import {
    uuidv4,
    z,
    getAllClusters,
    getAllSSHTunnels,
    getSSHTunnelById,
    getClusterById,
    insertCluster,
    updateCluster,
    deleteCluster,
    deleteSSHTunnel,
    insertOperationLog,
    runInTransaction,
    PulsarAdminClient,
    clientManager,
    ClusterConfigSchema,
    ClusterTestSchema,
    ClusterIdSchema,
    encrypt,
    encryptSensitiveFields,
    normalizeCluster,
    formatError,
    registerRawHandler,
    ensureDbInitialized,
    persistSshConfig,
    establishTunnel,
    rewriteUrl,
    tunnelVerifyHost,
    sshTunnelManager,
} from './_shared';
import {createLogger} from '../utils/logger';
import {nativeClientManager} from '../services/pulsar-native-client';

const log = createLogger('IPC');

// 集群 id 由渲染进程传入，必须先校验再进数据库
function parseClusterId(id: unknown): string {
    const parsed = ClusterIdSchema.safeParse(id);
    if (!parsed.success) {
        throw new Error('Invalid cluster id');
    }
    return parsed.data;
}

function parseSshConfig(config: unknown): z.infer<typeof ClusterConfigSchema> {
    return ClusterConfigSchema.parse(config);
}

type ClusterDraft = z.infer<typeof ClusterTestSchema>;

// 测试连接与真实请求共用同一套地址解析：勾选隧道时先建隧道，再把地址换成
// 本地转发端点，否则"测试通过但保存后连不上"永远对不上号。
async function resolveTestTarget(
    input: ClusterDraft,
): Promise<{serviceUrl: string; webServiceUrl?: string; tlsVerifyHost?: string; sshConfigId?: string}> {
    const base = {
        serviceUrl: input.serviceUrl,
        webServiceUrl: input.webServiceUrl || undefined,
        tlsVerifyHost: undefined as string | undefined,
        sshConfigId: undefined as string | undefined,
    };
    if (!input.useSshTunnel) {
        return base;
    }
    const resolved = await establishTunnel(
        {service_url: input.serviceUrl, web_service_url: input.webServiceUrl},
        {sshConfigId: input.sshConfigId, ssh: input.ssh},
    );
    return {
        serviceUrl: rewriteUrl(input.serviceUrl, resolved.endpoints.localBrokerPort),
        webServiceUrl: input.webServiceUrl
            ? rewriteUrl(input.webServiceUrl, resolved.endpoints.localAdminPort)
            : `${input.tlsEnabled ? 'https' : 'http'}://127.0.0.1:${resolved.endpoints.localAdminPort}`,
        tlsVerifyHost: tunnelVerifyHost(
            {service_url: input.serviceUrl, web_service_url: input.webServiceUrl},
            resolved.targets,
        ),
        sshConfigId: resolved.tunnelId,
    };
}

export function registerClusterHandlers() {
    registerRawHandler('cluster:list', async () => {
        try {
            ensureDbInitialized();
            // 一次取全部隧道再按 id 匹配，避免每个集群查一次
            const tunnels = new Map(getAllSSHTunnels().map(tunnel => [tunnel.id, tunnel]));
            const clusters = getAllClusters();
            return {
                success: true,
                data: clusters.map(cluster => normalizeCluster(cluster, tunnels.get(cluster.ssh_config_id || ''))),
            };
        } catch (error) {
            log.error('cluster:list failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('cluster:add', async config => {
        try {
            ensureDbInitialized();
            const validated = parseSshConfig(config);

            const id = uuidv4();
            const encrypted = encryptSensitiveFields(validated);
            const sshConfigId = validated.useSshTunnel ? persistSshConfig(validated.ssh!, validated.sshConfigId) : null;

            // 集群记录、隧道记录与操作日志必须一起提交，避免出现只写了一半的状态
            runInTransaction(() => {
                insertCluster({
                    id,
                    name: encrypted.name,
                    service_url: encrypted.serviceUrl,
                    web_service_url: encrypted.webServiceUrl,
                    auth_plugin: encrypted.authPlugin,
                    auth_params: encrypted.authParams,
                    tls_enabled: encrypted.tlsEnabled ? 1 : 0,
                    tls_trust_certs: encrypted.tlsTrustCerts,
                    use_ssh_tunnel: encrypted.useSshTunnel ? 1 : 0,
                    ssh_config_id: sshConfigId,
                    admin_api_timeout: encrypted.adminApiTimeout || 5000,
                    status: 'disconnected',
                });

                insertOperationLog({
                    cluster_id: id,
                    action: 'create',
                    resource_type: 'cluster',
                    resource_id: id,
                    resource_name: validated.name,
                    result: 'success',
                });
            });

            // 不回传凭据，只回传渲染进程需要的字段
            return {
                success: true,
                data: normalizeCluster(getClusterById(id), sshConfigId ? getSSHTunnelById(sshConfigId) : undefined),
            };
        } catch (error) {
            log.error('cluster:add failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('cluster:update', async (rawId, config) => {
        try {
            ensureDbInitialized();
            const id = parseClusterId(rawId);
            const existing = getClusterById(id);
            if (!existing) {
                return {success: false, error: 'Cluster not found'};
            }

            const validated = parseSshConfig(config);
            const sshConfigId = validated.useSshTunnel
                ? persistSshConfig(validated.ssh!, validated.sshConfigId || existing.ssh_config_id)
                : existing.ssh_config_id;

            // 凭据不会下发到渲染进程，所以表单提交空值意味着"保持不变"，
            // 只有真的填了新值才覆盖。
            const authParams = validated.authParams ? encrypt(validated.authParams) : existing.auth_params;
            const tlsTrustCerts = validated.tlsTrustCerts ? encrypt(validated.tlsTrustCerts) : existing.tls_trust_certs;

            runInTransaction(() => {
                updateCluster(id, {
                    name: validated.name,
                    service_url: validated.serviceUrl,
                    web_service_url: validated.webServiceUrl,
                    auth_plugin: validated.authPlugin,
                    auth_params: authParams,
                    tls_enabled: validated.tlsEnabled ? 1 : 0,
                    tls_trust_certs: tlsTrustCerts,
                    use_ssh_tunnel: validated.useSshTunnel ? 1 : 0,
                    ssh_config_id: sshConfigId,
                    admin_api_timeout: validated.adminApiTimeout || 5000,
                });

                insertOperationLog({
                    cluster_id: id,
                    action: 'update',
                    resource_type: 'cluster',
                    resource_id: id,
                    resource_name: validated.name,
                    result: 'success',
                });
            });

            // 必须丢弃缓存的客户端，否则后续请求仍使用旧的地址、凭据和超时设置
            clientManager.removeClient(id);
            // 原生客户端与在跑的收发会话同样要作废；removeCluster 的缓存清理是同步完成的，
            // 不必等它关闭连接再回响应。
            void nativeClientManager.removeCluster(id);
            // 隧道参数（含远端端口）可能已变，作废旧的本地转发，下一次请求按新参数重建。
            // 关掉开关时同样要停掉转发，否则本地端口一直占着一条没人用的隧道。
            const previousTunnelId = existing.ssh_config_id;
            if (previousTunnelId) {
                void sshTunnelManager.invalidate(previousTunnelId);
            }
            if (sshConfigId && sshConfigId !== previousTunnelId) {
                void sshTunnelManager.invalidate(sshConfigId);
            }

            return {
                success: true,
                data: normalizeCluster(getClusterById(id), sshConfigId ? getSSHTunnelById(sshConfigId) : undefined),
            };
        } catch (error) {
            log.error('cluster:update failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('cluster:delete', async rawId => {
        try {
            ensureDbInitialized();
            const id = parseClusterId(rawId);
            const cluster = getClusterById(id);

            runInTransaction(() => {
                deleteCluster(id);

                if (cluster) {
                    // 隧道配置是这个集群专属的（表单内联录入），删集群就要连它一起删
                    if (cluster.ssh_config_id) {
                        deleteSSHTunnel(cluster.ssh_config_id);
                    }
                    insertOperationLog({
                        cluster_id: null,
                        action: 'delete',
                        resource_type: 'cluster',
                        resource_id: id,
                        resource_name: cluster.name,
                        result: 'success',
                    });
                }
            });

            // 清除客户端缓存
            clientManager.removeClient(id);
            void nativeClientManager.removeCluster(id);
            if (cluster?.ssh_config_id) {
                void sshTunnelManager.disconnect(cluster.ssh_config_id);
            }

            return {success: true};
        } catch (error) {
            log.error('cluster:delete failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('cluster:testConnection', async config => {
        try {
            const validated = ClusterTestSchema.parse(config);
            const target = await resolveTestTarget(validated);

            // 创建临时客户端测试连接
            const client = new PulsarAdminClient({
                serviceUrl: target.serviceUrl,
                webServiceUrl: target.webServiceUrl,
                timeout: validated.adminApiTimeout || 5000,
                auth: validated.authPlugin
                    ? {authPlugin: validated.authPlugin, authParams: validated.authParams}
                    : undefined,
                tls: validated.tlsEnabled
                    ? {enabled: true, trustCerts: validated.tlsTrustCerts || undefined}
                    : undefined,
                tlsVerifyHost: target.tlsVerifyHost,
            });

            const result = await client.testConnection();

            // 清理临时客户端
            client.destroy();

            if (!result.connected) {
                return {
                    success: false,
                    error: '无法连接到 Pulsar 集群，请检查服务地址和认证配置',
                    data: {sshConfigId: target.sshConfigId},
                };
            }

            return {
                success: true,
                data: {connected: result.connected, version: result.version, sshConfigId: target.sshConfigId},
            };
        } catch (error) {
            log.error('cluster:testConnection failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });
}

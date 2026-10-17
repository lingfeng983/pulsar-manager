import {
    uuidv4,
    z,
    getAllClusters,
    getAllSSHTunnels,
    getSSHTunnelById,
    getAllK8sForwards,
    getK8sForwardById,
    getClusterById,
    insertCluster,
    updateCluster,
    deleteCluster,
    deleteSSHTunnel,
    deleteK8sForward,
    insertOperationLog,
    runInTransaction,
    PulsarAdminClient,
    clientManager,
    ClusterConfigSchema,
    ClusterTestSchema,
    ClusterIdSchema,
    SshInlineSchema,
    K8sInlineSchema,
    encrypt,
    encryptSensitiveFields,
    normalizeCluster,
    formatError,
    registerRawHandler,
    ensureDbInitialized,
    getAdminClient,
    markClusterStatus,
    markClusterVersion,
    persistSshConfig,
    reuseSshConfig,
    establishTunnel,
    persistK8sConfig,
    reuseK8sConfig,
    establishK8sForward,
    rewriteUrl,
    tunnelVerifyHost,
    forwardVerifyHost,
    sshTunnelManager,
    k8sForwardManager,
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

// 隧道落库的三种情形：这次重填了参数（覆盖或新建）、只带了已保存的 id（沿用）、
// 什么都没有（schema 已拦，这里只是不再对 ssh 做非空断言）。
function resolveTunnelId(
    config: {useSshTunnel?: boolean | null; ssh?: z.infer<typeof SshInlineSchema> | null; sshConfigId?: string | null},
    ownerClusterId: string | null,
): string | null {
    if (!config.useSshTunnel) {
        return null;
    }
    if (config.ssh) {
        return persistSshConfig(config.ssh, config.sshConfigId, ownerClusterId);
    }
    if (config.sshConfigId) {
        return reuseSshConfig(config.sshConfigId, ownerClusterId);
    }
    throw new Error('SSH 隧道需要主机与用户名');
}

// K8s 转发落库的三种情形，与上面 SSH 完全对称。
function resolveK8sConfigId(
    config: {
        useK8sForward?: boolean | null;
        k8s?: z.infer<typeof K8sInlineSchema> | null;
        k8sConfigId?: string | null;
    },
    ownerClusterId: string | null,
): string | null {
    if (!config.useK8sForward) {
        return null;
    }
    if (config.k8s) {
        return persistK8sConfig(config.k8s, config.k8sConfigId, ownerClusterId);
    }
    if (config.k8sConfigId) {
        return reuseK8sConfig(config.k8sConfigId, ownerClusterId);
    }
    throw new Error('K8s 端口转发需要命名空间与资源名');
}

// 测试连接与真实请求共用同一套地址解析：勾选隧道时先建隧道，再把地址换成
// 本地转发端点，否则"测试通过但保存后连不上"永远对不上号。
async function resolveTestTarget(input: ClusterDraft): Promise<{
    serviceUrl: string;
    webServiceUrl?: string;
    tlsVerifyHost?: string;
    sshConfigId?: string;
    k8sConfigId?: string;
}> {
    const base = {
        serviceUrl: input.serviceUrl,
        webServiceUrl: input.webServiceUrl || undefined,
        tlsVerifyHost: undefined as string | undefined,
        sshConfigId: undefined as string | undefined,
        k8sConfigId: undefined as string | undefined,
    };
    if (input.useK8sForward) {
        const resolved = await establishK8sForward(
            {service_url: input.serviceUrl, web_service_url: input.webServiceUrl},
            {k8sConfigId: input.k8sConfigId, k8s: input.k8s, ownerClusterId: input.id},
        );
        return {
            serviceUrl: rewriteUrl(input.serviceUrl, resolved.endpoints.localBrokerPort),
            webServiceUrl: input.webServiceUrl
                ? rewriteUrl(input.webServiceUrl, resolved.endpoints.localAdminPort)
                : `${input.tlsEnabled ? 'https' : 'http'}://127.0.0.1:${resolved.endpoints.localAdminPort}`,
            tlsVerifyHost: forwardVerifyHost({service_url: input.serviceUrl, web_service_url: input.webServiceUrl}),
            k8sConfigId: resolved.forwardId,
        };
    }
    if (!input.useSshTunnel) {
        return base;
    }
    const resolved = await establishTunnel(
        {service_url: input.serviceUrl, web_service_url: input.webServiceUrl},
        {sshConfigId: input.sshConfigId, ssh: input.ssh, ownerClusterId: input.id},
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

// 只为这次测试建立的转发：用户点完"测试连接"就取消弹窗的话，本地端口和
// SSH 长连接 / kubectl 进程会一直留着（下一次启动还得换端口）。没有任何已保存集群引用
// 它时才拆，正在被集群使用的转发不能动——真实请求虽然会按需重建，但没必要为此掐断在线链路。
async function releaseTestOnlyForward(target: {sshConfigId?: string; k8sConfigId?: string}): Promise<void> {
    if (target.sshConfigId && !getAllClusters().some(cluster => cluster.ssh_config_id === target.sshConfigId)) {
        try {
            await sshTunnelManager.disconnect(target.sshConfigId);
        } catch (error) {
            log.warn('test tunnel cleanup failed', error instanceof Error ? error.message : String(error));
        }
    }
    if (target.k8sConfigId && !getAllClusters().some(cluster => cluster.k8s_config_id === target.k8sConfigId)) {
        try {
            await k8sForwardManager.disconnect(target.k8sConfigId);
        } catch (error) {
            log.warn('test forward cleanup failed', error instanceof Error ? error.message : String(error));
        }
    }
}

export function registerClusterHandlers() {
    registerRawHandler('cluster:list', async () => {
        try {
            ensureDbInitialized();
            // 一次取全部隧道/转发再按 id 匹配，避免每个集群查一次
            const tunnels = new Map(getAllSSHTunnels().map(tunnel => [tunnel.id, tunnel]));
            const forwards = new Map(getAllK8sForwards().map(forward => [forward.id, forward]));
            const clusters = getAllClusters();
            return {
                success: true,
                data: clusters.map(cluster =>
                    normalizeCluster(
                        cluster,
                        tunnels.get(cluster.ssh_config_id || ''),
                        forwards.get(cluster.k8s_config_id || ''),
                    ),
                ),
            };
        } catch (error) {
            log.error('cluster:list failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    // 首屏与刷新图标走这条通道：clusters.status 是落库列，cluster:list 只把它原样读出来，
    // 于是上次退出时"在线"的集群会一直绿着，哪怕 broker 早停了。这里逐集群并发探活
    // （单集群内 healthCheck 的四个候选端点是顺序试的，per-client 信号量已经限好并发），
    // 探完再回整份列表，渲染层一次 set 就能把徽标刷成真实状态。
    registerRawHandler('cluster:checkStatus', async () => {
        try {
            ensureDbInitialized();
            const clusters = getAllClusters();
            await Promise.all(
                clusters.map(async cluster => {
                    try {
                        const client = await getAdminClient(cluster.id);
                        if (!client) {
                            // 集群在探活途中被删掉了，不是"连不上"
                            return;
                        }
                        if (await client.healthCheck()) {
                            markClusterStatus(cluster.id, 'connected');
                            // 探活顺带补版本：首页版本列以前只有"测试连接"弹窗会看到，
                            // 落库后列表直接显示。/metrics 一次是全量文本，只在库里没有
                            // 版本时取；broker 就地升级后版本号在集群页编辑重存即可刷新。
                            // 读不到版本（权限受限、没开 /metrics）只跳过，不能把在线集群误判成离线。
                            if (!cluster.version) {
                                const version = await client.resolveVersion();
                                if (version) {
                                    markClusterVersion(cluster.id, version);
                                }
                            }
                        } else {
                            markClusterStatus(cluster.id, 'disconnected');
                        }
                    } catch {
                        // 建连本身失败（隧道起不来、配置坏掉）与连不上等价
                        markClusterStatus(cluster.id, 'disconnected');
                    }
                }),
            );
            const tunnels = new Map(getAllSSHTunnels().map(tunnel => [tunnel.id, tunnel]));
            const forwards = new Map(getAllK8sForwards().map(forward => [forward.id, forward]));
            return {
                success: true,
                data: getAllClusters().map(cluster =>
                    normalizeCluster(
                        cluster,
                        tunnels.get(cluster.ssh_config_id || ''),
                        forwards.get(cluster.k8s_config_id || ''),
                    ),
                ),
            };
        } catch (error) {
            log.error('cluster:checkStatus failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('cluster:add', async config => {
        try {
            ensureDbInitialized();
            const validated = parseSshConfig(config);

            const id = uuidv4();
            const encrypted = encryptSensitiveFields(validated);
            const sshConfigId = resolveTunnelId(validated, id);
            const k8sConfigId = resolveK8sConfigId(validated, id);

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
                    use_k8s_forward: encrypted.useK8sForward ? 1 : 0,
                    k8s_config_id: k8sConfigId,
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
                data: normalizeCluster(
                    getClusterById(id),
                    sshConfigId ? getSSHTunnelById(sshConfigId) : undefined,
                    k8sConfigId ? getK8sForwardById(k8sConfigId) : undefined,
                ),
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
            // 表单没带隧道 id 时回落到该集群已保存的那条：编辑弹窗只回填非敏感字段，
            // 用户没重填隧道参数就不该新建第二条
            const sshConfigId = validated.useSshTunnel
                ? resolveTunnelId(
                      {
                          useSshTunnel: true,
                          ssh: validated.ssh,
                          sshConfigId: validated.sshConfigId || existing.ssh_config_id,
                      },
                      id,
                  )
                : existing.ssh_config_id;
            const k8sConfigId = validated.useK8sForward
                ? resolveK8sConfigId(
                      {
                          useK8sForward: true,
                          k8s: validated.k8s,
                          k8sConfigId: validated.k8sConfigId || existing.k8s_config_id,
                      },
                      id,
                  )
                : existing.k8s_config_id;

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
                    use_k8s_forward: validated.useK8sForward ? 1 : 0,
                    k8s_config_id: k8sConfigId,
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
            const previousForwardId = existing.k8s_config_id;
            if (previousForwardId) {
                void k8sForwardManager.invalidate(previousForwardId);
            }
            if (k8sConfigId && k8sConfigId !== previousForwardId) {
                void k8sForwardManager.invalidate(k8sConfigId);
            }

            return {
                success: true,
                data: normalizeCluster(
                    getClusterById(id),
                    sshConfigId ? getSSHTunnelById(sshConfigId) : undefined,
                    k8sConfigId ? getK8sForwardById(k8sConfigId) : undefined,
                ),
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
                    if (cluster.k8s_config_id) {
                        deleteK8sForward(cluster.k8s_config_id);
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
            if (cluster?.k8s_config_id) {
                void k8sForwardManager.disconnect(cluster.k8s_config_id);
            }

            return {success: true};
        } catch (error) {
            log.error('cluster:delete failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('cluster:testConnection', async config => {
        let target: Awaited<ReturnType<typeof resolveTestTarget>> | null = null;
        try {
            const validated = ClusterTestSchema.parse(config);
            target = await resolveTestTarget(validated);

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

            let result: {connected: boolean; version?: string};
            try {
                result = await client.testConnection();
            } finally {
                // 测试失败时也要释放临时客户端：原来 destroy 排在 await 之后，
                // 抛异常就永远走不到
                client.destroy();
            }

            if (!result.connected) {
                return {
                    success: false,
                    error: '无法连接到 Pulsar 集群，请检查服务地址和认证配置',
                    data: {sshConfigId: target.sshConfigId, k8sConfigId: target.k8sConfigId},
                };
            }

            return {
                success: true,
                data: {
                    connected: result.connected,
                    version: result.version,
                    sshConfigId: target.sshConfigId,
                    k8sConfigId: target.k8sConfigId,
                },
            };
        } catch (error) {
            log.error('cluster:testConnection failed', formatError(error));
            return {success: false, error: formatError(error)};
        } finally {
            if (target) {
                await releaseTestOnlyForward(target);
            }
        }
    });
}

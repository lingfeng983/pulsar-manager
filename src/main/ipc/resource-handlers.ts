import {
    z,
    markClusterStatus,
    registerClientHandler,
    registerMutationHandler,
    ClusterIdSchema,
    TenantPathSchema,
    NamespacePathSchema,
    TopicPathSchema,
    SubscriptionPathSchema,
    SchemaStrategySchema,
    CreateSchemaVersionSchema,
    CreateSubscriptionSchema,
    ResetCursorSchema,
    SkipMessagesSchema,
    TopicConfigPatchSchema,
    CreateTenantSchema,
    UpdateTenantSchema,
    CreateNamespaceSchema,
    CreateTopicSchema,
    GrantPermissionSchema,
    RevokePermissionSchema,
    GrantTopicPermissionSchema,
    RevokeTopicPermissionSchema,
} from './_shared';

const ClusterOnlySchema = z.object({clusterId: ClusterIdSchema});

const UpdateTopicConfigSchema = TopicPathSchema.extend({
    config: TopicConfigPatchSchema,
});

export function registerResourceHandlers() {
    registerClientHandler(
        'resources:getTenants',
        ClusterOnlySchema,
        ([clusterId]) => ({clusterId}),
        async (client, {clusterId}) => {
            try {
                const tenants = await client.getTenants();
                markClusterStatus(clusterId, 'connected');
                return tenants;
            } catch (error) {
                markClusterStatus(clusterId, 'disconnected');
                throw error;
            }
        },
    );

    registerClientHandler(
        'resources:getNamespaces',
        TenantPathSchema,
        ([clusterId, tenant]) => ({clusterId, tenant}),
        (client, {tenant}) => client.getNamespaces(tenant),
    );

    registerClientHandler(
        'resources:getTopics',
        NamespacePathSchema,
        ([clusterId, tenant, namespace]) => ({clusterId, tenant, namespace}),
        (client, {tenant, namespace}) => client.getTopics(tenant, namespace),
    );

    registerClientHandler(
        'resources:getTopicStats',
        TopicPathSchema,
        ([clusterId, tenant, namespace, topic, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            persistent: persistent ?? true,
        }),
        (client, {tenant, namespace, topic, persistent}) => client.getTopicStats(tenant, namespace, topic, persistent),
    );

    registerClientHandler(
        'resources:getTopicConfig',
        TopicPathSchema,
        ([clusterId, tenant, namespace, topic, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            persistent: persistent ?? true,
        }),
        (client, {tenant, namespace, topic, persistent}) => client.getTopicConfig(tenant, namespace, topic, persistent),
    );

    registerMutationHandler(
        'resources:updateTopicConfig',
        UpdateTopicConfigSchema,
        ([clusterId, tenant, namespace, topic, config, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            config,
            persistent: persistent ?? true,
        }),
        ({tenant, namespace, topic, config, persistent}) => ({
            action: 'update',
            resource_type: 'topic',
            resource_id: `${tenant}/${namespace}/${topic}`,
            resource_name: `${tenant}/${namespace}/${topic}`,
            details: `${persistent ? 'persistent' : 'non-persistent'} keys=${Object.keys(config).join(',')}`,
        }),
        (client, {tenant, namespace, topic, config, persistent}) =>
            client.updateTopicConfig(tenant, namespace, topic, config, persistent),
    );

    registerClientHandler(
        'resources:getSubscriptions',
        TopicPathSchema,
        ([clusterId, tenant, namespace, topic, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            persistent: persistent ?? true,
        }),
        (client, {tenant, namespace, topic, persistent}) =>
            client.getSubscriptions(tenant, namespace, topic, persistent),
    );

    registerClientHandler(
        'resources:getTenantInfo',
        TenantPathSchema,
        ([clusterId, tenant]) => ({clusterId, tenant}),
        (client, {tenant}) => client.getTenantInfo(tenant),
    );

    registerClientHandler(
        'resources:getNamespaceInfo',
        NamespacePathSchema,
        ([clusterId, tenant, namespace]) => ({clusterId, tenant, namespace}),
        (client, {tenant, namespace}) => client.getNamespaceInfo(tenant, namespace),
    );

    registerMutationHandler(
        'resources:createSubscription',
        CreateSubscriptionSchema,
        ([clusterId, tenant, namespace, topic, subscription, initialPosition, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            subscription,
            initialPosition,
            persistent: persistent ?? true,
        }),
        ({tenant, namespace, topic, subscription, initialPosition, persistent}) => ({
            action: 'create',
            resource_type: 'subscription',
            resource_id: `${tenant}/${namespace}/${topic}/${subscription}`,
            resource_name: `${tenant}/${namespace}/${topic}/${subscription}`,
            details: `${persistent ? 'persistent' : 'non-persistent'} from=${initialPosition}`,
        }),
        (client, {tenant, namespace, topic, subscription, initialPosition, persistent}) =>
            client.createSubscription(tenant, namespace, topic, subscription, persistent, initialPosition),
    );

    registerMutationHandler(
        'resources:deleteSubscription',
        SubscriptionPathSchema,
        ([clusterId, tenant, namespace, topic, subscription, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            subscription,
            persistent: persistent ?? true,
        }),
        ({tenant, namespace, topic, subscription, persistent}) => ({
            action: 'delete',
            resource_type: 'subscription',
            resource_id: `${tenant}/${namespace}/${topic}/${subscription}`,
            resource_name: `${tenant}/${namespace}/${topic}/${subscription}`,
            details: persistent ? 'persistent' : 'non-persistent',
        }),
        (client, {tenant, namespace, topic, subscription, persistent}) =>
            client.deleteSubscription(tenant, namespace, topic, subscription, persistent),
    );

    // 游标一跳，未消费的消息就可能永远读不到了，这两条必须进审计
    registerMutationHandler(
        'resources:resetCursor',
        ResetCursorSchema,
        ([clusterId, tenant, namespace, topic, subscription, position, timestamp, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            subscription,
            position,
            timestamp,
            persistent: persistent ?? true,
        }),
        ({tenant, namespace, topic, subscription, position, timestamp}) => ({
            action: 'update',
            resource_type: 'subscription',
            resource_id: `${tenant}/${namespace}/${topic}/${subscription}`,
            resource_name: `${tenant}/${namespace}/${topic}/${subscription}`,
            details: `reset cursor to ${position}${position === 'timestamp' ? ` @${timestamp}` : ''}`,
        }),
        async (client, {tenant, namespace, topic, subscription, position, timestamp, persistent}) => {
            if (position === 'earliest') {
                return client.resetCursorToEarliest(tenant, namespace, topic, subscription, persistent);
            }
            if (position === 'latest') {
                return client.resetCursorToLatest(tenant, namespace, topic, subscription, persistent);
            }
            // 时间戳模式必须带有效时间戳，否则以前会什么都不做却返回成功
            if (!timestamp) {
                throw new Error('A timestamp is required when resetting the cursor by time');
            }
            return client.resetCursor(tenant, namespace, topic, subscription, timestamp, persistent);
        },
    );

    registerMutationHandler(
        'resources:skipMessages',
        SkipMessagesSchema,
        ([clusterId, tenant, namespace, topic, subscription, count, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            subscription,
            count,
            persistent: persistent ?? true,
        }),
        ({tenant, namespace, topic, subscription, count}) => ({
            action: 'update',
            resource_type: 'subscription',
            resource_id: `${tenant}/${namespace}/${topic}/${subscription}`,
            resource_name: `${tenant}/${namespace}/${topic}/${subscription}`,
            details: `skipped ${count} messages`,
        }),
        (client, {tenant, namespace, topic, subscription, count, persistent}) =>
            client.skipMessages(tenant, namespace, topic, subscription, count, persistent),
    );

    registerMutationHandler(
        'resources:deleteTopic',
        TopicPathSchema,
        ([clusterId, tenant, namespace, topic, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            persistent: persistent ?? true,
        }),
        ({tenant, namespace, topic, persistent}) => ({
            action: 'delete',
            resource_type: 'topic',
            resource_id: `${tenant}/${namespace}/${topic}`,
            resource_name: `${tenant}/${namespace}/${topic}`,
            details: persistent ? 'persistent' : 'non-persistent',
        }),
        (client, {tenant, namespace, topic, persistent}) => client.deleteTopic(tenant, namespace, topic, persistent),
    );

    // ========== Schema 注册表 ==========

    registerClientHandler(
        'resources:getSchema',
        TopicPathSchema,
        ([clusterId, tenant, namespace, topic, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            persistent: persistent ?? true,
        }),
        (client, {tenant, namespace, topic, persistent}) => client.getSchemaInfo(tenant, namespace, topic, persistent),
    );

    registerClientHandler(
        'resources:getSchemaStrategy',
        TopicPathSchema,
        ([clusterId, tenant, namespace, topic, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            persistent: persistent ?? true,
        }),
        (client, {tenant, namespace, topic, persistent}) =>
            client.getSchemaCompatibilityStrategy(tenant, namespace, topic, persistent),
    );

    registerMutationHandler(
        'resources:setSchemaStrategy',
        SchemaStrategySchema,
        ([clusterId, tenant, namespace, topic, strategy, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            strategy,
            persistent: persistent ?? true,
        }),
        ({tenant, namespace, topic, strategy}) => ({
            action: 'update',
            resource_type: 'schema',
            resource_id: `${tenant}/${namespace}/${topic}`,
            resource_name: `${tenant}/${namespace}/${topic}`,
            details: `strategy=${strategy}`,
        }),
        (client, {tenant, namespace, topic, strategy, persistent}) =>
            client.setSchemaCompatibilityStrategy(tenant, namespace, topic, strategy, persistent),
    );

    registerMutationHandler(
        'resources:createSchemaVersion',
        CreateSchemaVersionSchema,
        ([clusterId, tenant, namespace, topic, type, definition, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            type,
            definition,
            persistent: persistent ?? true,
        }),
        ({tenant, namespace, topic, type, definition}) => ({
            action: 'create',
            resource_type: 'schema',
            resource_id: `${tenant}/${namespace}/${topic}`,
            resource_name: `${tenant}/${namespace}/${topic}`,
            // 定义正文可能很大且含业务字段，审计只记类型与长度
            details: `type=${type} bytes=${definition.length}`,
        }),
        (client, {tenant, namespace, topic, type, definition, persistent}) =>
            client.createSchemaVersion(tenant, namespace, topic, {type, schema: definition}, persistent),
    );

    registerMutationHandler(
        'resources:deleteSchema',
        TopicPathSchema,
        ([clusterId, tenant, namespace, topic, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            persistent: persistent ?? true,
        }),
        ({tenant, namespace, topic, persistent}) => ({
            action: 'delete',
            resource_type: 'schema',
            resource_id: `${tenant}/${namespace}/${topic}`,
            resource_name: `${tenant}/${namespace}/${topic}`,
            details: persistent ? 'persistent' : 'non-persistent',
        }),
        (client, {tenant, namespace, topic, persistent}) => client.deleteSchema(tenant, namespace, topic, persistent),
    );

    // ========== 权限（ACL）==========

    registerClientHandler(
        'resources:getNamespacePermissions',
        NamespacePathSchema,
        ([clusterId, tenant, namespace]) => ({clusterId, tenant, namespace}),
        (client, {tenant, namespace}) => client.getNamespacePermissions(tenant, namespace),
    );

    registerClientHandler(
        'resources:getTopicPermissions',
        TopicPathSchema,
        ([clusterId, tenant, namespace, topic, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            persistent: persistent ?? true,
        }),
        (client, {tenant, namespace, topic, persistent}) =>
            client.getTopicPermissions(tenant, namespace, topic, persistent),
    );

    // 授权与撤权直接决定谁能读写这条资源，是最需要留痕的两类写操作
    registerMutationHandler(
        'resources:grantNamespacePermission',
        GrantPermissionSchema,
        ([clusterId, tenant, namespace, role, actions]) => ({clusterId, tenant, namespace, role, actions}),
        ({tenant, namespace, role, actions}) => ({
            action: 'update',
            resource_type: 'permission',
            resource_id: `${tenant}/${namespace}`,
            resource_name: `${tenant}/${namespace}`,
            details: `grant ${role} = ${actions.join(',')}`,
        }),
        (client, {tenant, namespace, role, actions}) =>
            client.grantNamespacePermission(tenant, namespace, role, actions),
    );

    registerMutationHandler(
        'resources:revokeNamespacePermission',
        RevokePermissionSchema,
        ([clusterId, tenant, namespace, role]) => ({clusterId, tenant, namespace, role}),
        ({tenant, namespace, role}) => ({
            action: 'delete',
            resource_type: 'permission',
            resource_id: `${tenant}/${namespace}`,
            resource_name: `${tenant}/${namespace}`,
            details: `revoke ${role}`,
        }),
        (client, {tenant, namespace, role}) => client.revokeNamespacePermission(tenant, namespace, role),
    );

    registerMutationHandler(
        'resources:grantTopicPermission',
        GrantTopicPermissionSchema,
        ([clusterId, tenant, namespace, topic, role, actions, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            role,
            actions,
            persistent: persistent ?? true,
        }),
        ({tenant, namespace, topic, role, actions, persistent}) => ({
            action: 'update',
            resource_type: 'permission',
            resource_id: `${tenant}/${namespace}/${topic}`,
            resource_name: `${tenant}/${namespace}/${topic}`,
            details: `${persistent ? 'persistent' : 'non-persistent'} grant ${role} = ${actions.join(',')}`,
        }),
        (client, {tenant, namespace, topic, role, actions, persistent}) =>
            client.grantTopicPermission(tenant, namespace, topic, role, actions, persistent),
    );

    registerMutationHandler(
        'resources:revokeTopicPermission',
        RevokeTopicPermissionSchema,
        ([clusterId, tenant, namespace, topic, role, persistent]) => ({
            clusterId,
            tenant,
            namespace,
            topic,
            role,
            persistent: persistent ?? true,
        }),
        ({tenant, namespace, topic, role, persistent}) => ({
            action: 'delete',
            resource_type: 'permission',
            resource_id: `${tenant}/${namespace}/${topic}`,
            resource_name: `${tenant}/${namespace}/${topic}`,
            details: `${persistent ? 'persistent' : 'non-persistent'} revoke ${role}`,
        }),
        (client, {tenant, namespace, topic, role, persistent}) =>
            client.revokeTopicPermission(tenant, namespace, topic, role, persistent),
    );

    // 创建租户时 allowedClusters 必须填 Pulsar 侧的集群名，应用里保存的连接名不是同一个东西。
    registerClientHandler(
        'resources:getPulsarClusters',
        ClusterOnlySchema,
        ([clusterId]) => ({clusterId}),
        client => client.getPulsarClusters(),
    );

    registerMutationHandler(
        'resources:createTenant',
        CreateTenantSchema,
        ([clusterId, name, adminRoles, allowedClusters]) => ({
            clusterId,
            name,
            adminRoles: adminRoles ?? [],
            allowedClusters: allowedClusters ?? [],
        }),
        ({name, allowedClusters, adminRoles}) => ({
            action: 'create',
            resource_type: 'tenant',
            resource_id: name,
            resource_name: name,
            details: `clusters=${allowedClusters.join(',')} adminRoles=${adminRoles.join(',')}`,
        }),
        (client, {name, adminRoles, allowedClusters}) => client.createTenant(name, {adminRoles, allowedClusters}),
    );

    registerMutationHandler(
        'resources:updateTenant',
        UpdateTenantSchema,
        ([clusterId, tenant, adminRoles, allowedClusters]) => ({
            clusterId,
            tenant,
            adminRoles: adminRoles ?? [],
            allowedClusters: allowedClusters ?? [],
        }),
        ({tenant, allowedClusters, adminRoles}) => ({
            action: 'update',
            resource_type: 'tenant',
            resource_id: tenant,
            resource_name: tenant,
            details: `clusters=${allowedClusters.join(',')} adminRoles=${adminRoles.join(',')}`,
        }),
        (client, {tenant, adminRoles, allowedClusters}) => client.updateTenant(tenant, {adminRoles, allowedClusters}),
    );

    registerMutationHandler(
        'resources:deleteTenant',
        TenantPathSchema,
        ([clusterId, tenant]) => ({clusterId, tenant}),
        ({tenant}) => ({action: 'delete', resource_type: 'tenant', resource_id: tenant, resource_name: tenant}),
        (client, {tenant}) => client.deleteTenant(tenant),
    );

    registerMutationHandler(
        'resources:createNamespace',
        CreateNamespaceSchema,
        ([clusterId, tenant, name]) => ({clusterId, tenant, name}),
        ({tenant, name}) => ({
            action: 'create',
            resource_type: 'namespace',
            resource_id: `${tenant}/${name}`,
            resource_name: `${tenant}/${name}`,
        }),
        (client, {tenant, name}) => client.createNamespace(tenant, name),
    );

    registerMutationHandler(
        'resources:deleteNamespace',
        NamespacePathSchema,
        ([clusterId, tenant, namespace]) => ({clusterId, tenant, namespace}),
        ({tenant, namespace}) => ({
            action: 'delete',
            resource_type: 'namespace',
            resource_id: `${tenant}/${namespace}`,
            resource_name: `${tenant}/${namespace}`,
        }),
        (client, {tenant, namespace}) => client.deleteNamespace(tenant, namespace),
    );

    registerMutationHandler(
        'resources:createTopic',
        CreateTopicSchema,
        ([clusterId, tenant, namespace, name, persistent, partitions]) => ({
            clusterId,
            tenant,
            namespace,
            name,
            persistent: persistent ?? true,
            partitions: partitions ?? 0,
        }),
        ({tenant, namespace, name, persistent, partitions}) => ({
            action: 'create',
            resource_type: 'topic',
            resource_id: `${tenant}/${namespace}/${name}`,
            resource_name: `${tenant}/${namespace}/${name}`,
            details: `${persistent ? 'persistent' : 'non-persistent'} partitions=${partitions}`,
        }),
        (client, {tenant, namespace, name, persistent, partitions}) =>
            client.createTopic(tenant, namespace, name, persistent, partitions),
    );
}

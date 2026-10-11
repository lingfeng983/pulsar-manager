import React, {useState, useEffect, useCallback, useRef} from 'react';
import {Card, Tabs, Row, Col, Statistic, Tag, Button, Table, Spin, Alert} from 'antd';
import {FolderOutlined, DatabaseOutlined, TagOutlined, ArrowRightOutlined} from '@ant-design/icons';
import {useTabStore} from '../store/tabs';
import {loadNamespaces} from '../hooks/resourceCache';
import {shortName} from '../utils/format';
import {namespaceTab} from '../utils/tabIds';

interface TenantDetailProps {
    clusterId: string;
    tenant: string;
}

interface NamespaceInfo {
    name: string;
}

const TenantDetail: React.FC<TenantDetailProps> = ({clusterId, tenant}) => {
    const {addTab} = useTabStore();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [namespaces, setNamespaces] = useState<NamespaceInfo[]>([]);
    const [tenantInfo, setTenantInfo] = useState<{
        adminRoles: string[];
        allowedClusters: string[];
    } | null>(null);

    // 参数切换时旧请求的晚到响应不能覆盖新数据，编号单调递增、绝不归零
    const requestIdRef = useRef(0);

    const fetchTenantInfo = useCallback(async () => {
        const currentRequestId = ++requestIdRef.current;
        setLoading(true);
        setError(null);
        try {
            const [namespaceNames, tenantResponse] = await Promise.all([
                loadNamespaces(clusterId, tenant),
                window.electronAPI.resources.getTenantInfo(clusterId, tenant),
            ]);
            if (currentRequestId !== requestIdRef.current) {
                return;
            }

            const nsList: NamespaceInfo[] = namespaceNames.map((ns: string) => ({
                name: shortName(ns),
            }));
            setNamespaces(nsList);

            if (tenantResponse.success && tenantResponse.data) {
                setTenantInfo(tenantResponse.data);
            } else {
                // 静默忽略的话页面会照常渲染 0 个角色/0 个集群，看起来像"租户就是这么空"
                setError(tenantResponse.error || '获取租户信息失败');
            }
        } catch (error) {
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            console.error('Failed to fetch tenant info:', error);
            setError(error instanceof Error ? error.message : String(error));
        } finally {
            if (currentRequestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, [clusterId, tenant]);

    useEffect(() => {
        fetchTenantInfo();
    }, [fetchTenantInfo]);

    const handleNamespaceClick = (namespace: string) => {
        addTab(namespaceTab(clusterId, tenant, namespace));
    };

    const namespaceColumns = [
        {
            title: '命名空间名称',
            dataIndex: 'name',
            key: 'name',
            render: (name: string) => (
                <Button type="link" onClick={() => handleNamespaceClick(name)}>
                    {name}
                    <ArrowRightOutlined style={{marginLeft: 4}} />
                </Button>
            ),
        },
    ];

    return (
        <div style={{padding: 'var(--spacing-lg)', height: '100%', overflow: 'auto'}}>
            {loading ? (
                <div style={{display: 'flex', justifyContent: 'center', alignItems: 'center', height: '200px'}}>
                    <Spin size="large" />
                </div>
            ) : error ? (
                <Alert
                    message="加载租户信息失败"
                    description={error}
                    type="error"
                    showIcon
                    action={
                        <Button size="small" onClick={() => void fetchTenantInfo()}>
                            重试
                        </Button>
                    }
                />
            ) : (
                <Tabs
                    items={[
                        {
                            key: 'overview',
                            label: '概览',
                            children: (
                                <>
                                    <Row gutter={16}>
                                        <Col span={8}>
                                            <Card>
                                                <Statistic
                                                    title="命名空间数量"
                                                    value={namespaces.length}
                                                    prefix={<FolderOutlined />}
                                                />
                                            </Card>
                                        </Col>
                                        <Col span={8}>
                                            <Card>
                                                <Statistic
                                                    title="管理角色数"
                                                    value={tenantInfo?.adminRoles?.length || 0}
                                                    prefix={<TagOutlined />}
                                                />
                                            </Card>
                                        </Col>
                                        <Col span={8}>
                                            <Card>
                                                <Statistic
                                                    title="允许的集群数"
                                                    value={tenantInfo?.allowedClusters?.length || 0}
                                                    prefix={<DatabaseOutlined />}
                                                />
                                            </Card>
                                        </Col>
                                    </Row>

                                    <Card title="租户信息" style={{marginTop: 'var(--spacing-md)'}}>
                                        <div style={{padding: '20px'}}>
                                            <div style={{marginBottom: 'var(--spacing-md)'}}>
                                                <span style={{fontWeight: 500}}>租户名称:</span>
                                                <code style={{marginLeft: 8}}>{tenant}</code>
                                            </div>
                                            <div style={{marginBottom: 'var(--spacing-md)'}}>
                                                <span style={{fontWeight: 500}}>管理角色:</span>
                                                <div style={{marginLeft: 8, display: 'flex', flexWrap: 'wrap', gap: 8}}>
                                                    {tenantInfo?.adminRoles?.map(role => (
                                                        <Tag key={role}>{role}</Tag>
                                                    ))}
                                                    {(!tenantInfo?.adminRoles ||
                                                        tenantInfo?.adminRoles?.length === 0) && (
                                                        <span style={{color: 'var(--color-text-tertiary)'}}>无</span>
                                                    )}
                                                </div>
                                            </div>
                                            <div style={{marginBottom: 'var(--spacing-md)'}}>
                                                <span style={{fontWeight: 500}}>允许的集群:</span>
                                                <div style={{marginLeft: 8, display: 'flex', flexWrap: 'wrap', gap: 8}}>
                                                    {tenantInfo?.allowedClusters?.map(cluster => (
                                                        <Tag key={cluster}>{cluster}</Tag>
                                                    ))}
                                                    {(!tenantInfo?.allowedClusters ||
                                                        tenantInfo?.allowedClusters?.length === 0) && (
                                                        <span style={{color: 'var(--color-text-tertiary)'}}>无</span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </Card>
                                </>
                            ),
                        },
                        {
                            key: 'namespaces',
                            label: '命名空间',
                            children: (
                                <Card title={`命名空间列表 (${namespaces.length})`}>
                                    {namespaces.length > 0 ? (
                                        <Table
                                            dataSource={namespaces}
                                            columns={namespaceColumns}
                                            rowKey="name"
                                            pagination={false}
                                            size="small"
                                            scroll={{x: 'max-content'}}
                                        />
                                    ) : (
                                        <div
                                            style={{
                                                textAlign: 'center',
                                                padding: '40px 0',
                                                color: 'var(--color-text-secondary)',
                                            }}
                                        >
                                            暂无命名空间
                                        </div>
                                    )}
                                </Card>
                            ),
                        },
                    ]}
                />
            )}
        </div>
    );
};

export default TenantDetail;

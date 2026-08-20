/**
 * Pulsar 集群连接测试脚本
 * 使用给定的地址进行测试
 * 
 * Broker Service URL: pulsar://192.168.222.121:6650
 * Admin API URL: http://192.168.222.121:8080
 */

const axios = require('axios');

const BROKER_URL = 'pulsar://192.168.222.121:6650';
const ADMIN_API_URL = 'http://192.168.222.121:8080';

async function testAdminApi() {
  try {
    console.log(`\n[测试] 连接 Admin API: ${ADMIN_API_URL}`);
    
    const response = await axios.get(`${ADMIN_API_URL}/admin/v2/clusters`, {
      timeout: 10000,
    });
    
    console.log('✓ Admin API 连接成功');
    console.log('  集群列表:', response.data);
    
    return { success: true, data: response.data };
  } catch (error) {
    console.log('✗ Admin API 连接失败:', error.message);
    return { success: false, error: error.message };
  }
}

async function testTenants() {
  try {
    console.log('\n[测试] 获取租户列表');
    
    const response = await axios.get(`${ADMIN_API_URL}/admin/v2/tenants`, {
      timeout: 10000,
    });
    
    console.log('✓ 获取租户成功');
    console.log('  租户列表:', response.data);
    
    return { success: true, data: response.data };
  } catch (error) {
    console.log('✗ 获取租户失败:', error.message);
    return { success: false, error: error.message };
  }
}

async function testNamespaces(tenant = 'public') {
  try {
    console.log(`\n[测试] 获取命名空间列表 (租户: ${tenant})`);
    
    const response = await axios.get(`${ADMIN_API_URL}/admin/v2/namespaces/${tenant}`, {
      timeout: 10000,
    });
    
    console.log('✓ 获取命名空间成功');
    console.log('  原始响应:', response.data);
    
    const namespaces = response.data.map((ns) => {
      const parts = ns.split('/');
      return parts.length > 1 ? parts.slice(1).join('/') : ns;
    });
    console.log('  解析后命名空间:', namespaces);
    
    return { success: true, data: namespaces };
  } catch (error) {
    console.log('✗ 获取命名空间失败:', error.message);
    return { success: false, error: error.message };
  }
}

async function testTopics(tenant = 'public', namespace = 'default') {
  try {
    console.log(`\n[测试] 获取 Topic 列表 (${tenant}/${namespace})`);
    
    const response = await axios.get(
      `${ADMIN_API_URL}/admin/v2/namespaces/${tenant}/${namespace}/topics`,
      { timeout: 10000 }
    );
    
    const topics = [];
    
    for (const topicUri of response.data || []) {
      const topicName = topicUri.split('://').pop();
      const type = topicUri.startsWith('persistent://') ? 'persistent' : 'non-persistent';
      topics.push({ name: topicName, type, uri: topicUri });
    }
    
    console.log('✓ 获取 Topic 成功');
    console.log('  Topic 列表:', topics);
    
    return { success: true, data: topics };
  } catch (error) {
    console.log('✗ 获取 Topic 失败:', error.message);
    return { success: false, error: error.message };
  }
}

async function testTopicStats(tenant = 'public', namespace = 'default', topicName = 'test-topic') {
  try {
    console.log(`\n[测试] 获取 Topic 统计信息: persistent://${tenant}/${namespace}/${topicName}`);
    
    const response = await axios.get(
      `${ADMIN_API_URL}/admin/v2/persistent/${tenant}/${namespace}/${topicName}/stats`,
      { timeout: 10000 }
    );
    
    console.log('✓ 获取 Topic 统计成功');
    console.log('  消息输入速率:', response.data.msgRateIn, 'msg/s');
    console.log('  消息输出速率:', response.data.msgRateOut, 'msg/s');
    console.log('  积压消息:', response.data.backlogSize);
    console.log('  存储大小:', response.data.storageSize, 'bytes');
    
    return { success: true, data: response.data };
  } catch (error) {
    console.log('✗ 获取 Topic 统计失败:', error.message);
    return { success: false, error: error.message };
  }
}

async function testSubscriptions(tenant = 'public', namespace = 'default', topicName = 'test-topic') {
  try {
    console.log(`\n[测试] 获取订阅列表: persistent://${tenant}/${namespace}/${topicName}`);
    
    const response = await axios.get(
      `${ADMIN_API_URL}/admin/v2/persistent/${tenant}/${namespace}/${topicName}/subscriptions`,
      { timeout: 10000 }
    );
    
    console.log('✓ 获取订阅成功');
    console.log('  订阅列表:', response.data);
    
    return { success: true, data: response.data };
  } catch (error) {
    console.log('✗ 获取订阅失败:', error.message);
    return { success: false, error: error.message };
  }
}

async function testCreateTopic(tenant = 'public', namespace = 'default', topicName = 'test-topic') {
  try {
    console.log(`\n[测试] 创建测试 Topic: persistent://${tenant}/${namespace}/${topicName}`);
    
    await axios.put(
      `${ADMIN_API_URL}/admin/v2/persistent/${tenant}/${namespace}/${topicName}`,
      {},
      { timeout: 10000 }
    );
    
    console.log('✓ Topic 创建成功');
    
    return { success: true };
  } catch (error) {
    if (error.response && error.response.status === 409) {
      console.log('~ Topic 已存在 (409)');
      return { success: true };
    }
    console.log('✗ Topic 创建失败:', error.message);
    return { success: false, error: error.message };
  }
}

async function testClusterInfo(clusterName = 'standalone') {
  try {
    console.log(`\n[测试] 获取集群信息: ${clusterName}`);
    
    const response = await axios.get(`${ADMIN_API_URL}/admin/v2/clusters/${clusterName}`, {
      timeout: 10000,
    });
    
    console.log('✓ 获取集群信息成功');
    console.log('  服务URL:', response.data.serviceUrl);
    console.log('  Broker URL:', response.data.brokerServiceUrl);
    console.log('  版本:', response.data.version);
    
    return { success: true, data: response.data };
  } catch (error) {
    console.log('✗ 获取集群信息失败:', error.message);
    return { success: false, error: error.message };
  }
}

async function runAllTests() {
  console.log('='.repeat(60));
  console.log('Pulsar 集群连接测试');
  console.log('='.repeat(60));
  console.log('Broker URL:', BROKER_URL);
  console.log('Admin API:', ADMIN_API_URL);
  console.log('='.repeat(60));

  const results = [];

  const adminResult = await testAdminApi();
  results.push({ test: 'Admin API 连接', ...adminResult });

  if (adminResult.success) {
    const clusterInfoResult = await testClusterInfo();
    results.push({ test: '获取集群信息', ...clusterInfoResult });

    const tenantResult = await testTenants();
    results.push({ test: '获取租户列表', ...tenantResult });

    const namespaceResult = await testNamespaces();
    results.push({ test: '获取命名空间列表', ...namespaceResult });

    const topicResult = await testTopics();
    results.push({ test: '获取 Topic 列表', ...topicResult });

    const createResult = await testCreateTopic();
    results.push({ test: '创建测试 Topic', ...createResult });

    const statsResult = await testTopicStats();
    results.push({ test: '获取 Topic 统计', ...statsResult });

    const subscriptionResult = await testSubscriptions();
    results.push({ test: '获取订阅列表', ...subscriptionResult });
  }

  console.log('\n' + '='.repeat(60));
  console.log('测试报告');
  console.log('='.repeat(60));
  
  let passed = 0;
  let failed = 0;

  for (const result of results) {
    if (result.success) {
      console.log('✓', result.test);
      passed++;
    } else {
      console.log('✗', result.test + ':', result.error);
      failed++;
    }
  }

  console.log('='.repeat(60));
  console.log('总计:', passed + failed, '个测试');
  console.log('通过:', passed);
  console.log('失败:', failed);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((error) => {
  console.error('测试运行异常:', error);
  process.exit(1);
});
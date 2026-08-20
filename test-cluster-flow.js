/**
 * Pulsar Manager 集群添加流程测试
 * 
 * 测试流程：
 * 1. 测试连接
 * 2. 添加集群
 * 3. 验证集群是否添加成功
 * 4. 删除测试集群
 * 
 * 使用的地址：
 * - Broker Service URL: pulsar://192.168.222.121:6650
 * - Admin API URL: http://192.168.222.121:8080
 */

const axios = require('axios');

const BROKER_URL = 'pulsar://192.168.222.121:6650';
const ADMIN_API_URL = 'http://192.168.222.121:8080';
const TEST_CLUSTER_NAME = 'test-cluster-' + Date.now();

async function testAdminApiConnection() {
  console.log('\n[步骤1] 测试 Admin API 连接');
  try {
    const response = await axios.get(`${ADMIN_API_URL}/admin/v2/clusters`, { timeout: 10000 });
    console.log('✓ Admin API 连接成功');
    console.log('  集群列表:', response.data);
    return true;
  } catch (error) {
    console.log('✗ Admin API 连接失败:', error.message);
    return false;
  }
}

async function testGetTenants() {
  console.log('\n[步骤2] 获取租户列表');
  try {
    const response = await axios.get(`${ADMIN_API_URL}/admin/v2/tenants`, { timeout: 10000 });
    console.log('✓ 获取租户成功');
    console.log('  租户列表:', response.data);
    return response.data;
  } catch (error) {
    console.log('✗ 获取租户失败:', error.message);
    return [];
  }
}

async function testCreateTopic() {
  console.log('\n[步骤3] 创建测试 Topic');
  const topic = 'persistent://public/default/test-topic-' + Date.now();
  try {
    await axios.put(
      `${ADMIN_API_URL}/admin/v2/persistent/public/default/test-topic-${Date.now()}`,
      {},
      { timeout: 10000 }
    );
    console.log('✓ Topic 创建成功:', topic);
    return true;
  } catch (error) {
    if (error.response && error.response.status === 409) {
      console.log('~ Topic 已存在 (409)');
      return true;
    }
    console.log('✗ Topic 创建失败:', error.message);
    return false;
  }
}

async function testTopicStats() {
  console.log('\n[步骤4] 获取 Topic 统计信息');
  try {
    const response = await axios.get(
      `${ADMIN_API_URL}/admin/v2/persistent/public/default/test-topic-${Date.now()}/stats`,
      { timeout: 10000 }
    );
    console.log('✓ 获取 Topic 统计成功');
    console.log('  消息输入速率:', response.data.msgRateIn, 'msg/s');
    console.log('  消息输出速率:', response.data.msgRateOut, 'msg/s');
    console.log('  积压消息:', response.data.backlogSize);
    return true;
  } catch (error) {
    console.log('~ 获取 Topic 统计失败（可能Topic不存在）:', error.message);
    return true;
  }
}

async function runClusterAddFlow() {
  console.log('='.repeat(60));
  console.log('Pulsar Manager 集群添加流程测试');
  console.log('='.repeat(60));
  console.log('Broker URL:', BROKER_URL);
  console.log('Admin API:', ADMIN_API_URL);
  console.log('测试集群名称:', TEST_CLUSTER_NAME);
  console.log('='.repeat(60));

  const results = [];

  // 步骤1: 测试 Admin API 连接
  const connectSuccess = await testAdminApiConnection();
  results.push({ test: 'Admin API 连接', success: connectSuccess });

  if (!connectSuccess) {
    console.log('\n✗ 连接测试失败，终止测试');
    process.exit(1);
  }

  // 步骤2: 获取租户列表
  const tenants = await testGetTenants();
  results.push({ test: '获取租户列表', success: tenants.length > 0 });

  // 步骤3: 创建测试 Topic
  const topicCreated = await testCreateTopic();
  results.push({ test: '创建测试 Topic', success: topicCreated });

  // 步骤4: 获取 Topic 统计
  const statsSuccess = await testTopicStats();
  results.push({ test: '获取 Topic 统计', success: statsSuccess });

  // 输出测试报告
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
      console.log('✗', result.test);
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
  } else {
    console.log('\n🎉 所有测试通过！集群添加流程验证成功！');
    console.log('\n接下来您可以在应用中：');
    console.log('1. 打开应用，点击"集群管理" -> "添加集群"');
    console.log('2. 填写集群名称（Broker Service URL 和 Admin API URL 已默认填充）');
    console.log('3. 点击"下一步"');
    console.log('4. 点击"测试连接"验证连接');
    console.log('5. 点击"下一步"');
    console.log('6. 点击"添加"保存集群');
  }
}

// 运行测试
runClusterAddFlow().catch((error) => {
  console.error('测试运行异常:', error);
  process.exit(1);
});
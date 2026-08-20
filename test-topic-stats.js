const axios = require('axios');

const baseUrl = 'http://192.168.222.121:8080';

async function testStats() {
  const topic = 'persistent://public/default/test-topic';
  
  console.log(`测试 Topic 统计: ${topic}\n`);
  
  // 测试 stats 端点
  try {
    console.log('1. 测试 /stats 端点:');
    const statsResponse = await axios.get(`${baseUrl}/admin/v2/persistent/public/default/test-topic/stats`);
    console.log(`   ✓ 成功: ${statsResponse.status}`);
    console.log(`   响应数据:`, JSON.stringify(statsResponse.data, null, 2));
  } catch (error) {
    console.log(`   ✗ 失败: ${error.response?.status} - ${error.response?.data?.message || error.message}`);
  }
  
  // 测试 info 端点
  try {
    console.log('\n2. 测试 /info 端点:');
    const infoResponse = await axios.get(`${baseUrl}/admin/v2/persistent/public/default/test-topic/info`);
    console.log(`   ✓ 成功: ${infoResponse.status}`);
    console.log(`   响应数据:`, JSON.stringify(infoResponse.data, null, 2));
  } catch (error) {
    console.log(`   ✗ 失败: ${error.response?.status} - ${error.response?.data?.message || error.message}`);
  }
  
  // 测试状态端点
  try {
    console.log('\n3. 测试 /status 端点:');
    const statusResponse = await axios.get(`${baseUrl}/admin/v2/persistent/public/default/test-topic/status`);
    console.log(`   ✓ 成功: ${statusResponse.status}`);
    console.log(`   响应数据:`, JSON.stringify(statusResponse.data, null, 2));
  } catch (error) {
    console.log(`   ✗ 失败: ${error.response?.status} - ${error.response?.data?.message || error.message}`);
  }
  
  // 获取订阅列表
  try {
    console.log('\n4. 测试 /subscriptions 端点:');
    const subsResponse = await axios.get(`${baseUrl}/admin/v2/persistent/public/default/test-topic/subscriptions`);
    console.log(`   ✓ 成功: ${subsResponse.status}`);
    console.log(`   响应数据:`, JSON.stringify(subsResponse.data, null, 2));
  } catch (error) {
    console.log(`   ✗ 失败: ${error.response?.status} - ${error.response?.data?.message || error.message}`);
  }
}

testStats().catch(console.error);
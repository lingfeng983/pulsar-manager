/**
 * Pulsar Admin API 端点测试脚本
 * 用于发现正确的 API 端点路径
 */

const axios = require('axios');

const baseUrl = 'http://192.168.222.121:8080';

const endpoints = [
  // 健康检查端点
  '/admin/v2/health',
  '/health',
  '/ready',
  
  // 集群信息
  '/admin/v2/clusters',
  
  // 租户相关
  '/admin/v2/tenants',
  
  // 命名空间相关
  '/admin/v2/namespaces/public',
  
  // Topic 相关
  '/admin/v2/namespaces/public/default/topics',
  
  // 统计信息
  '/admin/v2/persistent/public/default/test-topic/stats',
  '/admin/v2/persistent/public/default/test-topic/info',
];

async function testEndpoints() {
  console.log('=== Pulsar Admin API 端点测试 ===\n');
  console.log(`基础URL: ${baseUrl}\n`);

  const results = [];

  for (const endpoint of endpoints) {
    const fullUrl = `${baseUrl}${endpoint}`;
    try {
      const response = await axios.get(fullUrl, { timeout: 5000 });
      results.push({
        endpoint,
        status: '✓',
        statusCode: response.status,
        message: '成功',
        data: response.data ? typeof response.data === 'object' ? JSON.stringify(response.data).substring(0, 100) + '...' : String(response.data).substring(0, 100) : '无数据'
      });
    } catch (error) {
      results.push({
        endpoint,
        status: '✗',
        statusCode: error.response?.status || '网络错误',
        message: error.response?.data?.reason || error.response?.data?.message || error.message,
        data: null
      });
    }
  }

  // 打印结果
  console.log('测试结果:');
  console.log('-' . repeat(120));
  console.log(`| 状态 | HTTP状态 | 端点路径 | 消息 |`);
  console.log('-' . repeat(120));
  
  for (const result of results) {
    const statusColor = result.status === '✓' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`| ${statusColor} | ${result.statusCode.toString().padEnd(8)} | ${result.endpoint.padEnd(50)} | ${result.message.substring(0, 30)} |`);
  }
  
  console.log('-' . repeat(120));
  
  // 输出详细信息
  console.log('\n详细信息:');
  for (const result of results) {
    if (result.status === '✓') {
      console.log(`\n✓ ${result.endpoint}`);
      console.log(`   状态码: ${result.statusCode}`);
      console.log(`   响应: ${result.data}`);
    }
  }
}

testEndpoints().catch(console.error);
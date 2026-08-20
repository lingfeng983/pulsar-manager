/**
 * Pulsar 集群连接测试脚本
 * 使用给定的地址进行测试
 * 
 * Broker Service URL: pulsar://192.168.222.121:6650
 * Admin API URL: http://192.168.222.121:8080
 */

import axios from 'axios'

const BROKER_URL = 'pulsar://192.168.222.121:6650'
const ADMIN_API_URL = 'http://192.168.222.121:8080'

async function testAdminApi(): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    console.log(`\n[测试] 连接 Admin API: ${ADMIN_API_URL}`)
    
    const response = await axios.get(`${ADMIN_API_URL}/admin/v2/clusters`, {
      timeout: 10000,
    })
    
    console.log(`✓ Admin API 连接成功`)
    console.log(`  集群列表:`, response.data)
    
    return { success: true, data: response.data }
  } catch (error: any) {
    console.log(`✗ Admin API 连接失败: ${error.message}`)
    return { success: false, error: error.message }
  }
}

async function testTenants(): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    console.log(`\n[测试] 获取租户列表`)
    
    const response = await axios.get(`${ADMIN_API_URL}/admin/v2/tenants`, {
      timeout: 10000,
    })
    
    console.log(`✓ 获取租户成功`)
    console.log(`  租户列表:`, response.data)
    
    return { success: true, data: response.data }
  } catch (error: any) {
    console.log(`✗ 获取租户失败: ${error.message}`)
    return { success: false, error: error.message }
  }
}

async function testNamespaces(tenant: string = 'public'): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    console.log(`\n[测试] 获取命名空间列表 (租户: ${tenant})`)
    
    const response = await axios.get(`${ADMIN_API_URL}/admin/v2/tenants/${tenant}/namespaces`, {
      timeout: 10000,
    })
    
    console.log(`✓ 获取命名空间成功`)
    console.log(`  命名空间列表:`, response.data)
    
    return { success: true, data: response.data }
  } catch (error: any) {
    console.log(`✗ 获取命名空间失败: ${error.message}`)
    return { success: false, error: error.message }
  }
}

async function testTopics(tenant: string = 'public', namespace: string = 'default'): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    console.log(`\n[测试] 获取 Topic 列表 (${tenant}/${namespace})`)
    
    const response = await axios.get(`${ADMIN_API_URL}/admin/v2/namespaces/${tenant}/${namespace}/topics`, {
      timeout: 10000,
    })
    
    console.log(`✓ 获取 Topic 成功`)
    console.log(`  Topic 列表:`, response.data)
    
    return { success: true, data: response.data }
  } catch (error: any) {
    console.log(`✗ 获取 Topic 失败: ${error.message}`)
    return { success: false, error: error.message }
  }
}

async function testTopicStats(topic: string = 'persistent://public/default/test-topic'): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    console.log(`\n[测试] 获取 Topic 统计信息: ${topic}`)
    
    const encodedTopic = encodeURIComponent(topic)
    const response = await axios.get(`${ADMIN_API_URL}/admin/v2/persistent/${encodedTopic}/stats`, {
      timeout: 10000,
    })
    
    console.log(`✓ 获取 Topic 统计成功`)
    console.log(`  统计信息:`, JSON.stringify(response.data, null, 2))
    
    return { success: true, data: response.data }
  } catch (error: any) {
    console.log(`✗ 获取 Topic 统计失败: ${error.message}`)
    return { success: false, error: error.message }
  }
}

async function testSendMessage(): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`\n[测试] 发送消息到 Topic`)
    
    const message = {
      payload: Buffer.from(JSON.stringify({
        test: 'hello',
        timestamp: Date.now(),
      })).toString('base64'),
      properties: {},
    }
    
    const response = await axios.post(
      `${ADMIN_API_URL}/admin/v2/producer/persistent/public/default/test-topic`,
      message,
      {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      }
    )
    
    console.log(`✓ 消息发送成功`)
    console.log(`  响应:`, response.data)
    
    return { success: true }
  } catch (error: any) {
    console.log(`✗ 消息发送失败: ${error.message}`)
    return { success: false, error: error.message }
  }
}

async function testCreateTopic(): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`\n[测试] 创建测试 Topic`)
    
    await axios.put(
      `${ADMIN_API_URL}/admin/v2/persistent/public/default/test-topic`,
      {},
      {
        timeout: 10000,
      }
    )
    
    console.log(`✓ Topic 创建成功`)
    
    return { success: true }
  } catch (error: any) {
    if (error.response?.status === 409) {
      console.log(`~ Topic 已存在 (409)`)
      return { success: true }
    }
    console.log(`✗ Topic 创建失败: ${error.message}`)
    return { success: false, error: error.message }
  }
}

async function runAllTests() {
  console.log('='.repeat(60))
  console.log('Pulsar 集群连接测试')
  console.log('='.repeat(60))
  console.log(`Broker URL: ${BROKER_URL}`)
  console.log(`Admin API: ${ADMIN_API_URL}`)
  console.log('='.repeat(60))

  const results: { test: string; success: boolean; error?: string }[] = []

  // 测试连接
  const adminResult = await testAdminApi()
  results.push({ test: 'Admin API 连接', ...adminResult })

  if (adminResult.success) {
    // 测试租户
    const tenantResult = await testTenants()
    results.push({ test: '获取租户列表', ...tenantResult })

    // 测试命名空间
    const namespaceResult = await testNamespaces()
    results.push({ test: '获取命名空间列表', ...namespaceResult })

    // 测试 Topic
    const topicResult = await testTopics()
    results.push({ test: '获取 Topic 列表', ...topicResult })

    // 创建测试 Topic
    const createResult = await testCreateTopic()
    results.push({ test: '创建测试 Topic', ...createResult })

    // 发送消息
    const sendResult = await testSendMessage()
    results.push({ test: '发送消息', ...sendResult })

    // 获取 Topic 统计
    const statsResult = await testTopicStats()
    results.push({ test: '获取 Topic 统计', ...statsResult })
  }

  // 输出测试报告
  console.log('\n' + '='.repeat(60))
  console.log('测试报告')
  console.log('='.repeat(60))
  
  let passed = 0
  let failed = 0

  for (const result of results) {
    if (result.success) {
      console.log(`✓ ${result.test}`)
      passed++
    } else {
      console.log(`✗ ${result.test}: ${result.error}`)
      failed++
    }
  }

  console.log('='.repeat(60))
  console.log(`总计: ${passed + failed} 个测试`)
  console.log(`通过: ${passed}`)
  console.log(`失败: ${failed}`)
  console.log('='.repeat(60))

  if (failed > 0) {
    process.exit(1)
  }
}

// 运行测试
runAllTests().catch((error) => {
  console.error('测试运行异常:', error)
  process.exit(1)
})
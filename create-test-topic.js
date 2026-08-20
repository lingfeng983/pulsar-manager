const axios = require('axios');

const baseUrl = 'http://192.168.222.121:8080';

async function createTopic() {
  const topic = 'persistent://public/default/test-topic';
  
  try {
    console.log(`创建 Topic: ${topic}`);
    const response = await axios.put(`${baseUrl}/admin/v2/persistent/public/default/test-topic`, {}, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    console.log(`Topic 创建成功: ${response.status}`);
    
    // 发送测试消息
    console.log('\n发送测试消息...');
    const messageData = {
      payload: Buffer.from('Hello Pulsar!').toString('base64'),
      properties: { key: 'value' }
    };
    const produceResponse = await axios.post(
      `${baseUrl}/admin/v2/persistent/public/default/test-topic/messages`,
      messageData,
      { headers: { 'Content-Type': 'application/json' } }
    );
    console.log(`消息发送成功: ${produceResponse.status}`);
    
    // 获取统计信息
    console.log('\n获取 Topic 统计信息...');
    const statsResponse = await axios.get(`${baseUrl}/admin/v2/persistent/public/default/test-topic/stats`);
    console.log('统计信息:', JSON.stringify(statsResponse.data, null, 2));
    
  } catch (error) {
    console.error('错误:', error.response?.data || error.message);
  }
}

createTopic().catch(console.error);
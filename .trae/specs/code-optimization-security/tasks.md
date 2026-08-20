# Pulsar Manager - 代码优化与安全修复实现计划

## [ ] Task 1: 修复SQL注入漏洞 (sqlite.ts)
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 在updateCluster函数中添加字段名白名单校验，禁止直接使用Object.keys()的结果
  - 在updateSSHTunnel函数中添加相同的白名单校验
  - 定义允许更新的字段列表，拒绝非法字段名
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `programmatic` TR-1.1: 传入包含恶意字段名的update请求应被拒绝并返回错误
  - `programmatic` TR-1.2: 传入合法字段名的update请求应正常执行
- **Notes**: 使用better-sqlite3的参数化查询特性，同时对字段名进行白名单过滤

## [ ] Task 2: 修复敏感数据解密失败处理 (handlers.ts)
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 修改decryptSensitiveFields函数，在解密失败时抛出明确错误而非静默返回原始数据
  - 确保错误信息不泄露敏感内容
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `programmatic` TR-2.1: 传入无效加密数据时应抛出明确错误
  - `programmatic` TR-2.2: 传入有效加密数据时应正确解密并返回
- **Notes**: 遵循项目约定，使用formatError()处理错误信息

## [ ] Task 3: 修复Topic类型支持 (pulsar-admin.ts)
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 修改getTopicStats函数，根据topicUri判断Topic类型（persistent/non-persistent）
  - 动态构建API路径，支持两种Topic类型
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `human-judgment` TR-3.1: 查看non-persistent类型Topic详情时应正常显示数据
- **Notes**: 需要从Topic对象中获取topicUri来判断类型

## [ ] Task 4: 优化聚合统计API调用 (pulsar-admin.ts)
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 修改getAggregatedStats函数，使用Promise.all并行化获取各命名空间的统计
  - 添加请求超时控制，避免长时间阻塞
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-4.1: 50个Topic的聚合统计响应时间应小于10秒
- **Notes**: 注意控制并发数量，避免超出API限制

## [ ] Task 5: 添加请求取消机制 (TopicDetail.tsx)
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 在TopicDetail组件中使用AbortController实现请求取消
  - 在组件卸载和重新获取数据时取消之前的请求
  - 防止15秒轮询导致的竞态条件
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `human-judgment` TR-5.1: 快速切换Topic时不应出现旧数据覆盖新数据的情况
- **Notes**: 使用axios的CancelToken或AbortController

## [ ] Task 6: 优化集群拓扑获取 (pulsar-admin.ts)
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 修改getClusterTopology函数，使用Promise.all并行化获取各租户的信息
  - 优化数据结构，减少冗余计算
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-6.1: 100个Topic的拓扑获取响应时间应小于15秒
- **Notes**: 与Task 4共享部分优化逻辑

## [ ] Task 7: 修复右键菜单关闭功能 (ResourceTree.tsx)
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 添加document点击事件监听器，点击菜单外部时关闭右键菜单
  - 使用useEffect管理事件监听器的生命周期
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `human-judgment` TR-7.1: 打开右键菜单后点击外部区域应自动关闭菜单
- **Notes**: 需要处理事件冒泡和目标元素判断

## [ ] Task 8: 修复TopicDetail组件Tabs.TabPane (TopicDetail.tsx)
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 替换已废弃的Tabs.TabPane写法，使用items配置方式
  - 确保所有Tab内容正确渲染
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `human-judgment` TR-8.1: Topic详情页所有Tab标签页应正常切换和显示内容
- **Notes**: 参考Ant Design v5的Tabs组件API

## [ ] Task 9: 修复配置页分区数显示 (TopicDetail.tsx)
- **Priority**: medium
- **Depends On**: Task 3
- **Description**: 
  - 添加获取Topic配置的API调用，获取实际分区数
  - 更新配置页显示，显示真实的分区数和其他配置信息
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `human-judgment` TR-9.1: 配置页应显示实际的分区数而非"未知"
- **Notes**: 需要调用getTopicConfig API

## [ ] Task 10: 实现metrics:query IPC处理器 (handlers.ts)
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 在handlers.ts中注册metrics:query IPC处理器
  - 实现Prometheus指标查询功能，支持时间范围参数
- **Acceptance Criteria Addressed**: AC-7
- **Test Requirements**:
  - `programmatic` TR-10.1: 调用metrics.query方法应返回有效响应或明确错误
- **Notes**: 需要解析Prometheus格式的指标数据

## [ ] Task 11: 添加IPC通道输入验证 (handlers.ts)
- **Priority**: low
- **Depends On**: Task 1
- **Description**: 
  - 对所有IPC通道的输入参数添加Zod验证
  - 添加输入清理和规范化处理
- **Acceptance Criteria Addressed**: AC-1, AC-7
- **Test Requirements**:
  - `programmatic` TR-11.1: 传入无效参数应被拒绝并返回错误
- **Notes**: 部分通道已有Zod验证，需补充缺失的验证

## [ ] Task 12: 实现编辑配置按钮功能 (TopicDetail.tsx)
- **Priority**: low
- **Depends On**: Task 9
- **Description**: 
  - 添加编辑Topic配置的弹窗
  - 实现配置更新功能，支持调整分区数等参数
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `human-judgment` TR-12.1: 点击编辑配置按钮应弹出编辑弹窗
  - `human-judgment` TR-12.2: 修改配置并保存应成功更新
- **Notes**: 需要后端支持Topic配置更新API
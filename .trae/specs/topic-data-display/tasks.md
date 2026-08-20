# Pulsar Manager - Topic 数据显示问题修复实现计划

## [x] Task 1: 修复 ResourceTree 中 topic 参数传递错误
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 修改 `loadTreeNodeData` 函数中 topic 节点的 `dataRef` 构建逻辑
  - 将 `topic: topic.name` 修改为只存储纯 topic 名称（从 `topic.name` 中提取最后一部分）
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `human-judgement` TR-1.1: `dataRef.topic` 只包含纯 topic 名称，不含 tenant/namespace
- **Notes**: `topic.name` 的格式为 `tenant/namespace/topicName`，需要提取最后一部分

## [x] Task 2: 验证 TopicDetail 页面数据显示
- **Priority**: high
- **Depends On**: Task 1
- **Description**: 
  - 验证 TopicDetail 页面接收到的 `topic` 参数是纯名称
  - 验证 `getTopicStats` API 调用参数正确
  - 验证页面能正确显示统计数据
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `human-judgement` TR-2.1: TopicDetail 页面能正确显示 Topic 统计数据
  - `human-judgement` TR-2.2: 应用编译通过，无 TypeScript 错误
- **Notes**: 需要运行应用进行实际验证

## [x] Task 3: 代码审查和验证
- **Priority**: medium
- **Depends On**: Task 1, Task 2
- **Description**: 
  - 审查修改的代码
  - 运行应用验证功能正常
- **Acceptance Criteria Addressed**: 所有 AC
- **Test Requirements**:
  - `human-judgement` TR-3.1: 所有修复的功能正常
  - `human-judgement` TR-3.2: 应用启动正常，无运行时错误

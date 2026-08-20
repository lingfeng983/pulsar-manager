# Pulsar Manager 代码扫描与优化 - 实现计划

## [ ] Task 1: 修复 MessageBrowser 导出按钮功能
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 实现导出按钮功能，将消息数据导出为 JSON 文件
  - 添加 loading 状态和成功提示
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `programmatic` TR-1.1: 点击导出按钮应触发文件下载
  - `human-judgement` TR-1.2: 导出过程有 loading 状态，完成后有成功提示
- **Notes**: 使用浏览器原生下载 API

## [ ] Task 2: 修复 TopicDetail 订阅操作按钮
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 为订阅操作按钮（重置游标、跳过消息、删除）添加确认对话框
  - 实现删除订阅功能
  - 其他按钮暂显示"功能开发中"提示
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `human-judgement` TR-2.1: 点击删除按钮弹出确认对话框
  - `human-judgement` TR-2.2: 删除成功后列表更新并显示提示
- **Notes**: 删除订阅需要调用 API

## [ ] Task 3: 修复 TopicDetail 创建订阅按钮
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 添加创建订阅的 Modal 表单
  - 实现创建订阅功能
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `human-judgement` TR-3.1: 点击按钮弹出表单
  - `human-judgement` TR-3.2: 填写表单后成功创建订阅
- **Notes**: 需要调用 createSubscription API

## [ ] Task 4: 修复 TopNav 搜索功能
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 实现搜索框的基本搜索功能
  - 支持按集群、租户、Topic 名称搜索
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `human-judgement` TR-4.1: 输入关键词显示搜索结果
  - `human-judgement` TR-4.2: 点击结果跳转对应页面
- **Notes**: 搜索结果可以在侧边栏高亮显示

## [ ] Task 5: 修复 TopNav 未实现按钮
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 快速压测按钮：显示功能开发中提示
  - 导出日志按钮：导出应用日志文件
  - 设置菜单：添加占位功能
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `human-judgement` TR-5.1: 点击按钮有明确反馈
- **Notes**: 部分功能可能需要后续实现

## [ ] Task 6: 修复 ClusterConfig 保存按钮逻辑
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 修改保存按钮禁用逻辑，编辑模式下不强制要求测试连接
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `programmatic` TR-6.1: 编辑模式下无需测试连接即可保存
  - `programmatic` TR-6.2: 新建模式下提示建议测试连接
- **Notes**: 需要区分新建和编辑模式
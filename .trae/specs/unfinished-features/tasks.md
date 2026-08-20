# Pulsar Manager 未完成功能开发 - 实现计划

## [ ] Task 1: 实现 Topic 订阅重置游标功能
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 在 TopicDetail 订阅管理页面实现重置游标功能
  - 添加重置游标的确认对话框，支持选择重置位置（最早/最新/指定时间）
  - 调用 Pulsar Admin API 重置订阅游标
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `human-judgement` TR-1.1: 点击重置游标按钮弹出确认对话框
  - `human-judgement` TR-1.2: 选择重置位置后成功执行并显示结果
- **Notes**: 需要在 preload.ts 添加 resetCursor API

## [ ] Task 2: 实现 Topic 订阅跳过消息功能
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 在 TopicDetail 订阅管理页面实现跳过消息功能
  - 添加跳过消息的输入对话框，支持输入跳过数量
  - 调用 Pulsar Admin API 跳过指定数量的消息
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `human-judgement` TR-2.1: 点击跳过消息按钮弹出输入对话框
  - `human-judgement` TR-2.2: 输入数量后成功跳过并更新积压数
- **Notes**: 需要在 preload.ts 添加 skipMessages API

## [ ] Task 3: 实现删除 Topic 功能
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 在 TopicDetail 配置页面实现删除 Topic 功能
  - 添加确认对话框，显示警告信息
  - 调用 Pulsar Admin API 删除 Topic，成功后关闭当前 tab
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `human-judgement` TR-3.1: 点击删除按钮弹出确认对话框
  - `human-judgement` TR-3.2: 确认后成功删除并关闭 tab
- **Notes**: 需要在 preload.ts 添加 deleteTopic API

## [ ] Task 4: 实现全局搜索功能
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 在 TopNav 组件实现全局搜索功能
  - 添加搜索结果下拉面板
  - 支持搜索集群、租户、命名空间、Topic
  - 点击搜索结果跳转对应页面
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `human-judgement` TR-4.1: 输入关键词后显示搜索结果
  - `human-judgement` TR-4.2: 点击结果跳转对应页面
- **Notes**: 需要从资源树获取数据进行搜索

## [ ] Task 5: 实现 SSH 隧道实际连接
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 在主进程 handlers.ts 实现实际的 SSH 隧道连接
  - 使用 ssh2 库建立 SSH 连接和端口转发
  - 实现隧道状态管理（连接中、已连接、断开、错误）
  - 实现隧道断开功能
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `human-judgement` TR-5.1: 点击连接后显示连接状态
  - `human-judgement` TR-5.2: 连接成功后本地端口可访问
- **Notes**: 需要安装 ssh2 依赖

## [ ] Task 6: 实现 TabWorkspace tenant/namespace 页面
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 创建 TenantDetail 和 NamespaceDetail 组件
  - 在 TabWorkspace 中添加对应的 tab 类型渲染
  - 显示租户/命名空间的基本信息和 Topic 列表
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `human-judgement` TR-6.1: 点击资源树的租户打开对应页面
  - `human-judgement` TR-6.2: 页面显示租户信息和 Topic 列表
- **Notes**: 需要创建新的组件文件

## [ ] Task 7: 实现集群详情导航
- **Priority**: low
- **Depends On**: None
- **Description**: 
  - 在 Home 页面实现查看集群详情功能
  - 点击"查看"按钮后导航到资源树并展开该集群
- **Acceptance Criteria Addressed**: AC-7
- **Test Requirements**:
  - `human-judgement` TR-7.1: 点击查看按钮后资源树展开对应集群
- **Notes**: 需要与资源树状态同步

## [ ] Task 8: 实现检查更新功能
- **Priority**: low
- **Depends On**: None
- **Description**: 
  - 在 TopNav 设置菜单实现检查更新功能
  - 检查当前版本和最新版本
  - 显示版本信息和更新提示
- **Acceptance Criteria Addressed**: AC-8
- **Test Requirements**:
  - `human-judgement` TR-8.1: 点击检查更新显示版本信息
- **Notes**: 可使用 GitHub API 检查版本
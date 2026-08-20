# Pulsar Manager - 按钮功能排查实现计划

## [x] Task 1: 修复 ClusterTopology 组件的重置视图按钮
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 修复 `handleResetView` 函数，移除 dataZoom action（不适用于 graph 图表）
  - 使用 graphRoam action 实现正确的视图重置
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `human-judgement` TR-1.1: 点击重置按钮，图表应恢复默认缩放和位置
- **Notes**: graph 图表需要使用 graphRoam action，dataZoom 只适用于坐标轴类型图表

## [x] Task 2: 验证左侧菜单按钮功能
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 验证监控按钮 onClick 绑定正确
  - 验证拓扑按钮 onClick 绑定正确
  - 验证刷新按钮 onClick 绑定正确
  - 验证折叠/展开按钮 onClick 绑定正确
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-4, AC-5
- **Test Requirements**:
  - `human-judgement` TR-2.1: 所有左侧菜单按钮有正确的 onClick 绑定
  - `human-judgement` TR-2.2: 所有左侧菜单按钮功能正常工作
- **Notes**: ResourceTree 组件已检查，按钮绑定正确

## [x] Task 3: 验证页面按钮功能
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 验证首页按钮功能（添加集群、编辑、删除、查看、刷新）
  - 验证 TopicDetail 页面按钮功能
  - 验证其他页面按钮功能
- **Acceptance Criteria Addressed**: 所有 AC
- **Test Requirements**:
  - `human-judgement` TR-3.1: 所有页面按钮有正确的 onClick 绑定
  - `human-judgement` TR-3.2: 应用编译通过，无 TypeScript 错误
- **Notes**: 已检查的页面按钮绑定看起来正确

## [x] Task 4: 运行验证
- **Priority**: medium
- **Depends On**: Task 1, Task 2, Task 3
- **Description**: 
  - 运行应用验证所有按钮功能正常
  - 检查是否有其他潜在的按钮问题
- **Acceptance Criteria Addressed**: 所有 AC
- **Test Requirements**:
  - `human-judgement` TR-4.1: 所有修复的按钮功能正常
  - `human-judgement` TR-4.2: 应用启动正常，无运行时错误

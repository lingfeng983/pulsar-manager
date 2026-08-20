# Tenant/Namespace 页面与集群详情导航 - 实现计划

## [ ] Task 1: 创建 TenantDetail 组件
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 创建 TenantDetail 组件，展示租户基本信息（名称、管理角色、允许的集群）
  - 展示该租户下的命名空间列表
  - 支持点击命名空间跳转 NamespaceDetail 页面
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `human-judgement` TR-1.1: 页面显示租户基本信息
  - `human-judgement` TR-1.2: 页面显示命名空间列表
  - `human-judgement` TR-1.3: 点击命名空间跳转到对应页面
- **Notes**: 需要调用 getNamespaces API

## [ ] Task 2: 创建 NamespaceDetail 组件
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 创建 NamespaceDetail 组件，展示命名空间基本信息（名称、复制集群）
  - 展示该命名空间下的 Topic 列表
  - 支持点击 Topic 跳转 TopicDetail 页面
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `human-judgement` TR-2.1: 页面显示命名空间基本信息
  - `human-judgement` TR-2.2: 页面显示 Topic 列表
  - `human-judgement` TR-2.3: 点击 Topic 跳转到对应页面
- **Notes**: 需要调用 getTopics API

## [ ] Task 3: 更新 TabWorkspace 支持 tenant/namespace 类型
- **Priority**: high
- **Depends On**: Task 1, Task 2
- **Description**: 
  - 在 TabWorkspace 中添加 tenant 和 namespace 类型的 tab 渲染
  - 导入 TenantDetail 和 NamespaceDetail 组件
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `human-judgement` TR-3.1: tenant 类型 tab 正确渲染
  - `human-judgement` TR-3.2: namespace 类型 tab 正确渲染
- **Notes**: 需要修改 renderTabContent 函数

## [ ] Task 4: 实现资源树点击导航
- **Priority**: high
- **Depends On**: Task 3
- **Description**: 
  - 修改 ResourceTree 的点击处理逻辑
  - 点击 tenant 节点打开 tenant 类型的 tab
  - 点击 namespace 节点打开 namespace 类型的 tab
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `human-judgement` TR-4.1: 点击 tenant 打开对应页面
  - `human-judgement` TR-4.2: 点击 namespace 打开对应页面
- **Notes**: 需要修改 onSelect 处理函数

## [ ] Task 5: 实现集群详情导航
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 在 Home 页面实现"查看"按钮功能
  - 点击后在资源树中展开对应集群的节点
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `human-judgement` TR-5.1: 点击查看按钮后资源树展开对应集群
- **Notes**: 需要在 cluster store 中添加展开状态管理
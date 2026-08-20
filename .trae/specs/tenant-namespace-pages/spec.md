# Tenant/Namespace 页面与集群详情导航 - 产品需求文档

## Overview
- **Summary**: 实现 Tenant 和 Namespace 的详情页面，以及集群详情导航功能，支持从资源树点击打开对应页面
- **Purpose**: 完善资源管理的导航体验，让用户能够查看和管理租户、命名空间的详细信息
- **Target Users**: 开发人员、运维人员、Pulsar 集群管理员

## Goals
- 实现 TenantDetail 组件，展示租户信息和命名空间列表
- 实现 NamespaceDetail 组件，展示命名空间信息和 Topic 列表
- 在 TabWorkspace 中添加 tenant 和 namespace 类型的 tab 渲染
- 实现集群详情导航，点击集群后展开资源树
- 实现从资源树点击 tenant/namespace 打开对应页面

## Non-Goals (Out of Scope)
- 不实现租户/命名空间的创建和删除功能
- 不实现复杂的权限管理功能
- 不进行性能优化（除非为了实现功能必须）

## Background & Context
当前代码中：
1. TabWorkspace 只支持 home、metrics、topology 和 topic 类型的 tab
2. ResourceTree 点击 tenant/namespace 没有打开对应页面
3. Home 页面的"查看"按钮有 TODO 标记

## Functional Requirements
- **FR-1**: 创建 TenantDetail 组件，展示租户信息和命名空间列表
- **FR-2**: 创建 NamespaceDetail 组件，展示命名空间信息和 Topic 列表
- **FR-3**: 在 TabWorkspace 中添加 tenant 和 namespace 类型的 tab 渲染
- **FR-4**: 实现从资源树点击 tenant/namespace 打开对应页面
- **FR-5**: 实现集群详情导航，点击后展开资源树

## Non-Functional Requirements
- **NFR-1**: 页面加载时有 loading 状态
- **NFR-2**: 点击 Topic 能跳转到 TopicDetail 页面
- **NFR-3**: 代码符合现有项目风格和架构

## Constraints
- **Technical**: React + Ant Design, TypeScript
- **Dependencies**: 需要调用 Pulsar Admin API 获取数据

## Assumptions
- Pulsar Admin API 支持获取租户和命名空间信息

## Acceptance Criteria

### AC-1: TenantDetail 页面显示
- **Given**: 用户从资源树点击租户
- **When**: 打开 tenant 类型的 tab
- **Then**: 显示租户名称、管理角色、允许的集群等信息，以及命名空间列表
- **Verification**: `human-judgment`

### AC-2: NamespaceDetail 页面显示
- **Given**: 用户从资源树点击命名空间
- **When**: 打开 namespace 类型的 tab
- **Then**: 显示命名空间名称、复制集群等信息，以及 Topic 列表
- **Verification**: `human-judgment`

### AC-3: TabWorkspace 支持 tenant/namespace 类型
- **Given**: 系统中有 tenant 或 namespace 类型的 tab
- **When**: 切换到该 tab
- **Then**: 正确渲染对应的详情页面
- **Verification**: `human-judgment`

### AC-4: 资源树点击导航
- **Given**: 用户在资源树点击 tenant 或 namespace
- **When**: 点击节点
- **Then**: 打开对应的详情页面
- **Verification**: `human-judgment`

### AC-5: 集群详情导航
- **Given**: 用户在首页点击集群的"查看"按钮
- **When**: 点击按钮
- **Then**: 资源树展开该集群的节点
- **Verification**: `human-judgment`

## Open Questions
- [ ] 是否需要在 TenantDetail 中显示更多统计信息
- [ ] 是否需要在 NamespaceDetail 中显示更多统计信息
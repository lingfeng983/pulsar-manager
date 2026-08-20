# Pulsar Manager 未完成功能开发 - 产品需求文档

## Overview
- **Summary**: 整理代码库中所有未开发完成的功能，制定开发计划并逐步实现，确保产品功能完整可用
- **Purpose**: 解决现有功能缺失问题，提升产品完整性和用户体验
- **Target Users**: 开发团队、测试团队、最终用户

## Goals
- 实现所有标记为"开发中"的功能
- 实现所有 TODO 标记的功能
- 完善 SSH 隧道功能
- 实现全局搜索功能
- 实现 TabWorkspace 完整的 tab 类型支持

## Non-Goals (Out of Scope)
- 不添加全新功能模块
- 不进行架构重构
- 不优化性能（除非为了实现功能必须）

## Background & Context
通过代码扫描，发现以下未完成的功能：

### TopicDetail 页面
1. 重置游标功能
2. 跳过消息功能  
3. 删除 Topic 功能

### TopNav 组件
1. 全局搜索功能
2. 快速压测功能
3. 配置中心功能
4. 快捷键设置功能
5. 插件市场功能
6. 检查更新功能

### TabWorkspace 组件
1. tenant 和 namespace 类型的 tab 渲染

### Home 页面
1. 查看集群详情导航

### SSH 隧道
1. 实际的 SSH 隧道连接实现

### ClusterTopology
1. 节点点击事件处理

## Functional Requirements
- **FR-1**: 实现 Topic 订阅的重置游标功能
- **FR-2**: 实现 Topic 订阅的跳过消息功能
- **FR-3**: 实现删除 Topic 功能
- **FR-4**: 实现全局搜索功能
- **FR-5**: 实现 SSH 隧道实际连接功能
- **FR-6**: 实现 TabWorkspace 的 tenant/namespace tab 渲染
- **FR-7**: 实现集群详情导航功能
- **FR-8**: 实现检查更新功能

## Non-Functional Requirements
- **NFR-1**: 所有功能应有清晰的错误处理和用户提示
- **NFR-2**: 功能实现应符合现有代码风格和架构
- **NFR-3**: 所有功能应通过 TypeScript 编译检查

## Constraints
- **Technical**: React + Ant Design, Electron, TypeScript
- **Dependencies**: 需要实现 Electron 主进程 API

## Assumptions
- Pulsar Admin API 支持所有需要的操作
- SSH 隧道依赖 ssh2 库

## Acceptance Criteria

### AC-1: 重置游标功能
- **Given**: 用户在订阅管理页面
- **When**: 点击"重置游标"按钮
- **Then**: 弹出确认对话框，选择位置后重置游标
- **Verification**: `human-judgment`

### AC-2: 跳过消息功能
- **Given**: 用户在订阅管理页面
- **When**: 点击"跳过消息"按钮
- **Then**: 弹出输入框，输入跳过数量后执行
- **Verification**: `human-judgment`

### AC-3: 删除 Topic 功能
- **Given**: 用户在 Topic 配置页面
- **When**: 点击"删除 Topic"按钮
- **Then**: 弹出确认对话框，确认后删除 Topic
- **Verification**: `human-judgment`

### AC-4: 全局搜索功能
- **Given**: 用户在顶部导航栏搜索框输入关键词
- **When**: 按回车键或点击搜索
- **Then**: 显示匹配的集群/租户/Topic 列表，点击可跳转
- **Verification**: `human-judgment`

### AC-5: SSH 隧道连接
- **Given**: 用户配置了 SSH 隧道
- **When**: 点击连接按钮
- **Then**: 建立实际的 SSH 隧道连接
- **Verification**: `human-judgment`

### AC-6: TabWorkspace 完整支持
- **Given**: 用户从资源树点击 tenant 或 namespace
- **When**: 打开新的 tab
- **Then**: 显示对应的资源列表页面
- **Verification**: `human-judgment`

### AC-7: 检查更新功能
- **Given**: 用户点击"检查更新"
- **When**: 应用检查版本更新
- **Then**: 显示当前版本和最新版本信息
- **Verification**: `human-judgment`

## Open Questions
- [ ] 重置游标支持哪些位置选项（最早/最新/指定时间/指定消息ID）
- [ ] 跳过消息是否支持指定消息数量
- [ ] SSH 隧道是否需要支持自动重连
# Pulsar Manager 代码扫描与优化 - 产品需求文档

## Overview
- **Summary**: 对 Pulsar Manager 代码库进行全面扫描，识别按钮功能缺陷和代码问题，并进行修复优化
- **Purpose**: 确保所有按钮功能正常工作，提升代码质量和用户体验
- **Target Users**: 开发团队、测试团队、最终用户

## Goals
- 修复所有无效/未实现的按钮功能
- 优化代码结构，提升可维护性
- 确保所有按钮点击有正确响应
- 统一按钮样式和交互体验

## Non-Goals (Out of Scope)
- 不添加新功能模块
- 不修改整体架构设计
- 不进行性能优化（除按钮相关）

## Background & Context
通过全面扫描代码库，发现以下按钮问题：

1. **MessageBrowser.tsx**: 导出按钮无实现
2. **TopicDetail.tsx**: 订阅操作按钮（重置游标、跳过消息、删除）无实现；创建订阅按钮无实现；编辑配置/删除Topic按钮无实现
3. **TopNav.tsx**: 快速压测按钮无实现；导出日志按钮无实现；搜索框无实现；设置菜单项无实现
4. **ClusterConfig.tsx**: 添加/保存按钮在未测试连接时禁用（可能影响编辑场景）

## Functional Requirements
- **FR-1**: 修复 MessageBrowser 导出按钮功能
- **FR-2**: 修复 TopicDetail 中所有操作按钮功能
- **FR-3**: 修复 TopNav 中所有未实现的按钮功能
- **FR-4**: 修复 ClusterConfig 保存按钮禁用逻辑

## Non-Functional Requirements
- **NFR-1**: 所有按钮应有明确的点击反馈（loading状态、成功/失败提示）
- **NFR-2**: 按钮样式应统一，符合设计规范
- **NFR-3**: 按钮功能应具备错误处理机制

## Constraints
- **Technical**: React + Ant Design, TypeScript
- **Dependencies**: Electron 主进程 API 可能尚未实现某些功能

## Assumptions
- 所有按钮功能在 Electron 主进程已有对应 API 支持

## Acceptance Criteria

### AC-1: MessageBrowser 导出按钮
- **Given**: 用户在消息浏览器页面
- **When**: 点击"导出"按钮
- **Then**: 消息数据导出为 JSON 文件下载
- **Verification**: `programmatic`

### AC-2: TopicDetail 订阅操作按钮
- **Given**: 用户在订阅管理页面
- **When**: 点击"重置游标"、"跳过消息"或"删除"按钮
- **Then**: 弹出确认对话框，执行对应操作并显示结果
- **Verification**: `human-judgment`

### AC-3: TopicDetail 创建订阅按钮
- **Given**: 用户在订阅管理页面
- **When**: 点击"创建订阅"按钮
- **Then**: 弹出创建订阅表单，填写后创建订阅
- **Verification**: `human-judgment`

### AC-4: TopNav 搜索功能
- **Given**: 用户在顶部导航栏
- **When**: 输入搜索关键词并按回车
- **Then**: 显示搜索结果或跳转对应页面
- **Verification**: `human-judgment`

### AC-5: ClusterConfig 保存按钮
- **Given**: 用户编辑已有集群配置
- **When**: 点击"保存"按钮（未测试连接）
- **Then**: 允许保存，不强制要求测试连接
- **Verification**: `programmatic`

## Open Questions
- [ ] 导出消息的数据格式和文件名约定
- [ ] 重置游标/跳过消息的具体实现逻辑
- [ ] 搜索功能的具体范围和行为
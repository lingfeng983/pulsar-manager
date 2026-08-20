# Pulsar Manager - Topic 数据显示问题修复 PRD

## Overview
- **Summary**: 修复点击 Topic 时没有数据显示的问题，根本原因是前端传递的 topic 参数包含完整路径（如 `public/default/test-topic`），而后端期望只传递纯 topic 名称
- **Purpose**: 确保用户点击 Topic 后能正确显示统计数据和详情
- **Target Users**: Pulsar Manager 桌面应用的所有用户

## Goals
- 修复 ResourceTree 中 topic 参数传递错误的问题
- 确保 TopicDetail 页面能正确获取和显示数据

## Non-Goals (Out of Scope)
- 不修改后端 API 实现
- 不修改其他页面的功能

## Background & Context
- 项目使用 Electron + React + TypeScript 技术栈
- 后端 PulsarAdmin API `getTopics` 返回的 `topic.name` 包含完整路径（如 `public/default/test-topic`）
- 前端在 ResourceTree 中将完整路径存储到 `dataRef.topic` 中
- TopicDetail 页面传递完整路径给 `getTopicStats`，虽然后端有处理逻辑，但前端应该传递正确的参数

## Functional Requirements
- **FR-1**: ResourceTree 中 topic 的 `dataRef.topic` 应只存储纯 topic 名称（不含 tenant/namespace）
- **FR-2**: TopicDetail 页面能正确获取和显示 Topic 统计数据

## Non-Functional Requirements
- **NFR-1**: 修复应保持代码风格一致
- **NFR-2**: 修复应遵循项目现有的工程约定

## Constraints
- **Technical**: 使用现有的 API，不引入新的依赖

## Assumptions
- ResourceTree 中的 `dataRef` 已经包含 `clusterId`, `tenant`, `namespace` 信息
- 后端 `getTopicStats` API 期望参数为：`tenant`, `namespace`, `topic`（纯名称）

## Acceptance Criteria

### AC-1: Topic 参数传递正确
- **Given**: 用户在左侧菜单中展开 namespace 节点
- **When**: 加载 topics 列表并存储到 `dataRef`
- **Then**: `dataRef.topic` 应只包含纯 topic 名称（不含 tenant/namespace）
- **Verification**: `human-judgment`

### AC-2: TopicDetail 页面能正确显示数据
- **Given**: 用户点击某个 Topic
- **When**: 打开 TopicDetail 页面并调用 `getTopicStats` API
- **Then**: 页面应正确显示 Topic 的统计数据（消息速率、积压、生产者、消费者等）
- **Verification**: `human-judgment`

## Open Questions
- [ ] 是否需要在后端也加强参数校验？

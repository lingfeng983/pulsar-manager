# Pulsar Manager - 按钮功能详细排查 PRD

## Overview
- **Summary**: 详细排查左侧菜单和所有页面按钮的功能，修复不正常的按钮行为
- **Purpose**: 确保所有按钮功能正常工作，提升用户体验
- **Target Users**: Pulsar Manager 桌面应用的所有用户

## Goals
- 修复 ClusterTopology 组件中重置视图按钮使用错误 API 的问题
- 验证左侧菜单所有按钮功能正常
- 验证所有页面按钮功能正常

## Non-Goals (Out of Scope)
- 不修改按钮的样式和布局
- 不添加新的按钮功能
- 不实现"开发中"的功能

## Background & Context
- 项目使用 Electron + React + TypeScript 技术栈
- UI 组件库使用 Ant Design
- 图表使用 ECharts (echarts-for-react)

## Functional Requirements
- **FR-1**: ClusterTopology 组件的重置视图按钮应正确使用 graphRoam action
- **FR-2**: 左侧菜单所有按钮（监控、拓扑、刷新、折叠/展开）功能正常
- **FR-3**: 所有页面按钮功能正常

## Non-Functional Requirements
- **NFR-1**: 修复应保持代码风格一致
- **NFR-2**: 修复应遵循项目现有的工程约定

## Constraints
- **Technical**: 使用现有的 ECharts API，不引入新的依赖

## Assumptions
- ECharts 实例通过 `getEchartsInstance()` 获取
- ReactECharts 组件的 ref 可以正确获取图表实例

## Acceptance Criteria

### AC-1: ClusterTopology 重置视图按钮功能正常
- **Given**: 用户在集群拓扑页面
- **When**: 用户点击重置视图按钮
- **Then**: 图表应恢复默认缩放和位置
- **Verification**: `human-judgment`

### AC-2: 左侧菜单监控按钮功能正常
- **Given**: 用户在应用中
- **When**: 用户点击左侧菜单的监控按钮
- **Then**: 应打开监控仪表盘标签页
- **Verification**: `human-judgment`

### AC-3: 左侧菜单拓扑按钮功能正常
- **Given**: 用户在应用中
- **When**: 用户点击左侧菜单的拓扑按钮
- **Then**: 应打开集群拓扑标签页
- **Verification**: `human-judgment`

### AC-4: 左侧菜单刷新按钮功能正常
- **Given**: 用户在应用中
- **When**: 用户点击左侧菜单的刷新按钮
- **Then**: 应刷新集群列表
- **Verification**: `human-judgment`

### AC-5: 左侧菜单折叠/展开按钮功能正常
- **Given**: 用户在应用中
- **When**: 用户点击折叠/展开按钮
- **Then**: 菜单应正确折叠或展开
- **Verification**: `human-judgment`

## Open Questions
- [ ] 是否需要添加右键菜单中 topic 的"查看监控"功能实现？

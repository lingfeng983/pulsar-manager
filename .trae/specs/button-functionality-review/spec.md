# Pulsar Manager - 按钮功能扫描与修复 PRD

## Overview
- **Summary**: 扫描代码中所有按钮的功能实现，排查并修复不正常的按钮行为
- **Purpose**: 确保所有按钮功能正常工作，提升用户体验
- **Target Users**: Pulsar Manager 桌面应用的所有用户

## Goals
- 修复 HomeTopology 组件中无效的放大/缩小按钮
- 修复 ClusterTopology 组件中图表缩放按钮的实现问题
- 实现 MetricsDashboard 中全屏按钮的功能
- 确保所有按钮的 onClick 事件绑定正确

## Non-Goals (Out of Scope)
- 不实现"开发中"的功能（快速压测、配置中心等）
- 不修改按钮的样式和布局
- 不添加新的按钮功能

## Background & Context
- 项目使用 Electron + React + TypeScript 技术栈
- UI 组件库使用 Ant Design
- 图表使用 ECharts (echarts-for-react)

## Functional Requirements
- **FR-1**: HomeTopology 组件的放大/缩小按钮应正确控制图表缩放
- **FR-2**: ClusterTopology 组件的放大/缩小按钮应使用正确的 ECharts API
- **FR-3**: MetricsDashboard 组件的全屏按钮应实现全屏切换功能

## Non-Functional Requirements
- **NFR-1**: 修复应保持代码风格一致
- **NFR-2**: 修复应遵循项目现有的工程约定

## Constraints
- **Technical**: 使用现有的 ECharts API，不引入新的依赖
- **Dependencies**: ECharts graph 图表需要使用 `graphRoam` action 进行缩放

## Assumptions
- ECharts 实例通过 `getEchartsInstance()` 获取
- ReactECharts 组件的 ref 可以正确获取图表实例

## Acceptance Criteria

### AC-1: HomeTopology 放大按钮功能正常
- **Given**: 用户在首页拓扑视图中
- **When**: 用户点击放大按钮
- **Then**: 图表应放大 1.2 倍
- **Verification**: `human-judgment`

### AC-2: HomeTopology 缩小按钮功能正常
- **Given**: 用户在首页拓扑视图中
- **When**: 用户点击缩小按钮
- **Then**: 图表应缩小到原来的 0.8 倍
- **Verification**: `human-judgment`

### AC-3: ClusterTopology 放大按钮使用正确 API
- **Given**: 用户在集群拓扑页面
- **When**: 用户点击放大按钮
- **Then**: 使用 graphRoam action 进行缩放，图表应正确放大
- **Verification**: `human-judgment`

### AC-4: ClusterTopology 缩小按钮使用正确 API
- **Given**: 用户在集群拓扑页面
- **When**: 用户点击缩小按钮
- **Then**: 使用 graphRoam action 进行缩放，图表应正确缩小
- **Verification**: `human-judgment`

### AC-5: MetricsDashboard 全屏按钮功能正常
- **Given**: 用户在监控仪表盘页面
- **When**: 用户点击全屏按钮
- **Then**: 图表区域应进入全屏模式
- **Verification**: `human-judgment`

## Open Questions
- [ ] 是否需要添加图表重置按钮到 HomeTopology 组件？

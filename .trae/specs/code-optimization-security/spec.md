# Pulsar Manager - 代码优化与安全修复 PRD

## Overview

* **Summary**: 对Pulsar Manager进行全面的代码优化、安全漏洞修复和功能增强，涵盖安全加固、性能优化、代码质量提升和功能完善四个方面。

* **Purpose**: 修复现有代码中的安全漏洞，提升系统稳定性和性能，完善缺失的功能，确保生产环境安全可靠。

* **Target Users**: Pulsar Manager开发者和终端用户

## Goals

* 修复SQL注入等安全漏洞，确保数据安全

* 优化API调用性能，提升大型集群的响应速度

* 修复UI交互问题，提升用户体验

* 完善缺失的功能，确保功能完整性

## Non-Goals (Out of Scope)

* 新增未规划的功能模块

* 重构整个项目架构

* 更改项目技术栈

## Background & Context

当前项目是一个基于Electron + React + TypeScript的Pulsar桌面管理工具。通过代码审查发现了以下关键问题：

1. 数据库操作存在SQL注入风险
2. API调用性能存在瓶颈
3. UI组件存在交互缺陷
4. 部分功能仅实现后端，缺少前端交互

## Functional Requirements

### FR-1: 安全漏洞修复

* **FR-1.1**: 修复SQL注入漏洞 - 对数据库更新操作中的字段名进行白名单校验

* **FR-1.2**: 修复敏感数据解密失败处理 - 在解密失败时抛出明确错误而非静默返回原始数据

* **FR-1.3**: 修复Topic类型处理 - 支持persistent和non-persistent两种Topic类型

### FR-2: 性能优化

* **FR-2.1**: 优化聚合统计API调用 - 使用Promise.all并行化请求

* **FR-2.2**: 添加请求取消机制 - 防止Topic详情页轮询导致的竞态条件

* **FR-2.3**: 优化集群拓扑获取 - 并行化租户/命名空间/Topic的API调用

### FR-3: 代码质量修复

* **FR-3.1**: 修复右键菜单 - 添加点击外部关闭的功能

* **FR-3.2**: 修复TopicDetail组件 - 替换已废弃的Tabs.TabPane

* **FR-3.3**: 修复配置页 - 获取实际的Topic分区数

* **FR-3.4**: 实现编辑配置按钮功能

### FR-4: 功能完善

* **FR-4.1**: 实现metrics:query IPC处理器 - 注册preload.ts中引用的处理器

* **FR-4.2**: 添加IPC通道输入验证 - 对所有IPC通道添加参数校验和清理

## Non-Functional Requirements

* **NFR-1**: 安全性 - 所有数据库操作必须使用参数化查询或白名单校验

* **NFR-2**: 性能 - 聚合统计API响应时间不超过30秒（100个Topic以内）

* **NFR-3**: 可靠性 - 解密失败时必须抛出明确错误，不泄露敏感数据

* **NFR-4**: 可维护性 - 代码应遵循项目现有风格和约定

## Constraints

* **Technical**: 必须保持与现有API的兼容性，不破坏现有功能

* **Dependencies**: 不得引入新的第三方依赖

* **Platform**: 支持Windows/macOS/Linux三平台

## Assumptions

* 用户会配置至少一个Pulsar集群进行测试

* 集群规模在100个Topic以内

* 用户使用现代浏览器（Electron内置Chromium）

## Acceptance Criteria

### AC-1: SQL注入漏洞修复

* **Given**: 攻击者尝试通过updateCluster传入恶意字段名

* **When**: 调用updateCluster API

* **Then**: 系统拒绝请求并返回错误，不会执行恶意SQL

* **Verification**: `programmatic`

### AC-2: 敏感数据解密失败处理

* **Given**: 加密密钥损坏或数据被篡改

* **When**: 尝试解密敏感字段

* **Then**: 系统抛出明确错误，不会返回原始加密数据

* **Verification**: `programmatic`

### AC-3: Topic类型支持

* **Given**: 用户有non-persistent类型的Topic

* **When**: 查看Topic详情

* **Then**: 系统正确获取并显示non-persistent Topic的统计信息

* **Verification**: `human-judgment`

### AC-4: 聚合统计性能优化

* **Given**: 集群包含50个Topic分布在多个命名空间

* **When**: 获取聚合统计信息

* **Then**: 响应时间不超过10秒

* **Verification**: `programmatic`

### AC-5: 右键菜单关闭功能

* **Given**: 用户打开右键菜单

* **When**: 点击菜单外部区域

* **Then**: 右键菜单自动关闭

* **Verification**: `human-judgment`

### AC-6: Topic配置页分区数显示

* **Given**: 用户查看Topic配置页

* **When**: 页面加载完成

* **Then**: 显示实际的分区数而非"未知"

* **Verification**: `human-judgment`

### AC-7: metrics:query IPC处理器

* **Given**: 前端调用metrics.query方法

* **When**: IPC通信执行

* **Then**: 返回有效的响应或明确的错误信息

* **Verification**: `programmatic`

## Open Questions

* [ ] 是否需要添加对非持久化Topic的完整支持（创建、删除等操作）？

* [ ] 是否需要实现SSH隧道的完整功能？

* [x] 是否需要添加Tenant/Namespace的创建/删除UI？


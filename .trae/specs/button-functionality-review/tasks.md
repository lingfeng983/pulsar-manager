# Pulsar Manager - 按钮功能修复实现计划

## [x] Task 1: 修复 HomeTopology 组件的放大/缩小按钮
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 修复 `handleZoomIn` 函数，使用正确的 ECharts API 实现放大功能
  - 修复 `handleZoomOut` 函数，使用正确的 ECharts API 实现缩小功能
  - 使用 `graphRoam` action 替代当前的 `dispose()` 调用
- **Acceptance Criteria Addressed**: AC-1, AC-2
- **Test Requirements**:
  - `human-judgement` TR-1.1: 点击放大按钮，图表应放大
  - `human-judgement` TR-1.2: 点击缩小按钮，图表应缩小
- **Notes**: 需要使用 ECharts 的 dispatchAction 方法，type 为 'graphRoam'

## [x] Task 2: 修复 ClusterTopology 组件的放大/缩小按钮
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 修复 `handleZoomIn` 函数，使用 `graphRoam` action 替代 `dataZoom` action
  - 修复 `handleZoomOut` 函数，使用 `graphRoam` action 替代 `dataZoom` action
  - 因为图表类型是 graph，需要使用 graphRoam 而不是 dataZoom
- **Acceptance Criteria Addressed**: AC-3, AC-4
- **Test Requirements**:
  - `human-judgement` TR-2.1: 点击放大按钮，图表应正确放大
  - `human-judgement` TR-2.2: 点击缩小按钮，图表应正确缩小
- **Notes**: dataZoom 适用于坐标轴类型的图表，graph 图表需要使用 graphRoam

## [x] Task 3: 实现 MetricsDashboard 全屏按钮功能
- **Priority**: medium
- **Depends On**: None
- **Description**: 
  - 为 MetricsDashboard 中的全屏按钮添加 onClick 事件处理
  - 实现浏览器原生全屏 API 调用
  - 添加全屏状态切换逻辑
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `human-judgement` TR-3.1: 点击全屏按钮，图表区域应进入全屏
  - `human-judgement` TR-3.2: 再次点击或按 ESC 键，应退出全屏
- **Notes**: 需要使用 HTML5 Fullscreen API

## [x] Task 4: 代码审查和验证
- **Priority**: medium
- **Depends On**: Task 1, Task 2, Task 3
- **Description**: 
  - 审查所有修改的代码
  - 运行应用验证按钮功能正常
  - 检查是否有其他潜在的按钮问题
- **Acceptance Criteria Addressed**: 所有 AC
- **Test Requirements**:
  - `human-judgement` TR-4.1: 所有修复的按钮功能正常
  - `human-judgement` TR-4.2: 应用启动正常，无编译错误

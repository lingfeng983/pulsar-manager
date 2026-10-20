# 界面截图与演示素材采集清单

本目录用于存放 README「界面预览」引用的截图素材。截图采集后放入本目录，并在 `README.md` 的「界面预览」小节替换占位说明为对应图片。

## 命名约定

统一命名便于替换与维护：

| 文件名 | 内容 | 建议构图 |
| --- | --- | --- |
| `home.png` | 首页集群总览与监控 | 亮色主题、至少一个已连接集群、聚合统计可见 |
| `message-browser.png` | 消息浏览器 | 发送测试 + 消息列表同屏 |
| `producer-workbench.png` | 生产者工作台 | 常驻会话 + 实时统计 |
| `consumer-workbench.png` | 消费者工作台 | 分桶消息 + 速率 |
| `load-test.png` | 快速压测 | 压测进行中，吞吐/延迟可见 |
| `topology.png` | 集群拓扑 | 力导向或环形布局 |
| `inspection.png` | 巡检报告 | 一份体检报告，级别列可见 |
| `alert-center.png` | 告警中心 | 规则列表或事件列表 |
| `plugin-market.png` | 插件市场 | 插件卡片列表 |
| `docs-center.png` | 文档中心 | 目录 + 一篇文档 |

## 采集要求

- **真实数据**：对真实集群或 standalone（见 `docker-compose.yml`）操作所得，不造示例值
- **隐私脱敏**：截图前确认不含真实 Token、证书、SSH 密码或敏感 topic 名；集群地址如需展示请使用本地/演示地址
- **三套主题**：主截图用亮色（默认）；如需展示暗色/护眼，文件名加后缀（如 `home-dark.png`）
- **比例**：建议 16:10 或窗口实际比例，不拉伸变形；PNG 格式，长边不低于 1280px

## 动图（可选）

关键操作可用 GIF 演示（消息收发、压测、巡检告警通知），命名加 `-demo` 后缀（如 `load-test-demo.gif`），单张建议 5MB 以内、8 秒以内。

## 替换到 README

采集完成后，在 `README.md`「界面预览」小节把占位列表替换为：

```markdown
![首页](docs/screenshots/home.png)
![消息浏览器](docs/screenshots/message-browser.png)
...
```

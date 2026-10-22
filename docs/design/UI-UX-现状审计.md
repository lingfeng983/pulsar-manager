# Pulsar Manager 界面设计现状审计（2026-10）

> 范围：`src/renderer`（62 个 `.tsx`、`index.css` 1060 行）+ `components/layout`、`components/common`、`pages/Home`、`pages/MetricsDashboard`、`components/message` 等代表性实现，对照 `docs/design/Pulsar 桌面管理工具 UI 详细设计规范（最终完整版）.md`。
> 方法：静态代码审计 + 全量模式扫描。**未启动 Tauri 外壳做运行态验证**（需要真实集群与 WebView2），凡标注「需运行态确认」的结论是代码与算术推导，不是截图实证。
>
> **2026-10-22 更新：第二～五节列出的 P1/P2/P3 已全部修复，逐条改法与验收见第六节。** 第二～五节保留为审计当时的基线，方便复查"改了什么、为什么改"。

---

## 一、结论摘要

**设计系统的四层里，前三层已经建成，缺口集中在"最后一公里"和"分支路径"。**

与上一轮审计（`页面设计优化方案.md`，当时 20 个页面、0 处 `aria-*`）相比，那一轮 P0–P3 的主体已落地：`PageShell` / `StateBlock` / `IconButton` / `useConfirmDanger` 都建起来了并被大量复用（`<StateBlock>` 34 处调用；18 个页面里 17 个落在 `PageShell` 上，租户/命名空间详情经 `ResourceDetailPage` 间接复用），`aria-*` 从 0 涨到 90 处，右键菜单补了键盘入口，`20px/40px` 裸内边距已经清零。

所以现在的问题不再是"没有共享层"，而是三类：

1. **三套主题里各有一处真实不可读**——不是审美问题，是文字/图标看不见（P1-1）。
2. **所有响应式分支为 0**——61 个 `<Col span=>`，0 个 `xs/sm/md/lg`；顶栏在最小窗口下会被挤爆（P1-2）。
3. **只在"常规路径"上做对了**——键盘、无动画偏好、系统主题、加载骨架这些分支路径没有设计（P2）。

| 维度 | 现状 | 关键证据 |
|---|---|---|
| 设计令牌（色彩/间距/字号/圆角/阴影） | 🟢 完整 | `index.css` 三套主题 × 四档字号，`--font-size-*` 与 `fontScale.ts` 对齐 |
| 令牌消费率 | 🟢 高 | 全仓仅 2 处硬编码 hex（`TopNav.tsx:313`、`SchemaPanel.tsx:75`），图表配色经 `topologyColors.ts` 从 CSS 变量读 |
| 页面骨架一致性 | 🟢 好（1 处例外） | `PageShell` 统一 `.page-shell/.page-header/.page-body`，标题基线唯一；`MessageBrowser` 自管根容器，见 P2-4 |
| 三态占位 | 🟢 好 | `StateBlock` 固定 loading → error → empty 判定顺序 |
| 对比度 | 🔴 有三处硬伤 | 亮色主题下次要文字 3.24:1、行号 1.44:1、注释 1.59:1，见 P1-1 |
| 响应式 | 🔴 缺失 | 61 个固定 `span`，0 个断点属性；无 `matchMedia` |
| 键盘可达 | 🟡 主体达标、边角缺失 | `DocCenter` 目录/锚点为可点击 `div`/`li`，无 `tabIndex`/`role`/键盘处理 |
| 动效偏好 | 🔴 未处理 | 全仓 0 处 `prefers-reduced-motion` |
| 加载观感 | 🟡 只有 Spin | 0 处 `Skeleton`，规范 §6「优先骨架屏」未落地 |
| 规范文档 vs 实现 | 🟡 已漂移 | 文档里的 48/36/16/20/32 与代码的 44/30/12/18/28 全面对不上 |

---

## 二、按严重度的问题清单

### P1-1｜三套主题各有一处"真的看不见"（对比度）

全部为实测比值（WCAG 2.1：正文 ≥4.5:1，大字号 ≥3:1，非文字图标 ≥3:1），已用脚本按 sRGB 相对亮度公式验算。

| 位置 | 前景 / 背景 | 比值 | 后果 |
|---|---|---|---|
| `.hint-text`（75 处，12px 次要文字） | `--color-text-secondary` #86909c / #ffffff | **3.24:1** | 表格副标题、参数说明、统计补充行整片偏浅，长时间阅读吃力，不满足 AA |
| `.page-subtitle`、`.doc-kb-toc li`（13px） | 同上 | 3.24:1 | 同上 |
| CodeMirror 行号 `.cm-gutters` | `--color-text-tertiary` #c9cdd4 / `--color-bg-secondary` #f2f3f5 | **1.44:1** | 行号几乎不可见（代码编辑器的主要定位辅助） |
| JSON 语法注释（`cmTheme.ts:97,110`） | #c9cdd4 / #ffffff | **1.59:1** | 注释等于隐藏 |
| 亮色滚动条 thumb | #c9cdd4 / #f2f3f5 | 1.44:1 | 高密度滚动界面里滚动条失去位置指示作用 |
| `TopNav.tsx:313` topic 图标 | 硬编码 #722ed1 / 暗色 #17171a | **2.58:1** | 暗色主题下搜索下拉里的 topic 图标低于 3:1 |

**修法（改 token，不改用法）**：亮色 `--color-text-secondary` → `#4e5969`（7.10:1，仍是"次要"观感）；给行号/注释单独引入 `--color-text-faint: #86909c`（3.24:1，仅用于非正文装饰）或直接把行号提到 `--color-text-secondary`。正文色必须 ≥4.5，装饰色 ≥3。

> 另注：`--color-primary` #1677ff 在白底上是 4.10:1，antd 的链接态文字（`type="link"` 按钮，Home 表格每行 3 个）严格讲也不达 AA。改主色影响面大，建议只在"纯文字链接"场景用更深的 `#0958d9`（6.16:1）。

### P1-2｜响应式分支为 0：最小窗口下顶栏与图表都会被挤

- 扫描结果：`<Col span=>` **61 处**，`<Col xs/sm/md/lg=>` **0 处**，`matchMedia` **0 处**。
- 最小窗口 `min_inner_size(1000, 700)`（`rust/crates/pm-tauri/src/main.rs:164`），侧栏固定 240px，页面内边距 12px。
- **顶栏（需运行态确认）**：左区 8 个 `size="small"` 图标+文字按钮 + 1 个图标按钮 ≈ 536px，中间搜索 `clamp(200px, 26%, 520px)` 最少 200px，右区 4 个按钮 ≈ 300px，加 24px 内边距与组间距 ≈ **1080px > 1000px**。两侧是 `flex: 1 1 0` + `minWidth: 0`（`TopNav.tsx:477,578`），会各自收缩到约 400px——按钮文字是 `nowrap`，结果不是换行，而是顶出按钮边界、与相邻按钮重叠。
- **监控页**：4 张 `span={6}` 统计卡 + 2×2 张 `span={12}` 图表卡（`MetricsDashboard.tsx:749-871`）。1000px 窗口下每张图卡宽度约 **(1000 − 240 − 24 − 12) / 2 ≈ 362px**——给 2000 点的多序列时序图，横轴刻度会退化成一片。

**修法**：`<Col span={6} lg={12} xl={6}>`、`<Col span={12} lg={24} xl={12}>`，图表卡在 <1200px 时强制单列；顶栏在本仓库的密度下不是加断点能救的，见第三节。

### P1-3｜字号「小」档把中文压到 10px

`fontScale.ts:39-44` 的 `ANTD_FONT_BASE_PX.small = 10`，`index.css:120-126` 的 `--font-size-xs: 10px`。选「小」的用户（动机就是"一屏多放几行"）拿到的是**表格、按钮、页签全部 10px**。10px 中文在 WebView2 的 ClearType 渲染下笔画已糊成一片，属于"用可用性换密度"的负收益。建议把该档基准拉到 12px，密度改用行高与内边距（`cellPaddingBlockSM`）去省，不要动字号下限。

### P2-1｜键盘可达：主流路径达标，但文档中心整条路径断掉

`pages/DocCenter.tsx:201`（目录项 `div onClick`）、`:214`（锚点 `li onClick`）、`:248`（搜索结果 `List.Item onClick`）都是**不可聚焦、无 `role`、无 `onKeyDown`** 的可点击元素。纯键盘用户进文档中心后：Tab 只能到达"折叠"按钮和搜索框，**无法切换文章、无法跳转锚点**——整页对键盘用户是只读的。

对比之下 `ContextMenu.tsx` 做得对（`role="menu"/"menuitem"` + 方向键 + `:focus` 高亮），`ResourceTree` 也有 `role="img"` + `aria-label` + `onKeyDown`。所以这是**局部漏项而不是体系缺失**，修法统一：包成 `<button>` 或给 `tabIndex={0} role="button"` + `Enter/Space` + `aria-current`。

全仓 `tabIndex` 仅 1 处、`onKeyDown` 3 处，说明除了 antd 自带组件（Tree/Table/Select/Modal 都合格）之外，自绘交互基本没做键盘等价物。

### P2-2｜动效、系统主题、加载观感三个"分支路径"没设计

| 缺口 | 证据 | 影响 |
|---|---|---|
| 不尊重减少动效 | `prefers-reduced-motion` 0 处；`index.css:490,596,771` 有 transition，`:1049` 有 1.2s flash 动画 | 前庭敏感用户、长期盯屏的运维人员无法关掉动画 |
| 不跟随系统深浅色 | `store/theme.ts:28` 默认写死 `'light'`，`matchMedia` 0 处 | 夜间运维场景（规范 §1.3.2 明确定位）每次启动先白一下，要手动切 |
| 无骨架屏 | `Skeleton` 0 处，`StateBlock` 只有居中 `Spin` | 规范 §6「所有接口优先骨架屏」未落地；密集表格页首屏是"空白 + 转圈"而非"占位形状" |
| 无 live region | `aria-live` 0 处 | antd `Alert`/`message` 自带 role 的部分没问题，但巡检/轮询这类**就地更新**的状态变化不会被播报 |

### P2-3｜图标与视觉一致性

- **1 处 emoji 当图标**：`TopNav.tsx:620` 的关于弹窗 `<div style={{fontSize:32}}>⚡</div>`。项目图标唯一来源是 `npm run icon` 产出的 `rust/crates/pm-tauri/icons/icon.png`，弹窗里应该是那张图，而不是跨平台字形不一致的 emoji。
- 图标家族本身是统一的（全用 `@ant-design/icons` 线性风格），这点没问题。
- 硬编码 hex 只剩 2 处（P1-1 已列），且都没有注释说明为什么不用 token——`SchemaPanel.tsx:75` 的错误色 #d4380d 在暗色上是 3.72:1，12px 文字不达标。

### P2-4｜最大的那个页面绕过了页面骨架

`pages/MessageBrowser.tsx:1181` 的根节点是 `<div className="stack">`，**没有 `.page-shell`**。`.stack` 只有 `display:flex` 与 `gap`，不带 `padding` 与 `overflow`（`index.css:279-283`、`:323-329`）。

后果：它自己不带 12px 内容区留白，滚动由外层 `.main-workspace-tabs` 的 `overflow:auto` 兜住——也就是说**这个 1300 行、信息密度最高的页面，内容左右是贴着页签栏与侧栏边缘的**，与其余 17 个页面的基线差一拍，换页签时直接能看出来。

**修法**：根节点换成 `PageShell`（不传 title，与 Home 一致），或至少补 `className="page-shell"`。这也提醒：`page-shell` 是约定而非强制，后续可加 lint 规则或在 `TabWorkspace` 里按 `tab.type` 断言。

### P3｜规范文档与实现已经互相不认识

规范文档是"验收标准"，但代码在密度上做了系统性、且**有注释说明理由**的偏离。现在文档里每一条都可能被误读成"实现不合规"：

| 项 | 规范文档 | 实现 | 位置 |
|---|---|---|---|
| 顶栏高度 | 48px | 44px（`calc(14*3+2)`） | `index.css:51` |
| 页签栏高度 | 36px | 30px（`calc(14+16)`） | `index.css:53` |
| 内容区内边距 | 16px | 12px（`--spacing-lg`） | `index.css:33,327`；`PageShell.tsx:15` 注释还写着 16px |
| 页面标题 | 20px | 18px（`--font-size-xl`） | `index.css:47` |
| 最小点击区 | ≥32px | 28px（`controlHeight`） | `App.tsx:26` |
| 间距栅格 | 4px 倍数 | `--spacing-sm: 6px`、`--spacing-md: 10px` 不是 4 的倍数 | `index.css:30-35` |
| 字号梯度 | 12/14/16/18/20 | 12/13/14/15/18 + 四档可切换 | `index.css:43-47,104-126` |

前五项是合理的密度决策（桌面工具，一屏要放表格+图+树），但**文档没跟着改，等于自定标准被判违规**。建议把文档的 §1.3.1 / §2.1 / §2.3 数字直接改成实现值，并把"为什么更紧"写进去——这比让下一轮审计再报一次"违反规范"便宜得多。最后一项（6/10px）建议要么把栅格基准声明为 2px，要么把 token 调成 4/8/12/16/24。

---

## 三、信息架构：顶栏是当前最该动的地方

`TopNav` 左侧常驻 **9 个同级按钮**（监控/拓扑/函数/巡检/汇总/文档/通知/告警/折叠），右侧 4 个（压测/导出日志/主题/设置），中间搜索。

三个问题，按重要性：

1. **9 个同级按钮 = 没有优先级**。视觉权重完全一样，用户每次都要重新扫一遍才能找到自己那一个；而规范 §2.1 定义的是"Logo / 搜索 / 工具 / 状态 / 设置"五区，当前实现把"导航"和"工具"压成了一排。
2. **缺 Logo 区与状态区**（上一轮审计也报过状态区缺失，仍未补）。后台压测进度、连接异常、未恢复告警（已有 Badge）这些"正在发生的事"没有归属地。
3. **和左侧资源树职责重叠**。监控/拓扑/巡检本质上都是"对某个集群做事"，资源树右键菜单里已有同名入口——同一个动作两个入口、权重还都是常驻一级。

**建议（从便宜到贵）**：

- **A｜最小改动**：左侧只留「监控」「拓扑」+「更多 ▾」（其余 6 项进下拉分组），腾出的宽度给搜索框和状态区；顶栏需求宽度立刻从 ~1080px 降到 ~820px，1000px 窗口不再挤。
- **B｜按规范恢复五区**：Logo（点回首页）+ 搜索 + 状态区（压测进度/连接数/未恢复告警）+ 工具区（压测、导出、主题）+ 设置菜单；导航类（函数/巡检/汇总/文档/通知）下沉到资源树或"更多"。这是规范原意，也是唯一能让"新增第 10 个功能"不撑爆顶栏的结构。
- **C｜不改结构时**：9 个按钮改成**图标 + Tooltip**（`IconButton` 已支持），宽度从 536px 降到约 260px，代价是可发现性——不推荐，这也正是 `IconButton` 存在而顶栏没用它的原因。

顺带：顶栏 9 个按钮**没有显示快捷键**，而项目已有一套完整的可绑定快捷键系统（`store/shortcuts.ts`、`ShortcutConfig` 页）。把当前绑定塞进工具栏 `Tooltip`（`formatBinding` 已有），能把"有这功能但没人用"变成"顺手就用了"。

---

## 四、值得保留的资产（别在重构里弄丢）

1. **令牌 + 四档字号 + 三套主题的联动是完整的**：DOM 走 CSS 变量、antd 走 `compactWithFont` 补丁、ECharts 走 `fontFactor` 乘数——三层各自解决"读不到 CSS 变量"的问题，这个设计很扎实，别为省事退回硬编码。
2. **`StateBlock` 的固定判定顺序**（loading → error → empty）让 34 处调用不会各写各的。
3. **`IconButton` 用类型强制 `label` 必填**，从根上避免了"纯图标按钮没有可访问名"。
4. **图表配色从 CSS 变量读**（`topologyColors.ts`），切主题时 ECharts 重算 option——这是很多同类工具做错的地方。
5. **注释解释"为什么"而不是"做了什么"**（如 `index.css:28-29` 为什么密度要比常规低一档）。这让下一轮审计能做判断而不是猜。

---

## 五、行动路线（按风险收益比）

### 第一梯队：半天，纯收益，无回归风险
1. 亮色主题 `--color-text-secondary` → `#4e5969`；行号/注释改用不参与正文的浅色 token。（P1-1，改 3 行 CSS）
2. 「小」档 antd 基准 10px → 12px。（P1-3，改 1 行）
3. `TopNav.tsx:313` 的 #722ed1 换成 `var(--color-primary)` 或新增 `--color-accent`（三套主题各一值）；`SchemaPanel.tsx:75` 换 `var(--color-danger)`。（P1-1）
4. 关于弹窗的 ⚡ 换成应用图标。（P2-3）
5. `MessageBrowser` 根节点接入 `PageShell`，补回内容区留白。（P2-4）

**验收**：亮色主题下 `.hint-text` 对比度 ≥4.5:1（DevTools 取色验算）；JSON 编辑器注释与行号肉眼可读；「小」档表格文字不再是 10px。

### 第二梯队：1 天，补齐分支路径
6. `DocCenter` 三个可点击 `div`/`li` 改语义化按钮 + `aria-current`。（P2-1）
7. 全局加 `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important } }`。（P2-2）
8. `theme.ts` 增加「跟随系统」选项（`matchMedia('(prefers-color-scheme: dark)')`），默认值改成 `system`。（P2-2）

**验收**：纯键盘走完"打开文档 → 切文章 → 跳锚点 → Esc 返回搜索"；系统开启"减少动态"后切页签无过渡动画。

### 第三梯队：2–3 天，响应式与顶栏
9. 61 个 `<Col span=>` 补断点，监控/巡检类页面在 <1200px 强制单列；图表卡按容器宽度决定高度。（P1-2）
10. 顶栏先落"更多 ▾"（方案 A），再按五区（方案 B）重排。（第三节）

**验收**：窗口拖到 1000×700，顶栏无重叠、无横向滚动条；监控页每张图卡宽度 ≥560px 或单列占满。

### 第四梯队：文档债
11. 把规范文档的 48/36/16/20/32 改成 44/30/12/18/28，并写明密度理由；声明栅格基准。（P3）

---

## 附录：可复现的检查命令

```powershell
# 对比度：取 token 值手工验算，或 DevTools 取色
Select-String -Path src\renderer\index.css -Pattern "color-text-(secondary|tertiary)"

# 响应式分支是否还是 0
(Select-String -Path (Get-ChildItem src\renderer -Recurse -Include *.tsx).FullName -Pattern "<Col span=").Count
(Select-String -Path (Get-ChildItem src\renderer -Recurse -Include *.tsx).FullName -Pattern "<Col (xs|sm|md|lg|xl)=").Count

# 硬编码颜色 / 字号 / emoji
Select-String -Path (Get-ChildItem src\renderer -Recurse -Include *.tsx).FullName -Pattern "#[0-9a-fA-F]{6}"
Select-String -Path (Get-ChildItem src\renderer -Recurse -Include *.tsx).FullName -Pattern "fontSize:\s*\d+"

# 分支路径缺口（应全部 >0，当前均为 0）
foreach ($p in 'prefers-reduced-motion','matchMedia','Skeleton','aria-live') {
    (Select-String -Path (Get-ChildItem src\renderer -Recurse -Include *.ts,*.tsx).FullName -Pattern $p).Count
}
```

---

## 六、修复记录（2026-10-22）

逐条对应第二节的问题编号。所有改动都过了 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build:renderer`。

### P1-1 对比度（令牌层，改 3 处）

| 令牌 | 改前 | 改后 | 比值 |
|---|---|---|---|
| 亮色 `--color-text-secondary` | `#86909c` | `#4e5969` | 3.24 → **7.10**（白底）/ 6.40（`#f2f3f5`） |
| 亮色 `--color-text-tertiary` | `#c9cdd4` | `#64707d` | 1.59 → **5.05**（白底）/ 4.55（行号底色） |
| 暗色 `--color-text-tertiary` | `#86909c` | `#8f9aa6` | 4.17 → **4.72**（浮层底色） |
| 护眼 `--color-text-tertiary` | `#8a8a8a` | `#666666` | 4.10 → **4.62** |

配套：

- 新增 `--color-danger-text`（亮 `#cf1322` 5.57:1 / 暗 `#ff7875` 6.98:1 / 护眼 `#b03a2e` 5.44:1）。`--color-danger` 保留给边框、图标与按钮底——它压到 12px 正文上只有 3.71:1。
- 新增 `--color-accent`（亮 `#722ed1` 6.94:1 / 暗 `#9e5cf7` 3.43:1 于浮层 / 护眼 `#722ed1`），替掉 `TopNav.tsx` 里写死的紫色。
- 暗色 `--color-border` `#2e2e33` → `#3d3d45`：原来它与浮层底色同值，等于弹窗、卡片、右键菜单都没有边框。
- `.danger-text` 与 `SchemaPanel` 的错误提示改用 `--color-danger-text`；`SchemaPanel` 的 `#d4380d` 一并清掉。
- 滚动条 thumb、CodeMirror 行号与语法注释都吃 tertiary，跟着上面一起达标。

### P1-2 响应式（页面级栅格）

- `MetricsDashboard`：4 张统计卡 `span={6}` → `xs={12} xl={6}`；4 张图表卡 `span={12}` → `xs={24} xl={12}`（<1200px 单列，图卡从 362px 回到满宽）。
- `ConfigCenter`：两栏设置卡 `span={12}` → `xs={24} xl={12}`。
- `ResourceDetailPage`：统计卡 `span={8}` → `xs={24} sm={12} xl={8}`。
- **弹窗内的固定栅格保持原样**：antd 的 `xs/sm/lg` 是视口断点，而弹窗宽度是固定的（如 680px），套视口断点会在窗口变窄时把一个 680px 弹窗里的两列莫名拆成两行。这条规则已写进规范 §2.3。

### P1-3 字号下限

- antd 组件字号基准：`small 10 / medium 11 / large 12 / xlarge 14` → **`12 / 12 / 12 / 14`**，12px 是硬下限。
- 控件尺寸不再跟字号共用比例：新增 `ANTD_DENSITY_BASE_PX` + `antdDensityFactor()`，仍按 `10/11/12/14` 缩放，所以「小」档行高与内边距照旧收紧，只是文字不再被压到 10px。
- DOM 字号下限：`--font-size-xs` 的 10px → 11px，四档梯度整体上移一格（小 11/12/13/14/16、中 12/12/13/15/17、大 12/13/14/15/18、特大 13/14/15/17/20）。
- 图表 canvas 字号有 `fontFactor` 下限 0.92（≈11px），坐标轴刻度不会被缩到读不出。

### P2-1 文档中心键盘可达

`DocCenter.tsx` 的三处可点击元素全部改成真按钮：目录项 `.doc-kb-item-title`（`aria-current="page"` 标当前篇）、锚点 `.doc-kb-toc-item`、检索命中 `.doc-kb-hit`。配套 CSS 做了按钮复位（`background: none` / `border: none` / `font: inherit` / `text-align: left` / `width: 100%`），并给它们补了 `:focus-visible` 焦点环——原来的 hover 态保留。

### P2-2 三个分支路径

- **减少动态**：`@media (prefers-reduced-motion: reduce)` 把 transition / animation / scroll-behavior 压到不可感知。
- **跟随系统**：`ThemePreference = 三套主题 | 'system'`，store 里拆成 `preference`（用户选的）与 `theme`（生效值），`matchMedia('(prefers-color-scheme: dark)')` 在模块求值时同步解析首帧、并监听系统切换。顶栏主题菜单与配置中心都加了「跟随系统」。落库仍写偏好值，Rust 侧是字符串透传，无需改动。
- **骨架屏**：`StateBlock` 新增 `loadingVariant="skeleton"`（默认仍是 `spin`，图表/详情页不受影响），Home、ResourceDetailPage、AlertCenter、WorkerCenter、FleetInspection、ClusterInspection、PluginMarket 已切换。
- **live region**：`StateBlock` 的 loading/empty 分支带 `role="status" aria-live="polite"`，error 分支带 `role="alert"`——轮询把空态翻成异常时读屏能播报。

### P2-3 图标

关于弹窗的 ⚡ 换成 `ThunderboltOutlined`（同族线性图标、跟着主题色走）。全仓已无 emoji 充当结构图标。

### P2-4 消息浏览器的页面骨架

`MessageBrowser` 根节点 `<div className="stack">` → `<PageShell>`，与其余 17 个页面对齐 12px 内容区留白。

### 顶栏信息架构（第三节）

- 左侧 9 个同级按钮 → **监控 / 拓扑 / 告警 / 更多 ▾ / 折叠**。「更多」收纳函数与连接器、集群巡检、跨集群巡检汇总、文档中心、外部通知渠道。
- 告警的未恢复计数从 Badge 叠图标改为文字后面的小标签，顺带省十几像素。
- 新增**状态区**：`在线 N/总数` 的连接概况，一个色点表达三态，点击进跨集群巡检汇总。
- 主题按钮的 Tooltip 里带上当前绑定的快捷键（`toggleTheme`）。
- 宽度核算：左区约 310px + 搜索框（1000px 窗口下 22% ≈ 220px）+ 右区约 310px（1120px 以下状态格收起）+ 内边距与组间距 44px ≈ **884px**，小于最小窗口 1000px，留出约 110px 余量。1120px 以上状态格出现时，两侧各有约 415px，右区 392px 仍然放得下。

### P3 规范文档

`Pulsar 桌面管理工具 UI 详细设计规范（最终完整版）.md` 的数字改成实现值：顶栏 44px、页签栏 30px、内容区 12px、页面标题 18px、控件 28px、栅格 2px 基准（4px 主步进，6/10 为密度中间档）、字号梯度 11–18px 六档 + 四档切换。另补了三段原来缺的内容：色彩表更新（含 `--color-danger-text`、`--color-accent`、暗色分隔线）、对比度红线、页面级栅格必须带断点。

### 仍未做（需要运行态或另立需求）

- **运行态验收**：以上都是代码级验证。要在真实集群 + WebView2 里过一遍：三套主题取色、1000×700 窗口下顶栏不重叠、监控页单列切换、文档中心纯键盘走通。
- **全局快捷键提示**：只在主题按钮上做了示范。监控/拓扑这类入口没有对应 command（`COMMAND_CATALOG` 里没有“打开某页”的命令），要补先得扩命令表。
- **骨架屏覆盖率**：目前 7 个表格/列表页，图表页仍是转圈（图表本身没有形状可占位）。

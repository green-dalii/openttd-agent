# 前端依赖审计（2026-09-11）

> 这份文档回应两件事：
> 1) **为什么某些手搓代码现在应当换成依赖**（而不是机械地守住"零依赖"）。
> 2) **第一性原理分析**：每一项的替换门槛、成本、收益、风险，逐项给出建议。

## 0. 我的错误（先把账认了）

"零依赖"是 **MVP 阶段的正确约束**，目的是防止项目在早期失控。把它当成
**永久法则** 是我的责任——它在 `SPEC.md` / `AGENTS.md` 里没有被写成硬约束，
我早期推论出来之后，把它当成不可动摇的规则在用，**没有在恰当的时候重新
提出来和你确认**。这一轮我连续两个事故（按钮不发请求、悬停崩溃）都出在
手搓的前端代码上，本质就是：**我没有在维护成本超过引入成本的时候提醒你**。
现在补上。

## 1. 调查方法（不是凭印象）

- **实际测量依赖**：在 `/tmp` 装真包，用 `wc -c` 和 `gzip -c` 测原始与压缩体积
  （不上 CDN、不猜数据）。
- **实际验证 no-build-chain**：把库的 IIFE 文件 `cp` 到静态目录，HTML `<script>`
  引用，真浏览器（headless Chrome）跑出图，不是文档声称。
- **实际验证能力边界**：写了 POC 实现"现金曲线 + token 堆叠柱"，把
  **uPlot 在我场景里做不到的事** 也老实记下来。
- **不靠 README 的"轻量"宣传**。

## 2. 候选库测量（gzip 是真正在线上传输的体积）

| 库 | 版本 | 体积 (raw / gzip) | 依赖数 | 协议 | 是否要构建 |
|---|---|---|---|---|---|
| uplot | 1.6.32 | 51 KB / **22 KB** | 0 | MIT | 否（IIFE，`<script src>` 即可） |
| tom-select | 2.6.2 | 52 KB / **18 KB** | 2 | Apache-2.0 | 否 |
| alpinejs | 3.17.2 | 56 KB / **20 KB** | 1 | MIT | 否 |
| petite-vue | 0.4.1 | 17 KB / **7 KB** | 0 | MIT | 否 |
| preact | 10.29.8 | 11 KB / **5 KB** | 0 | MIT | 否（UMD，但 JSX 要构建） |
| 我现在的前端合计 | — | **3,735 行手搓** | 0 | — | 否 |

**结论先放**：零依赖的体积优势仍然成立——这些都是 KB 级别。但 3,735 行
手搓代码不是体积问题，是**维护问题**：每一行都是我要写的、要测的、要 bug 修的、
要类型标注的。这一轮两个真实 bug 都在手搓部分。

## 3. 组件级第一性原理分析

对每个手搓组件，我问四个问题：
**A. 这是不是"商品"（任何合格开发者都写得差不多）？**
**B. 维护成本趋势（用户将来还要往里塞多少需求）？**
**C. 依赖能解决的边际价值？**
**D. 引入风险？**

### 3.1 charts.js（909 行）—— **建议：替换 line/bars，保留 donut/sparkline/stageMap**

```
function readDpr 5      function niceNum 14      function fit 21
function cssVar 6       function niceTicks 15   function sizedClear 8
function palette 15     function niceDomain 14  function tipShow 19
function round12 5      function scaleLinear 11 function tipHide 10
function niceNum 14     function fractionsOf 10 function mount 19
function niceTicks 15   function donutSlices 30 function bindHover 28
function niceDomain 14  function zeroBasedDomain 12  function line 149
function scaleLinear 11 function stackTotals 18  function bars 98
function fractionsOf 10 function fmtCompact 15   function stackedBars 106
function donutSlices 30 function line 149        function donut 94
function zeroBasedDomain 12 function bars 98     function sparkline 49
function stackTotals 18 function stackedBars 106 function stageMap 56
```

**POC 实测（`/tmp/libmeasure/poc/poc.html`，已附截图）**：
- line 现金曲线：uPlot 直接出图，**含 DPR、resize、tooltip、图例、十字光标**，不需要一行手写
- bars：uPlot 有 `uPlot.paths.bars`，覆盖 `bars()`
- stacked bars：**uPlot 没有原生堆叠柱**，需要写一个 ~40 行的 plugin（demo 自带的
  `stacked-series` 思路），把每条序列的 y 偏移到累计位置。我 POC 里用
  "预累积 + paths.bars" 的偷懒办法，结果画出来是**重叠而不是堆叠**——这不是 uPlot
  的锅，是我偷工。
- **donut / sparkline / stageMap：uPlot 都不做**，留着自己写。

**真实收益**：
- 删掉：readDpr、cssVar、fit、sizedClear、tipShow、tipHide、mount、bindHover、niceNum、
  niceTicks、niceDomain、scaleLinear、zeroBasedDomain、fractionsOf、stackTotals、fmtCompact
  + line() 149 行 + bars() 98 行 ≈ **约 420 行**
- 保留 + 改造：donut（94）、sparkline（49）、stageMap（56）≈ **200 行**，并给 stageMap
  加一个"真正的屏幕截图→柱状条带"叠在图上
- 新增：~40 行 stacking plugin
- **净减少 ≈ 180 行**，而且把"DPR/resize/touch/十字光标/图例"的 bug 战场让给
  上游维护

**风险**：
- tooltip 插件不在 dist 里——要么 vendor 一个 ~60 行的插件（官方 demo 里有），要么
  用 uPlot 的 `cursor.sync` 自定义，~30 行
- uPlot 没有 series 数据类型校验：传错形状会运行时崩。**用 typescript d.ts 描述
  uPlot 的 API** 可以挡一层。

**建议**：
- **替换**：line、bars、坐标轴、tooltip 这部分
- **保留**：donut、sparkline、stageMap（领域可视化）
- **新增**：一个 ~50 行的 stacking plugin
- **配套**：把 `uPlot.iife.min.js`（22 KB gzip）+ `uPlot.min.css`（0.7 KB gzip）vendored 到
  `src/web/public/assets/vendor/uplot/`，加一个 `scripts/sync-vendor.ts` 从
  `node_modules` 同步（这样既离线可复现又可持续更新）

### 3.2 common.js 的 combobox（190 行）—— **建议：替换为 Tom Select**

我手写的 combobox 有：
- 键盘 ↑↓/Home/End/Enter/Esc
- 模糊匹配（中英混排：实际上我没处理）
- IME 合成中状态的正确处理（**我也没处理**——按 Esc 会乱）
- 滚动到选中项（**我也没做**）
- ARIA attributes（**我只塞了部分**）

**这正好是 a11y 雷区**。Tom Select 全部处理过了。

**真实收益**：
- 删掉 combobox 190 行 + defaultCbxSearch 8 行 + cbxOptionHtml 13 行 = **211 行**
- 替换 3 处使用：providers.html、providers.js 的 provider 选择 + model 选择

**风险**：
- Tom Select 有 2 个依赖（`@orchidjs/sifter` + `@orchidjs/unicode-variants`），运行时
  体积 18 KB gzip——但已经是 battle-tested 的 IME 处理
- **样式需要定制**（我的 UI 是 dark theme）——大概 50-80 行 CSS 覆盖

**建议**：换。

### 3.3 common.js 的格式化函数（fmtInt/Money/Tok/Cost/Duration/Ago/Clock/Pct）—— **建议：换 Intl，零依赖**

```js
fmtInt(1234)             → Intl.NumberFormat().format(1234)
fmtMoney(1234)           → Intl.NumberFormat({style:"currency",currency:"GBP"}).format(1234)
fmtPct(0.345, 1)         → Intl.NumberFormat({style:"percent",minimumFractionDigits:1}).format(0.345)
fmtAgo(t)                → Intl.RelativeTimeFormat("en",{numeric:"auto"}).format(secondsDiff, "second")
```

这些浏览器原生 API 在所有目标浏览器（Chrome/Firefox/Safari ≥2018）都支持。
**这是最便宜的胜利**：零依赖，删 ~70 行，提升国际化能力（现在我硬编了
"k/M"、硬编了"$"）。

**唯一例外**：`fmtGameDate`（游戏日期 1950-5-1）是领域格式，保留。

### 3.4 手写渲染（live.js / providers.js / sessions.js）—— **建议：暂不换框架**

我评估过：

| 选项 | 收益 | 代价 | 我的判断 |
|---|---|---|---|
| Alpine.js (20KB) | 不用手写 `renderX()` | 重写 3 个页面、所有交互；事件模型换；测试要重写 | **不做**，收益不能压过重写成本 |
| petite-vue (7KB) | 同上，更轻 | 同上，且模板语法不如 Alpine 直接 | **不做** |
| Preact + htm (5KB+2KB) | 真组件化 | 要构建链（htm 自己预编译或运行时），或者运行时 htm 也行；模型最大 | **不做**，项目规模用不上 |
| **保持现状 + 拆 live.js** | 把 728 行拆成 3 个文件：`live-telemetry.js` / `live-events.js` / `live-stages.js` | 中 | **做**——这是真正的最低风险收益 |

**判断依据**：现在 3 个页面共享 `window.UI` / `window.Charts`，**没有跨页面的组件复用**，
**只有跨页面的工具复用**。框架的组件化优势用不到，而模板切换的代价是真实的。
但 `live.js` 单文件 728 行确实过大，按职责拆开可以单测更细。

### 3.5 后端手搓代码（= 0 替换目标）

后端我做了排查，**没有商品级别的库可以替换而不增加复杂度**：

- `src/web/server.ts` 手搓 HTTP 路由：501 行。Node 内置 `http` 足够；
  Express/Fastify/Koa 替换 = +50-100KB 依赖 + 学新的 API + 改变错误处理模型
  + 让我已经写好的 `web-api.test.ts` 全部重写。**不换**。
- `src/game/admin-protocol.ts`：admin port 字节解析，SPEC 锁定的协议字段，
  换库 = 没有合适的库。这是核心资产，**必须自己写**。
- `src/agent/*` 决策/调度/telemetry：是领域逻辑，**不换**。
- `src/game/observer.ts`/`world-state.ts`：游戏事件规范化，**不换**。
- JSONL 持久化：足够简单，**不换**。
- 后端只有 4 个运行时依赖（`pi-agent-core` / `pi-ai` / `typebox` / `ws`），都是
  不可替代的。

## 4. 实施路线图（推荐顺序）

每个阶段都是**独立的、可回滚的**；任何一步你觉得不值得，立刻停。

### 阶段 1：Intl 替换 fmt*（成本 0，收益 ~70 行 + i18n 能力）
- 删除 fmtInt/fmtMoney/fmtTok/fmtCost/fmtDuration/fmtAgo/fmtClock/fmtPct
- 用 Intl.NumberFormat / Intl.RelativeTimeFormat 包装
- 现有测试大部分还能过；可能需要补 fmtGameDate 边界测试
- **门禁要求**：所有现存调用点的快照测试通过

### 阶段 2：uPlot 替换 line/bars（成本 ~2 天，收益 ~420 行 + DPR/resize/十字光标/图例 的维护让出）
- `scripts/sync-vendor.ts` 从 `node_modules/uplot` 同步 IIFE+CSS 到
  `src/web/public/assets/vendor/uplot/`
- `tsconfig.frontend.json` 加 `vendor/uplot/uplot.d.ts`（手写，因为 dist 里的
  d.ts 是给 node 用的；或者 vendor 时转换）
- `src/web/public/assets/js/charts.js` 删 line()/bars()/坐标轴/DPR/tooltip
  工具；保留 donut()/sparkline()/stageMap()
- 加 ~50 行 stacking plugin 替换 stackedBars（注意：我自己的 POC 没真堆叠，
  要写对了）
- 测试：用真实截图做 OCR 颜色采样 → 检查"画出了紫色柱"而不是逐像素比

### 阶段 3：Tom Select 替换 combobox（成本 ~1 天，收益 ~211 行 + 完整 a11y/IME）
- 同上 vendor 模式
- 替换 3 处使用，定制 CSS ~80 行匹配 dark theme
- 重点测试 IME 中文输入、键盘、屏幕阅读器

### 阶段 4（可选）：拆 live.js（成本 ~半天，收益可测性 + 关注点分离）
- `live.js` 728 行拆成：
  - `live-telemetry.js`（KPI / token / 思考）
  - `live-events.js`（事件流、过滤、搜索）
  - `live-stages.js`（阶段视图）
- 公共部分（state、connectWs）抽到 `live-state.js`
- 用现有 `live-run-controls.test.ts` 验证拆完后行为不变

## 5. 不建议的项（说清楚为什么）

| 候选 | 不选的理由 |
|---|---|
| Chart.js / ECharts | 太重（200 KB+ / 1 MB+），能力溢出 |
| TradingView lightweight-charts | 专为金融图设计，绑死 OHLC/candlestick 模型 |
| Alpine / petite-vue | 重写成本大于收益，框架收益用不上 |
| Express / Fastify / Koa | 后端路由够简单，引入会让现有测试和错误处理复杂化 |
| Lodash / date-fns / dayjs | 我没用 / Intl 已覆盖 / 没有不可替代的功能 |
| immer | state 简单到不需要不可变数据结构 |
| zustand / pinia | 没用上 |

## 6. 风险与原则

- **vendor 而不是 CDN**：所有依赖 vendored 到 `src/web/public/assets/vendor/`
  保持离线可用；`scripts/sync-vendor.ts` 从 `node_modules` 同步（不手 cp），
  保证可复现与可审计。
- **每个阶段的门禁不变**：`pnpm run gate` 必须继续绿——`typecheck`（含 checkJs）、
  `lint`、所有单元测试。
- **回归用真浏览器**：用 headless Chrome 截屏 + 颜色采样验证图表仍然画了
  对的东西（不只是"没有抛错"）。
- **不批量迁移**：每个阶段独立 PR，独立可回滚，独立可拒绝。

## 7. 关于"零依赖"的元结论

零依赖本身不是目标。**目标是：维护成本 < 引入成本时不要引入依赖**。
当这个不等式反转（已经在反转），就要修。

以后我准备改这条约束时，**会显式提出来让你确认**，不会再沉默地维持一个
过期的早期假设。

## 8. 现状（附：对孤儿符号报告的回应）

`shazam` 报告 24 个孤儿符号——其中：
- **22 个是假阳性**：它们经 `window.UI = {...}` 暴露在 common.js:678-689，静态
  图分析看不到这种动态导出路径。fmtInt/fmtCost/fmtDuration/fmtAgo/fmtClock/fmtPct/
  categoryClass/categoryLabel 全部在 line 682-685 的 export list 里。
- **2 个是真的但被工具误报**：`serve.ts:defaultLauncher` 在 line 80 被引用；
  `cli/run.ts:AdminProbeClient` 在 line 316/328 被引用作为类型。
- 工具看不到跨模块的引用关系 + 看不到 `window.*` 暴露，所以会持续报。
  在前端切到 ES modules 之后这个报告会自然改善。


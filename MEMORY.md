# MEMORY.md — 过程教训（跨 session 记忆）

> **职责**：记录**踩过的坑与错误模式**，让下一个 session（或 compact 后的自己）不再重复。
> **禁止**：系统事实（→ `SPEC.md`/`docs/`）、可执行规范条文（→ `AGENTS.md`）、进度计划（→ `ROADMAP.md`）。
>
> 每条格式：**现象 → 根因 → 规则**。新教训追加到对应分类末尾。
> 与 `AGENTS.md` 的关系：本文是**复盘叙述**，AGENTS 是**可执行准则**；一条教训若沉淀为硬规则，写进 AGENTS 并在本文留指针。

---

## A. 验证方法（本仓库最大的坑）

### A1. 「没有报错」只在代码真的执行过时才成立（2026-09-12）

**现象**：我向用户报告"三个页面 0 控制台错误"并交接。用户实测 Live 页满屏报错：
`Alpine Expression Error: ... reading 'children'` + `Uncaught ReferenceError: m is not defined`。

**根因**（三层，每一层单独都足以放过错误）：
1. 我的 E2E 跑在一次 **`stageViews` 仍为空**的会话上（agent 刚启动，还没到施工阶段），
   出错的 `<template x-for>` **从未渲染** → 不产生任何错误。
   **我用一个没有数据的状态"验证"了我刚写完的组件。**
2. 探针只监听 `Runtime.exceptionThrown` + `console.error`；Alpine 的表达式错误走
   **`console.warn`** → **被我的过滤器丢掉**。
3. 我把"采集到 0 条错误日志"当成了"页面没问题"这个结论的证据。

**规则**：见 `AGENTS.md` §5.2。要点：验证前先问「这段代码这次真的跑了吗」；
采集全部日志级别；断言用户能观察到的东西。

### A2. 验证代理指标 ≠ 验证结果（重复犯错，本仓库至少 3 次）

**现象/实例**：
- **uPlot 图表宿主误用 `<canvas>`**：注入的 DOM 成了 canvas 的 fallback content（浏览器
  永不渲染），且画布被拉伸到 1108px。用户看到两个空的大黑框。而我当时的"验证"测的是
  **canvas 里的像素**，并报告"230 painted pixels"——**像素在一个没人渲染的画布里**。
- 迁移后报告"0 控制台错误"，实际见 A1。
- 阶段 2 我检查 `el.querySelector('canvas')` 是否存在，即断言"我注入的东西在"，
  而不是"用户看得见"。

**根因**：选择断言时挑了**容易测的量**（像素数、异常数、进程存活），而不是**用户能看到的量**
（元素可见性、DOM 文本、wrapper 的实际屏幕盒子）。

**规则**：断言必须指向**用户可观察的结果**。UI 断言至少要有
`offsetParent !== null` 或 `getBoundingClientRect()` 的非零尺寸，
不能只断言"我插入的节点存在"或"有像素"。

### A3. 「某个变体失败」≠「整个能力不可得」（2026-09-12）

**现象**：`SPEC.md` 曾把"headless 无法截图"写成一条系统事实，据此放弃了阶段画面（写进了
边界说明与结论）。实际上：`screenshot` 变体确实失败，但 **`screenshot minimap` 可以成功**，
它从**地图数据**渲染 256×256 PNG，不依赖 framebuffer。于是"视觉像素不可得"这个结论
**只对 viewport 成立**，对 minimap 不成立。

**根因**：试一个变体失败后做了**过度推广**，并把推广结论固化成 SPEC 事实。

**规则**：下"不可得/不支持"这类否定结论前，**穷举变体**（子命令、参数、模式），
并在 SPEC 里写清**边界到底在哪**（"对 X 不成立，对 Y 成立"），不要写笼统的"不可得"。

### A4. 单测用 faux provider，永远抓不到"没接线"

**现象**：v0.3~v0.5 期间 `--agent` 的 E2E 只验证了"进程起来了、有 token 计数"。
真实情况是三个 Session 全是 `mode=watch` + `kind=faux` + `decisions=0` ——
**内置 CPU AI 在打**，而面板一切正常。单测全绿。

**根因**：faux provider 让"没接线"也能产出看似正常的遥测。

**规则**：见 `AGENTS.md` §5.1 的 8 条必证断言。涉及 agent/决策/遥测的改动必须跑 `test:live`。

---

## B. 前端 / 渲染层

### B1. 「静默缺失的 UI」是最危险的类别（2026-09-12，一次迁移踩中 3 次）

**现象**（迁 Alpine 期间，三个都是**零报错**）：
1. `companyCards()` 被模板 `x-for` 引用，但**视图模型里从未实现** → ReferenceError（这个至少报错了）
2. Providers 页的 **Built-in / Custom 模式开关被我整段删掉** → 渲染成一个空 `<div>`，
   无任何异常。**用户切换模式的唯一入口消失了。**
3. `$refs.provBox` / `$refs.modelBox` 取了 ref，但 HTML 上**没写 `x-ref`**
   → 两个搜索下拉**从未挂载**（不报错，只是没出现）。

**根因**：重写声明式模板时，"元素还在不在、指令接没接上"没有任何自动检查。
单测/类型检查/eslint 都看不见"运行时绑定缺失"。

**规则**：迁移或重写动态模板后，**逐个交互元素人工点一遍**（开关、下拉、按钮、折叠），
并断言 DOM 有内容。见 `AGENTS.md` §5.2 第 4 条。

### B2. `<template>` **不能放在 `<svg>` 内部**（2026-09-12，我两次误判才找到真因）

**现象**：Live 页满屏
`Alpine Expression Error: Cannot read properties of undefined (reading 'children')`
以及一连串 `Uncaught ReferenceError: m is not defined`（`m.x1`、`m.y` …）。

**我的第一次误判**：我以为根因是「`x-for` 内放了两个兄弟 `<template x-if>`，违反了
「模板内恰好一个根元素」。改成两个平铺 `x-for` 后 **错误依旧**。

**真因**（Chrome 实测证据）：
```js
{ expr: 'm in stageRoutes(v)', ns: 'SVG', isHTMLTemplate: false, contentDefined: false }
```
`<template>` 在 `<svg>` 内部被 HTML 解析器当作 **SVG 命名空间元素**，而不是
`HTMLTemplateElement`。它的 `.content` 是 `undefined`，于是 Alpine 的 `x-for` 读
`.content.children` 直接抛错，循环变量也永远不会绑定。

**规则**：需要在 SVG 里画动态内容时，**把 SVG 标记拼成字符串，用 `x-html` 注入**
（注入时处于 HTML 解析上下文，`<svg>` 命名空间才正确），生成逻辑做成纯函数以便单测。
已在静态守卫里锁住：`lintTemplatesInsideSvg()`。

**教训**：报错信息里的**元素上下文**（` line.ov-route`）是关键线索——它告诉我 Alpine
正在处理 SVG 里的节点。我第一次只看了表达式（`stageMarks(v)`）就下结论，
把一个**解析层**问题当成了**模板结构**问题。

### B3. 响应式读取必须在 effect 的**同步作用域**内（2026-09-12）

**现象**：Sessions 页的 donut 图**永远不绘制**——canvas 在、legend 正常、无报错，只是全白。

**根因**：`drawDonut()` 在 `$nextTick` 回调里读 `tokenSlices()`。Alpine 的依赖追踪发生在
同步求值期间，跨过异步边界后读取**不算依赖** → `x-effect` 永不重跑。

**规则**：在 `x-effect` 里，**先同步读完所有要用的响应式数据**，再进入异步/`$nextTick`。
已加回归测试：断言读取发生在异步边界之前。

### B4. 永不用 `scrollIntoView` 跟随列表（2026-09-12，用户报告）

**现象**：Agent steps 更新时**整个页面自己滚动**，用户正在看上面内容时被拽走。

**根因**：`scrollIntoView({block:"nearest"})` 会滚动**所有可滚动祖先，包括 document**。
实测：列表 520/2121px 时它把页面滚了 692px。

**规则**：用 `UI.scrollToEnd(el)`（设自己的 `scrollTop`）或 `UI.keepVisible(container, child)`
（基于 rect 计算）。已加**静态护栏**：页面脚本里出现 `.scrollIntoView(` 即测试失败。

### B5. `Intl` 是数据，不是契约（2026-09-11）

**现象**：`Intl.NumberFormat(..., {notation:"compact"})` 的后缀拼法在不同引擎不一致：
Node 给 `1.5B`，Chrome 给 **`1.5bn`**，而我们手写的图表给 `1.5B` → **同一页 KPI 与图表
对同一个数字显示不同单位**。

**根因**：compact 后缀拼写来自 **CLDR 数据**，随引擎/版本变化，不构成可依赖的契约。

**规则**：`Intl` 只负责**数字本身**；单位阶梯（k/M/B/T）是**我们自己的词表**
（`COMPACT_UNITS`），KPI 与图表必须共用同一份实现。已加两个测试锁定：
① 一个拒绝 compact 的"敌对 Intl"；② `fmtTok(v) === charts.util.fmtCompact(v)`。

### B6. Alpine `x-for` 的 `:key` 必须唯一，否则**整段列表渲染为空**（2026-09-12）

**现象**：`stageViews` 里确实有 2 条数据，但 `.stage-snaps` **一个节点都没渲染**，
且**无任何控制台报错**。

**根因**：两条记录的 `index` 都是 `0`（同一帧被投递了两次），而 `index` 是 `x-for` 的 `:key`。
**重复 key 让 Alpine 渲染出 0 个节点**，而不是 2 个或 1 个。

**规则**：`:key` 必须唯一。更重要的是，**列表写入要幂等（upsert by 稳定 id），不要盲 append**
——重复投递不应该产生分歧状态。已加测试：重复投递同一帧后长度不变、
`new Set(keys).size === list.length`。

### B7. 页面缺一个依赖脚本 = 功能静默消失（2026-09-12，第 3 次同类错误）

**现象**：新建的 Evolution 页图表**永远不出现**——div 存在、可见、1278×120、ref 正确解析、
`Charts.line` 也在，但 `innerHTML` 是空的，**零控制台输出**。

**根因**：`evolution.html` 漏了 `<script src=".../uplot/uPlot.iife.min.js">`。
`ucharts.js` 的 `mount()` 第一行就是 `if (!uplotAvailable()) return null;`
—— 静默返回。同一页面加载了 `ucharts.js`，却没加载它依赖的全局。

**为什么这是"第 3 次"**：同一类错误本仓库已经踩过三次——
① uPlot 宿主误用 `<canvas>`（注入的 DOM 进了 fallback content）；
② Providers 的 `x-ref` 缺失（下拉从未挂载）；
③ 本次缺 vendor 脚本。
共同点：**功能没了，但没有任何异常**。

**规则**：页面脚本之间的**依赖闭包**必须被静态守卫，不能靠人记得。
已加入 `test/unit/web-assets.test.ts` 的 `script dependency closure`：
加载 `ucharts.js` 的页面必须同时加载 uPlot bundle 与样式；加载 `charts.js` 必须加载
`common.js`；加载 Alpine 必须加载 bridge。

**更普遍的教训**：`if (!dependency) return null;` 这种**静默降级**在页面里是危险的——
它把"配置错误"伪装成"这里本来就没东西"。若必须降级，至少 `console.error` 一次
（`ucharts.js` 的 `hostCannotRenderChildren` 就是这么做的，所以那类错误当场就被发现了）。

---

## C. 数据与一致性

### C1. 同一概念重复实现会**静默漂移**（2026-09-12）

**现象**：`toWireSnapshot` 存在**两份**（`src/agent/runner.ts` + `src/game/runner.ts`），
且已经漂移——agent 那份漏了 `history` 字段。后果：**主模式（`--agent` / `--serve`）的
现金曲线一直是空的**，而 `--watch` 看起来完全正常。

**根因**：复制粘贴后各自演化；没有测试比对两份实现；两条模式路径的测试没有交叉。

**规则**：同一概念只允许**一处**实现（`src/game/wire-snapshot.ts`）。发现两份立刻合一，
并补一个测试锁定统一行为。**"另一条路径看起来没问题"不是借口——正是它掩盖了这条路径的 bug。**

### C2. 不要为"曾用实测支撑过的决定"静默改设计（2026-09-12）

**现象**：`ROADMAP` 待办要求"Token usage 图从柱图改折线"，但 v0.5.0 **刚刚**把它从折线
改成堆叠柱，理由是 token 是**构成**语义、且 input 比 output 大一个数量级会让多条折线挤成 3px
（写在 `docs/DASHBOARD-UI.md` §6c）。

**根因**：（潜在）把新需求当成对一个空白页面的改动，忽略既有决策。

**规则**：改动一个**有实测理由支撑**的设计前，先找到那条理由（读文档），
然后二选一：**对齐它**，或**明确推翻并更新文档**。禁止静默覆盖。

---

## D. 环境与工具

### D1. 清理开发进程必须用对的匹配模式（2026-09-12，导致门禁假红）

**现象**：`pnpm run gate` 以 3 个 `preflight.test.ts` 失败告终
（`expected false to be true`），看起来像代码回归。

**根因**：残留一个 `--serve` 进程占着端口，而 preflight 检查端口空闲。
我的清理命令 `pkill -f "cli --"` **根本匹配不到**——真实命令行是
`src/cli/run.ts --serve`，其中**没有 `cli --` 这个子串**。所以我以为清干净了，其实没有。

**规则**：清理命令与复核命令见 `ROADMAP.md`「环境陷阱」段。

```sh
pkill -f "cli/run.ts"          # 真正的 dev 进程（serve / agent / watch）
pkill -f "llm-stub"
pkill -f "OpenTTD.app/Contents/MacOS/openttd"
pkill -f "remote-debugging"    # headless Chrome
lsof -nP -iTCP:<port> -sTCP:LISTEN   # 复核
```

另：有一次运行**漏设 `OPENTTD_DATA_DIR`**，导致 OpenTTD 用了**默认**
`/tmp/openttd-agent-data` 而不是隔离目录——违反 `AGENTS.md` §2 铁律 3。跑 dev/测试前先确认该变量。

### D2. subagent 不可用不要静默降级（环境事实，重复验证 5+ 次）

**现象**：本环境缺少 `@earendil-works/pi-server`，异步/后台 subagent 委派**不可能**。

**规则**：委派失败时**显式报告偏差**，不要静默改为全内联执行后假装按计划走了。
本仓库实际全部工作都是内联完成的。

---

## E. 提交卫生

### E1. 同一次工作的收尾不要拆成多个 commit（2026-09-12，用户指出）

**现象**：一次「把待办写入 ROADMAP」的文档工作产出 **3 个 commit**：
记录待办 → 补一个环境陷阱 → 修正自己写错的 VCS 说明。
后两次都是**同一次更新的收尾**，本应 `--amend` 进第一次。

**根因**：把"每次工具调用成功就提交一次"当成了习惯，而没有先问
「这属于同一次逻辑变更吗」。

**规则**：见 `AGENTS.md` §8。判定标准：**「如果我在写第一版时就知道这些，还会单独提交吗？」**
答"不会" → `git commit --amend`（本仓库无 remote，amend 是安全默认）。

---

## F. 文档一致性

### F1. 同一事实散落在多个文档 = 必然不一致（2026-09-12，用户指出）

**现象**：`ROADMAP.md` 末尾有一份「开发纪律」5 条，与 `AGENTS.md` §2 铁律**重复表述**；
`ROADMAP.md` 顶部的进度速览还停留在旧版本，完全没有反映 v0.6.0 做的事。
另：我把"26 个 commit 未 push"写进 ROADMAP——**实际这个仓库根本没有 remote**，
错误结论被白纸黑字记下。

**根因**：写文档时"就近复制"而不是"指向权威位置"；没有人核对数字/结论。

**规则**：见 `AGENTS.md` §9 文档职责表。**改一个事实需要动几个文件？> 1 就是有重复。**
写进文档的**具体数字与结论必须当场核实**（如 `git remote -v`），不要凭印象。

---

## 附：快速自检清单（开工前 / 交接前）

- [ ] 这次改动**真的跑过了**吗？跑在**有数据的状态**下吗？（A1）
- [ ] 断言是**用户能观察到的结果**，还是代理指标？（A2）
- [ ] 涉及 UI：交互元素**逐个点过**了吗？console 的 **warn** 也看了吗？（B1、A1）
- [ ] 有没有**两份实现**同一个概念？（C1）
- [ ] 是否在改一个有**实测理由**支撑的决定？理由读了吗？（C2）
- [ ] 端口/进程清干净了吗？`OPENTTD_DATA_DIR` 设了吗？（D1）
- [ ] 这次是不是该 `--amend`？（E1）
- [ ] 文档**一次性同步全**了吗？有没有重复表述？（F1、AGENTS §9）

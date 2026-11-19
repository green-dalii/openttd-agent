> **冻结归档（2026-11-18）**：本文件是 `CHANGELOG.md` 里 **v0.1.0 – v0.6.0** 的
> 已发布版本记录，**不是当前权威**、**不再维护**（新改动写回 `CHANGELOG.md` 的
> `[Unreleased]`）。
>
> **归档理由**：主文档的行数预算（`AGENTS.md` §9.1b：650 行）是**硬门禁**，而
> `[Unreleased]` 里要写的是"使用者能感知的变化"——两件事挤在一份文件里 ⇒ 预算
> 先到、内容后到。已发布的版本记录**不再需要每轮同步** ⇒ 移到这里，主文档留指针。
>
> **权威位置**：`CHANGELOG.md`（未发布的变化）；本文件（v0.1.0–v0.6.0 的历史）。

## [0.6.0] - 2026-09-11

> **本轮的主要工作是"把实现拉回 SPEC"**，而不是加功能。审计真机 Session 日志发现，
> 之前几轮返工的根因都是**没有按 SPEC §1.1/§4.2 实现决策循环**。

### Fixed（核心：Agent 其实只决策了一次）
- **`maxTurns ?? 1` 使整局只问 LLM 一次**：模型在 1950-01-01 建一条线后再没被咨询过， 收入一路下滑也无人补救。真机证据：三个 Session 全是 `mode=watch` + `kind=faux` + `decisions=0`（内置 CPU AI 在打），而面板看起来一切正常
- **轮询顺序 bug**：阶段变化靠 admin poll 发现，而 poll 曾写在决策循环**之后** → 永远发现不到变化 → 调度器收不到 `phase_change` → 仍表现为"只决策一次"
- **删除框架层的策略引导**：旧 prompt 写"施工中就报告并结束回合"，等于替模型做决定。 现在 prompt 只给事实与因果（并有测试禁止 `you should`/`recommend` 等措辞）
- **Live 页 `renderHeader` 引用已删除的 `#g-mode`** → 页面首屏就崩（浏览器实测发现）

### Added（决策循环，对齐 SPEC §1.1/§4.2）
- `decision-context.ts`：每次决策喂**现状 + 因果**（`sinceLastDecision`：金额/车辆变化、
  阶段列表、上次动作结果、显著事件）——没有它模型无法复盘自己动作的效果
- `scheduler.ts`：**何时问**与**问什么**分离。触发 = `start`/`phase_change`/
  `wait_until`/`interval`(每月，SPEC §4.2 默认)/`event`/`manual`；同窗口多触发**合并**
- **冻结-观察-决策-执行-解冻**（SPEC §1.1 六步）：决策前 `rcon pause`，决策后 `unpause`
- **结构化计划**（SPEC §4.2 步骤 2）：`{goal, plan[], immediate_action, wait_until, rationale}` ——接口由框架规定，**内容全由模型填**；`wait_until` 让模型决定自己何时再被问
- **运行控制（`--serve`）**：常驻 dashboard + `RunSupervisor`，页面可 **开始 / 停止 / 暂停 / 恢复**；`POST /api/run/{start,stop,pause,resume}`、`GET /api/run`、 WS 帧 `run`。被监督的 run 复用同一个 WebServer（`attach()` 晚绑定）
- **阶段画面**：`stage-view.ts` 用 GS ack 的真实 tile 坐标生成几何描述， 前端 canvas 渲染**示意图**（每个施工阶段一张，存档 `<session>/stages/NNN.json`）
- Live 页新增运行控制条、**未接线时的明确提示**（而不是让人猜为什么面板是空的）

### Docs
- **`AGENTS.md` §5.1**：E2E 必须证明"智能真的接上了"（7 条断言）， 并规定**每次新 Session/compact 后先读 SPEC 对齐再动手**
- `docs/AGENT-LOOP-AND-CONTROL.md`：决策循环与运行控制契约，含**§2.0 偏离记录**
- `SPEC.md` §10.19：把本轮事实固化（含 dedicated server 无帧缓冲 → 无法截图的结论）

### Tests
- `test/live/agent-loop.test.ts`（新增，`@live`）：断言 `kind==="real"`、`mode==="agent"`、
  `decisions>=2`、`tokens>0`、audit 含带 trigger 的 decision 与 action_result、
  trigger 不全为 `start`、dashboard telemetry 非零、WS 推送 `telemetry`
  ——**这层测试此前缺失，正是"没接线"能溜过去的原因**

### Added（真实画面：小地图快照）
- `src/game/minimap.ts`：`captureMinimap()` 请求 `screenshot minimap` 并**轮询 mtime** 确认落盘后归档
- 每个施工阶段写 `<session>/stages/NNN.png`，`GET /api/sessions/:id/stages/:n.png` 提供（拒绝路径穿越）
- Live 页实时显示新捕获的图（WS 帧 `stageImage`），Sessions 页可回放全阶段

### Verified（真机，本轮）
- **真实小地图**：`screenshot minimap` → 256×256 PNG，逐阶段归档且**内容随施工变化**；浏览器实测 0 console 异常
- 决策数由 **1 → 4+**（phase_change 驱动）；`llm.kind=real`；token 正常
- `--serve` 全链路：idle → start agent → pause → resume → stop（session 落 `aborted`）→ **不重启进程再起 watch**；重复 start 返回 409
- 浏览器实测（CDP，禁用缓存）：**0 console 异常**，运行控制条可见、阶段示意图真实绘制

## [0.5.0] - 2026-09-11

### Added (启动门禁 + Session 生命周期)
**启动前环境检查（`src/agent/preflight.ts`，`docs/STARTUP-AND-LIFECYCLE.md`）**
- **先决条件不满足就拒绝启动，且发生在任何副作用之前**（不 spawn 游戏、不建 session）
- 检查项：`binary`（存在且可执行）、`dataDir`（可建可写）、`ports`（未被占用）、
  `llmConfigured`、`llmReachable`、`gsFiles`（warn）
- **LLM 可用性做真实最小请求**：配置完整 ≠ 可用（key 可能失效、endpoint 不可达、 模型名下线）。用 `buildBrain()` 走**真正会被使用的那条路径**，避免"检查的和用的不是同一个"
- `--offline-demo`：**唯一**允许无 LLM 运行的显式开关（UI 里标注为"非真实 LLM"）
- `--skip-preflight`：只跳过非安全项（ports/gsFiles），二进制与 LLM 检查不可跳过

**移除静默降级（本次核心行为修正）**
- 此前 `--agent` 在 LLM 未配置时**静默换成脚本化 faux**，照样启动游戏、部署 GS、建线，
  用户看到的是一次"无脑模拟"。现在**直接拒绝启动并说明怎么修**
- `runAgent()` 在无 LLM 且未显式 `--offline-demo` 时抛错（不假装在工作）

**Session 生命周期（`session-store.ts`）**
- `heartbeatAt` 心跳（runner 每 2s 刷新）+ 新状态 **`interrupted`**
- **有效状态在读取时计算**（`effectiveStatus`）：`running` 且心跳超时 15s ⇒ `interrupted`； 读取不写盘（幂等无副作用）
- **启动时和解**（`reconcileStaleSessions`）：新进程把上一个进程遗留的过期 `running` 写盘固化为 `interrupted`（附 `endedAt` 与原因），历史自愈
- 崩溃兜底：`uncaughtException`/`unhandledRejection` → 尽力 finalize 为 `error`；
  新增 `SIGHUP` 处理
- 前端：`interrupted` 是**独立徽章**并带 tooltip（此前会静默落成通用 warn）

### Fixed（仪表盘数据可视化）
- **Token 图表类型错误**：输入/输出/推理用三条折线，但输入约是输出的 20 倍， 实测三条线挤在 **3px** 内（输出 y≈153、推理 y≈156），200px 画布约 60% 是空白。 改为**堆叠柱状图**（`Charts.stackedBars`）——同时表达"每轮总量"与"构成比例"， 带 hover tooltip（各段数值 + 占比）
- **柱状图基线非零**：`niceDomain()` 会在最小值下方留 4% 内边距，非负序列因此把 y 轴 拉到 **-200**，柱子悬空约 30px、下方一条死区。新增 `zeroBasedDomain()`， 柱图一律从 0 起（实测柱底 193 vs 地板 194）
- Token 面板新增：阶段汇总（peak/累计）、按轮次倒序明细表（含缓存列）

### Changed（Live 页排版）
- Agent 行高度对齐（Token 435px vs Runtime 431px，此前 382 vs 431）
- Reasoning 独立成面板并显示计数；步骤流与推理流并排（两者都会增长）
- 步骤/事件流默认行为与空态文案更明确

### Verified
- `pnpm run gate` 全绿：**200 passed / 1 skipped**
- 真机（Chrome headless + CDP）：拒绝启动三条路径（无 LLM / 无二进制 / 端口占用）均 `Nothing was started`，**未 spawn 任何进程、未写 session**；LLM 不可达时拒绝启动且**密钥未出现在任何输出**
- SIGKILL 模拟崩溃 → 盘上 `running`；重启后 `reconciled 1 abandoned session`，仪表盘由 `running` 变为 **`interrupted`**
- Token 图：柱底 193 / 地板 194（基线正确）、网格 4360px、图例与汇总正常

## [0.4.0] - 2026-09-11

### Changed (Dashboard UX 重构 — 从「极客日志面板」到可用控制台)
**Provider/Model 选择改为**「**可搜索组合框**」**（原来两个并排滚动列表，"在列表里找列表"）
- 39 provider × ~1900 model 不是"列表内容"而是"单选控件"：用户通常已知道要用哪个，第一交互应是**搜索**
- 键盘完整：`↑`/`↓`/`Home`/`End`/`Enter`/`Esc`；ARIA `combobox`/`listbox`/`aria-activedescendant`
- **按「Ready now / Needs a key / Cloud-OAuth」分组**；Providers 页从 `/llm` 迁到 `/providers`（旧 URL 经 `PAGE_ALIASES` 内部重写，不再 404）

**Live 页按信息紧迫性重排，信息密度显著提升**
- 首屏 **KPI 条**：Cash / Income / Company value / Loan / Fleet / Tokens —— 大数字 + **环比 delta** + **迷你趋势线**
- Agent 区：token 构成、**失败率**、按 turn 图可切 **Tokens / Cost**、工具延迟表、
  步骤流**可过滤**（全部/LLM/工具/失败）、思考流独立面板
- 事件流：类别 chips **带计数**、**搜索**（跨 kind/类别/摘要/payload）、
  **暂停**（阅读时不被冲走）、默认**最新在前**
- 新增**图表模块** `assets/js/charts.js`：折线（网格/轴标签/**hover 十字线 + tooltip**/面积）、
  柱状（含横向 top-N）、环图、迷你线；**按 DPR 渲染**（视网膜屏不再发虚）、
  ResizeObserver 自适应、`prefers-reduced-motion` 尊重
- Sessions 页新增**两次运行对比**（Δ 列）与 token 环图

**设计系统**：`style.css` 重建为 token 化（`--c1..--c8` 图表色板、间距/圆角刻度、
三级文字），组件契约见 `docs/DASHBOARD-UI.md`
**新增交互原语**：Toast（保存成功/失败不再是一行小字）、确认对话框、分段控件、
视图偏好 `localStorage` 持久化（隐藏类别/跟随滚动/图表指标）

- `GET /api/evolution` + `POST /api/evolution/strategies/:id/enabled`
  —— 进化层只读视图与 SPEC §5.3 的人工确认闸门（本 API 唯一的写操作）。
  真机验证：读、翻转、持久化、未知 id → 404。契约见 `docs/DASHBOARD-API.md` §3.5。

- **记忆的呈现（P6 前端）**——按时间跨度切成两处，而不是二选一：
  - **Live 页新增 `Memory in effect` 面板**：显示本局**注入的内容**（不只是计数），
    零注入时明确写"nothing"（那是对照实验的控制臂，不是空白）。
  - **新增 `/evolution` 页面**：两臂对照（SPEC §5.2 #3）、跨局列表与现金曲线、
    lesson 库（含量信度/证据/来源）、策略候选池与**人工确认开关**。
  - `src/evolution/web-view.ts`：所有**规则判定在服务端**（promotion 门槛、
    arms 的 `conclusive`），浏览器只显示结论——避免同一规则两份实现后漂移。
  - `test/unit/web-assets.test.ts` 新增 `script dependency closure` 守卫。
  详见 `docs/DASHBOARD-UI.md` §5.4。

### Fixed（Providers 页保存）

- **点了 Save 毫无反应**（用户报告）。根因是**禁用的按钮看起来完全可点**： 选中 Provider 但未选模型时 `saveReady()` 为假、按钮 `disabled`，而 CSS 没有给 `:disabled` 任何样式（`opacity:1; cursor:pointer`），点击不发请求、不报错、不提示。 现在：`:disabled` 有可见样式，且 `saveHint()` 按分支说明**下一步该做什么**。
- **切到 Custom 模式会继承目录 Provider 的 id**，把 `{"source":"custom","providerId":"deepseek"}` 写进 `llm.json`（凭据归错主的混合记录）。 两个模式的选择现在分开保存。
- **静态资源没有缓存校验**（无 `Cache-Control` / `ETag`），导致"刷新"可能继续跑旧 JS —— 修好的 bug 看起来没修好。现为 `no-cache` + `ETag`（未变返回 304）。
- **全新安装默认落在 Custom 端点**（`resolveLlmSource` 对空配置返回 `custom`）， 于是首次打开 Providers 是一个禁用的、要求填写 baseUrl 的自定义表单。 空配置现返回 `catalog`——内置目录才是入口。

### Fixed（用户 e2e 发现的两个问题）

- **Token Usage 图只有一种颜色，没有按 token 种类堆叠**。根因：uPlot 的
  `paths.bars` **永远从零基线画**，所以累积数据里后画的系列整块盖住先画的
  （实测 3 系列只有最后一个有像素：`{Input:0, Output:0, Reasoning:6272}`）；
  把系列反序也没用，只是换一个颜色全遮。正解是 uPlot 的 `disp` facet 给出每段的
  上下界，且**必须同时给 `y0` 和 `y1`** —— uPlot 1.6.32 的实现是
  `if (y0 != null && y1 != null)`，只给 `y0` 会被**静默忽略**（实测无变化）。
  修后逐系列像素 `{Input:4922, Output:949, Reasoning:385}`，
  纵向颜色序列自上而下 `Reasoning → Output → Input`，即正确的堆叠。
- **`add_vehicles` 谎报成功，导致 agent 无限重试**。工具无条件返回 `ok=true` （"命令写进 socket 了"），而这条命令在车队为 0 时**永远不可能生效** （执行器靠克隆头车扩容，且只在 `stage=="done"` 时读请求标牌）。 模型因此得不到"这做不到"的反馈 —— 一个永远说谎的工具会让 agent 丧失学习能力。 现在工具会检查 `vehicles` 并**拒绝**，附上原因与下一步。 语义澄清见 `SPEC.md` §10.20。

### Fixed（2026-09-12 审计 + 用户报告）

- **KPI 不实时更新，必须手动刷新**。根因：`--watch` 会 `web.publishEvent(ev)`， 而**主模式 `--agent` 从不转发事件** → 页面收不到 `event` 帧， 公司镜像与历史永不推进，KPI 冻结在连接时的快照上。已补齐并加一致性测试。
- **Token 图改为堆叠面积图**（用户要求）。过程中否掉了两条错路，都由**像素扫描**判定： ① uPlot 的 `bands` API：`series` 必须是 `[from,to]` 元组（传数字被静默忽略）， 且改成元组后填充**仍然不出现**；② 仅累积数据不够——后面画的大面积会盖住前面的。 最终方案：**倒序绘制（大者先画）+ 不透明填充到轴**。实测（等分三等份）：纵向连续三段 `Reasoning 100px → Output 100px → Input 70px`，无缝、无混色。
- **Harness 边界收紧**（用户明确要求：不要把经验教训内化进框架）。
  `SYSTEM_PROMPT` 曾写着"Do NOT issue the same command repeatedly"、
  "Prefer one solid route"、"add vehicles when queues grow" —— 这些是**策略**，
  等于把 agent 该自己学的教训直接告诉它。现已改为只给**世界机制**与**交互协议**。
  我上一轮给 `add_vehicles` 写的"Use observe()…only then scale"同属违规，一并删除。
  新增机械守卫：SYSTEM_PROMPT、每个工具 description、每个工具拒绝信息
  都不得出现策略措辞。
- **`add_vehicles` 谎报成功**：见 `SPEC.md` §10.20。

### Added

- 机械守卫：`test/unit/agent-runtime.test.ts` 的 harness 边界检查
  （边界定义：契约前提 ✅ / 世界事实与因果 ✅ / 交互协议 ✅ / 策略 ❌）。

### Fixed
- **阶段性总结面板恒为空（dead UI）**：Live 页读 `telemetry.checkpoints`，但该字段 从不存在，且 checkpoint **只在 shutdown 写**。现在 `--agent` 每个 decision turn、 `--watch` 每约 60 事件就产生一条，新增 `checkpoint` WS 帧，且 `snapshot.checkpoints` 带全量 backlog（晚订阅/刷新也能看到）
- **阶段总结数字全是 0**：agent 模式只同步了 `events`，从未把遥测写进 session totals， 于是"1 decisions, 1 tool calls, 0 tokens"这类假数据会长期存在 → 新增 `totalsFromTelemetry()` 作为唯一映射点
- `live.js` 使用未导出的 `U.pickColor`（现金曲线会直接崩）→ 由门禁测试捕获并修复
- `paintSparks` 把所有迷你线画成同一条数据 → 改为按 tile 对齐

### Fixed（浏览器实测发现，CDP 逐条验证）
- **协议层符号错误**：`money/loan/income/companyValue` 是 **int64**（OpenTTD `Money`），却按 `uint64` 读 → 亏损公司显示 `£18446744073.71B`。新增 `ByteReader.int64()`，与 `SPEC.md` §10.6 一致；真机已验证显示 `-£6.0k`
- **现金曲线刷新即清空**：历史只存在页面内存，违反"服务端是真源" → 上移到 `WorldState`（有界 600 点），`snapshot` 携带，前端 seed
- **空状态图表跳高**：无数据分支跳过 `fit()`，画布停留在默认 300×200 → 空状态也按容器宽度设置 backing store（含回归测试）
- **迷你趋势线错位**：`paintSparks` 把同一份数据画到所有 tile → 改为按 tile 对齐
- **组合框分组失效**：选项未按组排序导致组标题重复出现 14 次 → 加 `sort` 并按「Ready now → Needs key → OAuth」排序
- 大数字尾部粘 delta chip → chip 移入独立行

## [0.3.0] - 2026-09-10

### Added (Dashboard 打磨)
**多页仪表盘（无构建链，按角色分目录）**
- `src/web/public/pages/{live,llm,sessions}.html` + `assets/css/style.css` + `assets/js/{common,live,providers,sessions}.js`
- `WebServer` 导出 `PAGES` 路由表（单一事实源）；LLM 配置**解耦为独立子页**

**多 Provider 接入（发挥 pi-ai 内置目录，不再手填）**
- `provider-catalog.ts`: 暴露 pi-ai **39 个内置 provider / ~1900 个模型**；**环境变量自动检测**求出每个 provider 真正接受的变量名（31/39，不触碰真实 process.env）
- `file-credential-store.ts`: **文件版 `CredentialStore`**（`credentials.json`, 0600），密钥重启不丢
- `provider.ts` 新增 `buildBrain()`；REST: `GET|POST /api/llm`、`GET /api/llm/catalog[/:id]`、`DELETE /api/llm/credentials/:id`

**Agent 遥测（token / 思考 / 每步）**
- `telemetry.ts`: 消费 pi-agent-core `AgentEvent` → 累计 token 用量，**按 turn 与按 tool 分组**，捕获思考流与每步 log
- CLI `--agent` 也起 dashboard（`--web-port`）；Live 页新增 KPI 卡、token 图、tool 统计、思考列表、步骤流、阶段性总结时间线

**多 Session（局）管理与复盘**
- `session-store.ts`: 每局落 `<dataDir>/sessions/<id>/{meta,events,audit,telemetry}` + `index.json`，结束时写入**成绩单 + 阶段性总结**
- Sessions 页：历史局列表 + 单局复盘

**事件呈现（从「极客 JSON」到结构化）**
- 前端 `categoryOf()` 分类 + Tag 配色 + `briefOf()` **人类可读摘要**，原始 JSON 保留但**默认折叠**
- `scripts/llm-stub.ts` 按 OpenAI 规范返回 usage chunk，使 token 计量可离线验证

### Fixed
- **密钥写入后 `hasStoredKey` 仍为 false**：dashboard 保存走 pi-ai 的异步 `modify()`， 同一 tick 内回读会 stale → 改用同步 `set/remove/has` 路径（新增 `llm-api.test.ts` 锁定）
- **重构丢掉 `providers.js` 的 else 分支**导致浏览器语法错误 → 新增 `web-assets.test.ts`（`node --check` 全部脚本、校验 href/src 与 `window.UI` 符号） 作为**无构建链前端**的永久门禁

### Docs
- 新增 `docs/DASHBOARD-API.md`：dashboard 前后端**冻结契约**；SPEC §10.16 增补真机 E2E 事实与「合并不得烘焙默认值」原则

### Verified
- 真机：`--watch` 三页 200、WS snapshot/event、session 落盘；`--agent`（仅靠 llm.json）走 REAL provider → token 用量、工具调用与阶段性总结均写入 meta.json。

## [0.2.0] - 2026-09-09

### Added (决策闭环 M2)
**v0.2.0 — 通信 + Executor「手」（真机验证）**
- **`src/game/squirrel/bridge-gs/`**: BridgeV1 GS —— Admin↔游戏内双向 JSON 通道 + 标牌邮箱 + `build_bus_route`/`add_vehicles` 命令；规划层选镇对（分段铺路后可到 260 tile）
- **`src/game/squirrel/executor-ai/`**: ExecutorV1 AI —— 读标牌 → 建站 → **分段贪心铺路**（解除 AyStar v6 长路死锁）→ depot → 买 bus + 订单 + 运行；`SetPhase` 公司名编码对外汇报
- **`src/game/squirrel-deploy.ts`**: Squirrel 包部署 + sandbox `[game_scripts]` 选 GS
- **`src/game/v02-runner.ts` + CLI `--v02`**: 全链路 demo（GS 心跳 → 施工 → 经济反馈）

**v0.2.1 — Pi Agent「脑」（接线真机验证）**
- **`src/agent/`（新模块）**:
  - `runtime.ts`：pi-agent-core Agent 装配（tools + convertToLlm + transformContext + before/afterToolCall）
  - `tools/index.ts`：首批 4 个 tool —— `observe` / `build_bus_route` / `add_vehicles` / `set_pause`（typebox schema，异步 ack 语义）
  - `provider.ts`：用 **pi-ai 官方 `createProvider` + `openAICompletionsApi`** 从配置装配 provider（任意 OpenAI 兼容端点）
  - `llm-settings.ts`：`<dataDir>/llm.json` 持久化 + env>file 优先级 + key 脱敏视图
  - `context.ts`：`transformContext` 历史剪枝 + lessons 注入 hook（v0.3）
  - `audit.ts`：决策/动作 **JSONL 审计**（append-only，密钥自动脱敏）
  - `loop.ts`：决策点编排（observation → prompt → tools）
  - `messages.ts`：`CustomAgentMessages` 声明合并（`game_observation` / `action_result`）
  - `runner.ts` + CLI `--agent`：真实游戏 + 脑驱动的完整闭环
- **Web Dashboard**: 新增「LLM provider」面板（Base URL / Model / API key / API 类型）+ `GET|POST /api/llm`（key 永不回显）
- **`scripts/llm-stub.ts`**: 本地 OpenAI 兼容 stub（离线端到端验证接线，非 faux）

### Fixed
- **Dashboard LLM 面板 providerId 回读不一致**: `applyLlmSettingsFile()` 会把默认
  `"openttd-llm"` 烘焙进合并结果，而 CLI 启动时已合并过一次 → watch 进程内
  `POST /api/llm` 保存后，同一进程 `GET /api/llm` 仍回旧 providerId（新起的
  `--agent` 进程正常）。现合并层不再烘焙默认值（兜底改为 `""`），默认值只在
  使用点 `buildProvider()` 应用（具名常量 `DEFAULT_LLM_PROVIDER_ID`），合并幂等。
- **Executor 长路死锁**：Pathfinder.Road v4 + AyStar v6 对 >~60 tile 单次 FindPath 不返回 → 改**分段贪心铺路**（每段 ~20 tile + probe 回退 + 末段直达目标）
- **road type 前置条件**：`BuildRoadStation` 与 pathfinder 邻居探测都需 `AIRoad.SetCurrentRoadType(ROADTYPE_ROAD)`，否则恒失败
- **depot 门未接路**：车永远卡在 depot 内 → 补 `ConnectStop(depotTile, front)`
- **站入口方向**：pax 精扫须保持 GS 给的 front 相对方向，避免 `ERR_LAND_SLOPED`
- **income 符号**：协议 u64 承载负利润 → `BigInt.asIntN(64, …)`
- **观测期轮询**：company name 变更仅轮询可见；报告路径 API 必须包 try/catch（否则静默停止汇报）

### Verified (真机)
- **手**：`boot→work→stA_ok→stB_ok→road_built(r103)→dpt_ok→dpt_conn→bus_live→done stN2 r103 bus`；`vehicles=3 stations=2`；站队列被消化
- **脑**：真实 HTTP provider（`--agent` + 本地 OpenAI 兼容端点）→ LLM 工具调用 → 命令通道 → 施工 → 经济回灌；审计 JSONL 落盘
- **真机 E2E**（2026-09-09）：dashboard 保存 → `<dataDir>/llm.json` → **另一进程** `--agent`（清空所有 `LLM_*` env）走 REAL provider、真发 HTTP、产生 `build_bus_route` 工具调用；`GET /api/llm` 全程不回显 key（SPEC §10.16-8/9）

### Notes
- **"盈利"验收未完成**：属带脑决策质量（选镇/投资规模），需真实 LLM + 更长观察期（见 ROADMAP v0.2.1）
- 其余 tools（`build_train_route` / `adjust_orders` / `request_reflection`）、事件镜像给 Web、决策点绑定游戏月份 → 后置

## [0.1.0] - 2026-09-08

### Added (观测闭环 M1)
- **Admin 客户端** (`src/game/admin-client.ts`): connect/join/subscribe/poll/rcon/gs + 状态回调 + 优雅关闭；默认订阅 date/company/economy/stats/console
- **世界状态** (`src/game/world-state.ts`): 内存权威状态（日期/公司注册表/economy/stats/环形事件缓冲）
- **长驻观测循环** (`src/game/runner.ts`): spawn → start_ai → AdminClient → WorldState → WebServer 广播 + 周期 poll；SIGINT 优雅关闭
- **AI 可用性探测** (`src/game/ai-registry.ts`)、**BigInt-safe 序列化** (`src/util/json.ts`)
- **Web 服务器 + 仪表盘** (`src/web/server.ts` + `public/*`): HTTP 静态 + WS 扇出；原生 HTML+Canvas，无构建链
- **CLI `--watch`**: 起服 + start_ai + 长驻采集 + 仪表盘；**测试** `test/live/observation.test.ts`（@live）；`ws` 是唯一的运行时依赖

### Fixed
- `decodeErrorText` 修正: ServerError 是单 NUL 字符串而非 cstr 对；economy payload 的 BigInt 在 JSON 序列化崩溃（probe 无公司从未触达）—— 现在全链路 BigInt-safe

### Verified (真机)
- `rcon start_ai "CPU"` → company_new → company_info(isAi) → company_economy(money=100000 loan=100000)
- `--watch` 端到端: dashboard HTTP 200; WS snapshot + 增量 economy/date 事件（seq 单调递增）; SIGINT 优雅关闭无残留

## [0.0.1] - 2026-09-07

### Changed
- **包管理器切换到 pnpm**: 移除 `node_modules`/`package-lock.json`；改用 `pnpm-lock.yaml`；脚本从 `npm run *` 改为 `pnpm *`；移除未使用的 `zod` 依赖；声明 `pnpm.onlyBuiltDependencies`（esbuild）允许构建脚本。（注：pnpm 传递 CLI 参数不需要 `--`）

### Added (MVP — 脚手架 + Admin Port 最小闭环)
- **工程脚手架**: TypeScript strict + ESM + vitest + eslint flat config；`pnpm run gate`；**开发规范** `AGENTS.md`；`ROADMAP.md`
- **Admin Port 协议层** (`src/game/admin-protocol.ts`): packet 类型枚举（对齐 `tcp_admin.h`）+ 帧编解码（u16 LE 含自身长度前缀）+ 增量流式拆帧
- **Payload 解析** (`src/game/payload-parsers.ts`, `src/game/observer.ts`): OpenTTD 日历算法（锚点 712223=1950-01-01 已真机校准）+ CompanyEconomy/Info/Stats/Chat/Console/GameScript/Date 规范化
- **蓝图通道** (`src/game/blueprint.ts`): 高层动作 → GS 蓝图 JSON（job 0..999 / path ≤200 校验）
- **进程管理** (`src/game/process-manager.ts`): 隔离 data dir；generate-then-patch 配置；spawn/stop/日志尾/端口探活
- **配置** (`src/config.ts`) 与 **CLI** (`src/cli/run.ts`): env 驱动的全量可配；`--probe`（真机最小闭环）+ `--dry-run`
- **测试**: 40 个单测（codec golden / 日历 / 蓝图 / observer / 配置 / 进程生命周期），全绿

### Changed
- `SPEC.md` v0.2: 固化两轮源码级调研（动作面/观察模型/通信链路/GS-only 候选）

### Fixed / Verified (M0 实测)
- Admin listener 需要 `secrets.cfg` 中非空 `admin_password`（OpenTTD 15 将密码移出 `openttd.cfg`）；手写 `secrets.cfg` 会被 OpenTTD 重建清空 → 必须先生成再 patch；headless 起服参数与日历锚点均已真机校准；新地图无公司属预期行为

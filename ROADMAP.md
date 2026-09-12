# ROADMAP — OpenTTD LLM Agent Framework

> 渐进式开发计划。从 v0.0.1（脚手架 + MVP）开始，每版都保持「可运行 + 测试绿 + 门禁过」。
> 原则：**先打通最小闭环，再进化；任何版本不得以破坏测试/门禁为代价堆功能。**

---

## 版本规划

### 进度速览
- ✅ v0.0.1 — 脚手架 + MVP（Admin Port 最小闭环，真机验证通过）
- ✅ **v0.1.0 — 观测闭环（M1）（2026-09-08 完成）**
- ✅ **v0.2.0 — 通信 + Executor「手」（M2 前半）（2026-09-09 完成）**
- 🔵 **v0.2.1 — Pi Agent「脑」接线（M2 后半）（接线完成，盈利验收待真实 LLM）**
- ✅ **v0.3.0 — Dashboard 打磨（观测/配置/复盘三页）（2026-09-10 完成）**
- ✅ **v0.4.0 — Dashboard UX 重构（可搜索选型 / 信息层级 / 图表）（2026-09-11 完成）**
- ✅ **v0.5.0 — 启动门禁 + Session 生命周期 + 图表语义（2026-09-11 完成）**
- ✅ **v0.6.0 — 决策循环 + 运行控制 + 阶段画面 + 前端重构（2026-09-12 完成，见下）**
- ⬜ **v0.6.x — 记忆闭环 + Dashboard 收尾（见下方「待办」）** ← **下一步从这里接续**
- ⬜ v0.3.1 — 进化闭环（M3）＝ 下方「待办」第 1 项
- ⬜ v0.4.0 — 打磨与广度（M4）

**v0.6.0 已完成**（2026-09-11 → 09-12）:
决策循环对齐 SPEC（此前只问一次 LLM）· 运行控制 API + 页面按钮 · 阶段画面（真实小地图
+ 缩放 + 图例）· 版本号单源自 `package.json` · 前端依赖审计（实测选型）·
Intl 替换手写格式化（自带单位阶梯，避免 CLDR 漂移）· uPlot 替换手写折线/柱图 ·
**三页全部迁 Alpine.js** · 记忆系统的第一片（跨局 metrics 账本）·
门禁从 306 → **468** 测试。详见 CHANGELOG.md 与 `docs/FRONTEND-DEPENDENCIES-AUDIT.md`。

---

## ⬜ 待办（v0.6.x）— 2026-09-12 记录，尚未开工

> **当前状态**（compact 后从这里接续）:
> - 三个页面**全部**已迁到 Alpine.js（`live` / `sessions` / `providers`），
>   每页结构统一为 `<page>-view.js`（纯逻辑，可单测）+ 页面组件（IO + 命令式部件）+ 声明式模板
> - 门禁: **468 passed / 9 skipped**（`pnpm run typecheck && lint && vendor:check && test`）
> - 前端依赖: uPlot（折线/柱图）、Alpine.js（渲染层）、Tom Select（**已回退，未使用**）
> - **本仓库没有配置 git remote**（44 个 commit 全在本地）—— 所有工作都只在本地，没有远程备份

### 1. 记忆闭环（v0.3.1 / M3）— 🔵 开工中

**目标（SPEC §9 M3 验收）**：**同 seed 带/不带 lessons 各 3 局可出对比曲线**。
设计见 [`docs/EVOLUTION.md`](docs/EVOLUTION.md)（数据契约 + 三道闸 + 注入路径）。

现状：只有 metrics 记账那一段。`runner.ts` 调 `pruningTransformContext({keepRecent:40})`，
**从不传 `lessonsProvider`** —— 该 hook 自 v0.2.1 起没人喂。

#### 分阶段（每阶段 TDD：先写失败测试 → 实现 → 绿 → 提交）

- [x] **P1 — lessons 模型 + 蒸馏 + 去重/限量（纯函数）**
  `src/evolution/lessons.ts`：`Lesson` 类型、`normalizeLessonText()`、
  `dedupeLessons()`（规范化文本去重、保留高置信度）、`selectLessons({limit})`、
  `formatForInjection()`
  **验收**：`evidence` 为空的 lesson 被丢弃；重复文本合并且 `supersededBy` 记录；
  limit 生效；同等输入输出确定（可单测）
- [x] **P2 — 策略库 + 入库门槛（纯函数）**
  `src/evolution/strategies.ts`：`StrategyCard`、`promoteStrategies()`
  **验收**：`价值>阈值` **且** `已验证局≥2` 两条同时满足才入库（SPEC §5.3 硬性）
- [x] **P3 — 学习库持久化**
  `store.ts` 扩展 `lessons.jsonl` / `strategies.jsonl`（append + read + 幂等，
  与 metrics 同一套容忍坏行/原子压缩约定）
  **验收**：坏行不致命；同 id 覆盖；读写往返一致
- [x] **P4 — 反思（prompt 构造 + 响应解析，纯函数）**
  `src/evolution/reflect.ts`：`buildReflectionPrompt()` 内含"禁止臆测因果"；
  `parseReflection()` 强校验 schema，`evidence` 为空整条丢弃
  **验收**：臆测性表述与无证据条目都被拒；合法输出解析完整
- [ ] **P5 — 接进运行生命周期**
  开局：读库 → `selectLessons()` → 喂 `lessonsProvider` → `setMemoryInjected(真实计数)`；
  局终：反思 → 蒸馏 → 持久化（**与 metrics 记账互不影响**，各自失败不连带）
  **验收**：`test/live` 断言注入计数 `> 0` 且出现在 `metrics.jsonl`；
  反思失败时 metrics 仍落盘
- [ ] **P6 — Dashboard 进化视图（SPEC §6.1 #4）**
  跨局指标折线对比 + lessons/策略浏览 + **手动开关注入**（SPEC §5.3 guardrail：
  默认关、人工确认后才生效）

**红线**：注入默认**关闭**，人类在 UI 确认后才全局生效（SPEC §5.3）。
一个把错误教训固化进库的系统，比没有记忆的系统更糟。

### 2. Token usage 图表：柱图 → 折线图

- 现状: `live.html` 的 `#t-chart` 由 `live.js` 的 `drawTokens()` 调 `C.stackedBars(...)`（堆叠柱）
- 要求: 改为折线图

**⚠️ 实施前必须先读 `docs/DASHBOARD-UI.md` §6c。** v0.5.0 曾把这张图**从折线改成堆叠柱**，
理由写在 §6c：token 是**构成**语义（input/output/reasoning 的占比），而且 input 常比 output
大一个数量级，多条折线会挤成 3px 看不出来。因此这条需求与当时的结论冲突，两种可能：
  (a) 保留"构成"但改用**多条折线 + 明确刻度**（需先量一下是否真的挤在一起）
  (b) 明确推翻 §6c 的结论并更新文档
**不要静默改掉一个曾用实测支撑过的设计决定。**

### ✅ 3. KPI 卡片里的 sparkline 消失 —— **已修复（2026-09-12）**

- 根因:重构后模板里留着 `<canvas class="kpi-spark">`,但 **`U.paintSparks()` 再没被调用**
- 修复:`.kpis` 上加 `x-ref="kpiBox" x-effect="drawSparks()"`;`drawSparks()` **同步**读
  `sparkSpecs()`(在异步边界之前,否则 Alpine 追踪不到依赖 → 图永远不画)
- 顺手修掉一个**真 bug**:旧 `hasHistory(metric)` **忽略参数**,查的是"当前选中的现金指标",
  于是 Cash 有历史时 "Income / yr" 也会显示趋势线
- 新增纯函数:`primaryHistory()` / `sparkSeries(metric)` / `hasSpark(metric)` / `sparkSpecs()`
- **实测**:319 个历史点 → money/income 两张 sparkline 可见(219×26),
  实际绘制像素 4340 / 1568

### ✅ 4. Live 页控制台报错 —— **已修复（2026-09-12，真因与我最初判断不同）**

**现象**:满屏 `Alpine Expression Error: ... reading 'children'` +
`Uncaught ReferenceError: m is not defined`。

**真因**（Chrome 实测）:`<template>` 放在 `<svg>` 内部会被解析成 **SVG 命名空间元素**,
不是 `HTMLTemplateElement` —— `.content` 为 `undefined`,Alpine 的 `x-for` 读
`.content.children` 直接抛错,循环变量永不绑定。
```js
{ expr: 'm in stageRoutes(v)', ns: 'SVG', isHTMLTemplate: false, contentDefined: false }
```
> ⚠️ **我最初的诊断（"x-for 内有两个兄弟根"）是错的**。按它改完错误依旧。
> 复盘见 `MEMORY.md` B2。

**修复**:overlay 标记改为**字符串生成**(`overlaySvg()`,`x-html` 注入),生成逻辑是纯函数可单测。

**新增静态守卫**(防止同类再犯):
- `lintTemplatesInsideSvg()` —— `.scratch` 之外,任何页面 HTML 里 `<svg>` 内含 `<template>` 即失败
- `lintAlpineTemplates()` —— 顺手锁住 `x-for`/`x-if` 的"恰好一个根元素"
- `lintXForKeys()` —— `x-for` 必须有 `:key`

**验证**(按 `AGENTS.md` §5.2,在**有数据的状态**下):6 个 stage view 全部渲染,
overlay 里 5 条路线 + 15 个标记,`non-log console msgs: 0`。

**关联发现**:同一帧被投递两次会产生重复 `:key`,导致**整段列表渲染 0 个节点**(见 `MEMORY.md` B6),
已改为幂等 upsert(`LiveView.upsertStageView`)。

### 5. 环境陷阱（残留进程 / data dir）→ 见 `MEMORY.md` D1

`preflight.test.ts` 有 3 个用例依赖**端口空闲**；残留一个 `--serve` 进程会让门禁以
"expected false to be true" 假红，看起来像代码回归。清理命令、复核方式与
`OPENTTD_DATA_DIR` 注意事项**集中在 `MEMORY.md` D1**，此处不重复。

---

### v0.5.0 — 启动门禁 + Session 生命周期（✅ 完成, 2026-09-11）
**目标**: 先决条件不满足就拒绝启动；进程异常结束时不再谎报 running；修正图表语义。

1. `src/agent/preflight.ts`：binary / dataDir / ports / llmConfigured / **llmReachable** / gsFiles，
   **在任何副作用之前**执行（不 spawn、不建 session）✅
2. **移除静默 faux 降级**：`--offline-demo` 是唯一显式豁免，UI 标注为非真实 LLM ✅
3. 心跳 + `interrupted` 派生状态 + 启动和解（历史自愈）✅
4. 崩溃兜底：`uncaughtException` / `unhandledRejection` / `SIGHUP` ✅
5. Token 图改**堆叠柱**（构成语义）+ 柱图**零基** + 空态定尺寸 ✅
6. Live 页排版对齐；Reasoning 独立面板 ✅

**验收**
- [x] `pnpm run gate` 全绿（202 passed / 1 skipped）
- [x] 三条拒绝路径（无 LLM / 无二进制 / 端口占用）均 `Nothing was started`，未 spawn、未写 session
- [x] SIGKILL 后重启和解 → 仪表盘由 running 变 interrupted；running/aborted/interrupted 同屏正确
- [x] 密钥零泄漏（输出中 `sk-` 计数 0）

### v0.0.1 — 脚手架 + MVP（✅ 已完成，2026-09-07）
**目标**: 可运行的 TypeScript 工程骨架 + 首个**可验证的最小闭环**，证明「外部进程↔OpenTTD Admin Port」双向通道真实可用。

**已完成交付**
1. 工程脚手架: pnpm + TS strict ESM + vitest + eslint；`pnpm run gate` 门禁
2. `admin-protocol.ts`（帧编解码/枚举/reader/writer）+ `observer.ts`（事件规范化）+ `config.ts` + `process-manager.ts`（generate-then-patch 配置）+ `blueprint.ts`
3. CLI `--probe`: spawn → join → subscribe → poll → rcon → 打印规范化事件
4. 40 单测 + 真机 probe 通过（date raw 712223 = 1950-01-01 锚点验证）
5. pnpm 迁移完成（05a7541）

**里程碑映射**: M0（环境钉死）—— admin auth/进程/协议打通。

---

### v0.1.0 — 观测闭环（M1）（✅ 已完成，2026-09-08）
**目标**: Runner 长驻，实时接收 admin+GS 状态 → 规范事件 → Web 仪表盘可看现金/年份/公司。

**前置 spike 实证（2026-09-07, 真机验证）**
- `start_ai` 经 RCON 可创建公司: company_new → company_info（isAi:true, inauguratedYear）→ company_economy（poll 即时返回，无需等季度翻转）
- 本地无用户 AI 包，但 OpenTTD.app 内置 4 个 AI: AAAHogEx / CityLifeAI / CivilAI / CPU（`ai` 目录）；sandbox `-c` 目录自带空 `ai/` 子目录
- economy payload 含 **BigInt**（money/loan/income，开局 £100k 贷款）→ JSON 序列化需 BigInt-safe

**交付物**
1. `util/json.ts`: BigInt-safe `stringify`/`parse`（事件/日志/审计通用）✅
2. `game/admin-client.ts`: 完整 AdminClient 类（connect/join/auth/subscribe/poll/rcon/GS 通道/断线重连/事件回调）——从 run.ts probe 内联逻辑抽离 ✅
3. `game/observer.ts` 扩展 + `world-state.ts`: 内存态累计（公司表/日期/最近经济快照）+ 轮询节奏 ✅
4. `web/server.ts` + `web/public/*`: HTTP(静态) + WS 扇出；原生 HTML+Canvas 仪表盘 v1（现金/贷款/年份曲线 + 公司列表 + 事件流）✅
5. CLI: `--watch` 模式（spawn + start_ai + 长驻采集 + WS 广播）+ 真机 live integration 测试 ✅
6. 单元测试（json/codec 往返/observer/state/web-server）+ `@live` integration 标记 ✅
7. GS `PushState` 模板 v1（bridge-gs Squirrel 骨架）—— 移到 v0.2.0（与 Bridge GS 一同落地更合理）

**验收**
- [x] 浏览器 live 看到公司现金/年份曲线 + 事件流（真机 `--watch` 实测: WS snapshot + 增量 economy/date 事件）
- [x] `@live` integration 绿（真机: start_ai CPU → company_economy 到达，5s 内）
- [x] `pnpm run gate` 全绿（59 单测 + 1 live skip）

**里程碑映射**: M1 观测闭环（AdminClient 订阅 company/date/economy + 基础仪表盘）。

---

### v0.2.0 — 决策闭环骨架：通信 + Executor"手"（M2 前半）（✅ 完成, 2026-09-09）
**目标**: 把"手"做完整 —— 外部/GS 规划 → 标牌邮箱 → Executor 全量施工 → 可观测经济反馈。
**范围修正（2026-09-09, 用户第一性原理对齐）**: "盈利"属于带脑（LLM）的完整 M2 验收；
无脑阶段（v0.2.0）只验收**决策闭环机械可运行 + 经济反馈可观测**。盈利验收移到 v0.2.1/S6。
（SPEC §10.8 M2 原始定义含 Pi Agent + LLM 决定；拆 ROADMAP 时曾把盈利误留在无脑 S5，已修正。）

**已验证（2026-09-08/09, 真机; 细节在 SPEC §10.9-§10.13 + 本轮新增待补）**
- ✅ shutdown abort 修复（信号 handler 只翻 flag）§10.9
- ✅ 自定义 AI/GS 装入 sandbox + start_ai/list_game/attach GS 规则 §10.10
- ✅ Admin↔GS 双向 JSON 通道 + AdminClient 默认订阅含 Gamescript §10.11
- ✅ 标牌邮箱可见性: GS 须 `GSCompanyMode(company)` 放标牌 §10.12
- ✅ OpenTTD Squirrel 字符串语义（双引号+find/slice+tointeger）§10.13
- ✅ **Executor 全量施工真机跑通**: boot→work→stA_ok→stB_ok→road_built(r30-46)→dpt_ok→dpt_conn→bus_live→done stN2 r* bus
- ✅ 世界级验收: `vehicles=3 stations=2`；车 R42-56 往返、@到站停靠、站排队被消化
- ✅ 经济反馈回灌: money/income 持续经 CompanyEconomy 观测（含 signed income 解析修复）
- ⚠️ **AI 公司无 HQ**: 施工坐标必须来自标牌/外部，不能靠 HQ 选址
- ✅ **分段贪心铺路已实现并真机验证**（SPEC §10.15）: AyStar v6 长路死锁解除——
  PhaseRoad 每 tick 只搜 ~20 tile 短段、probe 回退、末段直达 fB；GS 选镇放宽到
  [25..260]。真机: 109-tile 路线 103 段铺成 + bus 跑起（commit 见 §10.15 前）

**S1-S5 实施（全部 ✅ 真机通过, commits 744f626→2194305）**
- S1 GS 选址 + S/E 站标牌（company_signs=2）✅
- S2 Executor 建 2 个真实 bus station（done stN2；road-type 前置条件 root cause 已修）✅
- S3 Pathfinder.Road 铺两站间路 + 连通性验证（短镇对；AyStar 长路死锁 root cause 已记录）✅
- S4 depot + 3 bus + orders A→B→A + 运行（vehicles=3；depot 门连接 root cause 已修）✅
- S5 经济反馈闭环可观测（cash/income 持续回流；排队被 3 车消化）✅（非盈利验证, 见范围修正）

**验收（v0.2.0 总）**
- [x] S1-S5: 一局 1950 地图脚本化跑通一条**真实 bus route**（2站+路+depot+3车在跑, stats 可查）
- [x] 经济反馈可观测: CompanyEconomy money/income 持续回灌（runner S5 快照 + signed 解析）
- [x] `pnpm run gate` 全绿
- [x] 分段铺路解除长路线限制（v0.2.1 前置技术债, SPEC §10.15）
- [ ] （移到 S6）"开始盈利" — 需脑决策选择路线/投资规模

**里程碑映射**: M2 前半（通信 + 手施工）；脑接线与盈利归 v0.2.1。

### v0.2.1 — Pi Agent（LLM）接线（M2 后半）（✅ 接线完成, 2026-09-09）
- ✅ Pi Agent Core 装配 tool: `observe`/`build_bus_route`/`add_vehicles`/`set_pause` + `CustomAgentMessages`（`game_observation`/`action_result`）
- ✅ 前置技术债: 分段铺路（SPEC §10.15）—— LLM 可选远/长路线
- ✅ LLM 决策 → 复用已验证命令通道 → 结果回灌（真机: 真实 HTTP provider 驱动一条线）
- ✅ `transformContext` v1（历史剪枝 + lessons 注入 hook）；✅ 决策/动作 **JSONL 审计**
- ✅ **Provider 配置**: env / CLI flags / **Web dashboard 面板**（Base URL / Model / key / API），持久化 `<dataDir>/llm.json`，key 脱敏
- ⬜ **验收（未完成）**: 真实 LLM 驱动一条**盈利**公交线 —— 需用户提供 provider key + 更长观察期；架构与通道已就绪
- ⬜ 后置: 其余 tools（train/orders/reflection）、事件镜像给 Web、决策点绑定游戏月份、session 分支

### v0.3.0 — Dashboard 打磨（✅ 完成, 2026-09-10）
**目标**: 把 dashboard 从「极客 log 面板」做成能用的 Agent 控制台；
发挥 pi-ai 内置多 Provider 能力；引入多 Session 与遥测。

**已完成交付**
1. 三页式独立子页（Live `/` / Providers `/llm` / Sessions `/sessions`），
   按角色分目录 `pages/` + `assets/{css,js}/`，`PAGES` 路由表为单一事实源 ✅
2. **多 Provider**：pi-ai 内置 39 provider / ~1900 模型目录 + 环境变量自动检测
   （合成 env 探测出真实变量名，31/39）+ 文件版凭证存储（重启不丢）✅
3. **Agent 遥测**：token（总量/按 turn/按 tool）、思考流、每步 log、工具耗时/失败 ✅
4. **多 Session**：每局落盘（meta/events/audit/telemetry + index），含成绩单与阶段性总结 ✅
5. **事件结构化**：类别 Tag + 人类可读摘要 + 过滤；原始 JSON 默认折叠保留 ✅
6. 冻结契约 `docs/DASHBOARD-API.md` + 无构建链前端的门禁测试（`web-assets.test.ts`）✅

**验收**
- [x] `pnpm run gate` 全绿（151 passed / 1 skipped）
- [x] 真机 `--watch` 三页 200 + WS snapshot/event + session 落盘
- [x] 真机 `--agent`（仅 llm.json）REAL provider → token 计量 1790、步骤/审计/成绩单落盘
- [x] 无构建链前端不再有「看不见的语法错误」风险（`node --check` 门禁）

### v0.3.1 — 进化闭环（M3）
**目标**: 多局对比实验 + lessons 蒸馏注入 + 指标可视化。

- 局终结算/反思/lessons 蒸馏/注入下局
- metrics JSONL + 对比图
- 策略库 v1
- 验收: 同 seed 带/不带 lessons × 3 局出对比曲线

### v0.4.0 — 打磨与广度（M4）
- 铁路/货运 tool 扩展
- replay（事件时间线）
- 自愈（崩溃重启/续档）
- 文档完善 + SPEC 更新
- 对照模型基线（多 provider）

---

## 开发纪律

见 `AGENTS.md`（**唯一权威**）。重点：§2 铁律 · §5 测试与门禁（§5.1 E2E 必证、§5.2 前端验证）·
§7 完成定义 · §8 提交卫生 · §9 文档职责与正交性。

> 本节**刻意只放指针**：此前这里复制过一份与 `AGENTS.md` §2 重复的「开发纪律」5 条，
> 属文档重复，已按 `AGENTS.md` §9 改正。

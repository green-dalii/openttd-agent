# Dashboard 全面 CoDesign（待审核）

> **这份文档回答一个问题**：后端已经变成"可配置的评测 harness"，Dashboard 还是不是它的界面？
> 结论：**不是**。后端新增的 8 个旋钮、bench 流程、manifest、10 类结果成因，页面上
> 要么没有入口，要么只显示了一部分；而页面自己又在 4 个地方复制了"运行配置"的真值。
> 本文从**第一性原理**出发重新定义四个问题，给出目标信息架构与分步实施顺序。
> 状态：**方案，待所有者审核**。运行配置那一条的详细诊断在
> `docs/SELECTION-STATE-CODESIGN.md`（已批准，S1 待执行）。边界声明见 `AGENTS.md` §9。

---

## 1. 第一性原理：这个 Dashboard 只有四件事要做

一个 harness 看板不是"把后端字段画出来"，它必须能独立回答四个问题（**判据**：不打开终端、
不读日志、不超过一屏）：

| # | 问题 | 谁来答 | 今天能不能答 |
|---|---|---|---|
| **Q1 配置与发起** | 我要跑的下一局**到底是什么**（模型/世界/旋钮/花费上限），现在能不能跑？ | Configure | ❌ 只能点 "Start agent"，8 个旋钮只有 CLI |
| **Q2 观察与解释** | 它**真的在玩吗**？这一刻它决定做什么、**为什么**、结果如何？ | Run | 🟡 有数据，但因果链被拆成 6 个区块 |
| **Q3 比较与判定** | 同一世界下 A 模型比 B 强吗？差多少？**凭什么说可比**？ | Compare | ❌ 无 bench 界面（只有原始 metrics 行） |
| **Q4 复现与审计** | 这局为什么是这个结果？当时的浏览器/模型/脚手架是什么？ | History | 🟡 有 session 详情，manifest 只显示 3 个字段 |

今天四个问题分别落在 Live / Providers / Sessions / Evolution 四页上，但**没有一页对上一个问题**：
Live 是仪表盘堆叠、Evolution 是记忆管理、Sessions 兼具"列表+回放+对比"，Providers 只做凭据。

**由此得到第一条原则**：
> **页面按"问题"划分，而不是按"数据源"划分。** 一个数据源出现在几页是正常的；
> 一页里出现两个问题的答案是设计错误。

第二条：
> **判断只在服务端做一次。** 页面可以排序、折叠、格式化，但"这局算不算数""这个模型能不能用"
> 必须来自同一个函数——否则页面与报告会给出不同的答案（已经发生过，见 §3 F1）。

---

## 2. 能力对照：后端事实 vs 页面呈现（证据）

| 后端能力（坐标） | 页面现状 | 判定 |
|---|---|---|
| 旋钮 `thinkingLevel` / `toolBudget`（`scaffold-knobs.ts`） | 无入口；`POST /api/run/start` 只接受 `mode`（`server.ts:496-508`） | ❌ 不可达 |
| 花费闸 `tokenLimit` / `costLimit`（`run-budget.ts`） | 无入口、无展示 | ❌ 不可达 |
| 世界参数（seed / 游戏日 / 场景 / 记忆臂）CLI-only | 无入口 | ❌ 不可达 |
| 双后端 `AGENT_HARNESS`（`harness-runtime.ts`） | 只在 manifest 里事后可见 | 🟡 不可选 |
| manifest 10 字段（`manifest.ts`） | Sessions 对比显示 backend/scaffold/payload；`servedModel`/`gameVersion`/`payloadShapeHash`/`tokenLimit`/`costLimit` 不显示 | 🟡 部分 |
| 结果分类 10 类（`outcome.ts`） | 页面只区分 4 类（paused / frozen / horizon / cap）；`refused`、`no_construction`、`delivered_nothing` 无名 | 🟡 词表截断 |
| bench：矩阵规划 / 四轴分数卡 / 配对统计 / 报告（`bench-plan.ts`、`scorecard.ts`、`bench-stats.ts`、`scripts/bench.ts`） | **零呈现**：没有 `/api/bench`，没有页面 | ❌ 不存在 |
| `metricExclusion` 排除原因（`metrics.ts`） | Sessions 训练图用它标点（✅ 单一写者） | ✅ |
| `learningCurve` / `powerVerdict`（`metrics.ts`） | 只有 `scorecard.ts` 在 CLI 侧调用 | ❌ 不可见 |
| 决策→动作→相位→效果（`route-ledger.ts`、`gs-events.ts`、`decision-context.ts`） | 分散在 6 个区块：Current intent / Last action / Agent activity / Agent steps / Phase / Action surface | 🟡 无因果视图 |
| retries / faults / recentRuntimeIssues（`telemetry.ts`） | 一个 "Wire" KPI（计数）；问题列表不显示 | 🟡 |
| 成本诚实 `costKnown`（`provider.ts`/`scorecard.ts`） | 已显示 `unknown`（✅） | ✅ |
| 实时模型目录 refresh（`live-catalog.ts`） | 已接线（✅） | ✅ |

---

## 3. 发现（按"会不会骗人 / 会不会挡路"排序）

**F1 · 运行配置有 4 份真值，页面会显示与运行不同的模型。**
已复现：保存 `MiniMax-M3.1-Flash` 后 `GET /api/llm` 仍答旧值（进程启动快照），
门禁与运行又各自解析一次。详见 `SELECTION-STATE-CODESIGN.md`（已批准）。

**F2 · 发起面缺失 → 基准模式无法从这个 Dashboard 使用。**
`POST /api/run/start` 只接受 `{mode}`。D4/P4 的旋钮、seed、游戏日、记忆臂、后端选择全部
CLI-only；`scripts/bench.ts` 也只能命令行跑。**"基准评测台"目前没有台子。**

**F3 · 比较面不存在。**
`buildScorecard` / `pairedComparison` 已经能出四轴与 CI，但没有任何 HTTP 端点或页面。
用户能看到的只有 Sessions 的单对 Compare 与一条训练曲线。

**F4 · manifest 的不完整呈现让"可比性"无法自查。**
`payloadShapeHash`（跨 seed 同一问句）、`servedModel`（实际服务的模型）、
`gameVersion`（同 seed 不同 build 的世界不同）、`tokenLimit`/`costLimit`（是否被闸住）
都不显示。**"两局可比"是基准的立身之本，却要用户去读 JSON。**

**F5 · 结果词表被截断。**
后端有 10 类成因，页面只报 4 类。最可行动的一类（`refused`：所有工具调用被拒）完全不可见——
它恰恰是"模型在乱试"的信号。

**F6 · 因果链被拆散（Q2 的核心失败）。**
一次决策的完整证据是：`decision(trigger)` → `tool calls` → `GS job/phase` → `effect`（钱/交付/进度）
→ 下一个 `decision` 的增量。后端已经用 `job` 把它们连起来了（D3a/S4），页面却把它们放在
6 个互不相邻的区块里，用户必须自己在时间线上拼。

**F7 · 信息架构是"仪器优先"而非"问题优先"。**
Live 页 20 个区块 / 14 个 KPI / 9 张图。新增能力（cost/wire/manifest）都**追加**在末尾，
于是"这局在干嘛"被埋在中间。这是典型的"只加不减"，与 `AGENTS.md` §9.1b 同一个机制。

**F8 · 错误是非结构化字符串。**
服务端 `{error: string}`；页面用正则猜"401 该做什么"（`providers-view.js refreshHint()`）。
同一个 401 在 Providers、启动失败、门禁结果里会出现三种不同文案。

**F9 · "Evolution" 页名与内容不符。**
它管理 lessons/strategies/route-facts（**记忆**），而"是否变强"在 Sessions 的训练图里。
用户按名字找"进化"，找到的是记忆编辑器。

**F10 · 跨 run 的分组能力没有用在界面上。**
度量行里已有 `manifest.servedModel` / `seed` / `backend` / `scaffoldHash`，
但 Sessions 只按时间列；没有任何"按模型/按 seed/按后端"的视图——而这正是 Q3 的入口。

---

## 4. 目标信息架构（四页对四问）

```
Run          ← Q2 观察与解释
Compare      ← Q3 比较与判定（新增；吸收 Sessions 的训练图 + bench 分数卡）
History      ← Q4 复现与审计（原 Sessions 的列表/回放/细节）
Configure    ← Q1 配置与发起（原 Providers + 运行旋钮 + next-run 预览）
```

### 4.1 Run（原 Live，重排为三段）

| 段 | 内容 | 判据（验收） |
|---|---|---|
| **① 在玩吗** | 健康条（run state / 世界时钟 / 相位 / 是否被闸住）+ **分数**（deliveredRun、每游戏日、窗口是否已开）+ 一句"当前目标" | 3 秒内回答"这局是活的吗、跑到哪了" |
| **② 刚做了什么** | **因果时间线**：一次决策一行，可展开为 `decision → tools → job/phase → effect`，并给出**本窗口增量**（钱/交付/车/进度） | 任一决策的四个事实**同屏**，用 `job` 连接（D3a 的成果第一次被看到） |
| **③ 诊断** | 折叠区：现金曲线、车队/站、货种、城镇、token/轮次、**Wire 明细（retries/faults 列表）**、注入的记忆、动作面 | 默认收起；展开后与今天等价 |

**原则**：新增能力优先放进 ②③，不再往首屏堆 KPI。

### 4.2 Compare（新增）

| 区 | 内容 |
|---|---|
| 计划 | 选模型（多选）× seed（多选）× 重复次数 × 旋钮；显示"预计 N 局 / 预计花费（有价目表时）" |
| 结果 | 每个模型一行 × 四轴（成绩 / 效率 / 可靠性 / 可比性），缺失显式写 `not measured` |
| 排除 | 按**原因计数**（`metricExclusion` 的既有枚举，含 `token cap reached` / `cost cap reached`） |
| 判定 | 配对比较的点估计 + CI；样本不足时写 **"不可判定"**（沿用 `powerVerdict` 的口径） |
| 明细 | 可下钻到 History 的单局 |

**判据**：两个模型在同一 seed 上的差异，必须能在**一个屏幕**里被质疑（看到 n、看到排除、看到 CI）。

### 4.3 History（原 Sessions）

保留：列表（带 verdict 芯片）、单局 KPI、回放、savegame、对比抽屉。
新增：**manifest 全字段**（`servedModel` 与请求模型不同就标出、`gameVersion`、`tokenLimit`、
`payloadShapeHash` 8 位短哈希 + 复制）、**结果成因全词表**、按模型/seed/后端分组。

### 4.4 Configure（原 Providers + 新增运行旋钮）

| 区 | 内容 |
|---|---|
| 模型与凭据 | 就是 `SELECTION-STATE-CODESIGN.md` 的 S1–S4（draft/saved、保存即校验、统一列表） |
| **运行旋钮** | 游戏日 / seed（或随机）/ 场景 / 记忆臂（treatment/control）/ 思考档位 / 工具预算 / token 上限 / 费用上限 / 后端（agent/harness） |
| **next run 预览** | 全部来自服务端解析：`provider/model/api/ctx/price known/thinking/tool budget/caps/backend/scaffoldHash` |

**判据**：从打开页面到"点一次 Start 跑出我想要的配置"，**不需要终端**；`manifest` 逐字段等于预览。

---

## 5. 实施顺序（每步独立可合并、可验收）

| 步 | 内容 | 验收（全部满足才算完成） |
|---|---|---|
| **B1** | 运行配置真值（= SELECTION S1）：视图读盘、保存即校验、返回真值 | 保存后**不重启** GET 是新值；未知模型 400 |
| **B2** | 发起面：`POST /api/run/start` 接受并校验运行旋钮；Configure 表单 + next-run 预览 | 从页面用 seed/天数/思考档/上限起一局，manifest 与预览**逐字段相同** |
| **B3** | Run 页三段化 + 因果时间线（决策→工具→job/相位→效果） | 一次决策的四段证据同屏且由 `job` 连接；默认折叠诊断区 |
| **B4** | Compare 页（分数卡复用 `buildScorecard` + `pairedComparison`） | 2 模型 × 2 seed 能出四轴与"不可判定/CI"；排除原因按类计数 |
| **B5** | 结果词表全量 + 结构化错误（`problems[{code,message,hint}]`） | 10 类成因都能在 UI 出现；401/404/无凭据各自有 code 与可执行提示 |
| **B6** | History 补 manifest 全字段 + 分组；Evolution 更名/分区（"Memory"） | 任一局能自查"同世界/同脚手架/是否被闸住" |

依赖：B1 → B2 → (B3 与 B4 可并行) → B5 → B6。

---

## 6. 明确不做

- 不引入前端构建链或状态库（`AGENTS.md` §4：无构建、运行时依赖最小化）。
- **不在前端重算判断**（可比性、分数、是否算数）：那是 `metrics.ts` / `scorecard.ts` 的职责。
- 不做"实时把整张 metrics 表推到浏览器"：Compare 只取聚合后的分数卡与必要的明细行。
- 不为了好看删掉证据（诊断区是折叠，不是删除）。
- 不在运行中改配置时说"已生效"：一律 "applies to the next run"，并有预览为证。

---

## 7. 需要所有者决定

1. **导航是否按四问重排**（Run / Compare / History / Configure）？替代方案：保留四页名，
   只新增 Compare——代价是 Live 仍然是"仪器堆"、Evolution 仍然名不副实。
2. **基准运行是否允许从 Dashboard 发起**（可能跑数小时、花真钱）？我建议：允许，
   但必须有"预计局数 / 预计花费（`costKnown` 时）/ 逐格确认"三个前置；否则保持 CLI-only，
   Dashboard 只读结果。
3. **因果时间线的保留粒度**：一局可能 90+ 决策。建议默认显示最近 20 条 + 按需加载更早的
   （数据已在 `audit.jsonl` / session，不需要新存储）。

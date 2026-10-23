# Scaffold 契约（v1）——模型看到什么、能做什么、动作后得到什么

> **文档边界**（AGENTS.md §9 为唯一权威）：本文件是**脚手架对外契约**——一局里模型
> 观测到什么、可以做什么、动作之后得到什么反馈，以及**两种模式（单机游玩 / 模型基准
> 评测）如何共用同一套脚手架**。
> **不收录**：协议字节布局与游戏机制（→ `SPEC.md`）、进度与计划（→ `ROADMAP.md`）、
> 过程教训（→ `MEMORY.md`）、已实现细节（→ `CHANGELOG.md`）。
>
> 状态：v1，2026-10-08 收敛。§4 的缺口清单是"把脚手架打磨到足够优秀"的工作项，
> 对应的 GitHub Issues 是执行清单（见 `ROADMAP.md`「阶段 D」）。
> 2026-10-08 合并：原 `docs/SIGNAL-ARCHITECTURE.md`（信号源盘点 / RL 五要素 / L0–L3
> 呈现分层 / 红线）并入本文件 §5 与 §7，避免同一主题两份权威。

---

## 1. 产品形态：一套脚手架，两种模式

```
                  ┌──────────────────────────────────────┐
                  │  Scaffold（模型无关）                  │
                  │  观测面 + 反馈面 + 动作面 + 协议        │
                  └──────────────────┬───────────────────┘
        ┌───────────────────────────┴───────────────────────────┐
   模式 A：单机游玩                                模式 B：模型基准评测
   一个模型 × 一局（可续）                        固定世界 × N 模型 × R 次重复
   实时看板、随手停/改                            manifest + 配对统计 + 分数卡 + 报告
   不比较、不排除、不谈功效                        预登记先于数据（P2-3 已实现）
```

**共用内核（两种模式必须逐字相同，任何差异都必须在 manifest 里声明）**

| 内核 | 权威位置 |
|---|---|
| 系统提示词（角色 + 世界机制 + 交互协议 + 计分口径） | `src/agent/runtime.ts` `SYSTEM_PROMPT` |
| 工具集合、参数 schema、描述、拒绝理由 | `src/agent/tools/index.ts`、`src/agent/tools/catalog.ts` |
| 决策上下文构造（事实 JSON） | `src/agent/decision-context.ts` + `src/agent/loop.ts` |
| 动作回执与结算事实（GS 事件 → 通道 → 账本） | `src/game/squirrel/bridge-gs/main.nut` → `src/agent/signal-hub.ts` |
| 跨局记忆的**事实**格式与注入包装 | `src/evolution/`、`src/agent/context.ts` |

**模式只允许改变**：编排（跑几次、跑哪些模型）、记录（manifest）、统计、看板。
**不允许**改变模型看到的内容——否则"基准"测的是脚手架差异，不是模型能力。

---

## 2. 四根支柱

### 2.1 观测面（Observation）

每到一个决策点，模型收到**一份** JSON 上下文（`buildDecisionContext`）：

| 字段 | 内容 | 来源 |
|---|---|---|
| `now` | 游戏日期 + 各公司读数（money / income / vehicles / stations） | world state |
| `towns` | 可选站点：id / pop / x / y | world state |
| `routes` | 已建线路经济：profit / waiting / 车辆归属 / 货物 / 车型 | GS 路由账本 |
| `executor` | 施工进度：剩余 tiles、tiles/game-day、ETA、停滞天数、已见 job 数 | GS 相位 |
| `session` | 墙钟剩余、模拟日剩余、游戏日剩余（episode 边界） | 调度器 |
| `since` | 自上次决策以来的世界增量、相位、已执行动作、值得注意的事件 | 决策追踪器 |
| `score` | **本局累计交付、每游戏日、测量窗口起点、horizon** | world state（`deliveredRun`） |

**`score` 块的形状与语义**（S1，2026-10-08 定）

```
score: {
  delivered: number | null,          // 本局累计交付（与度量行 deliveredRun 同一个数）
  deliveredPerGameDay: number | null, // delivered / elapsedGameDays（两者任一未知则 null）
  elapsedGameDays: number,            // 本局已经历的游戏日
  horizonDays: number | null,         // 本局 horizon（未设则 null）
  scoredFromGameDay: number | null,   // 计分窗口开启的那一天（null = 整局都是窗口）
  windowOpened: boolean               // 计分窗口是否已开启
}
```

- **与度量同一个数**：`delivered` 必须等于该局度量行的 `deliveredRun`（`SPEC.md` §10.65），
  否则模型看到的分与最终被记的分不是同一个分。
- **缺失不折零**：还没有交付读数时 `delivered` 是 `null`；`deliveredPerGameDay` 在
  `delivered` 或 `elapsedGameDays` 未知时是 `null`。
- **窗口是条件，不是评价**：`scoredFromGameDay` / `windowOpened` 只说"计分从哪天开始"，
  不说"这算好还是不好"。


**观测铁律**

- **O1 一个事实一处真值**：同一事实不得在多个通道重复出现（见 §4 S2）。
  `observe()` 是**按需刷新**，不是第二份真值。
- **O2 缺失 ≠ 0**：未观测到的量必须是 `null` / 字段缺席，绝不折叠成 0。
- **O3 顺序确定**：同一批事实任何时候的排序一致（人口降序等规则写死在一处）。
- **O4 只给事实与因果，不给策略**：禁止"应该建几条线/该加车"这类注入（AGENTS 铁律 7 / J2）。

### 2.2 反馈面（Feedback）

每个写动作的生命周期由三段事实组成：

1. **请求回执**——工具返回"请求被接受"（带 `job` 等标识）。**不等于生效**。
2. **生效事实**——引擎确认的生效值（`cargoApplied` / `engineApplied` / `fleetApplied` / `fleetIds`）。
3. **结算事实**——该动作的世界后果（施工完成 / 失败原因 / 车队上线 / 交付开始出现）。

**反馈铁律**

- **F1 可关联**：三段事实必须能按 `job` 关联起来（当前**未达成**，见 §4 S4）。
- **F2 不谎报**：没有第 2/3 段时，第 1 段不得声称成功；必须显式拒绝并说明原因。
- **F3 失败全文**：失败原因走类型化 `exec.error` 全文通道，不得截断、不得静默。

### 2.3 动作面（Action）

11 个工具（5 读 / 6 写），登记表在 `ACTION_EFFECTS`：

- 读：`observe` `estimate_route` `inspect_route` `recall` `capabilities`
- 写：`build_bus_route` `set_route_vehicles` `set_route_cargo` `set_route_engine` `retire_route` `set_pause`

**动作铁律**

- **A1 前置即拒绝**：每个写动作的引擎前置（公司作用域 / 车辆在库 / 时序）不满足时
  **明确拒绝并说明原因**，不得静默失败。
- **A2 变更即登记**：新增/改名动作必须同步 `ACTION_EFFECTS`、工具名列表与世界状态字段
  （守卫会抓漏）。

### 2.4 协议（Protocol）

决策输出是结构化 JSON：`{goal, plan, immediate_action, wait_until, rationale}`；
`wait_until` 决定框架何时再次唤醒模型。

- **P1 只规定接口，不规定内容**：框架不替模型决定该建什么、该等多久。

---

## 3. 两种模式各自增加什么（不污染共用内核）

| 维度 | 模式 A：单机游玩 | 模式 B：模型基准评测 |
|---|---|---|
| 世界 | 随机或指定 seed | **固定**：同 seed + 同初始态 + 同 horizon + 同测量窗口 |
| 重复 | 1 局（用户可续） | 每格 ≥3 次重复（预登记） |
| 记录 | 会话 + 实时看板 | **run manifest**（模型实际服务名、脚手架指纹、配置、任务、seed、重复序号、结果分类）+ 原始记录 |
| 统计 | 无 | 配对（同 seed 跨模型）+ 预登记功效闸（P2-3 已实现：不够 n 拒绝出结论） |
| 产物 | 看板 | 分数卡（能力 / 效率 / 稳定性 / 成长）+ 失败分类 + 机器可读 JSON + 人读报告 |
| 隔离 | 单目录 | **每格独立 data dir**（记忆不串、进化库不串） |
| 记忆 | 默认开（自进化是产品特性） | 基准默认**冷启动**；成长性另设 sequential 模式 |

**分数卡（模式 B 的四个正交轴）**

| 轴 | 主指标（预登记） | 辅助指标 |
|---|---|---|
| 能力 | `deliveredRun / game-day` | 线路数、站点数、车队规模、载货/日 |
| 效率 | 每 1M token / 每 $ 的 delivered | 每决策 token、cacheRead 占比、reasoning token、每局墙钟 |
| 稳定性 | 方差、结果分类分布 | 工具失败率、GS 错误率、阻塞/冻结率 |
| 成长 | sequential 斜率 CI | 记忆条目曲线、经验使用分布 |

评分只用**客观标量**，**不用 LLM 裁判**。

---

## 4. 脚手架待打磨清单（"足够优秀"的定义）

| ID | 缺口 | 现状（坐标） | 影响 |
|---|---|---|---|
| **S1** | **agent 看不见自己的分数** | `world-state.ts` 有 `deliveredRun`；`loop.ts` 的上下文只给 money/income/vehicles/stations | 自我评估缺失；信用分配没有起点；系统提示词说了计分口径却不说自己考了多少分 |
| **S2** | **同一事实三处出现** | 决策上下文（companies/towns）+ `observe()` summary（同样字段，**顺序还不同**）+ 每决策追加的 `game_observation` 消息 | 噪声与 token 浪费；"哪个顺序是权威"产生歧义；事实漂移风险 |
| **S3** | **未观测基线被折成 0** | `decision-context.ts` `numbersOf` 把 `null` → 0 再算 delta | 模型把"没读到"读成"没变化"（违反 O2 / D60） |
| **S4** | **动作与后果未成对** | 工具回执带 `job`，但 GS 相位不绑 job，结算事实散落 | 信用分配断裂（反馈铁律 F1 未达成） |
| **S5** | **agent 看不见自己历局成绩** | 记忆只注入 lesson 文本，没有"我历局的每游戏日交付"序列 | 无法自我调节（`ROADMAP.md` 对齐检查表 #10 长期未修） |
| **S6** | **关键旋钮不可配** | `runtime.ts` 思考档位写死 `off`；`runner.ts` 建 Agent 时未传 `thinkingLevel` / `maxToolCallsPerDecision`；`config.ts` 无这两项；CLI 无 `--llm-provider` | 成熟度下限；基准无法扫"思考档位 / 工具预算"这两个最有区分度的变量 |
| **S7** | **世界事实有洞** | 逐线交付量无；GS 镇名样本外只有 `#id`；贷款/融资无事实 | 信号不足、决策面受限 |
| **S8** | **结果分类缺失** | "0 分"有 6+ 种成因（自暂停 / 世界冻结 / 墙钟到 / 工具连拒 / 施工失败 / 没建线）混在一起 | 分数不可解释，基准无法归因 |
| **S9** | **脚手架无指纹** | 无提示词哈希、无工具 schema 哈希 | 无法证明两个模型看到的是同一套脚手架（模式 B 的前提） |

---

## 5. 信号从哪来：源 → 归一 → 呈现

> 本节回答"模型看到的每个事实是从哪条通道来的、经过什么处理、以什么形态出现"。
> 另一半（**模型侧**看到什么、承诺什么）在本文件 §2；这份分工是防漂移的关键。

### 5.1 三个信号源

| 源 | 内容 | 现状 |
|---|---|---|
| **Admin Port 推送** | 日期、公司信息/经济/统计、聊天/控制台、GS 消息 | ✅ 已用 |
| **GS API**（实测可用，见 `SPEC.md` §10.25 探针） | 城镇（人口/增长/上月运输/位置）、工业与货源、站点（等待货量/评级）、车辆（位置/速度/今年利润/年龄）、财务（余额/贷款/估值）、事件（车毁/首车到站/城镇成长）、空间（地图尺寸/地形/距离） | 部分已用（城镇样本、站点等待、车辆与车队账本）；**工业/货源、事件族、财务明细未用** |
| **harness 自己计算** | 路线估价（距离/造价/工期）、决策→结果账本、镇间距离摘要 | 估价已用（`estimate_route`）；**决策→结果账本未成体系**（见 §4 S4） |

**边界判定**（哪句话是事实，哪句话是策略）：

| 允许（事实） | 禁止（策略） |
|---|---|
| "a↔b 距离 42 tiles，预计造价 X，工期 Y" | "选近的更好" |
| "这条线今年亏 200" | "别建远线" |
| "上次 3 辆车时每游戏日交付 11" | "多派车能提高收益" |

### 5.2 RL 五要素 → 本 harness 的形态

| RL 要素 | 形态 | 现状 |
|---|---|---|
| State | 常驻增量 + 按需查询（人看 HUD 的等价物） | ✅ 事实通道齐（§2.1） |
| Action affordance | 工具契约 + **前置条件拒绝的原因** | ✅（"工具必须能拒绝"已实现） |
| Reward | **不是标量**，是可归因的结果事实（这条线收入 X / 成本 Y / 时滞 Z） | ⚠️ 事实有（路线经济），但**与自身成绩的连接缺失**（§4 S1） |
| Credit assignment | 决策 → 结果的账本对齐（3 月建线、4 月来钱必须连起来） | ❌ 缺（§4 S4） |
| Episode 边界 | 固定 horizon + 局终结算与反思 | ✅ |

**核心判断**：本 harness 不是 Q-learning，不需要标量 reward；需要的是**可归因的结果事实**。
OpenTTD 的年度分类账 + 事件时间线提供了全部原料，缺的是 harness 把它们**对齐**。

### 5.3 呈现分层 L0–L3

| 层 | 内容 | 形态 |
|---|---|---|
| **L0 常驻** | 协议事实、工具契约、计分口径 | 系统提示词（给**接口**，不给**选择**） |
| **L1 每轮增量** | 自上次决策以来的世界增量、相位、失败事件 | 决策上下文的 `since` 段 |
| **L2 按需查询** | 人的"点击即查"等价物：参数化查询某镇/某线/某车/年度账本 | 工具族（`observe`/`inspect_route`/`estimate_route`…；`inspect_town`/`inspect_vehicle`/`finances` **未做**） |
| **L3 推送** | 新闻门：阶段变化、失败事件、首车到站、车毁、城镇成长 | 已做阶段/失败；**GSEvent 族未做** |
| **看板（一次性大信息）** | 空间摘要（top-N 镇距离矩阵）、minimap | minimap 已有；agent 侧结构化空间摘要未做 |

**降噪原则**（与 §2.1 的 O1 同源）：L1 只发**变化**，L2 才给全量，L3 只推值得注意的；
任何一层的"全量重复"都是噪声（现状：companies/towns 在三个通道重复，见 §4 S2）。

---

## 6. pi-agent-core 的利用路线（成熟度杠杆）

仓库当前只用 pi-agent-core 的**裸 `Agent`**（`src/agent/runtime.ts`），
`harness/` 子系统（0.85.1）**一行未用**。它能直接补掉上面多项：

| 能力 | 坐标 | 补哪个缺口 |
|---|---|---|
| `AgentHarness` + lane（每 lane 独立 model / thinkingLevel / activeTools） | `pi-agent-core/dist/harness/agent-harness.d.ts` | S6（消融）、脚手架变体轴 |
| hook `before_payload` / `after_response` | 同上 `HookMap` | S9（给每次真实请求做指纹） |
| hook `before_tool` / `after_tool`（可 block） | 同上 | 工具预算下沉到 harness 层（成熟度） |
| 事件流（turn / tool / usage / retry / config_update / fault） | 同上 `HarnessEventPayload` | S8（结果分类的原料）、S4 |
| usage 台账（每 entry 一行，含 reasoning / cache / cost） | `harness/session/types.d.ts` | 效率轴指标 |
| `JsonlSessionRepo`（create / open / list / fork） | `harness/session/jsonl/repo.d.ts` | 可回放会话、run 记录 |
| `CompactionSettings` | `harness/compaction/compaction.d.ts` | 上下文预算作为受控变量 |
| `Skill` / `PromptTemplate` | `harness/skills.d.ts` | 脚手架变体轴（提示词工程可比较） |
| OTel schema（`AI_TELEMETRY_SCHEMA` / `HARNESS_TELEMETRY_SCHEMA`） | `harness/telemetry.d.ts` | 标准 trace 导出 |
| faux provider（pi-ai） | 已在用 | CI 离线冒烟（"接线没断"） |

**三条必须先讲清的限制**

1. **lane ≠ 模型并行评测**：lane 共享工具上下文 = **同一个世界**，两个 lane 都会改同一家
   公司 → 那是互相污染的对照。模型并行评测必须**多实例**（多 port / 多 data dir）。
2. **session fork 不是标准基准单元**：它是"同一世界前缀下换模型"的反事实对比，
   很有价值，但必须与"独立重跑"分开统计。
3. **迁移有成本**：`AgentHarness` 需要 `Context`（chord）、`Models` 注册表与
   `AgentHarnessTool` 形状，与现有 `AgentTool` 不同 → 必须**分层迁移、每步可回退**。

---

## 7. 不变量（两种模式都必须满足；模式 B 会逐条断言）

| ID | 不变量 | 守卫形态 |
|---|---|---|
| **I1** | 提示词与注入的记忆里**没有策略/祈使句**（J2） | 单元守卫（已有 lessons 祈使句守卫，扩展到系统提示词与上下文） |
| **I2** | 缺失永不折叠成 0（O2） | 单元守卫 + 真机 grep |
| **I3** | 一个事实只有一处真值、只出现一次（O1） | 上下文快照断言（同一事实不得在两个通道出现） |
| **I4** | 每个写动作要么带引擎确认的生效值，要么显式拒绝（F2） | 动作回执守卫 |
| **I5** | 模型无关：提示词、工具、预算、观测面对所有模型逐字相同 | manifest 里记录指纹并比对（S9） |
| **I6** | 结果可归因：0 分必须带**结果分类**（S8） | manifest 必填字段 |

---

## 8. 验收口径

**脚手架侧**：§2 的每条铁律都有守卫测试（缺失≠0 / 无重复事实 / 无策略注入 /
动作必回执或拒绝 / 结果必分类）；模式 A 的真机链路不回退（`pnpm run gate` +
`pnpm run dashboard:smoke` 0 控制台条目 + 真机断言）。

**基准侧**：manifest 完整率 100%；每局都有结果分类；功效不足时**拒绝出结论**
（不是出 p 值）；报告可机器读（JSON）也可人读（MD）。

**参照**：统计口径沿用 `src/evolution/metrics.ts`（`powerVerdict` / `learningCurve` /
`experienceOutcomes`，SPEC §10.112–§10.113）；实验编排沿用 `scripts/run-experiment.ts`。

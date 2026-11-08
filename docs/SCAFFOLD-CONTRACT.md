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

- **O1 一个事实一处真值**：世界事实只由**一个投影函数**产生
  （`src/agent/world-facts.ts`），决策上下文与 `observe()` 读的是同一份投影
  （同字段、同排序）——两个通道不再是两套会漂移的实现（见 §4 S2）。
  `observe()` 是这份投影的**按需刷新**，不是第二份真值。
  **每次决策的 transcript 只保留一份全量状态**（在 prompt 里）；审计侧的快照
  另存于审计记录，不进模型上下文。
- **O2 缺失 ≠ 0**：未观测到的量必须是 `null` / 字段缺席，绝不折叠成 0。
- **O3 顺序确定**：同一批事实任何时候的排序一致（人口降序等规则写死在一处）。
- **O4 只给事实与因果，不给策略**：禁止"应该建几条线/该加车"这类注入（AGENTS 铁律 7 / J2）。

### 2.2 反馈面（Feedback）

每个写动作的生命周期由三段事实组成：

1. **请求回执**——工具返回"请求被接受"（带 `job` 等标识）。**不等于生效**。
2. **生效事实**——引擎确认的生效值（`cargoApplied` / `engineApplied` / `fleetApplied` / `fleetIds`）。
3. **结算事实**——该动作的世界后果（施工完成 / 失败原因 / 车队上线 / 交付开始出现）。

**反馈铁律**

- **F1 可关联**：三段事实必须能按 `job` 关联起来。
  **D3a 已达成第一段**：相位事实带 `job`，并接回**订下它的那次动作**
  （`action`，来自 GS ack——job id 由 GS 分配，工具自己的回执里没有）。
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

**配对统计按轴给结论**（2026-11-08）

配对（同一 seed、同一重复序号的两局做差）**只对"逐局能取标量"的轴有意义** ⇒ 三条：

| 轴 | 逐局标量（配对用） | 辅助标量（也可配对） |
|---|---|---|
| 能力 | `deliveredRun / game-day` | 站点数、车辆数、货物吨数/游戏日 |
| 效率 | `deliveredRun / 1M tokens` | 每决策 token、每局墙钟 |
| 稳定性 | 工具失败率（`toolFailures / toolCalls`） | GS 错误率/局 |

**成长轴不进配对**：它的主指标是**跨局的斜率**（`learningCurve`），不是逐局标量 ⇒
它的判定仍由分数卡的成长曲线给出（顺序实验，sequential 模式）。

铁律：① **配对只比同一轴**（跨轴的差没有意义）；② 一侧缺失的配对**整格丢掉**（缺一个数
≠ 差为 0）—— 且**配对按“局”定**：重复序号在**可比较的行**上数，与指标无关 ⇒ 一个轴缺读数
只让 n 变小，**不会把两局错配**；③ 配对 < 3 ⇒ `not determinable`（不是"无差异"）；
④ 报告必须写明**轴**、**配对设计**与 **n**；⑤ 判定**只由服务端出**（页面不重算、不下判断）；
⑥ **方向 ≠ 胜负**：判定词（`a_higher` / `b_higher`）说的是**数字的方向**，而效率轴上
"更大"通常是**更差**（更多 token / 更多秒）⇒ 指标的**好坏方向**写在指标目录里，服务端
给出「谁更好」；**不带好坏方向的指标**（站点数、车辆数）明说「no quality」。

---

## 4. 脚手架待打磨清单（"足够优秀"的定义）

| ID | 缺口 | 现状（坐标） | 影响 |
|---|---|---|---|
| **S1** | **agent 看不见自己的分数** | `world-state.ts` 有 `deliveredRun`；`loop.ts` 的上下文只给 money/income/vehicles/stations | 自我评估缺失；信用分配没有起点；系统提示词说了计分口径却不说自己考了多少分 |
| **S2** | **同一事实三处出现** | 决策上下文（companies/towns）+ `observe()` summary（同样字段，**顺序还不同**）+ 每决策追加的 `game_observation` 消息 | 噪声与 token 浪费；"哪个顺序是权威"产生歧义；事实漂移风险 |
| **S3** | **未观测基线被折成 0** | `decision-context.ts` `numbersOf` 把 `null` → 0 再算 delta | 模型把"没读到"读成"没变化"（违反 O2 / D60） |
| **S4** | **动作与后果未成对** | 工具回执带 `job`，但 GS 相位不绑 job，结算事实散落 | 信用分配断裂（反馈铁律 F1 未达成） |
| **S5** | **agent 看不见自己历局成绩** | 记忆只注入 lesson 文本，没有"我历局的每游戏日交付"序列 | 无法自我调节（Issue #8；已在阶段 D1 修掉） |
| **S6** | **关键旋钮不可配** | `runtime.ts` 思考档位写死 `off`；`runner.ts` 建 Agent 时未传 `thinkingLevel` / `maxToolCallsPerDecision`；`config.ts` 无这两项；CLI 无 `--llm-provider` | 成熟度下限；基准无法扫"思考档位 / 工具预算"这两个最有区分度的变量 |
| **S7** | **世界事实有洞** | 逐线交付量无；GS 镇名样本外只有 `#id`；贷款/融资无事实 | 信号不足、决策面受限（设计与顺序见 §9） |
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
| **I5** | 模型无关：提示词、工具、预算、观测面对所有模型逐字相同 | manifest 记录两枚指纹；Compare 页对**不同的**指纹给出披露（见 §7.1） |

### 7.1 指纹范围：观测面**不进** `scaffoldHash`，但**要有一枚自己的结构指纹**（2026-11-02 修订）

**结论：不合并。观测面由 `observationShapeHash`（结构）覆盖，
`payloadShapeHash` 降级为"逐字请求"的记录。**

| 指纹 | 覆盖什么 | 何时可算 | 用途 |
|---|---|---|---|
| `scaffoldHash` | 系统提示词 + 工具 name/description/schema（**静态**） | 跑之前（预览就有） | 同一套脚手架？ |
| `observationShapeHash` | 观测面的**结构**（有哪些世界事实、什么类型），**值全抹掉** | 跑之前（只依赖代码） | 两局看的是**同一个问题**吗？ |
| `payloadShapeHash` | **整份真实请求**（含 `observe()` 文本），所有数值归一化 | 跑之后（首帧 payload） | 逐字请求长什么样（**含世界 ⇒ 跨 seed 必不同**） |
| `observationPolicy` | **GS 自报**它暴露了世界的哪一部分（`towns=all;industries=top12`） | 跑之后（GS 第一次心跳） | 两局看的是**同一片**世界吗？ |
| `payloadHash` | 同上但不归一化数值 | 跑之后 | 逐字相同？跨 seed 必然不同 |

理由：
1. **可预测性**：观测面**的值**取决于世界，跑之前不存在；并进 `scaffoldHash` 会让
   "下一次运行会用什么"的预览承诺一个算不出来的值。
2. **跨 seed 可比性**：`scaffoldHash` 的用途是"不同 seed、同一脚手架 ⇒ 同哈希"。
   观测面的**值**随 seed 变 ⇒ 哈希随之变 ⇒ 该用途被毁掉（`payloadHash` 已经
   踩过这个坑，才需要 `payloadShapeHash`）。
3. **结构 ≠ 值，也 ≠ 切片**（2026-11-02 的修正）：`observationShapeHash` 只看**字段结构**，
   所以"看到全部 26 座城"与"只看到人口前 10"的结构**一样** —— 但它们是**两个问题**。
   ⇒ 切片必须由**GS 自报**（`observationPolicy`）：只有它知道自己取了多少，外面不能猜
   （"列表长度"是世界的读数，"我给你看哪一刀"是代码的承诺）。
4. **结构 ≠ 值**（2026-11-02 的修正）：`payloadShapeHash` 含**世界**（城镇名、产业
   清单）⇒ **每个 seed 都不同** ⇒ 拿它**跨局**比较会把"同代码、不同世界"误报成
   "不是同一个问题"。**假警报比没警报更坏**（它会让人不信任正确的比较）。于是需要
   一枚**只看结构**的指纹：投影多了一个字段 ⇒ 指纹变；地图上多了一座城 ⇒ 不变。
   它的算法是"用**填满所有分支的探针世界**跑一遍投影，取结果的形状（值全抹掉、
   数组长度不计）"，所以它**只依赖代码**，跑前就能算，两种后端都一样。
5. **真正的缺口不是哈希而是比较**：`buildCompareView` 返回
   `surface{scaffoldHashes, observationShapeHashes, payloadShapeHashes, differs}`，
   `differs` **只**由前两枚（跨 seed 稳定）决定；Compare 页在被比较的局来自不同指纹
   时**明说**"它们回答的不是同一个问题"。页面不排除、不下判断（是否剔除是审阅者
   的决定）。

**尚未覆盖（必须说清，不能假装已覆盖）**：`payloadHash` / `payloadShapeHash` 只在
**harness 后端**有值（它们来自 `before_payload` 回调）；默认后端跑出来的局这两项是
`null`（真机账本实测：6 行全是 `null`）。**这不再影响"是否同一问句"的判断** ——
那件事现在由 `observationShapeHash` 回答（两种后端都记录，真机实测值
`f06107cdb4c77a59`，且**预览与 manifest 逐字段相同**；投影结构一变它就变——融资事实进观测面
时它从 `ba1cc7959b170e8d` 挪到了新值）。
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

---

## 9. S7 世界事实补洞：设计与顺序（待所有者审核）

> 目的：把"世界有洞"变成**一次一类事实、每类可单独验收**的四步，而不是一次性
> 重做观测面。判据仍是 `AGENTS.md` §2 铁律 7：只给事实与因果，不给方法。
> **未核实的 API 一律标注"待真机验证"，不进 `SPEC.md`**（D43）。

### 9.1 恒定的两条约束

1. **一次只改一类事实**。每加一类都要能回答"上一次改动之后，模型的行为变了多少"
   ——同时改三样，任何差异都无法归因。
2. **可比性自己会变**。观测面**不在** `scaffoldHash` 里（它有自己两枚指纹：
   `observationShapeHash` = 投影的**结构**、`observationPolicy` = GS **自报**暴露了哪一片世界），
   所以任何一步都会让**改动前后的局变成"不同的问题"**。现在的处理办法（2026-11-02，
   所有者决定 (b)）：Compare 按 manifest 的三元组**分组**，一次只比一组，别的组披露
   （见 `docs/DASHBOARD-API.md` §3.8）——而不是把两副脚手架的数字混在一张表里。

### 9.2 四个缺口（按"该先补哪个"排序）

| # | 缺口 | 现在的事实（坐标） | 数据从哪来 | 风险 |
|---|---|---|---|---|
| **S7a** | 城镇**没有名字** | ✅ **已补**（PR #74）：GS 改报**全图城镇**并带名字（真机 26 座城全部有名字进 `observe()`）；GS 自报 `towns=all;industries=top12` | GS 侧 `GSTown.GetName`（真机已验证） | 本地化字符串（非 ASCII）进 payload 的编码坑（`SPEC.md` 的 Squirrel 字符串教训） |
| **S7b** | **逐线交付量**不存在 | ⚠ **2026-11-05 纠正**（调研：`docs/PER-LINE-DELIVERY-FEASIBILITY.md`）：Squirrel **有** cargo monitor（`GSCargoMonitor.GetTownDeliveryAmount/GetIndustryDeliveryAmount`，`@api game`）⇒ **按城镇 / 按产业**的交付量**可测**（当初"不可测"是我们自己的累加器抛异常，Squirrel 的表严格 ⇒ MEMORY D94）。**仍然不可测**的是**逐车站 / 逐线路**（整个脚本 API 没有 `GetCargoTotal`，引擎也不记）。⇒ 逐线路只能**自己推导**（路线台账 + 唯一服务规则），**不用换引擎** | GS 的 cargo monitor（城镇 / 产业粒度）+ 我们自己的路线台账（推导） | ① monitor **只统计货运**，而当前脚手架**只建客运线路** ⇒ 货运读数恒为 0（要先把货运线路做出来）；② 同城镇多条线 ⇒ 不可分摊 |
| **S7c** | **融资事实缺失** | ✅ **已补**（PR #75）：投影带 `financing{loanCeiling, loanInterval}`（真机 300000 / 10000）。**利息率引擎不暴露** ⇒ "没测到"，不猜；且必须在**公司模式**里读（`COMPANY_SELF` 在全局脚本里解析不出来，MEMORY D93） | `GSCompany.GetMaxLoanAmount`（真机已验证）/ `GetLoanInterval`（真机已验证） | 利率是"该怎么花钱"的暗示？不是——它是价格事实，与"造价 X"同类 |
| **S7d** | **推送族未用** | L3 只推相位与失败；车毁/首车到站/城镇成长都走不到模型 | `GSEventVehicleLost` / `GSEventTownGrowth` 等（**待真机验证**） | 噪声：推送太多会淹没增量段，必须先定"值得推"的门槛 |

### 9.3 每一步的验收

| 步 | 验收（缺一不可） |
|---|---|
| S7a | 单测：名字缺失 → 保持 `#id`（缺失不折叠）；真机：**样本外**城镇（不在 top-N 里）也有名字；token 增量实测记录 |
| S7b | 事实串**明确写归因口径**（"delivered into town X"）；真机：两条线同镇时数字**相同**（证明是城镇口径，不是线路口径）；`null` 仍是 `null` |
| S7c | 只读工具返回引擎读数；无法读到 → 明确拒绝并给原因；真机抓包进 payload |
| S7d | 每个事件类型都有"为什么值得打断模型"的一句话；真机：一次真实车毁产生一条推送，且不重复 |

### 9.4 需要所有者决定的三件事

1. **S7b 的归因口径**是否可接受：OpenTTD 不提供逐线交付，只有逐城镇/逐货种。
   接受则模型看到的是"进入该镇的货量"，模型需自己知道这不是线路口径。
2. **顺序**：是否按 a → b → c → d？(a) 最便宜且纯命名，(b) 信息量最大但归因有边界，
   (c)(d) 价值取决于后续是否要玩金融/事件驱动。
3. **是否允许一次 PR 只做一步**（推荐：是；这样 `scaffoldHash` 的变化可与行为变化对齐）。


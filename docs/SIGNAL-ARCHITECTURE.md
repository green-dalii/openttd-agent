# SIGNAL-ARCHITECTURE — Agent 环境信号的设计契约

> **职责**: 回答一个设计问题 —— harness 必须向 agent 提供**哪些**信号、**怎样**提供，
> agent 才能像人一样在 OpenTTD 里以强化学习方式游玩，而不是盲人摸象。
> **边界**: 本文是设计与事实盘点（AGENTS §6），进度见 ROADMAP，教训见 MEMORY。
> **依据**: 实测事实见 SPEC §10.20–§10.36；GS API 能力见 EXECUTOR-ARCHITECTURE.md。

---

## 1. 第一性原理：对照"人"的信息面

一个真人玩家在 OpenTTD 里的信息获取方式只有五种，全部可以映射到 harness：

| 人的方式 | 内容 | 对应 harness 层 |
|---|---|---|
| **常驻 HUD** | 钱、日期 —— 一眼扫过，永不关闭 | L1 每轮增量 |
| **点击即查** | 任何城镇/站/车/工业，点开就有窗口。**人的信息是按需、有指向的** | L2 参数化查询 |
| **空间感** | 小地图、地形、距离直觉 —— "这两个镇隔得远"是看出来的 | 看板（结构化空间摘要）|
| **推送** | 新闻：车到站、倒闭、事故、城镇成长 | L3 事件流（新闻门）|
| **年度账本** | **收入支出分类表**（客运收入/建设支出/利息…）—— 天然的归因源 | 归因账本 |

RL 五要素对齐：

| RL 要素 | 在本 harness 中的形态 | 现状 |
|---|---|---|
| State | 全局 HUD + 按需局部查询 | ⚠️ 只有 observe，无参数化 |
| Action affordance | 工具契约 + **前置条件拒绝的原因** | ✅（"工具必须能拒绝"已实现）|
| Reward | **不是标量**——是可归因的结果事实（这条线收入 X / 成本 Y / 时滞 Z）| ❌ 完全缺失 |
| Credit assignment | 决策→结果 账本对齐（3 月建线、4 月来钱，必须连起来）| ❌ 缺失 |
| Episode 边界 | 局终结算 + 反思 | ✅ |

**核心判断**：我们不是 Q-learning，不需要标量 reward；需要的是**可归因的结果事实**。
OpenTTD 年度分类账 + 事件时间线已经提供了全部原料 —— 缺的是 harness 把它们**对齐**。

---

## 2. 双向盘点：OpenTTD 能提供什么（信号源清单）

### 2.1 Admin Port 推送（harness 已解析一部分）

| 包 | 内容 | 现状 |
|---|---|---|
| date / company_info | 日期、公司名（**执行器 phase 通道**）、颜色、AI 标记 | ✅ 已用 |
| company_economy | money、loan、income | ✅ 已用 |
| company_stats | vehicles/stations 计数 | ✅ 已用 |
| chat / console / gamescript | GS 消息、rcon 回显 | ✅ 已用 |
| **company_expenses 分类账** | 按类别的收支（建设/车辆/利息）| ❌ **未解析 —— 归因的现成来源** |
| **news** | 游戏新闻消息 | ❌ 未订阅 |

### 2.2 GS API（`@api ai game`，已被 §10.25 探针证实可用）

| 信号 | API | 用途 |
|---|---|---|
| 城镇详情 | `GSTown.GetPopulation/GetGrowthRate/GetLastMonthTransported/GetLocation` | 选址事实 |
| **工业/货源** | `GSIndustry.*`（类型、产量、运输量）、`GSCargo.*` | 货运决策的前提 |
| 站点状态 | `GSStation.GetCargoWaiting/GetCargoRating` | "我的线是否积压/饱和" |
| 车辆详情 | `GSVehicle.GetLocation/GetSpeed/GetProfitThisYear/GetAge/GetState` | 车队管理 |
| 财务 | `GSCompany.GetBankBalance/GetLoanAmount/GetValue`、`GSEconomy` | HUD |
| 事件 | `GSEvent.*`（车毁、首车到站、城镇成长）| L3 推送 |
| 空间 | `GSMap.GetSize`、`GSTile.GetTerrainType`、距离计算 | 看板/估价 |

### 2.3 harness 必须自己计算的（OTTD 不直接给，但 RL 必需）

| 信号 | 为什么必需 | 边界判定 |
|---|---|---|
| **route 估价**：a↔b 距离、预计造价、预计工期 | §10.34 实测：没有它，"按人口取前二"是唯一策略 | 路径长度=事实 ✅；"选近的更好"=策略 ❌ |
| **决策→结果账本**：哪个决策创建了哪条线、成本、建成耗时、逐月收入 | credit assignment；反思因此才有料可写（现在只喂 outcome，只能写空洞 lesson）| "这条线亏了"=事实 ✅；"别建远线"=策略 ❌ |
| 镇间距离矩阵（top-N） | 人的"距离直觉"的结构化等价物 | 事实 ✅ |

---

## 3. 呈现架构：L0–L3

### L0 常驻（system prompt，现状保持）
协议事实、工具契约。给**接口**，不给**选择**。

### L1 每轮增量（user 消息，需重构）
- **只发变化**：money/stations/vehicles 的 delta + 新阶段 + 失败事件（新闻门已保证稀疏）
- **修正缺口**：towns 摘要补进 `now`（§现状 towns 不在每轮注入，要 observe 才有）
- 去掉 companies 全量重复（loan/income 不变就不重发）

### L2 按需查询（参数化工具族 —— 对应人的"点击"）
```
inspect_town(id)      人口/增长率/上月运输量/到各候选镇距离
inspect_route(id)     站点/车辆数/本月收入/等待货物/账本（哪次决策建的、花了多久）
inspect_vehicle(id)   位置/状态/今年利润/年龄/载货
estimate_route(a,b)   曼哈顿/路径距离、预计造价、预计工期、当前资金是否够
finances()            年度分类账（客运收入/建设支出/利息）—— 归因入口
```
依赖结构化通道（审计 P0）：无 JSON 通道，这些工具的返回仍要压 summary 字符串。

### L3 推送（事件流）
新闻门已做（stage 变化/失败触发）。补充 GSEvent 族：首车到站、车毁、城镇成长。
**失败必须带原因**（`road_stuck` → 为什么：地形/资金/路径）。

### 看板（一次性大信息）
minimap 截图已有（stage-view）。给 agent 的等价物是**结构化空间摘要**：
top-N 镇的距离矩阵，随 L2 estimate 按需取，不整表轰炸。

---

## 4. 红线（harness 边界，违反即失效）

- ✅ 事实与因果：价格、距离、机制、账本、**过去式教训**
- ❌ 策略：任何"应该/建议/优先"句式 —— **被剧透的 agent 不会试错，也就没有可学的教训**（MEMORY B11）
- 判定法：同一信息，"这条线月亏 200" 说的是世界；"别建远线" 说的是选择。前者给，后者删。

## 5. 实施顺序（依赖驱动）

1. **结构化通道**（GS→admin→agent JSON 化 phase/事件）—— 一切的前置，否则 L2 返回仍走 summary 字符串
2. **L2 查询工具族**（inspect_* / estimate_route / finances）
3. **决策→结果账本** + 把它喂进反思（reflection 现在只喂 outcome 汇总）
4. **L1 重构**（delta 化 + towns 入 now）
5. **GSEvent 推送** + 失败原因
6. 每步以 `loop-health.ts` 验证空转率/observe 占比下降，**再**谈 A/B

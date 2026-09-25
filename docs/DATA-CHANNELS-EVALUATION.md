# 重要数据的获取与呈现：通道评估与选型

> **职责**：本文件回答"城镇/物资/载具这些数据**从哪来**、**怎么呈现**"，给出**选型**与实施计划。
> **边界**：系统事实进 `SPEC.md`（§10.98/§10.99）；未完成的计划进 `ROADMAP.md` §6d；
> 前端结构（面板怎么组织）进 `docs/FRONTEND-ARCHITECTURE.md`；本文只做**通道选择**与口径定义。
> **方法**：读权威源码/官方文档 + **对自己运行的 OpenTTD 15.0 实测**（仓库铁律：协议不许猜）。

## 1. 要取什么（按需求逐条拆开）

| # | 需求（用户原话） | 具体字段 | 谁的口径 |
|---|------------------|----------|----------|
| 1 | 城镇统计（人口、资源） | 人口、坐标、主货种、上月产量、上月运走比例 | 世界（所有公司） |
| 2 | 物资统计：**存量** | 产业等待加工的库存 `GetStockpiledCargo` | 世界 |
| 3 | 物资统计：**运输量** | ① 产业口径 `GetLastMonthTransported` ② **本公司**口径 `GSCargoMonitor` | 两者不同，必须分开 |
| 4 | 物资统计：**处理量** | 产业上月产量 `GetLastMonthProduction` | 世界 |
| 5 | 物资统计：**利用率** | 产业 `GetLastMonthTransportedPercentage`（**所有公司**） vs 本公司运量/产量 | 两者不同，必须标明 |
| 6 | 交通工具（单车） | 车辆 id、类型、所在线路、年龄、状态、本年利润 | 公司 |

## 2. 候选通道与**硬事实**（2026-09-25 核查）

### C1 admin 端口 —— ❌ **拿不到产业/城镇/车辆数据**
- 官方 `AdminUpdateType` 的完整列表是：`DATE, CLIENT_INFO, COMPANY_INFO, COMPANY_ECONOMY,
  COMPANY_STATS, CHAT, CONSOLE, CMD_NAMES, CMD_LOGGING, GAMESCRIPT, END` —— **没有 INDUSTRY、
  没有 CARGO、没有 TOWN、没有 VEHICLE**。
  证据：① `docs.openttd.org` 的 `tcp_admin.h` 枚举页；② GitHub master 的同一枚举；
  ③ 本仓库 `src/game/admin-protocol.ts`（到 `Gamescript = 9` / `End = 10`，包类型到
  `ServerEnableEncryption = 129`）。
- **实测复核**（本机 OpenTTD 15.0）：连上自己的 dedicated server 读 `SERVER_PROTOCOL` 广告，
  协议版本 **3**，广告条目里最大 `update_type` 仍在 `GAMESCRIPT` 量级。
- **修正一条我先前的错判**：我以为"我们的枚举是旧版、缺 INDUSTRY/CARGO"——**不成立**，
  我们的枚举就是当前版本；admin 端口**本来就没有**这些数据。
- 结论：**C1 只能提供公司级事实（已有：economy/stats/breakdown/deliveredCargo）**，
  对需求 1–6 无解。

### C2 Bridge GS 周期上报（已存在的 `cmd=state`，每 200 tick） —— ✅ **主力**
GS 侧可读（官方 GS API，函数名已核对）：
- `GSTown`：`GetPopulation`、`GetLocation`、`GetCargoProduction/GetCargoAccepted`、
  `GetLastMonthProduction`、`GetLastMonthTransportedPercentage`
- `GSIndustry`：`GetIndustryCount`、`GetIndustryType`、`GetLocation`、`GetName`、
  `GetStockpiledCargo`、`GetLastMonthProduction`、`GetLastMonthTransported`、
  `GetLastMonthTransportedPercentage`、`IsCargoAccepted`
- 限制：**只在 agent 模式**（watch 模式没有 GS）；每帧载荷必须**限量**（现在城镇就是 top-10）；
  Squirrel 有两个已知地雷：**未建表键会静默杀掉整个 GS**（MEMORY D44）、
  字符串/名称处理（D34）。

### C3 GS 按需查询（在现有命令通道上加只读查询） —— ✅ **明细用**
用途：agent 或页面需要**全量**产业/车辆清单时再取，避免每帧载荷。
边界：只读事实通道（符合 harness "给事实，不给策略"）；返回必须带**取样/全量**标注。

### C4 `GSCargoMonitor`（GS 内部计量） —— ✅ **唯一能给"本公司运输量"的通道**
- 语义（源码核对）：`GetTownDeliveryAmount(company, cargo, town, keep_monitoring)` /
  `GetIndustryDeliveryAmount(...)` / `GetTownPickupAmount` / `GetIndustryPickupAmount`
  返回**自上次查询以来**的量，并**更新/重置**监视状态（`cargomonitor.h`:
  "Get and reset the amount associated with a cargo monitor"）。
- 推论：它**不是幂等查询** —— 谁先读走、谁就拿到那段增量。所以**只能在 GS 里读**，
  读到的增量在 GS 内累加后再上报（页面绝不能直接查它）。
- 它同时给出**按城镇/按产业**的交付分布（"货去哪了"）。

### C5 console / rcon —— ❌
- 主线 console 里与货/产业相关的只有**枚举型**命令（如 `dump_cargo_types` 列货种清单，
  不含产量/存量）。
- 能按产业/城镇输出统计的命令，在官方 wiki 上位于 **`/Community/Patches/`** 之下
  —— 那是**社区补丁**，不是主线。
- （次要项，**未做实测**：`rcon cmds` 的回包在本轮探针里没拿到，不影响结论。）

### C6 存档解析 / 读内存 —— ❌
脆弱、随版本破裂、违反最小依赖；且会绕过"游戏自己报的数"。

## 3. 先定义口径（否则数字会撒谎）

| UI 词 | 用哪个数 | 口径必须怎么写 |
|-------|----------|----------------|
| Produced (last month) | `GetLastMonthProduction` | 产业侧，上月经济月 |
| Transported (last month) | `GetLastMonthTransported` | 产业侧，**所有公司**运走的量 |
| **Utilization** | `GetLastMonthTransportedPercentage` | **产业口径**：该产业上月被运走的比例（**不是** agent 的成绩） |
| **Our deliveries** | `GSCargoMonitor` 增量累计 | **公司口径**：本公司实际交付/取货量（区间必须写明） |
| Stockpile | `GetStockpiledCargo` | 产业**等待加工**的库存（不是公司仓库） |

**硬规则**：同一个面板里**不得**把"产业利用率"和"本公司运量"并排而不加区分——
那会让人以为 agent 运走了全部。两个数字**分开成两块**，各自标注口径（这是本项目
"null ≠ 0 / 不可得 ≠ 零"诚实规则的同一类要求）。

## 4. 选型结论（最优方案）

**采用 C2（周期上报）+ C3（按需明细）+ C4（公司口径计量）；C1 保持现状；C5/C6 否决。**

| 数据 | 通道 | 为什么不用别的 |
|------|------|----------------|
| 城镇人口/坐标 | C2（**已实现**） | C1 无城镇包 |
| 城镇主货种 + 上月产/运比 | C2 | — |
| 产业存量/产量/运量/利用率 | C2（聚合 + top-N 明细） | C1 无产业包；C6 太脆 |
| 本公司运输量/交付分布 | **C4**（GS 内累计后上报） | 其它通道都拿不到"按公司"的量 |
| 全量产业/车辆清单 | C3（按需） | 每帧发全量会爆载荷 |
| 车辆明细 | C3 + C2（限量采样） | C1 无车辆包 |
| 公司级货物（已在用） | C1 | — |

**watch 模式的诚实边界**：没有 GS ⇒ 需求 1–6 **全部不可得**（必须显示"不可得"，
不能显示 0；沿用 `routesAvailable`/`townsAvailable` 的既有模式）。
**唯一在 watch 也能显示的货物数字**是公司级 `deliveredCargo` 与 `stats.breakdown`（已有）。

## 5. 呈现方案（面板、三态、标注）

新增 **Cargo & industry** 段（放在 Routes 与 Towns 之间）：

1. **货种聚合表**：`Cargo | Produced (last mo) | Transported (last mo) | Utilization %`
   —— 表头注明"utilization = share of production transported, **all companies**"。
2. **产业表**（取样）：`#id | Type | Cargo | Produced | Transported | Util% | Stockpile`
   + 右上角 **"largest N of M industries · sampled"**。
3. **本公司交付块**（C4）：`Cargo | Delivered (this session)` + 按城镇/产业的交付分布
   —— 标题必须写 **"delivered by this company"**，与上面的产业口径分开。
4. **Towns 面板**加列：主货种、上月产/运比（同为世界口径）。
5. **Fleet 抽屉**加"Vehicles"子表（取样 + `N of M`）。

**三态（每个面板都要有）**：`不可得`（watch 模式/无 GS 通道）· `空`（有通道但还没上报）·
`有数据`。取样一律写明 N of M；上月口径一律写 "last economy month"。

## 6. 实施计划（详见 `ROADMAP.md` §6d）

| 阶段 | 内容 | 验收（真机） |
|------|------|--------------|
| **P1** | C2：GS 上报 `industries`(top-N) + `cargo_totals` + 城镇主货 | 面板数字与游戏内产/运一致；`gsErrors = 0`；三态正确；smoke 有断言 |
| **P2** | C4：GS 内 `GSCargoMonitor` 周期累加 → 上报本公司交付 | 累计量与线路收入趋势方向一致；区间标注正确 |
| **P3** | C3：按需全量（agent 只读工具 + 页面"展开全部"） | 取全量与取样对得上；不增加稳态载荷 |
| **P4** | 车辆明细（C3/C2） | 行数与 GS 车队数一致或明确标注取样 |

每阶段都遵守：**先写会失败的测试**（含 Squirrel 守卫与 D44 重放）、
真机跑一次、`dashboard:smoke` 加断言并**证明它会红**、文档同步。

## 7. 明确不做的事

- 不把"产业利用率"说成 agent 的成绩（口径分块）。
- 不在每帧发全量（产业/车辆会到几十上百条）——只用 top-N + 按需。
- 不在 watch 模式编造产业数据（显示"不可得"）。
- 不解析存档、不读内存、不依赖社区补丁命令。

# 执行器架构：为什么它粗糙，以及怎么做完（2026-09-12）

## 0. 直接回答"为什么不把执行器做完善"

因为**它不是没做完，是选错了架构**。而选错的代价是三个**结构性**缺陷，
靠继续修补 `.nut` 永远补不掉。

`SPEC.md` §10 选了 **Executor AI + 标牌邮箱** 两件套。这个选择的起因是一条约束：

> `SPEC.md` L88：**AI 不能直接收 admin 消息** → 一切外部命令先到 GS，
> GS 转标牌/事件给 executor

一条约束派生出三个永久残疾：

| # | 残疾 | 后果 |
|---|---|---|
| 1 | 外部命令经 **标牌（Tile 上的文本）** 中继给 AI | 没有真正的命令通道；只能传极短的字符串 |
| 2 | AI 只能靠 **公司名** 回报（31 字符上限） | 阶段被压成 `EX rd s0 r0 j100`；**没有结构化反馈、没有错误原因** |
| 3 | AI 是**一次性状态机**（`done` 后永久 idle） | 一局只能建一条公交线；agent 想下新指令也没有通道 |

**我上一轮修的三个 bug（铺路方向、失败无原因、阶段不可读）全都是残疾 2 的症状。**
治症状不等于治病。

---

## 1. 关键发现：那条约束**根本不存在**

`SPEC.md` L355 其实**已经预警过**这件事，但那个 spike 从未做：

> 若 spike 证实 GS 可对 agent 公司施工且与 Executor AI 无冲突
> → **架构可简化为 GS-only（省一个组件）**

### 证据（来自 OpenTTD 官方源码，非推断）

**① GS 可以"像真人一样"操作一个公司** —— `src/script/api/script_companymode.hpp`：

> Class to switch the current company.
> **All actions performed within the scope of this mode, will be executed on behalf
> of the company you switched to. This includes any costs attached to the action
> performed. If the company does not have the funds the action will be aborted.
> In other words, this is like the real player is executing the commands.**

这正是项目要的东西：**agent 花钱、agent 施工、资金不足就失败**——与真人完全同构。

**② GS 的施工 API 与 AI 完全同源** —— 同一批头文件，`@api ai game` 标注表示
**AI 与 GS 都能用**：

| 文件 | 标注 | 关键函数 |
|---|---|---|
| `script_road.hpp` | `@api ai game` | `BuildRoad` / `BuildRoadFull` / `BuildRoadDepot` / `BuildRoadStation` / `BuildDriveThroughRoadStation` |
| `script_vehicle.hpp` | `@api ai game` | `BuildVehicle` / `BuildVehicleWithRefit` / `CloneVehicle` |
| `script_station.hpp` | `@api ai game` | `BuildStation` 系列 |

**结论：Executor AI 能做的每一件事，GS 在 company mode 下都能做。
因此 Executor AI 是一个可以删掉的组件。**

验证方式（可复现）：
```bash
curl -s https://raw.githubusercontent.com/OpenTTD/OpenTTD/master/src/script/api/script_companymode.hpp
curl -s https://raw.githubusercontent.com/OpenTTD/OpenTTD/master/src/script/api/script_road.hpp     | grep -B2 BuildRoad
curl -s https://raw.githubusercontent.com/OpenTTD/OpenTTD/master/src/script/api/script_vehicle.hpp  | grep -B2 BuildVehicle
```
本机 OpenTTD 15.0 二进制中含 `GSCompanyMode` / `GSRoad` / `GSRoadTypeList`
符号，与该 API 表面一致。

---

## 2. 删掉 Executor AI 之后，三个残疾同时消失

| 残疾 | GS-only 之后 |
|---|---|
| 命令经标牌中继 | **不需要**：GS 本来就通过 `ScriptEventAdminPort` 直接收 admin 消息 |
| 只能靠 31 字符公司名回报 | **不需要**：GS 用 `GSAdmin.Send(json)` 直接向 admin port 发**结构化 JSON** —— 与接收同一条通道，全双工 |
| 一次性状态机 | **不需要**：GS 常驻，任何时候都能接新命令，可以同时维护多条线路 |

顺带解决了我上一轮只能"治症状"的两件事：
- 阶段不再是电报体 —— 直接发结构化状态（`{stage:"road", segment:3, remaining:18, blockedBy:"slope"}`）
- 失败**结构化成字段**，而不是塞进 31 字符里截断

---

## 3. 还有一个更根本的"半成品"问题：**动作面太窄**

即使执行器完美，agent 现在也只有 4 个工具：

```
observe · build_bus_route · add_vehicles · set_pause
```

真人玩家能做的远不止这些。**"agent 无法像真人一样操作"的主因在这里，
不在施工代码里** —— 它反复要车，是因为在它能触及的动作里那是唯一看起来有用的事。

补齐后的动作面（按"真人会用到的操作"枚举，全部经 GS company mode 执行）：

| 类别 | 动作 |
|---|---|
| **观察** | 看地形/坡度、看某站候客量与货种、看车辆位置与载货、看某线路盈亏、看竞争对手 |
| **建设** | 修路（点对点/沿路）、建站（含改向/扩站）、建车库、建桥/隧道、平整土地、拆除 |
| **运营** | 买车（按引擎/载具类型）、克隆车、改编组、设/改订单、卖车、开关线路 |
| **财务** | 贷款/还款、查看可购引擎与价格 |
| **铁路/货运** | 铺轨、建信号、建火车站、货运线（M4 目标） |

每一个动作的返回都必须是**结构化结果 + 失败原因**（`SPEC.md` §10.20 的原则：
一个永远说"成功"的工具会摧毁 agent 的学习能力）。

---

## 4. 实施计划

### 阶段一：**可行性 spike**（小，必须先做）
`SPEC.md` L355 要求但从未做的那一步。

- 在现有 Bridge GS 里临时加一个 `GSCompanyMode(0)` 作用域，尝试：
  1. `GSRoad.BuildRoad(t1, t2)`
  2. `GSRoad.BuildRoadStation(...)` + `GSRoad.BuildRoadDepot(...)`
  3. `GSVehicle.BuildVehicle(depot, engine)` + `GSOrder`
  4. 用 `GSAdmin.Send` 发回 `{ok, money, err}`
- **验收**：agent 公司名下真的出现 1 段路 + 1 站 + 1 辆车，且公司账上扣了钱；
  admin port 收到结构化 JSON。**用真机跑，不看代码推断。**

> 这一步不能跳。`GSCompanyMode` 的文档说"像真人一样"，但**文档没说**
> 它是否受每 tick 指令数限制、是否与现有 GS 逻辑冲突、macOS dedicated 下是否可用。
> 这些只能实测。

**阶段一已尝试，并已得到一个负面结果（2026-09-12）**：

1. 已在 Bridge GS 里实现 `probe_cm`（company mode 下试建 1 格路 + 查可购引擎 + 回报 JSON）。
2. 用**第二个 admin 客户端**发这条命令 → 客户端连上了、命令发出了，
   **但 GS 从未收到**（GS 侧无任何反应，日志无输出）。
3. 因此把探针改成 **GS 启动时自触发**，绕开"第二个 admin 客户端能否给 GS 发消息"这个问题。
4. 该改动一度把 `Dispatch` 的结构改坏（多次字符串替换级联出错），
   **已整体回退**。GS 当前处于未改动的正确状态。

**下一步（阶段一继续）**：按第 3 点的设计重做——把探针作为 GS 启动时的一次性自检，
用一次真机 run 读它的输出。这样不依赖第二条 admin 连接。

**顺带得到的事实（记入 SPEC §10.24）**：第二个 admin 客户端发出的
GameScript 消息**不会**被 `ScriptEventAdminPort` 收到。这本身对
"外部工具能否旁路观察/控制"很重要。

### 阶段二：把执行器搬进 GS
- 把 `main.nut` 的状态机逻辑移植成 GS 模块（施工顺序不变，通道换掉）
- 状态改为 `GSAdmin.Send(json)` 结构化上报
- 保留 `PhaseRoad` 那套分段探测（`Pathfinder.Road` 在 GS 下同样可用；
  长距离单次搜索会死锁 —— 这个实测事实要保留）

### 阶段三：删除 Executor AI 与标牌邮箱
- 删 `src/game/squirrel/executor-ai/`、标牌协议、GS↔AI 中继
- `src/game/executor-status.ts` 保留（解码器仍有用于兼容/日志），
  但 agent 直接拿结构化字段，不再需要解码电报体

### 阶段四：扩动作面
按 §3 的表逐类补齐工具，每类都带结构化失败原因。

---

## 5. 风险与未证实项（诚实列表）

| 项 | 状态 |
|---|---|
| GS 能否在 company mode 下施工 | **源码层面已证实**（`@api ai game` + company mode 语义）；**真机未验证** |
| 每 tick 指令上限 | **未查证**。AI 与 GS 共享同一套限制，所以**不构成选 AI 的理由**，但影响施工速度 |
| 与现有 Bridge GS 逻辑是否冲突 | 未验证（阶段一 spike 的验收项之一） |
| **第二个 admin 客户端能否给 GS 发命令** | **已证实：不能**（2026-09-12 实测）。探针必须由 GS 自触发 |
| macOS dedicated 下的行为 | 未验证。已知 `AILog` 在 macOS .app 会被丢弃（SPEC §10.10），
若 `GSAdmin.Send` 也受影响，需要退回 `GSSign` 中继 —— **这正是阶段一必须真机跑的原因** |
| 删掉 Executor AI 的工作量 | 中等：约 880 行 Squirrel 需要移植，加工具层重写 |

---

## 6. 结论

**"执行器卡在原始粗糙阶段"的根因是架构选择，不是实现不完整。**
那条逼出标牌邮箱的约束（"AI 不能收 admin 消息"）在选择 GS-only 方案后**不存在**。

建议顺序：**先做阶段一 spike（真机，小），证实后再动阶段二～四。**
在 spike 出结果之前，我不会声称这项改造可行 —— 文档证据很强，但
`GSAdmin.Send` 在 macOS dedicated 下是否可用这类问题，只有真机能回答。

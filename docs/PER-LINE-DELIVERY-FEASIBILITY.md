# 逐线路交付：可行性调研（2026-11-05）

> 目的：回答所有者的问题——**"逐线路交付"能不能做，要不要换引擎 / 换脚本语言？**
> 结论先行：**不用换引擎，也不用换脚本语言。** 我们此前"引擎不提供"的判断是**误判**，
> 错在我们自己的代码（下面第 3 节有证据链）。
> 事实来源：OpenTTD **15.3** 源码（tag `15.3`，`14ec60f`）＋本机 Steam 15.3 二进制真机实测。
> 边界：本文只回答"能不能测、怎么测"，**不决定**要不要实现（那是下一个 PR 的事）。

---

## 1. 结论（三句话）

1. **按城镇 / 按产业的交付量：现在的引擎 + 现在的 Squirrel 就能测。**
   `GSCargoMonitor.GetTownDeliveryAmount` / `GetIndustryDeliveryAmount` **在 Squirrel 里存在**
   （真机实测：类存在、调用成功、无异常）。
2. **按线路（route）的交付量：任何脚本 API 都不提供**——15.3 的脚本 API 里**根本没有**
   "车站累计货物"这种函数（`GetCargoTotal` 在整个 API 里不存在）。所以逐线路只能是
   **我们自己推导**（用路线台账 + 城镇/产业读数，并写明归因边界），**不是换引擎能换来的**。
3. **换引擎 / 换脚本语言解决不了第 2 条**：原生 Script API（AI，C++）提供的是**同一个**
   cargo monitor（按城镇 / 按产业），没有更多。真要引擎原生逐线路，只能**改引擎（fork）**。

---

## 2. 引擎侧到底记了什么

| 粒度 | 引擎记不记 | 脚本 API 能读到吗 |
|---|---|---|
| 公司 × 货种 | ✅ `cur_economy.delivered_cargo[cargo]`（含客运） | ❌ admin 只给**求和**；`GetCargoTotal` 不存在 |
| 公司 × 货种 × **城镇** | ✅ `CargoMonitor`（`src/cargomonitor.h`） | ✅ `GSCargoMonitor.GetTownDeliveryAmount` |
| 公司 × 货种 × **产业** | ✅ 同上 | ✅ `GSCargoMonitor.GetIndustryDeliveryAmount` |
| **车站**累计收货 | ✅ 引擎内部有（`station->goods`） | ❌ **API 里没有这个函数** |
| **车辆 / 线路** | ❌ 引擎**不记** | ❌ |

来源：
- `src/script/api/script_cargomonitor.hpp`（`@api game` ⇒ **GS 侧也导出**），
  `GetTownDeliveryAmount` / `GetIndustryDeliveryAmount` / `GetTownPickupAmount` / `GetIndustryPickupAmount`。
- `src/script/api/script_cargomonitor.cpp`：实现只有城镇 / 产业两档，**没有车站 / 车辆档**。
- `grep -rn "GetCargoTotal" src/script/api/` ⇒ **零命中**（整个脚本 API 没有"车站累计货物"）。

### monitor 的语义（必须知道，否则会读错）
官方注释（`script_cargomonitor.hpp`）：
> 第一次调用 `GetIndustryDeliveryAmount(..., keep_monitoring=true)` 之后，引擎开始累计；
> 之后每次调用返回**自上次调用以来**的累计量，并**把计数清零**。
⇒ ① 读数是**增量**，累计要自己做；② `keep_monitoring=false` 会**静默丢掉**中间那段；
③ 只统计**货运**（monitor 不管客运）。

---

## 3. 为什么我们此前以为"引擎不提供"（误判的证据链）

2026-11-01 的结论写进了 SPEC §10.65 / MEMORY D89 / 守卫测试的 `KNOWN_BAD_CALLS`：
> "OpenTTD 15.3 的 Squirrel API 没有 cargo monitor —— 调用不报错，只返回 null。"

**这条结论是错的。** 三条证据：

1. **源码**：`script_cargomonitor.hpp` 的类注释写着 `@api game` ⇒ Squirrel 侧**生成**
   `GSCargoMonitor`（CMake 用同一份 `script_*.hpp` 生成 `ai/AI`、`game/GS`、`template/Template`
   三套，见 `cmake/scripts/SquirrelExport.cmake`；`@api` 标签决定进哪一套）。
2. **真机实测**（2026-11-05，隔离 data dir + 隔离端口，本机 Steam 15.3 二进制）：
   在 Bridge GS 的心跳里临时探针（用完即删）得到：
   ```json
   {"cm_class": true, "cm_town": 0, "cm_industry": 0, "loan_max": true}
   ```
   ⇒ **类存在、方法存在、调用成功、返回 0**（当时确实还没有任何货运交付 ⇒ 0 是对的）。
3. **我们自己的代码才是凶手**：被删掉的那段实现（PR #65 的 diff）长这样：
   ```nut
   this._own_cargo_total = {};                       // 空表
   ...
   this._own_cargo_total[label] = prev + amt;        // ← 往不存在的键里写
   ```
   **Squirrel 的表是严格的**：给不存在的键赋值会抛 `the index 'LVST' does not exist`
   ⇒ `CollectFacts` 整个函数抛异常 ⇒ 事实表**永远没更新** ⇒ 拆分"永远是空的"。
   而"永远是空的"正好长得像"这个 API 返回 null" ⇒ 我们据此**判了引擎的死刑**。
   （这正是 MEMORY **D44** 记的那条："Squirrel 里条件创建表键是最容易出事的写法"，
   以及 D89 的那条："调用没报错 ≠ 调用有效"——这里还要再加一句：**空结果 ≠ API 不存在**。）

**同一个坑今天又踩了一次**（本次调研的第一版探针）：
```nut
local probe = {};                    // 空表
probe.cm_class = ...;                // ← 同样的错
```
⇒ 报 `the index 'cm_class' does not exist`，而且**catch 块里再写一次同样的键**，
于是连 catch 都救不回来 ⇒ 脚本报错停摆。
**修法**：要么用**字面量**把键先建出来（`{ cm_class = null, ... }`），
要么用**数组**累加（`acc.append({ label = ..., amount = ... })`）——本仓库的 GS 一律用后者。

---

## 4. 那"逐线路"到底能不能做

### 4.1 不能直接测的部分
引擎**不记**"哪辆车把哪批货送进了哪个站"，脚本 API 也**没有**车站累计货物的函数
（`GetCargoTotal` 不存在）。所以**"我的 101 线交付了 N"这种口径，引擎给不出来**。

### 4.2 能自己推导的部分（可选实现，附归因规则）
我们**自己**知道每条线路服务哪些城镇/车站（`route-facts.ts` 的路线台账 + GS 的
`RegisterRoute`），所以可以按下面的规则把 monitor 的读数**归因**到线路：

| 情况 | 归因 | 口径写法 |
|---|---|---|
| 某城镇只被**我们的一条**线路服务 | 该城镇的交付量归这条线 | `deliveredByRoute[line] += monitor(town)` |
| 某城镇被**多条**线路服务 | **不可分摊** | 记 `null` + 写明"该城镇由 N 条线路共用" |
| 交付去了**产业**（不是城镇） | 同上，按产业归属 | 同上 |

⚠️ 这条规则要**写进契约**再实现：口径是**推导值**，不是引擎读数，必须在页面与报告里
标明"归因规则"（哪个城镇唯一归属、多线路城镇不计入）。

### 4.3 换引擎 / 换脚本语言的代价（如果真要引擎原生逐线路）
- **换脚本语言（Squirrel → 原生 AI/C++）**：**不解决问题**——原生 API 的 cargo monitor
  和 Squirrel 是**同一套**（同一份 `script_cargomonitor.cpp`），粒度一样（城镇 / 产业）。
  代价却很大：GS 全部重写 + 编译链 + 每次改代码要重新编译（仓库现在**没有**构建链）。
- **换引擎（fork OpenTTD）**：才能让引擎记"每站 / 每车的交付"，但那是**长期分叉**：
  每次升级都要 rebase，且我们的分数口径会绑死在 fork 上。**代价与收益不成比例。**
- **推荐**：4.2 的推导规则。**不换**。

---

## 5. 还差的一块证据（诚实记账）

本次调研**没有**拿到 monitor 的**非零**读数，原因是**环境限制**，不是 API 限制：

- 本机唯一能离线跑的 provider 是 `--offline-demo`（faux），它的剧本只建**客运**线路
  ⇒ 没有货运交付 ⇒ monitor 恒为 0（**客运本来就不在 monitor 的口径里**）。
- 临时把 GS 的车辆改成**货运**（`CC_BULK`）再跑：线路建成了，但**该线路的车站没有散货可运**
  ⇒ 依然 0 交付 ⇒ 反而把原来那条客运线路的交付也弄没了。
- 真实模型跑（seed 4242，300 游戏日，`deliveredRun = 2759`）：**交付确实发生了**，但 monitor 仍是 0
  ⇒ 因为那条线路是**客运**线路（`build_bus_route` + GS 的 `PhaseBus` 只建客运车），
  而 **monitor 只统计货运** ⇒ 0 是**正确**的读数，不是 API 不工作。
  **顺带查出一条更结构性的事实**：我们这套脚手架**只能跑客运**（工具叫 `build_bus_route`，
  GS 的 `PhaseBus` 写死 `CC_PASSENGERS`）⇒ **公司永远不运货** ⇒ 货运口径的数在当前脚手架下
  **恒为 0**（是"真的 0"，不是"没测到"）。要让货运数字有意义，得先让脚手架能建**货运线路**。

⇒ **下一步（实现 PR）必须自己拿到非零读数**：用一个**真的运货**的线路（模型建货运线路，
或给 demo 加一条货运剧本）跑一局，确认 monitor 的读数 > 0，**并**与 admin 的
`deliveredCargo` 求和做**交叉核对**（monitor 是"卸到城镇/产业站"的量，admin 是"被接受量"，
**口径不同、不能相等**，只能做量级对照）。
**在拿到非零读数之前，"按货种拆分"仍然是"没测到"**（`null`），不得折成 0。

---

## 6. 给所有者的建议（**不换引擎**）

1. **修我们自己的累加器**（数组，不是动态键的表）—— 这是当初"引擎不提供"的真凶。
2. **让脚手架能建货运线路**（GS 按车站上的货选车：散货→卡车、牲畜→厢式车……）——
   否则货运口径永远是 0，"货物 vs 客运"的拆分没有意义。
3. **逐线路 = 推导**，规则写进契约（唯一服务的城镇归那条线；多线路城镇不计入）。
4. **不换引擎、不换脚本语言**：原生 API 给不了更多（§4.3），fork 的代价与收益不成比例。

## 7. 与既有记录的关系（要改的地方）

| 记录 | 现在写的 | 应改成 |
|---|---|---|
| SPEC §10.65 | "引擎不提供 cargo monitor，拆分不可测" | **纠正**：Squirrel **有** cargo monitor（城镇 / 产业粒度）；不可测的是**逐车站 / 逐线路** |
| MEMORY D89 | "API 不存在时它返回 null" | 保留，但补上本次的**误判**与真因（我们自己的严格表写入） |
| `squirrel-api-guard` 的 `KNOWN_BAD_CALLS` | 登记了 `GSCargoMonitor.` | **删除该条**（API 有效）；改为**新守卫**：monitor 的累加器不许用"动态键的表" |
| `docs/SCAFFOLD-CONTRACT.md` §9.2 的 S7b | "引擎限制" | 改成"**可测（城镇/产业）+ 逐线路需推导**" |
| 分数口径 | `cargoDelivered` / `passengersDelivered` 恒为 `null` | **暂时不变**（等非零读数）；实现 PR 才改成真实值 |

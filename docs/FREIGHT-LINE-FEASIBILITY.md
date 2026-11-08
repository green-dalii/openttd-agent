# 货运线路可行性调研（Freight Line Feasibility）

> **职责**：回答一个问题 —— **脚手架能不能建出真正在运货的货运线路**，以及要改什么。
> **不含**：脚手架契约（→ [`SCAFFOLD-CONTRACT.md`](SCAFFOLD-CONTRACT.md)）；进度（→ `ROADMAP.md`）；
> 逐线路交付的推导规则（→ [`PER-LINE-DELIVERY-FEASIBILITY.md`](PER-LINE-DELIVERY-FEASIBILITY.md)）。
>
> 调研日期：2026-11-05。证据来源：OpenTTD 15.3 源码（`/tmp/ottd-src`，tag `15.3`，commit `14ec60f`）
> + 真机探针（隔离 data dir `/tmp/pFreight`，admin 3991 / game 3993，seed 4242，脚本包
> `.scratch/freight-probe/`；用完删除，不进仓库）。
>
> **2026-11-08 纠正（货运 F3 的真机证据）**：本文档 §0.2 / §1.1 / §2.2(a) 的
> **"车站不收货 ⇒ 产方不交货"** 是**错的**：产业交货看的是车站的 **rating**
> （`CanMoveGoodsToStation`：`rating == 0` 才拒收，新车站的 rating 是 175）⇒
> **车站不收这个货，产业照样把货送到站上等着**；车**卸货**才看收货（不收 ⇒ 退回）。
> 另：**集货半径是 3**（15.3 默认开着 modified_catchment ⇒ `CA_TRUCK = 3`；
> `CA_UNMODIFIED` 才是 4）。真机：煤矿 28 → 电站 53 交付 5 吨煤（见 `SPEC.md` §10.126）。

---

## 0. 结论（先看这段）

1. **能，而且不用换引擎、不用换脚本语言** —— 15.3 的 Squirrel API 有全套货运零件（建站、买车、
   改装、挂路线、计量）。与逐线路交付那份调研的结论一致：**原生 API 到此为止**。
2. **"矿场旁的站不收煤 ⇒ 煤运不走"是错的（2026-11-08 纠正）**：**交货**看车站的
   **rating**（新车站 175 ⇒ 照送），**卸货**才看**收货**（不收 ⇒ 货被退回）。⇒
   **装货站只要罩住产方；卸货站必须收货 >= 8**（它罩住收方即可）。这是引擎规则，不是我们的选择。
3. **观测面缺一块关键事实**：现在只报产业的"产了多少 / 运了多少 / 库存"，**不报"它收什么货"** ——
   模型因此**无法规划任何一条货运线路**。这是第一件要补的事。
4. **计量面**：cargo monitor 存在但**从未接上**；它是**增量**口径（读一次清零），且**城镇轴与产业轴
   会把同一笔交付记两次** ⇒ 只能取一个轴。接上它，"货物 vs 客运"的拆分才第一次可测。
5. **铺路不要重写**：探针自己重写的铺路逻辑在 97 格链上留了 **40 个断口**；执行器里那套
   `LayPath`（桥/隧 + 一拍一段 + "还在施工"重试）是真机验过的 ⇒ **实现必须复用它**。

---

## 1. 引擎的货运规则（15.3 源码事实）

### 1.1 车站的"收什么货"是自动算的，而且按**产业收什么**算

- `src/station_cmd.cpp:589` `GetAcceptanceAroundStation(st)` ⇒ 遍历车站的**集货区瓦片**
  （`st->catchment_tiles` = 车站矩形 + 集货半径 `CA_UNMODIFIED = 3`），
  对每格调用 `AddAcceptedCargo`。
- `src/industry_cmd.cpp:412` `AddAcceptedCargo_Industry` ⇒ 用的是产业 tile spec 的
  **`accepts_cargo`**（这个产业**收**哪些货），不是它**产**哪些货。
- 产业 tile 定义（`src/table/build_industry.h`）：

  | 产业 | `accepts_cargo` | 含义 |
  |---|---|---|
  | Coal Mine | `MT(0, CT_INVALID, ...)` | **什么都不收** ⇒ 车站旁边只有煤矿 ⇒ **车站不收煤** |
  | Power Station | `MT(1, CT_PASSENGERS, 8, CT_COAL, ...)` | 收煤（强度 8/8）⇒ 车站旁边有电站 ⇒ **车站收煤** |
  | Factory (temperate) | `MT(8, MCT_GRAIN…, 8, MCT_LIVESTOCK…, 8, CT_STEEL, ...)` | 收粮/畜产/钢 |

- 车站真正"接受"某货种的门槛：`amt >= 8`（`station_cmd.cpp:627`）⇒ **强度必须够**。
  ⚠ **但"接受"只管卸货，不管交货**：交货看的是车站的 **rating**（`CanMoveGoodsToStation`）：
  `rating == 0` 才拒收，而新车站的 rating 是 `INITIAL_STATION_RATING = 175` ⇒
  **车站不收这个货，产业照样把货交到站上**（2026-11-08 真机纠正）。

### 1.2 产业把货交给车站

- `src/industry_cmd.cpp:525` `TransportIndustryGoods` ⇒ `MoveGoodsToStation(cargo, …, i->stations_near, …)`。
- `stations_near` = **集货区覆盖到该产业的车站**（`src/station.cpp:466` `RecomputeCatchment`）。
- `src/station_cmd.cpp:4578` `CanMoveGoodsToStation` ⇒ 货车不能停公交站、货种评分不能为 0。

⇒ **形状**：车站 S 要从煤矿 M 拿到煤，S 的集货区必须同时含 M（产方）与一个**收煤**的产业（消费方）。
⇒ 常见地图上"煤矿 + 电站"本来就是挨着长的 ⇒ 一个车站同时吃两家 ⇒ 这条线才成立。

### 1.3 交付发生在**卸货站**，且计入**该站集货区里的收方产业**

- `src/economy.cpp:1050` `DeliverGoodsToIndustry` ⇒ 遍历 `st->industries_near`（卸货站的集货区），
  逐个收 ⇒ ⇒ **卸货站必须落在收方产业的集货区里**。
- `src/economy.cpp:1112` ⇒ `company->cur_economy.delivered_cargo[cargo_type] += accepted_total`（**按货种**记到公司）。
- `src/economy.cpp:1076` ⇒ 同时写 cargo monitor（城镇轴 + 产业轴，**同一笔记两次**）。

### 1.4 计量口径

| 来源 | 粒度 | 口径 | 陷阱 |
|---|---|---|---|
| admin `ServerCompanyEconomy.deliveredCargo` | 公司 | **所有货种求和**（`network_admin.cpp:392` 用 `GetSum<>`） | 分不出货/客 |
| `GSCompany.GetQuarterlyCargoDelivered(company, quarter)` | 公司 | 同样**求和**（第 2 个参数是**季度号**，不是货种！） | 误读成"按货种"就会写错 |
| `GSCargoMonitor.Get{Town,Industry}DeliveryAmount` | 公司 × 货种 × **城镇/产业** | **增量**（`cargomonitor.cpp:69` 读完清零；`keep_monitoring=false` 连监测一起删） | 漏读一次就丢一段增量；城镇轴与产业轴**同一笔记两次** |

⇒ **"货物 vs 客运"的拆分只有 cargo monitor 能给** ⇒ 必须接上；且**只能取一个轴**（建议产业轴：
交付一定落到某个产业上；城镇轴会把城镇的客运也算进来）。

---

## 2. 真机探针的结果（OpenTTD 15.3，seed 4242）

探针脚本包（一次性，`.scratch/freight-probe/`）跑完了这条链：
**选货种与产业对 → 选站址 → 建两个货车停靠站 → 铺路 → 建公路车库 → 买改装卡车 → 挂路线 → 观察**。

### 2.1 建成的部分

```
[probe] {"step":"pick","cargo":"COAL","producer":28,"producer_name":"Tratborough Coal Mine",
         "consumer":53,"consumer_name":"Lunningville Power Station","distance":20}
[probe] {"step":"stations","ok":true,"st_a":0,"st_b":1,"monitor_town":15}
[probe] {"step":"road","ok":true,"segs":96}
[probe] {"step":"depot","ok":true,"tile":39218}
[probe] {"step":"truck","ok":true,"vehicle":8,"engine":"Balogh Coal Truck","cap":20}
```

⇒ **货车停靠站、公路车库、改装卡车（载 20 吨煤）全部建成** ⇒ API 齐备 ✓。

### 2.2 卡住的地方（两条，都指向设计）

**(a) 车站不收煤 ⇒ 煤矿**仍然**发货（2026-11-08 纠正）。** 探针同时读了两处：

```
{"acc_a":0,  "acc_b":16, "st_around_prod":1, "st_around_cons":1,
 "wait_a":0, "wait_b":0, "veh_load":0, "company_quarter":0}
```

- `acc_a = 0`：车站 A 周围**没有任何产业收煤**（那边只有煤矿）⇒ 车站不接受煤
  （`GSTile.GetCargoAcceptance` 与引擎同一套算法 ✓）。
- `acc_b = 16`：车站 B 旁边有电站（收煤，8/8）⇒ 那里才收煤。
- ⇒ **"车站同时罩住产方与收方"这个推断是错的**（2026-11-08 纠正）：货**照样**从煤矿
  交到站 A（交货看 rating），车把煤拉到电站旁的站 B 卸下（卸货看收货 ⇒ B 罩住电站
  ⇒ 电站收煤 ⇒ 交付成立）。**真机：煤矿 28 → 电站 53（相距 20 格），交付 5 吨。**
  ⇒ 真正缺的不是"一座车站吃两家"，而是**卸货站要落在收方的集货区里**。

**(b) 自己重写的铺路留了断口。** 97 格的链只有 57 格是路（`road_ok=57, first_missing=0`），
⇒ 卡车出不了车库（`veh_loc` 一直是车库格，`veh_state=0` 停住）。
根因：连着铺 ⇒ 后一段撞上"还在施工" ⇒ 拆掉上一段重铺 ⇒ 路上出现断口。
⇒ **执行器里的 `LayPath`（`bridge-gs/main.nut:651`）已经处理了这件事**
（桥/隧 + 一拍一段 + 施工中重试）⇒ **实现必须复用，不要重写**。

### 2.3 探针本身踩到的两个坑（值得记住）

- **GS 的 `Start()` 必须挂起**：直接 `return` ⇒ 引擎判定"脚本死了"（日志
  `The script died unexpectedly.`），**没有任何错误信息**（dedicated 模式吞掉了脚本错误）。
  与 `bridge-gs` 同款：`Start()` 里死循环 + 每轮 `GSController.Sleep(n)`。
- **`AreRoadTilesConnected` 只对**相邻**两格有效**（`script_road.cpp:114`）⇒
  拿它查"A 到 B 连通吗"永远返回 false ⇒ 别用它做长程连通性判断。

---

## 3. 设计（据此改什么）

### 3.1 观测面（第一优先）

现在产业事实只有 `produced / transported / stock` ⇒ **模型不知道谁收什么货** ⇒
规划不出货运线路。要补：

- 每个产业**收哪些货**（`GSIndustry.IsCargoAccepted(iid, cargo)` ⇒ `CAS_ACCEPTED`）
  —— 现在只有"产什么"（`GSIndustry.GetLastMonthProduction`）。
- 货种清单与标签（`GSCargo.IsFreight` / `GetCargoLabel`）⇒ 模型要能说"运煤"。
- **哪一对是可运的**：车站能不能收这个货，取决于**集货区里有没有收方产业**
  （`GSTile.GetCargoAcceptance(tile, cargo, 1, 1, radius)`）⇒ 这是**世界事实**，
  服务端算好给模型（前端/模型不自己推）。

⇒ 对齐 RL 边界（`docs/RL-HARNESS-SCOPE-AUDIT.md`）：我们只给**事实与可行性**，
**不替模型选货种、不替模型选线路**。

### 3.2 动作面

新增一个动作（与 `build_bus_route` 同级）：`build_freight_route`，参数形如
`{ cargo: "COAL", from: <产业/城镇锚点>, to: <产业/城镇锚点> }`。
**分工**：模型决定**运什么货、运去哪**；脚手架负责**怎么落地**
（找站址 ⇒ 铺路 ⇒ 建车库 ⇒ 买车改装 ⇒ 挂路线）—— 与客运线路同款分工 ✓。

> 站址解析必须**照引擎的规则来**：源站要同时罩住产方与收方，宿站要罩住收方。
> 这不是"策略"，是**可行性的定义**（照 §1.1/§1.3 的规则机械求值）。

### 3.3 计量面

- 接上 cargo monitor：**增量**读数 ⇒ **harness 侧累加**（读一次清零 ⇒ 漏读即丢 ⇒
  与交付计量器同款纪律，`gaps` 要能报）。
- **只取一个轴**（建议产业轴）⇒ 城镇轴与产业轴相加 = 双计。
- 客运/货运的**拆分**由此第一次可测（此前恒为空数组 ⇒ "没测到"，不是 0）。

### 3.4 台账与归因

货运线路也要进路线台账（`src/agent/route-ledger.ts`）：决策 → 线路 → 车 → 交付 ⇒
"这个决策带来的货，真的送到了吗"（与 PR #79 的客运版同构）。

---

## 4. 阶段计划（每个阶段一个 PR）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **F1 观测** | 产业**收什么货** + 货种清单 + "哪一对可运"的世界事实 | 真机：模型看得见"电站收煤" |
| **F2 计量** | cargo monitor 接上（增量累加、单轴） | 真机：客运脚手架下货运读数**仍为 0**（诚实），且 monitor 不为空 |
| **F3 动作** | `build_freight_route`（复用执行器的铺路/车库/车队机制，只参数化站型/货种/引擎） | 真机：**真的交付**，monitor 非 0，公司 `deliveredCargo` 增长 ✅（2026-11-08：煤矿 28 → 电站 53，**5 吨**） |
| **F4 归因** | 货运线路进台账 → 决策→结果；Compare 增加货运轴 | 真机：History 能说"这条决策运了多少货" |

⚠ **每一步都会动脚手架指纹**（工具表/提示词/观测面变了就变）⇒ 基准局会**分组**，
Compare 按组比（PR #76 已实现）⇒ 结论里必须写清分组。

---

## 5. 明确不做的事

- **不换引擎、不换脚本语言**（同逐线路调研的结论）：原生 API 的粒度就是这些。
- **不做逐线路交付量**（引擎不记；只能用自有台账推导，见逐线路调研）。
- **不替模型选货种/选线路**（RL 边界）。
- **不把"客运 + 货运"合成一个数当主轴**：主轴口径保持"货物 + 客运交付"，拆分另算。

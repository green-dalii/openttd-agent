# ROADMAP — OpenTTD LLM Agent Framework

> **本文件只收录「未完成的进度与计划」**：里程碑状态、下一步做什么、验收标准。
>
> **不收录**（按 `AGENTS.md` §9 的文档职责表，冲突以该表为准）：
> - 各版本**已经做了什么** → `CHANGELOG.md`（唯一权威）
> - 开发准则 / 铁律 / 提交卫生 → `AGENTS.md`
> - 系统事实与协议细节 → `SPEC.md`、`docs/`
> - 踩过的坑与教训 → `MEMORY.md`
> - **已完成阶段的过程叙述**（旧的 A/B 记录、冻结判定、完成史）→ `CHANGELOG.md` 与
>   `SPEC.md` §10.x；本文件只留指针，不再复述。
>
> 2026-10-23 瘦身：按 `AGENTS.md` §9.2 删除了本文件中的历史章节（约 450 行），
> 内容全部保留在 `CHANGELOG.md` / `SPEC.md` / `MEMORY.md`（见各节指针）。

---

## 里程碑（SPEC §9）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 环境钉死（二进制 / 隔离 data dir / admin auth） | ✅ |
| **M1** | 观测闭环（规范事件 + Web 仪表盘） | ✅ |
| **M2** | 最小决策闭环（bridge GS + executor + Pi Agent 决策） | ✅ |
| **M3** | 进化闭环（局终结算 + 反思 + lessons + 注入下局 + 对比图） | 🔵 引擎完成；**记忆无收益**是当前唯一有效对照结论（`SPEC.md` §10.43） |
| **M4** | 打磨（策略库 / replay / 自愈 / 多模型基线） | ⬜ 并入阶段 D |

## 进度速览

每版一行，细节一律去 `CHANGELOG.md`（本文件不列版本清单——那是变更日志的职责）。

---

## 🔵 当前阶段：阶段 D —— scaffold 成熟化 + 模型基准评测模式

> **契约正文（唯一权威）：`docs/SCAFFOLD-CONTRACT.md`**；执行清单：GitHub Issue #1
> （跟踪）与 #2–#13（逐项）。
> 所有者定调（2026-10-08）：**同一套脚手架，两种模式**——A 单机游玩（接任意 pi-ai
> 模型玩一局，不是评测）、B 模型基准评测（固定世界下比较不同模型）。两种模式的
> **共用内核必须逐字相同**（提示词、工具、观测面、反馈面、协议），否则"基准"测的
> 是脚手架差异而不是模型能力。
> **先把 scaffold 打磨到足够优秀（信号足、反馈全、优雅不冗余），再做评测面。**

| 阶段 | 做什么 | 验收 | 状态 |
|---|---|---|---|
| **D0** | 契约文档 + 文档地图 + 执行清单落成 Issue | `docs/SCAFFOLD-CONTRACT.md` + `docs/README.md` + 登记守卫；Issue #1–#13 | ✅ |
| **D1** | **脚手架信号缺口**：S1 自身分数可见、S3 增量不折零、S5 历局成绩注入 | 真机打印 `score` 块且与度量同值；缺读数为 `null`；注入含历局每游戏日交付 | ✅（`SPEC.md` §10.114） |
| **D2** | **脚手架降噪**：S2 同一事实多套实现 → **唯一 canonical 投影**（上下文与 `observe()` 同源同序；transcript 不留第二份全量状态） | 上下文与 `observe()` 同字段同序（单测）；真机实测 observe() -17.4%、prompt +0.8%（新增 loan） | ✅（`SPEC.md` §10.114） |
| **D3a** | **反馈成对（连接点）**：S4 相位→`job`→**订下它的动作**（GS ack 为唯一真源，run 级连接） | 真机：相位事实带 `job` + `action`（实测 payload） | ✅（`SPEC.md` §10.114） |
| **D3b** | **run manifest + 结果分类**：S9 served model / 旋钮 / 脚手架指纹；S8 0 分必带成因（派生不存盘） | 度量行含 manifest（真机实测）；0 分记录经分类得具名成因 | ✅（`SPEC.md` §10.114） |
| **D4** | **旋钮与成熟度**：S6 思考档位 / 工具预算 / provider 进 CLI+config；S9 脚手架指纹（D3b 已落地） | 真机：`--thinking low --tool-budget 5` 生效并进 manifest；非法值报错 | ✅（`SPEC.md` §10.114） |
| **D5** | **评测面**：矩阵规划（每格独立目录 + 预登记闸）/ 四轴分数卡 / 配对统计 / JSON+MD 报告 | 真机 2×1×1 矩阵跑通并出报告；预登记双向自证（拒绝/放行） | ✅（`SPEC.md` §10.114） |
| ~~D6c~~ | 全量替换自研 `session-store`/`telemetry` | **否决**：对可比性零增益、回归面覆盖 5 页 + E2E | ❌ |
| **D6d** | 反事实 fork（同存档同决策点换模型） | **机制已核实**（`-g savegame` + 控制台 `save` + GS 状态随存档存取 ⇒ 不用新写 GS）⇒ 剩下的是**确定性探针**（同一存档读两次 ⇒ 同一资金轨迹）；探针通过后才谈换模型 | ⏸（探针列为待办 #3） |
| **F4** | **货运归因**：GS 逐 (货种,产业) 读数 → 台账装得下"产业对" → Compare/History 货运轴 | History 能说"这条决策运了多少货"；Compare 画出货物/客运拆分 | ✅（`SPEC.md` §10.126；Issue #13） |
| **P3** | 卫生：删 `v02-runner` 死代码（380 行）、DOM churn 降噪（12.5k/s 实测）、orphan 规则修、`AdminProbeClient` 审查 | gate 绿；DOM churn 显著下降并实测 | ⬜ |

**D6 的方案（唯一权威）**：`docs/HARNESS-MIGRATION.md`（含已核实的库事实与三条不变量）。

**依赖与顺序**：D1–D4 是**共用内核**（两种模式都受益），必须先于 D5；D6 与 D1–D5
可并行但每步独立提交。S7（世界事实补洞）是 D1 的后续（#13）：城镇名 / 融资 / 推送事件 /
L2 查询 / 决策→结果台账 / 逐线路调研 **已做**；**只剩货运线路**（观测 ✅ → 计量 → 动作 →
归因，见 `docs/FREIGHT-LINE-FEASIBILITY.md` §4）。

**D1 的补洞清单**（源自契约 §5：信号源盘点里"未用"的通道，Issue #13）——现状：L2 查询工具族
✅（`inspect_town` / `inspect_vehicle`）、决策→结果账本 ✅、GSEvent 推送族 ✅（封闭词表七类）；
**仍欠**：`company_expenses` 分类账（年度收支归因）、逐线交付量（引擎无此粒度 ⇒ 只能用自有
台账推导，见 `docs/PER-LINE-DELIVERY-FEASIBILITY.md`）。

**明确不做**：不在脚手架未成熟前堆评测面；不因"模型清单未定"而阻塞脚手架
（模型走 pi-ai 目录，评测时再指定）；不用 LLM 裁判打分；不把策略写进脚手架。

---

## 待办（未完成，按可执行性排序）

| # | 事 | 验收 | 位置 |
|---|---|---|---|
| 0 | **B 基准决策与新矩阵**（Issue #1）：**当前脚手架上的矩阵已跑完**（2026-11-10，`d89a898b6d575e4a`；2 模型 × 3 seed × 250 日，6/6 成功）。结论按轴：**能力轴与货运轴都 `not determinable`**（交付/游戏日配对差 -1.364，95% CI [-4.335, 0.837]；货运/游戏日 -0.125，CI [-0.769, 0.393]，n=3，**未预登记**）⇒ 两个模型**分不开**（方差来自种子：M2.5 有一局什么都没建）；**效率轴**可判定（M3.1-Flash 每决策多花 **+105991 tokens**，CI [100637, 114751]）；**稳定性轴**可判定（M3.1-Flash 的工具失败率 **+3.9pp**，CI [2.0pp, 6.7pp]）。⇒ 下一步要么**预登记**效应量/CV 再按 `requiredSampleSize()` 跑够局数，要么**换更窄的问题**（货运轴的方差仍由"建没建线"主导）⇒ 两条路都压在待办 #1–#3 上面（口径、可算的经济性、可配对的世界） | 选定轴的配对 CI 不含 0，或写明 n 与「不可判定」 | SPEC §10.126 / Issue #1 |
| 1 | **P0 口径修正（前置，其余都压在它上面）**。**(a) 时间模型：已做**（2026-11-11，PR #110）—— harness 的时钟换成**引擎的日历**（唯一实现 `src/game/calendar.ts`），六处虚构的 360 天年投影、季度推算、线路年内天数全改完，守卫 `test/unit/calendar-guard.test.ts`。**(b) 读数：已做**（2026-11-11，PR #111）—— 收益读数 = **本局净现金流（`money − loan`）÷ 这一局实际经过的游戏日**（`src/game/profit-meter.ts`：按**日历年**分段，**年翻转靠引擎的计数器归零判定**（恒等式 `Δincome == Δ(money − loan)` 在归零处断开，**不靠日期猜**——GS 的时钟可能晚一天），再用引擎自报的整年值**对账**，缺口报差值不折零）；模型可见的 `deliveredPerGameDay` 分母统一成"这一局经过的天数"；归档改用 `stringifyJson` ⇒ **经济读数序列现在真的落盘**（旧局仍不可重算：目录已删 + 归档曾丢事件）；阈值单位写明为"年收入目标 5000"。**公司级运营利润仍缺**（要连续的车队台账：卖出车辆不得清空累计）⇒ 归 #105 | (b) 单测已绿（年翻转积分、闰年、缺口/下界、分母=经过天数、BigInt 落盘）；**真机已对账**（seed 4242、381 日跨过 1951-01-01：1950 段与引擎自报整年值差 0，归档可离线重算）；阈值单位写成"年收入目标" | `SPEC.md` §10.55 / §10.76 / `docs/EVOLUTION.md` §2.2 / MEMORY D115 / D116 / Issue #104 |
| 2 | **P1 收入侧事实**：GS 侧补 **capacity / price / runningCost** 与**货种收入**（`GSCargo.GetCargoIncome`、`GSEngine.GetCapacity/GetPrice/GetRunningCost`；15.3 源码已确认存在，且两个类的标注是 `@api ai game` ⇒ **GS 可调**，仍需真机探针锁定）⇒ `estimate_route` 能算线路经济（每个数字注明 upper/lower bound）⇒ 模型在花钱前知道这条线赚不赚钱 | 真机：模型看到的估计里有收入与成本，且标为估计不是实测 | `SPEC.md` §10.126 / `docs/SCAFFOLD-CONTRACT.md` / Issue #105 |
| 3 | **P5 同存档反事实 fork（探针先行）**：机制已核实（专用服务器 `-g savegame`、控制台 `save`、GS 状态随存档存取）⇒ **不需要新写 GS**。先做**确定性探针**：同一存档读两次、同一时刻发同一命令 ⇒ 同一资金轨迹；探针过了再谈"同存档换模型"的消融 | 探针能证明同存档 ⇒ 同轨迹（或明确指出不可确定性在哪） | `SPEC.md` §10.113 / Issue #106 |
| 4 | **B2 策略库晋升真机证明**（**依赖 P0**）：身份归代码（封闭动作词表 + 白名单参数）与"一局一读数"已就位；门槛是"利润 > 16.67/游戏日 且 **≥2 局**"。**当前门槛不可判定**（读数口径错，见待办 #1）⇒ 先按 P0 重算旧两局，再判断门槛是否可达；剩下的才是"模型能不能赚钱"（不是脚手架） | P0 之后：重算值 + 门槛可达性有明确结论 | `docs/EVOLUTION.md` §2.2 / Issue #104 |
| 5 | **P2-1 / P2-2 实验待跑**：预建场景 + 300 日短局多跑；M4b 选择压力 + M5 学习曲线 | 每小时局数 ≥3×；斜率 CI 或「不可判定」声明 | 需所有者先定**模型与预算**（P2-3 的功效闸会拒绝样本不足的比较） |
| 6 | **未测旋钮**（不得声称已有效果）：`sessionId` 缓存收益、`deliberation off-vs-low` 的质量-成本权衡 | 各跑一次受控对比并报出结论 | D4（旋钮可达后） |
| 7 | **D3(b) UnoCSS CLI 是否放行**（唯一可能划算的形态） | 所有者决定；不放行则保持现状 | `docs/FRONTEND.md` §6.6 |
| 8 | 预提交孤儿符号误报刷屏（25 个/次）淹没真孤儿 —— **2026-10-30 已查清：卡在工具上**（pi-shazam 的项目配置只认 `verify.maxFiles`，没有 ignore 规则；分析器只数**调用**，前端 `window.*` 导出在模板里被调用 ⇒ 假孤儿）。它**不拦提交**（咨询性），故只剩噪声；已记 MEMORY D85 防止误删 | 要么工具支持 ignore，要么接受噪声 | P3（等工具） |

**实验与真机约束**（细节见 `MEMORY.md`）：隔离 data dir 与端口（`/tmp/pXX`、admin `3991`、
game `3993`、web `8198`）；**不跑宽泛 pkill**；实验期间不跑 gate（D5）；block 期间不改 `src/`（D12）。

---

## 已知的环境事实

- 凭证/remote/清理/门禁等易变事实**不在本文件**：见 `MEMORY.md` §0 与
  `docs/STARTUP-AND-LIFECYCLE.md`（本文件曾复制一份，重复即漂移——2026-11-08 删除）。
- 本地测试 serve（8187）默认数据目录 `/tmp/openttd-agent-data`；其中的 demo 局是**旧代码**
  跑的贪心线路，不代表当前能力（新证据一律用隔离目录的局）。

---

## 🔴 COMPACT 后从这里接续（2026-11-10）

> 给"compact 后的我自己"的恢复手册。**按顺序做，不必重新推导**。

### 1. 现在有什么在跑？

```bash
pgrep -fl "bench.ts|run-experiment|cli/run.ts|llm-stub|OpenTTD.app"
```

无输出 = 没有实验。**不要**用宽泛 `pkill -f openttd`；收尾用
`lsof -nP -iTCP:<port>` 确认端口为空。

### 2. 下一步做什么？

| 顺序 | 内容 | 验收 | 权威位置 |
|---|---|---|---|
| **1** | **P0 口径修正**：(a) 时钟 = 引擎日历（PR #110，已做）；(b) 读数 = 本局净现金流 ÷ 这一局经过的游戏日 + 分段对账 + 读数落盘（PR #111，已做）；**剩下的**：公司级**运营利润**（连续车队台账）⇒ 归 #105 | 新口径有单测 + 真机跨年对账（跑数中）；阈值单位明确（已做） | 本文件「待办」#1 / SPEC §10.55 / §10.76 / MEMORY D115–D118 |
| **2** | **P1 收入侧事实**：GS 补 capacity/price/runningCost + 货种收入（源码已确认可调，需真机探针）⇒ 模型花钱前能算线路经济 | 真机：估计里有收入与成本 | 本文件「待办」#2 / SPEC §10.126 |
| **3** | **P5 同存档 fork 的确定性探针**：`-g savegame` + `save` + GS 状态随存档存取 ⇒ 不用新写 GS；先证"同一存档 ⇒ 同一轨迹" | 探针能证明同存档 ⇒ 同轨迹 | 本文件「待办」#3 / SPEC §10.113 |
| **4** | **B2 策略晋升**（依赖 P0）与 **B 基准决策**（Issue #1：能力/货运轴 `not determinable`；效率与稳定性轴可判定） | 门槛可达性有明确结论；选定轴的 CI 或写明 n 与「不可判定」 | 本文件「待办」#4 / #0 |

**每个子步都是独立分支 + PR**（英文 commit、正文 `Part of #N`、squash 合并），顺序即上面的 1。
**A 阶段可全程离线**：F4 的 harness 部分用 `scripts/llm-stub.ts` + 真机 cargo monitor 验收
（不烧 token）；**只有"真实模型能不能自主用好货运线"这类问题需要额度**。

**已完成、不要重做**：阶段 D 的 D0–D5；B1–B6（Dashboard 四页：Run / Compare / History /
Configure）；#13 S7 除货运线路外全部（城镇名 / 融资事实 / 推送事件 / L2 查询 / 决策→结果台账 /
逐线路调研）；货运 **F1 观测 ✅ / F2 计量 ✅ / F3 动作 ✅**（真机：真实模型自己下了 5 条
货运线，交付 **120 吨煤**；engine 事实纠正见 `SPEC.md` §10.126）；**A2 逐轴配对统计 ✅**
（Issue #87：配对只对"逐局能取标量"的轴有意义 ⇒ 能力/效率/稳定性三条，成长轴不进配对；
配对按"局"定，不随轴变 ⇒ 一个轴缺读数只会整格丢掉，不会把两局错配）；**货运 F4 的 A3+A4+A5+A6 ✅**
（GS 报逐 (货种,产业) 增量 + 线路两端产业 id ⇒ harness 归因：唯一服务 ⇒ 归它 / 多线共用 ⇒
`null` + 原因 / 没有线 ⇒ 单独报出来；台账改成**两种线两种记录**，事实行带产业对 + 货种 +
`delivered` ⇒ 注入句不再有 `null` 端点；真机 160 吨煤归到那条线）。
**A2 与 F4 的前置调研结论（2026-11-08，已落 SPEC §10.126）**：① 旧 6 格的**度量行已不在磁盘**
⇒ 聚合数推不出配对 CI（A2 的真正理由）；② GS 的 monitor 累计**只按货种**上报 ⇒ 逐线路归因
缺的是读数不是算法（**A3 已补上这一层**）；③ 台账的形状是"城镇对" ⇒ 货运线硬塞会变
`null/null` 并进模型上下文（**A5 已改成两种记录**）；④ 货运拆分**服务端已算好、页面没画**
（**A6 已接线**：Run 页多一列 Delivered、Compare 页画出货物/客运拆分）。
**i18n 三批 ✅**（Issue #88：静态文案 / 动态字面量 / 服务端词汇按 id）；**数据按需全量 ✅**（Issue #13：
`get_industries`/`get_cargo` + 页面"展开全部"，取样与全量同一扫描）；**退出码语义 ✅**（正常收场=0）；
**货运轴配对指标 ✅**；**基准矩阵自带 credentials 与 models-cache ✅**；**策略晋升闸数局不数采样 ✅**
（PR #102：单局曾能过闸；已修，且模型现在看得见 `build_freight_route`）。
当前指纹：scaffold **`d89a898b6d575e4a`**、观测面 **`103aabed827a8def`**（变了就会分组，Compare 按组比）。

**三条不得违反的不变量**：① harness 默认关（`AGENT_HARNESS=0`）；② harness compaction 必须关；
③ 完成 = `AGENTS.md` §5.1 八条真机断言全绿（单测绿不算）。

**当前阻塞（需所有者）**：**provider 额度已恢复**（2026-11-10 起真实模型局不再 429）⇒ 阶段 B 的矩阵
与策略晋升证明**都能跑**；但晋升门槛**目前不可判定**——它读的 `income / 365` 不是"每游戏日利润"
（见「待办」#1 与 SPEC §10.55）⇒ ⇒ **先修口径，再谈"模型能不能开出一条赚钱的线"**。若要换 key，请顺带轮换待处理的旧 key。

### 3. 环境事实（易变）

**不在本文件**：端口、二进制路径、门禁命令、清理禁则 ⇒ 见 `MEMORY.md` §0 与
`docs/STARTUP-AND-LIFECYCLE.md`。两条最容易踩的：`dashboard:smoke` 默认占 **8899**
（临时服务别占它）；真机实验用隔离目录 `/tmp/pXX` + admin 3991 / game 3993。

### 4. 最近的交接点（2026-11-10）

- `main` = 最新合并的 PR（`git log --oneline -3`）。**不要再在本文引用 commit SHA**——
  一次历史重写就会让它悬空。
- 门禁：`pnpm run gate` = 126 files / 2053 tests（9 skipped）；`shazam_verify` 独立跑（LSP 诊断 +
  broken references + orphan 复核：前端那 28 个是已知误报）。
- 开放 Issue：#1（跟踪）、#13（世界事实）。
- Dashboard 四页已就位：`/`(Run) `/compare` `/history` `/configure`（`/providers` 302）。
- 每阶段**分支 + PR**（英文 commit、正文 `Closes #N` / `Part of #N`、squash 合并）；
  一次性脚本放 `.scratch/`，用完删除。

---

## 怎么跑（实测过的命令；交接文档里的命令必须能直接执行）

```bash
# 真机单局（隔离目录/端口；不碰本机 8187 serve）
OPENTTD_DATA_DIR=/tmp/pXX OPENTTD_ADMIN_PORT=3991 OPENTTD_GAME_PORT=3993 \
  pnpm run cli --agent --demo-seconds 300 --game-days 150 --web-port 8198 --seed 11

# 记忆 A/B（两臂同 seed；功效不足会被跑前拒绝，见 scripts/run-experiment.ts）
pnpm exec tsx scripts/run-experiment.ts --dir /tmp/abXX --n 5 --game-days 300 --seed 7

# 学习曲线（同一 agent 连续 N 局、记忆累积；N 上限 10）
pnpm exec tsx scripts/run-experiment.ts --dir /tmp/seqXX --mode sequential --sessions 10

# 基准矩阵（每格独立 data dir；--credentials 把仓库外的 key 复制进每一格）
pnpm exec tsx scripts/bench.ts --root /tmp/pB7 --models MiniMax-M3.1-Flash,MiniMax-M2.5 \
  --seeds 11,22,33 --repeats 1 --game-days 250 --credentials /tmp/pCred/credentials.json --dry-run
```

- 门禁：`pnpm run gate`（typecheck + lint + vendor 校验 + 单测）。
- 看板回归：`pnpm run dashboard:smoke`（真实 Chrome + 全部控制台级别）。
- 真机实验的隔离/清理/禁则见 `MEMORY.md` §0 与 `docs/STARTUP-AND-LIFECYCLE.md`。

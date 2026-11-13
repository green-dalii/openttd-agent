# ROADMAP — OpenTTD LLM Agent Framework

> **本文件只收录「未完成的进度与计划」**：里程碑状态、下一步做什么、验收标准。
>
> **不收录**（按 `AGENTS.md` §9 的文档职责表，冲突以该表为准）：
> - 各版本**已经做了什么** → `CHANGELOG.md`（唯一权威）
> - 开发准则 / 铁律 / 提交卫生 → `AGENTS.md`
> - 系统事实与协议细节 → `SPEC.md`、`docs/`
> - 踩过的坑与教训 → `MEMORY.md`
> - **已完成阶段的过程叙述**（旧的 A/B 记录、冻结判定、完成史、一次性交接手册）→ `CHANGELOG.md`
>   与 `SPEC.md` §10.x；本文件只留指针，不再复述。

---

## 里程碑（SPEC §9）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 环境钉死（二进制 / 隔离 data dir / admin auth） | ✅ |
| **M1** | 观测闭环（规范事件 + Web 仪表盘） | ✅ |
| **M2** | 最小决策闭环（bridge GS + executor + Pi Agent 决策） | ✅ |
| **M3** | 进化闭环（局终结算 + 反思 + lessons + 注入下局 + 对比图） | 🔵 引擎完成；**记忆无收益**是当前唯一有效对照结论（`SPEC.md` §10.43） |
| **M4** | 打磨（策略库 / replay / 自愈 / 多模型基线） | ⬜ 并入阶段 D |

---

## 🔵 当前阶段：阶段 D —— scaffold 成熟化 + 模型基准评测模式

> **契约正文（唯一权威）：`docs/SCAFFOLD-CONTRACT.md`**；执行清单：GitHub Issue #1
> （跟踪）与 #2–#13（逐项）。
> 所有者定调（2026-10-08）：**同一套脚手架，两种模式**——A 单机游玩（接任意 pi-ai
> 模型玩一局，不是评测），B 模型基准评测（固定世界下比较不同模型）。两种模式的
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
| **D6d** | 反事实 fork（同存档同决策点换模型） | **探针已过**（Issue #106）：同一存档读两次 ⇒ 同一资金轨迹 ⇒ 引擎侧可复现；但**脚本状态不随存档存取** ⇒ 两臂必须都从存档起步 | ⏸（待办 #2） |
| **F4** | **货运归因**：GS 逐 (货种,产业) 读数 → 台账装得下"产业对" → Compare/History 货运轴 | History 能说"这条决策运了多少货"；Compare 画出货物/客运拆分 | ✅（`SPEC.md` §10.126；Issue #13） |
| **P3** | 卫生：删 `v02-runner` 死代码、DOM churn 降噪、orphan 规则修、`AdminProbeClient` 审查 | gate 绿；DOM churn 显著下降并实测 | ⬜ |

**D6 的方案（唯一权威）**：`docs/HARNESS-MIGRATION.md`（含已核实的库事实与三条不变量）。

**依赖与顺序**：D1–D4 是**共用内核**（两种模式都受益），必须先于 D5；D6 与 D1–D5
可并行但每步独立提交。S7（世界事实补洞）是 D1 的后续（Issue #13）：城镇名 / 融资 /
推送事件 / L2 查询 / 决策→结果台账 / 逐线路调研 / 逐线路交付量**已做**（`SPEC.md`
§10.126、`docs/PER-LINE-DELIVERY-FEASIBILITY.md`）。

**明确不做**：不在脚手架未成熟前堆评测面；不因"模型清单未定"而阻塞脚手架
（模型走 pi-ai 目录，评测时再指定）；不用 LLM 裁判打分；不把策略写进脚手架。

---

## 待办（未完成，按可执行性排序）

| # | 事 | 验收 | 位置 |
|---|---|---|---|
| 0 | **B 基准决策与新矩阵**（Issue #1）：矩阵已跑完（2026-11-10；2 模型 × 3 seed × 250 日，6/6 成功）。结论按轴：**能力轴与货运轴都 `not determinable`**（交付/游戏日配对差 -1.364，95% CI [-4.335, 0.837]；货运/游戏日 -0.125，CI [-0.769, 0.393]，n=3，**未预登记**）⇒ 两个模型**分不开**（方差来自种子：M2.5 有一局什么都没建）；**效率轴**可判定（M3.1-Flash 每决策多花 **+105991 tokens**，CI [100637, 114751]）；**稳定性轴**可判定（工具失败率 **+3.9pp**，CI [2.0pp, 6.7pp]）。⇒ 下一步要么**预登记**效应量/CV 再按 `requiredSampleSize()` 跑够局数，要么**换更窄的问题**（货运轴的方差仍由"建没建线"主导）⇒ 两条路都压在待办 #1（货运线真的能交付）与 #2（同存档 fork）上面 | 选定轴的配对 CI 不含 0，或写明 n 与「不可判定」 | `SPEC.md` §10.126 / Issue #1 |
| 1 | **货运线建好了却不交付**（Issue #113）：线建成了（相位全绿）、车装对了货、带着车站订单、到了装货站 ⇒ 但**装走 0 吨**、整局**交付 0**。**已排除**"货没有下一跳"（`GetCargoWaitingVia(装货站,-1,COAL)` = 338 ⇒ 货在"无下一跳"桶 ⇒ 兜底允许任何车装它）。已交付**按需诊断**（GS `route_diag` + 模型工具 `diagnose_route` + 服务端具名原因）⇒ "卡在哪"可查、可复现。**下一步**：用诊断读数定位引擎拒绝装货的条件并修掉（候选：车辆是否真的进入货车站停靠流程、车站 truck stop 的 road tile、订单方向、station rating / exclusive rights）⇒ 这会同时压住**货运轴**与**策略晋升** | 真机：同 seed（4242）同产业对（46→53）⇒ **有交付且车辆利润为正** | Issue #113 / `SPEC.md` §10.126 / `MEMORY.md` D121 |
| 2 | **同存档反事实 fork（正式 run mode）**：**探针已做**（Issue #106，`scripts/determinism-probe.ts`）：同一存档复制两份各自 `-g` 开局、发同一条命令 ⇒ **资金档位集合与顺序完全相同** ⇒ 引擎侧可复现；且**脚本自身的状态不随存档存取**（GS 与 ExecutorV1 都没有 `Save()`/`Load()`）⇒ **两臂必须都从存档起步**（不能一臂续跑、一臂读档）。下一步：把"两臂都从存档起步 + 同一确定性触发点换模型"做成正式 run mode | 两臂同存档、同触发点、同 scaffold/config，只换模型；复用现有 manifest / route ledger / 配对比较 | `SPEC.md` §10.113 / Issue #106 |
| 3 | **B2 策略库晋升真机证明**（依赖待办 #1）：身份归代码（封闭动作词表 + 白名单参数）与"一局一读数"已就位；门槛是"利润 > 16.67/游戏日 且 **≥2 局**"。**当前门槛不可判定**：本局净现金流口径已修（`money − loan` ÷ 这一局经过的游戏日，`SPEC.md` §10.55 / §10.76），但**真实货运线还不能交付** ⇒ 没有正利润的读数 | 重算值 + 门槛可达性有明确结论（"做不到"必须建立在**有交付**的局上） | `docs/EVOLUTION.md` §2.2 / Issue #104 |
| 4 | **公司级运营利润**：现有 `route-stats.profit` 只覆盖**当前**车辆集合（卖车会丢累计）⇒ 需要**连续车队台账**（卖出不得清零） | 口径单测 + 真机对账（运营利润 ≠ admin `income`） | `docs/EVOLUTION.md` §2.2 |
| 5 | **P2-1 / P2-2 实验待跑**：预建场景 + 300 日短局多跑；M4b 选择压力 + M5 学习曲线 | 每小时局数 ≥3×；斜率 CI 或「不可判定」声明 | 需所有者先定**模型与预算**（P2-3 的功效闸会拒绝样本不足的比较） |
| 6 | **未测旋钮**（不得声称已有效果）：`sessionId` 缓存收益、`deliberation off-vs-low` 的质量-成本权衡 | 各跑一次受控对比并报出结论 | D4（旋钮可达后） |
| 7 | **D3(b) UnoCSS CLI 是否放行**（唯一可能划算的形态） | 所有者决定；不放行则保持现状 | `docs/FRONTEND.md` §6.6 |
| 8 | 预提交孤儿符号误报刷屏（25 个/次）淹没真孤儿 —— **2026-10-30 已查清：卡在工具上**（pi-shazam 的项目配置只认 `verify.maxFiles`，没有 ignore 规则；分析器只数**调用**，前端 `window.*` 导出在模板里被调用 ⇒ 假孤儿）。它**不拦提交**（咨询性），故只剩噪声；已记 MEMORY D85 防止误删 | 要么工具支持 ignore，要么接受噪声 | P3（等工具） |

**实验与真机约束**（细节见 `MEMORY.md`）：隔离 data dir 与端口（`/tmp/pXX`、admin `3991`、
game `3993`、web `8198`）；**不跑宽泛 pkill**；实验期间不跑 gate（D5）；block 期间不改 `src/`（D12）。

---

## 已知的环境事实

- 凭证/remote/清理/门禁/端口等易变事实**不在本文件**：见 `MEMORY.md` §0.4 与
  `docs/STARTUP-AND-LIFECYCLE.md`（本文件曾复制一份，重复即漂移——2026-11-08 删除）。
- 本地测试 serve（8187）默认数据目录 `/tmp/openttd-agent-data`；其中的 demo 局是**旧代码**
  跑的贪心线路，不代表当前能力（新证据一律用隔离目录的局）。

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

# 同存档确定性探针（Issue #106：同一存档读两次 ⇒ 同一资金轨迹）
pnpm exec tsx scripts/determinism-probe.ts --data-dir /tmp/pDetXX --seed 4242 \
  --checkpoint-day 60 --window-days 30
```

- 门禁：`pnpm run gate`（typecheck + lint + vendor 校验 + 单测）。
- 看板回归：`pnpm run dashboard:smoke`（真实 Chrome + 全部控制台级别）。
- 真机实验的隔离/清理/禁则见 `MEMORY.md` §0 与 `docs/STARTUP-AND-LIFECYCLE.md`。

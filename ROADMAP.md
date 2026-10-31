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
| **D6d** | 反事实 fork（同存档同决策点换模型） | 待定：等 D5 真跑一轮真实模型后再评估 | ⏸ |
| **P3** | 卫生：删 `v02-runner` 死代码（380 行）、DOM churn 降噪（12.5k/s 实测）、orphan 规则修、`AdminProbeClient` 审查 | gate 绿；DOM churn 显著下降并实测 | ⬜ |

**D6 的方案（唯一权威）**：`docs/HARNESS-MIGRATION.md`（含已核实的库事实与三条不变量）。

**依赖与顺序**：D1–D4 是**共用内核**（两种模式都受益），必须先于 D5；D6 与 D1–D5
可并行但每步独立提交。S7（世界事实补洞：逐线交付/融资/样本外镇名）是 D1 的后续，
按需单独排期（#13）。

**D1 的补洞清单**（源自契约 §5：信号源盘点里"未用"的通道，Issue #13）——随 D1 一并评估，
不做则写明理由：L2 查询工具族（`inspect_town` / `inspect_vehicle` / `finances`）、
决策→结果账本（credit assignment 的原料）、GSEvent 推送族（首车到站/车毁/城镇成长）、
`company_expenses` 分类账（年度收支归因）、逐线交付量。

**明确不做**：不在脚手架未成熟前堆评测面；不因"模型清单未定"而阻塞脚手架
（模型走 pi-ai 目录，评测时再指定）；不用 LLM 裁判打分；不把策略写进脚手架。

---

## 待办（未完成，按可执行性排序）

| # | 事 | 验收 | 位置 |
|---|---|---|---|
| 1 | **P2-1 / P2-2 实验待跑**：预建场景 + 300 日短局多跑；M4b 选择压力 + M5 学习曲线 | 每小时局数 ≥3×；斜率 CI 或「不可判定」声明 | 需所有者先定**模型与预算**（P2-3 的功效闸会拒绝样本不足的比较） |
| 2 | 线路端点只显示城镇 id（`#4 → #8`）：**2026-10-30 查明 GS 侧早就报了 `GSTown.GetName`（真机载荷里有 "Plunbury"），丢在模型可见的投影里** ⇒ 已修（PR：投影带 `town.name`）。但 GS 只发人口前 10 的城镇 ⇒ **样本外的城镇仍只有 id**（真机 26 座城只见 10 座） | 样本外城镇也有名字 ⇒ 要 GS 改采样范围 | #13 |
| 3 | 产业表整列 `Transported 0`：先测 `-1` 是否存在 | 存在则显示 `—`；不存在则该列对"只有公交公司"的地图无信息量（两种处置不同） | §6f 仍欠 |
| 4 | **数据按需全量**：agent 只读工具 `get_industries`/`get_cargo` + 页面"展开全部"；车辆明细采样 + 按需全量 | 全量与取样一致；行数与 GS 车队数一致或明确标注 "N of M"；**稳态载荷不增**（同一探针比对前后帧字节/变更数） | §6d P3/P4 |
| 5 | **止损型 run 一律 exit 1** 的语义分档（待议） | 区分"未到终点"与"真失败"，让 CI 不被正常止损刷屏 | §6 收尾链事实 |
| 6 | **未测旋钮**（不得声称已有效果）：`sessionId` 缓存收益、`deliberation off-vs-low` 的质量-成本权衡 | 各跑一次受控对比并报出结论 | D4（旋钮可达后） |
| 7 | 带 LLM 的真实运行的**交付量读数**（offline demo 恒为 0）—— **2026-10-30 三局真机（MiniMax-M3.1-Flash，seed 4242）仍是 0，但原因已不同**：① `deliveredCargo` **只记货物不记乘客**（客运线在游戏自己的季度计数器上是 9，admin 侧读 0）⇒ 分数轴只有货物路线能挣到；② 模型**已经会打货物了**（投影补齐后它自己推出「货物—车型」对应、按产业名里的镇名选货路线），但**建路到矿区要 30–40 游戏日，60 日视界装不下一次货物经营** | 真机一局读到非零 `deliveredRun`（**需要更长的视界**：与 #1 的 300 日短局一起做） | §6d P2 待补 |
| 8 | **D3(b) UnoCSS CLI 是否放行**（唯一可能划算的形态） | 所有者决定；不放行则保持现状 | `docs/FRONTEND.md` §6.6 |
| 9 | 预提交孤儿符号误报刷屏（25 个/次）淹没真孤儿 —— **2026-10-30 已查清：卡在工具上**（pi-shazam 的项目配置只认 `verify.maxFiles`，没有 ignore 规则；分析器只数**调用**，前端 `window.*` 导出在模板里被调用 ⇒ 假孤儿）。它**不拦提交**（咨询性），故只剩噪声；已记 MEMORY D85 防止误删 | 要么工具支持 ignore，要么接受噪声 | P3（等工具） |
| 10 | **策略库从未观察到晋升**（每轮 `0 strategy card(s) promoted`，自进化第二条腿未运行） | 一次真实运行里确认晋升路径可用，或调整晋升门槛并报出理由 | `SPEC.md` §5.3 |

**实验与真机约束**（细节见 `MEMORY.md`）：真机实验用**隔离 data dir 与端口**
（如 `/tmp/pXX`、admin `3991`、game `3993`、web `8198`）；**不跑宽泛 pkill**；
实验进行期间不跑 gate（D5）；block 运行期间不改 `src/`（D12）。

---

## 已知的环境事实

- 凭证/remote/清理/门禁等易变事实**不在本文件**：见 `MEMORY.md` §0 与
  `docs/STARTUP-AND-LIFECYCLE.md`（本文件曾复制过一份，重复即漂移——2026-10-23 删除）。
- 本地测试 serve（8187）默认数据目录 `/tmp/openttd-agent-data`；其中的 demo 局是**旧代码**
  跑的贪心线路，不代表当前能力（新证据一律用隔离目录的局）。

---

## 🔴 COMPACT 后从这里接续（2026-10-25）

> 给"compact 后的我自己"的恢复手册。**按顺序做，不必重新推导**。

### 1. 现在有什么在跑？

```bash
pgrep -fl "bench.ts|run-experiment|cli/run.ts|llm-stub|OpenTTD.app"
```

无输出 = 没有实验（2026-10-24 收工时如此）。**不要**用宽泛 `pkill -f openttd`。

### 2. 下一步做什么？

**B1–B6（#33·#34·#35·#36·#37·#38）全部合并**（§10.119–§10.123；Dashboard 的四问 IA 落地完毕）。
**下一步：#13 S7 世界事实（等 owner 答复）→ 真实模型局 → 真实基准 → D6d → P3 卫生**。

| 步 | 内容（权威文档） | 关键验收 |
|---|---|---|
| **B2** 🔵 | 发起面：`POST /api/run/start` 接受并**校验**运行旋钮（seed/游戏日/场景/记忆臂/thinking/tool budget/token·cost 上限/后端）；Configure 表单 + **next-runn 预览**（字段与 manifest 同名） | 从页面用非默认旋钮起一局，`meta.manifest` 与预览**逐字段相同** |（#34）
| **B3** | Run 页三段化 + **因果时间线**（decision → tools → job/阶段 → 效果，默认最近 20 条） | 一次决策的四段证据同屏、由 `job` 连接 |（#35）
| **B4** | **Compare 页**：复用 `buildScorecard` + `pairedComparison`；排除按原因计数；样本不足写"不可判定" | 2 模型 × 2 seed 出四轴 + CI/不可判定 |（#36）
| **B5** | 结果词表**全 10 类** + 结构化错误 `{code,message,hint}`（删掉前端正则猜语义） | 10 类成因都能在 UI 出现；401/404/无凭据各有 code |（#37）
| **B6** | History 补 manifest 全字段 + 按模型/seed/后端分组；Evolution 并入 History 的 "Memory" 分区 | 任一局可自查"同世界/同脚手架/是否被闸" |（#38）

**跟踪**：总 Issue **#32**（B1–B6 清单），每步各自一个 Issue（下面就标注）；PR 内 `Closes #N`。
**语言**：对外载体（Issue/PR/评审回复）**一律英文**（`AGENTS.md` §8.1）；仓库文档仍是中文。

**已批准的三条决定**（细节见两份 CoDesign 的 §7）：
① 导航按四问重排（Run / Compare / History / Configure）；
② 基准可从看板发起，但必须有"预计局数 / 预计花费（无价目表写 unknown）/ 逐格确认"；
③ 因果时间线默认最近 20 条、按需加载。

**上一轮的遗留（未完成，别丢）**：
- **#13 S7 世界事实补洞**：方案在 `docs/SCAFFOLD-CONTRACT.md` §9，等回答三问（归因口径可接受？顺序 a→b→c→d？一次一 PR？）。**排在 B 系列之后**。
- **AGENT_HARNESS 翻默认**：前提已满足 2/3（live 双绿、跨 seed `payloadShapeHash` 相等）；
  还差"至少一局真实模型"。**S2 已修好 A5**（门禁与 runner 共用同一份覆盖层，见 `SPEC.md` §10.117）：
  门禁现在对 live-only 模型 `MiniMax-M3.1-Flash` 判 **ok**（provider 1592ms 应答），
  所以"真实模型一局"不再被门禁挡住。
- **真实基准一轮**（需所有者定模型与预算）→ D6d fork 再评估 → P3 卫生。

**端口占用（踩过两次）**：`dashboard:smoke` 默认在 **8899** 上自起 dashboard；临时
stub/服务别占 8899。真机实验固定用 admin 3991 / game 3993 / web 81xx–82xx。

**三条不得违反的不变量**：harness 默认关（`AGENT_HARNESS=0`）；harness compaction 必须关；
完成=§5.1 八条真机断言全绿（单测绿不算）。

### 3. 环境事实（易变，只写这里）

- 门禁：`pnpm run gate`（typecheck + **eslint --max-warnings 0** + vendor 校验 + 单测）。
  **只看它自己的退出码**：`pnpm run gate > .scratch/gate.log 2>&1; echo "gate=$?"`（MEMORY D68）。
- 看板回归：`pnpm run dashboard:smoke`（真实 Chrome + 全部控制台级别）。
- OpenTTD 二进制：`$HOME/Library/Application Support/Steam/steamapps/common/OpenTTD/OpenTTD.app/Contents/MacOS/openttd`。
- 真机隔离模板：`OPENTTD_DATA_DIR=/tmp/pXX`、admin `3991`、game `3993`、`--web-port 8198`。
- 无 CI workflow：本地 gate + PR 人工审核即门禁；**每阶段走分支 + PR**（用户 2026-10-23 要求）。
- 一次性脚本一律放 `.scratch/` 并**用完删除**。
- **当前 dashboard（2026-10-24 收工）**：`pnpm exec tsx src/cli/run.ts --serve --web-port 8187`
  在后台跑，数据目录 `/tmp/openttd-agent-data`；模型选择 = `minimax-cn / MiniMax-M3.1-Flash`
  （实时刷新到的模型，`llm.json` 里已写入）。**它现在会被门禁判死**（A5：`probeLlmReal` 缺
  `modelsStore`）——这正是 B1/B2 要修的，修完才用它跑"至少一局真实模型"。
- `models-cache.json` 里已有 `minimax-cn` 的 6 个实时模型覆盖层（`checkedAt` 2026-10-25）；
  目录快照本身是 **2026-09-04** 的（`SPEC.md` §10.116）。

### 4. 最近的交接点（2026-10-25 收工）

- `main` = **`93090cf`**（S2：四路共用一个 selection resolver）。B2 只在分支
  `feat/b2-launch-surface`（未提交）。`pnpm run gate` = **1652 passed / 9 skipped**。
- `LIVE_TESTS=1 vitest --run test/live`：**harness 9/9、裸 Agent 9/9**，跑完端口自动释放。
- 开放 Issue：#13（世界事实，下一步）、#1（跟踪）。
- **文档已收敛（2026-10-24）**：MEMORY 2081→664、CHANGELOG 1846→495、SPEC 1297→1243；
  旧的完整叙述进 `docs/archive/`（冻结）；预算与"减法义务"写进 `AGENTS.md` §9.1b，
  由 `repo-hygiene` 守卫（`pnpm run gate` 会拦超额）。
- 已完成阶段的实测数字：`SPEC.md` §10.114（D1–D5）+ §10.115（D6）+ §10.116（模型目录）。
- **Dashboard 现状**：Live 2030 行模板 / 20 区块 / 14 KPI；无 Compare 页、无 bench 端点、
  无旋钮入口（诊断与目标结构见 `docs/DASHBOARD-CODESIGN.md`）。

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
```

- 门禁：`pnpm run gate`（typecheck + lint + vendor 校验 + 单测）。
- 看板回归：`pnpm run dashboard:smoke`（真实 Chrome + 全部控制台级别）。
- 真机实验的隔离/清理/禁则见 `MEMORY.md` §0 与 `docs/STARTUP-AND-LIFECYCLE.md`。

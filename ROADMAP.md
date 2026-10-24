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
| 2 | 线路端点只显示城镇 id（`#4 → #8`）：城镇**名字**没上报 | 补 `GSTown.GetName`（需先验 API 真机可用） | #13 |
| 3 | 产业表整列 `Transported 0`：先测 `-1` 是否存在 | 存在则显示 `—`；不存在则该列对"只有公交公司"的地图无信息量（两种处置不同） | §6f 仍欠 |
| 4 | **数据按需全量**：agent 只读工具 `get_industries`/`get_cargo` + 页面"展开全部"；车辆明细采样 + 按需全量 | 全量与取样一致；行数与 GS 车队数一致或明确标注 "N of M"；**稳态载荷不增**（同一探针比对前后帧字节/变更数） | §6d P3/P4 |
| 5 | **止损型 run 一律 exit 1** 的语义分档（待议） | 区分"未到终点"与"真失败"，让 CI 不被正常止损刷屏 | §6 收尾链事实 |
| 6 | **未测旋钮**（不得声称已有效果）：`sessionId` 缓存收益、`deliberation off-vs-low` 的质量-成本权衡 | 各跑一次受控对比并报出结论 | D4（旋钮可达后） |
| 7 | 带 LLM 的真实运行的**交付量读数**（offline demo 恒为 0） | 真机一局读到非零 `deliveredRun` | §6d P2 待补 |
| 8 | **D3(b) UnoCSS CLI 是否放行**（唯一可能划算的形态） | 所有者决定；不放行则保持现状 | `docs/FRONTEND.md` §6.6 |
| 9 | 预提交孤儿符号误报刷屏（25 个/次）淹没真孤儿 | 误报规则写进配置，真孤儿仍被报出 | P3 |
| 10 | `AdminProbeClient` 审查（`src/cli/run.ts`） | 明确去留并有测试覆盖 | P3 |
| 11 | **策略库从未观察到晋升**（每轮 `0 strategy card(s) promoted`，自进化第二条腿未运行） | 一次真实运行里确认晋升路径可用，或调整晋升门槛并报出理由 | `SPEC.md` §5.3 |

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

## 🔴 COMPACT 后从这里接续（2026-10-24）

> 给"compact 后的我自己"的恢复手册。**按顺序做，不必重新推导**。

### 1. 现在有什么在跑？

```bash
pgrep -fl "bench.ts|run-experiment|cli/run.ts|llm-stub|OpenTTD.app"
```

无输出 = 没有实验（2026-10-24 收工时如此）。**不要**用宽泛 `pkill -f openttd`。

### 2. 下一步做什么？

**D6b 完成后需要拍板的一件事**：`AGENT_HARNESS` 是否翻成默认。翻之前必须满足：
① 用同一 seed 各跑 3 局，两后端 `payloadHash` 相同的局数 ≥ 2（世界随机性会让首份 payload
的数值不同，这条需要一个"数值归一化后的 payload 哈希"才能真的可比——否则别翻）；
② `test:live` 在两条后端上都绿（已达成：2026-10-24 两条后端各 9/9，见 #22 的修复）；
③ 至少一局真实模型（非 stub）。

**之后**：S7 世界事实补洞（Issue #13）→ P3 卫生。
**D6d（反事实 fork）** 仍待定：等 D5 真跑过一轮真实模型后再评估。

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

### 4. 最近的交接点

`main` = D0–D5 全部合并；gate 1486 绿；Issue #1 有阶段进度表。
已完成阶段的实测数字在 `SPEC.md` §10.114（阶段 D 一条）。

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

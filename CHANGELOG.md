# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **文档边界**（范围以 `AGENTS.md` §9 为唯一权威）：本文件是每个版本**改了什么**的
> 权威记录（面向使用者与回滚）。
> **不收录**：未来计划（→ `ROADMAP.md`）、开发准则（→ `AGENTS.md`）、
> 踩过的坑的复盘（→ `MEMORY.md`；此处只写"改了什么"，不写"我为什么犯错"）。

## [Unreleased]

### Changed（校准 #2：仪器修好后的真实方差图像，2026-09-18）

- 修复后校准（3/臂，900s）：`gsErrors` **全 0**、`deliveredRun ≥ raw` **每局成立**
  （旧读数低估 0–56%）——两个仪器修复均获验证。
- **证伪**："修仪器会降低结果方差" **不成立**：control 臂 CV 仍为 **1.25**（同臂 0/19/225）。
  方差来自**局间行为**（建成与否、决策数 5–12、路线选择），不是测量端。
- **新病理**：一局 treatment **193 次工具调用 / 11 次决策（17.5 次/决策）**、
  1.48M tokens，占该臂 token 总量 82% → 把 tok/dec 抬到正常的 9 倍。
  当前**每决策工具调用无上限**；这既是方差来源，也是可干预点。

### Fixed（GS 通道部分失效 + 通道健康指标，2026-09-18）

- **`GSStation.IsStationTile` 在 GS API 里不存在**：它在 `StationNear` 的半径扫描
  里，只在 executor 挪址时触发，**只**让 `route_stats` 这一种请求报错。ab900/cal900
  **17/17 局**都命中（共 1221 次），单局严重度从 2 次到 152 次不等，**verdict 里一行
  都看不到**——`ctl4`（delivered=0 那局）只拿到 20 条线路经济读数。已改用已验证的
  `GetStationID` + `IsValidStation`，并加静态守卫测试（黑名单条目必须来自线上观测）。
- **新增通道健康指标**：`SignalHub.getGsErrors()` → `GameMetric.gsErrors`，verdict 在
  任何收益声明前打印每臂错误数与最大值；历史行显示 `not reported` 而非假装干净。
- 修复真机验证：错误 0 次、route-stats 313 条（修复前同窗口 20–291 条）。
- README/CONTRIBUTING 里 `pnpm run gen-squirrel` 这条**不存在的命令**已删除
  （脚本包是运行时从 `src/game/squirrel/` 部署的）。

### Fixed（流量指标的真实测量缺陷，2026-09-18）

- **`delivered` 一直是 OpenTTD 的"当季"计数器**（每季归零）→ 此前测的是**随机一段
  部分季度**的交付量，这解释了"建成却 0 交付"、同车队规模下 0–279 的散布，以及两轮
  A/B 方向相反。新增 `deliveredRun`（`src/game/delivery-meter.ts`）跨季积分，
  判定优先用它、**两臂同源**（`ArmComparison.deliveredSource`），旧行回落原始值并标注为不可比。
- 澄清 `rc=1` 的含义（=施工未达成 DONE，不是崩溃）并在输出中明示。

### Added（M1：反思可诊断 + 有界重试 + 产出率披露，2026-09-19）

- 反思结果现在写进**会话审计**（`type:"reflection"`）：模型调了哪些记录工具、
  被拒几次、重试几次、存了几条、失败原因、以及**回复预览**（单行、≤300 字符）。
  此前只有 `0 lesson(s) kept` 一行 console —— 看不出模型说了什么，失败无从诊断。
- **有界重试**：成功反思若一个记录工具都没调用，则再问一次（上限 1 次），
  重试消息列出该局已知事实，并明说"仍无可支撑就什么都别记"。
  次数进报告与审计，两个 verdict 披露。
- 新增 `reflection-stats`（`src/evolution/reflection-stats.ts`）与 verdict 行
  `reflection: N run(s) recorded (M failed), zero-tool-call runs …`；
  **协议信号与基础设施故障分别计数、分别告警**（真机上 provider 失败曾被误报为协议问题）。
- 真机 6 局（`/tmp/m1a`、`/tmp/m1b`）：反思稳定产出（1–4 条观察/局），
  **`supersedes` 首次在真机生效**（两局分别作废 1 与 2 条旧观察）。

### Docs（能力判定 + MEMORY 精简，2026-09-19）

- 新增 **M-PLAY 里程碑**（ROADMAP）：把"LLM 能否自主玩一局"变成可辩护的主张，
  含五项阶段与**成功判据**（先写下来，避免事后挪门柱）。判定结论：**能无人干预跑完整局、
  能自主决策，但还不算"会玩"**——动作面只有建线+加车（GS 只暴露 7 条命令）、
  目标（profitable）与判据（deliveredRun）不一致、有后果的决策只有开头 1–3 个。
- `MEMORY.md` 精简：删除已完成的 NEXT-2 方案与执行日志（127 行，事实仍在 SPEC §10.53–§10.63）、
  §0 改为「能力判定表 + 当前阶段 + 不漂移协议」、新增**教训索引表**（查 id 不必通读）、
  修掉两处重复编号（A4/E1 → A10/E2）、并把**环境事实统一指向 ROADMAP 交接块**（单一权威）。
  新增教训 **D32**（判断"agent 能否做 X"要沿环境暴露的动作面查，而不是查 agent 循环）。

### Changed（R2b：反思改走 Agent + 记录工具，2026-09-19）

- 反思不再"输出 JSON 由框架解析"，而是走 pi-agent-core 的 `Agent` 调用
  `record_lesson` / `record_strategy` 工具：参数由 schema 校验，
  **被拒的理由作为工具错误回到模型**，模型可以改写成观察句再试。
  校验唯一实现在 `validateLesson`；`parseReflection` / `reflectToLessons` /
  `reflectToStrategies` 已删除（两条并存的契约是漂移源）。
- provider 失败按库的契约读 `agent.state.errorMessage`，不再把它伪装成
  "这局没什么可记录的"。
- 新增 `ReflectionReport.toolCalls` 与一条 WARNING：模型一次都没调用记录工具时
  明确区分"没接线/协议不一致"与"确实没什么可记"。
- 修复真机事故：运行时改成工具后提示词仍要求 "Reply with JSON only"，
  导致两局 `0 lessons kept` 且无任何拒绝（静默）。现已加**契约交叉守卫测试**
  （提示词点名的工具必须存在、不得再教旧协议、必须说明被拒会给理由）。
- 反思现在与决策共用同一套消息/工具机制（少一套自造协议）。

### Changed（R2：跨局经验从"指令"变成"带实测读数的观察"，2026-09-18）

- **经验契约换代**：`Lesson.kind: "do"|"dont"` → `Lesson.outcome: {metric, before, after}`。
  注入行由 `Previously an action like this paid off: <text>` 改为
  `Recorded in an earlier game: <text> [delivered 420 -> 1088, seed 7]` ——
  旧格式既是指令，又替模型断言了一个从未验证的因果。
- **内容级守卫** `isImperative()`：作用在被注入的**文本**上（旧守卫只查包装前缀，
  永远不可能匹配），在产出处生效并在注入处纵深防御。真机 53 条旧条目实测召回率 60%
  （初版 36%，动词表按真机措辞扩充）——文档中已写明它只是第二道闸。
- **迁移**：读取时排除旧形状条目（无实测读数）并**报出数量**（`legacyDropped`），
  不重写磁盘。真机 4 个数据目录共 53 条旧条目，0 条满足新契约。
- **经验可被推翻**：`supersededBy` 第一次被真正赋值。反思输入带上现库，模型可用
  `supersedes:[id]` 取代旧观察；落盘时应用。修复两个缺陷：去重会让作废输给原条；
  读取守卫只查 id+text（因此"库里有几条经验"这个数字是假的）。
- Dashboard 记忆面板：徽标由 `do`/`avoid` 换成**实测读数**（缺读数显示 `—`），
  新增"模板绑定 ↔ 视图模型"交叉守卫测试。

### Fixed（R1：工具执行顺序 / 预算 / 披露路径，2026-09-18）

- **变更型工具改为串行执行**：`build_bus_route` / `add_vehicles` / `set_pause` 现在声明
  `executionMode:"sequential"`。此前 pi-agent-core 的默认 `parallel` 会让同一条助手消息里的
  两条命令**重叠发出**，而游戏按 FIFO 应用 → 台账顺序 ≠ 实际应用顺序（实测时序见 SPEC §10.75）。
- **每决策工具预算**（默认 12 次）：在 `beforeToolCall` 里拒绝并把理由交回模型；
  拒绝次数记入 `GameMetric.toolBudgetBlocks`，并在两个 verdict 打印"tool budget (refusals/run)"。
  实测正常决策 2–3 次、病态局 17.5 次/决策（193 次烧掉该臂 82% tokens）。
- **降级披露修好**：`channel health` 一行此前**从未出现在任何实验日志里**
  （打印它的脚本不在实验路径上，且实现取错对象恒为 "not reported"）。
  聚合统一进 `src/evolution/metrics.ts`（`metricStat`/`degradationStats`），
  两个 verdict 都打印并已实测取到数。缺报仍报 `not reported`，不是 0。
- 新增 `createAgent` 参数：`sessionId`（provider 缓存键）、`maxToolCallsPerDecision`、
  `thinkingLevel` / `thinkingBudgets`（默认 `"off"` = 原行为）。**缓存收益与 deliberation
  对比均未测量**，文档中不得声称。

### Fixed（反思输入补上产出指标，2026-09-18）

- 反思（局终 lessons 蒸馏）的 outcome 现在包含 `delivered` / `simulatedDays` /
  `episodeStop`，并打印每游戏日速率；缺读数写 "not measured" 而非 0。
  此前反思只看 money（被施工花费与贷款主导），却用 `deliveredRun` 评判——**学错了对象**。

### Added（S1/G4：预建场景，施工移出测量窗，2026-09-18）

- 新增 `--scenario prebuilt`：开局先用确定性蓝图建好线路，**等到可运营才开始测量窗**，
  此后全部是管理决策；记录 `scenario`/`scenarioReason`/`deliveredAtReady`；
  **场景未就绪的局在判定中排除并披露**。
- 真机验证（horizon 120）：就绪耗时 331 采样（施工不计入测量窗），
  测量窗内 6 次决策 → 车队扩到 3、站点扩到 4，`reachedHorizon=true`。
- `src/agent/prebuilt.ts` 纯编排 + 5 项单测（就绪判定、超时、被拒）。

### Added（S0 oracle 梯度：杠杆存在但饱和，2026-09-18）

- `--v02 --add-vehicles N` 探针修好并**验证自身效果**（请求 6/12/18 → 实测 9/15/21）；
  修掉两个会造成**假阴性**的缺陷（`EX done` 瞬态未闩锁、等待上限硬编码 120s）。
- 结果：`deliveredRun` **1088 / 1511 / 1598**，而原始当季读数为 **0 / 22 / 83**
  → 任务**有杠杆**（决策空间真实），但在 15 辆附近**饱和**（边际 70 → 15 交付/车）。
- 由此确定 S1/G4 设计约束：**起始 3 辆**，效应量须落在陡峭区（3–15 辆）。

### Fixed（episode 时钟改用 GS 原始日期 + 三处接线缺口，2026-09-18）

- episode 边界改用 **GS 原始日期**（每 200 tick ≈ 3 游戏日）而非 admin 的 `Date`
  订阅（**Monthly = 30 游戏日**）：实测 horizon 30 → 32、60 → 60、120 → 120；
  **测量请用 30 的整数倍 horizon**。
- 修三处"声明了但没接线"：`loop.ts` 只转发 `secondsRemaining`（模拟时钟被丢弃）、
  CLI 未把 `--game-days` 转发给 **v02** 路径、v02 时钟只读粗粒度的 `world.date`。
- `--v02` 记录 `deliveredRun`/`simulatedDays`/`horizonDays`/`reachedHorizon`，
  使 oracle 梯度测试与 agent 路径**同一套可比量**。

### Added（G2：施工进度/吞吐/ETA 成为 agent 可见的事实，2026-09-18）

- 新增 `src/agent/executor-progress.ts`：从 executor 阶段（`rd s<seg> r<step> d<dist> p<fails>`）
  积分出 **还需铺多少格 / 实测格每游戏日 / ETA（游戏日）/ 剩余格数多久没变**，
  经 hub → 决策上下文 `executor` 字段 → 模型，并打印 `[agent] executor facts: …`。
- 语义取自 Squirrel 源码：`d` 是**还剩多少格**（随推进下降），`r` 是**搜索步数**（在动≠前进）。
- 真机实测：`157 tiles to go, 0.67 tiles/game-day, ETA ~176 game days` 而该局 horizon 150 日
  ——**该路线按当前速率建不完**。过去正是缺这条事实，agent 才会在一局内连下
  68/110/161/239/271 格线路，并用 193 次工具调用轮询填空。

### Fixed（G3：车队请求不再静默无效，2026-09-18）

- executor 跳过"非当前 job"的车队请求时，现在会置阶段 `fleet_otherjob j<k>`
  （同一请求只报一次，避免淹没路网进度阶段），harness 解码后送到 agent。
  背景：agent 反复请求 10/15 辆车（同一请求 8 次），而车队停在 6，**且它无从知道原因**。
- 车队按**线路**记账（`_fleetOwned` 只数本 job 克隆的车），修掉"一条线路的车队
  满足另一条线路请求"的语义混用。
- 真机冒烟验证：GS 起得来、0 错误、阶段正常推进。
- 记录 horizon 的**边界分辨率 ≈3 游戏日**（GS 日期上报节奏）——测量应用 ≫该分辨率的 horizon。

### Changed（G1：局改以模拟时间结束，2026-09-18）

- 新增 `--game-days N`：推进 N **游戏日**后结束；`--demo-seconds` 降级为**墙钟安全上限**。
- 记录 `simulatedDays`/`horizonDays`/`reachedHorizon`；未达上限的局在判定中**排除并披露**，
  历史行披露为 "unknown opportunity"。**"世界停住了"不再冒充 `deliveredRun=0`。**
- 模型上下文新增 `simulatedDays`/`gameDaysRemaining`（固定接口缺口：`loop.ts` 原先只转发
  墙钟秒，新字段到不了提示）。
- 边界精确性：决策进行中也检查边界 + 剩余不足一次决策时不再提问（实测 horizon 60 → 60，过冲 0；
  修前 horizon 40 → 60）。**固定模拟时长还能省墙钟**（60 日只花 113s，上限 600s 未触发）。

### Added（block #1 结果与方差诊断，2026-09-18）

- 顺序检验 block #1（n=5/臂）：delivered 均值 137 vs 190、**CI [-147, 56] 含 0**、
  方向与校准轮**相反** → **未建立任何效应**（把任一轮当信号即选择性引用）。
- 证伪"900s 零膨胀已消除"：10 局中 1 局零交付（校准时为 8/8）→ "0%" 应读作 "≤1/8"。
- 方差诊断：**同 6 辆车 delivered 0–279**，窗口/车队/站点都解释不了 → 主因是
  **路线选择 + 施工时序**（被测行为自身的噪声），因此下一步是**设计改动**而非加样本。

### Added（900s 校准：实验设计的转折，2026-09-18）

- 校准证明 **500s 窗口是零膨胀与方差的主因**：900s 下零交付率 70%→**0%**、
  建成率→**100%**、CV 1.95→**0.48**；记忆的 tok/决策代价 +0.1%。
- 障碍率在双臂 100% 时**饱和**：`deliveredNote` 明确提示"该统计量在此无判别力，
  请比较量级"，并给出按 MDE 反推的 n（+46% → 25/臂；+30% → ≥40/臂）。

### Added（分布感知判据：中位数 / 零率 / delivered 独立判定，2026-09-17）

- `ArmStats.medianDelivered`、`zeroDeliveredRate`；`ArmComparison.deliveredNote`
  （均值与中位数符号相反时点名）；`deliveredConclusive`（**不被 built-rate 守卫挡住**
  ——那条守卫是给 money/income 的）。
- 原因：/tmp/n2ab3 实测 delivered 均值 favor 记忆（23.2 vs 11.2）而中位数 favor 对照
  （0 vs 15），系零膨胀重尾所致——只报均值会得出相反结论。

### Changed（冻结 A/B 结论：默认不冻结，2026-09-17）

- 冻结机制已核实（5/5 局有 3–8 次确认暂停、0 恢复失败、0 看门狗触发），
  但代价是**游戏内时间少约 10%**，且暂停期间 executor/GS 无法推进施工——
  本任务的瓶颈正是施工时长。结论：**默认保持不冻结**（SPEC §10.61）。
- verdict 输出的臂标签按比较维度显示（冻结轮不再写 "with lessons"）。

### Fixed（A/B 比较维度可指定，2026-09-17）

- `GameMetric.freeze` + `compareArms(metrics, by: "memory"|"freeze")` +
  `evolutionView(dir, by)`。修前 `arm` 只描述记忆变量，冻结轮两臂都 `--no-memory`
  → 全被记成 control，统计失去对照。
- 冻结维度下"要求冻结但零确认"的局算 control（干预没送到）。

### Added（已验证的冻结 `--freeze`，2026-09-17）

- `src/agent/freeze.ts` + `--freeze`：决策期暂停世界（`pause` → 模型思考+执行动作
  → `finally` 恢复），暂停/恢复都要 rcon 回执确认，带重试与 120s 看门狗。
- 局末打印冻结统计（确认次数/未确认/恢复失败/看门狗触发/最长持有）。
- `scripts/run-experiment.ts --vary memory|freeze`：A/B 的自变量可选记忆或冻结，
  两臂只差自变量（freeze 轮两臂都 `--no-memory`）。

### Added（rcon 回执通道，2026-09-17）

- `AdminClient.rconAwait(cmd, timeoutMs)`：等待 rcon 回执（FIFO + `RCON_END` 结算，
  超时返回 `null`）。修前 `ServerRcon/ServerRconEnd` 被 observer 丢弃——所有 rcon
  都是盲发。
- `set_pause` 观测后回报（无回执时明说"是否暂停未知"，不谎报成功）。
- 运行日志打印 rcon 回执：`[agent] rcon <cmd>: <reply>`。

### Added（v02 oracle baseline probe，2026-09-17）

- `pnpm run cli --v02 --add-vehicles N`：v02 在 done 后自动请求 N 辆车，
  作为"已知好的程序策略"对照基线。
- v02 RESULT 读 deliveredCargo 并写一行 metrics.jsonl（`arm=control`），
  让 oracle 与 agent 路径在 `compareArms` 里可比。

### Added（N2-4b 吞吐量指标，2026-09-17）

- `GameMetric.delivered`（`deliveredCargo`，早已解析但从未记录）、
  `ArmStats.meanDelivered/deliveredReported`、`ArmComparison.deliveredDelta`；
  verdict 标注 "least confounded outcome"。
- 为什么换：admin 的 `income` 是 **net（含负费用）**，施工期必然为负、继承 money 的
  混杂（见 SPEC §10.57 的实测分析）。

### Fixed（A/B 臂划分：以分配为准，2026-09-17）

- `SessionMeta.arm` / `GameMetric.arm`：arm 由 runner 在**分配时**记录
  （`--no-memory` = control）；`compareArms` 优先按它划分，旧记录退回启发式。
  修前：新 dataDir 的首局 treatment 因"无可注入"被算作 control（/tmp/n2ab 实际 4v6）。
- `ArmComparison.treatmentWithoutInjection` + verdict `WARNING`：treatment 臂中
  **干预没送到**的局被点名，不再静默平均。

### Added（NEXT-2 N2-4：收益流主指标，2026-09-16）

- `ArmStats.meanIncome` / `incomeReported`、`ArmComparison.incomeDelta`；
  两条 verdict 脚本打印 income。**缺读数不进均值**（不冒充 0），负收益合法。
- `session.finalize` 写入 income（来自 HUD economy）。

### Added（NEXT-2 N2-2/N2-3：经济可查、可见、可记，2026-09-16）

- `inspect_route` 工具：按 job 查线路经济；未知 job / 无读数 / 无 GS 通道
  **三种情形都明确拒绝**并说明原因。
- 每日收益要有 ≥30 天样本才报（年初 1 天样本不冒充年化）。
- 线路经济进入**每次**决策上下文（`routes`，hub 读数 × 账本 pair 连接），
  并在运行日志打印 `[agent] route facts: …` 以便验证。
- `route-facts` v2：事实带结果（vehicles/waiting/profit）；幂等键含经济读数
  （同一线路的不同观测都要留下）。

### Added（NEXT-2 N2-1：线路经济信号，2026-09-16）

- GS 每 200 tick 上报每条线路的原始读数：`route-stats {job, vehicles, profit,
  waiting, gameDate}`（当年累计利润、乘客等待）。归属按站点订单
  （`GSVehicleList_Station` + `GetOwner`），站点用`StationNear` 吸收 executor
  的 alt-site 偏移。
- `src/agent/route-stats.ts`：每日收益派生 + 事实文本化（纯函数）。
  **亏钱线路如实为负**；只有"没有车辆"才报 income unknown——不编造 0。
- signal-hub 保留每条线路的最新读数（`getRouteStats()`），**不唤醒决策**
  （每 200 tick 都变的量不是新闻）。

### Added（每局存档 + 分级结果指标，2026-09-16）

- 每局结束自动存档 `<dataDir>/save/<sessionId>.sav`（teardown 时 rcon save，
  在 metrics 落盘之后），可用 OpenTTD 15 客户端载入回看；文件名经净化。
- `ArmStats.meanStations`：分级结果指标（200s 窗口下二值 constructionDone
  被截断主导，站点数不随截断消失）。
- `compareArms` 守卫收紧：样本门槛 3→5 局/臂；money 结论要求两臂建成率**相同**
  （固定 1/3 差距阈值在大样本下看不见"一局之差"）。

### Fixed（首次有效 A/B 暴露的三个实验缺陷，2026-09-15）

- GS `ParseExecPhase` 对真机 `EX done <detail> j<N>` 相位匹配失败（要求全等
  `done`）→ 完成事件永不落地、账本与 route-facts 全部 `completed:false`。
- 实验臂计分遗漏 route facts：`MemoryInjected.routeFactsInjected` 入账，
  treatment = lessons 或 facts，control = 都没有。
- `--no-memory` 未关闭 route facts 注入 → 控制臂被注入、实验失去对照。
- `scripts/run-experiment.ts` 每局日志落盘（原先 stdio 直通终端，事后无法复盘）。

### Added（Phase C：结构化记忆 + 实验脚手架）

- `src/evolution/route-facts.ts` —— 路线事实确定性入库/注入（不经 LLM）：
  reflect-run 局终落盘、`makeRouteFactsProvider` 启动快照注入、幂等去重、
  注入句断言无策略词。
- **躺平局降权**：零下单局不产出 lesson、不写事实（反思噪声源治理）。
- `scripts/run-experiment.ts` —— 一条命令跑 A/B 矩阵 + 判定。
- `metrics.ts` ArmStats.`tokensPerDecision` + note 归一守卫
  （meanTokens 差由行动量混杂时不许声称"记忆增加 token 成本"）。

### Added（RL 反馈闭环 + 类型化信号通道）

- `src/agent/route-ledger.ts` —— 决策→结果账本：GS ack（job/townA/townB + 决策号）
  记账、执行器 done 事件回填完成事实，局终把账本行并入反思 evidence。
  实测（cal8）反思首次写出"关于选择"的 lesson（如"重复下单 9→17 浪费决策"）。
- `src/agent/estimate.ts` + `estimate_route` 工具 —— 路线造价下界（曼哈顿距离、
  £307/tile 实测道路成本、占余额比例），事实进 summary、不表态偏好。
- `session.secondsRemaining` 进决策上下文 —— 局终预算事实，防止模型睡过运行终点。

### Changed（重构：类型化事件通道 + runner 拆分，行为不变）

- **GS JSON 事件通道（REFACTOR Phase A，SPEC §10.45–§10.46）**：执行器相位经
  bridge-gs 以类型化事件（kind=exec, stage/job/hb/raw）推送、变化才发，
  "心跳"概念退役为"无事件=无变化"；harness 侧 31 字符公司名解析与
  `phaseStage/isErrorPhase/jobFromPhase` 全部退役。
- **runner.ts 拆分（REFACTOR Phase B，979→650 行）**：
  `runner-helpers`（纯工具）/ `reflect-run`（局终结算+反思）/ `signal-hub`
  （信号消费+新闻门）/ `decision-loop`（决策节拍）/ `loop-control`（纯判据），
  各带单元契约测试（+27）；结构性不变量测试改为扫描双文件。
- **执行器队列 FIFO（SPEC §10.39.1）**：newest-wins → 按提交顺序逐条建完；
  done 集合替代单调 id 假设；队列语义写入 `build_bus_route` 契约文本；
  GS err 进 audit 日志（"发送≠接受"可观察）。

### Fixed

- 相位解码器对 `hb <stage> #<n> s<signs>` 与 `rd s<n> r<n> d<dist> p<probes>`
  两种高频真机格式 detail 解析为空（golden 测试抓到；语义以 Squirrel 源为准）。
- `compareArms` 金额结论符号反转 → confounded 守卫（建成率差 ≥1/3 拒绝下结论）。

### 教育（实验结论，详情见 SPEC §10.42–§10.43）

- M3 A/B 第三次重跑（首次在已验证 harness 上）：记忆臂无收益、
  token 均值差由行动数混杂解释（"记忆翻倍 token"是归因错误）；
  失败局 lesson 是噪声源 —— 结构化记忆列为 Phase C 首项。

#### 记忆闭环 第 1 片：不变量与门槛

- `src/evolution/lessons.ts` —— lessons 的数据契约与三道闸（纯函数）：
  `normalizeLessonText()` / `lessonId()`（FNV-1a，大小写与标点不制造重复记忆）、
  `fromReflection()`（**证据为空整条丢弃**，不是降级保留）、
  `dedupeLessons()`（按 id 去重，置信度高者胜、时间断平）、
  `selectLessons()`（先去重再限量，排除被覆盖与过期的）、`formatForInjection()`。
- `src/evolution/strategies.ts` —— 策略卡片与 **SPEC §5.3 双重入库门槛**：
  `evaluatePromotion()` 要求「价值 > 阈值」**且**「已验证局 ≥ 2」，两条缺一不可；
  `mergeStrategySamples()` 跨局累积（`valuePerRun` 存**每局一个样本**而非均值，
  否则"验证过几局"无法判定）；`selectStrategies()` 只注入被人工确认的卡片。
- `src/evolution/types.ts` —— 记忆系统持久化实体的单一事实源（`Lesson` / `StrategyCard`）。
- `docs/EVOLUTION.md` —— 记忆系统的数据契约、三道闸、注入路径与反思约束。

**设计要点**：注入**默认关闭**（SPEC §5.3：进化引擎只读建议，人工确认后才全局生效）。
一个把错误教训固化进库的系统，比没有记忆的系统更糟。

- `src/evolution/store.ts` 扩展 —— `lessons.jsonl` / `strategies.jsonl`
  （与 metrics 同一套约定：append-only、按 id 收敛、单个坏行不丢整本库、
  压缩走 temp + rename）。**一处刻意不同**：lessons 读取按「更可信者胜」收敛，
  而不是最后一条胜出——追加一条低置信度重复项不应把更好的结论挤掉。
- `src/evolution/reflect.ts` —— 局终反思的 prompt 构造与**强校验**解析：
  `buildReflectionPrompt()`（system 与 user 双处声明"禁止臆测因果"）、
  `isSpeculative()`（教科书式推测措辞检测，故意收窄以免误杀 `Maytown`/`monthly`）、
  `parseReflection()`（从散文/代码块里提取 JSON，平衡括号扫描且忽略字符串内的括号）、
  `reflectToLessons()` / `reflectToStrategies()`。

**一个被测试抓到的真 bug**：`Number(null)` 是 `0`，于是模型漏写 `value`（JSON 里序列化成
`null`）会被当成"收益为 0"的**有效样本**进入门槛判定。已改为严格转换，缺失/垃圾一律拒绝
（与之前 `fmtInt(null)` 是同一类错误）。

- **记忆闭环接上线（P5）**——这是本仓库最贵的一课（AGENTS §5.1）的直接产物：
  `lessonsProvider` 从 v0.2.1 起存在了十个版本却**从未被喂过**，每一局都在完全隔离中运行。
  现在 `runner.ts` 在装配 agent 前 `loadMemory()` 一次并把 provider 传进
  `pruningTransformContext`，同时 `setMemoryInjected()` 记录**实际注入的数量**；
  局终 `finalize()` 之后跑一次反思，蒸馏出的 lessons 与策略候选落盘。
- `src/evolution/memory.ts` —— `loadMemory()` / `makeLessonProvider()` / `memoryCounts()`。
- `src/evolution/reflection-run.ts` —— `runReflection()`：调一次模型 → 解析校验 → 落盘。
  模型调用通过注入的 `complete` 完成，因此本模块不依赖 pi-agent-core，可纯单测。
- `src/evolution/reflect.ts` 增加 `buildReflectionEvidence()`：把阶段总结与动作结果
  归约成**纯事实行**（不加入任何解释——解释正是不许模型臆造的东西）。

#### 记忆闭环 P5：被测试逼出来的设计错误

- **策略门槛曾经永远不可能通过**：早期实现只把"通过门槛的卡片"写回磁盘，于是第一局的样本
  被丢弃、第二局只看到自己 → `已验证局≥2` 永远不成立。已改为持久化**完整候选池**，
  可注入性由 `selectStrategies()` 的**两道独立闸**决定（证据门槛 + 人工确认）。
- **`selectStrategies()` 没有检查证据门槛**：只要有 `enabled` 就会被注入，
  使单局样本也能成为"建议"。现已同时要求 promotion 通过。
- **反思失败不再可能连累记账**：`runReflection()` 不抛异常，且它跑在 `finalize()` **之后**
  ——metrics 是"带/不带 lessons"对照实验的地基，必须先落盘。


- **Live 页满屏 Alpine 报错**（`reading 'children'` + `m is not defined`）。
  真因与最初判断不同：`<template>` 放在 `<svg>` 内部会被 HTML 解析器当作 **SVG 命名空间元素**，
  不是 `HTMLTemplateElement`，`.content` 为 `undefined`，Alpine 的 `x-for` 读 `.content.children`
  直接抛错且循环变量永不绑定。修复：overlay 标记改为**字符串生成**（`overlaySvg()` + `x-html`），
  生成逻辑为纯函数、可单测。**副作用**：我最初的诊断（"x-for 内有两个兄弟根"）是错的，
  按它改完错误依旧——复盘见 `MEMORY.md` B2。
- **KPI 卡片里的 sparkline 在重构后消失**：模板里留着 `<canvas class="kpi-spark">`，
  但 `U.paintSparks()` 再没被调用。现在由 `x-effect="drawSparks()"` 驱动，
  且**同步**读取数据（跨异步边界读会让 Alpine 追踪不到依赖，图永远不画）。
- **`hasHistory(metric)` 忽略参数**：它查的是"当前选中的现金指标"，于是 Cash 有历史时
  "Income / yr" 也显示趋势线。改为按指标查询（`sparkSeries(metric)`）。
- **重复 `:key` 导致整段列表渲染为空**：同一 stage 帧被投递两次 → 两条 `index` 相同的记录，
  而 `index` 是 `x-for` 的 `:key`，**重复 key 让 Alpine 渲染出 0 个节点**且无任何报错。
  列表写入改为幂等 upsert（`LiveView.upsertStageView`）。

#### Added（续）：决策一次化修复

- **`MEMORY.md`** —— 跨 session 的**过程教训**记录（现象/根因/规则），
  与 `SPEC.md`（系统事实）、`AGENTS.md`（开发准则）分工正交。
- `AGENTS.md` §5.2 前端验证准则：验证必须在**代码真的执行过的状态**下进行、
  必须采集全部控制台级别（含 `warn`）、断言用户可观察的结果、
  重写动态模板后逐个交互元素人工过一遍。
- `AGENTS.md` §8 提交卫生（禁止碎片化，同一次工作的收尾用 `--amend`）；
  §9 文档职责与正交性（同一事实只有一个权威位置，其余用指针）。
- `AGENTS.md` §3.1 临时脚本一律放 `.scratch/`（已被 `.gitignore`）。
- 静态守卫 `test/unit/alpine-templates.test.ts`：页面 HTML 里 `<svg>` 内含 `<template>`、
  `x-for`/`x-if` 根元素数量不为 1、`x-for` 缺 `:key` —— 任一命中即测试失败。
- `test/unit/repo-hygiene.test.ts`：防止探针脚本再被提交进仓库。

## [0.6.0] - 2026-09-11

> **本轮的主要工作是"把实现拉回 SPEC"**，而不是加功能。审计真机 Session 日志发现，
> 之前几轮返工的根因都是**没有按 SPEC §1.1/§4.2 实现决策循环**。

### Fixed（核心：Agent 其实只决策了一次）
- **`maxTurns ?? 1` 使整局只问 LLM 一次**：模型在 1950-01-01 建一条线后再没被咨询过，
  收入一路下滑也无人补救。真机证据：三个 Session 全是 `mode=watch` + `kind=faux` +
  `decisions=0`（内置 CPU AI 在打），而面板看起来一切正常
- **轮询顺序 bug**：阶段变化靠 admin poll 发现，而 poll 曾写在决策循环**之后** →
  永远发现不到变化 → 调度器收不到 `phase_change` → 仍表现为"只决策一次"
- **删除框架层的策略引导**：旧 prompt 写"施工中就报告并结束回合"，等于替模型做决定。
  现在 prompt 只给事实与因果（并有测试禁止 `you should`/`recommend` 等措辞）
- **Live 页 `renderHeader` 引用已删除的 `#g-mode`** → 页面首屏就崩（浏览器实测发现）

### Added（决策循环，对齐 SPEC §1.1/§4.2）
- `decision-context.ts`：每次决策喂**现状 + 因果**（`sinceLastDecision`：金额/车辆变化、
  阶段列表、上次动作结果、显著事件）——没有它模型无法复盘自己动作的效果
- `scheduler.ts`：**何时问**与**问什么**分离。触发 = `start`/`phase_change`/
  `wait_until`/`interval`(每月，SPEC §4.2 默认)/`event`/`manual`；同窗口多触发**合并**
- **冻结-观察-决策-执行-解冻**（SPEC §1.1 六步）：决策前 `rcon pause`，决策后 `unpause`
- **结构化计划**（SPEC §4.2 步骤 2）：`{goal, plan[], immediate_action, wait_until, rationale}`
  ——接口由框架规定，**内容全由模型填**；`wait_until` 让模型决定自己何时再被问
- **运行控制（`--serve`）**：常驻 dashboard + `RunSupervisor`，页面可
  **开始 / 停止 / 暂停 / 恢复**；`POST /api/run/{start,stop,pause,resume}`、`GET /api/run`、
  WS 帧 `run`。被监督的 run 复用同一个 WebServer（`attach()` 晚绑定）
- **阶段画面**：`stage-view.ts` 用 GS ack 的真实 tile 坐标生成几何描述，
  前端 canvas 渲染**示意图**（每个施工阶段一张，存档 `<session>/stages/NNN.json`）
- Live 页新增运行控制条、**未接线时的明确提示**（而不是让人猜为什么面板是空的）

### Docs
- **`AGENTS.md` §5.1**：E2E 必须证明"智能真的接上了"（7 条断言），
  并规定**每次新 Session/compact 后先读 SPEC 对齐再动手**
- `docs/AGENT-LOOP-AND-CONTROL.md`：决策循环与运行控制契约，含**§2.0 偏离记录**
- `SPEC.md` §10.19：把本轮事实固化（含 dedicated server 无帧缓冲 → 无法截图的结论）

### Tests
- `test/live/agent-loop.test.ts`（新增，`@live`）：断言 `kind==="real"`、`mode==="agent"`、
  `decisions>=2`、`tokens>0`、audit 含带 trigger 的 decision 与 action_result、
  trigger 不全为 `start`、dashboard telemetry 非零、WS 推送 `telemetry`
  ——**这层测试此前缺失，正是"没接线"能溜过去的原因**
- `decision-context`(12) / `scheduler`(11) / `supervisor`(12) / `stage-view`(9) 单测
- `web-assets` 增强：同时校验 `const elX = $("id")` 这类**别名**（此前漏检）

### Added（真实画面：小地图快照）
- `src/game/minimap.ts`：`captureMinimap()` 请求 `screenshot minimap` 并**轮询 mtime**
  确认落盘后归档（固定 sleep 会归档到上一张）
- 每个施工阶段写 `<session>/stages/NNN.png`（与同名几何描述 JSON 配对），
  `GET /api/sessions/:id/stages/:n.png` 提供（仅接受 `NNN.png`，拒绝路径穿越）
- Live 页实时显示新捕获的图（WS 帧 `stageImage`），Sessions 页可回放全阶段
- 拿不到图时降级为示意图（`stage-view.ts`）

### Verified（真机，本轮）
- **真实小地图**：`screenshot minimap` → 256×256 PNG，逐阶段归档且**内容随施工变化**
  （4114/4124/4129 字节，sha 不同）；浏览器实测 `naturalWidth=256 loaded=true`，
  0 console 异常
- 决策数由 **1 → 4+**（phase_change 驱动，随运行持续增加）；`llm.kind=real`；token 正常
- `--serve` 全链路：idle → start agent → pause（server.log 有 pause）→ resume →
  stop（session 落 `aborted`）→ **不重启进程再起 watch**；重复 start 返回 409
- 浏览器实测（CDP，禁用缓存）：**0 console 异常**，运行控制条可见、
  6 张阶段示意图真实绘制（canvas 非空）、token/步骤/轮次表均有数据

## [0.5.0] - 2026-09-11

### Added (启动门禁 + Session 生命周期)
**启动前环境检查（`src/agent/preflight.ts`，`docs/STARTUP-AND-LIFECYCLE.md`）**
- **先决条件不满足就拒绝启动，且发生在任何副作用之前**（不 spawn 游戏、不建 session）
- 检查项：`binary`（存在且可执行）、`dataDir`（可建可写）、`ports`（未被占用）、
  `llmConfigured`、`llmReachable`、`gsFiles`（warn）
- **LLM 可用性做真实最小请求**：配置完整 ≠ 可用（key 可能失效、endpoint 不可达、
  模型名下线）。用 `buildBrain()` 走**真正会被使用的那条路径**，避免"检查的和用的不是同一个"
- `--offline-demo`：**唯一**允许无 LLM 运行的显式开关（UI 里标注为"非真实 LLM"）
- `--skip-preflight`：只跳过非安全项（ports/gsFiles），二进制与 LLM 检查不可跳过

**移除静默降级（本次核心行为修正）**
- 此前 `--agent` 在 LLM 未配置时**静默换成脚本化 faux**，照样启动游戏、部署 GS、建线，
  用户看到的是一次"无脑模拟"。现在**直接拒绝启动并说明怎么修**
- `runAgent()` 在无 LLM 且未显式 `--offline-demo` 时抛错（不假装在工作）

**Session 生命周期（`session-store.ts`）**
- `heartbeatAt` 心跳（runner 每 2s 刷新）+ 新状态 **`interrupted`**
- **有效状态在读取时计算**（`effectiveStatus`）：`running` 且心跳超时 15s ⇒ `interrupted`；
  读取不写盘（幂等无副作用）
- **启动时和解**（`reconcileStaleSessions`）：新进程把上一个进程遗留的过期 `running`
  写盘固化为 `interrupted`（附 `endedAt` 与原因），历史自愈
- 崩溃兜底：`uncaughtException`/`unhandledRejection` → 尽力 finalize 为 `error`；
  新增 `SIGHUP` 处理
- 前端：`interrupted` 是**独立徽章**并带 tooltip（此前会静默落成通用 warn）

### Fixed（仪表盘数据可视化）
- **Token 图表类型错误**：输入/输出/推理用三条折线，但输入约是输出的 20 倍，
  实测三条线挤在 **3px** 内（输出 y≈153、推理 y≈156），200px 画布约 60% 是空白。
  改为**堆叠柱状图**（`Charts.stackedBars`）——同时表达"每轮总量"与"构成比例"，
  带 hover tooltip（各段数值 + 占比）
- **柱状图基线非零**：`niceDomain()` 会在最小值下方留 4% 内边距，非负序列因此把 y 轴
  拉到 **-200**，柱子悬空约 30px、下方一条死区。新增 `zeroBasedDomain()`，
  柱图一律从 0 起（实测柱底 193 vs 地板 194）
- Token 面板新增：阶段汇总（peak/累计）、按轮次倒序明细表（含缓存列）

### Changed（Live 页排版）
- Agent 行高度对齐（Token 435px vs Runtime 431px，此前 382 vs 431）
- Reasoning 独立成面板并显示计数；步骤流与推理流并排（两者都会增长）
- 步骤/事件流默认行为与空态文案更明确

### Verified
- `pnpm run gate` 全绿：**200 passed / 1 skipped**
- 真机（Chrome headless + CDP）：
  - 拒绝启动三条路径实测：无 LLM / 无二进制 / 端口占用，均 `Nothing was started`，
    **未 spawn 任何进程、未写 session**
  - LLM 不可达时拒绝启动；**密钥未出现在任何输出**（`sk-` 出现次数 0）
  - SIGKILL 模拟崩溃 → 盘上 `running`；重启后 `reconciled 1 abandoned session`，
    仪表盘由 `running` 变为 **`interrupted`**；同时并存 `running`（当前）与
    `aborted`（优雅停止）三种状态各就各位
  - Token 图：柱底 193 / 地板 194（基线正确）、网格 4360px、图例与汇总正常

## [0.4.0] - 2026-09-11

### Changed (Dashboard UX 重构 — 从「极客日志面板」到可用控制台)
**Provider/Model 选择改为**「**可搜索组合框**」**（原来两个并排滚动列表，"在列表里找列表"）
- 39 provider × ~1900 model 不是"列表内容"而是"单选控件"：用户通常已知道要用哪个，
  第一交互应是**搜索**
- 键盘完整：`↑`/`↓`/`Home`/`End`/`Enter`/`Esc`；ARIA `combobox`/`listbox`/`aria-activedescendant`
- **按「Ready now / Needs a key / Cloud-OAuth」分组**，直接回答"我现在能用哪个"
- Providers 页从 `/llm` 迁到 `/providers`；旧 URL 经 `PAGE_ALIASES` 内部重写，不再 404

**Live 页按信息紧迫性重排，信息密度显著提升**
- 首屏 **KPI 条**：Cash / Income / Company value / Loan / Fleet / Tokens
  —— 大数字 + **环比 delta** + **迷你趋势线**
- Agent 区：token 构成、**失败率**、按 turn 图可切 **Tokens / Cost**、工具延迟表、
  步骤流**可过滤**（全部/LLM/工具/失败）、思考流独立面板
- 事件流：类别 chips **带计数**、**搜索**（跨 kind/类别/摘要/payload）、
  **暂停**（阅读时不被冲走）、默认**最新在前**
- 新增**图表模块** `assets/js/charts.js`：折线（网格/轴标签/**hover 十字线 + tooltip**/面积）、
  柱状（含横向 top-N）、环图、迷你线；**按 DPR 渲染**（视网膜屏不再发虚）、
  ResizeObserver 自适应、`prefers-reduced-motion` 尊重
- Sessions 页新增**两次运行对比**（Δ 列）与 token 环图

**设计系统**：`style.css` 重建为 token 化（`--c1..--c8` 图表色板、间距/圆角刻度、
三级文字），组件契约见 `docs/DASHBOARD-UI.md`
**新增交互原语**：Toast（保存成功/失败不再是一行小字）、确认对话框、分段控件、
视图偏好 `localStorage` 持久化（隐藏类别/跟随滚动/图表指标）

- `GET /api/evolution` + `POST /api/evolution/strategies/:id/enabled`
  —— 进化层只读视图与 SPEC §5.3 的人工确认闸门（本 API 唯一的写操作）。
  真机验证：读、翻转、持久化、未知 id → 404。契约见 `docs/DASHBOARD-API.md` §3.5。

- **记忆的呈现（P6 前端）**——按时间跨度切成两处，而不是二选一：
  - **Live 页新增 `Memory in effect` 面板**：显示本局**注入的内容**（不只是计数），
    零注入时明确写"nothing"（那是对照实验的控制臂，不是空白）。
  - **新增 `/evolution` 页面**：两臂对照（SPEC §5.2 #3）、跨局列表与现金曲线、
    lesson 库（含量信度/证据/来源）、策略候选池与**人工确认开关**。
  - `src/evolution/web-view.ts`：所有**规则判定在服务端**（promotion 门槛、
    arms 的 `conclusive`），浏览器只显示结论——避免同一规则两份实现后漂移。
  - `test/unit/web-assets.test.ts` 新增 `script dependency closure` 守卫。
  详见 `docs/DASHBOARD-UI.md` §5.4。

### Fixed（Providers 页保存）

- **点了 Save 毫无反应**（用户报告）。根因是**禁用的按钮看起来完全可点**：
  选中 Provider 但未选模型时 `saveReady()` 为假、按钮 `disabled`，而 CSS 没有给
  `:disabled` 任何样式（`opacity:1; cursor:pointer`），点击不发请求、不报错、不提示。
  现在：`:disabled` 有可见样式，且 `saveHint()` 按分支说明**下一步该做什么**。
- **切到 Custom 模式会继承目录 Provider 的 id**，把
  `{"source":"custom","providerId":"deepseek"}` 写进 `llm.json`（凭据归错主的混合记录）。
  两个模式的选择现在分开保存。
- **静态资源没有缓存校验**（无 `Cache-Control` / `ETag`），导致"刷新"可能继续跑旧 JS
  —— 修好的 bug 看起来没修好。现为 `no-cache` + `ETag`（未变返回 304）。
- **全新安装默认落在 Custom 端点**（`resolveLlmSource` 对空配置返回 `custom`），
  于是首次打开 Providers 是一个禁用的、要求填写 baseUrl 的自定义表单。
  空配置现返回 `catalog`——内置目录才是入口。

### Added（测试缺口）

- `test/unit/providers-save.test.ts`：**保存链路**的真实组件测试——"点 Save 发了什么请求"、
  "发不出去时用户是否被告知"。此前后端（`web-api.test.ts`）与纯逻辑
  （`saveReady()` / `saveBody()`）都被测过，**缺的正是两者之间那一段**：
  断言一个谓词 ≠ 断言一次体验。

### Fixed（用户 e2e 发现的两个问题）

- **Token Usage 图只有一种颜色，没有按 token 种类堆叠**。根因：uPlot 的
  `paths.bars` **永远从零基线画**，所以累积数据里后画的系列整块盖住先画的
  （实测 3 系列只有最后一个有像素：`{Input:0, Output:0, Reasoning:6272}`）；
  把系列反序也没用，只是换一个颜色全遮。正解是 uPlot 的 `disp` facet 给出每段的
  上下界，且**必须同时给 `y0` 和 `y1`** —— uPlot 1.6.32 的实现是
  `if (y0 != null && y1 != null)`，只给 `y0` 会被**静默忽略**（实测无变化）。
  修后逐系列像素 `{Input:4922, Output:949, Reasoning:385}`，
  纵向颜色序列自上而下 `Reasoning → Output → Input`，即正确的堆叠。
- **`add_vehicles` 谎报成功，导致 agent 无限重试**。工具无条件返回 `ok=true`
  （"命令写进 socket 了"），而这条命令在车队为 0 时**永远不可能生效**
  （执行器靠克隆头车扩容，且只在 `stage=="done"` 时读请求标牌）。
  模型因此得不到"这做不到"的反馈 —— 一个永远说谎的工具会让 agent 丧失学习能力。
  现在工具会检查 `vehicles` 并**拒绝**，附上原因与下一步。
  语义澄清见 `SPEC.md` §10.20。

### Fixed（2026-09-12 审计 + 用户报告）

- **KPI 不实时更新，必须手动刷新**。根因：`--watch` 会 `web.publishEvent(ev)`，
  而**主模式 `--agent` 从不转发事件** → 页面收不到 `event` 帧，
  公司镜像与历史永不推进，KPI 冻结在连接时的快照上。已补齐并加一致性测试。
- **Token 图改为堆叠面积图**（用户要求）。过程中否掉了两条错路，都由**像素扫描**判定：
  ① uPlot 的 `bands` API：`series` 必须是 `[from,to]` 元组（传数字被静默忽略），
  且改成元组后填充**仍然不出现**；② 仅累积数据不够——后面画的大面积会盖住前面的。
  最终方案：**倒序绘制（大者先画）+ 不透明填充到轴**，小面积覆盖其下半部分，
  于是每条系列露出的正好是自己那一段。实测（等分三等份）：纵向连续三段
  `Reasoning 100px → Output 100px → Input 70px`，无缝、无混色。
- **Harness 边界收紧**（用户明确要求：不要把经验教训内化进框架）。
  `SYSTEM_PROMPT` 曾写着"Do NOT issue the same command repeatedly"、
  "Prefer one solid route"、"add vehicles when queues grow" —— 这些是**策略**，
  等于把 agent 该自己学的教训直接告诉它。现已改为只给**世界机制**与**交互协议**。
  我上一轮给 `add_vehicles` 写的"Use observe()…only then scale"同属违规，一并删除。
  新增机械守卫：SYSTEM_PROMPT、每个工具 description、每个工具拒绝信息
  都不得出现策略措辞。
- **`add_vehicles` 谎报成功**：见 `SPEC.md` §10.20。

### Added

- 机械守卫：`test/unit/agent-runtime.test.ts` 的 harness 边界检查
  （边界定义：契约前提 ✅ / 世界事实与因果 ✅ / 交互协议 ✅ / 策略 ❌）。

### Fixed
- **阶段性总结面板恒为空（dead UI）**：Live 页读 `telemetry.checkpoints`，但该字段
  从不存在，且 checkpoint **只在 shutdown 写**。现在 `--agent` 每个 decision turn、
  `--watch` 每约 60 事件就产生一条，新增 `checkpoint` WS 帧，且
  `snapshot.checkpoints` 带全量 backlog（晚订阅/刷新也能看到）
- **阶段总结数字全是 0**：agent 模式只同步了 `events`，从未把遥测写进 session totals，
  于是"1 decisions, 1 tool calls, 0 tokens"这类假数据会长期存在 →
  新增 `totalsFromTelemetry()` 作为唯一映射点
- `live.js` 使用未导出的 `U.pickColor`（现金曲线会直接崩）→ 由门禁测试捕获并修复
- `paintSparks` 把所有迷你线画成同一条数据 → 改为按 tile 对齐

### Tests
- `web-assets.test.ts` 强化：除语法/引用外，新增 **`$("id")` 必须在同页存在**、
  **只允许使用 `window.UI`/`window.Charts` 真正导出的符号**、**前端不得持久化/回显密钥**
- `charts.test.ts`（8）：`node:vm` 沙箱加载（证明加载期不碰 DOM），覆盖刻度/定义域/
  比例尺/环图弧段/数字压缩与**退化输入不产生 NaN**
- `web-api.test.ts` 新增 checkpoint WS 帧与 snapshot backlog 用例
- `dashboard-core.test.ts` 新增「阶段总结必须反映真实遥测」回归用例

### Fixed（浏览器实测发现，CDP 逐条验证）
- **协议层符号错误**：`money/loan/income/companyValue` 是 **int64**（OpenTTD `Money`），
  却按 `uint64` 读 → 亏损公司显示 `£18446744073.71B`。新增 `ByteReader.int64()`，
  与 `SPEC.md` §10.6 一致；真机已验证显示 `-£6.0k`
- **现金曲线刷新即清空**：历史只存在页面内存，违反"服务端是真源" → 上移到
  `WorldState`（有界 600 点），`snapshot` 携带，前端 seed；真机验证刷新前后曲线一致
- **空状态图表跳高**：无数据分支跳过 `fit()`，画布停留在默认 300×200 → 空状态也按
  容器宽度设置 backing store（含回归测试）
- **迷你趋势线错位**：`paintSparks` 把同一份数据画到所有 tile → 改为按 tile 对齐
- **组合框分组失效**：选项未按组排序导致组标题重复出现 14 次 → 加 `sort` 并按
  「Ready now → Needs key → OAuth」排序
- 大数字尾部粘 delta chip → chip 移入独立行

### Verified
- `pnpm run gate` 全绿：**170 passed / 1 skipped**
- 真机 `--agent`：`/`、`/providers`、`/llm`(别名)、`/sessions` 与全部静态资源均 200；
  **运行中**（status=running）meta.json 已有 checkpoint 且数字正确
  （`1 decisions, 1 tool calls, 1,790 tokens`）；关闭后写入第二条 + 成绩单；无残留监听
- **真实浏览器（Chrome headless + CDP）**：三页 **0 个 console 异常**；
  组合框实测「输入 deep → ↑↓ → Enter」选中 deepseek，模型目录 4 条，
  环境变量就绪时显示「ready — no action needed」；`canvas` 真实绘制
  （网格线/面积/折线，非空白）；截图存档于验证流程

## [0.3.0] - 2026-09-10

### Added (Dashboard 打磨)
**多页仪表盘（无构建链，按角色分目录）**
- `src/web/public/pages/{live,llm,sessions}.html` + `assets/css/style.css` + `assets/js/{common,live,providers,sessions}.js`
- `WebServer` 导出 `PAGES` 路由表（URL → 文件，单一事实源）；`/` `/llm` `/sessions` 三个独立子页
- LLM 配置从 Live 页**解耦为独立 Providers 子页**

**多 Provider 接入（发挥 pi-ai 内置目录，不再手填）**
- `provider-catalog.ts`: 暴露 pi-ai **39 个内置 provider / ~1900 个模型**（`providers/all` 的
  `getBuiltinProviders`/`getBuiltinModels`），含 API 形态、上下文窗口、价格、认证方式
- **环境变量自动检测**：用「合成 env 探测」求出每个 provider **真正接受**的变量名
  （31/39 已解析；如 huggingface→`HF_TOKEN`、google→`GEMINI_API_KEY`、moonshotai→`MOONSHOT_API_KEY`），
  不触碰真实 process.env；剩余 8 个 OAuth/云凭证 provider 给出明确 hint
- `file-credential-store.ts`: **文件版 `CredentialStore`**（`credentials.json`, 0600），
  密钥重启不丢（pi-ai 默认 store 仅在内存）
- `provider.ts` 新增 `buildBrain()`：catalog 路径直接用 `builtinModels()` 选中模型
  （baseUrl/认证由 pi-ai 解析），custom 路径保留原 `createProvider` 行为
- `llm-api.ts` + REST: `GET|POST /api/llm`、`GET /api/llm/catalog[/:id]`、`DELETE /api/llm/credentials/:id`

**Agent 遥测（token / 思考 / 每步）**
- `telemetry.ts`: 消费 pi-agent-core `AgentEvent` → 累计 `AssistantMessage.usage`
  （input/output/cache/reasoning/total/cost），**按 turn 与按 tool 分组**，捕获
  `thinking_delta` 思考流与每步 log（含工具耗时/成功失败）
- CLI `--agent` 现在也起 dashboard（`--web-port`）；`agent.subscribe()` → 遥测 → WS（≥250ms 节流）
- Live 页新增：KPI 卡、tokens-per-turn 图、tool 统计、思考列表、Agent 步骤流、阶段性总结时间线

**多 Session（局）管理与复盘**
- `session-store.ts`: 每局落 `<dataDir>/sessions/<id>/{meta,events,audit,telemetry}` +
  `index.json`；`--watch`/`--agent` 均自动建局并在结束时写入**成绩单 + 阶段性总结**
- Sessions 页：历史局列表（状态/耗时/token/成本）+ 单局复盘

**事件呈现（从「极客 JSON」到结构化）**
- 前端 `categoryOf()` 分类 + Tag 配色 + `briefOf()` **人类可读摘要**
  （如 `£297.8k cash · loan £100k · income £1.2k`），类别过滤 chips，
  原始 JSON 保留但**默认折叠**（满足「保留原始 log 形态」）
- `scripts/llm-stub.ts` 现在按 OpenAI 规范返回 usage chunk，使 token 计量可离线验证

### Fixed
- **密钥写入后 `hasStoredKey` 仍为 false**：dashboard 保存走 pi-ai 的异步 `modify()`，
  同一 tick 内回读会 stale → 改用同步 `set/remove/has` 路径（新增 `llm-api.test.ts` 锁定）
- **重构丢掉 `providers.js` 的 else 分支**导致浏览器语法错误 → 新增
  `web-assets.test.ts`（`node --check` 全部脚本、校验 href/src 与 `window.UI` 符号）
  作为**无构建链前端**的永久门禁

### Docs
- 新增 `docs/DASHBOARD-API.md`：dashboard 前后端**冻结契约**（路由/类型/REST/WS/Tag 规则/module 契约）
- SPEC §10.16 增补真机 E2E 事实与「合并不得烘焙默认值」原则

### Verified
- `pnpm run gate` 全绿：**151 passed / 1 skipped**
- 真机：`--watch` 三页 200、WS snapshot/event、session 落盘；
  `--agent`（仅靠 llm.json，无任何 `LLM_*` env）走 REAL provider →
  `tokens: in=1738 out=52 reasoning=13 total=1790`、`tools: 1 calls, 0 failed`、
  meta.json 阶段性总结与成绩单写入。

## [0.2.0] - 2026-09-09

### Added (决策闭环 M2)
**v0.2.0 — 通信 + Executor「手」（真机验证）**
- **`src/game/squirrel/bridge-gs/`**: BridgeV1 GS —— Admin↔游戏内双向 JSON 通道 + 标牌邮箱 + `build_bus_route`/`add_vehicles` 命令；规划层选镇对（分段铺路后可到 260 tile）
- **`src/game/squirrel/executor-ai/`**: ExecutorV1 AI —— 读标牌 → 建站 → **分段贪心铺路**（解除 AyStar v6 长路死锁）→ depot → 买 bus + 订单 + 运行；`SetPhase` 公司名编码对外汇报
- **`src/game/squirrel-deploy.ts`**: Squirrel 包部署 + sandbox `[game_scripts]` 选 GS
- **`src/game/v02-runner.ts` + CLI `--v02`**: 全链路 demo（GS 心跳 → 施工 → 经济反馈）

**v0.2.1 — Pi Agent「脑」（接线真机验证）**
- **`src/agent/`（新模块）**:
  - `runtime.ts`：pi-agent-core Agent 装配（tools + convertToLlm + transformContext + before/afterToolCall）
  - `tools/index.ts`：首批 4 个 tool —— `observe` / `build_bus_route` / `add_vehicles` / `set_pause`（typebox schema，异步 ack 语义）
  - `provider.ts`：用 **pi-ai 官方 `createProvider` + `openAICompletionsApi`** 从配置装配 provider（任意 OpenAI 兼容端点）
  - `llm-settings.ts`：`<dataDir>/llm.json` 持久化 + env>file 优先级 + key 脱敏视图
  - `context.ts`：`transformContext` 历史剪枝 + lessons 注入 hook（v0.3）
  - `audit.ts`：决策/动作 **JSONL 审计**（append-only，密钥自动脱敏）
  - `loop.ts`：决策点编排（observation → prompt → tools）
  - `messages.ts`：`CustomAgentMessages` 声明合并（`game_observation` / `action_result`）
  - `runner.ts` + CLI `--agent`：真实游戏 + 脑驱动的完整闭环
- **Web Dashboard**: 新增「LLM provider」面板（Base URL / Model / API key / API 类型）+ `GET|POST /api/llm`（key 永不回显）
- **`scripts/llm-stub.ts`**: 本地 OpenAI 兼容 stub（离线端到端验证接线，非 faux）

### Fixed
- **Dashboard LLM 面板 providerId 回读不一致**: `applyLlmSettingsFile()` 会把默认
  `"openttd-llm"` 烘焙进合并结果，而 CLI 启动时已合并过一次 → watch 进程内
  `POST /api/llm` 保存后，同一进程 `GET /api/llm` 仍回旧 providerId（新起的
  `--agent` 进程正常）。现合并层不再烘焙默认值（兜底改为 `""`），默认值只在
  使用点 `buildProvider()` 应用（具名常量 `DEFAULT_LLM_PROVIDER_ID`），合并幂等。
- **Executor 长路死锁**：Pathfinder.Road v4 + AyStar v6 对 >~60 tile 单次 FindPath 不返回 → 改**分段贪心铺路**（每段 ~20 tile + probe 回退 + 末段直达目标）
- **road type 前置条件**：`BuildRoadStation` 与 pathfinder 邻居探测都需 `AIRoad.SetCurrentRoadType(ROADTYPE_ROAD)`，否则恒失败
- **depot 门未接路**：车永远卡在 depot 内 → 补 `ConnectStop(depotTile, front)`
- **站入口方向**：pax 精扫须保持 GS 给的 front 相对方向，避免 `ERR_LAND_SLOPED`
- **income 符号**：协议 u64 承载负利润 → `BigInt.asIntN(64, …)`
- **观测期轮询**：company name 变更仅轮询可见；报告路径 API 必须包 try/catch（否则静默停止汇报）

### Verified (真机)
- **手**：`boot→work→stA_ok→stB_ok→road_built(r103)→dpt_ok→dpt_conn→bus_live→done stN2 r103 bus`；`vehicles=3 stations=2`；站队列被消化
- **脑**：真实 HTTP provider（`--agent` + 本地 OpenAI 兼容端点）→ LLM 工具调用 → 命令通道 → 施工 → 经济回灌；审计 JSONL 落盘
- **单测**：90 passed / 1 skipped（含本地 HTTP stub 的真实 provider 链路测试）
- **真机 E2E**（2026-09-09）: dashboard 保存 → `<dataDir>/llm.json` → **另一进程**
  `--agent`（显式清空所有 `LLM_*` env）读到该文件并走 REAL provider、真发 HTTP、
  产生 `build_bus_route` 工具调用；`GET /api/llm` 全程不回显 key（SPEC §10.16-8/9）

### Notes
- **"盈利"验收未完成**：属带脑决策质量（选镇/投资规模），需真实 LLM + 更长观察期（见 ROADMAP v0.2.1）
- 其余 tools（`build_train_route` / `adjust_orders` / `request_reflection`）、事件镜像给 Web、决策点绑定游戏月份 → 后置

## [0.1.0] - 2026-09-08

### Added (观测闭环 M1)
- **`src/game/admin-client.ts`**: 完整 AdminClient（connect/join/subscribe/poll/rcon/gs + 状态回调 + 优雅关闭）；默认订阅 date/company/economy/stats/console
- **`src/game/world-state.ts`**: 内存权威状态（日期/公司注册表/economy/stats/环形事件缓冲）
- **`src/game/runner.ts`**: 长驻观测循环（spawn → start_ai → AdminClient → WorldState → WebServer 广播 + 周期 poll）；SIGINT 优雅关闭
- **`src/game/ai-registry.ts`**: AI 可用性探测（已知内置集 + `OPENTTD_AI_LIST` 覆盖）
- **`src/util/json.ts`**: BigInt-safe 序列化（economy 的 u64 money/loan 不丢精度）
- **`src/web/server.ts` + `public/*`**: HTTP 静态 + WS 扇出；原生 HTML+Canvas 仪表盘（公司卡片/现金曲线/事件流），无构建链
- **CLI `--watch`**: 起服 + start_ai + 长驻采集 + Web 仪表盘；`--ai`/`--web-port` 参数
- **`test/live/observation.test.ts`**: @live 真机集成（`LIVE_TESTS=1` 才跑）
- **`ws` 依赖**: 唯一运行时依赖（WebSocket）

### Fixed
- `decodeErrorText` 修正: ServerError 是单 NUL 字符串而非 cstr 对
- economy payload 的 BigInt 在 JSON 序列化崩溃（probe 无公司从未触达）—— 现在全链路 BigInt-safe

### Verified (真机)
- `rcon start_ai "CPU"` → company_new → company_info(isAi) → company_economy(poll 即时返回, money=100000 loan=100000)
- `--watch` 端到端: dashboard HTTP 200; WS snapshot + 增量 economy/date 事件（seq 单调递增）; SIGINT 优雅关闭无残留

## [Unreleased]

### 规划中 (见 ROADMAP.md)
- v0.1.0: 观测闭环（Web 仪表盘 + GS rich state）
- v0.2.0: 最小决策闭环（Executor AI + Pi Agent）
- v0.3.0: 进化闭环（lessons/策略库/metrics）
- v0.4.0: 打磨与广度

## [0.0.1] - 2026-09-07

### Changed
- **包管理器切换到 pnpm**: 移除 `node_modules`/`package-lock.json`；改用 `pnpm-lock.yaml`；
  脚本从 `npm run *` 改为 `pnpm *`；移除未使用的 `zod` 依赖；声明
  `pnpm.onlyBuiltDependencies`（esbuild）允许构建脚本。磁盘占用更小、安装更快。
  （注：pnpm 传递 CLI 参数不需要 `--`，如 `pnpm run cli --probe`）

### Added (MVP — 脚手架 + Admin Port 最小闭环)
- **工程脚手架**: TypeScript strict + ESM + vitest + eslint flat config；`pnpm run gate`（typecheck+lint+test 一键门禁）
- **开发规范**: `AGENTS.md`（TDD 先行 / 门禁铁律 / 职责与禁止项）；`ROADMAP.md`（渐进式计划）
- **Admin Port 协议层** (`src/game/admin-protocol.ts`)
  - 完整 packet 类型枚举（值对齐 `tcp_admin.h`）+ UpdateType/Frequency 枚举
  - 帧编解码（u16 LE 含自身长度前缀 + u8 type + payload；NUL 结尾字符串；LE 整数）
  - `FrameWriter` / `ByteReader` / `FrameStreamParser`（增量流式拆帧）
- **Payload 解析** (`src/game/payload-parsers.ts`, `src/game/observer.ts`)
  - OpenTTD 日历算法（raw date → y/m/d；锚点 712223=1950-01-01 已真机校准）
  - CompanyEconomy/CompanyInfo/CompanyStats/Chat/Console/GameScript/Date 规范化事件
  - `decodeWelcome` / `decodeServerRconResponse`
- **蓝图通道** (`src/game/blueprint.ts`): 高层动作 → GS 蓝图 JSON（job 0..999 / path ≤200 校验）
- **进程管理** (`src/game/process-manager.ts`)
  - 隔离 data dir；generate-then-patch 配置（绕过 OpenTTD 15 覆盖手写 `secrets.cfg` 的行为）
  - spawn/stop/日志尾/`waitForAdminPort` 探活
- **配置** (`src/config.ts`): env 驱动的全量可配（二进制/端口/seed/年份/地图尺寸）
- **CLI** (`src/cli/run.ts`): `--probe`（真机最小闭环）+ `--dry-run`
- **测试**: 40 个单测（codec golden / 日历 / 蓝图 / observer / 配置 / 进程生命周期），全绿

### Changed
- `SPEC.md` v0.2: 固化两轮源码级调研（动作面/观察模型/通信链路/GS-only 候选）；v0.0.1 完成后新增 §10.6 M0 实测结果

### Fixed / Verified (M0 实测)
- Admin listener 需要 `secrets.cfg` 中非空 `admin_password`（OpenTTD 15 将密码移出 `openttd.cfg`）
- 手写 `secrets.cfg` 会被 OpenTTD 重建清空 → 必须先生成再 patch
- headless 起服参数与日历锚点均已真机校准
- 新地图无公司属预期行为（CompanyEconomy 需公司存在才推送）

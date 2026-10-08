# SPEC — OpenTTD LLM Agent Framework

> **文档边界**（范围以 `AGENTS.md` §9 为唯一权威）：本文件是**系统是什么** +
> **已验证的系统事实**（协议字节布局、游戏机制、架构取舍 ADR）。
> **不收录**：进度/待办（→ `ROADMAP.md`）、版本历史（→ `CHANGELOG.md`）、
> 过程教训（→ `MEMORY.md`）、怎么用（→ `README.md`）。

> 状态: **v0.2 — 用户已拍板（D1-D10）+ 已固化两轮可行性调研 + M0/M1 实测闭环**
> 版本: 2026-09-08
> 作者: Pi (pi-shift-router SMART tier)

---

## 0. 目标与范围

构建一个 **Node.js / TypeScript** 单体框架，让 **LLM Agent**（基于 `@earendil-works/pi-agent-core`）能够：

1. **自主玩 OpenTTD**：接管一家运输公司，构建并运营盈利的交通网络（公路/铁路/车站/车辆/订单）
2. **自进化**：跨多局游戏，通过「记忆蒸馏 + 策略库 + 指标追踪」三种机制持续改进
3. **可视化**：Web 仪表盘实时展示进度、指标、目标达成度、LLM 推理、事件流
4. **可复现实验**：相同 seed 可重放、可对比、可审计

**边界**（本版本不做）:
- 多 Agent 竞争 / 多人游戏（D8 答案: 单 Agent 起步，架构预留）
- 外部世界地图 / 真实地理（arena 的 Google Maps 集成，非核心）
- Agent 之间经济交互（付费/市场）
- 游戏内 GUI 自动化（截图 CV 识别）—— 全部走结构化 Admin/GS/AI 通道

---

## 1. 第一性原理核心矛盾与解法

### 1.1 节拍矛盾
OpenTTD 是**连续时钟仿真**（tick 驱动），LLM 是**慢思考离散推理**（一次 1-30s）。

**解法（2026-09-17 现状，勿按旧文字实现）**: 时间可控的**默认手段不是暂停**，
而是「**快照 + 增量汇报 + 队列化动作**」：
1. LLM 收到「需要决策」信号（阶段变化 / 事件 / 间隔 / 模型自定的 wait_until）
2. **决策前**采集快照（`preSnap`）——不暂停游戏
3. 喂给 LLM；同时把**思考期间世界发生的变化**如实汇报（`sinceLastDecision`：
   金额/收入/车辆/阶段/动作/事件）——模型知道世界动过，而不是以为世界没动
4. LLM 产出结构化决策（计划 / 即时命令 / 等待条件）
5. 动作经 RCON（服务器级）或 GS 通道下发，在 executor 里**FIFO 排队**执行；
   晚到的动作仍会按序落地（§10.39.1）
6. 动作异步执行；结果事件（含 rcon 回执，§10.59）回流；需要再决策时回到 1

> **历史**：原设计确实是"决策前 `pause`、决策后 `unpause`"（冻结-观察-决策-执行-解冻）。
> 2026-09-12 因"暂停不可恢复"废除；**2026-09-17 实测推翻该归因**（§10.59：双向有效，
> 真因是 `pause_on_join=true` 且无客户端），于是冻结以**可选、已验证**的形式回归：
> `--freeze`（§10.60）。但它在本任务里**要付吞吐**——暂停期间施工也停，
> 而施工墙钟是本任务瓶颈（§10.61 实测 frozen delivered 0/5 vs unfrozen 2/5）。
> 因此**默认不冻结**；要重测决策质量必须**按游戏时间对齐**。

### 1.2 动作面矛盾（本次调研最重要的发现）
OpenTTD 有**两个动作面**，能力完全不同：

| 动作面 | 能力 | 能做什么 |
|---|---|---|
| **RCON / console** (Admin Port TCP) | 服务器级 | `pause/unpause` `save/load` `newgame` `say` `money` `start_ai/stop_ai` `exec .scr` `set` `reset_engines` `give` `reload_ai` `rescan_ai`… |
| **Squirrel AI / GS API** (游戏内) | 完整 DoCommand | `AIRail.BuildRail` `AIStation.BuildStation` `AIRoad.BuildRoad` `AIVehicle.BuildVehicle` `AIOrder.*` `AIDepot` `AITile` + 完整 Pathfinder 库 |

**关键结论**: RCON **无法**铺铁轨/建站/买车/设订单。真正「玩」必须有一个**游戏内伴生 AI**（executor）充当 LLM 的「手」；LLM 是「脑」，通过管理端口下发**高层动作指令**，由 executor 用完整 AI API 落地。

**三方独立先例验证此模式**:
- `jplattel/openttd-llm`: 外部 Python 写 `commands.nut`（**该项目的文件名，本仓库没有此文件**）到 AI 包目录 → Squirrel AI 读 → 执行 → AILog 回传
- `walter-grace/agent-openttd-arena` (15.x): Admin↔GS 双向 JSON + **GS 用 GSSign 放蓝图标牌 → executor AI 轮询 AISignList 消费**
- `OpenTTDLab`: 受控 Squirrel AI + admin port（重实验可复现）

---

## 2. 已验证的通信事实（OpenTTD 15.0）

### 2.1 Admin Port (TCP)
- 端口默认 `3977`（`openttd.cfg: server_admin_port`），当前机器已配置
- `allow_insecure_admin_login = false` → 需 **secure auth**（authorized keys 或 PAKE password）；或用 `-p`/配置开明文调试
- 协议: 长度前缀(LE u16) + type(1B) + payload
- 订阅（push）: `DATE/COMPANY_INFO/COMPANY_ECONOMY/COMPANY_STATS/CLIENT/CHAT/CONSOLE/CMD_NAMES/GAMESCRIPT`
- 频率: `POLL/DAILY/WEEKLY/MONTHLY/QUARTERLY/ANUALLY/AUTOMATIC`
- 命令: `AdminJoin/JoinSecure`, `AdminUpdateFrequency`, `AdminPoll`, `AdminRcon`, `AdminChat`, **`AdminGameScript`** (→GS JSON), `AdminPing`

### 2.2 原生观察源（无需自建）
| 源 | 内容 |
|---|---|
| `SERVER_DATE` | 游戏日期 |
| `SERVER_COMPANY_*` | 公司信息（名/颜色/总裁），economy（现金/贷款/收入/支出），stats（车辆数/货运量/利润） |
| `SERVER_GAMESCRIPT` | GS 通过 `GSAdmin.Send(table→JSON)` 推的状态（≤1450B/条），**rich state: 城镇/工业/路线/车辆/事件** |
| `SERVER_CONSOLE` | GS/AI 的 `GSLog/AILog` 输出（macOS .app 会丢 AILog → 需规避） |
| RCON poll | 需要时主动取快照 |

### 2.3 双向 Admin↔GameScript 通道（15.x 核心）
- **Admin → GS**: `AdminGameScript` 包 (JSON 字符串) → GS 收到 `ScriptEventAdminPort`, `GetObject()` 取 JSON table
- **GS → Admin**: `GSAdmin.Send(table)` → JSON → `SERVER_GAMESCRIPT` 包
- GS 只能有一个（`one GS per game`）→ 我方 bridge GS 是唯一 GS，负责: 状态推送 + admin 命令分发 + 蓝图落地为标牌

### 2.4 AI executor 与 GS 的「标牌邮箱」
- GS 放 `GSSign` 标牌（`NUTZ:bp:<job>:S/E/W/D:...`），AI 用 `AISignList()` 轮询读到 → 按蓝图执行
- 反向 (AI 状态→外部): **AILog 在 macOS .app 被丢弃** → arena 用「公司名编码」`SetPhase()` (`"Nutz <phase> j<job> r<routes>"`) + admin 轮询 COMPANY_INFO 读回；或用 GS 转发
- AI 不能直接收 admin 消息 → 一切外部命令先到 GS，GS 转标牌/事件给 executor

### 2.5 公司沙箱/API
- AI 每公司一个，`Start() { while(true){ ...; Sleep(n);} }` 循环
- 动作全部异步排队（DoCommand），错误码经 `AIEvent` + `GetLastError()`（如 `ERR_AREA_NOT_CLEAR`）
- 可选 `AICompany.SetName/SetPresidentName`；`SetLoanAmount(GetMaxLoanAmount())` 融资
- **AI 无任意文件系统访问** → jplattel 的 `commands.nut`（**该项目的文件名**）写入 AI 包目录方案需要 AI 能 `import`/`dofile` 变体（有版本/沙箱风险）；**arena 的标牌方案是干净、跨 15.x、可观测的**（每个标牌=一个可审计事实）。→ **SPEC 采用标牌邮箱为主通道**

---

## 3. 系统架构（已收敛 D1-D3）

### 3.1 拓扑

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser — Web UI (原生 HTML + Canvas, 无构建链)                  │
│  · 实时仪表盘 (经济/得分/时间线/LLM推理/事件流/地图)              │
│  · 进化视图 (指标曲线/策略库/历史局)                             │
└──────────────────────┬──────────────────────────────────────────┘
                       │ WebSocket (Server-Sent Events 也可)      D3=A
┌──────────────────────▼──────────────────────────────────────────┐
│ Agent Runner (Node.js 单进程, TS, ESM)                          │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ Pi Agent    │  │ Memory/      │  │ Evolution Engine       │ │
│  │ Core Agent  │  │ Strategy     │  │ · post-game reflection │ │
│  │ 实例         │  │ Library      │  │ · lessons 蒸馏         │ │
│  └──────┬──────┘  └──────┬───────┘  │ · strategy 模板化/检索  │ │
│         │ AgentMessage/工具          │ · metrics 记录/可视化  │ │
│  ┌──────▼───────────────────────────▼───────────────────────┐ │
│  │ Game Env Adapter (状态编码/动作编解码/事件总线)            │ │
│  │ · OpenTTDProcessManager   spawn/-D/-G/自愈/退出码          │ │
│  │ · AdminClient (TS net.Socket, 纯手写协议)                 │ │
│  │ · RCONClient / Observer  原生订阅→规范化事件              │ │
│  └──────┬─────────────────────────────────────────────────────┘ │
└─────────┼────────────────────────────────────────────────────────┘
          │ TCP Admin Port :3977 (双向)                     D1=A(直接协议)
┌─────────▼────────────────────────────────────────────────────────┐
│ OpenTTD 15.0 dedicated server (headless, 本机)                    │
│  · Company [0..n) — 我方 agent 占一家                            │
│  · Bridge GS (唯一 GS)  — 状态推送/命令分发/蓝图→标牌            │
│  · Executor AI (agent 公司) — 消费蓝图标牌, 用 AI API 施工       │
└───────────────────────────────────────────────────────────────────┘
```

### 3.2 关键组件职责

| 组件 | 职责 | 禁止 |
|---|---|---|
| **OpenTTDProcessManager** | 启动/停止/守护 dedicated server；`-c` 指向独立配置目录；seed/存档管理；崩溃自愈；干净退出 | 修改用户默认 `~/Documents/OpenTTD` 配置 |
| **AdminClient** | TS 手写 Admin Port 协议编解码；连接/认证/重连；双工事件 | 引入任何 Python 库 |
| **GameEnvAdapter** | 把 admin/GS/AI 原始事件 → 规范 `GameEvent`；把 LLM 高层动作 → GS JSON 命令 | 不在本层做 LLM 推理 |
| **Executor AI (Squirrel)** | 游戏内施工：读蓝图标牌 → `AI*` DoCommand 顺序执行 → 结果经 GS 汇报 | 不做决策；单动作失败可回滚 |
| **Bridge GS (Squirrel)** | 唯一 GS：周期 `GSAdmin.Send` rich state；收 admin JSON 命令；`GSSign` 放蓝图；转发事件/错误 | 不做决策；不碰其他公司 |
| **Pi Agent 实例** | LLM 决策循环：tools(动作), custom AgentMessage, hooks | 不直接碰 TCP/游戏细节 |
| **Memory Layer** | 跨局 lessons + 当局短期记忆注入（`transformContext`） | — |
| **Evolution Engine** | 局结束反思 → 蒸馏 lessons/策略；`metrics` 落盘 | 不做运行时主循环决策 |
| **WebServer** | WebSocket + HTTP 静态服务；把 Agent 事件镜像给浏览器 | 不持有游戏状态 |

### 3.3 目录结构

目录树与"新增文件该放哪"的规则**只有一个权威**：`CONTRIBUTING.md` §3。
此处**不再复制**（复制的副本已经腐坏过一次：曾列出 `rcon.ts` / `gs-channel.ts` /
`action-executor.ts` / `events.ts`，这些文件早已不存在或在重构中消失）。

### 4.1 为什么用 pi-agent-core
| Pi 能力 | 本项目用法 |
|---|---|
| `Agent` 类 + 事件流 | 决策循环本体；事件镜像给 Web |
| `AgentMessage` 声明合并 | 引入 `game_observation` `agent_plan` `action_result` 等自定义消息类型（UI/审计可见，经 `convertToLlm` 过滤） |
| `convertToLlm` | 只把对 LLM 有意义的 message 转出去（观察/结果摘要），避免上下文爆炸 |
| `transformContext` | 注入 lessons/策略库检索结果；剪枝历史 |
| `tools` (AgentTool) | 实际工具集（**9 个**，权威列表见 §4.3 与 `src/agent/tools/index.ts`）。`reflection` **已实现**（§10.77/§10.78）；`train`/`orders` 仍未实现 |
| `beforeToolCall` | 动作合法性预检（钱/状态/冷却），拒绝非法动作并给原因 |
| `afterToolCall` | 记录指标、审计、结果反馈给进化引擎 |
| `shouldStopAfterTurn` | 「这一 turn 结束就停」——执行器完成一轮动作后让出 |
| `steer/followUp` | 游戏中需要紧急重规划时注入 |
| session | 由本仓库的 `src/agent/session-store.ts` 持久化（每局一份）；跨局 lessons 独立存。**注意**：pi-agent-core 的 `AgentHarness` 层**未被使用**（§10.82） |

### 4.2 决策循环（细粒度）
每局定义「决策点」（阶段变化 / 事件 / 间隔 / 模型 `wait_until`）。循环:
1. Runner 在决策点**采集 rich state（不暂停，见 §1.1）** → 构造 `game_observation` 消息
2. Agent `prompt()`; LLM 产出 计划（JSON: `goal / plan[] / immediate_action / wait_until / rationale`）
3. 系统校验计划合法性 → 合法则 `unpause` 交给 executor 异步执行
4. executor 按计划施工（可能跨月）；Bridge GS 汇报每步结果
5. 到达下一决策点或「等待条件满足」，回 1

### 4.3 高层动作集（**9 个工具，唯一权威列表**）
以 `src/agent/tools/index.ts` 为准（`capabilities` 由 `src/agent/tools/catalog.ts` 派生，
并有"目录必须等于活工具数组"的防漂移断言）：

| 工具 | 作用 | 改状态 |
|------|------|--------|
| `observe` | 规范化状态切片 | 否 |
| `estimate_route` / `inspect_route` | 线路收益估算 / 现状查询 | 否 |
| `build_bus_route` | 站 A/站 B/路网/车库蓝图 → Executor 施工 | **是** |
| `set_route_vehicles` | 车队规模（`V:N` = 本线路应有 N 辆；可扩容/缩编/设为 N） | **是** |
| `retire_route` | 退役整条线路（卖车 + 注销登记） | **是** |
| `recall` | 按需检索经验库（词级匹配 + 重叠排序） | 否 |
| `set_pause` | 暂停/恢复游戏 | **是** |
| `capabilities` | 环境允许的动作目录（含只读/改状态分类） | 否 |

未实现的（`train`/`orders`）属于路线图，不在契约里；`reflection` **已实现**（§10.77–§10.78）。
工具预算：`DEFAULT_MAX_TOOL_CALLS_PER_DECISION = 12`；执行顺序 `executionMode:"sequential"`（§10.75）。

动作统一是**异步 + 可观测**：发出即返回 ack + job_id；executor 阶段事件经 GS→Admin→Runner 回灌；失败返回结构化 error code + 理由，供 LLM 反思。

---

## 5. 自进化设计（D4=C: 三机制并存）

### 5.1 局生命周期
```
新局 (seed, config)
  → 加载 policy (system prompt + lessons 注入 + 候选策略)
  → 玩到终止条件 (年份/破产/价值阈值/时间预算)
  → 结算: 记 metrics (终值/利润曲线/覆盖率/效率/LLM决策质量)
  → 反思 (LLM 复盘: 成败归因)
  → 蒸馏:
       lessons:  泛化教训 (做对/做错 + 可复用规则)
       strategy: 把「表现好的动作序列模式」模板化入库
  → 下一局 (或同 seed 对比 baseline)
```

### 5.2 三机制
1. **Memory Distillation (lessons)**: 局终反思 → 短 lessons → 语义检索 → 下局开局注入 system。带置信度/来源局，可被后续局覆盖。
2. **Strategy Library**: 把「高收益动作模板」（如 `build_bus_route` 的参数化成功模式：城镇距离/人口阈值/车型选择/扩容触发）存为 strategy 卡片；开局势检索相似上下文注入。
3. **Metrics 追踪**: 每局结构化指标 JSONL；进化引擎可跑「同 seed 对照实验」（有无 lessons/不同策略），产出对比图。

### 5.3 收敛防抖
- 每 lessons 限量、去重、带来源/时间戳
- 策略入库需通过「价值>阈值 且 已验证局≥2」
- 反思 prompt 显式禁止臆测因果（只接受游戏事实佐证）
- v0.1 进化引擎**只读建议**，规则由人类在 UI 确认后才全局生效（guardrail）

---

## 6. 可视化 (D3=A 原生无构建)

### 6.1 页面/数据
- **WS 事件流**（从 Runner 镜像）: Agent events + GameEvents + EvolutionEvents
- 视图:
  1. **总览**: 当前局/年份/现金曲线/公司价值/贷款/目标达成度进度条
  2. **时间线**: 动作事件 (build/add/pause…) 时间轴 + 结果成功/失败
  3. **LLM 推理**: 每 turn 的 thinking/plan/rationale 流式显示
  4. **进化**: 跨局指标折线对比 + lessons/策略库浏览 + 手动开关进化注入
  5. **审计**: 原始事件日志 (可筛选), 保存/回放
- 状态: Runner 持权威状态，Web 无状态只渲染；断线重连拉全量快照

### 6.2 技术
- HTTP(静态) + WS(@fastify/websocket 或原生 node:http + ws 包最小依赖)
- 前端原生 JS + Canvas：无框架、无打包；数据驱动渲染
- 一张 index.html + 少量 js/css

---

## 7. 技术选型（最终收敛 D1-D7）

| # | 决策 | 结论 |
|---|---|---|
| D1 | OpenTTD 通信 | **A. 纯 TS 手写 Admin Port TCP + 游戏内 bridge GS / executor AI（标牌邮箱）**；不引入 Python |
| D2 | 项目结构 | **A. 单 TS 包 + 清晰模块边界**（上 3.3） |
| D3 | Web UI | **A. 原生 HTML+Canvas+WS**，无构建链 |
| D4 | 进化粒度 | **C. 多机制并存**（lessons+strategy+metrics）§5 |
| D5 | 目标 | **A. 单目标起步: 到 N 年最大化公司价值**（可在 config/UI 切换为多指标面板） |
| D6 | LLM | **MiniMax-M3 主推 + 至少一个对照**（全走 pi-ai provider 抽象，首版配 deepseek/glm 任一即可；架构天然多 provider） |
| D7 | 持久化 | **JSONL（Pi 原生）+ savegame 文件 + metrics JSONL**；不引入 SQLite（除非后续跨局分析需要） |

补充决策:
| 追加 | 结论 |
|---|---|
| D8 | 多 Agent? **否（v0.1）**，但 company_id 与 runner 隔离使未来可加 |
| D9 | 一局长局 vs 短局重复? **两者都要**：CLI 支持 `--episode-length`（默认玩到 2030 或破产/价值停滞），进化靠多短局，演示靠长局 |
| D10 | Replay/录像? **是**：每局存事件 JSONL + 关键 savegame 快照；Web 可回放时间线（重放不做像素级，是结构化事件重放） |
| D11 | **Admin 认证(v0.1)**：隔离 data-dir 内 `allow_insecure_admin_login = true` + **随机强密码** + 仅绑定 127.0.0.1。不实现 secure-auth 握手（首版降复杂度；安全边界=本机回环）|

---

## 8. 鲁棒性/工程约束

1. **进程隔离**: OpenTTD 崩 → runner 存活 → 自愈重启（同 seed 续档 or 新档按策略）
2. **优雅退出**: SIGINT/SIGTERM → pause → save → flush 全部 JSONL → 关 agent → 关 server
3. **超时/重试**: 所有 admin RCON/GS 命令带超时；LLM 流式错误走 pi retry
4. **状态权威单一**: Runner 内存权威，避免双写竞态；事件带单调 seq
5. **审计**: 动作/结果/LLM 决策全落 JSONL（结构化，可 grep/回放）
6. **配置**: 单 zod schema；路径/端口/seed/模型/预算全可配；不动用户全局配置目录（用独立 `-c` 与独立 data dir 副本）
7. **测试**: unit (codec/蓝图/蒸馏/解析) → integration (真 spawn openttd→join→poll→rcon→save/load) → e2e smoke（最短可玩局）
8. **类型**: strict TS；shared event 类型是单一事实源
9. **无屎山护栏**: 每模块明确职责+禁止项(§3.2)；ADR 记录决策；复杂逻辑函数式纯函数化；LLM 交互全部走显式 schema

---

## 9. 里程碑（实施顺序）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 环境钉死** | 定位 openttd 二进制；独立 data dir + admin auth 打通；能 `-D -f` 起服务、admin join、rcon pause/save | `pnpm run smoke:env` 绿 |
| **M1 观测闭环** | AdminClient 订阅 company/date/economy/stats + GS rich state → 规范事件；Web 基础仪表盘能显示现金/年份 | 单测 + 真机 integration 绿；浏览器能看到 live 曲线 |
| **M2 最小决策闭环** | bridge GS + executor AI v0.1（bus route 施工）；Pi Agent 装配 3 个 tool；能: 观察→LLM 决定→施工→结果回灌 | e2e: 一台 1950 地图跑通第一条 bus route 并开始盈利 |
| **M3 进化闭环** | 局终结算 + 反思 + lessons 蒸馏 + 注入下局；metrics JSONL + 对比图 | 同 seed 带/不带 lessons 各 3 局可出对比曲线 |
| **M4 打磨** | 策略库、replay、UI 完善、错误自愈、文档 | 全绿 + SPEC 更新 |

**预计**: M0-M2 为首个可演示闭环（核心价值），M3-M4 为进化与打磨。

---

## 10. 已实测事实速查（本节只写「今天仍为真」的事实）

> **本节不是日记。** 2026-09-23 重写：原先 3780 行的逐轮实验叙事已按职责迁移——
> 我们改了什么 → `CHANGELOG.md`；我为什么错 → `MEMORY.md`；未完成的计划 → `ROADMAP.md`；
> 决策 ADR → `docs/*.md`。这里只留**系统事实**，每条满足三个条件：
> (1) 今天仍为真；(2) §1–§5 / `AGENTS.md` / `README.md` / `docs/*` 里没有；
> (3) 是事实（协议 / 引擎行为 / 不变量），不是「我们做了什么」。
>
> 依据一律写**代码 / 测试 / 上游源码**，不写 `/tmp/...`（临时目录，环境重建即失效）。
> **编号保持不变**，其它文档里的 `§10.x` 指针继续有效。

### 10.1 动作面（回答"Admin Port 做不到的操作怎么办"）
**仍为真**：动作面（agent 能做什么）以 §4.3 的工具集为准；环境侧的施工原语见 §10.25。

### 10.2 观察信号（回答"Admin 能否拿到全部/有价值指标"）
**仍为真**：观察信号源见 §2.2；**工具必须能观测到自己的效果，否则必须显式拒绝**（`MEMORY.md` D39/D40）。

### 10.3 GS-only 施工候选（M0 spike 验证）
**仍为真**：GS 可以公司身份施工（`GSCompanyMode`）→ §10.25；因此 GS-only 在**简单地形**上可行（§10.90）。

### 10.4 命令下发链路（三方先例收敛）
**仍为真**：主链路 = Admin → Bridge GS `ScriptEventAdminPort` → 蓝图 → Executor 施工 → GS 回报；标牌邮箱细节见 §2.4。

### 10.5 待 M0/M1 spike 实测项
**过程** → `CHANGELOG.md`（v0.0.1–v0.1）。M0/M1 spike 已完成；**仍为真的事实**：无（结论已并入 §2.5 / §10.25）。

### 10.6 M0 实测结果（v0.0.1 完成）
**过程** → `CHANGELOG.md`（v0.0.1）。**仍为真的事实**：RCON **不能**铺轨/建站/买车，真正的「玩」必须在游戏内有 AI/GS（§1.2）。

### 10.7 M1 实测结果（v0.1.0 完成）
**过程** → `CHANGELOG.md`（v0.1.0）。**仍为真的事实**：无。

### 10.8 里程碑进度
**过程** → `ROADMAP.md`（里程碑状态以那里为唯一权威）。

### 10.9 M1.5 崩溃调查（重要工程事实, 2026-09-08）
**过程** → `CHANGELOG.md` + `MEMORY.md`（A 类）。**仍为真的事实**：无。

### 10.10 v0.2 spike: 自定义 Squirrel AI/GS 加载 + 标牌邮箱（2026-09-08）
**过程** → `CHANGELOG.md`（v0.2 spike）。**仍为真的事实**：标牌邮箱 = 每标牌一个可审计事实（§2.4）；解码契约见 §10.23。

### 10.11 v0.2 spike: Bridge GS 双向通道打通（2026-09-08）
**过程** → `CHANGELOG.md`（v0.2 spike）。**仍为真的事实**：GS↔Admin 双向通道见 §2.3。

### 10.12 v0.2 实现: 标牌邮箱可见性 + 决策链路打通（2026-09-08）
**过程** → `CHANGELOG.md`（v0.2）。**仍为真的事实**：标牌可见性限制见 §2.4。

### 10.13 OpenTTD Squirrel 字符串语义（血泪教训, 2026-09-08）
**仍为真**（Squirrel 字符串语义，唯一权威）：① `s[i]` 取到的是**整数字节值**（不是单字符）；② `':'` 是整数 58（不是字符串）；③ `"7".tointeger() == 7`；④ 切分/查找用 `find()` + `slice()`；⑤ 遍历数组用单变量 `foreach (v in arr)`，双变量 `(k, v in arr)` 的第一个是**下标**。
依据：`src/game/squirrel/executor-ai/main.nut`。

### 10.14 v0.2 实现: Executor 全量施工（S2-S5, 2026-09-09, 真机）
**仍为真**（Executor 四条硬约束）：① 建站/铺路前必须 `AIRoad.SetCurrentRoadType(AIRoad.ROADTYPE_ROAD)`，否则试建恒 false（`ERR_PRECONDITION_FAILED`，寻路邻居集为空 → NOPATH）；② 巴士站出入口朝向由 `BuildRoadStation(t, front)` 的 `front` 决定，挪站址要保相对朝向；③ 车库必须 `ConnectStop` 保证门前有路，否则车**永远**卡在车库；④ 只有静停在车库内的车能卖（上游 `src/vehicle_cmd.cpp:261`）。
依据：`src/game/squirrel/executor-ai/main.nut`。

### 10.15 v0.2.1: 分段贪心铺路解除 AyStar 长路死锁（2026-09-09, 真机）
**仍为真**：长路铺设会**死锁**（见 §10.27）；解法是**分段贪心**。

### 10.16 v0.2.1 实现: Pi Agent「脑」接线 + Provider 配置（2026-09-09）
**过程** → `CHANGELOG.md`（v0.2.1）。**仍为真的事实**：Provider/LLM 配置的合并语义见 §10.93。

### 10.17 v0.3.0 实现: Dashboard 三页化 + 多 Provider 目录 + Agent 遥测（2026-09-10）
**过程** → `CHANGELOG.md`（v0.3.0）。**仍为真的事实**：仪表盘 API 见 `docs/DASHBOARD-API.md`。

### 10.18 v0.5.0 实现: 启动门禁 + Session 生命周期 + 图表语义（2026-09-11）
**过程** → `CHANGELOG.md`（v0.5.0）。**仍为真的事实**：启动门禁与 session 生命周期见 `docs/STARTUP-AND-LIFECYCLE.md`。

### 10.19 v0.6.0 实现: 决策循环对齐 SPEC §1.1/§4.2 + 运行控制 + 阶段画面（2026-09-11）
**过程** → `CHANGELOG.md`（v0.6.0）。**仍为真的事实**：决策循环契约见 `docs/AGENT-LOOP-AND-CONTROL.md`。

### 10.20 `add_vehicles` 的真实语义（2026-09-12 实测澄清）
**仍为真**：`V:<count>` 的语义 = 「本线路应当有 N 辆」（不是「再加 N 辆」）；工具已由 `add_vehicles` **更名为 `set_route_vehicles`**（双向：扩容 / 缩编 / 设为 N）。
依据：`src/agent/tools/index.ts`。

### 10.21 两个 runner 的事件转发契约（2026-09-12 修正）
**过程** → `MEMORY.md`（C 类）。**仍为真的事实**：两个 runner（`src/game/runner.ts` / `src/agent/runner.ts`）的事件转发契约由类型化事件保证（§10.45）。

### 10.22 RL Harness 范围（2026-09-12 重申并固化）
**已删除**：RL Harness 范围声明已被 §4/§5 完全覆盖；**且**曾经「harness 一局 = 一个 session 分支」的假设是错的（§10.82：`AgentHarness` 层根本没用）。

### 10.23 执行器阶段的解码契约（2026-09-12）
**仍为真**（阶段解码契约）：公司名是**唯一的运行时状态通道**，压成电报体（`EX rd s4 r27 d24 p0 j101`），上限 **31 字符**；解码以 `src/game/executor-status.ts` 为准。覆盖 / 粘滞 / 可抢占三种写法见 §10.87。

### 10.24 第二条 admin 连接不能给 GS 发命令（2026-09-12 实测）
**仍为真**：**第二条 admin 连接发 `gameScript()` 不会被 GS 收到**——GS 只读**第一条**连接的 `ScriptEventAdminPort`。要发命令必须复用那条连接。
依据：`src/game/admin-client.ts`（单连接约束）。

### 10.25 GS 可对公司施工并扣公司钱（2026-09-12 真机证实）
**仍为真**：`GSCompanyMode` 下 GS 能以该公司身份 `BuildRoad` / `BuildRoadDepot` / `BuildRoadStation` / `BuildVehicle` / `AppendOrder` / `StartStopVehicle`，**并扣该公司的钱**（真机 `probe_cm`：100000 → 70416）。
另：`GSEngineList` **必须**带 `GSVehicle.VT_ROAD`，否则报 wrong number of parameters；周期性代码块必须先确认公司在（tick ~200 时 `GSCompany.ResolveCompanyID(0)` 仍是 `COMPANY_INVALID`），且**没有订阅者时 `GSAdmin.Send` 静默丢弃**。
依据：`src/game/squirrel/bridge-gs/main.nut`；`docs/EXECUTOR-ARCHITECTURE.md`。

### 10.25.1 两条附带实测事实
**见 §10.25**（本节是其源码级证据细节；上游为 `script_companymode.hpp`）。

### 10.26 决策循环的 freeze/thaw 必须有 finally（2026-09-12 实证）
**过程** → `CHANGELOG.md`。**仍为真的事实**：冻结/解冻必须在 `finally` 里做（否则异常路径会留下暂停的游戏）。

### 10.27 执行器"假死"的真正根因：路径搜索占满单个 tick（2026-09-12 实测）
**仍为真**：执行器「假死」的真因是**单 tick 内路径搜索占满**；`FindPath(1000)` 对 >~110 tile 的曼哈顿缺口可能 **90s+ 不返回** → 约束在 ≤~60 tile 并分段铺设。

### 10.28 控制台 `pause` 是**单向**的 —— 这就是"执行器假死"的最终根因（2026-09-12 实测）
**⚠️ 已推翻**：本节曾断言「控制台 `pause` 是单向的、这是执行器假死的最终根因」。§10.59 用 rcon 回执**实测推翻**：`pause` 双向可用，假死真因是 §10.27 的路径搜索占满。**不要照本节修。**

### 10.29 执行器跑通完整公交线（2026-09-12 真机验收）
**过程** → `CHANGELOG.md`。**仍为真的事实**：Executor 能跑通完整公交线（站/路/车库/车/订单）。

### 10.30 `seconds` 从未限制运行长度（2026-09-12 实测）
**过程** → `MEMORY.md`。**仍为真的事实**：`--seconds` 曾**不**限制运行长度（墙钟预算问题），现以**模拟时间**结束一局（§10.69）。

### 10.31 M3 对照实验结果（2026-09-12，首次真实数据）
**过程** → `CHANGELOG.md`（M3 首次真实数据）。

### 10.32 第一性原理：M3 测不出差异，是因为 **agent 没有决策可做**
**仍为真**：M3 早期测不出差异，是因为 **agent 没有决策可做**（动作面太窄）；修复方向是把决策权交还 agent（§10.33）。

### 10.33 把决策权交还 agent：城镇对由它自己选（2026-09-12 实施）
**过程** → `CHANGELOG.md`。**仍为真的事实**：城镇对由 agent 自己选（它必须先看事实再决策）。

### 10.34 M3 第二次 A/B：把决策权交还 agent 之后，结果反而更差（2026-09-12）
**过程** → `CHANGELOG.md`。**仍为真的事实**：把决策权交还 agent 后**方差变大**，单轮 A/B 不可判定（§10.63）。

### 10.35 心跳被当成「变化」—— 决策循环一直在被自己的存活信号唤醒（2026-09-12）
**过程** → `CHANGELOG.md` + `MEMORY.md`。**仍为真的事实**：心跳**不是**变化——决策循环不得被自己的存活信号唤醒（那是空转）。

### 10.35.1 修复的实测结果与**尚未解决的问题**（2026-09-12）
**见 §10.35**（心跳不是变化）。

### 10.36 新闻门：phase 按**阶段**门控，而不是按字符串（2026-09-12）
**过程** → `CHANGELOG.md`。**仍为真的事实**：相位要按**阶段**门控，不是按字符串匹配。

### 10.37 新闻门之后的第一次校准跑（2026-09-12，/tmp/cal1）
**过程** → `CHANGELOG.md`。**仍为真的事实**：session horizon（以模拟时间结束）生效后信号链闭合。

### 10.38 校准跑 #2：session horizon 生效，信号链闭合；剩余阻塞点收敛到执行器（2026-09-12，/tmp/cal2）
**过程** → `CHANGELOG.md`。**仍为真的事实**：剩余阻塞点收敛到执行器。

### 10.39 NEXT-4 最小切片：执行器队列化（顺序多线路）（2026-09-12）
**仍为真**：执行器 FIFO 队列化（顺序多线路），且**调度语义属于工具契约**——库的默认值不是契约（`MEMORY.md` D27）。

### 10.39.1 修正：FIFO + done 集合 + 契约 + err 通道（2026-09-12）
**见 §10.39**（FIFO 队列的调度语义）。

### 10.40 FIFO 队列真机验证通过（2026-09-12，cal6/cal7）
**仍为真**：即使有序队列生效，**下单率本身方差极大**（5 局里可能只有 2 局真的下单）——任何 A/B 必须先承认这一点（§10.63）。

### 10.41 决策→结果账本接入反思（2026-09-12，cal8）
**过程** → `CHANGELOG.md`。**仍为真的事实**：决策→结果账本进 `audit.jsonl`（耐久）；反射用的是**局前快照**。

### 10.42 M3 A/B 第三次重跑：手眼账俱全后的首次有效对照（2026-09-12，/tmp/m3c）
**过程** → `CHANGELOG.md`。**仍为真的事实**：手眼账俱全后才算「有效对照」。

### 10.43 为什么记忆无收益：全链路审计（2026-09-12，应项目所有者质询）
**过程** → `CHANGELOG.md`。**仍为真的事实**：记忆**当初没有量到收益**——不要假设「注入记忆就会更好」。

### 10.45 Phase A2：GS 侧类型化事件中继（2026-09-12，calA2）
**仍为真**：GS→Admin 的相位/健康事件是**类型化**的（`src/game/gs-events.ts`），公司名正则已退役；新增字段必须走这条类型化通道。

### 10.46 Phase A3：harness 消费类型化事件，公司名正则退役（2026-09-12，calA3）
**过程** → `CHANGELOG.md`。**仍为真的事实**：公司名正则**已退役**，不得再作为解析手段。

### 10.47 Phase B-3：signal-hub 拆分（2026-09-12，calB3）
**过程** → `CHANGELOG.md`。**仍为真的事实**：信号中枢在 `src/agent/signal-hub.ts`，`getGsErrors()` 是通道健康的事实来源（§10.66）。

### 10.48 Phase B-4a：决策循环纯逻辑拆分（2026-09-12，calB4）
**过程** → `CHANGELOG.md`。**仍为真的事实**：决策循环的**纯逻辑**与执行体分离，纯逻辑可单测。

### 10.49 Phase B-4b：决策循环体提取（2026-09-12，calB5）
**过程** → `CHANGELOG.md`。**仍为真的事实**：同上。

### 10.50 Phase C：结构化记忆 + 实验脚手架（2026-09-15，calC1–C3）
**过程** → `CHANGELOG.md`。**仍为真的事实**：记忆是结构化观察（带实测读数），不是散文。

### 10.51 M3 第四次重跑：首次有效分臂（2026-09-15，/tmp/m3e → m3f → m3g）
**过程** → `CHANGELOG.md`。**仍为真的事实**：无。

### 10.52 每局存档（可回看）+ M3 第五/六次重跑（2026-09-15/16）
**过程** → `CHANGELOG.md`。**仍为真的事实**：每局存档（可回看）是诊断的前提。

### 10.53 NEXT-2 N2-1：线路经济事件（route-stats）——探针全绿（2026-09-16）
**过程** → `CHANGELOG.md`。**仍为真的事实**：线路经济事实（route-stats）必须可从环境查到。

### 10.54 NEXT-2 N2-2/N2-3：让经济事实可查、可见、可记（2026-09-16）
**过程** → `CHANGELOG.md`。**仍为真的事实**：无。

### 10.55 NEXT-2 N2-4：主指标换成收益流 + 标定结果（2026-09-16）
**过程** → `CHANGELOG.md`。**仍为真的事实**：主指标是**收益流**，不是成本。

### 10.56 N2-5 首轮 A/B 判废：臂划分缺陷（2026-09-17）
**仍为真**：臂划分必须按**首次真实动作**判定；否则会把 control/treatment 判反，得到「方向反转」的假结论（`MEMORY.md` D20）。

### 10.57 N2-5 有效轮次（n=5/臂，500s，/tmp/n2ab2）与两个结论（2026-09-17）
**过程** → `CHANGELOG.md`。**仍为真的事实**：无。

### 10.58 N2-5 oracle 探测：任务梯度成立（2026-09-17）
**过程** → `CHANGELOG.md`。**仍为真的事实**：任务梯度成立（车队规模 ↑ → deliveredRun ↑），但会**饱和**（§10.72）。

### 10.59 工具必须能观测自己的效果：rcon 回执通道 + 两个实测事实（2026-09-17）
**仍为真**：工具必须能观测自己的效果 → 加了 **rcon 回执通道**；并实测两件事：`pause` **双向**可用（推翻 §10.28）、控制台回执可作事实来源。

### 10.60 已验证的冻结（`--freeze`）：重新引入暂停，但这次可观测（2026-09-17）
**过程** → `CHANGELOG.md`。**仍为真的事实**：`--freeze` 是可观测的冻结（重引入暂停，但这次有回执）。

### 10.61 冻结 vs 不冻结：机制成立，但在本任务里**冻结要付吞吐**（2026-09-17）
**仍为真**：冻结机制成立，但在本任务里**冻结要付吞吐**——测量窗口内暂停会减少模拟时间。

### 10.62 NEXT-2 收尾：首个干净判据的 memory A/B —— 方向有利，但 n=5 不足以判定（2026-09-17）
**过程** → `CHANGELOG.md`。**仍为真的事实**：n=5/臂**不足以判定**（首个干净判据的 A/B 方向有利但 CI 含 0）。

### 10.63 校准轮（900s）：**窗口是方差的主因**，实验设计随之改变（2026-09-18）
**仍为真**：**窗口本身是方差的主因**（900s 校准轮）；实验设计因此改为按**模拟时间**与**顺序检验**。

### 10.64 顺序检验 block #1（n=5/臂，900s）：CI 含 0 → 续跑；但诊断指向**设计**而非样本量
**过程** → `CHANGELOG.md`。**仍为真的事实**：顺序检验 block #1 的 CI 含 0 → 问题在**设计/样本量**，不在臂。

### 10.65 流量指标的**测量缺陷**：`deliveredCargo` 是当季计数器（2026-09-18）
**仍为真**（测量缺陷，最常咬人）：`ServerCompanyEconomy.deliveredCargo` 是**本季度已运出**的计数器，**每季度归零**（u16）。所以 `deliveredRun` 是**跨季积分**，`deliveredRunComplete=true` 表示整段无 gap；两臂必须同源，否则回落到 `raw` 并标 `ArmComparison.deliveredSource`。
依据：`src/game/delivery-meter.ts`、`src/evolution/metrics.ts`；教训 `MEMORY.md` D14。

### 10.66 GS 通道的**部分失效**：`GSStation.IsStationTile` 不存在（2026-09-18）
**仍为真**（GS 通道会**部分**失效）：`GSStation.IsStationTile` **不存在** → 用 `GSStation.IsValidStation(id)`；判据是 `signalHub.getGsErrors()`（`GameMetric.gsErrors`）。通道健康**必须在收益声明之前**打印。
依据：`test/unit/squirrel-api-guard.test.ts`、`src/agent/signal-hub.ts`；教训 `MEMORY.md` D15。

### 10.67 校准 #2（修好仪器后）：**仪器缺陷不是方差来源**，且发现"工具暴走"局（2026-09-18）
**过程** → `CHANGELOG.md`。**仍为真的事实**：修好仪器**不**减少方差（仪器缺陷不是方差来源，`MEMORY.md` D16/D17）——方差来自 LLM 采样本身。

### 10.68 **测量单元本身不可比**：墙钟预算 → 可变模拟时间（2026-09-18）
**仍为真**（测量单元不可比）：墙钟预算 → **可变模拟时间**；< **180 游戏日**的窗口量的是常数，不可比。`MIN_COMPARABLE_HORIZON_DAYS = 180` 与 `horizonIsComparable()` 使 `run-experiment.ts` 跑**之前**就拒跑。
依据：`src/evolution/metrics.ts`；教训 `MEMORY.md` D18。

### 10.69 G1 落地：局以**模拟时间**结束（2026-09-18）
**过程** → `CHANGELOG.md`。**仍为真的事实**：一局以**模拟时间**结束（G1）。

### 10.70 G3 落地：车队请求的**静默无效**变成可观测的拒绝（2026-09-18）
**过程** → `CHANGELOG.md`。**仍为真的事实**：车队请求的**静默无效**已变成**可观测的拒绝**（`fleet_unknown<job>` / `fleet_retired<job>`）。

### 10.71 G2 落地：把"决定结局的那个过程"变成 agent 能看见的事实（2026-09-18）
**过程** → `CHANGELOG.md`。**仍为真的事实**：「决定结局的那个过程」必须变成 agent 能看见的事实。

### 10.72 S0 oracle 梯度：**杠杆存在，但会饱和**（2026-09-18）
**仍为真**：车队杠杆**存在但会饱和**（oracle 梯度：9/15/21 辆 → deliveredRun 1088/1511/1598）。

### 10.73 S1/G4 落地：预建场景（施工移出测量窗）（2026-09-18）
**过程** → `CHANGELOG.md`。**仍为真的事实**：预建场景把施工移出测量窗（S1/G4）。

### 10.74 与 pi-agent-core 的协同设计（ADR，2026-09-18）
**ADR** → `docs/AGENT-LOOP-AND-CONTROL.md`（与 pi-agent-core 的协同设计；本节决策摘要已迁到那里）。

### 10.75 R1 实施结果：执行顺序 / 工具预算 / 缓存与**披露路径**（2026-09-18）
**仍为真**（披露路径必须有）：`metricStat` / `formatMetricStat` / `degradationStats`；所有 verdict 行**先**打印通道健康，**再**打印收益。执行顺序 `executionMode:"sequential"`，工具预算 `DEFAULT_MAX_TOOL_CALLS_PER_DECISION = 12`。
依据：`src/evolution/metrics.ts`、`src/agent/decision-loop.ts`；教训 `MEMORY.md` D28。

### 10.76 R2 实施结果：经验 = 带实测读数的观察（2026-09-18）
**仍为真**：经验（`Lesson`）必须带**实测读数**：`outcome:{metric,before,after}`；撤回（retraction）在去重时优先。
依据：`src/evolution/lessons.ts`；教训 `MEMORY.md` D29。

### 10.77 R2b 实施结果：反思改走 Agent + 记录工具（2026-09-18/19）
**仍为真**：反思复用**同一个 `Agent`** + 记录型工具（`src/evolution/reflect-tools.ts`），带 `validateLesson()`；入口 `runReflection({streamFn, model, dataDir, facts, now})`。
依据：`src/evolution/reflect-run.ts`；教训 `MEMORY.md` D31。

### 10.78 M1：反思产出率变成可诊断、可重试、可披露的事实（2026-09-19）
**仍为真**：反思产出率是可诊断事实——审计里 `type:"reflection"`，`MAX_REFLECTION_ATTEMPTS = 2`，统计在 `src/evolution/reflection-stats.ts`（`zeroCallRuns` / `failedRuns` / `firstError`）。**重试从未被观测到触发**（诚实缺口）。

### 10.79 M2：把计分规则作为事实写进提示词（2026-09-19）
**仍为真**：**计分规则要作为事实写进系统提示词**（`SYSTEM_PROMPT`），并用 `assertNoStrategy` 守住「提示词不得含策略」这条边界。

### 10.80 M3 能力盘点：环境到底允许 agent 做哪些动作（2026-09-19）
**仍为真**：环境允许 agent 做的动作 = §4.3 的 **9 个工具**；GS 侧 7 个命令；executor 支持 5 种标牌类型；**唯一「操作杠杆」是 `V:<count>`**。
依据：`src/agent/tools/index.ts`、`src/game/executor-status.ts`。

### 10.81 M3-1 真机结果：车队杠杆**被阶段门控**（探针证伪源码推断，2026-09-19）
**仍为真**：车队杠杆**被阶段门控**——只有 `_stage == "done"` 且已有车时才生效（源码推断曾被探针**证伪**：`--shrink-to 4` 当时无效）。**源码推断必须由探针确认**（`MEMORY.md` D34）。

### 10.82 第一性原理复检：能力面、空缺与协同结论（2026-09-19）
**仍为真**：**`AgentHarness` 层完全未被使用**（`grep -rn AgentHarness src/` = 0）——pi-agent-core 的这部分对本项目是死代码，勿据此设计。
另（决策带宽事实）：中位 **6 次决策/局**，**76% 的工具调用是只读** → 当前 agent 是**监督者**，不是玩家。
依据：`scripts/loop-health.ts`；教训 `MEMORY.md` D35。

### 10.83 G6 实测：单次请求峰值 5–7k tokens ⇒ **不需要上下文压缩**（2026-09-19）
**仍为真（决策记录）**：单次请求峰值 **5188 / 7324 tokens**（60 游戏日），模型上下文余量 >10× ⇒ **不需要上下文压缩**。指标 `usage.peakRequest`。

### 10.84 M3-1b：车队杠杆真正的两处缺陷，与"缩编必须先进车库"（2026-09-19）
**仍为真**（三个必修事实）：① `foreach (k,v in array)` 的第一个是**下标**（§10.13）；② **只有静停在车库里的车能卖**（§10.14）；③ 缩编是**跨 tick 状态机**（`ProcessFleetSells`，先进车库再卖）。
依据：`src/game/squirrel/executor-ai/main.nut`；教训 `MEMORY.md` D36/D37。

### 10.85 第一性原理复审：离"自主 + 自进化地玩"还差什么（2026-09-19）
**仍为真（第一性原理复审的结论）**：① 判据必须可比 → §10.68 的 180 天；② 决策带宽 §10.82；③ 当时的缺口是**没有选择压力、没有按需检索、没有退役**（后两者已补：§10.86 / §10.89）。

### 10.86 M3-2a：每线路登记表 + **退役**（2026-09-19）
**仍为真**：executor 侧维护**每线路登记表** `_routes[job]`；`retire_route` 会卖掉整条线路。

### 10.87 M3-2b：披露粘滞——让事件相位真的被采样到（2026-09-19）
**仍为真**（披露粘滞）：公司名是**被采样**的单值通道，所以有 `SetPhase`（覆盖）/ `SetPhaseSticky(p, hold=15)`（持久）/ `WritePhase`（可被 `exc:` 抢占）三种写法——**「动作执行了但汇报丢失」是一类真缺陷**（`MEMORY.md` D39/D40）。

### 10.88 M3-2c：车队请求对**已登记的旧线路**生效（2026-09-19）
**过程** → `CHANGELOG.md`。**仍为真的事实**：车队请求对**已登记的旧线路**也生效（`FleetTarget(job)` / `SaveFleetTarget`），且三处登记点都带 `applied` 字段。

### 10.89 M4a：`recall` 按需检索——并第一次量到"记忆被用了"（2026-09-19）
**仍为真**：`recall` 用**词级匹配 + 重叠排序**（纯 substring 对自由文本命中率为 **0**）；排序按不同词数。检索是**增量**的，不替代开局注入（保持可比性）。
依据：`src/agent/tools/recall.ts`；教训 `MEMORY.md` D42。

### 10.90 决定性事实：**Bridge GS 单机可完成整个巴士闭环**（2026-09-19）
**仍为真（决定性）**：**Bridge GS 单机即可完成整个巴士闭环**（站/路/车库/引擎/买车/订单/启动；真机钱 100000→70416）。因此 action bus 是**单车道**（一个 VM、一张分发表）。
依据：`src/game/squirrel/bridge-gs/main.nut`（`probe_cm`）；`docs/ACTION-BUS-CODESIGN.md`；教训 `MEMORY.md` D43。

### 10.91 AB-1：`capabilities()` —— agent 第一次能**问**环境它有哪些动作（2026-09-19）
**仍为真**：`capabilities` 是**第 9 个工具**，目录**由活的工具数组派生**（防漂移断言）；`TOOL_GATES` 把「原因 + 谓词」绑在一起；`ACTION_EFFECTS` 区分只读 / 改状态。TS 侧发出的每个 `cmd` **必须**有 `Dispatch` 分支（否则 GS 回 `unknown cmd`）。
依据：`src/agent/tools/catalog.ts`；`test/unit/action-surface-panel.test.ts`。

### 10.92 AB-4a：GS 自建 + 自运营线路（NEXT-4 验收）—— 决定性事实（2026-09-19）
**仍为真**：**GS 每 tick 异步建设**——瓦片要下一两 tick 才生效，所以必须有 `settle` 阶段（观测到车动了才算 `run`）；**同城两站之间运 0 货物**（旅客要去别的城镇）；任意寻路是 A* 范畴 → **Executor 不退役**。
依据：`probe_route_cm`；`docs/EXECUTOR-ARCHITECTURE.md`；教训 `MEMORY.md` D44。

### 10.93 `--serve` 的 Start 必须用**当前**的 `llm.json`（2026-09-22 回归）
**仍为真**：`--serve` 的 Start **每次**都要重新读 `<dataDir>/llm.json`（不是 boot 时的快照）；`applyLlmSettingsFile(cfg)` 是幂等的唯一合并者，`cfg.llmAppliedFrom`（`env`|`file`|`none`，**粘性**）由它写入。
依据：`src/agent/llm-settings.ts`；教训 `MEMORY.md` D46。

### 10.94 Live 页面运行期的**滚动失控**与**版面失控**：机制与修法（2026-09-22）
**⚠️ 部分推翻**：本节曾把「Live 页面纵向伸缩」归因为 uPlot + `aspect-ratio` + `.snap-img { max-height }`。
- **`max-height` 那条是错的**：它破坏了快照的正方形（叠加层 `preserveAspectRatio="none"` 会拉伸、底图按宽度缩放 → 标记与地图错位），**已回退**；
- 滚动锚定、列表上限、`sameEventList` 等**仍是有效修复**（见 `docs/DASHBOARD-UI.md` §8 契约）；
- 但**用户报的「纵向爆炸」另有真因** → §10.95。

### 10.95 图表渲染路径：三个真因与"图表健康"断言（2026-09-22）
**⚠️ 纠正后的真因**：
- uPlot 侧三个真缺陷（构造时宽度为 0 / `LEGEND_RESERVE_PX` 未声明导致每帧 `ReferenceError` / `.u-legend{flex-wrap}` 对 `<table>` 无效）**确实存在且已修**，但它们**不是**「Result 栏纵向爆炸」的原因。
- **真因**：KPI 迷你图 `Charts.fit()` **回读自己写进去的 `canvas.getAttribute("height")`**，而那是 `cssH × devicePixelRatio` → 每帧乘一次 dpr。**dpr=1（所有 headless 探针）增益为 1 → 看起来恒定；dpr=2（用户是 Retina）→ 26→52→104→208→… 几千像素**，元素重建时复位 → 「往复」。
- 修法：尺寸只从样式/布局取（`cssBoxHeight` / `cssBoxWidth`，**永不回读属性**）；`SPARK_H = 26` 为常数；图表高度改**固定值**（删掉视口耦合）。
- 验证：`pnpm run dashboard:smoke` 现在**复现 dpr=2** 并做**时间序列**断言（10s × 20 次，高度极差 ≤ 1px）。
依据：`src/web/public/assets/js/charts.js`；`test/unit/charts.test.ts`（重放 `[52,104,208,416,832,1664]`）；`scripts/dashboard-smoke.mjs`；教训 `MEMORY.md` D48/D51。

### 10.96 长跑实测（2026-09-23：5.7 小时 / 90 决策 / 3.26M tokens）

在**真实长程**（`20260923-081950-seed1360217681`，1950-01 → 1952-06，地图 256²，MiniMax-M3）
上量到的事实。短跑（60 游戏日）的结论**不可外推**到长跑。

| 事实 | 读数 | 含义 |
|------|------|------|
| **agent 能亲手结束自己的 episode** | 最后一次决策（turn 90）的动作就是 `set_pause` → 游戏冻结，**此后 5 小时循环再没跑过** | 这是真实的"死局"：暂停后没有游戏日期推进 → 没有 event/interval 触发 → 循环静默停摆。**必须让"谁让它停的"成为可查事实**（已加 `pausedBy`/`pausedAt` 与快照 `control` 字段） |
| **写工具只报"请求"会诱发空转** | 线路 100 被调车队 **32 次**；`retire_route` 对同一 job 重复 **5–7 次**（103/104/105/106），回执停在 `retire_unknown<104>` | "已退役"与"未知线路"在文本上无法区分，agent 只能重试。**空转的代价是 turn**（它把最后 20 轮都花在这里） |
| **长跑上下文会增长 ~4×** | 单次请求峰值 **24,624 tokens**（turn 38；短跑实测 5,188–7,324） | §10.83 的"不需要上下文压缩"是**在 60 游戏日上量的**，**对长跑不成立**——长跑的输入累计 2.48M tokens |
| **过度扩张 → 收缩是真实的策略学习** | 车辆 48 → 9；年收入 −267k → **+101k**；车队操作 50 次缩编 vs 14 次扩容 | 早期建 9 条线后现金跌到 £32,913，随后它自己发现并收缩到盈利。**这是自发的 credit assignment**（无人教它） |
| **首个财年结束后公司价值才真实** | 早期 `old_economy[0] = 1`（占位）；1952 年实测 `companyValue = £12,021`、`deliveredCargo = 493` | 验证 §10.95 的 `companyValueKnown` 判定：越过首财年后数字自然出现 |
| **车辆/站点类型分布早就在快照里** | `stats.breakdown {bus:9,…}`、`stationBreakdown {bus:8,…}` | 仪表盘"没有线路类型"不是数据缺失，是**没显示** |
| **本次长跑**没有**跨局记忆** | `lessonsInjected: 0`，`recall` 两次命中 0 | 0 命中是**正确**行为（库为空），不是匹配缺陷；跨局学习需要**多局**（M4b/M5 的前提） |
| 6 个文件、3 名参与者的运行时小样本 | — | — |

### 10.97 uPlot 1.6.32 的交互事实：`setScale` 不可依赖，视野必须直接写（2026-09-23 实测）

图表加缩放/平移/复位时，连续四轮"修好了"都是假的。逐条量下来，**uPlot 在这条路径上有
三个反直觉行为**，而它们合起来会让"点了没反应"看起来像玄学。事实以 vendored
`uPlot.iife.min.js`（1.6.32，与 npm 字节一致）与 `node_modules/uplot/dist/uPlot.esm.js`
源码为准，结论用**像素哈希**验证（同一张静态图，600 ms 后比对 canvas 数据）：

| 事实 | 依据（源码行） | 真机表现 |
|------|----------------|----------|
| **`setScale(key,{min,max})` 不保证生效** | 它只做 `pendScales[key]=opts; shouldSetScales=true; commit()`；微任务里 `setScales()` 应用后**清空 `pendScales`**，随后的重画又按数据回贴 | 点 `＋` **画面像素完全不变**（而状态曾短暂显示"已缩放"） |
| **`setData(data)` 默认重置 scales** | `uPlot.d.ts`：`setData(data, resetScales = true)`；实现里 `_resetScales !== false` 时 `_setScale(xScaleKey, …)` | 用户缩放后，**每一帧数据到达都会把视野擦掉** → 缩放等于不存在 |
| **`redraw(false)` 是 no-op** | `redraw(rebuildPaths)`: `rebuildPaths !== false` 才 `_setScale(x, scales.x.min, scales.x.max)`，否则只 `commit()`；没有 setScales 标志时 `commit()` 不重画 | 状态改了（`isZoomed` 为 true）但**画面没变** —— 比第一种更难发现 |

**有效配方**（像素级验证通过）：
```js
inst.scales.x.min = min;          // 直接写，绕开 pendScales 的生命周期
inst.scales.x.max = max;
inst.redraw();                    // 无参 → 用刚写入的极值重画（不能传 false）
inst.__zoomedByUser = true;       // 让数据帧走 setData(data, false)，视野才保得住
```
四条交互的实测结果（静态图 + 像素哈希）：`＋` 缩放后 **1.5 s 内每帧都稳定**、
`⟲` 还原到**与初始像素完全一致**、滚轮按指针位置为锚缩放、拖拽平移（需先缩进去——
全量视野本来就无处可平移，那是正确行为不是缺陷）。

**另一条必须记住的渲染事实**：uPlot 的**轴刻度与标签不在 DOM 里**。
`.uplot` 只有两个子元素（`.u-wrap`、`.u-legend`），`.u-axis` 容器**没有子节点**，
全库也没有 `.u-tick` 这个类名（`uPlot.min.css` / `uPlot.iife.min.js` 里都不存在）。
⇒ 任何"有没有刻度"的断言**不能靠 DOM 计数**，只能看截图或像素。

**公开 API 的一致性要求**：图表适配层的缩放 API 必须统一收**宿主元素**（`resetZoom(el)`、
`zoomBy(el, …)`、`isZoomed(el)`）。曾导出过收**实例**的 `isZoomed(inst)`，而调用方按元素
传入 → **恒返回 false**，探针与冒烟测试据此得到过"没有缩放"的假结论。

### 10.98 城镇与存档：两条"数据一直在、只是没送到页面"的通道（2026-09-25 实测）

| 事实 | 依据 | 含义 |
|------|------|------|
| **Bridge GS 的状态上报同时带"总数"与"取样"** | `bridge-gs/main.nut`：`GSAdmin.Send({cmd="state", towns = tlist.Count(), town_list = <人口前 10, 按人口降序>})` | 页面可以说"largest 10 of N towns"；**取样 ≠ 全图**，两者必须分开显示 |
| **`world-state.ts` 早就有 `TownInfo[]`，但快照从不带它** | `toWireSnapshot()` 只发 `{date, companies, totalEvents, recent, routes, routesAvailable}`；`snap.towns` 被丢掉 | 城镇面板此前**永远为空**，而 agent 自己能看到城镇（它从 `world` 读）——页面与 agent 看到的世界**不一致** |
| **真人验证（本轮）** | 自建 agent 运行（隔离端口/数据目录）：GS 报 `towns=24–25`，快照 `towns: 10 / townsTotal: 25 / townsAvailable: true`，面板渲染 10 行、0 控制台条目 | 通道端到端可用 |
| **存档路径约定：`<dataDir>/save/<sessionId>.sav`** | `runner.ts` 收尾执行 `rcon save ${savegameName(session.id)}`；真机日志 `Map successfully saved to '20260925-100825-seed1392029491.sav'`；磁盘上 `/tmp/openttd-agent-data/save/20260923-163902-seed1973692307.sav`（84,112 B）确实存在 | 页面据此显示"可载入审核"的路径；**存在性**单独报告（"还没写档"≠"路径未知"） |
| **本仓库协议层没有产业/城镇的 admin 包解析** | `admin-protocol.ts` 中没有 `INDUSTRY_*` / `CARGO_ACCEPTANCE` / `TOWN`；产业数据目前无处可取 | 想加 "物资/产业"面板必须**先开一条通道**（GS 侧或 admin 解析），见 `ROADMAP.md` §6d |

**样本量与总量必须分开渲染**（本节的通用规则）：GS 出于载荷只发前 10 个城镇；
把 `towns.length` 当作"地图城镇数"、或把样本人口求和当作"全图人口"，都是编造事实。

### 10.99 数据的唯一来源边界：admin 端口**没有**产业/城镇/车辆，只有 GS 有（2026-09-25 核对）

要回答"城镇/物资/车辆数据从哪来"之前，必须先钉死**每条通道的能力边界**。
以下三项事实来自：官方文档枚举页、OpenTTD `master` 源码枚举、本仓库枚举，
以及**对本机 OpenTTD 15.0 的实测**（连自己的 dedicated server 读 `SERVER_PROTOCOL` 广告）。

| 事实 | 证据 | 后果 |
|------|------|------|
| **admin 端口的更新类型只有 10 种**：`DATE, CLIENT_INFO, COMPANY_INFO, COMPANY_ECONOMY, COMPANY_STATS, CHAT, CONSOLE, CMD_NAMES, CMD_LOGGING, GAMESCRIPT`（+`END` 哨兵） | `docs.openttd.org` 的 `tcp_admin.h` 枚举页；GitHub `master` 同一枚举；本仓库 `admin-protocol.ts`（`Gamescript = 9` / `End = 10`，包类型到 `ServerEnableEncryption = 129`）；实测广告协议版本 **3**，最大 `update_type` 仍在 `GAMESCRIPT` 量级 | **产业、货物、城镇、车辆数据在 admin 端口不存在** —— 不是"我们没解析"，是**协议里没有**。公司级事实（economy/stats/breakdown/deliveredCargo）仍从 admin 拿 ✓ |
| **曾误判"我们的枚举过期、缺 INDUSTRY/CARGO"** | 同一批证据 | 我们的枚举**是当前的**。教训与 D53 同源：**先核对再断言** |
| **主线 console 没有按产业/城镇输出统计的命令** | 官方 console 命令表里与货相关的是枚举型 `dump_*`（如 `dump_cargo_types`，只列货种）；能按产业/城镇出统计的命令在官方 wiki 上位于 `/Community/Patches/`（**社区补丁**） | rcon/console 不是数据通道（次要项 `rcon cmds` 回包**未实测**） |
| **唯一能取到这些数据的是 Game Script（Squirrel）** | GS API：`GSIndustry.GetStockpiledCargo / GetLastMonthProduction / GetLastMonthTransported / GetLastMonthTransportedPercentage`、`GSTown.GetPopulation / GetCargoProduction / GetLastMonthProduction / GetLastMonthTransportedPercentage`、`GSVehicleList`/`GSVehicle` | GS 只在 **agent 模式**存在 ⇒ **watch 模式下这些数据一律不可得**（必须显示"不可得"，不能显示 0） |

**两个"利用率"不是一回事（呈现前必须分开）**：

| 口径 | 取值 | 语义（源码依据） |
|------|------|------------------|
| **产业口径** | `GSIndustry.GetLastMonthTransportedPercentage(industry, cargo)` | 读的是产业**上月产量的历史**（`script_industry.cpp` 取 `produced[LAST_MONTH].transported`） ⇒ **所有公司**合计运走的比例。**不是**本公司的成绩 |
| **公司口径** | `GSCargoMonitor.GetTownDeliveryAmount / GetIndustryDeliveryAmount / GetTownPickupAmount / GetIndustryPickupAmount(company, cargo, id, keep_monitoring)` | 返回**自上次查询以来**的量并**更新监视状态**（`cargomonitor.h`：get **and reset**） ⇒ **本公司**实际交付/取货量；**非幂等**，只能在 GS 内读一次并累计上报，页面不得直接查 |

**规则**：同一面板里"产业利用率"与"本公司运量"必须**分块并各自标注口径**；
所有这类字段都是**上月经济月**口径（`ScriptEconomyTime`），不是实时值，必须标注。
具体选型与呈现方案见 `docs/DATA-CHANNELS-EVALUATION.md`；实施计划见 `ROADMAP.md` §6d。

### 10.100 P1+P2 实测：产业/货种/公司交付量（2026-09-25 真机）

按 `docs/DATA-CHANNELS-EVALUATION.md` 的选型落地的**线上形状**与真机读数
（自建 agent 运行，隔离端口 + 数据目录，offline demo）：

| 事实 | 证据 |
|------|------|
| **GS 上报原始计数，比率由前端派生** | `cmd=state` 新增字段：`industries`(总数) · `industry_list`(按产量取样 top-12：`{id,cargo,name,produced,transported,stock}`) · `cargo_totals`(按货种聚合 `{label,produced,transported}`) · `own_delivered`(本公司 monitor 累计 `{label,amount}`) · `own_quarter`(游戏季度总量) · `own_monitored`(`{towns,industries}`)。真机：`industriesTotal=49..52`、`industry_list=12`、`cargo_totals=6`、`own_monitored={towns:20..23, industries:49..52}` |
| **重活节流**：事实每 1000 tick 重算一次（心跳仍 200 tick） | `bridge-gs/main.nut` 的 `_facts_tick + 1000 < now` 门；载荷形状恒定（不用条件建键 —— D44 的规避方式） |
| **monitor 必须 `keep_monitoring = true`** | 语义是"读取即重置"（`cargomonitor.h`）：传 `false` 会静默丢掉这段增量。守卫测试锁死两次调用 |
| **监视覆盖全部城镇与全部产业** | GS 侧把 `GSTownList()`/`GSIndustryList()` 物化成 id 数组后逐对轮询；真机 `own_monitored` 与地图上的数量一致 ⇒ 交付量**不是**不明子集 |
| **货种标签是定长 4 字符**（`OIL_`） | 真机面板最初显示 `OIL_`；前端归一化后为 `Oil`（`GetName` 是本地化字符串，官方明确不作玩家可见文案） |
| **产业名截断会留尾空格** | 真机 `"Chedingworth Falls Coal "` → GS 侧 `Trim(slice(0,24))` 后为 `"Wundston Coal Mine"` |
| **库存 `—` 的含义** | `GetStockpiledCargo` 对该产业**不接受的货**返回负值 ⇒ 落成 `null` ⇒ 页面显示 `—`（不是"库存 0"） |
| **两种口径必须分块** | 面板：`Cargo — last month`（标注 "map-wide (all companies)"）与 `Delivered by this company`（标注 "since this run started · all N towns and M industries monitored"）分开呈现；季度总量作为**交叉核对**单列 |
| **0 与"—"不混用** | "Our deliveries" 在有通道但尚无交付时显示 **0**（真实测量），仅当没有通道时显示 `—` |

**注意**：本节的读数来自 offline-demo（脚本化演示）——`own_delivered` 因此恒为 0
（演示里没有真实交付）。真实交付量需要带 LLM 的 agent 运行，属 P2 的后续验收项。

### 10.101 僵尸局取证（2026-09-25）：用户看到的那句告警，**不是真相的描述，而是真相的遮蔽**

用户报告页面提示：
`attention — No decision for 1 hour ago, and the run is not stopped. The process is alive but nothing is progressing…`

**先取证，再改代码**（session `20260925-145039-seed1000516367`）：

| 证据 | 读数 | 含义 |
|------|------|------|
| `audit.jsonl` 最后几条 | `turn 22: set_pause ok=true "rcon pause delivered…"`；`turn 23: 模型 input 12564 → observe: date=1950-12-01`（与上轮相同）；`turn 24: input=0 output=0` → `plan`；**此后 audit 无记录** | agent 在 turn 22 **自己按了暂停**（D52 第二次）；世界冻结后它又跑了两轮（turn 23 的 `observe` 看到日期不动），然后决策循环**再无动作** |
| `meta.json` | `status: "running"`、`endedAt: null`、`heartbeatAt` 一直在更新到 16:17 | 进程活着、心跳正常 —— 所以"进程活着"这句**是对的** |
| `events.jsonl` | 15:02→16:17 仍在收 `company_info` / `company_stats`（~4/s） | 通道活着、公司读数在收 —— 所以"数据在流"也是对的 |
| 世界日期 | 停在 `1950-12-01` | **世界不推进** ⇒ 决策触发器（游戏日推进 / 显著事件）永远不打开 |
| 公司名 | `EX exc:can't execute over an un…`、`vehicles: 0`、`stations: 2` | 第二个独立问题：执行器也卡住了（0 辆车） |

**根因（结构性）**：`set_pause` 的归因只写在了**快照**（`control.pausedByAgent`），没有写进
**supervisor**（`run.state`/`pausedBy`）—— 两个写者，页面只读后者。于是：
① 页面看不到"是 agent 自己停的"，只能给出通用告警；② 决策节奏（`scheduler`）**没有**跟着停，
它仍在按"日期推进"找触发，而日期永不推进 ⇒ 空转。

**修法**（本次已落地）：agent 的 `set_pause` 现在**走与页面按钮同一条路径**
（`scheduler.pause/resume` + rcon），并通过 `control.onAgentPause` 把归因交给 supervisor
（serve 模式下 supervisor 是 run 状态的**唯一写者**）；页面另外直接读快照的 `control` 事实
（即使 supervisor 尚未同步也能说清"谁让它停的"）。

**W1 落地（同一修复内）**：让"这局是在暂停中结束的"成为**可查事实**，而不只是页面提示：
`session.finalize` 的 outcome 新增 `blockedByPause`（只在为真时写 true）+ `pausedBy` + `pausedAt`；
`toGameMetric` 把两个字段带进进化账本；`compareArms`/`comparableMetrics` 在**比较入口**统一剔除
这类局（`m3-verdict.ts` 同时报出被剔除的局数，"悄悄少几局"不能被读成"结果更干净"）；
`/sessions` 审核页把它排在 Outcome 表**第一行**并写明"不要当学习结果"。
只写 true、不写 false：把"没发生"与"没记录"混成 false 就会在统计里变成另一种噪声。

### 10.102 世界时钟：一个事实、一个写者、一条够细的通道（2026-09-25）

W2 的目标是让"这局是在**世界冻住**时结束的"成为 run 记录里的事实。落地时先撞上一个
**更底层**的缺陷，不修它 W2 的判据就没有可信的输入：

| 事实 | 证据 |
|------|------|
| admin port 的 DATE 包按 **`Monthly`** 订阅 | `admin-client.ts` 的 `DEFAULT_SUBSCRIBE`：`[AdminUpdateType.Date, AdminUpdateFrequency.Monthly]` |
| 于是一局 90 s 的真实运行只收到 **1** 个 date 事件 | 隔离真机 `events.jsonl` 事件计数：`date: 1`（同时 `company_info: 128`） |
| 页面 health 条的判据是"最近 90 s 内有没有新 date 事件" | `live-view.js` 的 `worldRate()`：`advancing: now - lastAt <= 90 * 1000` |
| ⇒ 它**结构性地**永远报 `world frozen` | 真机截图：世界每 6 s 推进一次，页面却写 `WORLD frozen — no new game date in the last 90s` |
| 同一个字段还喂给 agent 的 `observe` | `tools/index.ts` 读 `snap.date` ⇒ **模型看到的世界时间也停在连接那一刻** |

**结论（系统事实）**：按游戏月刷新的通道不能当"当前时间"用；页面与模型都曾因此拿到
**结构上过时**的时间事实。可用的细粒度来源是 Bridge GS 的 `GSDate`（每 200 script tick
≈ 6 s 一次，`signal-hub.ts` 的 `gsRawDate`）——它一直在报，只是从未变成 `date` 事件。

**修法（三件事一起，缺一件就还是旧的谎）**：
1. `WorldState` 成为 `date` 的**唯一写者**（`applyDate`），并**单调**：较旧的读数一律丢弃
   ——按月到达的 admin 包不得把日期往回滚（交付计量器按 `gameDay` 判季度，倒退会污染它）。
2. hub 在 GS 日期**变化**时把它变成一个真正的 `date` 事件（`source:"gs"`），走与收包
   **完全相同**的三条路径（world / 页面 / 归档）。`source` 是诚实标注：它是 OpenTTD 时钟的
   **观测**，不是 admin 包。
3. 该段自带 `try/catch`：里面有 IO（归档写盘），一次失败不许连坐同一份 state 里的
   城镇/产业/运量事实（SPEC §10.66 的 `IsStationTile` 就是"一处坏、整条通道按局退化"）。

**W2 事实链**：`signal-hub` 记录"日期**变化**"的时刻 → runner 记录"**harness 自己**按住
世界"的时刻表（agent `set_pause` / 页面按钮与 `supervisor.pause` / freeze 模式三条路径，
见 `runner.ts` 的 `markWorldHeld`）→ 收尾时两者合成 outcome：
`worldFrozen: true` 仅当"超过阈值且没有人按住"，另记证据 `worldFrozenMs`。
只写 `true`、不写 `false`（把"没发生"与"没记录"混成 false 就是另一种噪声）。

**阈值 45 s 的来历（实测，不是拍脑袋）**：健康期相邻推进间隔 **max 6.0 s**（41 个样本，
中位 5.9 s）⇒ 45 s ≈ 7.5×；外部 rcon 暂停后的冻结段实测 **64–66 s**（outcome 记 66 109 ms，
事件流独立算出 64 s，两者互相印证）；真机事故是 **1 小时**。

**真机验收（重放 2026-09-12 `pause_on_join` 事故的形状）**：从 harness **之外**用 admin
rcon 暂停世界（与页面按钮两条独立路径）⇒ `meta.json` 记 `worldFrozen=true`、
`worldFrozenMs=66109`，而 `blockedByPause` 为**空**（暂停不来自我们）——两类原因被分开。
页面截图复核：health 条从假的 `frozen` 变成真的 `30.2/min`，`GAME DATE` 从连接时刻的
`1950-01-01` 变成实时的 `1950-02-01`。

### 10.103 执行器异常：完整文本进事件流（2026-09-25）

**问题**：`EX exc:can't execute over an un…` + `vehicles: 0`。错误文本在**生产端**被砍：
`catch` 里 `if (es.len() > 24) es = es.slice(0, 24);`。为什么是 24？因为相位要写进
**公司名**，而作者以为预算是 31 - 4 - 5。**上限是真的，算法是错的** —— 于是现场那句
`…` 不是显示层截断，是信息在源头就没了。

**三条候选通道，逐条实测排除**（隔离真机，探针已回退；勿再重试）：

| 通道 | 实测结果 | 结论 |
|------|----------|------|
| 公司名（`AICompany.SetName`） | **31 接受；32/44/56/64/72 全部静默拒绝** | 上限 31 是硬事实，一条错误永远放不下 |
| `AILog.*` | macOS dedicated `-v dedicated` 下 **0 行**（server.log 与 admin console 包都没有） | 与 §10.10 一致：这条通道在 macOS 上不存在 |
| `AISign.BuildSign` → GS 的 `GSSignList()` | AI 建标牌**成功**（`ok30481`），但 GS 扫描 **16/16 次报告都看不到它**（current 模式 0 个；company 模式只看到 GS 自己放的 3 个 bp 标牌） | 可见性不通，这条通道不可用 |

⇒ **公司名是唯一已验证的执行器→harness 通道**（GS 每 ~20 script tick ≈ 1.1 s 轮询一次），
于是错误只能**分块**走它。

**协议**：`exc<seq><marker><chunk>`，写进名字 `EX <phase> j<job>`（总长 ≤ 31）。
marker 三态：`: ` 后续还有块 / `=` 末块且完整 / `~` 末块但被生产端 5 块上限截断。
块宽由**真实预算**算出：`31 - 3("EX ") - 3("exc") - 1(seq) - 1(marker) - (2 + 位数(job))`，
下限 4；每块**粘滞 5 轮**（≈1.4 s > GS 的 1.1 s 轮询），否则末块会被下一轮施工相位盖掉。
GS 侧把 `exc<seq>` 映射成 `stage = "error" + seq`：**必须**带序号，否则 `ExecEventKey`
指纹（只比 stage/job/hb）会把第 2..N 块全部抑制。

**两个协议级陷阱（worker 复核时发现，已修）**：
1. **指纹**：连续两条**单块**错误会算出同一个 `error1|job|0`，第二条永远发不出去。
   修法：指纹对**错误相位**附加整段相位文本（非心跳相位，否则心跳每轮变 → 事件风暴）。
2. **作业号后缀**：`s.find(" j")` 取**首次**命中，块文本里出现 `" j"`（例如
   `can't join …`）就会切错并顺带截断相位。修法：从后往前找，且尾部必须全是数字，
   否则宁可不切。

**装配在 hub，且必须喂 `p.raw`**：`decodeExecutorPhase` 自己的后缀处理会吃掉块尾空格，
于是 `cannot join` 会变成 `cannotjoin`——一个**自信的错误文本**比没有更坏。装配器规则：
必须从 `seq 1` 开始且逐一递增；跳号/重复则丢弃重拼（采样通道可能漏轮询，缺字就
不拼）；非块相位不动缓冲区；30 s 以上的残块在下一次 push 时丢弃。

**真机验收（重放现场那句错误）**：一次性注入 `W3REPLAY: can't execute over an
unfinished action (simulated 2026-09-25)`（72 字符）⇒ 真实事件流按序出现 4 块
（`exc1:`…`exc4=`）⇒ 装配器还原出**完整 72 字符**（`truncated=false, complete=true`）；
旧代码这里只剩前 24 字符。页面渲染出
`The executor raised an error (2 minutes ago): W3REPLAY: can't execute over an unfinished action (simulated 2026-09-25)`。
完整文本同时进 `events.jsonl`（走的是与收包相同的归档路径），所以事后 autopsy 不需要新通道。

### 10.104 图表手势、区间读数与列表索引（2026-09-25 用户实测复核）

用户在真实长局（`/tmp` 外的自有实例，9.15M tokens / 691 决策 / 17 条线路）上指出
"折线图、Token 用量等，鼠标缩放逻辑不正确，也没有对应坐标轴范围显示缩放及区间范围"。
逐条核对代码与 DOM 后确认三件事：

| 现象 | 实测根因 |
|------|----------|
| 提示写着 `drag to zoom`，实现却是**平移** | `cursorOpts()` 关掉了 uPlot 的框选（`setSelect: false`），指针层把裸左键拖拽接成 `panBy`；未缩放时平移是**静默 no-op** ⇒ 提示承诺的动作不存在 |
| 缩放后看不出在看哪一段 | 全页 `document.querySelectorAll` 找不到任何区间文本；uPlot 的 legend 是**光标跟随**读数，鼠标离开就显示 `—`（实测 `legend: "x--Company 0--"`） |
| 放大后 x 轴挤成一片竖线 | 107/400 点的视野里约 20 根竖直网格线、只剩 2 个标签（真机截图） |

**改法（第一性原理：用户要能"框一段放大"、并且随时知道"看的是哪一段"、并且能回来）**：
1. 裸拖拽 = **框选缩放**（`dragToRange` 纯函数：像素 → 样本区间，最小位移 8px、竖直为主则忽略）；
   **Shift+拖拽 = 平移**（只在放大之后才有意义，所以是修饰键动作）；滚轮仍是以指针为锚的缩放；
   双击 / `⟲` 复位。横跨全宽的拖拽 = 回到全量（而不是"没反应"）。
2. **区间读数**（`formatRangeCaption` 纯函数）：`1950-12-01 → 1951-01-01 · 107 of 400 points (27%)`，
   未缩放时是 `full range · 400 points`。由 `applyXRange` 统一写（它是视野的唯一写者），
   并广播 `uplot:range` 事件供页面与探针观测。**单位写 `points` 不写 `days`**：x 是采样序号，
   一天可以有多个点，把采样点说成"天"是编造单位。
3. x 轴竖直网格线关掉（键名是 `grid`，已对 vendored uPlot 1.6.32 核过：`splits` 是刻度概念，
   写在轴上会让 x 轴 `values` 回调收到非数组、图表直接抛异常——真机复现过）。

**Fleet Detail 的"不更新"其实不是响应式缺陷**：白盒注入 `vehicles 5 → 11` 后抽屉 DOM
（`x-for` + `:key`）确实跟着变（真机实测），快照流也在增长（25 s 内 history 35 → 107）。
真正的三个问题是：① 指标本身几乎不变（见 §10.105）② 两个车队数字互相矛盾 ③ 页面没有任何
"数据新鲜度"信号，用户无法判断"是没变还是没在更新"。

**/sessions 列表**（用户："统计信息过少，缺少关键信息，也缺少该 session 的存档文件位置"）：
服务器**早就**把 `savegame` 挂在每个列表项上（`serve.ts` 的 `list()`），但列表模板从不渲染它，
只有详情面板显示；且决定"这局能不能进比较"的三件事（交付量 / 窗口长度 / 是否有效样本）
都不在列表里——一条被暂停结束或世界冻住的局，在列表里长得和好局**一模一样**。
现在列表项多一行"索引事实"（`sessions-view.js` 的 `runFacts` 纯函数，可单测）：
`delivered 377 ✓` · `window 447d` · `verdict horizon not reached` / `stopped (paused) — exclude` ·
`save …/save/<id>.sav`（完整路径在 title，详情面板可复制）。

### 10.105 车队数必须跨线路去重：同屏两个"车队"曾经互相矛盾（2026-09-25）

**真机现场**（用户自有 5 年长局，17 条线路 / 9 个车站 / 25 辆车）：同一屏上出现
`FLEET 25 veh`（公司口径）与 `VEHICLES ON ROUTES 129`（线路求和）——两个都是"真的读数"，
但放在一页上就是**互相矛盾的数字**。

**机制**（算术可核对）：GS 的每条线路读数是"停在这条线**两端站**上的车 / 等在这两端的人"。
一个车站服务多条线路 ⇒ 同一辆车、同一批乘客被**每条用到该站的线路各数一次**。
17 条线分布在 9 个站上 ⇒ 站平均出现在 ~3.8 条线路上 ⇒ 25 × ~5 ≈ 125，与实测 129 同量级。
等待人数同理（实测朴素求和 1 951）。

**改法**（有 id 才能去重，否则只能重复计数）：
1. `EmitRouteStats` 额外上报 `vehiclesIds`（两端的车辆 id 列表）、`endsA/endsB`
   （GS 用 `StationNear` 真正找到的**站号**，不是标牌格 —— 执行器站点偏移时二者不同）、
   `waitA/waitB`（**逐站**等待，而不是只有两端之和）。
2. `RouteStats` → `joinRoutesWithLedger` → `routeWireFacts` 全程透传。
   ⚠️ `joinRoutesWithLedger` 曾经**逐字段重建**对象，这些字段在那里被静默丢掉 ——
   典型症状是"解析器有、wire 没有"，页面于是仍然重复计数。
3. `routesSummary()` 跨线路去重：车辆按 id、等待按**站号**（同一线路两端同站时只算一次）。
   旧 GS 没有 id 时退回求和，并在界面上**明说没去重**，不假装已经修好。
4. 口径写进界面：`Vehicles at route ends`（旧标题 `Vehicles on routes` 听上去像车队规模）
   + `distinct vehicles standing at line ends · buses between stops are not counted here`。

**真机验收**（新 GS，seed 21）：有车时刻的线路**朴素求和 = 12**，按 id **去重后 = 3**
（同一 4× 膨胀，与 129-vs-25 同形）；页面显示 `Vehicles at route ends 3`，
`Waiting passengers 4 · 2 distinct stops`。

**顺带暴露的另一半（诚实地说明它没有被"修掉"）**：这个口径只数**停在端点**上的车，
**在途的车两个口径都看不到** —— 一条正常运营的线路大多数采样时刻会显示 0。
真正的每线路归属要由**执行器**报（它知道每条线自己配了几辆），那是新通道，
列在 `ROADMAP.md`；本轮只做到"不再重复计数 + 口径说清"。

**数据新鲜度**：用户报"Fleet Detail 不会自动更新"，白盒注入证明**响应式链没坏**
（`vehicles 5 → 11` 会更新抽屉 DOM，快照流 25 s 内 history 35 → 107）。真正缺的是
**用户无法区分"数字没变"与"数据没在流"**。现在页头有独立的 `Data` 项：
`data now` / `data 42s ago`（warn）/ `no data for 90s`（bad）/ `no data frame yet`（未知 = dim）。
连接状态与数据状态是两个不同的问题，页头必须分开说。

### 10.106 事实通道补全与 admin 握手竞态（2026-10-07 真机实测）

**城镇名**：`GSTown.GetName(tid)` **存在且返回真名**（真机探针："New Badworth"，25 镇）。
名字现走完整链路 GS `town_list.name` → hub → `WorldState.setTowns` → `wire-snapshot` → 页面。
`WorldState.setTowns` 曾在"最后一公里"重建对象时丢掉 `name`（D55 同类**第三次**），
事件流里有名字而页面显示 `#id` —— 新字段的验收必须包含"它到页面并被渲染"。
线路端点同理解析名字；**样本外的镇回退 `#id`**（GS 只发人口前 10 的样本）。

**`-1` ≠ 0**：`GSIndustry.GetLastMonthTransported` 在**全交叉**（产业×货种）下实测
一采样期 **548 个负读数**（-1 = 该产业不涉此货 = 不适用）；在 `GSIndustryList_CargoProducing`
的产出对上是实数（本轮全 0：游戏早期且公司只做客运）。折叠 `-1→0` 的四层
（GS `trans<0→0`、hub `Number(x)||0`、world-state 重建、view `cargoSharePct`）已全部拆除：
缺失/负值 → `null` → 页面 `—`。注意 `Number(null) === 0`：**先问缺失，再转换**。

**未验证（D43/D59，不得引用）**：`GSVehicle.GetLastStation` —— 探针在公司 0 辆车时
循环体 0 次，`ok=0` 什么也没证明（"未测"≠"失败"）。要重测需保证循环真的执行。

**admin 握手竞态（本次事故根因）**：
1. OpenTTD 15.3 的 admin 端口在**游戏自举期间**（地图生成）就监听 ⇒ `waitForAdminPort`
   放行后立即连接会被 reset（`connect ECONNRESET` / `read ECONNRESET`）。
2. 该服务端是**"先收后说"**：裸 socket 连上后空等 3 s **零字节**；客户端不先发字节，
   `ServerProtocol` 永远不来。"等 PROTOCOL 再 JOIN"（照协议应然顺序写的实现）**死锁**。
   **协议文档的"应然"是假设，实测才是事实（D53 同族）。**
3. 修复：JOIN 立即发（`joinSent` 幂等，`ServerProtocol` 到达只作兜底）+
   `connectAuthed()` 有界重试直到收到 `ServerWelcome`（半开连接丢弃重试；
   socket close 即结束本轮等待，不空转）。
4. 症状指纹：`'' () has disconnected`（JOIN 从未被服务端解析）+ `write EPIPE`（对端已关）。

### 10.107 P1-1a：执行器搬进 GS（2026-10-08 真机实测）

**类型化反馈取代公司名通道**：施工状态机移植为 `ExecCore`（`bridge-gs/main.nut`），
逐 tick 在 `GSCompanyMode(company)` 作用域内施工。反馈是类型化 `exec` 事件：
`{kind:"exec", job, stage, note?, error?, fleet?}`——**错误全文**（`error` 字段），
31 字符分块协议（W3）与公司名中继已**删除**（分块装配器与其测试一并删除）。
`done` 事件带车队真值 `fleet:{owned, ids, applied}`。

**真机流水线实测**（offline demo，seed 11）：`queued → work j100 → stA_ok → stB_ok
→ road_start → road seg1 d54 → … → road_stuck:ERR_AREA_NOT_CLEAR → done`
——具名失败与全文错误（`the index 'ShortErr' does not exist` 被 Fail() 捕获并送达）
都进了事件流；有界失败（同 job 连续异常 50 轮 → `abandoned`，FIFO 不堵）。

**新事实（勿再试）**：
1. **`import("pathfinder.road")` 在 GS 上下文不可用**：真机报 `couldn't find library`
   （同一 import 在 AI 上下文可解析）。GS 侧寻路只能用贪心分段（`GreedyPath`，
   探针同款走法 + 可建性过滤 + 清障重试）。**贪心寻路的完成率低于 Pathfinder.Road**
   （seed 11 的 55 格线路在地形处收摊）——已知缺口，P1-1b。
2. **公司由 AI 创建**：没有"GS 创建公司"的 API ⇒ 执行器保留为**公司外壳**
   （建公司、命名、保活；施工一行不做）。删公司 ≠ 删脚本。
3. `ExecCore` 必须有构造器：`ExecCore(this, 0)` 在无构造器时**不报错但也不赋值**，
   `_gs` 为 null ⇒ 首次 Enqueue 抛穿 `Start()` ⇒ 整个 GS 静默死亡（一处失败连坐全通道）。
   现在 `Dispatch` 调用点有护栏：命令异常 → `dispatch_error` 全文事件，GS 继续跑。
4. Squirrel 类里 `this.Sleep` 来自 `AIController`/`GSController` 继承：
   `ExecCore` 不继承 ⇒ 需要自备代理（`GSController.Sleep` 存在）。

### 10.108 P1-1b：GS 寻路库入库（2026-10-08 真机实测）

**GS 库解析的实测事实**：
1. GS 的库扫描树是 **`<data>/game/library/`**（OpenTTD 自建该目录；content 下载树
   `content_download/ai/library/` 只对 **AI 上下文**可见——这就是旧 AI 能 import
   而 GS 不能的全部原因）。
2. **GS 虚拟机的库基类注册名是 `GSLibrary`**（四选一探针实测：`GameLibrary`/
   `Library`/`ScriptLibrary`/`AILibrary` 均报 `the index '...' does not exist`）。
3. **GS 虚拟机不注册 AI* API 名**（`the index 'AIList' does not exist`）；库内代码须按
   双名映射改 GS 名（AITile/AIMap/AITunnel/AIBridge/AIRoad/AIVehicle/AITestMode/
   AIList/AIBridgeList_Length → GSTile/GSMap/GSTunnel/GSBridge/GSRoad/GSVehicle/
   GSTestMode/GSList/GSBridgeList_Length）。
4. 依赖链：`pathfinder.road`(v4) → `graph.aystar`(v6) → `queue.binary_heap`(v1)。
   三件套已 vendored 进 `src/game/squirrel/library/`（GPL v2 独立作品，保留许可全文，
   修改声明在各 `library.nut` 顶部；边界见该目录 README）。`squirrel-deploy` 部署到
   `<data>/game/library/`。

**完整线路建成（P1-1a 验收补齐，seed 11 真机）**：
`queued → work j100 → stA_ok → stB_ok → road seg1..3 → road_built → dpt_ok →
dpt_conn → bus_live → done`，`done.fleet = {owned:1, ids:[4], applied:-1}`
——车站×2 + 道路（真 Pathfinder.Road 分段寻路）+ 车库 + 巴士 + 发车，全部经 GS 执行
核心，server.log 零 API 缺失。贪心回退（`GreedyPath`）保留为库不可用时的兜底。

**遗留（收尾链缺陷，登记 ROADMAP）**：offline demo 收尾时反射步骤失败
（faux 队列耗尽）会让 `runFinalizeAndReflect` 返回 1、进程退出码 1 且**不写指标行**
（`/api/metrics` 看不到该局）——数据丢失，P2 的短局多跑必须先修。

### 10.109 P1-1b 尾巴 + P1-3 数据层：车队双向/退役实证（2026-10-08 真机）

**双向与退役在新核心上全部落地**（D58 探针，seed 11）：
- **增**（3→5）：`fleet_wait5j100c3L3 → fleetg5j100L5C5`（克隆 2 辆，注册表 5/公司 5）；
- **减**（5→1）：`fleet_wait1j100c5L5 → fleetsend4j100C5 → fleetsold1…`（送库 4 辆、逐辆卖出）；
- **退役**：`retire4C4` + 逐辆卖出（公司 5→4→3→2 递减，卖车跨 tick 是引擎语义）。
每个相位带计数（want/cur/list/company），具名可核（D20）。

**两个真值字段（P1-3 数据层）**：`route-stats` 现带 `fleetIds`（执行器注册表 =
**归属**，稳定唯一）与 `fleetApplied`（目标规模）；与 `vehiclesIds`（站点归属 =
**此刻站在两端站的车**，会重复计数）是两个事实。真机对照：`fleetIds:[4,5,6]`
vs `vehiclesIds:[6,5,4,6,5,4]` vs 引擎 `company_stats.vehicles=3`——三个数字
三个含义，页面去重只能靠 id（D60 语义：缺失 = 字段缺席，不折叠成 0）。

**修复的两个真缺陷**（各带先红守卫）：
1. **克隆车不进注册表**：`bus` 阶段克隆循环只登记头车 ⇒「引擎 3 辆、注册表 1 辆」。
   现在每辆克隆车 `append` 进 `_fleetOwned` 并重登记线路。
2. **队列空 = 躺平**：`Tick` 在施工队列空时提前 `return`，尾部的
   `CheckAddVehicles/ProcessFleetSells/CheckRetireRequests` 永不执行 ⇒ done 后发出的
   车队/退役请求永远排队（有回执、无效果——「通路 ≠ 效果」的又一实例）。现在空队列
   分支在公司作用域内照常做维护。

**工具层的诚实拒绝也已实证**（observe-or-refuse）：公司统计未到/车为 0 时
`set_route_vehicles` 明确拒绝并具名理由（`no reported stats` / `0 vehicles … nothing
to clone`），不吞请求不假装成功。

### 10.110 P1-2：动作面扩——选货 / 换车（2026-10-08 真机实证）

**两个新动作**（`set_route_cargo` / `set_route_engine`，类型化命令进 ExecCore）：

| 动作 | 做法 | 真机证据 |
|---|---|---|
| **选货** `set_route_cargo {job, cargo}` | 送库 → 到库 `RefitVehicle` → 重启（跨 tick 队列，最新意图顶替） | `refitq3c2 → refit3f0c2`（3 成 0 败）+ `cargoApplied: "MAIL"` |
| **换车** `set_route_engine {job, engine}` | **先买后卖**：新车（同订单同货物）进登记表，旧车送库卖掉 | `reeng3e153j100` + `fleetIds [4,5,6]→[7,8,9]` + `engineApplied: 153` |

**D43 实测的 API 事实**（探针一次性验证，存在性进 SPEC 的只有实测过的）：
`GSCargo.GetCargoLabel`/`GSEngine.GetName`/`GSVehicle.GetRefitCapacity`/
`GSVehicle.GetCapacity`/`GSCargo.CC_MAIL`/`GSOrder.GetOrderCount` **存在**；
`GSOrder.GetOrderDest`/`GSVehicle.GetVehicleEngine` **不存在**（勿引）。

**引擎前置（真机实测，三连坑）**：
1. `RefitVehicle` 要求**车停在库里**（不然逐辆失败）——所以选货是「送库→到库改→重启」的
   多 tick 流程，不是一次调用。已库内的车直接进队列（`SendVehicleToDepot` 对库内车是 false）。
2. **公司动作必须在公司作用域内**：`SendVehicleToDepot`/`BuildVehicle`/`RefitVehicle` 在
   Dispatch 上下文裸调 ⇒ `ERR_PRECONDITION_INVALID_COMPANY` / 静默 false。
3. 登记表只记**生效值**（引擎回执 ok>0 才写）；请求值 ≠ 事实（D61）。

**可选车型目录**：state 报告新增 `engines: [{id, name, speed}]`（GSEngineList(VT_ROAD) +
IsBuildable + GetName + GetMaxSpeed，四个 API 均实测存在）——agent 要看得见选项才可能学选择。
`route-stats` 带 `cargoApplied`（标签）/`engineApplied`（引擎 id），缺失 = 未改装（字段缺席）。

### 10.111 P1-3 收尾：FLEET 归因分解（2026-10-08 真机实证）

**恒等式**（`src/agent/route-stats.ts` `fleetDecomposition`，纯函数 + 单测）：
```
owned + unattributed === companyTotal      // 跨线路按 id 去重
owned = onRoad + inDepot                   // 在途/在库（GS 报 fleetDepot）
```
任何一项不可得 = `null`（显示 `—`），**不是 0**（D60）。差额**具名**
（"Unattributed — named gap, not dropped"），不再有两个各自为政的车队数字。

**数据**：`route-stats` 增 `fleetDepot`（登记车辆中 `IsStoppedInDepot` 的 id，引擎读数）。
分解在**服务端**算好下发（wire `fleet` 字段），页面只渲染（`fleetAttributionRows`，
永不为 null 的数组，D45 模板守卫）。

**真机页面实证**（demo seed 11，CDP 全级别控制台）：
```
Company total 3 · Owned by routes 3 · — on the road 3 · — in depot 0 ·
Unattributed 0 (named gap, not dropped)
```
恒等式 3+0=3 对上；0 控制台条目。**未做截图**（CDP captureScreenshot 在本机
headless 持续超时）——布局正确性由 DOM 文本断言 + smoke 的元素检查兜底，如实披露。

### 10.112 P2-3：统计预登记（2026-10-08，跑前拒绝）

**预登记条目**（P2 系列实验不得事后修改）：
- 公式：`n ≈ 16·(CV/效应量)²`（每臂局数；正态近似、80% 功效、α=0.05）
- 默认声明效应量 = **+20%**（0.2）；假定 CV = 100%（保守）
- **声明 +20% 而 n 不足 = 拒绝比较/拒绝开跑**，不给安慰剂 p 值

**实现**：`requiredSampleSize` / `powerVerdict`（`src/evolution/metrics.ts`，纯函数 + 单测）。
两个判据脚本接**跑前拒绝**（G7 同型）：
- `scripts/run-experiment.ts --effect X --cv Y`：开跑前不够 n → `!! UNDERPOWERED` + exit 1
- `scripts/m3-verdict.ts [dataDir] [effect]`：裁决前不够 n → 打印拒绝 + exit code 1

**双向自证（真跑脚本）**：`--n 3 --effect 0.2 --cv 1.0` →
`!! UNDERPOWERED: detecting +20% at CV 100% needs 400 run(s)/arm; this comparison has 3` + 拒绝；
`--n 64 --effect 0.5` → 放行开跑。缺 CV/效应量 → `detectable: null`（不可判 ≠ 放行）。

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

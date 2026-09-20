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
- `jplattel/openttd-llm`: 外部 Python 写 `commands.nut` 到 AI 包目录 → Squirrel AI 读 → 执行 → AILog 回传
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
- **AI 无任意文件系统访问** → jplattel 的 `commands.nut` 写入 AI 包目录方案需要 AI 能 `import`/`dofile` 变体（有版本/沙箱风险）；**arena 的标牌方案是干净、跨 15.x、可观测的**（每个标牌=一个可审计事实）。→ **SPEC 采用标牌邮箱为主通道**

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

### 3.3 目录结构（D2=B: 单包 + 模块边界）

```
openttd-agent/
├── package.json                 # type:module, engines.node>=22.19
├── tsconfig.json
├── SPEC.md                      # 本文档
├── docs/
│   ├── architecture.md          # 图 + 决策记录 (ADR)
│   └── protocol.md              # 自研协议说明
├── src/
│   ├── main.ts                  # 入口: 装配 + 启动 runner
│   ├── config.ts                # 环境/CLI 配置 (zod)
│   ├── game/
│   │   ├── process-manager.ts   # OpenTTD 子进程生命周期
│   │   ├── admin-client.ts      # 纯 TS Admin Port 协议 (net.Socket)
│   │   ├── admin-protocol.ts    # 类型化包编解码
│   │   ├── observer.ts          # 订阅→规范化 GameEvent 流
│   │   ├── rcon.ts              # RCON 命令封装
│   │   ├── gs-channel.ts        # Admin↔GS JSON 通道
│   │   ├── action-executor.ts   # 高层动作→蓝图 JSON→GS
│   │   ├── events.ts            # GameEvent 类型
│   │   └── squirrel/
│   │       ├── bridge-gs/       # 生成的 GS 包 (info.nut/main.nut 模板)
│   │       └── executor-ai/     # 生成的 Executor AI 包
│   ├── agent/
│   │   ├── runtime.ts           # pi-agent-core Agent 装配
│   │   ├── tools/               # 每个高层动作一个 tool (build-route, add-vehicle…)
│   │   ├── messages.ts          # AgentMessage 声明合并 (gameObs/plan/result)
│   │   ├── context.ts           # transformContext 记忆注入 + 上下文精简
│   │   └── prompts.ts           # 系统提示词模板 (分层: meta/strategy/play)
│   ├── evolution/
│   │   ├── engine.ts            # 局终反思编排
│   │   ├── lessons.ts           # 记忆蒸馏存储/检索
│   │   ├── strategy-library.ts  # 成功策略模板化/相似度检索
│   │   └── metrics.ts           # 指标采集 → JSONL
│   ├── memory/
│   │   └── store.ts             # lessons/strategies 持久化 (JSONL, Pi session 复用)
│   ├── web/
│   │   ├── server.ts            # HTTP + WebSocket
│   │   ├── hub.ts               # 事件扇出给浏览器
│   │   └── public/
│   │       ├── index.html       # 原生仪表盘
│   │       ├── app.js           # WS 客户端 + Canvas 渲染
│   │       └── style.css
│   ├── obs/                     # 观察者: agent/evolution 事件 → 指标/日志
│   └── util/                    # 纯工具 (jsonl, time, id, retry)
├── test/
│   ├── unit/                    # admin-protocol, codec, blueprint, config, lessons
│   ├── integration/             # spawn openttd → admin join → poll → save/load
│   └── e2e/                     # 完整一局最短跑通 (smoke)
└── scripts/                     # dev 辅助 (gen-squirrel, setup-local-env)
```

---

## 4. Agent 层设计（pi-agent-core 深度集成）

### 4.1 为什么用 pi-agent-core
| Pi 能力 | 本项目用法 |
|---|---|
| `Agent` 类 + 事件流 | 决策循环本体；事件镜像给 Web |
| `AgentMessage` 声明合并 | 引入 `game_observation` `agent_plan` `action_result` 等自定义消息类型（UI/审计可见，经 `convertToLlm` 过滤） |
| `convertToLlm` | 只把对 LLM 有意义的 message 转出去（观察/结果摘要），避免上下文爆炸 |
| `transformContext` | 注入 lessons/策略库检索结果；剪枝历史 |
| `tools` (AgentTool) | 实际工具集（以 `src/agent/tools/index.ts` 为准）：`observe` `estimate_route` `inspect_route` `build_bus_route` `add_vehicles` `set_pause`。未实现的（train/orders/reflection）属于路线图，不在契约里 |
| `beforeToolCall` | 动作合法性预检（钱/状态/冷却），拒绝非法动作并给原因 |
| `afterToolCall` | 记录指标、审计、结果反馈给进化引擎 |
| `shouldStopAfterTurn` | 「这一 turn 结束就停」——执行器完成一轮动作后让出 |
| `steer/followUp` | 游戏中需要紧急重规划时注入 |
| session (harness) | 一局=一个 session 分支；跨局 lessons 独立存 |

### 4.2 决策循环（细粒度）
每局定义「决策点」（阶段变化 / 事件 / 间隔 / 模型 `wait_until`）。循环:
1. Runner 在决策点**采集 rich state（不暂停，见 §1.1）** → 构造 `game_observation` 消息
2. Agent `prompt()`; LLM 产出 计划（JSON: `goal / plan[] / immediate_action / wait_until / rationale`）
3. 系统校验计划合法性 → 合法则 `unpause` 交给 executor 异步执行
4. executor 按计划施工（可能跨月）；Bridge GS 汇报每步结果
5. 到达下一决策点或「等待条件满足」，回 1

### 4.3 高层动作集 (v0.1)
第一批 tool（足够跑通最小闭环）:
- `observe(filter?)`: 拉取规范化状态切片
- `build_bus_route(from_town, to_town)`: 蓝图=站A/站B/路网/车库 → executor 施工
- `build_train_route(...)`: 同上铁路版（v0.1 可后置）
- `add_vehicles(route, count)`
- `fund_infrastructure?` (城镇发展, 先不做)
- `set_pause(bool)` `save_snapshot(tag)`

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

## 10. 已固化调研结论（两轮源码级验证）

### 10.1 动作面（回答"Admin Port 做不到的操作怎么办"）
- **Admin Port 的 RCON 面 = 服务器级操作**：pause/unpause/save/load/newgame/say/money/give/start_ai/stop_ai/rescan_ai/exec/set/reset_engines/reload_ai。**确认无任何铺轨/建站/买车/设订单命令**。
- **游戏内 Squirrel API（AI/GS 共享同一套 `Script*` 底层，`@api ai game`）才是完整操作面**。源码逐类核实存在：
  - `AIRail`: `BuildRail` `RemoveRail` `BuildRailTrack` `BuildRailStation` `BuildRailDepot` `BuildSignal` `BuildRailWaypoint`
  - `AIStation/AIRoad/AIVehicle/AIOrder/AIGroup/AIBridge/AITunnel/AITile/AIDepot/AIEngine/AITown/AIIndustry/Pathfinder…` 完整
- **结论**: LLM=脑，游戏内 Executor AI=手；GS 负责上帝权限 + 状态广播 + 命令中继。

### 10.2 观察信号（回答"Admin 能否拿到全部/有价值指标"）
- **双通道叠加 ≈ 游戏全量状态镜像**：
  - 通道A Admin 原生：`DATE` `COMPANY_INFO/ECONOMY/STATS`（现金/贷款/收入/公司价值/车辆数/货运量/业绩）`CLIENT` `CONSOLE` `CMD_*`
  - 通道B GS `GSAdmin.Send(JSON)`：`GSTownList`(人口/评级) `GSIndustryList`(产量/货物) `GSStationList/GSVehicleList` `GSCargoMonitor` `GSCompany`季度报告（`GetQuarterlyCompanyValue/PerformanceRating/CargoDelivered`）`GSMap`…
- **拿不到的（诚实边界）**: 视觉像素；引擎内部值（非 API 暴露）；GS 推送受 `1450B/条` + `script_max_opcode_till_suspend` 执行预算限制。
- **macOS .app 坑**: `AILog` 输出被丢弃 → AI 状态回传不依赖日志，走 GS 转发 / 公司名编码。

### 10.3 GS-only 施工候选（M0 spike 验证）
- `ScriptCompanyMode` (`@api game`) 允许 GS 以任意公司身份执行 DoCommand（费用记该公司账）。
- **若 spike 证实** GS 可对 agent 公司施工且与 Executor AI 无冲突 → 架构可简化为 GS-only（省一个组件）。默认方案仍是 Executor AI + Bridge GS 两件套（职责分离）。

### 10.4 命令下发链路（三方先例收敛）
- **主**: 外部→`AdminGameScript`(JSON)→Bridge GS `ScriptEventAdminPort`→GS 放 `GSSign` 蓝图→Executor AI `AISignList` 消费施工→GS `Send` 回传结果
- **备**: jplattel `commands.nut` 文件通道（受文件沙箱+macOS日志限制，仅参考）

### 10.5 待 M0/M1 spike 实测项
1. AI 包热更新语义（`reload_ai` 是否保留资产）
2. GS-only 施工可行性（§10.3）
3. 蓝图长序列与 `commands_per_frame` 限速的交互
4. ~~Admin insecure-login + 127.0.0.1 绑定在 dedicated 模式的实际行为~~ **✅ 已实测**（见 10.6）
5. 本地已装 AI（AAAHogEx/CityLifeAI/CivilAI/CPU）可否作为基线对手

### 10.6 M0 实测结果（v0.0.1 完成）
以下事实经真机 (OpenTTD 15.0, dedicated) 验证：
1. **admin listener 触发条件**: `AdminAuthenticationConfigured()` 要求 **非空 `admin_password`**（`settings_type.h` line 441），密码在 **`secrets.cfg`** 的 `[network]` 段，**不在** `openttd.cfg`。日志标志: `net=5` 时出现 `Starting listeners for admins`。
2. **secrets.cfg 必须由 OpenTTD 先生成再 patch**：手写 secrets.cfg 会被视为外部文件，启动时重建并清空 `admin_password`。process-manager 因此采用 generate-then-patch。
3. **headless 起服**: `-D 127.0.0.1:<gamePort> -t <year> -G <seed> -v dedicated -s null -m null -c <dir>/openttd.cfg` 即可自动生成地图。
4. **日历锚点**: `-t 1950` → ServerWelcome `start_date_raw = 712223` = 1950-01-01；算法 = proleptic Gregorian days-since-year0。
5. **ServerDate 轮询**: 订阅 Date (Monthly) + Poll Date → 收到 `ServerDate` raw date，解码正确。
6. **新地图无公司**: 纯净图没有 company → `CompanyEconomy` 不会出现，直到客户端加入或 `start_ai`。这是预期行为。

### 10.7 M1 实测结果（v0.1.0 完成）
以下事实经真机 (OpenTTD 15.0, dedicated, seed 可控) 验证：
1. **`start_ai` 经 RCON 可创建公司**: `rcon start_ai "CPU"` → `ServerCompanyNew(id=0)` → `ServerCompanyInfo`（`isAi:true`, `inauguratedYear:1950`）→ poll `CompanyEconomy` **即时返回**（无需等季度翻转）。
2. **economy payload 含 u64 金额**: money/loan/income/companyValue 是 `uint64`，JS 需 BigInt；开局 CPU AI `money=100000 loan=100000`（贷款开工）。
3. **本地 AI 包位置**: 用户级 `~/Documents/OpenTTD/content_download/ai/*.tar`（OpenTTD 15 以 tar 下载包存储，运行时解包）；app 内置 `Resources/ai` 只有 compat shim。→ AI 可用性探测不能用文件系统（tar 未解包查不到），用「已知集 + OPENTTD_AI_LIST 覆盖」。
4. **CPU AI 行为**: 一家道路公司（road AI），开局即贷款 10 万，会自行买/跑公交或货车。
5. **ServerError payload = 单 NUL 字符串**（非 cstr 对）—— decode 需用单 cstr 读取。
6. **WS/HTTP 广播链路**: `--watch` 下 WS snapshot（连接即全量）+ 增量事件（seq 单调递增）；poll 节奏 5s 保持曲线新鲜，date 按月推。
7. **SIGINT 优雅关闭**: pause → close client/web → stop server，无残留进程/端口。

## 10.8 里程碑进度
| 里程碑 | 状态 | 证据 |
|---|---|---|
| M0 环境钉死 | ✅ | v0.0.1 probe 真机通过; §10.6 |
| M1 观测闭环 | ✅ | v0.1.0: AdminClient+WorldState+Web dashboard+`--watch` 真机通过; §10.7 |
| M2 最小决策闭环 | ⬜ | 下一版 (Executor AI + Pi Agent) |
| M3 进化闭环 | ⬜ | |
| M4 打磨 | ⬜ | |

## 10.9 M1.5 崩溃调查（重要工程事实, 2026-09-08）
真机发现 OpenTTD 15.0 dedicated 在关机时高概率 abort（`Abort trap: 6`），栈顶为
`ServerNetworkAdminSocketHandler::~ServerNetworkAdminSocketHandler` +
`OTTD_CloseConnection`（admin receive 路径 use-after-free）。逐项隔离后定位：

1. **触发条件**: 在 **SIGINT/SIGTERM 信号回调里直接跑 async 收尾**（pause→save→
   client.close()）。信号上下文里的 socket write/close 与服务器 admin receive 循环竞态
   → abort。
2. **不是原因**（全部实测排除）: AdminQuit 包、save 命令本身、poll 节奏、Web 服务、
   运行时长、进程组信号传播、AI 类型（CPU/CivilAI 均崩）。
3. **修复**: 信号 handler **只翻 flag + resolve promise**；真实收尾（pause/save/close/
   web.stop/mgr.stop）在正常事件循环流程执行。修复后 3/3 干净关机（此前 0/3）。
4. **附带**: `AdminClient.close()` 不发 AdminQuit（EOF destroy 足够且安全）。
5. **教训**: 任何信号处理里不得做 async I/O；OpenTTD 15.0 的 admin socket 关闭路径
   对时序敏感。

## 10.10 v0.2 spike: 自定义 Squirrel AI/GS 加载 + 标牌邮箱（2026-09-08）
以下事实经真机 (OpenTTD 15.0 dedicated) 逐项验证：

1. **自定义 AI 加载**: 把 `<Name>/` 包（info.nut + main.nut）放进 **sandbox `ai/` 目录**
   （在 openttd.cfg 已建立的数据目录内）→ `rcon rescan_ai` → `rcon start_ai "<Name>"`
   即建公司（实测 company_new + company_info isAi:true）。
   - info.nut 类 extends **`AIInfo`**（不是 `AIControllerInfo`）；方法需含 GetName/
     GetVersion/CreateInstance/GetShortName；文件尾必须 **`RegisterAI(Xxx());`**（漏了
     就不出现在 list_ai，start_ai 报 Failed to load）。
   - main.nut 类 extends **`AIController`**，Start() 需 while(true)+Sleep 常驻。
   - 扫描仅发生在 config dir 已建立（第二次运行起）；首次生成配置后再放包需 rescan。
2. **自定义 GS 加载**: `<Name>/` 放进 **sandbox `game/` 目录** → `rcon rescan_game` →
   `rcon list_game` 可见。**attach 到新图**: openttd.cfg 的 `[game_scripts]` 段写
   `<Name> = `（替换默认 `none = `）→ 下次 `-G` 生成地图即加载。
   - GS info.nut 类 extends **`GSInfo`**，**必须含 `GetAPIVersion()`**（否则编译失败
     "doesn't have the method 'GetAPIVersion'"），文件尾 `RegisterGS(Xxx());`。
   - main.nut extends **`GSController`**，Start() 必须 while(true)+Sleep 常驻，否则
     地图生成时 "The script died unexpectedly"。
3. **AILog 在 dedicated/macOS 不可达 console**（再证 SPEC §10.2）；用 arena 方案：
   **SetPhase 公司名编码**（`"<phase> j<job> r<routes>"`）经 admin poll COMPANY_INFO
   读回。
4. **Executor AI 标牌邮箱**: arena `nutz_executor/main.nut` 模式确认——`AISignList()`
   轮询 `NUTZ:bp:<job>:...` 标牌 → 按 S/E/W/D 槽位组装 job → 施工 → 记 failed/
   succeeded_jobs。标牌由 GS 放（GSSign），AI 只读消费。
5. **尚无 GS-only 施工证据**: GS 收 AdminGameScript 走 `ScriptEventAdminPort`（事件
   队列 GetEvent + GetObject() 取 JSON）；GS→Admin 走 `GSAdmin.Send(table)`。双向
   通道字节级已由协议文档确认，端到端 GS 回声待 v0.2 正式实现验证。

## 10.11 v0.2 spike: Bridge GS 双向通道打通（2026-09-08）
真机逐项验证（sandbox BridgeTest GS + AdminClient）：

1. **GS 事件 API（squirrel 侧）**:
   - 轮询: `GSEventController.IsEventWaiting()` + `GSEventController.GetNextEvent()`
   - 事件类型: `ev.GetEventType() == GSEvent.ET_ADMIN_PORT`（常量前缀 ET_）
   - **取 JSON 必须 `GSEventAdminPort.Convert(ev).GetObject()`**，不能 `ev.GetObject()`
     （直接调在非 admin 事件会崩/吞）
2. **GS→Admin**: `GSAdmin.Send({...})` → 客户端收到 `SERVER_GAMESCRIPT`（gamescript 事件）。
   **前提: AdminClient 必须订阅 `UpdateType.Gamescript`**（此前默认订阅漏了它 → 收不到）
3. **Admin→GS**: `AdminGameScript` 包(str JSON) → GS 收到 admin 事件 → 回 echo。
   **端到端实测**: ping → `{kind:"pong",cmd:"ping",ok:true}` 返回；心跳带 admin_seen/last_cmd 佐证。
4. **GSLog.Info 不进 dedicated server.log 也不进 admin console**（需靠 GSAdmin.Send
   回传状态；script 崩溃错误会以 console origin=script 事件到达）。
5. **蓝图→标牌**: arena `bridge_gs.py` 模式——`GSSign.BuildSign(tile, "NUTZ:bp:<job>:S:fr=..:eg=..")`
   S/E/D/W 槽位；Executor AI `AISignList` 消费（§10.10-4）。
6. **GS 心跳节奏**: while(true){HandleEvents(); 每~100 tick GSAdmin.Send 状态; Sleep(20)}。

## 10.12 v0.2 实现: 标牌邮箱可见性 + 决策链路打通（2026-09-08）
端到端真机验证「外部 → GS → 标牌 → Executor → 可观测动作」：

1. **标牌可见性模型（核心坑）**: 引擎标牌有 `owner`（signs_base.h）。GS 默认
   deity 模式放的标牌，executor 的 **AISignList 看不到**（其语义 = "signs your
   company has created"）。**修复**: GS 必须以目标公司身份放标牌 ——
   `local mode = GSCompanyMode(company_id); GSSign.BuildSign(...)`。
2. **GS 无法枚举公司**: GS API 无公司列表（无 GSCompanyList）。executor 公司 id
   必须由外部传入命令（`{cmd, company:0}`）；GS 侧不校验（IsValid 不存在于
   GSCompany 静态 API）。
3. **GSSign.BuildSign 返回 SignID 非 bool**: 首个标牌 SignID=0（SignID::Begin()），
   Squirrel 里 `if(0)` 为 false → `placed:0` 是误读。应放后数 GSSignList 差值。
   （注: deity 模式的 GSSignList 看不到 company-mode 放的标牌 —— 要在 company
   mode 内复查。）
4. **决策链路全通**: `--v02` demo: boot(j-1) → GS demo 放标牌 → executor 读
   `NUTZ:bp:7` → 借贷 → phase=work(j7)。外部经 admin poll COMPANY_INFO 实时可见。

## 10.13 OpenTTD Squirrel 字符串语义（血泪教训, 2026-09-08）
调试标牌解析消耗大量时间，根因全是字符串处理。必须钉死：

1. **`s[i]` 返回 integer**（该字符的数值/字节），不是单字符字符串！
   逐字符拼接 `acc += c` 会把数字拼进去（实测 "NUTZ" 首字符拼出 78...）。
2. **单引号字面量是 integer**：`':'` 是整数 58，不是字符串。传给 `find()`
   报 "parameter 1 invalid type integer"。
3. **正确做法**: 全部用双引号字符串 + `s.find(sep)`/`s.slice(a,b)` 切分；
   不用 `s[i]` 逐字符；字符串比较用双引号（如 `ch < "0" || ch > "9"`）。
4. **`"7".tointeger() == 7`**（数值），不是 ASCII 55。字符转数直接用
   `ch.tointeger()`。
5. **判空/遍历**: `AISignList()` 用 `foreach (sid, _ in sl)`；`AISign.GetName`
   可能返回 null（需判空）。标牌文本有长度上限（MAX_LENGTH_SIGN_NAME_CHARS），
   demo 名 "NUTZ:bp:7:S:fr=0:eg=-1" 22 字符安全。

## 10.14 v0.2 实现: Executor 全量施工（S2-S5, 2026-09-09, 真机）
从「收到 job」到「3 辆 bus 跑起路线」的真机实证。每项都是调试定位的根因。

1. **road type 前置条件（S2/S3 双卡死的同一根因）**: `BuildRoadStation` 和
   Pathfinder.Road 的邻居探测都在 **AITestMode 测试模式**内用 `AIRoad.BuildRoad`
   试建；若公司当前 road type 不是 ROAD，所有试建恒 false：
   - `BuildRoadStation` → `ERR_PRECONDITION_FAILED`
   - Pathfinder 邻居集为空 → 永远 `NOPATH`
   **修复**: 每次施工前 `AIRoad.SetCurrentRoadType(AIRoad.ROADTYPE_ROAD)`。
   隔离 probe 对照: 加一行后 25-tile 路线从 NOPATH → ROUTE。

2. **Pathfinder.Road v4 + AyStar v6 (2012) 长路死锁**: `FindPath(1000)` 对
   >~110 tile 曼哈顿缺口**单次调用 90s+ 不返回**（隔离 probe 实测），25 tile
   秒回。非迭代慢，是 AyStar 内部对不可达/超长目标的行为问题。**约束**:
   路径必须 ≤~60 tile。**解除办法（S6 前置）**: 分段铺路（每段 ≤60 拼接）。
   另: v3 用 `FindPath(50)` 循环让出（arena）；v4 语义同但长距仍死锁。

3. **normal bus stop 的入口方向 = BuildRoadStation 的 front 参数**。铺路后
   站若与 front 无法 `BuildRoad` 连通（`ERR_LAND_SLOPED`），车永远到不了站台。
   **修复**: pax 精扫移动站址时**保持 GS 给的 front 相对方向**（front−tile
   偏移整体平移），与 GS 已选的地形兼容。

4. **road depot 门连接**: `BuildRoadDepot(tile, front)` 建 depot 后必须
   `ConnectStop(tile, front)` 确保门前有路，否则车**永远卡在 depot 里**
   （真实症状: 状态 RUNNING、距站 6 tile、永不进站）。之后再用 Pathfinder
   从 front 铺到最近站 front。

5. **正常观测前提（runner 踩坑）**: company name 的 SetPhase 只在**名字变化**
   时产生 CompanyInfo push；观察期必须**轮询** CompanyInfo/Date/Economy。
   且任何报告路径的 API 调用都要在 try/catch 内（`AIOrder.GetOrderIndex`
   不存在 → 崩溃 → 所有 phase 报告静默停止，而引擎继续扣维护费 → 误判"手
   不动"）。诊断代码叠加会掩盖此类崩溃，保持单一路径。

6. **income 是 signed 64-bit**（协议按 u64 传）: 负利润读成巨大 u64。JS 侧
   `BigInt.asIntN(64, income)` 还原符号，否则永远误报 income>0。

7. **车队规模**: 单 bus 无法消化健康路线的客流（站 waiting 97→121 积压）；
   3 辆共享订单后排队降到 26-52。盈利与否在此阶段属决策质量（脑的职责），
   机械闭环验收 = 车跑/站载客/经济数据回灌（§ROADMAP v0.2.0 范围修正）。

## 10.15 v0.2.1: 分段贪心铺路解除 AyStar 长路死锁（2026-09-09, 真机）
§10.14-2 记录的 AyStar v6 >60 tile 死锁的工程解法（S6 LLM 可选长线的前置）：

1. **方法**: PhaseRoad 不再一次 FindPath 到目标，而是**贪心分段**：每 tick 只
   向 B 方向搜索 ~20 tile 的短段（probe goal），铺完推进 `_roadCur`，重复到终点。
   短段（≤20-25 tile）在 AyStar 秒回安全区内，永不触发死锁。
2. **probe 回退**: 无路/lay 失败时 probe 从 20 逐步缩短到 4（每 tick 限速重试），
   保证要么前进要么干净 abort，不空转。
3. **末段直达**: 剩余 ≤22 tile 时 goal = fB 本身（直接指向终点），避免越过目标
   把路铺进 B 站区域（旧 bug: 越过 fB 的 probe 路径穿站 → BuildRoad 失败 →
   `road_layfail` + done nobus）。
4. **LastTileOf 坑**: FindPath 返回的是 **goal 节点**（其 GetParent 链回源），
   前进终点 = 返回节点自身 tile（链头），不是链尾。曾因返回链尾导致 `_roadCur`
   恒等于 fA、seg 计数爆炸而 d 不变。
5. **选镇放宽**: GS PickTownPair 从 [15,60→90] 放宽到 [25→140→260]，让规划层可
   触达更远更大城镇（真机: pop 1457/1990、~109 tile 路线，103 段铺成并跑起 bus）。
6. **盈亏平衡是决策层职责**: 长线(109 tile)建设成本高、1950-06 时仍亏（income
   -52k/季 含建设摊销），但客流旺盛（waiting a109-185）。选多长线/投多少车/观察
   多久 = 脑(LLM)的决策，非"手"的机械验收（呼应 ROADMAP v0.2.0 范围修正）。

## 10.16 v0.2.1 实现: Pi Agent「脑」接线 + Provider 配置（2026-09-09）
把 LLM 决策接入已验证的命令通道。**使用官方组件，不自行实现 provider。**

1. **官方 provider 组件**: `@earendil-works/pi-ai@0.85.1`（= pi 仓库 `packages/ai`）
   提供 `createProvider` + `openAICompletionsApi`/`anthropicMessagesApi`（子路径
   `@earendil-works/pi-ai/api/*.lazy`，顶层 index 不导出这两个函数）。
   本地/自建端点用 `createProvider({ id, baseUrl, auth.apiKey, models, api })` 装配。
2. **pi-agent-core Agent 装配要点**: `AgentOptions.streamFn` 必填；`initialState.tools`
   需为 `AgentTool<TSchema, TDetails>[]`（typebox schema，泛型参数必须写全，
   否则 `execute` 的 params 被推断为 unknown）；`beforeToolCall` 返回用 `block`
   （不是 `blocked`）；`CustomAgentMessages` 声明合并的 module 名 = 包名。
3. **配置优先级**: env(显式) > `<dataDir>/llm.json`(dashboard) > 未配置。
   `providerId` 在 env 未显式设置时留空字符串，交给文件/默认兜底（否则默认值会
   把文件值永久压住）。
4. **密钥安全**: 对外视图/日志/审计一律脱敏（`redactKey`、audit `sanitize`），
   `GET /api/llm` 绝不回显 key；POST 留空 key = 保持原值（不误清）。
5. **faux ≠ 真 LLM**: pi-ai 的 faux provider 是脚本桩，只能验证接线，**不能**
   验证决策质量。真实验证用**本地 OpenAI 兼容 stub + 真实 HTTP**
   （test/unit/agent-provider-http.test.ts + scripts/llm-stub.ts），
   或由用户配置真实 key。
6. **决策循环的非阻塞契约**: 施工是分钟级异步过程，工具**发出即返回**
   （ack 语义），LLM 靠 `observe` 轮询进展；禁止在工具内等待施工完成。
7. **审计**: 决策点 + 动作结果落 `<dataDir>/agent-audit.jsonl`（append-only、
   密钥脱敏、写失败不影响循环）。
8. **真机 E2E 验证（2026-09-09）**: dashboard 保存 → `llm.json` 落盘 → **另一个进程**
   `--agent`（显式 `env -u` 清空所有 `LLM_*`/`OPENAI_API_KEY`）读到该文件并走
   **REAL provider** 分支，真发 HTTP 到本地 OpenAI 兼容 stub 并产生
   `build_bus_route` 工具调用（audit JSONL 有 decision + action_result）。
   落盘路径 = `<OPENTTD_DATA_DIR>/llm.json`（默认 `/tmp/openttd-agent-data/llm.json`），
   dashboard 面板仅存在于 `--watch`（`--agent` 不起 WebServer）。
9. **合并不可烘焙默认值（本次真机暴露的 bug，root cause）**: `applyLlmSettingsFile()`
   曾把 `"openttd-llm"` 作为 providerId 兜底写进合并结果，而 CLI 启动时就已经
   `applyLlmSettingsFile(loadConfig())` 烘焙过一次 → watch 进程内再次合并时，
   **烘焙后的非空值反过来压住了刚保存的文件值**（现象: `POST /api/llm` 返回
   `e2e-file`，同一进程随后 `GET` 却回 `openttd-llm`；新起的 `--agent` 进程反而正常）。
   修法: 合并层 providerId 兜底改为 `""`（不烘焙），默认值只在**使用点**
   （`buildProvider`，具名常量 `DEFAULT_LLM_PROVIDER_ID`）应用；合并因此**幂等**
   （`apply(apply(x)) === apply(x)`，已用单测锁定）。原则: 合并函数只做
   「env > file > 空」，默认值永远在使用点解析。

## 10.17 v0.3.0 实现: Dashboard 三页化 + 多 Provider 目录 + Agent 遥测（2026-09-10）
把 dashboard 从「极客 log 面板」做成可用的 Agent 控制台。**契约冻结在
`docs/DASHBOARD-API.md`（前后端并行开发的单一事实源）。**

1. **页面结构（无构建链）**: `public/pages/*.html` + `public/assets/{css,js}/*`，
   路由表 `PAGES` 在 `src/web/server.ts`（URL 保持扁平 `/llm`、`/sessions`）。
   Live 页与 LLM 配置**解耦**：provider 配置独立成 Providers 子页。
2. **pi-ai 内置 provider 目录（实测）**: `@earendil-works/pi-ai/providers/all` 的
   `getBuiltinProviders()` = **39** 个静态 provider，`builtinModels()` 注册 40 个
   （多出纯动态 `radius`），合计 ~1900 模型。**catalog 路径不再手建 provider**：
   `builtinModels({credentials}).getModel(id, model)` + `models.stream(...)` 即可，
   baseUrl/认证由 pi-ai 自行解析。
3. **环境变量名必须“探测”而非猜测（重要坑）**: pi-ai **不**在 provider 对象暴露
   env 变量清单（`envApiKeyAuth(name, envVars)` 闭包掉了；anthropic/google 用自写
   `resolve()` 读非约定名如 `ANTHROPIC_AUTH_TOKEN`/`GEMINI_API_KEY`）。
   且 `findEnvKeys(id)` 返回的是**当前环境已设置**的名字，不是“期望的名字”
   （local 下直接调用恒为 `undefined`，极易误判）。
   正确做法: 对候选名逐个 `findEnvKeys(id, { [候选名]: "probe" })`（**合成 env，不碰
   process.env**），只有 pi-ai 真正接受的名字才会返回。命名约定 + 核实过的例外表
   （moonshotai→`MOONSHOT_API_KEY`、huggingface→`HF_TOKEN`、kimi-coding→`KIMI_API_KEY`、
   vercel-ai-gateway→`AI_GATEWAY_API_KEY`、azure-openai-responses→`AZURE_OPENAI_API_KEY`、
   anthropic→`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_OAUTH_TOKEN`）
   → **31/39 解析成功**；其余 8 个（bedrock/vertex/copilot/codex/cloudflare×2/opencode-go/
   qwen-token-plan-individual）无 API-key env，改为返回 `hint` 文案。
4. **凭据持久化**: pi-ai 的 `CredentialStore` 是**应用注入**的（默认 `InMemoryCredentialStore`
   仅内存）→ 自建 `FileCredentialStore`（`<dataDir>/credentials.json`，0600，原子写）。
   catalog 密钥存这里、**绝不**写进 `llm.json`；`llm.json` 只存选择（source/provider/model/api/baseUrl）。
5. **`models.getAvailable(id)` 不能用于列目录**: 无 auth 时返回 `[]`（只列可认证模型）→
   浏览目录必须用 `getBuiltinModels(id)`（全量）。
6. **遥测**: 消费 pi-agent-core `AgentEvent`（`message_update` 累积
   `thinking_delta`/`text_delta`；`message_end` 落 `AssistantMessage.usage`；
   `tool_execution_start/end` 算耗时），聚合成 token 总量 / 按 turn / 按 tool。
   **`Agent.subscribe()` 的监听器必须 await（subscribe 的返回不是 api）**，且必须在
   `submitMessage` **之前**注册，否则丢事件。WS 遥测帧必须**节流 ≥250ms**（thinking delta
   会刷爆连接）。
7. **合并函数不得烘焙默认值（真机暴露的 bug）**: `applyLlmSettingsFile()` 曾把
   `"openttd-llm"` 兜底写进合并结果，而 CLI 启动已合并过一次 → watch 进程内再次合并时
   烘焙值反过来压住刚保存的文件值（POST 返回新 id、同进程 GET 回旧 id；新进程正常）。
   修法: 合并层兜底 `""`，默认值只在**使用点**（`buildProvider`）解析，合并因此幂等。
8. **同步写入 vs pi-ai 异步 `modify()`**: dashboard 保存密钥若走 `modify()`（微任务队列），
   同一 tick 回读会 stale（`hasStoredKey:false`）→ 提供同步 `set/remove/has` 路径。
9. **无构建链前端的门禁**: `tsc`/eslint **看不到** `public/**` 的 JS。新增
   `test/unit/web-assets.test.ts`：`node --check` 全部脚本、校验每个 `href/src` 指向真实文件、
   `PAGES` 目标存在、页面脚本不得使用 `common.js` 未导出的符号、public 根目录不得有散落文件。

## 10.18 v0.5.0 实现: 启动门禁 + Session 生命周期 + 图表语义（2026-09-11）
契约: `docs/STARTUP-AND-LIFECYCLE.md`（门禁与生命周期）、`docs/DASHBOARD-UI.md` §6c（图表选型）。

1. **禁止静默降级（行为修正）**: 此前 `--agent` 在 LLM 未配置时**静默换成 faux** 并照常
   启动游戏/部署 GS/建线 → 用户看到"无脑模拟"。现在先决条件不满足即**拒绝启动**。
   无 LLM 只能通过显式 `--offline-demo` 运行，且 UI 标注为非真实 LLM。
2. **门禁必须在副作用之前**: brain 装配原先在 boot 之后，导致"检查了但已经启动了"。
   顺序固定为 preflight → spawn → session。preflight 不写任何会话文件。
3. **LLM 可用性需要真实请求**: `isLlmConfigured()` 只判断字段齐全；key 失效/端点不可达/
   模型下线都测不出来。用 `buildBrain()` 走**与运行期同一条路径**发最小请求，
   首个事件即判定（避免"检查的和用的不是同一个"）。
   **pi-ai 的流式失败不抛异常**，而是产出 `{type:"error"}` 事件 —— 只看 try/catch
   会把死端点误判为可用（实测踩到）。
4. **心跳 + 派生状态**: 强杀进程时 `finalize()` 不会执行，盘上永远 `running`。
   runner 每 2s 写 `heartbeatAt`；`effectiveStatus()` 在**读取时**把超时（15s）的
   `running` 判为 `interrupted`（不写盘，幂等）；`reconcileStaleSessions()` 在启动时固化。
   注意 `listSessions` 走 **index.json**，因此心跳必须同时更新 index，否则读者看到的是陈旧记录。
5. **和解必须看"原始"状态**: `effectiveStatus` 把"过期 running"和"已和解"都映射为
   `interrupted`，用它做幂等判断会导致每轮都重写；必须先用存储态的 `status === "running"` 过滤。
6. **柱状图零基**: `niceDomain()` 的 4% 内边距会把非负序列的 y 轴拉到 0 以下，
   柱子悬空、下方死区（实测悬空 ~30px）→ 柱图用 `zeroBasedDomain()`。
7. **构成数据不能用折线**: 输入/输出/推理量级差 ~20 倍时三条折线挤压在同一像素带
   （实测 3px 内），应改用堆叠柱。
8. **前端空态也要定尺寸**: 跳过 `fit()` 会留下默认 300×200 backing store，
   配合 `canvas{width:100%}` 无 CSS 高度 → 3:2 方框，数据到达时高度跳变。

## 10.19 v0.6.0 实现: 决策循环对齐 SPEC §1.1/§4.2 + 运行控制 + 阶段画面（2026-09-11）
契约: `docs/AGENT-LOOP-AND-CONTROL.md`（对齐记录 §2.0）。**本轮修的是"没按 SPEC 实现"**。

1. **`maxTurns ?? 1` = 整局只决策一次（最严重的偏离）**: LLM 在 1950-01-01 建一条线后
   再也没被问过，收入一路下滑也无人补救。真机证据：三个 Session 均
   `mode=watch` + `kind=faux` + `decisions=0`——用户看到的是内置 CPU AI 在打，
   而面板一切正常。**这是"无脑操作"的真正根因，不是 LLM 不行。**
2. **`DecisionScheduler`（何时问）与 `DecisionContext`（问什么）分离**:
   - 触发: `start`/`phase_change`/`wait_until`/`interval`(每月)/`event`/`manual`；
     同窗口内多触发**合并**为一次（取优先级最高），避免施工事件风暴烧 token。
   - 载荷含 `sinceLastDecision`（money/income/vehicles 变化、阶段列表、上次动作结果、
     显著事件）——没有它模型无法判断"我上次改的东西有没有用"。
3. **SPEC §1.1 六步落地（冻结-观察-决策-执行-解冻）**: 决策前 `rcon pause`、
   决策后 `rcon unpause`。不冻结时模型作答期间世界仍在推进，动作落在它没见过的状态上。
4. **SPEC §4.2 步骤 2 结构化计划**: prompt 要求
   `{goal, plan[], immediate_action, wait_until, rationale}`。**接口由框架定，
   内容全由模型填**（§2.4 禁止引导）；解析失败退回 `interval` 兜底，绝不中断。
5. **轮询必须在决策循环之前启动**（本次踩到的顺序 bug）: 阶段变化与经济数据靠
   admin poll 发现，曾经 poll 循环写在决策循环之后 → 永远发现不到阶段变化 →
   调度器收不到 `phase_change` → 仍表现为"只决策一次"。
6. **运行控制（`--serve` 监督模式）**: 常驻 WebServer + `RunSupervisor`；
   `POST /api/run/{start,stop,pause,resume}`；`GET /api/run`；WS 帧 `run`。
   被监督的 run **复用**已有 WebServer（`WebServer.attach()` 晚绑定 hooks），
   否则一个端口两个扇出。stop = `aborted`（用户主动停止 ≠ 达成目标）。
7. **阶段画面（#5）**: ⚠️ **本条的初版结论是错的，已修正**。初版只试了 `screenshot`
   就断言"headless 下截图不可能"。穷举变体后实测：
   - `screenshot` / `big` / `giant` / `no_con` → `Screenshot failed!`（需 3D 视口 + 帧缓冲）
   - **`screenshot minimap` → 成功**，写出 256×256 RGB PNG（`screenshot/screenshot.png`）
   - `minimap big` 只改文件名，尺寸不变；`minimap no_con` **失败**

   小地图由**地图数据**渲染，不经过 3D 视口，因此 headless dedicated server 可出图。
   SPEC §10.2 的"视觉像素"边界仅指**视口画面**。
   实现：每个施工阶段 `captureMinimap()` → `<session>/stages/NNN.png`（与同名
   `NNN.json` 几何描述配对）；命令返回 ≠ 落盘，必须**轮询 mtime**，否则归档到上一张。
   拿不到 PNG 时前端降级画 `stage-view.ts` 的示意图。
   教训：**"某个变体失败"不等于"整个能力不可得"**。
8. **E2E 必须证明"智能真的接上了"（AGENTS.md §5.1）**: v0.3~v0.5 的 E2E 只验证
   "进程起来了 + 有 token 计数"，所以"压根没接线"这类错误无人发现。新增
   `test/live/agent-loop.test.ts` 断言 7 条：`llm.kind==="real"`、`mode==="agent"`、
   `decisions>=2`、`tokens>0`、audit 有 `decision`（带 trigger）与 `action_result`、
   trigger 不全为 `start`、dashboard telemetry 非零。

---

## 附录 A — 关键事实来源
- 本地: `openttd -h` 输出 (v15.0), `~/Documents/OpenTTD/openttd.cfg` (admin_port=3977, allow_insecure_admin_login=false)
- `OpenTTD/docs/admin_network.md`: 协议、packet 类型、订阅、RCON、双向 gamescript
- `src/network/core/tcp_admin.h`: `AdminGameScript`/`ServerGameScript` 包定义
- `src/script/api/script_event_types.hpp`: `ScriptEventAdminPort` (GS 收 admin JSON)
- `src/script/api/script_admin.hpp`: `GSAdmin.Send(table)` (≤1450B JSON)
- 先例: jplattel/openttd-llm, walter-grace/agent-openttd-arena (bridge_gs.py/blueprint.py/nutz_executor), OpenTTDLab

## 附录 B — 术语
- **RCON**: Admin Port 远程 console 命令
- **GS (GameScript)**: 全局限 1 个的游戏脚本（`GSController`），可收 admin 消息/推状态
- **AI**: 每公司 1 个的玩家替身（`AIController`），拥有完整 DoCommand 施工能力
- **Executor AI**: 我方放进 agent 公司的施工 AI
- **Bridge GS**: 我方唯一 GS，负责状态/命令/标牌中继
- **蓝图 (Blueprint)**: GS 收到的高层施工 JSON → 拆成标牌序列
- **GameEvent**: Runner 内部规范化事件类型

## 10.20 `add_vehicles` 的真实语义（2026-09-12 实测澄清）

一段真实 e2e 日志里，模型连续 4 次调用 `add_vehicles` 得到 `ok=true`，而 `vehicles` 始终为 0。
排查后固化为以下事实（**不是推测**）：

1. **GS 的 ack 报的是标牌**。`{"kind":"ack","cmd":"add_vehicles","placed":1}` 里的 `placed`
   指 **`GSSign.BuildSign` 成功**，与"放了几台车"无关。字段已更名为 `signPlaced` 以免再次误读。
2. **标牌只是一个请求**。GS 在 exec 公司的模式下放 `NUTZ:bp:<job>:V:<count>` 标牌；
   真正执行的是执行器 AI。
3. **执行器只在特定状态下读它**。`CheckAddVehicles()` 的调用条件是
   `_stage == "done" && _vehicle >= 0`。若施工未完成（阶段停留在 `road`），
   这个标牌**永远不会被读取**。
4. **该命令只能"克隆"，不能创建第一台车**。`CheckAddVehicles` 用
   `AIVehicle.CloneVehicle(..., this._vehicle, ...)` 扩容；`_vehicle` 由 `PhaseBus()`
   的 `AIVehicle.BuildVehicle` 设置。因此**车队为 0 时该命令不可能生效**。

**结论（写入工具契约）**：`add_vehicles` 的前提是**路线已上线且有头车**。
`src/agent/tools/index.ts` 现在会在 `vehicles == 0`（或公司无 stats）时**拒绝发送**并
说明原因与下一步，而不是报 `ok=true`。

## 10.21 两个 runner 的事件转发契约（2026-09-12 修正）

`--watch` 与 `--agent` 都必须把规范化事件推给 Dashboard（`web.publishEvent`）。

**曾经只有 `--watch` 做了**（`src/game/runner.ts`），`--agent` 从不转发。
后果：在**主模式** `--agent` 下，页面收不到任何 `event` 帧 →
`companies` / `history` 镜像永不推进 → **KPI 冻结在连接时的快照上，必须手动刷新**。

这与 `toWireSnapshot` 的两份实现是同一类缺陷（MEMORY.md C1）：两条路径，
其中一条少了一段，而另一条的"看起来正常"掩盖了它。现已补齐，并加了一致性测试。

## 10.22 RL Harness 范围（2026-09-12 重申并固化）

**初始化只给 agent 背景知识；一切智能行为靠环境学习。**

判据（写 prompt / 工具文案 / 注入内容前逐条对照）：

| | 属于 Harness |
|---|---|
| 工具与子系统的**契约、前提**（"本工具靠克隆头车扩容"） | ✅ 像函数签名 |
| **世界事实与因果**（施工异步、贷款利息） | ✅ |
| **交互协议**（JSON 键、何时让出回合） | ✅ |
| **策略**（"你应该…"、"优先…"、"队列长了就加车"） | ❌ agent 自己学 |

一句话自检：**这句话是在描述世界，还是在替它做决定？**

**为什么这是硬约束**：被剧透的 agent 不会试错，也就没有可学的教训。
框架给策略 = 删掉 agent 的探索空间。

**机械守卫**：`test/unit/agent-runtime.test.ts` 检查 SYSTEM_PROMPT、
每个工具 description、每个拒绝信息是否出现策略措辞。

**已发生的违反（供后人对照）**：2026-09-12 之前，
`evolution/lessons.ts` 把经验渲染成 `DO:` / `AVOID:` 祈使句，
并以 user 角色**每次 LLM 调用都前置注入**；且只要库里有内容就自动注入。
详见 `docs/RL-HARNESS-SCOPE-AUDIT.md`。现已改为对过去的**陈述**，
且 `loadMemory()` 默认 `inject: false`（不显式要求连库都不读）。

## 10.23 执行器阶段的解码契约（2026-09-12）

执行器唯一的回报通道是**公司名**（OpenTTD 上限 31 字符，§10.10），所以它把状态压成了
电报体：`EX rd s0 r0 j100`、`EX hb road #11`、`EX done stN2 r1 bus`。

**语法只存在于 Squirrel 源码里。** 把原始串交给模型 = 交给它噪声：`rd` 是什么？
`s0` 是第 0 段还是第 0 站？`r0` 是重试还是半径？

因此 `src/game/executor-status.ts` 负责把这层**接口词汇表**翻译成一句可读叙述，
再由 `decision-context.ts` 交给模型。这属于**补齐事实**，不是给策略 ——
翻译之后"这个阶段意味着什么、值不值得等"仍由 agent 自己判断（§10.22）。

同一次修正还包括：
- **心跳折叠**：`hb road #1..#40` 是 40 条相同事实，会淹没唯一变化的那一条。
- **区分"在忙"与"卡住"**：`rd s0 r0`（搜索进行中，非失败）与 `road_stuck`（放弃）
  对 agent 的意义完全相反，`error` 字段显式区分。
- **失败必须带原因**：`road_stuck` 改为 `road_stuck:<reason>`。没有原因，
  agent 无法从失败中学到任何东西（§10.20 的同一原则）。

## 10.24 第二条 admin 连接不能给 GS 发命令（2026-09-12 实测）

在 `--serve` 已经跑着一局时，另外用一个 admin 客户端连接并 `gameScript({cmd:"probe_cm"})`：

- 客户端**连接成功**（`connect` 返回、日志确认 `connected`）
- `gameScript()` 发送**无异常**
- **GS 侧完全没有收到**（`ScriptEventAdminPort` 无任何反应，GS 无输出）

结论：**不要假设"多开一个 admin 客户端就能旁路给 GS 下命令"**。
要做外部探针，要么复用已连接的那个客户端，要么让 GS 自己定时/启动时执行。

用途：未来写"外部诊断工具"或"spike"时必须知道这一点，否则会得到
"命令发了但没反应"这种无法定位的假象（与 §10.21 的事件转发缺失同类）。

## 10.25 GS 可对公司施工并扣公司钱（2026-09-12 真机证实）

这是 `SPEC.md` L355 要求、但从未执行的那个 spike 的结果。

**实测**（`probe_cm`，Bridge GS 自触发，macOS dedicated，seed 7）：

```json
{"cm_valid":true, "money_before":298825, "money_after":298518, "road":"ok"}
```

- `GSCompanyMode(0)` 有效
- `GSRoad.BuildRoad` 返回 **true**（真的建成了）
- 公司余额**减少 307**

逐字复现了官方文档 `script_companymode.hpp` 的语义：
*"All actions performed within the scope of this mode, will be executed on behalf of
the company you switched to. This includes any costs attached to the action performed."*

**推论：Executor AI 是可删除的组件。** `script_road.hpp` / `script_vehicle.hpp` /
`script_station.hpp` 均标注 `@api ai game`，GS 与 AI 共享同一套施工 API；
GS 还能直接收 admin 消息、直接用 `GSAdmin.Send` 发结构化 JSON。
→ SPEC §10 里"AI 不能直接收 admin 消息"这条约束**不再构成架构约束**。
详见 `docs/EXECUTOR-ARCHITECTURE.md`。

### 10.25.1 两条附带实测事实

1. **tick ~200 时 company 0 尚不存在**（`GSCompany.ResolveCompanyID(0)` 返回
   `COMPANY_INVALID`）。任何"公司一开局就在"的假设都是错的。
2. **没有订阅者的 `GSAdmin.Send` 会被静默丢弃**。GS 在 `Start()` 里发的探针消息
   完全收不到；改到周期性发送（已知能到达 agent）后正常。
   → 写任何 GS 侧自检，必须**先证明通道是通的**，否则会得到"跑了但没反应"的假象。
3. **`GSEngineList` 需要一个载具类型参数**：`GSEngineList(GSVehicle.VT_ROAD)`。
   不传会报 "wrong number of parameters"。正确用法以 `executor-ai/main.nut`
   的 `PickBusEngine` 为准（那是本项目已验证的参照实现）。
4. **GS 周期块不 tick 时，挂在里面的探针不会跑**。连续两次真机运行
   `"cmd":"state"` 出现 0 次，说明 GS 的周期性代码块根本没执行 ——
   怀疑游戏被 pause 住（与 §10.21 的事件转发、ROADMAP §4b 的 `boot` 停顿同源）。
   **这是当前挡住施工与探针的唯一拦路石。**

## 10.26 决策循环的 freeze/thaw 必须有 finally（2026-09-12 实证）

`src/agent/runner.ts` 在决策前 `rcon("pause")`、决策后 `rcon("unpause")`。
最初两份 rcon 各自包在独立的 `try { ... } catch { /* ignore */ }` 里，**unpause 不在
finally 里** —— 如果 `runDecision()`（含 `agent.prompt()`）抛错，unpause 永不执行。

**后果**：游戏永久暂停 → GS 不 tick → 周期块不执行 → 执行器不推进。
agent 拿到一个冻结的世界，看起来像"半成品"，**实际上是 unhandled-pause bug**。

**修复**：把 pause/runDecision/unpause 包进 `try { ... } finally { rcon("unpause") }`。

**结构性守卫**：`test/unit/runner-freeze-thaw.test.ts` —— 静态扫描
runner.ts，禁止以后再次引入无 finally 的 unpause。

**未做的事（截至 2026-09-12）**：真机测试仍呈现 **flakiness** —— 同一命令
`--agent --offline-demo --seed 7` 偶尔执行器推进到 `EX road_start`，偶尔停在
`EX boot j-1` 不动。本节修复**保证 unpause 必定触发**，但不保证 100% 推进。
真正的根因可能是 OpenTTD 在 macOS dedicated 下的脚本 tick 时序，
需进一步观测。ROADMAP §4b 仍是开放的。

## 10.27 执行器"假死"的真正根因：路径搜索占满单个 tick（2026-09-12 实测）

**症状**：执行器长期停在 `EX boot j-1` 或 `EX road_start`，**没有任何心跳、没有任何
异常上报** —— 静默与死亡无法区分。

### 根因 1：心跳从来没有响过

心跳判据是 `AIController.GetTick() - _lastBeat > 300`。
`GetTick()` 返回的是**脚本 tick**（`script_controller.hpp`：*"Find at which tick your
script currently is"*，且 `Sleep` 的注释明确说 *"a script tick is different from
in-game ticks and differ per script speed"*）。它**从未超过 299**，
所以心跳一次都没发过。

**后果**：执行器**根本没有存活信号**。这就是"卡住"无法诊断的原因 ——
沉默和死了长得一模一样。

修复：改用**循环计数器**（`_loopSeq % N`），不再依赖 `GetTick()` 语义。

### 根因 2：`FindSegment` 在**单个 tick 内**最多跑 2000 次路径搜索

```squirrel
while (p == false && i < 40) { p = pf.FindPath(50); i++; }
```

而**本文件自己的注释早就写着**：*"Pathfinder.Road v4 + AyStar v6 deadlocks on long
single searches (>~60 manhattan; probe: FindPath(1000) **never returns**)"*。

搜索在 `Tick()` 内部同步执行，所以 `FindPath` 一旦不返回，**整个 AI 一起冻结**：
没有心跳、没有阶段变化、没有施工。

修复：把 pathfinder **持久化到成员**（原来每次调用都新建，状态丢失），
**每次调用只跑一个 chunk**（`FindPath(50)`），在 chunk 之间让出。
搜索总预算不变（40 chunk × 50 = 原来的 ~2000），但摊到 40 个 tick 上。

**实测对比**（同一命令，80 秒）：

| | 修复前 | 修复后 |
|---|---|---|
| 阶段序列 | 停在 `rd s0 r0` 不动 | `rd s0 r0 → r1 → r2` **重试计数在推进** |
| 心跳 | **从未出现** | `EX hb road #1 s3 j100` |

### 顺带**证伪**了一个假设

心跳里带上了执行器**实际能看到的 NUTZ 标牌数**（`s3`）：
**执行器能看到全部 3 个标牌**。所以 ROADMAP §4b 里"`AISignList()` 可见性竞态"
的猜测**是错的** —— 方案下达没问题，问题在施工搜索。

### 还有一条待查（新增）

80 秒内只跑到第 6 次循环（心跳 #1），即 **每轮循环 >6 秒**。
`Sleep(5)` 不该这么慢 —— 执行器的 **script tick 供给严重不足**，
这至少部分解释了"施工慢到看起来像卡住"。待查：脚本速度设置。

## 10.28 控制台 `pause` 是**单向**的 —— 这就是"执行器假死"的最终根因（2026-09-12 实测）

### 事实

`rcon("pause")` 会把 `Commands::Pause(PauseMode::Normal, true)` **投进游戏循环的命令队列**。
游戏一旦暂停，**那个循环就不再排空队列**，于是随后投进去的 unpause **永远不会执行**。

OpenTTD `src/console_cmds.cpp` 原文：

```cpp
// unpause
if (_pause_mode.Test(PauseMode::Normal)) {
    Command<Commands::Pause>::Post(PauseMode::Normal, false);   // 只有这一条路
} else if (_pause_mode.Test(PauseMode::Error)) {
    "Game is in error state and cannot be unpaused via console."
} else if (_pause_mode.Any()) {
    "Game cannot be unpaused manually; disable pause_on_join/min_active_clients."
}
```

`unpause` **只清 `PauseMode::Normal`**；只要还有任何其它 pause 位，它就**拒绝**。

### 实测证据（决定性）

| | 带 `rcon("pause")` | 去掉之后 |
|---|---|---|
| 游戏日历（120–170 秒） | `712225 → 712226`（**1 天**） | `712225 → 712299`（**74 天**，1000 tick 走 15 天 = 正常速） |
| GS 状态消息 | 正常发送（3200 脚本 tick） | 正常发送 |
| 执行器阶段 | 停在 `EX boot j-1` | `boot → work → stA_ok → road_start → rd s0 r0…r7` |
| 心跳 | **从未出现** | `EX hb road #1 s3` / `#2 s3` 正常 |

"脚本在跑、世界不动"就是暂停的指纹：GS 在发状态，日历却不动。

### 结论与修正

> **2026-09-17 复核（见 §10.59）**：本节当时把"暂停不可恢复"归因于 rcon 本身，
> 但用 rcon 回执通道 + `getdate` 实测（sandbox 配置 `pause_on_join=false`、
> `min_active_clients=0`）显示 **pause/unpause 双向有效**：暂停期间日期不动，
> `unpause` 之后日期恢复推进。当时的真正原因更可能是**网络默认值**
> （`pause_on_join=true` 且无客户端），而那正是本节末尾顺带修掉的配置。
> 本节保留原样作为历史，但"暂停是单向的"**不再是事实依据**。

**决策循环不再暂停游戏**（`src/agent/runner.ts`）。SPEC §1.1 step 2 的设计意图
（"别让世界在 LLM 思考时动"）由另一套机制承担，而且更诚实：

- 观察在**询问之前**取（`preSnap`）
- `sinceLastDecision` 如实汇报期间的变化（金额/收入/车辆/阶段/动作）
- 模型看到的是"世界在我思考时**确实动了**，这是变化量"，而不是"世界没动"这个假象

**守卫**：`test/unit/runner-freeze-thaw.test.ts` —— 决策循环 ±60 行内不得出现
控制台 pause/unpause（先剥离注释，否则会误伤解释这段陷阱的注释本身）。

### 顺带修正的配置事实

沙箱 `openttd.cfg` 的 `[network]` 块是**整块替换**的，原先没有写
`pause_on_join` / `min_active_clients`，于是回落到 OpenTTD 默认
`pause_on_join = true` —— 对无人驾驶 harness 是错的。现已显式写死
`pause_on_join = false` / `min_active_clients = 0`（`process-manager.ts` + 单测）。

## 10.29 执行器跑通完整公交线（2026-09-12 真机验收）

修掉 §10.28 的"单向暂停"之后，执行器**首次端到端跑通**：

```
[agent] RESULT: constructionDone=true  vehicles=3  stations=2  money=267375
executor phase: EX done stN2 r63 bus j100
```

| 验收项 | 实测 |
|---|---|
| 阶段走完 | `boot → work → stA_ok → stB_ok → road_start → (rd s0…sN) → depot → bus → done` |
| `constructionDone` | **true** |
| 车站 | **2** |
| 车队 | **3**（1 台购入 + 2 台克隆，与其设计一致） |
| 路 | **63 段** |
| 车辆状态 | `EX R53 d33 a24 #17` = **RUNNING，速度 53**，距 A 站 33 格，A 站候客 24 |

### 诊断字段（本次新增，让搜索过程可读）

`rd s<段> r<重试> d<剩余格> p<探针失败数>`，例如：

```
EX rd s0 r0  d61 p0    ← 第 0 段，剩余 61 格，探针从未失败
EX rd s0 r40 d61 p0    ← 用满 40 个 chunk 预算
EX rd s0 r0  d61 p0    ← 预算耗尽 → 探针缩短 → 重试计数归零
EX rd s1 r0  d21 p0    ← 第 1 段，剩余 21 格
```

**`p0` 是关键数据**：探针**从未失败** → 目标格一直找得到；
卡住的从来不是"选不到目标"，而是 **pathfinder 需要跑满多次 chunk**。
这与 §10.27 的修复吻合（把 2000 次迭代摊到 40 个 tick 上），也解释了
"为什么看起来像卡住但最终能过"。

### 附带事实

`DumpBus()` 是**车辆诊断**通道（`R`=RUNNING / `S`=STOPPED / `D`=IN_DEPOT /
`@`=AT_STATION / `B`=BROKEN / `X`=CRASHED，后跟速度、距 A 格数、A 站候客数）。
`done` 之后的阶段字符串**全部来自它**，不是施工阶段。
`src/agent/executor-status.ts` 的**解码器已覆盖这一族**：
`R53 d33 a24 #17` → "the bus is running at speed 53, 33 tile(s) from station A,
and 24 passenger(s) waiting at station A"；`B`/`X`（抛锚/撞毁）标为 `error`
（**"在忙"与"不赚钱"必须分开**，否则 agent 学不到东西）；
`@62,136 station d0` → 坐标 + 脚下是什么 + 距 A 格数。

**顺带修掉一个"自信地给出错误含义"的分支**：解码器里原有一个猜测性的
`@` → "正在扫描车站选址"分支，会**遮蔽**真正的车辆位置探针格式，
于是 agent 拿到的是**错的**解释。已删除 —— **没有含义好过错误的含义**。

## 10.30 `seconds` 从未限制运行长度（2026-09-12 实测）

真机现象：`--demo-seconds 190` 实际跑了 **28 分钟 / 251 次决策**才被手动杀掉。
运行本身是**健康的**（20 台车、游戏内过了 2 年），只是**没有上限**。

根因：决策循环是 `while (!stopRequested)`，**不含任何截止检查**。
`opts.seconds` 只在循环**之后**被用：

```ts
if (opts.seconds && opts.seconds > 0) {
    await Promise.race([stopPromise, sleep(opts.seconds * 1000)]);
}
```

它限制的是"循环结束后还要再等多久" —— 一个**永远走不到**的分支。
`maxDecisions` 也一样：只有在调度器产生一次决策时才检查。

**后果**：任何"跑 N 秒"的意图都不成立。对 M3 对照实验
（同 seed、每臂 3 局）这是致命的 —— 局长不可控，实验无法进行。

**修复**：把截止时间算进循环：

```ts
const deadline = opts.seconds && opts.seconds > 0 ? Date.now() + opts.seconds * 1000 : null;
while (!stopRequested) {
    if (deadline !== null && Date.now() >= deadline) { ...; break; }
```

循环现在已经拥有运行长度，循环之后那段 `Promise.race` 随之删除
（连同只服务于它的 `resolveStop`）。

**实测**：`--demo-seconds 60` → **76 秒**（60s 运行 + ~16s 启动），
日志 `[agent] run length reached (60s) - stopping`，metrics 正常落盘。

**守卫**：`test/unit/runner-freeze-thaw.test.ts` 断言循环体前 12 行内出现
`deadline` 与其比较。

## 10.31 M3 对照实验结果（2026-09-12，首次真实数据）

SPEC §9 要求的验收：**同 seed 带 / 不带 lessons 各 3 局**。已跑完
（真实 LLM `minimax-cn / MiniMax-M3`，seed 7，每局 200 秒）。

### 原始数据

| # | 臂 | 注入 lessons | money | vehicles | stations | 建成 | tokens |
|---|---|---|---|---|---|---|---|
| 1 | 对照 | 0 | 266791 | 3 | 2 | ✅ | 399367 |
| 2 | 对照 | 0 | 266784 | 3 | 2 | ✅ | 450730 |
| 3 | 对照 | 0 | 256927 | 5 | 2 | ✅ | 402678 |
| 4 | 处理 | 5 | 256979 | 5 | 2 | ✅ | 302008 |
| 5 | 处理 | 5 | 266768 | 3 | 2 | ✅ | 257021 |
| 6 | 处理 | 8 | 266788 | 3 | 2 | ✅ | 490610 |

### 结论

| 指标 | 带 lessons | 不带 | 差异 |
|---|---|---|---|
| 均值资金 | 263511.67 | 263500.67 | **+11（0.004%）** |
| 均值 token | **349879.67** | 417591.67 | **−16.2%** |
| 建成率 | 1.0 | 1.0 | 无差异 |

**① 资金上测不出差异。** +11 相对于两臂各约 9800 的组内极差（3.7%）是**纯噪声**。
**不得**据此宣称"记忆让 agent 更会赚钱"。

**② token 少 16%** —— 这是本次唯一值得注意的信号，但 **n=3，只能作为假设**，
SPEC §5.3 禁止据此下结论。若要证实需要更多局。

**③ 最重要的发现：这个任务的结果指标已经饱和。** 六局**全部建成**（`builtRate = 1.0`）。
一个 agent 每次都能完成的任务，**在"能不能做成"上没有提升空间**，
所以差异只能来自微小波动 —— 记忆的价值在这个指标上**结构性地测不出来**。

> 这意味着：要继续做 M3，需要的是**更难的任务**（更多线、更复杂地形、
> 或衡量"多久建成 / 途中犯多少错"），而不是更多的局数。
> 用同一个饱和任务跑 100 局，得到的仍然是"无差异"。

### 元数据

- 库：`/tmp/m3/evolution/`（metrics 6 条 + lessons 8 条）
- 全部 6 局 `status: completed`（无一 interrupted，因此都可进入对照）
- 对照臂的 3 局**仍然产生 lessons**（反思与注入是两个独立开关），
  这正是处理臂能拿到 5 → 8 条的原因

## 10.32 第一性原理：M3 测不出差异，是因为 **agent 没有决策可做**

用户质疑："按道理不至于有无 lessons 只有这么小的差距。是不是地图太小？"

方向对，但**根因不是地图大小**。逐层拆到第一性原理：

### 第一层：M3 的任务实际是什么？

```
agent:    "build_bus_route"（不带任何参数）
GS:       PickTownPair() 自己选城镇        ← 决策在这里，不在 agent
executor: 建 2 站 + 路 + 车库 + 3 台车
结果:     money ≈ 266,000，2 站，3–5 车 —— 6/6 局几乎一致
```

**agent 的整个"决策"就是按一次按钮。** 一个没有决策的任务，
经验教训没有作用点 —— 这是饱和的**结构性**原因。

### 第二层：agent 连"选择所需的信息"都没有

| 事实 | 位置 |
|---|---|
| `observe()` 只返回 `date` + `companies` | `src/agent/tools/index.ts` |
| 决策上下文里**没有任何城镇数据** | `src/agent/decision-context.ts`（grep `towns` = 0 命中） |
| 工具描述写着 **"Omit from_town/to_town to let the planner pick the best pair"** | `buildBusRouteTool` |

最后一条是决定性的：**框架在明说"你不用决定，我替你选最优的"。**
即使模型想选城镇，它**看不到**候选城镇的人口、距离、位置。

### 第三层：地图变大能解决吗？—— **实测：不能**

`OPENTTD_MAP_SIZE=large`（1024×1024，是 small 的 16 倍面积）实测：

| | small (256²) | large (1024²) |
|---|---|---|
| 城镇挑中 | tile 62,136 附近 | **同样的 tile 62,136 附近** |
| 站数 | 2 | 2 |
| 车 | 3–5 | 10 |
| money | 256,927–266,791 | 232,772 |
| constructionDone | **true** | **false**（280 秒没建完） |

地图大了，`PickTownPair()` 仍然挑"列表最前面的两个城镇"。
**变大的只有 harness 自己的施工难度，agent 的选择空间仍然是空集。**

> 换句话说：地图大小改变的是**环境**，不是 **agent 的自由度**。
> 用一个 agent 无法影响的任务做 A/B，得到的永远是噪声。

### 第四层：什么才会让 lessons 起作用？

需要同时满足三个条件：

1. **有真实的选项**，且选项的**结果确实不同**
2. agent **看得见**这些选项（人口 / 距离 / 地形 / 成本）
3. 环境对选择给出**可归因的反馈**

具体到本项目：**让 agent 自己挑城镇对，并把候选城镇摆给它看。**
从"按一次按钮"变成"在 N 个城镇对里选一个，并承担后果"。

### 结论

- **地图大小是次要因素**，值得作为难度旋钮保留，但**不是**饱和的原因
- 真正要做的是**把决策权交还 agent**：暴露城镇信息 + 让它选
- 在此之前，**任何 M3 实验都不会有信号**，加多少局都一样

## 10.33 把决策权交还 agent：城镇对由它自己选（2026-09-12 实施）

对应 §10.32 的诊断。三处改动：

| # | 改动 | 位置 |
|---|---|---|
| 1 | GS 周期状态消息里带上**候选城镇**（id / 人口 / x / y，按人口降序，最多 10 个） | `bridge-gs/main.nut` |
| 2 | agent 摄入这些城镇，`observe()` 把它交给模型 | `world-state.ts`（`setTowns`）、`runner.ts`、`tools/index.ts` |
| 3 | `build_bus_route` 描述不再写 *"let the planner pick the best pair"*（那是在叫模型别做选择） | `tools/index.ts` |

### 关键实现细节：必须放进 **summary**

`toResult()` 只把 `summary` 作为模型可见文本发出去；放在 `details` 里的东西
**模型看不到**。所以城镇写进了 `summary`：

```
date=1950-01-01 companies=[...] towns=[{"id":9,"pop":2279,"x":97,"y":162}, ...]
```

### 实测：agent 开始真的选了

改动前的 6 局：`sent build_bus_route (company=0)` —— **从不传城镇**，GS 用 `PickTownPair()` 自己挑。

改动后：

```
sent build_bus_route (company=0, from=9, to=1)
GS:  "townA":9,"townB":1
```

**agent 主动选了人口最高的 town 9（2279）与 town 1（1391）。**

### 两个踩到的坑（都已修）

1. **Squirrel 没有 `<=>` 运算符**。用 `towns.sort(@(a,b) b.pop <=> a.pop)` 导致
   **整个 GS 加载失败**（`BridgeV1 GS never heartbeated`）。改用 GSList 惯用法：
   `tlist.Valuate(GSTown.GetPopulation); tlist.Sort(GSList.SORT_BY_VALUE, false);`
2. 测试里用 `JSON.stringify(content)` 再去匹配 `/"id":9/` 永远不匹配 ——
   stringify 会把内层引号转义成 `\"`。断言必须读**模型实际读到的文本**
   （`content[0].text`）。

## 10.34 M3 第二次 A/B：把决策权交还 agent 之后，结果反而更差（2026-09-12）

工具：真实 LLM（`minimax-cn / MiniMax-M3`），seed 7，`--demo-seconds 200`，
新 ledger `/tmp/m3b`。设计：先 3 局对照（`--no-memory`，反思仍入库），
再 3 局处理（默认注入）——即"先盲打 3 局，再带着自己前 3 局的经验打 3 局"。

| # | 臂 | 注入 | money | 车 | 站 | 建成 |
|---|---|---|---|---|---|---|
| 1 | ctl | 0 | 284359 | 0 | 2 | ❌ |
| 2 | ctl | 0 | 267068 | 3 | 2 | ✅ |
| 3 | ctl | 0 | 286094 | 0 | 2 | ❌ |
| 4 | trt | 7 | 286094 | 0 | 2 | ❌ |
| 5 | trt | 8 | 284359 | 0 | 2 | ❌ |
| 6 | trt | 8 | 286094 | 0 | 2 | ❌ |

### ① 结论：**这一轮同样无效，但失效模式换了**

第一次（§10.31）6/6 建成；这次 **5/6 没建成**。`lessonsInjected` 证明接线正确
（0/0/0/7/8/8），但**建成率反而下降**。

### ② 根因：agent 选的城镇**离得远**，200 秒修不完

- 6 局里有 5 局选了同一对：**`from=9, to=1`**（人口最高的两个）。
  决策空间确实打开了，但 agent **收敛到同一个答案** —— "挑最大的两个"。
- 修路卡在 `rd s1 r0 d104 p0`：**还剩 104 格**，探针失败 0 次。
  旧 A/B 里 GS 用 `PickTownPair()` 挑的是**相邻的**镇，路短、200 秒建得完。
- 即：**GS 原来帮 agent 做了一个"可行性"上的优化**。把它拿掉之后，
  agent 只会按人口排序取前两名，而**它无从知道这条路要修多久**——
  `observe()` 只给了 x/y 坐标，没有距离/成本/工期估计。

### ③ 新的失效模式：**agent 的动作超出执行器能力**

对照 1 与 2 局分别发了 **2 次**和 **5 次** `build_bus_route`，且目标城镇不同
（`9,1` → `17,12` / `9,12` → `9,17` → `9,1` → `9,17` → `9,11`）。
执行器是**一次性状态机**（建完即 `done` 永久 idle），所以第二条指令无处落地，
只会让 agent 在"我下过令了"的错觉里反复改主意。

**放宽决策空间而没有放宽执行能力，制造了一个新的失败模式。**

### ④ 最重要的发现：`compareArms` 会给出**符号相反**的结论

工具原本报 `conclusive: true`、`money delta: +6342`（处理臂"更好"）。
**这是假的**：

- 6 局里**唯一建成的那局钱最少**（267068，因为建线+买车要花钱）
- 没建成的局钱最多（286094，因为什么都没买）
- 所以"处理臂多 6342"的真实含义是 **"处理臂建得更少"**
- 建成率：处理臂 **0%**，对照臂 **33%** —— 处理臂**更差**

**`money` 在建成率不同的两臂之间不可比。** 这是 MEMORY A2
（不要比较不可比的东西）的下一层：原有的排除只挡"没跑完的局"，
挡不住"两臂停在不同阶段"。

**已修**：`compareArms` 增加 `confounded` 判定——两臂建成率差 ≥ 1/3 时
拒绝下结论，并且 note 必须以
*"…but they are NOT comparable… the money delta above is not a benefit"* 开头，
**不允许只看到那个正数**。3 条新单测；在真实 ledger 上实测已触发。

### ⑤ 下一步（写进 ROADMAP NEXT-2）

放宽选择空间必须**同时**给 agent 判断选项的工具，否则"按人口取前二"是唯一策略：

1. `observe()` 补**距离/估价**（城镇对之间的曼哈顿距离、粗略造价、预计工期）
2. 局长必须够（或让 agent 能判断"这条线在剩余时间里修不完"）
3. 执行器要支持**多条线路**（一次性状态机是硬阻塞，见 NEXT-4）

## 10.35 心跳被当成「变化」—— 决策循环一直在被自己的存活信号唤醒（2026-09-12）

**这是 §10.34 那轮实验失败的真正原因，也是我自己在 §10.27 引入的回归。**

### 机制

执行器把状态汇报写在**公司名**里（§10 的 31 字符通道）。runner 用
`p.name !== executorPhase` 判断"阶段变了没有"——**全字符串比较**。

而我在 §10.27 为了让心跳**能被观测到**，给它加了自增计数器：

```
EX hb boot #1 s0
EX hb boot #2 s0      ← 字符串不同 → 判定为"阶段变化" → 请求一次决策
EX hb road #28 s3     ← 同上 → 又一次决策
EX hb road #29 s3
```

**每一拍心跳都是一个"新字符串"，于是每一次心跳都唤醒了一次 LLM 决策。**

### 实测证据（`/tmp/m3b`，212 次决策）

| 指标 | 值 |
|---|---|
| 由 `phase_change` 触发的决策 | **197 / 212（93%）** |
| 每局决策数 | 33–37（约 36） |
| 相邻决策间 `money` **没有变化**的比例 | **83%**（30/36，除了唯一成功的那局） |
| `stations` 变化次数 | 每局 1–2 次 |
| 工具调用中 `observe` 占比 | **87%**（145/166） |
| **完全相同的 plan 被重复写入** | **218 次** |
| 单局重复下发 `build_bus_route` | 最多 5 次 |

**因果链**：心跳触发决策 → 世界其实没变 → agent 无事可做 → 只能 `observe` →
看不到自己的指令有没有生效 → 重复下发指令 → 世界更乱 → 更多心跳 → 更多决策。

### 修复

新增纯函数 `phaseIdentity(phase)`（`src/game/executor-status.ts`），
**剔除心跳序号**，保留真正是状态的部分：

- `EX hb road #28 s3` 与 `EX hb road #29 s3` → **同一 identity**
- `EX hb boot #9` 与 `EX hb road #9` → **不同**（阶段真的变了）
- `EX hb road #9 s3` 与 `EX hb road #9 s4` → **不同**（多了一个标牌，是有意义的变化）
- 非心跳阶段（`EX rd s1 r0 d104 p0`）原样比较

runner 改为比较 identity。实测：6 拍心跳原来触发 6 次决策，现在只触发 2 次
（`boot → road` 是真实变化，其余是心跳）。

### 教训

**存活信号按定义就是「什么都没发生」**。把它接到"有变化就唤醒"的通道上，
是用"没有新闻"去触发一次新闻发布。§10.27 我修好了心跳的**可观测性**，
却同时把它变成了一个**触发器**——**修一个观测缺口时，必须问它会不会改变控制流**。

### 10.35.1 修复的实测结果与**尚未解决的问题**（2026-09-12）

**已生效**（`/tmp/hbfix3`，同 seed / 同时长）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 每局决策数 | ~36 | 28 |
| 心跳自身触发 | 26 | 8 |
| 该局是否建成 | 5/6 局**失败** | **建成**（3 车 / 2 站 / money 267138） |

用真实 phase 序列回放：**119 个字符串 → 7 次触发**（原为 119 次）。
修复内容两条：
1. `phaseIdentity` 剔除**计数器**（心跳序号 `#n`、重试计数 `r k`），保留状态
2. **心跳不再开启决策窗口**（`isHeartbeatPhase`）——它按定义就是"没有新闻"

**尚未解决（下一步的第一件事）**：
决策间隔实测稳定在 **5.2–5.7 秒**，说明调度器节流窗口成了限制因素——
即**仍有某个东西在持续请求触发**（`phase_change` 仍有 24 次）。
嫌疑：phase 串里的 `j<money>` 字段会随花钱而变，导致 identity 持续"变化"。
**在把决策数降到个位数之前，A/B 仍然是在测量节流参数，不是在测量 agent。**

### 方法论教训（本次两个，都很贵）

1. **第一版 `phaseIdentity` 的正则锚定在字符串末尾**，而真实格式带尾部 `j<money>`
   （`EX hb road #28 s3 j1`）。正则**匹配不到任何真实输入**，修复静默失效
   ——复测发现心跳仍触发 28 次。
   **测试也是错的**：我用的是自己臆想的格式。**断言必须建立在真实样本上。**
2. **心跳与进度是两条交替的流**：
   ```
   EX rd s0 r2 d144 p0 j100   ← 进度
   EX hb road s3 j100         ← 心跳
   EX rd s0 r3 d144 p0 j100   ← 回到进度，又被判定为"变了"
   ```
   只归一化心跳**不够**，因为两者交替，每次交替都是一次"变化"。
   **控制流要单独处理心跳（它不该触发），不能只靠字符串归一化。**

## 10.36 新闻门：phase 按**阶段**门控，而不是按字符串（2026-09-12）

三轮实测（§10.34/§10.35/§10.35.1）证明：对 phase 字符串做**任何**等值比较，
都会被"永远在变的字段"击穿 —— 心跳序号、重试计数、花钱（`j<money>`）都会改变字符串。
而且心跳与进度是**交替的两条流**，归一化一方的计数器没用，每次交替仍是一次"变化"。

**最终设计**：`phaseStage(phase)` 把 phase 折叠成**阶段词元**（`rd` 归并入 `road`，
心跳取其阶段字段），runner 只在 `stage` 变化或 `isErrorPhase`（stuck/giveup/exc 等）
时才请求决策。

**用真实历史日志回放验证**（修复前每条 phase 打印 = 一次决策请求）：

| 日志 | phase 数 | 新闻数 |
|---|---|---|
| m3b-ctl1 | 117 | **6** |
| m3b-trt1 | 119 | **6** |
| m3b-ctl2 | 87 | 48* |

*ctl2 是那个发了 5 次 build 的 thrashing 局 —— 阶段频繁切换，**这些触发是真实的**。
这说明新闻门不是"少触发"，而是**只在值得问的时候问**：agent 自己的反复改主意
仍然会逐条被看见（这正是我们想要的可观测性）。

**新增仪器** `scripts/loop-health.ts`：从 audit 反推决策数/局、触发分布、
**空转率**（money/stations/vehicles 全未变的决策间隔占比）、observe 占比、plan 重复率。
对 §10.34 的旧账本读出：**35.3 决策/局、空转率 72%、observe 87%** —— 即修复前的基线。
之后任何循环改动先跑它，再谈 A/B。

## 10.37 新闻门之后的第一次校准跑（2026-09-12，/tmp/cal1）

**循环侧：HEALTHY**。同 seed 同时长，对比 §10.34 基线：

| 指标 | 修复前（§10.34） | 校准跑 |
|---|---|---|
| 决策数/局 | 35.3 | **2** |
| phase_change 触发 | 1182/6 局 | **0** |
| 空转率 | 72% | **0%** |
| observe 占比 | 87% | 0% |
| loop-health 判定 | STILL BURNING | **HEALTHY** |

模型把仅有的窗口用于 `estimate_route`（9 次，0 次 observe——工具按预期被使用），
且**认知上生效**：主动避开了 9→1（146 直线格、£44,822），比较了多对组合。

**但暴露新缺口**：模型第一次决策全部用于探索，然后 `wait_until` 让自己睡到
1950-04-01 —— **200 秒的局在它醒来前就结束了**。plan（"先建一条便宜的线"）
从未执行，执行器全程停在 boot，build_bus_route 一次都没发。

**修复**：决策上下文新增 `session.secondsRemaining`（墙钟剩余）。这是**局边界
事实**（人知道这场要打多久），不是策略——模型用它自己规划决策预算。

**教训**：稀疏循环里每次决策都更重。决策变稀后，"agent 有没有足够的事实
做出正确分配"变成了硬约束——时间预算就是其中之一。

## 10.38 校准跑 #2：session horizon 生效，信号链闭合；剩余阻塞点收敛到执行器（2026-09-12，/tmp/cal2）

**① session horizon 生效**：3 次决策全部用于行动（对比 cal1 的 2 次全用于探索+睡眠）。
**模型执行了自己的 plan**：先建 9→12（**26 直线格、£7,982** —— 估价工具标出的最便宜
高人口对！），后建 9→1（扩张）。build_bus_route 4 次调用（cal1 为 0）。

**② 全信号链验证**：

| 信号 | 证据 |
|---|---|
| estimate_route | 先选 26 格对再选 146 格对 —— 与"先 bootstrap 后扩张"一致 |
| session horizon | 不再睡过终点；3 决策=1 探索+2 行动 |
| add_vehicles 诚实拒绝 | 0 车时 ok=false（不再谎报成功，§10.20）|
| 新闻门 | 0 phase_change 噪声触发；HEALTHY |

**③ 剩余阻塞点收敛为一：执行器是一次性状态机。**
站点建成 2 个（第一条线的），但 `rd s0 r0 d144` 显示修路朝 146 格的 9→1 走 ——
**第二条 build 指令把执行器重新瞄准，第一条线的进度被丢弃**。
模型"先建便宜的、再扩张"的 plan 完全合理，**是手接不住第二个计划**。

**结论**：信号侧（眼）的修复已闭环；现在卡住 agent 的只剩**手** ——
即 NEXT-4（GS-only 常驻执行器 + 多线路）。在此之前的 A/B 仍然测量不到
模型差异，因为两条臂共享同一个只会执行"最后一个计划"的执行器。

## 10.39 NEXT-4 最小切片：执行器队列化（顺序多线路）（2026-09-12）

**问题（§10.38 实测）**：模型发了 4 条 build 指令（"先便宜后扩张"），执行器只跑了一条
（还跳过了 job 1 直接拿了 job 2 的标牌）然后永久 idle。

**修复**（`executor-ai/main.nut`）：
1. `FindNextJob()`：扫描全部 `NUTZ:bp:*` 标牌，取 **job id 严格大于当前 job** 的最新蓝图
   （GS route_seq 单调递增 → "更新"即"未做过"）
2. `done` 且已上报完成后：重置**全部** per-route 字段（slotA/B/D、pf、vehicle、
   roadCur/Seg、builtRoad…逐一对齐构造函数初值）并进入下一 job 的 buildA
3. **未做**并行多线路 —— 仍是顺序执行；但这已匹配模型"bootstrap → expand"的真实行为

**验证**：
- cal3：队列生效 —— `work j100 → work j101`，**6 站 / 9 车**（历次最佳，3 条线规模），
  GS 加载正常（无 Squirrel 语法雷区）
- cal3 同时暴露修复 bug：`j101` 完成后**回头重跑了已完成的 j100**（只排除了当前 job）
  → 已修为 `job <= this._job` 跳过
- cal4：模型采样失误（0 次 build，重现 §10.37 的探索-睡觉模式），未触发队列路径 ——
  **一行修复的真机验证仍欠着，下轮校准 #4 补**

**注**：cal2 中 job1 被跳过的根因仍未查明（GS err 不入日志）——可能在 GS 侧
选址失败但工具返回 ok=true（§10.20 同族问题："发送成功"≠"GS 成功"）。

### 10.39.1 修正：FIFO + done 集合 + 契约 + err 通道（2026-09-12）

用户质询"替 agent 做的架构决定"后修正三项：

1. **newest-wins → FIFO**：原实现取最新 pending 计划、静默丢弃更早的——
   等于把 `build_bus_route(A)` 的语义偷改成"建 A，除非有更新的"。
   cal2 实测模型想要**全部四条**（bootstrap→expand），该策略会摧毁合法计划。
   现为：**按提交顺序逐条建完**，每条都被执行。
2. **done 集合替代单调 id 假设**：§10.39 假设"job id 单调递增"是**错的**——
   `job` 是模型可显式传的参数（cal2 实发 `job:2`）。改为 `_doneJobs` 数组 +
   `IsDoneJob()`，boot 接单与 FindNextJob 均跳过已完成 job。
3. **契约补全**：`build_bus_route` description 现在写明
   *"Commands are QUEUED: routes are built in submission order, each to completion
   before the next starts"*——调度语义属于 agent 可见的契约，不是藏在注释里的策略。
   另：GS err 现在写入 audit 日志（"发送成功 ≠ GS 接受"的观测闭环）。

**验证状态**：gate 800 绿；**FIFO 的真机验证仍欠**——cal5 模型 0 次 build
（"探索后睡觉"模式第 3 次出现：cal1/cal4/cal5），队列路径未被触发。
**另**：同 seed 连续局的模型行为差异很大（2/5 局真正下单）——LLM 采样
非确定性本身成为校准跑的噪声源，A/B 的样本量设计必须把这一点算进去。

## 10.40 FIFO 队列真机验证通过（2026-09-12，cal6/cal7）

两局各发 2 条计划，**两条都被按序执行、无一丢弃、无一重跑**：

| 局 | 提交的计划 | 结果 |
|---|---|---|
| cal6 | 9→12、5→11 | 4 站 / 3 车（两条线的站都建成）|
| cal7 | 9→12、9→17 | **constructionDone=true，4 站 / 6 车** —— 首次双线路完整闭环 |

**对照修复前**（§10.38）：4 条计划只执行 1 条（还跳过了第一条）。
现在 `build_bus_route` 的语义与契约一致："提交即建，按序"。

**下单率**：这两局 2/2 下单（此前 5 局 2 局）——"探索后睡觉"未复现，
样本仍小，A/B 设计时继续把它当噪声源对待。

## 10.41 决策→结果账本接入反思（2026-09-12，cal8）

RL 反馈闭环的最后一段接通：`RouteLedger`（`src/agent/route-ledger.ts`）记录
"哪个决策订购了哪条线"（GS ack：job/townA/townB + 决策号），执行器 done 阶段
（`j<job>`）回填完成事实，局终把账本行并入反思 evidence。

**cal8 实测**：模型订了 4 条线（含重复的 9→17 ×2），6 站 / 6 车。
反思第一次写出了**关于选择**的 lesson：

- *"Construction was not completed by game end despite 4 routes being ordered"*
- *"Ordering duplicate routes between the same towns (9->17 at decisions 2 and 3)
  wastes decisions"* ← 没有账本就不可能写出这句

对照 §10.34 的空洞 lesson（"零失败调用显示保守执行可行"）——**喂什么决定写什么**。

边界自查：账本只记事实（谁订的、建完没有、哪天）；lesson 是反思层对**自己
过去的观察**（过去式陈述），符合 RL-HARNESS-SCOPE-AUDIT 的注入规则。

## 10.42 M3 A/B 第三次重跑：手眼账俱全后的首次有效对照（2026-09-12，/tmp/m3c）

与 §10.31/§10.34 的**根本区别**：本轮跑在已验证的循环上
（HEALTHY 空转率、FIFO 队列、估价、horizon、账本）——测量结果**首次可以当真**。

| # | 臂 | 注入 | money | 车 | 站 | 建成 | 下单 |
|---|---|---|---|---|---|---|---|
| 1 | ctl | 0 | 99425 | 0 | 0 | ❌ | **0 次** |
| 2 | ctl | 0 | 229968 | 6 | 6 | ✅ | 3 |
| 3 | ctl | 0 | 298250 | 0 | 2 | ❌ | 2 |
| 4 | trt | 4 | 237554 | 6 | 4 | ✅ | 2 |
| 5 | trt | 4 | 99425 | 0 | 0 | ❌ | **0 次** |
| 6 | trt | 6 | 239476 | 6 | 6 | ❌ | 4 |

### 结果

- **建成率 1/3 vs 1/3**（confounded 检查通过，两臂可比）
- **money delta = −17,063**（有记忆臂**低** 6%）
- ~~**tokens：with 81,902 vs without 41,329 —— 有记忆臂 token 翻倍**~~
  **（§10.43 更正：这是归因错误）**——per-run 数据：token 与动作数近似线性
  （~8k/决策，两臂同规律：ctl 9k/93k/22k，trt 139k/7.6k/99k）。
  均值差完全由处理臂碰巧行动更多解释（18 vs 10 决策）。记忆注入本身
  ~200 token/局，成本可忽略。

### ① 诚实结论：**无证据表明记忆有益；有信号表明本轮记忆可能是负担**

但 n=3 且**方差由"下单率"主导**：两臂各有一局 0 下单（模型直接躺平），
那一局 money≈99,425（什么都不建当然钱最多）。6 局里 2 局无效，
**有效样本实际是 2+2**，且资金差异主要由"建了多少"驱动——
建成率相同时，多建多花 → 钱少。**money 仍然不是这个任务的好指标**。

### ② 真正的发现：**下单率是主要方差源**

5 局有效中"下单 0 次"出现 2 次（§10.37/§10.39 的"探索后睡觉"模式）。
模型在**没有记忆时也会躺平**，与 lessons 无关——这是采样/提示层问题。

### ③ token 翻倍值得注意

注入 4–6 条 lesson 后每局 token 从 ~41k 涨到 ~82k。
若记忆要成为净收益，它必须**省下比它成本更多的决策**——当前任务
（单城对公交线）给不了这个空间，指向 NEXT-2 的"扩决策空间"。

### 结论

**M3 的度量框架首次可信**；本轮结论是"记忆在此任务上无收益、成本翻倍"。
下一步不是加样本，而是：a) 解决下单率方差（提示层事实：不做也行，
但至少要让"局结束前应有建成"的账本事实进上下文）；b) 用账本把
"哪条线赚了多少"接进反思，让 lessons 有质量；c) 扩决策空间。

## 10.43 为什么记忆无收益：全链路审计（2026-09-12，应项目所有者质询）

### ① 先更正自己：§10.42 的"token 翻倍"是归因错误

per-run 数据（上表）：token ≈ 8k × 决策数，**两臂同规律**。均值差由行动数差异解释。
记忆注入本身 ~200 token/局。**记忆不是 token 负担** —— 最初的三条结论之一作废，
且这暴露：confound 守卫建在了 money 上，没建在 token 上。

### ② 注入链路审计：接线正确，无 Pi-core 配置问题

- `loadMemory` 每局加载**一次**（集合稳定——对照实验的正确做法），计数如实入库
- `pruningTransformContext` 把 lessons 作为 user 消息注入**每次 LLM 调用**顶部：
  *"Recorded outcomes from your own previous games: …"*（过去式陈述，符合 RL 边界）
- 跨轮记忆存在且健康：`keepRecent 40` + 最后一条 game_observation 永久保留
- strategies 0 张（人工确认闸门，符合设计）

### ③ 真正的原因（三层）

**第一层：lesson 的内容没有含金量。** trt1 实际收到的 6 条里：
- 2 条是结果复述（"小车队 6 车 6 站足以达到 229,968"）——模型一轮 observe 就能重推
- 3 条来自**失败局**（"201 秒什么都没建说明你太慢"）——把躺平局的教训当经验注入
- **没有一条包含只有记忆才能提供的载荷**：同一 seed 同一张地图，记忆的独家价值
  就是"9→12 只要 26 格、£7,982、上次建完是赚的"——这类**结构化地图事实**。
  反思 prompt 要求"one short reusable sentence"，恰好把账本里已有的精确数据
  压成了过程性散文。

**第二层：任务太浅，记忆的价值上限本来就低。** 记忆的价值 ≈ 节省的探索 × 决策频率。
本任务：探索 = 1 次 estimate（~1k token），最优策略近乎恒定。
**记忆收益的理论上限 ≈ 每局 1-2k token（~2%）**——任务不可能展示记忆价值。
这不是 harness 无效，是**任务没有给记忆出题**。

**第三层：失败局的 lesson 可能主动有害。** "你太慢了"注入后，trt1 行动 9 次
（对照臂均值 3.3 次）——活动更多、花得更多、建成率没变。方向性猜测（n 小），
但机制成立：**把躺平局的教训当经验，教出来的是躁进**。

### ④ 修法（按杠杆排序）

1. **结构化记忆**：路线事实（pair→格数/造价/结局）**不需要 LLM 总结**——
   账本里就有确定性数据，直接进库；LLM 反思只负责判断类 lesson
   （什么策略有效）。payload 不再被散文格式摧毁。
2. **失败局的教训要降权**：0 下单的局没有可学习的策略，它的"教训"是噪声源。
3. **给记忆出题**：NEXT-2 扩决策空间（多线路收益递增、重复博弈）——
   记忆在"上次这对镇赚了多少"有真实决策价值时才有用武之地。
4. token 与 money 一样需要 confound 守卫（按决策数归一）。

## 10.45 Phase A2：GS 侧类型化事件中继（2026-09-12，calA2）

**目标**：harness 面向的所有执行器状态通过结构化 JSON 事件；
公司名通道在 harness 侧退役（GS 侧继续做 executor→harness 的转发器）。

**实现**（`src/game/squirrel/bridge-gs/main.nut`）：
- `ParseExecPhase(name)`：剥 `EX ` 前缀与 `j<id>` 尾，映射 11 个 stage 枚举，
  设置 `hb=true` 当且仅当前缀为 `hb `；输入 `(null : 0x...)` 守门（无效公司）。
- `ExecEventKey(ev)`：stage+job+hb 的指纹，**变化才发**——心跳概念退役为
  "无事件 = 无变化"。
- `Start()` 内 200 tick 周期内新增 try/catch 块读取 executor 公司名 + 发送
  `{kind, stage, job, hb, raw}` 事件。
- 失败被吞掉、转为 `err/exec_emit` 事件，不破坏 GS 主循环。

**对原计划的诚实偏离**：GS 侧**不做 detail 解析**。实测发现
OpenTTD 15 的 GS Squirrel 在嵌套表赋值上有可靠性怪癖（`detail["beat"] = N`
会抛出 "the index 'beat' does not exist"，即使 `detail = {}` 刚声明
过）。若干轮 try/catch + 局部变量中转只能减少失败，不能根除。**决定**：
detail 字段由 harness 侧 `executor-status.ts` 继续用 TS 正则重建（**raw
永远在事件里**），契约层 GS 只负责 stage/job/hb + raw。这是能力受限
下的工程妥协——结构化通道仍然建起来了，心跳风暴的根因被消除；
detail 的契约迁移推迟到 A3 harness 消费侧统一处理时一并完成。

**真机验证**：calA2 200s，`0 emit 错误`、`0 hb 解析错误`、`1 exec 事件`
（boot 心跳，因为模型没下单、executor 未动，所以期间无 phase 变化）——
**这正是 on-change 设计的预期行为**：无变化 = 无事件。无心跳风暴。

**契约字段（GS 实际发出）**：
```
{ kind: "exec", stage: <ExecStage>, job: <int>, hb: <bool>, raw: <string> }
```
与 `src/game/gs-events.ts` ExecEventSchema 兼容；`detail` 字段在 GS 侧
为空，由 harness 消费时由 `phaseToEvent` 走 fallback 计算。

**剩余**：A3 harness 侧接线（消费 `kind=exec` 而非公司名 info）。
runner.ts 的 `phaseStage/isErrorPhase/jobFromPhase` 退役计划照旧。

## 10.46 Phase A3：harness 消费类型化事件，公司名正则退役（2026-09-12，calA3）

runner.ts 的相位源切换为 GS 的 `kind:"exec"` 事件：

- **消费**：`stage`（新闻门：stage 变化或 error 才醒）、`job`（done → 账本
  markDone）、`raw`（executorPhase 字符串，下游展示不变）、`hb`（防御性：
  事件心跳绝不唤醒模型）
- **退役**：`company_info` 里的 EX 相位逻辑整块删除；
  runner 不再 import `phaseStage/isErrorPhase/jobFromPhase`；
  route-ledger 的 `jobFromPhase` 与 gs-events 的过渡 shim `phaseToEvent`
  随之删除（各自测试同步）
- **契约微调**：`detail` 改为可选——GS 实发无 detail（§10.45 妥协），
  harness 消费只用 stage/job/hb/raw；detail 需要时可由
  `decodeExecutorPhase(raw)` 确定性重建
- **boot 检测**：`executorPhase.startsWith("EX boot")` → `executorStage === "boot"`

**真机验证（calA3，200s）**：64 个 exec 事件、**12 次 phase 迁移全部来自
事件流**（boot→work→stA_ok→road_start→dpt_ok→work j101→…）；
模型连订 j100/j101/j102 三条线，6 车 / 6 站——事件驱动新闻门 + FIFO 队列
在同一局里同时工作。gate 815 绿。

**Phase A 收官**：31 字符公司名在 harness 侧的解析职责归零；
唯一的相位解析在 GS（stage/job/hb，§10.45）与 TS 解码器（detail 重建，
按需）。

## 10.47 Phase B-3：signal-hub 拆分（2026-09-12，calB3）

**TDD 顺序**：先写 `test/unit/signal-hub.test.ts`（8 用例，golden 取自
/tmp/calA3.log 真机事件）→ 实现 `src/agent/signal-hub.ts`（makeSignalHub
工厂 + SignalHub 接口）→ 接到 runner.ts。

**职责迁移**：从 runner.ts 原 onEvent 回调 1:1 搬出，包括：
- world.ingest 路由、web.publishEvent / session.appendEvent / boot 缓冲
- GS gamescript state（towns、gsStates 计数）
- GS gamescript kind=exec（stage gate + 账本 markDone，§10.46 延续）
- GS gamescript kind=ack build_bus_route（lastRoute + ledger.record 携带决策号）
- company_stats notable（车队/站点变化唤醒 onNotableEvent）

**runner.ts 减重**：从 979 行降到 789 行（−190）。所有外部读取改为
`hub.getXxx()` 调用；executeRegion 的状态变集中在 hub 闭包内。

**踩到的两个真实回归（已被修复）**：
1. 我此前用 Python 脚本把 EmitExecPhase 移到每循环，**缩进错位**导致
   Squirrel 解析失败——GS 仍能 load 但 EmitExecPhase 体内 throw 被吞。
   修正缩进后恢复。
2. 我把 "GS alive" 检查从 `gsStates === 0` 改为 `hub.getStage() === ""`，
   但 `getStage()` 只在 exec 事件到达时变化，而 exec 事件需要 executor
   AI 公司已创建——**自相矛盾**（我们在等 start_ai 之后才有 exec
   事件，但我们用 exec 事件的存在来决定是否 start_ai）。
   修复：hub 暴露 `getGsCount()`（state 事件计数）；runner 用 state
   事件判 GS alive（state 事件先于 executor 启动就到来），用 exec 事件
   判 executor boot。

**acceptance（行为不变）**：gate 823 全绿（含 8 个新增 hub 单测）；
calB3 真机：23 个 exec 事件、8 次 phase 迁移全部走 hub、RESULT 正常。
零行为变化：阶段决策门 + FIFO 队列 + horizon + town 选举全部继续工作。

## 10.48 Phase B-4a：决策循环纯逻辑拆分（2026-09-12，calB4）

TDD: 12 loop-control 单测（deadline/cap/waitUntil/waitCondition/phaseWorth/
emptyTracker）→ 实现 src/agent/loop-control.ts → runner.ts 改用纯函数调用。

行为零变化证据：
- gate 835 全绿（含 12 新增 loop-control 单测）
- runner-freeze-thaw 一个断言需更新（`Date.now() >= deadline` →
  `shouldBreakOnDeadline`）——这正是"行为不变"的可见边界
- calB4 真机：4 次决策、8 次 phase 迁移、`run length reached (60s)`
  退出正常——deadline 仍生效

当前成果：runner.ts 979 → 785 行（−194，含 B-1/B-2/B-3）；helpers +
reflect-run + signal-hub + loop-control 四模块各自独立。

B-4b 留待下轮：决策循环 while 体的完整提取（含 runDecision 调用、
audit/telemetry 写入、buildStageSummary 等）——需要更细的 TDD 形态
（mock-based 循环体单测噪声大，行为不变目前最好证明仍是真机跑 +
全量 gate）。

## 10.49 Phase B-4b：决策循环体提取（2026-09-12，calB5）

runner.ts 的 while 循环体（约 190 行）1:1 迁入 `src/agent/decision-loop.ts`：
`createDecisionLoop(ctx)` 返回 `{run, handlePhase, handleNotable, handlePlanWait}`。

- 循环私有状态（tracker/waitUntil/waitCondition/pendingActions）随迁；
  pendingActions 由 runner 创建、循环填充、reflect-run 消费（共享引用，语义不变）
- runner.ts 保留装配 + 生命周期（进程/凭据/脑/telemetry/web/obs 轮询）；
  `onPhaseChange = (p) => loop.handlePhase(p)` 赋值位置不变——boot 期间的
  phase 事件依旧被丢弃（原 TDZ 安全语义保持）

**TDD**：`test/unit/decision-loop.test.ts` 7 用例（fake scheduler/runDecision/
session/audit/telemetry/web 注入）——start 触发全链路顺序、wait_condition
命中与清除、notable→request(event)、wait_until 过期唤醒、零决策退出。

**结构性不变量测试同步**：runner-freeze-thaw 的 5 条断言改为扫描
runner.ts + decision-loop.ts 两文件（不变量属于"循环"而非"文件"），
断言内容不变。

**runner.ts 清理后**：785 → 650 行；模块全景：
runner(650, 装配+生命周期) / decision-loop(200) / signal-hub(172) /
reflect-run(123) / runner-helpers(94) / loop-control(72)。

**验证**：gate 842 全绿（+7 loop 单测）；calB5 真机 deadline 正常触发、
RESULT 正常（模型该局未下单——已知采样方差，与重构无关）。

**Phase B 收官**：runner.ts 从 979 → 650 行；四个模块职责单一
（信号 / 决策 / 结算 / 纯判据），全部带单元契约测试。

## 10.50 Phase C：结构化记忆 + 实验脚手架（2026-09-15，calC1–C3）

### C-1 结构化路线记忆（§10.43 修法 1 落地）

`src/evolution/route-facts.ts`：账本 → JSONL（`<dataDir>/evolution/route-facts.jsonl`）
确定性转换，**不经 LLM**。reflect-run 在 finalize 时落盘（仅当有下单）；
runner 的 lessonsProvider 组合 `makeRouteFactsProvider`（启动时快照，
与 memory 同款稳定集语义——M3 实验独立变量）。注入行为为纯事实句
（"route towns 9->12 was ordered at decision 2 and was built (done …)"），
单测断言不含策略词。

**跨局幂等**：同 (pair, outcome, doneDate) 去重；同 pair 不同结局共存。

### C-2 躺平局降权（§10.43 修法 2 落地）

反思与落盘都要求 `decisions > 0 && routeLedger 非空`：零下单局**不产出
lesson、不写事实文件**。真机验证：calC2（躺平）→ 无 route-facts 写入。

### C-3 实验脚手架 + token 归一守卫（§10.43 归因教训落地）

- `metrics.ts` ArmStats 新增 `tokensPerDecision`（按决策归一，decisions=0 局
  排除除零 → null）；meanTokens 差 >25% 而 per-decision 差 ≤15% 时，note
  自动声明"gap 是行动量差异，不是记忆成本"。
- `scripts/run-experiment.ts`：一条命令跑完 3+3 矩阵（ctl=--no-memory /
  trt）+ compareArms 判定打印。

### C-4 标定（3 局，/tmp/calC）

| 局 | 下单 | 结果 |
|---|---|---|
| calC1 | 3 条（9→12, 9→17, 9→2） | 6 车/6 站，执行器 exc 异常终止 |
| calC2 | **0（躺平）** | 无事实写入 ✓ |
| calC3 | 1 条（9→12，road_start 未完） | 2 站，截至于 road_start |

loop-health：**HEALTHY**（4.3 决策/局、空转 0%、observe 25%、触发分布
多样）。**下单率 2/3**——与 §10.40 的 2/5 相比回升，样本仍小，A/B 设计
继续把它当主噪声源。

**观察**：calC1 出现执行器异常 `exc:can't execute ov`（第 4 条线 9→2 施工期
崩溃）——新失败模式，未定位，留待 NEXT-6。

**诚实边界**：route-facts 注入的真机观测仅到"提供者行为被单测锁定"——
标定 3 局启动时事实库为空（首局之前无历史），非空注入的实机观测
将在下次 A/B 的 treatment 臂出现。

## 10.51 M3 第四次重跑：首次有效分臂（2026-09-15，/tmp/m3e → m3f → m3g）

三次尝试，前两次**被实验缺陷判废**，第三次得到首个可信对照。

### 判废的两轮暴露了三个真实缺陷（已修，见对应 commit）

| 缺陷 | 现象 | 修复 |
|---|---|---|
| **GS done 相位匹配** | `ParseExecPhase` 要求全等 `"done"`，真机是 `EX done stN4 r81 bus j101` → stage=unknown → `reachedDone` 永不置位、账本 markDone 不触发 → **route-facts 全部 completed:false**（即使实际建成）| 前缀匹配（b4a5834）|
| **臂计分不含 route facts** | 注入事实但 lessons=0 的局被算作对照 → 分臂错乱 | `MemoryInjected.routeFactsInjected` 入账 + 臂定义改为"lessons 或 facts"，对照=都没有（b4a5834）|
| **--no-memory 未关 route facts** | 控制臂也被注入 → m3f 分臂 5v1，无真对照 | `routeFactsProviderFor(dir, enabled)` 门控（本 §）|

**教训**：三个缺陷都是"注入/计分链路不完整"，形态与 §10.35（观测改变控制流）、
MEMORY A9 同族——**实验工程量不在跑局，在保证两臂真的不同**。

### m3g 结果（首个有效 3v3）

| 臂 | n | money | tokens | **tok/决策** | 建成率 |
|---|---|---|---|---|---|
| treatment（lessons+facts）| 3 | 228,375 | 124,213 | **18,924** | **3/3** |
| control（无注入）| 3 | 236,730 | 87,402 | **14,999** | 2/3 |

- **分臂正确**（3v3）✓，confounded 守卫按设计拒绝下结论（建成率 100% vs 67%
  → money delta −8,355 **不可读为收益**）
- **tok/决策 +26%**（18,924 vs 14,999）：归一后仍显示注入有 token 成本——
  §10.43 的"无成本"结论需按此更新（但 n=3，不可下结论）
- **建成率 3/3 vs 2/3**：唯一方向性信号（treatment 全建成），样本太小

**结论：仪器现在可信；本次结果不可判定**（不是"无收益"，是"还测不出来"）。
下一步：扩大 n（≥5/臂）或先查执行器 `exc` 异常（calC1）以降低单局方差。

### 未收口

- 执行器 `exc:can't execute ov…`（16 字符截断的 Squirrel 运行时错误，
  calC1 road seg2 期；两臂共享故不偏倚，但会杀伤单局）
- 单局方差主源仍是"模型是否下单 + 是否建成"，n=3 时建成率 1 局的差异
  就能翻转守卫

## 10.52 每局存档（可回看）+ M3 第五/六次重跑（2026-09-15/16）

### 每局结束存档（项目所有者要求：能在 OpenTTD 里载入观看结果）

teardown 在 `mgr.stop()` 之前 `rcon("save <sessionId>")` + 等待 2.5s 落盘；
文件名经 `savegameName()` 净化（`[A-Za-z0-9._-]`，无字母数字则兜底 `game`）。
路径 `<dataDir>/save/<sessionId>.sav`，OpenTTD 15 客户端可直接载入。
**执行时机在 runFinalizeAndReflect 之后**——存档不影响实验数字。

**此前为什么没有存档**：`autosave_on_exit=false`，autosave 目录为空，
从没有人叫服务器存过。

### m3h（n=5/臂，200s）与 m3i（n=5/臂，400s）

| 轮 | 窗口 | treatment | control | 结论 |
|---|---|---|---|---|
| m3h | 200s | 建成 0/5、tok/dec 17,460 | 建成 1/5、tok/dec 12,389 | 不可比 |
| m3i | 400s | 建成 3/5、站点 5.60、tok/dec 18,907 | 建成 5/5、站点 5.20、tok/dec 13,426 | 不可比（60% vs 100%）|

**关键判断（2026-09-16）**：

1. **tok/决策是本任务唯一稳定的记忆效应**：三轮（m3g +26%、m3h +41%、m3i +41%）
   方向一致——注入记忆使每次决策贵 26–41%（归一后仍成立）。
2. **建成率不是记忆的函数**：m3g treatment 更高、m3h 都低、m3i treatment 更低。
   它主要由时间窗口 ÷ 路线长度决定——200s 窗口下 10/10 局终止于施工中途
   （road_start/stA_wait），与记忆无关。
3. **站点数（分级结果）两臂几乎相同**（5.60 vs 5.20）——在完成度这个更连续的
   量上，两臂没有可见差异。

**因此**：本任务上记忆是显著更贵、效果不可辨。与 §10.43 诊断一致——任务太浅
（单线路 + 200–400s 窗口），记忆没有出题空间，成本却每次决策都付。下一步的
科学问题不是重跑 A/B，而是 **NEXT-2 扩决策空间**（多线路/收益递增/重复博弈），
让记忆有赚回成本的地方。

### 并发实验与门禁（新教训，MEMORY D5）

实验占用 3977/3979 端口 → preflight 单测（断言端口空闲）失败。**真机实验运行
期间不得跑 gate**；实验结束后 gate 绿。

## 10.53 NEXT-2 N2-1：线路经济事件（route-stats）——探针全绿（2026-09-16）

### 为什么先做它

三轮 A/B（§10.52）的结论是"记忆显著更贵、效果不可辨"，根因是**任务只有一个真决策**。
要让记忆能兑现，必须先让**选择的结果可测量**。线路经济就是那个"结果"。

### 契约（`src/game/gs-events.ts` 的 `RouteStatsEventSchema`）

GS 每 200 tick 为每条已知线路发一条**扁平**事件（SPEC §10.45 的 GS 怪癖教训：
Squirrel 侧不留嵌套结构与算术）：

```json
{"kind":"route-stats","job":1,"vehicles":6,"profit":-308,"waiting":146,"gameDate":712427}
```

- `profit` = 该线车辆 `GSVehicle.GetProfitThisYear` 之和（**负值合法**：亏钱线路必须能上报）；
- `waiting` = 两端站点乘客等待之和（`GSStation.GetCargoWaiting`）；
- **派生量（每日收益）在 harness 侧**（`src/agent/route-stats.ts`，纯函数可单测）。

### 车辆归属：按站点订单，不靠位置猜

`GSVehicleList_Station(station_id)` + `GSVehicle.GetOwner(v) == 0`。
站点由蓝图标牌瓦片解析；**executor 有 `FindAltSite` 回退**（站点可能偏离标牌数格），
故 GS 侧 `StationNear(tile, 6)` 先精确瓦片、再半径扫描——否则一条正常运行的线路
会被静默报成"没有车辆"。

### 真机探针结果（/tmp/n2d，seed 7，400s，n=1）

| 探针问题 | 答案 |
|---|---|
| `GSVehicle.GetProfitThisYear` 在专用服务器 GS 里可用吗 | ✅ 可用（读到真值，含负值） |
| `GSStation.GetCargoWaiting` 可用吗 | ✅ 可用（waiting 0→146） |
| 车辆能精确归属到线路吗 | ✅ 6 辆车归到 job 1；无异常事件 |

**首个真实行为信号**（job 1，6 辆车）：
`waiting 0 → 146`，`profit -18 → -308`——一条**排队在涨、钱在亏**的线路。
这正是 NEXT-2 需要的那种"有题可做"的状态：加车是否让 waiting 掉下来、利润转正，
是 agent 可以做、且结果可测量的决策。

局末：`constructionDone=true`，4 stations / 3 vehicles（第二条线在建成）。

## 10.54 NEXT-2 N2-2/N2-3：让经济事实可查、可见、可记（2026-09-16）

### N2-2 `inspect_route` 工具

`inspect_route {job?}`：读 GS 上报的线路经济（车辆数 / 等待 / 当年利润）。
三条路径都必须**明确回答**（"永远说'是'的工具毁掉学习"）：

| 情形 | 行为 |
|---|---|
| 有读数的 job | 返回该线事实（`formatRouteStats`，无建议词） |
| 未知 job | `ok:false` + 已知 job 清单（不编造一条不存在的线） |
| 尚无任何读数 | `ok:false` + 说明（蓝图未下单前 GS 不会上报） |
| 该模式无 GS 通道 | `ok:false` + 说明（空成功 = 撒谎） |

**样本量诚实性**：年内不足 30 天时**不给每日速率**——`gameDate % 365 = 0` 时
`3650 / 1 = 3650/day` 是"用 1 天样本编出来的年化"，比不报更糟。原始
year-to-date 仍照实给出。

### N2-2b 经济事实进入**每次**决策上下文

§10.34 的教训同样适用：**需要工具调用才能看到的事实，模型经常不看**
（"按人口取前二"就是这么来的）。故 GS 读数（按 job）与账本 pair 连接
（`joinRoutesWithLedger`）后进入每个决策上下文：

```
routes: [{job:1, townA:10, townB:0, vehicles:6, waiting:146, profit:-308, gameDate:732}]
```

账本不知道 pair 的 job 只给读数，**不编 pair**。运行日志同步打印
`[agent] route facts: …`，使"模型是否真的被展示过这些事实"可验证。

### N2-3 记忆 v2：事实带**结果**

`RouteFact` 增 `vehicles/waiting/profit`（局终时由 hub 读数按 job 关联）。
**幂等键加入经济读数**：同一条线这次 −308、下次 +5000 是**两个不同观测**，
用旧键会把新观测静默丢弃。

注入形态（红线：无建议词，断言测试锁定）：

```
route towns 9->12 was ordered at decision 1 and was built; at session end it had
6 vehicles, 146 passengers waiting and -308 year-to-date profit
```

这就是 §10.43 诊断的修法：记忆从"我做没做"变成"这件事最后是什么结果"。

### 真机验证（/tmp/n2g，seed 11，400s）

**N2-2 工具**（模型真的调用了它，且两条路径都活）：

```
tool inspect_route: ok=false no route economics reported yet. …      ← 尚未有读数
tool inspect_route: ok=true  route 1: 0 vehicles, waiting 0, …       ← 有读数
tool inspect_route: ok=false unknown route job 2. Known jobs: 1      ← 未知 job 被拒并列出已知
tool inspect_route: ok=false unknown route job 3. Known jobs: 1
```

模型反复探问 job 2/3（当时只有 job 1）——拒绝路径给出已知清单，模型据此继续。

**N2-2b 上下文注入**（每次决策一行，多线路、非零读数）：

```
[agent] route facts: route 1: 6 vehicles, waiting 178, income -1/day (year-to-date -270);
                     route 2: 6 vehicles, waiting 0, income 0/day (year-to-date -8);
                     route 3: 0 vehicles, waiting 0, income not meaningful yet …
```

局末 `constructionDone=false`（第三条线在建），6 辆车 / 6 站——**第一条线在亏钱且排队涨到 178**。

### 两处"诚实性"缺陷（真机日志抓出，均已修 + 测试锁定）

1. **0 辆车时显示"year is 116 day(s) old"**：把"没有车"说成了"年份太新"。
   两种原因必须分开（无车 → `income unknown (no vehicles on this route yet)`）。
2. **`Math.round(-0.03)` = `-0` 显示成 `0/day`**：一条微微亏损的线读起来像"持平"。
   1/day 以下改用两位小数（`-0.03/day`）。

## 10.55 NEXT-2 N2-4：主指标换成收益流 + 标定结果（2026-09-16）

### met指标

`ArmStats.meanIncome` / `incomeReported`；`ArmComparison.incomeDelta`。

**缺失 ≠ 0**：没报收益的局不参与均值（0 会被读成"这家公司确实不赚钱"——数据没
这么说）。负收益是**合法读数**（亏损线），照实进均值。

为什么换：money 被"建不建"主导——**建线就是花钱，钱变少**，三轮 A/B 全部卡在这里
（§10.52）。income 才是"这条线到底赚不赚钱"，也是记忆能影响的量。

### 标定（/tmp/n2g，seed 11，400s，真机）

| 指标 | 值 | 参照 |
|---|---|---|
| decisions/game | **8.0** | m3 轮均为 4.3（§10.52） |
| triggers | start 1 / event 3 / phase_change 3 / interval 1 | 多样，非单一触发器 |
| idle rate | 14%（1/7） | 早期 calC 为 0%——**如实记录，不粉饰** |
| 工具分布 | estimate 7 / **inspect_route 6** / build 3 / **add_vehicles 2** / observe 2 | add_vehicles 在此前的轮次基本未被使用 |

**关键行为证据**：模型**第一次真的用上了 `add_vehicles`**。NEXT-2 的目标就是把
"选一对城镇"变成线路组合管理；车队管理动作出现，说明决策空间确实被行使了。

## 10.56 N2-5 首轮 A/B 判废：臂划分缺陷（2026-09-17）

### 结果先说：**判定无效**，不是"没有效应"

`/tmp/n2ab`（n=5/臂，400s，seed 7）跑完，verdict 自报 "5 with-lessons vs 5
without"——**假的**。metrics.jsonl 逐局核对：

| # | 分配 | lessons | facts | decisions | built |
|---|---|---|---|---|---|
| 1 | ctl | 0 | 0 | 3 | ✗ |
| 2 | **trt** | **0** | **0** | 3 | ✗ |
| 3 | ctl | 0 | 0 | 5 | ✗ |
| 4 | trt | 3 | 3 | 3 | ✗ |
| … | | | | | |

**第 2 局是 treatment，却因为"注入数为 0"被算进 control → 实际是 4 vs 6。**

### 根因（D4 第三问的残留漏洞）

新 dataDir 的**第一局 treatment 无任何记忆可注入**（还没有 lesson/fact 存在），
而臂划分用的是"注入了多少"而不是"被分配到哪一臂"。这是 m3f 缺陷的下一层：
上次修了"facts 也算注入"，这次暴露"**注入为空 ≠ 不是 treatment 臂**"。

### 修法

1. `SessionMeta.arm` / `GameMetric.arm`：**分配时记录**（runner 由
   `--no-memory` 决定），`compareArms` 优先按 `arm` 划分；旧记录退回启发式。
2. `ArmComparison.treatmentWithoutInjection`：treatment 臂里**干预没送到**的局数，
   两个 verdict 脚本都会 `WARNING` 点名——这类局稀释效应，不许静默平均。

### 首轮的原始数据（即便臂错，也如实记录）

- 建成率：treatment 1/4、control 1/6 → **10 局只建成 2 局**（m3i 同窗口为 8/10）
  ——窗口方差极大，本轮几乎全是截断。
- tok/决策：13,175 vs 12,562 → **+4.9%**（此前三轮为 +26%/+41%/+41%）。
  这与"事实型记忆比散文型 lesson 紧凑得多"一致，但 n=4/6 且分配错误，**仅作待测假设**。
- income 均值：-70,142 vs -37,778。注意 income 在施工期本来就为负
  （建设/贷款成本），**"没建线"的局反而 income 接近 0**——与 money 同一个陷阱，
  所以 income delta 同样受建成率混杂，必须与 built rate 一起读。

## 10.57 N2-5 有效轮次（n=5/臂，500s，/tmp/n2ab2）与两个结论（2026-09-17）

### 结果：臂划分正确（5 vs 5），但**守卫仍拒绝下结论**

| | n | money | tok/决策 | 建成率 | 站点 | income | delivered |
|---|---|---|---|---|---|---|---|
| with lessons | 5 | 203,168 | **14,655** | **0.60** | 2.80 | −56,832 | — |
| without | 5 | 241,140 | **14,535** | **0.40** | 3.60 | −58,860 | — |

`conclusive: false` —— 建成率 60% vs 40% 不同，money/income 不可比（**没建线的局花钱少，
所以"钱多"恰恰因为是失败的局**——与 §10.52 同一个陷阱，income 也逃不掉）。

### 结论 1：**记忆的 token 代价消失了**（本次唯一稳健的结果）

tok/决策 **14,655 vs 14,535 = +0.8%**（n=5/臂、臂划分正确）。
对照：三轮散文 lesson 时代为 **+26% / +41% / +41%**，而 /tmp/n2ab 为 +4.9%。

这与 §10.43 的修法一致：**结构化事实型记忆远比散文 lesson 紧凑**。§10.43/§10.52
里"记忆显著更贵"的诊断，在事实型记忆上**不再成立**——这是个正面结果。

### 结论 2：`income` 不是可用的目标量——**运营在盈亏平衡点附近，公司亏损来自施工与贷款**

- `payload-parsers.ts:67` 写明 admin 协议的 `income` 是 **net（含负的费用）**，
  所以施工期必然为负：它继承了 money 的混杂，我此前把 income 当"收益流"是**不准确的**。
- 10/10 局净 income 为负（−1.5k ～ −121k）；但 money 反而从 10 万涨到 20–28 万，
  因为 **loan 300,000**——现金是借来的，不是赚来的。
- GS 侧逐线读数显示运营本身在零附近：route 1 六辆车、178 人等待、`profit −270/年`
  ——**线路在跑、人在等，但基本不赚钱**。

**因此**：在"所有策略都不赚钱"的任务上问"记忆能不能提高收益"**没有梯度可测**。
这不是记忆的问题，是任务的问题。

### 修法：N2-4b 吞吐量指标（`deliveredCargo`）

admin 协议里**早就解析**了 `deliveredCargo`（`payload-parsers.ts:92`）却从未记录。
它是"实际运了多少货/客"，**不受施工花费与贷款影响**，且 `0` 是合法读数
（建了线没运货）与"缺读数"区分。已加入 `GameMetric.delivered` /
`ArmStats.meanDelivered(deliveredReported)` / `ArmComparison.deliveredDelta`，
两个 verdict 脚本都打印，并标注为 **least confounded outcome**。

### 下一步（数据推导，非猜测）

1. **先在吞吐量上建立"有策略能做事"的基线**：若最优策略也只能让 delivered≈0，
   则目标函数本身不成立，任何 A/B 都无意义。
2. 之后才谈记忆效应——用 delivered（而非 money/income）做主判据。
3. 窗口/方差：本轮 10 局建成 6 局（500s），比 400s 轮的 2/10 好，但仍需与建成率同读。

## 10.58 N2-5 oracle 探测：任务梯度成立（2026-09-17）

### 结论：**框架能运送货物**，任务有梯度

新增 `pnpm run cli --v02 --add-vehicles N`：v02 路径在 done 后发 add_vehicles 满车，
**不靠 agent 决策**——是"已知好的程序策略"的对照基线。同时 v02 RESULT 时读
deliveredCargo 并写一行 `metrics.jsonl`（`arm=control`），与 agent 路径同形。

### 真机对照（500s，v02 + add_vehicles=20）

| dataDir | seed | delivered | income | money | stations | vehicles |
|---|---|---|---|---|---|---|
| /tmp/baseline1 | 7 | **20** | −66,504 | 233,496 | 2 | 3 |
| /tmp/baseline2 | 11 | **31** | −43,127 | 256,873 | 2 | 3 |

**两个 oracle 局都 delivered > 0**——这是"任务是否可解"的独立答案：
**框架能运送货物；agent 局的 delivered 量级可比**。

### 但**公司仍亏钱**（−30k ~ −66k/局）

即使 baseline 满车 6 辆、delivered = 31、cash delta = −30k——**收入不足以覆盖
贷款利息 + 运行成本**（初始 loan 300k）。这与 §10.57 的诊断一致：
**问题在地图/参数（贷款、初始现金、利率、地图大小）**，不在框架、也不在 agent 智能。

### 下一步（数据推导）

- 既然 oracle 稳定 delivered ∈ [20, 31]，那么 agent 局的 delivered 差异**就能被测量**。
- 重跑一组 **agent n=3/臂、500s**（用含 N2-4b delivered 的当前代码）→ 比对
  with-lessons vs without-lessons 的 delivered。**delivered 是首个"有梯度"的目标量**。
- money/income 仍降为次级参考——它们不反映策略。

## 10.59 工具必须能观测自己的效果：rcon 回执通道 + 两个实测事实（2026-09-17）

### 新缺陷：所有 rcon 都是"盲发"

`ServerRcon(120)` / `ServerRconEnd(125)` 在 observer 的 `default: return null` 里被
**丢弃**（admin-client 只留给一个从未被赋值的 `onRconResult` 回调）。后果：

- `set_pause` 只能说"命令已发送"，**无法知道游戏有没有真的暂停**；
- 存档（`rcon save`）只能靠 `sleep(2500)` 赌它写完；
- 无法查询游戏自身的设置与命令表。

这正是本项目反复付学费的一类错误：**工具不能观测自己的效果**。

### 修法（契约来自官方文档，不是猜）

`Resources/docs/admin_network.md:190-191`：一次 rcon → **一个或多个**
`SERVER_RCON` 包，**最后**一个 `ADMIN_PACKET_ADMIN_RCON_END`。

因此 `AdminClient.rconAwait(cmd, timeoutMs)` **按 FIFO 结算**（真机实测
**命令文本不回显**：`command` 字段为空，所以"按命令匹配"是错的），
以 `RCON_END` 为完成信号，多行合并返回；超时返回 `null`（"没有回答"，
不是伪造成功）。所有回执进入运行日志（`[agent] rcon <cmd>: <reply>`）。

`set_pause` 随之改为**观测后回报**：有回执 → 汇报游戏的原话；无回执 → 明说
"是否暂停未知"（`ok:false`）。测试同时锁定两条路径。

### 事实 1：pause / unpause 双向有效（推翻 §10.28 的归因）

```
[before pause]   getdate → 1950-01-02
[paused #1]      getdate → 1950-01-02   ← 冻结
[paused #2]      getdate → 1950-01-02   ← 仍冻结
[after unpause #1] getdate → 1950-01-03 ← 恢复推进
[after unpause #2] getdate → 1950-01-04
```

**"暂停是单向的"不成立**（至少在 `pause_on_join=false` + `min_active_clients=0`
的沙箱配置下）。历史上那次"永久冻结"更可能是**网络默认值**
（`pause_on_join=true`，无客户端来解暂停）——§10.28 顺带修掉的正是它。

### 事实 2：**没有服务端速度旋钮**

- `setting game_speed` → `'game_speed' is an unknown setting.`
- `setting world_speed` → `'world_speed' is an unknown setting.`
- `list_settings` 中与速度/时间相关的键只有 3 个：
  `difficulty.competitor_speed`（AI 对手速度）、`vehicle.wagon_speed_limits`
  （物理真实性）、`gui.fast_forward_speed_limit`（**客户端**快进上限，2500）。
- `list_cmds` 全表（100+ 条，已实测导出）**没有任何速度/快进命令**。

**结论**：dedicated server 的模拟速度**不可调**；"快进"是客户端功能。
唯一影响"游戏内时间 vs 墙钟"的手段就是 **pause/unpause**（时间膨胀）。

### 由此产生的决策（留给项目所有者）

既然 pause/unpause 实测可用，**"决策期间冻结世界"重新成为可选项**：

| 方案 | 好处 | 代价 |
|---|---|---|
| 现状：不暂停 + 快照 + 增量汇报 | 墙钟不浪费；世界推进带来的变化被如实汇报 | 模型看到的快照会过期（本轮实录：`inspect_route` 返回 0 辆车时上下文已是 6 辆） |
| 冻结：pause → 决策+执行 → unpause（**带 rconAwait 确认 + 看门狗重试**） | 动作落在模型真正见过的世界状态上 | 决策耗时不产生游戏进展；`--demo-seconds`（墙钟）与游戏天数脱钩 |

**建议**：以"已验证的冻结"做一次同 seed A/B（freeze vs no-freeze），
用 delivered 判据——而不是凭信念二选一。

## 10.60 已验证的冻结（`--freeze`）：重新引入暂停，但这次可观测（2026-09-17）

### 为什么可以做了

§10.59 实测推翻"暂停单向"的旧结论 → 决策期冻结重新可用。但它必须满足三条，
否则就是重蹈 §10.26（永久冻结）：

1. **暂停/恢复都要回执确认**（`rconAwait`）；无回执 → 明说"没冻住"（`acquireUnconfirmed`），
   流程继续跑（**不假装冻住**，否则冻结 A/B 的整轮结论作废）；
2. **恢复在 `finally` 里**（`decision-loop.ts`），并有重试（恢复比暂停重要）；
3. **看门狗**：持有上限 120s，超时强制恢复（一次卡死的决策不能永久冻住游戏）。

### 实现

- `src/agent/freeze.ts`：`makeFreezeController({pause, unpause, now, log, maxHoldMs})`
  → `acquire(reason)` / `release()` / `isHeld()` / `stats()`
  （`acquisitions` / `acquireUnconfirmed` / `unpauseFailures` / `watchdogTrips` / `maxHoldMs`）。
- `decision-loop.ts`：把**模型思考 + 工具执行**整段包在 `acquire` … `finally release`。
- `src/cli/run.ts --freeze` + `run-experiment.ts --vary freeze`（两臂只差冻结，
  且都 `--no-memory`——记忆不是本轮自变量）。
- 局末打印 `[agent] freeze: N confirmed pause(s), …`：**冻结 A/B 必须能证明它真的冻住了**。

### 真机冒烟（/tmp/f4、/tmp/f5，seed 7）

```
[agent] DEBUG acquired held=true   ×4      ← 4 次决策，4 次确认冻结
```

### 一个自食其果的观测教训

`pause` 命令在 OpenTTD 里**没有输出行** → `[agent] rcon …` 日志里**完全看不见**，
最初我据此以为"冻结没生效"（连查三轮，插了 4 处调试才发现是**日志缺失**而非功能缺失）。
修法：冻结控制器**在成功路径也留一行** `[freeze] paused for "decision N" (acknowledged)`
/ `[freeze] resumed after Xms`。

**教训**：给模型和给自己看的事实，都要**在成功路径留证据**——"没有日志"既可能是
"没发生"，也可能是"发生了但没说话"，而这两者必须能被区分。

### 第二个自食其果：比较维度必须可指定（同轮发现）

`arm` 字段是按"记忆注入"定义的，而冻结轮**两臂都 `--no-memory`** → 两臂全被记成
`control`，统计直接失去对照（首轮 /tmp/fzab 因此作废）。这是 §10.56"臂来自分配"
的续集：**分配的是哪个变量，就必须记录那个变量**。

修法：
- `GameMetric.freeze`（confirmed / unconfirmed / failures / watchdogTrips / maxHoldMs），
  与 `arm` 并列记录；
- `compareArms(metrics, by)` —— `by: "memory" | "freeze"`；
- `evolutionView(dataDir, by)` 与 `run-experiment --vary` 贯通；
- 冻结维度下"要求冻结但一次都没确认"的局**算 control**（干预没送到 ≠ treatment）。

## 10.61 冻结 vs 不冻结：机制成立，但在本任务里**冻结要付吞吐**（2026-09-17）

### 干预已核实（这一步必须先成立）

`/tmp/fzab2`（n=5/臂，500s，seed 7，两臂都 `--no-memory`，`--vary freeze`）：

| | n | 冻结确认 | 恢复失败 | 看门狗 | 建成率 | 站点 | delivered（逐局）| 决策数 |
|---|---|---|---|---|---|---|---|---|
| **frozen** | 5 | 3–8 次/局 | 0 | 0 | **0.20** | 2.00 | **0,0,0,0,0 = 0** | 6,3,8,6,9 |
| **unfrozen** | 5 | — | — | — | **0.60** | 2.80 | 15,0,13,0,0 = **28** | 8,3,7,7,4 |

`conclusive: false`——建成率 20% vs 60% 不同（守卫拒绝在建成率不等时比较 money/income）。

### 关键量：冻结**减少了游戏内时间**

局末游戏日期（起点均为 712223）：

- unfrozen：712477 / 712463 / 712477 / 712478 / 712463 → **≈249 天**
- frozen：712457 / 712453 / 712438 / 712433 / 712449 → **≈223 天**

**同一 500s 墙钟窗口，冻结局少走约 10% 的游戏天数**——这是"时间膨胀"的必然结果，
也是"墙钟 ≠ 游戏时间"的直接证据。

### 诚实解读：两个原因**无法用本轮数据分离**

1. **游戏时间混杂**：少 10% 时间；在 500s 窗口里交付链条本就勉强，10% 足以让
   "晚建成"的线路变成"零交付"。
2. **冻结的真实代价（更像是主因）**：暂停时**脚本 tick 停止** → executor 与 GS
   在模型思考期间**完全不能推进施工**。而未冻结的局，模型思考时施工仍在继续。
   **本任务的瓶颈正是施工的墙钟时长**，冻结恰好把"思考"与"施工"从并行改成串行。

因此本轮不能宣称"冻结让决策变差"，能说的是：**在本任务里，冻结的代价是吞吐
（施工与思考不再重叠），而收益（动作落在见过的世界上）在当前判据上看不出来。**

### 结论与建议

- **默认保持不冻结**（现状：快照 + `sinceLastDecision`）。
- 若要用冻结，**不要整段冻结"思考 + 工具执行"**，只冻结"模型给出计划"的那一小段，
  或按**游戏时间**而非墙钟设定预算。
- 若要以决策质量为目的重测：必须**等游戏时间**（按游戏天数停止，或按天数预算），
  并用 `delivered / 游戏天数` 归一化后再比。

## 10.62 NEXT-2 收尾：首个干净判据的 memory A/B —— 方向有利，但 n=5 不足以判定（2026-09-17）

### 本轮与前三轮的根本差别：判据第一次干净

前三轮（§10.52）用 money/income/建成率判"记忆有无收益"，三者**全部被施工花费与
窗口截断污染**。本轮改用 **`deliveredCargo`**（§10.57：不受施工花费与贷款影响，
`0` 与"缺读数"区分），且先有 **oracle 基线**证明任务有梯度（§10.58：程序策略
delivered = 20 / 31）。

### 数据（/tmp/n2ab3，n=5/臂，500s，seed 7）

| 臂 | delivered 逐局 | 和 | 均值 | **中位** | **零率** | 建成率 | 站点 | tok/决策 |
|---|---|---|---|---|---|---|---|---|
| with memory | 0, **77**, 39, 0, 0 | 116 | 23.2 | **0** | **60%** | 0.40 | 3.20 | 16,345 |
| without | 0, 23, 0, 18, 15 | 56 | 11.2 | **15** | **40%** | 0.60 | 4.80 | 15,291 |

- `delivered delta: +12`（均值方向 favor 记忆）；tok/决策 **+7%**（与 §10.57 的
  "事实型记忆几乎不加价"一致，对照散文时代 +26~41%）。
- 决策数：with memory 45 次 vs without 35 次（记忆臂想得更多）。

### 关键methodological发现：**均值与中位数符号相反**

记忆臂均值高是因为**一局 77** 撑起 116 的总和；它的中位数是 **0**（5 局里 3 局
零交付），而对照臂中位数 15。**同一份数据，均值说记忆更好，中位数说记忆更差。**

→ **`delivered` 是零膨胀重尾量**。在 n=5 上比较均值，等于让最尾部的一局代表整个臂。
这是"前三轮总是不可判定"的**共同统计原因**，此前被归因于"任务太浅"。

**修法**（已实现，`metrics.ts`）：
- `ArmStats.medianDelivered` + `zeroDeliveredRate`（零率是零膨胀本身的度量）；
- `ArmComparison.deliveredNote`：当均值与中位数**符号相反**时明确标注
  "不要只读均值"；
- **`deliveredConclusive`**：delivered 的判定**不再被 built-rate 守卫挡住**——
  那条守卫是为 money/income 设的（"没建成→没花钱→钱更多"），而 delivered 恰好
  相反（没建成→没运货→0，是**诚实结果**而非偏差）。用别的量的病否决本量的问题
  是判据设计的错误。

### 结论（如实）

- **不可判定**（n=5，且均值/中位数符号相反）。**不能**据此声称记忆有效。
- 但方向**首次**在干净判据上倾向记忆（均值 +12），且记忆的 token 代价已近乎为零。
- **下一步**：① 提高样本（delivered 的方差要求 n 明显大于 5）；② 报告用中位数/零率
  或自助法置信区间，而不是均值；③ 若继续用均值，必须同时给出中位数并检查符号是否
  一致。

## 10.63 校准轮（900s）：**窗口是方差的主因**，实验设计随之改变（2026-09-18）

### 结果（/tmp/cal900，4+4 局，900s，seed 7）

| 指标 | 500s（§10.62） | **900s（本轮）** |
|---|---|---|
| **零交付率** | 70% | **0%**（8/8 都有交付）|
| **建成率** | 20–60% | **100%**（双臂）|
| delivered 均值 | 9.6 | **258** |
| 变异系数 CV = σ/μ | **1.95** | **0.48**（降约 4 倍）|
| tok/决策 | +7% | **＋0.1%**（16,486 vs 16,503）|

逐局：control `[92, 155, 284, 310]`（均值 210，中位 219.5）；
with-memory `[166, 260, 273, 527]`（均值 306，中位 266.5）。
`delivered delta (mean) = +96`、中位 +47 —— 但 n=4/臂、CV=0.48 时对 +46% 效应的力量
仅 **0.34**，**明确不是结论**。

### 这一轮改变了实验设计（这才是它的产出）

力量模拟（新分布，α=0.05，t 检验）：

| n/臂 | +20% | +30% | **+46%（本轮观测）** | MW +30% |
|---|---|---|---|---|
| 5 | 0.16 | 0.23 | 0.34 | 0.14 |
| 10 | 0.18 | 0.27 | 0.45 | 0.20 |
| 15 | 0.23 | 0.37 | 0.62 | 0.32 |
| **25** | 0.31 | 0.51 | **0.83** | 0.49 |
| 40 | 0.40 | 0.69 | 0.94 | 0.72 |

**结论**：
1. **500s 窗口是方差与零膨胀的主因，不是"任务太浅"。** 把窗口从 500s 提到 900s：
   零率 70%→0%、建成率→100%、CV 1.95→0.48。此前把"总是不可判定"归因于任务难度，
   实际是**实验设计把方差塞进了结果**。
2. **统计量必须随分布换。** 900s 下双臂 deliveryRate 都是 100% → 障碍率**饱和**、
   Fisher 必然 p=1（该统计量在此无判别力）。比较必须转向**量级**：
   均值/中位的 t 检验与 Mann-Whitney 秩检验；`deliveredNote` 在饱和时明确提示这一点。
3. **n 由 MDE 决定，不拍脑袋**：若只关心 +46% 这类大效应 → 25/臂（≈16 小时）；
   若关心 +30% → 40/臂以上。**+20% 在可承受的样本下无法检出**，必须事先声明为
   不可检出的效应。
4. **记忆的 token 代价在 900s 下也消失**（+0.1%），与 §10.57/§10.62 一致。

**下一步**：按**顺序检验（sequential）**跑首个 block（5/臂），预先登记停止规则：
每 5 局/臂为一个 block，用保守 α=0.01 的自助法 CI；CI 不含 0 即停，否则继续到
12/臂、再到 25/臂上限。这样"大效应早停、小效应诚实报不可判定"。

## 10.64 顺序检验 block #1（n=5/臂，900s）：CI 含 0 → 续跑；但诊断指向**设计**而非样本量

### 数据（/tmp/ab900，seed 7，5+5 局）

| | with memory | without |
|---|---|---|
| delivered 均值 / 中位 | **137** / 134 | **190** / 253 |
| 建成率 | 80% | **100%** |
| deliveryRate | 100% | 80% |
| 零交付率 | 0% | **20%** |
| tok/决策 | **20,534** | 17,066（**+20%**）|
| 站点数 | 5.20 | 4.40 |

`meanDiff 95%CI = [-147.4, 56.4]`（**含 0**）；Fisher p=1.0000；MW p=0.5309。
按**预登记规则**：CI 含 0 → 不可停，本应续到 12/臂。

### 三条必须记录的观察

1. **方向翻转两次**：校准轮 treatment 领先（306 vs 210），本 block control 领先
   （190 vs 137）。两轮合读 = **未建立任何效应**；把任一轮当"信号"都是选择性引用。
2. **零交付率不是 0%**：校准轮 8/8 有交付，本 block 10 局中 **1 局交付 0**（且
   `constructionDone=true`——建成却没运出）。"900s 消除零膨胀"是 **n=8 的巧合**，
   §10.63 的"零率 0%"应读作"≤1/8"，不是"0"。
3. **`rc=1` 不是崩溃**：`reflect-run.ts:162` 是 `return reachedDone ? 0 : 1`——
   退出码 1 = **施工未达 DONE**（trt5 的 `constructionDone=false phase="EX stA_wait"`），
   是框架的诚实自报。**把它当基础设施故障会把一个正常实验判废。**

### 方差诊断（先用已有 18 局数据查干扰变量，不写代码）

| 假设 | 数据 |
|---|---|
| 窗口长度/游戏天数 | 900s 下各处近似相同 → 不是主因 |
| 车队规模 | **同 6 辆车 delivered 从 0 到 279**；3 车有 0/124/155；15 车有 92/527 → 弱相关 |
| 站点数 | 4–6，区分不了 |
| **遗留**：**路线选择 + 施工时序**（= agent 自身决策的噪声）| 无法从既有字段解释 |

**结论**：`delivered` 的 CV≈0.5 主要由**路线选择与施工时序**贡献，二者都**不是**可以
事后归一掉的场景差异，而是**被测行为本身的噪声**。因此：
- 单纯加样本到 25/臂（≈14 h）**大概率仍不可判定**（+30% 效应在 25/臂仅 0.51 力量）；
- 按预登记规则的**成本条款（>3 h/轮即先做方差缩减）**，下一步应是**设计改动**：
  把"单局一个数字"变成**局内重复测量**（多条线路 × 每线路每日交付），
  使每局提供多个观测，而不是继续堆局数。

### 遗留缺陷（下次动手先修）

- verdict 的 `exit codes: … treatment=…,1` **不注明含义**，极易被读成崩溃
  → `run-experiment.ts` 应在 rc≠0 时打印原因（`constructionDone=false`）。
- `metrics.jsonl` **没有游戏时间字段**（无 gameDate/gameDays），故 `delivered/game-day`
  类归一无法事后补算，只能从日志 scrape。

## 10.65 流量指标的**测量缺陷**：`deliveredCargo` 是当季计数器（2026-09-18）

### 事实（协议层）

`ServerCompanyEconomy` 里的 `deliveredCargo`（`payload-parsers.ts` 读作 **u16**）
是 OpenTTD 的 **`cur_economy.delivered_cargo`**——**本季度已运出的货物量**，
**每季度归零**（同一包里随后的两个 `old_economy` 条目才是历史季度）。
它不是累计值。

### 后果（为什么两轮 A/B 方向相反）

此前判据用的是"运行结束那一刻的读数"，于是它实际测的是**随机一段部分季度**的交付量：

| 运行结束位置 | 读数含义 |
|---|---|
| 恰在季度重置之后 | **≈0**，无论之前运了多少 → 建成却"零交付" |
| 季度中段 | 只覆盖该季度已过的 0–90 游戏天 |
| 季度末尾 | 接近一整季 |

`/tmp/ab900` 的证据：`ctl4` **建成（constructionDone=true）却 delivered=0**；
18 局里**同为 6 辆车**的 delivered 从 0 到 279。季度相位与施工时序一起，
把 CV 抬到 ≈0.5，并让校准轮（treatment 领先）与本 block（control 领先）**方向相反**。
**§10.63 的"零率 0%"是 n=8 的巧合**，本 block 已出现 1/10 零交付。

### 修法：`deliveredRun`（跨季积分）

新增纯函数模块 `src/game/delivery-meter.ts`，挂在 `world-state.ts` 的
`company_economy` 分支（经济包 **700 ms** 一次）：

- 以**游戏日**识别季度（本项目 360 天年 / 90 天季），跨季时把上一季读数**结转入累计**；
- 季内取 max（轮询重放不重复计数）；**季内倒退**视为计数器重启，先结转再重计（`resyncs`）；
- **漏掉整季**计入 `gaps` 并使 `complete=false`——总额此时只是**下界**，允许调用方拒绝比较；
- 缺读数只损失分辨率，不计入不完整。

落盘：`GameMetric.deliveredRun` / `deliveredRunComplete`（`delivered` 保留为**原始读数**，
因为它是"线缆真相"）。判定**优先用积分值**，但**两臂必须同源**：只有在两臂都达到
样本下限时才切到 `run`，否则两臂一起回落到 `raw` 并由
`ArmComparison.deliveredSource` + verdict 明示（混用 = 拿不可比的东西比较）。

### 顺带的两个输出缺陷（已修）

1. `run-experiment.ts` 打印 `rc=${code}` 而不解释含义：`reflect-run.ts:162` 是
   `return reachedDone ? 0 : 1`，即 **rc=1 = 施工未达 DONE**，不是崩溃。
2. 本项目的 `delivered` 语义此前无任何一处注明"当季"，读者只能假设它是累计值。

## 10.66 GS 通道的**部分失效**：`GSStation.IsStationTile` 不存在（2026-09-18）

### 事实

`src/game/squirrel/bridge-gs/main.nut` 的 `StationNear(tile, radius)`（N2-1 为
executor 的 `FindAltSite` 兜底而加的**半径扫描**）调用了 **`GSStation.IsStationTile`**
——**该函数在 GS API 里不存在**（站点地块判定在 `GSTile` 上）。因此每次走到扫描路径：

```
{"cmd":"route_stats","detail":{"reason":"the index 'IsStationTile' does not exist"},"kind":"err"}
```

### 为什么它躲过了两轮实验

1. **只在"精确地块查不到站点"时触发**（= executor 挪过址），不是每次调用；
2. **失效是部分的**：只有 `route_stats` 这一种请求失败，其余通道照常，
   所以运行看起来一切正常；
3. **严重程度逐局差异巨大**——verdict 里没有任何一行能显示它。

| 目录 | 命中局数 | 错误次数 | 单局差异举例 |
|---|---|---|---|
| `/tmp/ab900`（10 局）| **10/10** | 610 | `ctl5` 2 次/240 条回复 ↔ `ctl4` 60 次/**仅 20 条** ↔ `ctl3` 152 次/151 条 |
| `/tmp/cal900`（7 局）| **7/7** | 535 | `trt2` 150 次/151 条 |

**后果**：agent 的线路经济读数在某些局里**丢了 50–92%**，而 `ctl4`——正是那局
**delivered=0**——只拿到 20 条。ab900/cal900 的 A/B 比较因此是在
"**部分失明**"的通道上做的，两臂差异不可解释。全量日志里该错误共 **1221 次**，
且是**唯一**一种"索引不存在"类错误（其余 GS API 用法均经真机验证）。

### 修复与守卫

- 改用循环外那对**已验证**的调用：`GSStation.GetStationID(cand)` +
  `GSStation.IsValidStation(cs)`（无需 `IsStationTile`）。
- 新增静态守卫 `test/unit/squirrel-api-guard.test.ts`：Squirrel 包只在 OpenTTD 内
  执行，单测无法运行时调用，故用**基于证据的黑名单**（每条必须来自线上观测到的
  `reason` 字符串）阻止回归；同时断言"半径扫描**仍然存在**"——否则删掉扫描也能让
  错误消失，代价是挪址后的线路被静默报成"无车辆"。
- **真机验证（/tmp/dm3）**：`IsStationTile` 错误 **0** 次、route-stats **313 条**
  （修复前同长度窗口为 20–291 条且伴随两位数错误）。

### 新增：通道健康指标（让这类缺陷无处隐身）

`SignalHub.getGsErrors()` → `GameMetric.gsErrors`（每局 GS 错误回复数），
verdict 在任何收益声明**之前**打印它：

```
channel health (GS errors/run): with-memory n=5 max=152 total=…  without n=5 max=60 total=…
(>0 means the agent ran with a partially broken GS channel)
```

历史行没有该字段，显示 `not reported`——**不假装它们是干净的**（我们知道按日志
至少 17 局都命中过）。

### 真机验证：跨季积分（§10.65）同时得到量化证据

修复后的 900s 运行（`/tmp/dm3`，seed 7）：

| 读数 | 值 |
|---|---|
| `delivered`（原始当季计数器）| **136** |
| `deliveredRun`（跨季积分）| **219**（**比原始读数高 61%**）|
| `deliveredRunComplete` | `true` |
| 建成 / 车辆 / 站点 / 决策 | true / 10 / 4 / 12 |

同一局"运了 219"，而"结束时读一次"只能看到 136；若结束点恰在季界之后则是 ~0
（正是 `ctl4`）。**旧判据系统性低估，且低估幅度随季相位随机浮动。**

## 10.67 校准 #2（修好仪器后）：**仪器缺陷不是方差来源**，且发现"工具暴走"局（2026-09-18）

### 数据（/tmp/cal2，3+3 局，900s，seed 7，新仪器）

| arm | `deliveredRun` | raw | `gsErrors` | built | decisions |
|---|---|---|---|---|---|
| control | 225 / 19 / 0 | 144 / 19 / 0 | **0 / 0 / 0** | ✓ / ✓ / ✗ | 10 / 9 / 5 |
| treatment | 37 / 44 / 42 | 24 / 37 / 20 | **0 / 0 / 0** | ✓ / ✗ / ✓ | 12 / 10 / 11 |

**两个仪器修复都得到验证**：`gsErrors` 全 0（§10.66 的通道修复生效）；
`deliveredRun ≥ delivered` 在**每一局**成立（225>144、37>24、44>37、42>20、19=19、0=0），
即旧的"结束时读一次"**系统性低估**，低估幅度 0–56%。

### 被证伪的假设（诚实记录）

我在 §10.65/§10.66 之后预期："修好仪器 → CV 从 ≈0.5 下降"。**没有发生**：
control 臂 CV=**1.25**（同臂内 0、19、225），treatment 臂 CV=0.07。
→ **两个仪器缺陷是真实的、必须修的，但它们不是方差主因**。方差来自
**局间行为差异**（建成与否、决策数 5–12、选了哪条线），这是被测对象的噪声，
不能靠测量端消除。

### 发现：**工具暴走局**（新的方差来源，且可干预）

| arm | tokens | decisions | tok/dec | tool calls | tools/decision |
|---|---|---|---|---|---|
| treatment（正常局）| 151k / 227k | 10 / 12 | 15k / 19k | 25 / 30 | 2.5 / 2.5 |
| **treatment（暴走局）** | **1,482,865** | 11 | **134,806** | **193** | **17.5** |
| control（正常局）| 122k / 205k / 65k | 9 / 10 / 5 | 13k / 20k / 13k | 15 / 34 / 14 | 1.7 / 3.4 / 2.8 |

一局占该臂 3 局 token 总量的 **82%**，把"per-decision cost"抬到正常的 9 倍。
这是**逐局工具数无界**的后果（无每决策预算），而不是记忆的代价：
§10.62/§10.63 里"记忆贵 +7%/+0.1%"的结论在 500s/900s 上成立，
但在有暴走局的小样本里，**均值会被单局主宰**。

**结论**：`tokensPerDecision` 一类指标必须与**离散度/离群值**一起报告；
且"每决策工具调用上限"是一个**具体、可测**的下一步干预（当前无上限）。

## 10.68 **测量单元本身不可比**：墙钟预算 → 可变模拟时间（2026-09-18）

### 事实（同一 `--demo-seconds 900` 的 6 局）

| 局 | durationMs | **实际推进的游戏日** | 天/墙钟秒 | deliveredRun | 每游戏日交付 | status |
|---|---|---|---|---|---|---|
| control | 900,915 | **449** | 0.50 | 225 | 0.501 | completed |
| treatment | 900,467 | 445 | 0.49 | 37 | 0.083 | completed |
| control | 900,439 | **273** | 0.30 | 19 | 0.070 | completed |
| treatment | 900,735 | 445 | 0.49 | 44 | 0.099 | aborted |
| control | 900,271 | **0** | 0.00 | 0 | 0.000 | aborted |
| treatment | 900,760 | 448 | 0.50 | 42 | 0.094 | completed |

**墙钟预算相同，模拟机会相差 0 → 449 游戏日（≈100%），且有一次为 0。**
成因至少三类：① 机器负载（脚本/AI 吞吐决定每秒能推进多少游戏时间）；
② **agent 自己调用的 `set_pause`**（本轮 cal2 8 次、ab900 16 次）；
③ 任何冻结/暂停机制。→ **结局近似与"推进了多少游戏时间"成正比，
而这个分母不是常数**：这是与 §10.65/§10.66 同一类的缺陷——
**测量单元与现象没有对齐**。

### 推论：一个"局"从未被定义成可比单元

`--demo-seconds` 定义了**墙钟**长度，却没有任何地方定义**模拟**长度。
于是"同一实验里的两局"实际是**不同长度的世界**，而判决把它们当同质样本平均。

**更危险的后果**：一次**世界根本没推进**的运行（0 游戏日）被记成
`deliveredRun=0`——**"世界停住了"与"agent 什么都没运"在记录里长得一模一样**。

### 修正（harness 契约，非策略）

1. **局应按模拟时间结束**：跑固定 **游戏日数**（如 350–400 日），墙钟只作**安全上限**；
   记录 `simulatedDays` 与 `reachedHorizon`。这样每局机会相等，**机器负载不再改变测量**
   （只改变耗时）；未达上限的局必须**显式标注**，不得当作 0 结果。
2. **给 agent 用它的单位表达时钟**：现在只给 `secondsRemaining`（墙钟），
   而施工是**游戏时间/脚本 tick** 受限的 → 必须同时给 `gameDaysRemaining`。
3. **暂停必须被计量**：暂停时长与模拟时长分别记录，绝不让"停住的世界"冒充结果。

## 10.69 G1 落地：局以**模拟时间**结束（2026-09-18）

### 契约

| 项 | 规则 |
|---|---|
| 边界 | `--game-days N`：推进 **N 游戏日**后结束。`--demo-seconds S` **降级为墙钟安全上限**（防"死住的世界"挂住整轮） |
| 记录 | `GameMetric.simulatedDays` / `horizonDays` / `reachedHorizon` |
| 判定 | `reachedHorizon=false` 的局**排除并披露**（"hit the wall-clock cap before the horizon"）；无该字段的历史行披露为 "unknown opportunity"，**不假装等长** |
| 模型上下文 | `session.simulatedDays` + `session.gameDaysRemaining`（与 `secondsRemaining` 并列） |

### 实现要点（都是实测逼出来的）

1. `src/agent/episode.ts`：纯函数时钟（`simulatedDays`/`daysRemaining`/`reachedHorizon`/`stopReason`），
   对重复/回退的日期报告取高水位（GS 会重播状态）。
2. **过冲必须治**：边界若只在两次决策之间检查，一次决策（墙钟数十秒 ≈ 十几游戏日）
   就会整段冲出边界——实测 **horizon 40 → 记录 60**。两条修法并用：
   - 决策**进行中**每秒检查一次（`horizonWatch`），命中即 `requestStop()`；
   - **剩余天数不足一次决策（用上一次决策实测消耗的游戏日做余量）时不再提问**，空转到边界。
   修后实测：**horizon 60 → `simulatedDays=60`，过冲 0**，且整局只花 **113 s**（墙钟上限 600 s 未触发）。
3. **接口缺口**：`src/agent/loop.ts` 原先只把 `secondsRemaining` 转发给模型，
   新字段会在到达提示前被丢弃 → 已修 + 单测锁定（"墙钟秒不是规划施工的单位"）。

### 为什么这同时是"诚实"修复

那局推进 **0 游戏日**的运行，过去被记为 `deliveredRun=0`——与"agent 什么都没运"不可区分。
现在它是 `reachedHorizon=false` 的**被排除项**：**"世界停住了"不再冒充结果**。

## 10.70 G3 落地：车队请求的**静默无效**变成可观测的拒绝（2026-09-18）

### 缺陷

`CheckAddVehicles`（executor-ai）只对**当前 job** 应用 `V` 请求：
`if (job != this._job) continue;`——跳过时**一句话都不说**。
结果：agent 反复请求车队 10/15（同一 `count:15, job:1` 出现 **8 次**），
而 6 局里 5 局最终车队仍是 **6**。这违反本项目自己的铁律：
**"工具必须能观测自身效果或明确拒绝"**。

### 修法（三处，都在各自职责内）

1. **executor 说明拒绝**：跳过时置阶段 `fleet_otherjob j<k>`，并**去重**
   （同一 `job:want` 只报一次）。去重是必需的：阶段通道是**主进度信号**
   （`EX rd s0 r15 d115`），每 tick 重报会把路网进度淹没在一条常驻抱怨下。
2. **按线路记账**：`cur` 改为数"本 executor 为**当前 job** 克隆的车"
   （`_fleetOwned`），不再数全公司车辆——`want` 是**按线路**的语义，
   用全公司车辆计数会让一条线路的车队"满足"另一条线路的请求。
3. **解码器**：`fleet_otherjob` → 诚实描述（"请求针对的不是正在施工的线路，
   因此尚未应用"），并有单测锁定文案语义。

### 验证

- 单测：解码器 22 项全绿（含新案例）；Squirrel API 守卫 3 项全绿。
- **真机冒烟**（Squirrel 无法单测，语法错会让 GS 起不来）：`--game-days 25` 短局，
  `kind:"err"` **0** 次、阶段正常推进（`rd s0 r23 d70` → `hb road #9`）、
  `gsErrors=0`。

### 边界分辨率（诚实记录）

### 边界分辨率与时钟源（2026-09-18 修正，原写"≈3 日"时没核对订阅频率）

| 时钟源 | 粒度 | 用途 |
|---|---|---|
| GS state 的**原始日期**（每 200 tick ≈ **3 游戏日**）| 细 | **首选**：episode 边界、决策上下文、metric |
| admin 订阅的 `Date`（`DEFAULT_SUBSCRIBE` = **Monthly**）| **30 游戏日** | 回退（无 GS 时） |

实测：horizon 30 → `simulatedDays=32`；horizon 60 → 60；horizon 120 → 120。
**因此测量应使用 30 的整数倍 horizon**（300/360/…），误差即被吸收为 ±3 日（<1%）。

同一实现里发现并修掉的三处"声明了但没接线"（都是 D19 的同一模式）：
① `loop.ts` 只转发 `secondsRemaining`；② `cli/run.ts` 未把 `--game-days` 转发给 **v02** 路径；
③ v02 的时钟只读 `world.date`（Monthly，30 日粒度）→ 必须与 agent 路径一样优先用 GS 原始日期。

## 10.71 G2 落地：把"决定结局的那个过程"变成 agent 能看见的事实（2026-09-18）

### 事实来源（语义取自 Squirrel 源码，不取自字段名）

`executor-ai/main.nut:420,462` 的 `rd s<seg> r<step> d<dist> p<fails>`：
- `d` = `AIMap.DistanceManhattan(_roadCur, farStation)` = **还需铺多少格**（随推进下降）；
- `r` = 当前段内的**寻路搜索步数**（在动 ≠ 路在前进）。

因此"这条路来不来得及建好"是可算的：`吞吐 = Δ(剩余格数)/Δ游戏日`，`ETA = 剩余/吞吐`。

### 新增事实（`src/agent/executor-progress.ts`，纯函数 + 单测）

每局维护：`remainingTiles`、`tilesPerDay`、`etaDays`、`stalledDays`（**剩余格数多久没变**；
搜索在动不算推进）、`jobsSeen`；换 job 时重置（跨线路平均会**凭空造出吞吐**）。
经 hub（喂阶段与心跳）→ 决策上下文 `executor` 字段 → 模型；并在运行日志打印：

```
[agent] executor facts: job 1, 117 tiles to go, 0.67 tiles/game-day, ETA ~176 game days,
                        tiles-to-go unchanged for 30 game days, 1 job(s) seen
```

### 真机实测（/tmp/g2b，seed 7，horizon 150）

上例即真机输出：**157 格、0.67 格/游戏日 → ETA 176 游戏日**，而该局 horizon 只有 150 日
——**按当前速率这条线建不完**。这正是过去缺失、导致 agent 在一局内连下
68/110/161/239/271 格线路的事实（每一条都排在同一条 FIFO 后面）。

### 诚实边界

- `stalledDays` 只反映"**被上报的数字**多久没变"：不带距离的阶段（心跳、站点施工）
  不会刷新它，故它可能**偏陈旧**而非"executor 停了"——文案与注释都按此措辞。
- 无 `rd` 阶段时（未开工、或已转入运营）该字段**缺席**，不伪造 0（0 会被读成"路已完工"）。

## 10.72 S0 oracle 梯度：**杠杆存在，但会饱和**（2026-09-18）

### 方法（无 LLM，确定性 oracle）

`--v02 --add-vehicles N --game-days 600`（同种子 7、同 horizon、同一蓝图线路），
只改车队规模。探针**验证自身效果**（请求后被观测的车队数）：
请求 6/12/18 → 实测 **9/15/21**（蓝图自带 3 辆）。

| 请求 | 实测车队 | `deliveredRun` | **原始当季读数** | 每增一辆的边际交付 |
|---|---|---|---|---|
| 6 | 9 | **1088** | **0** | — |
| 12 | 15 | **1511** | 22 | **+70** |
| 18 | 21 | **1598** | 83 | **+15** |

### 结论

1. **任务有杠杆**：车队规模确实改变结果（9→21 辆：+47% 交付）。因此"管理决策"
   是**真实存在的决策空间**，S1/G4（预建场景）有依据。
2. **但杠杆在 15 辆附近饱和**（15→21 只 +6%，边际从 70 掉到 15 交付/车）：
   线路吞吐受**道路容量/乘客生成**限制，堆车不再有效。→ **实验的效应量必须落在
   陡峭区间（约 3–15 辆）**，否则"记忆有没有用"会被饱和抹平。
3. **旧判据再次被证伪**：三局的原始当季读数分别是 **0 / 22 / 83**，而积分量是
   **1088 / 1511 / 1598**。若沿用 §10.65 前的读数，S0 会得出"车队规模毫无影响"
   （甚至"没运货"）。这是"会重置的计数器不是测量值"（D14）的又一次实证。
4. 样本量诚实边界：**每格 1 局**，只能证明"方向与量级"，不能当作精确斜率；
   但三格的单调性与饱和形状已足以决定"设计该往哪走"。

### 对 S1/G4 的设计约束（由本结果推导）

- 预建场景的**起始车队定为 3 辆**（蓝图默认），使 3→15 的陡峭区间完全可用；
- `deliveredRun` 为主判据，`fleetRequested`/`fleetObservedAfterRequest`/`fleetProbeFired`
  一并记录（探针未发出 = 该局作废，不得当成"无差异"）；
- 若最终 A/B 的效应落在饱和区，必须**先改任务参数**（更长的运营窗 / 不同货物 /
  多线路）再谈结论。

## 10.73 S1/G4 落地：预建场景（施工移出测量窗）（2026-09-18）

### 契约

`--scenario prebuilt`：开局时用**确定性蓝图**（复用 v02 的 `job=101`）建好一条线路，
**等到可运营**（≥2 站 + ≥1 车辆）才算"测量窗打开"，此后所有决策都是**管理决策**。
`metrics.jsonl` 记录 `scenario` / `scenarioReason` / `deliveredAtReady`。

- `scenarioReason`: `ready` | `timeout` | `order_refused`；
- **未就绪的局在判定中排除并披露**（"whose prebuilt scenario never became ready"）——
  场景没建好的一局**不是**一次关于管理决策的测量（G4）。
- 场景来源（`src/agent/prebuilt.ts`，5 项单测）：等就绪有墙钟上限（默认 20 min），
  超时/被拒不假装成功。

### 真机验证（/tmp/pb1，seed 7，horizon 120）

```
[agent] prebuilt: blueprint sent; waiting for an operable route…
[agent] prebuilt: ready after 331 sample(s) (stations=2, vehicles=2)
记录: scenario=prebuilt, scenarioReason=ready, deliveredAtReady=0,
      deliveredRun=18, simulatedDays=122, reachedHorizon=true, decisions=6
```

即：施工占用 ~5.5 min **但不计入测量窗**；测量窗内 agent 做了 6 次决策并把车队
扩到 3 辆、站点扩到 4 个（**管理动作**），这正是 N2 想要的决策空间。

### 为什么这样设计（由 S0/S0b 推出，不是猜）

`§10.72`：车队规模是真杠杆但**在 3–15 辆区间陡峭、15 辆后饱和**；
自由局里结局主要由"executor 有没有把路建完"决定（同车队下 0–527 的散布）。
→ 把施工移出测量窗后，两臂面对的是**同一类机会**（管理），效应量落进陡峭区，
且单局墙钟下降（预建后只需较短的 horizon）。

## 10.74 与 pi-agent-core 的协同设计（ADR，2026-09-18）

### 背景

`@earendil-works/pi-agent-core@0.85.1` 提供的不只是"跑一轮对话"：它管**消息类型、
上下文变换、工具校验与执行顺序、provider 缓存、转向/追加队列、优雅停止**。
harness 应把**agent 侧机制**交给库，把**领域侧（事实/协议/测量）**留给自己；
两边重复实现的地方是 bug 与漂移的来源。

### 现状审计（事实）

| 库机制 | 本项目现状 | 结论 |
|---|---|---|
| `beforeToolCall` / `afterToolCall` | ✅ 已用（未知工具拦截；动作结果回流台账）| 保持 |
| `transformContext` | ✅ 已用（剪枝 + 记忆注入）| 保持；P3 改为类型化消息 |
| `convertToLlm` | ✅ 已用（丢弃 UI-only 角色）| 自定义角色目前靠 `as never` 强转，应改**声明合并**使其有类型 |
| **工具执行顺序** | ✅ **已修（R1）**：变更型工具声明 `executionMode:"sequential"` | 领域不变量已由代码保证；实测批次顺序 `start,end,start,end` |
| `sessionId`（provider 缓存）| ✅ 已设（R1）= session id | ⚠️ **收益未测量**：设之前就有 37–44% 缓存命中（§10.75），所以"设 sessionId 才省缓存"这个猜测被证伪，收益记为未测 |
| `thinkingLevel` / `thinkingBudgets` | ✅ 已接线（R1），默认 `"off"` | ⚠️ `off`-vs-`low` 的质量/成本权衡**未测量**（单局曾出现 1.48M token、193 次工具调用，D16） |
| `steer()` / 追加队列 | ❌ 未用 | 长决策期间世界在变；事件唤醒之外，可中途告知事实（可选） |
| `shouldStopAfterTurn` | ❌ 未用 | 优雅停止/压缩点；当前由自建循环的 episode 时钟负责（§10.69），暂不需要 |
| `/harness/session`（会话后端）| ❌ 未用（自建 SessionStore + JSONL）| 自建件承载**领域**记录（metrics/audit/savegame），保留；不引入后端直到有实测需求 |

### 决策（ADR）

1. **领域不变量优先于库默认值**：凡"工具执行顺序 = 游戏应用顺序"这类不变量，
   必须在工具上显式声明执行模式（变更型工具 sequential）。库的默认值不是契约。
2. **库的钩子就是 guard 的落点**：`beforeToolCall` 返回 `{block, reason}` 与
   `execute()` 抛错都会**以工具错误的形式回到模型**，因此"拒绝 + 理由"应当写在这里，
   而不是在事后的字符串过滤里（§10.22 的边界守卫要能被模型看见并纠正）。
3. **记忆的呈现要用类型化消息**：声明合并 `CustomAgentMessages`，让"上一局成绩"
   成为一等消息类型（可裁剪、可刷新、可测试），而不是拼进 user 文本。
4. **记忆的读取权交给 agent**：长期经验以 **`recall` 工具**暴露（按需检索），
   只在上下文里保留一行"存在性事实"（有多少条、来自几局）。理由：
   ① 上下文成本（token 是已知瓶颈）；② 检索相关性由 agent 决定，符合 §10.22
   "harness 给记录，agent 决定含义"；③ **可测**——`recall` 调用次数第一次让我们
   能回答"记忆到底有没有被用过"。
5. **不重复实现库已有的机制**：会话后端、压缩、转向队列只有在实测显示必要时才引入；
   引入前先在 SPEC 记录理由。

### 由本 ADR 推导的后续工作（阶段划分见 `ROADMAP.md` 的 R 系列）

R1 执行顺序与成本旋钮 · R2 经验作为**被校验的记录**（反思用工具写库、内容级守卫、
可被推翻）· R3 自我评估（类型化消息）· R4 `recall` 检索工具 · R5 学习曲线实验 ·
R6 目标与判据一致 + 动作面扩展。

## 10.75 R1 实施结果：执行顺序 / 工具预算 / 缓存与**披露路径**（2026-09-18）

ADR 见 §10.74。本节是**实测事实**（真机 `/tmp/r1smoke`，`--n 1 --scenario prebuilt --game-days 30`）。

### 1. 工具执行顺序：默认 `parallel` 是真实缺陷（已修）

pi-agent-core 的默认执行模式是 `parallel`，而游戏按 **FIFO** 应用命令（§10.39.1）。
同一条助手消息里的两个变更命令因此会**重叠执行**。实测 trace（单测内的时序探针）：

```
修复前: start:pause, start:unpause, end:pause, end:unpause   ← 第二条在第一条结束前开始
修复后: start:pause, end:pause, start:unpause, end:unpause
```

`build_bus_route` / `add_vehicles` / `set_pause` 现声明 `executionMode:"sequential"`
（只读工具不变）。测试锁顺序 AND 声明，两者缺一不可。

### 2. 每决策工具预算（已修，且**可观测**）

实测：正常决策 2–3 次工具调用；有一局 **193 次 / 17.5 次每决策**（烧掉该臂 82% tokens）。
预算默认 **12 次/决策**，在 `beforeToolCall` 里 block 并把理由交回模型
（库会把 blocked 结果作为工具错误回给模型，所以它能改用已有观察作答）。
被拒绝的次数记入 `GameMetric.toolBudgetBlocks`，并在**两个 verdict**里打印
（`tool budget (refusals/run)`）。

真机冒烟（horizon 30）：两局均 `toolBudgetBlocks=0`，工具调用 4.5 次/决策
→ 12 这个上限不会误伤正常工作。

### 3. `sessionId`：**我原先的假设错了**

ADR 里我写"未设 sessionId → 无 provider 缓存"。实测**缓存本来就发生了**：

| 目录（R1 之前） | cacheRead / totalTokens | 命中率 |
|---|---|---|
| `/tmp/pbcal` | 664,145 / 1,501,457 | 44.2% |
| `/tmp/cal2` | 834,374 / 2,252,694 | 37.0% |
| `/tmp/ab900` | 963,687 / 2,288,005 | 42.1% |

`sessionId` 现在显式设置（语义更正确、对缓存键敏感的后端友好），但
**冒烟局只有 2 次决策（76.9% 命中），不足以支持任何"提升"主张** → 记为**未测量**。

### 4. deliberation 旋钮：已接线，**未测量**

`thinkingLevel` / `thinkingBudgets` 现在是 `createAgent` 的参数，默认 `"off"`
（= R1 之前的行为，测量口径不变）。"off vs low" 的对比**尚未运行**，不得当作结论。

### 5. 披露路径缺陷：`channel health` 从未真正出现过（已修）

§10.66 声称"verdict 在任何收益主张之前打印通道健康"。事实核查：

```
grep -rh "channel health" /tmp/*.log       → 0 处
```

两个原因叠加：① 打印它的 `m3-verdict.ts` **不在跑实验的那条路径上**
（`run-experiment.ts` 有自己的摘要，且当年就没有这一行）；② 即使跑了也永远显示
`not reported` —— 它把 `ArmSummary` 对象当账本行取 `gsErrors`，取到 undefined 被过滤掉。

现在聚合只有一处实现（`metricStat` / `degradationStats`，`src/evolution/metrics.ts`），
两个 verdict 都打印，并已实测**真的取到数**（`n=2 max=0 total=0`）。**缺报仍报 `not reported`，不是 0。**

## 10.76 R2 实施结果：经验 = 带实测读数的观察（2026-09-18）

ADR 见 §10.74。R2 的目标是修掉对齐检查里最伤的一条：**注入的其实是策略**。

### 1. 契约换代：`kind: do|dont` → `outcome: {metric, before, after}`

旧契约把经验塑造成**指令**（`kind:"do"` → 注入成 `DO: …`）。现在一条经验必须是
**对已发生事实的陈述 + 它所依据的实测读数**（`LessonOutcome`），注入格式从

```
Previously an action like this paid off: <text>        ← 还替模型断言了从未验证的因果
```
改为

```
Recorded in an earlier game: <text> [delivered 420 -> 1088, seed 7]
```

缺读数写 `—`（前端）/ 直接拒收（入库），**不印 0**。

### 2. 内容级守卫（MEMORY D26 的修复）

`isImperative(text)` 是启发式，判"这是不是在对模型下指令"。**必须作用在内容上**：
旧守卫断言注入行 `^DO\b`，而注入行以 `Previously …` 开头 → 那条正则永远不可能匹配，
真机库里 12 条有 10 条、27 条有 15 条祈使句全部通过。

**召回率用真库实测**（53 条旧条目，来自 `/tmp/{pbcal,ab900,cal2,r1smoke}`）：

| 版本 | 判为指令 | 占比 |
|---|---|---|
| 初版动词表 | 19 / 53 | 36% |
| 按真机措辞扩充后（plan / front-load / defer / order / cluster / chain …）| **32 / 53** | **60%** |

**必须诚实说明**：这条守卫只是**第二道闸**，召回率 60%，其余靠**结构性要求**
（没有 `outcome` 就不算经验）拦下。因此不能把"内容守卫"当作边界的主要保证。

### 3. 迁移：读取时排除 + **计数可见**，不改写磁盘

真机四库共 53 条旧条目，**0 条**满足新契约（全都没有实测读数）→ 读取时排除。
没有重写文件（那是用户数据），而是 `readLessonsReport()` 给出 `legacyDropped`
并在开局打一行说明。静默过滤正是让"这局带了记忆"变假的方式。

### 4. 经验可以被推翻（`supersededBy` 第一次真的被赋值）

`supersededBy` 从 Phase C 起就在类型里、`selectLessons` 也一直按它过滤，
**但全项目没有一处给它赋值** → 记忆只增不减。现在：反思输入带上现库
（id + 文本，上限 24 条），模型可用 `supersedes:[id]` 声明取代；落盘时
`applySupersessions` 把 `supersededBy` 写给被取代者。

**实现中发现的两个真问题**：
1. 作废以**追加同 id 记录**表达，而两者 confidence/createdAt 完全相同 ——
   `dedupeLessons` 原本按"更可信/更新"择优，**先到的原条会赢，作废被静默丢弃**。
   现在规则是：**作废优先于一切**（一条被标记作废的记录是关于这条经验的最新事实）。
2. `isLesson` 原本只查 `id + text`，会让旧祈使句继续当作"经验"载入（"库里有几条经验"
   这个数字因此是假的）→ 收紧为"必须带合法 `outcome`"。

### 5. 尚未完成（不得声称）

**R2b：反思改为走 pi-agent-core 的 Agent + `record_lesson` 工具**（schema 校验 +
拒绝理由作为工具错误回到模型，让它改写成观察句）。当前反思仍是"文本补全 + JSON 解析"，
守卫是**事后**生效（拒收但不告诉模型），因此**模型没有机会自我纠正**。
这一半属于 R2 的剩余工作。

## 10.77 R2b 实施结果：反思改走 Agent + 记录工具（2026-09-18/19）

### 1. 机制

反思不再是"文本补全 + JSON 解析"，而是**同一个 pi-agent-core `Agent` + 两个工具**：

| 工具 | 参数（schema 校验） | 拒绝条件（`execute` 抛错） |
|---|---|---|
| `record_lesson` | `text, outcome{metric,before,after}, evidence[], confidence?, supersedes?` | 建议/祈使句、缺 `outcome`、缺证据、缺来源 |
| `record_strategy` | `action, params?, value, evidence[]` | 无 action、`value` 非有限数、缺证据 |

抛错会把**理由作为工具结果交回模型**（pi-agent-core 的契约），模型下一轮可以改写重试
——这是解析 JSON 做不到的（旧路上拒绝是静默的）。校验的唯一实现在
`lessons.ts:validateLesson`（与工具共用），旧的 `parseReflection` /
`reflectToLessons` / `reflectToStrategies` **已删除**（两条并存的契约是漂移源）。

provider 失败在库里是**状态**而非异常：要读 `agent.state.errorMessage`，
否则一次网络故障会伪装成"这局没什么可记录的"。

### 2. 真机事故：提示词与运行时是**同一份契约的两半**

改成工具后第一次真机跑（`/tmp/r2smoke`，2 局）：**两局都 `0 lesson(s) kept`
且 0 次拒绝**。根因不在模型：**提示词仍在要求 `Reply with JSON only`**，
模型于是老实回 JSON、一个工具都不调。而 `lessonsSaved: 0` 在日志里与
"这局确实没什么可学"**完全一样**——静默失败（与 MEMORY D26/D28 同类）。

**修复**（三件，缺一不可）：
1. 提示词改为**说明工具用法**（并去掉 JSON schema）；
2. **契约交叉守卫**测试：提示词里点名的每个 `record_*` 工具必须真实存在、
   不得再出现 "reply with JSON"、必须说明"被拒会给出理由"；
3. **可观测性**：报告里新增 `toolCalls`，当模型**一次都没调用记录工具**时打印
   `reflection WARNING: … this is NOT the same as 'nothing to record'`。

### 3. 修复后的真机复验（`/tmp/r2b2`，1 臂 1 局）

| 指标 | control | treatment |
|---|---|---|
| 落盘观察 | **2 条**（各带实测读数） | 0 |
| 注入 | — | `lessonsInjected: 2`, `routeFactsInjected: 2` |
| 反思工具调用 | >0（无警告） | **0（警告触发）** |
| `gsErrors` / `toolBudgetBlocks` | 0 / 0 | 0 / 0 |

落盘的观察（对比旧的祈使句 "Build a single bus route first"）：

```
- Route job 102 (towns 10->0) was ordered at decision 1 but no completion was recorded before …
  outcome {metric:"construction", before:0, after:1}
- Two routes were ordered across two decisions in 32 game days, leaving one route (job 102) …
  outcome {metric:"construction", before:0, after:2}
```

### 4. 未决（不得声称）

同一配置下 **1/2 局的模型一次都没调用记录工具**（警告已如实打出）。
成因未定（模型选择？提示词强度？），因此**反思的产出率本身是一个待测对象**，
不是"已解决"。可能的下一步：把"0 调用"视为反思失败并重试一次，或在提示词里
要求"至少尝试一次"。

## 10.78 M1：反思产出率变成可诊断、可重试、可披露的事实（2026-09-19）

### 1. 为什么先做"可诊断"

R2b 修好后，同配置下仍观察到"某局 0 条 lesson"。当时能查到的唯一记录是
`0 lesson(s) kept` ——**看不出模型到底说了什么**，于是只能猜（恰好是本项目最忌讳的做法）。
反思 Agent 的消息当时没有任何落点。

**修法**：`ReflectionReport` 增加 `toolNames` / `retries` / `replyPreview`
（单行、**上限 300 字符含省略号**），并把整条反思记录写进**会话审计**：

```
audit.jsonl: {type:"reflection", ok, error, lessonsSaved, lessonsSuperseded,
              strategiesPromoted, toolCalls, toolNames, retries, rejections, replyPreview}
```

审计是权威（console 只在 `/tmp` 里，会丢），并且 `/tmp` 与审计的区别正是 D28 的教训：
**证据要落在不会消失的介质里、并在产出判决的那条路径上被打印**。

### 2. 有界重试：让"如实记录"比"编造"更容易

模型一次记录工具都没调用时，再问一次（`agent.prompt()` 续问，用库自己的 API）。
重试消息的关键设计：它列出 **harness 已知的事实**（这一局记录了什么：下单、完成、
车队、运量），并明确写"若读完仍然无可支撑的观察就什么都不要记"。
→ 提供的是**证据**而不是压力：编造比如实更费力。
**上限 1 次**（`MAX_REFLECTION_ATTEMPTS = 2`），且次数进报告与审计。

### 3. 真机结果（`/tmp/m1a` 2 局 + `/tmp/m1b` 4 局，`--scenario prebuilt --game-days 30`）

| 局 | toolCalls | retries | observations | superseded | ok |
|---|---|---|---|---|---|
| m1a-ctl | 3 | 0 | 3 | 0 | ✅ |
| m1a-trt | 3 | 0 | 2 | 0 | ✅ |
| m1b-ctl1 | 4 | 0 | 4 | 0 | ✅ |
| m1b-trt1 | 2 | 0 | 2 | **1** | ✅ |
| m1b-ctl2 | 3 | 0 | 3 | **2** | ✅ |
| m1b-trt2 | 0 | 0 | 0 | 0 | ❌ provider 失败 |

- **反思现在稳定产出**：7 局成功反思里 6 局有观察入库（1–4 条/局）。
- **`supersedes` 首次在真机生效**（两局分别作废 1 与 2 条旧观察 → `supersededBy` 真的被写）。
- **重试机制未被真机触发**（0/7）：修复提示词后，"成功但一个工具都没调用"只见过一次
  （`/tmp/r2b2` trt，早于重试实现）。→ **重试目前只有单测覆盖，真机效果未验证**，不得声称。

### 4. 我自己在这一步踩的坑（已修）

第一次跑完 `/tmp/m1b`，verdict 打出
`zero-tool-call runs 1` 并警告"协议/接线信号"——而那一局其实是 **provider 失败**
（`ok:false, toolCalls:0`）。**两个成因被混在一起，基础设施故障被读成提示词问题。**

修法：`reflectionStats` 只把 `ok !== false` 且 `toolCalls === 0` 记为协议信号，
另外单列 `failedRuns` / `firstError`，两个 verdict 分别打印各自的 WARNING。
审计同时记录 `error` —— 失败本身也要可诊断。

### 5. 反思统计的来源与边界

新增 `src/evolution/reflection-stats.ts`（纯读 + 聚合，缺报返回 `null` 而非 0）。
它**不读 metrics.jsonl**：反思发生在 `session.finalize()` 之后（metric 行已写完），
所以 `reflectionRetries` 这类字段**不可能**出现在 metric 行里——
硬塞只会得到一个永远 `undefined` 的字段（D19/D22 的经典形态）。

## 10.79 M2：把计分规则作为事实写进提示词（2026-09-19）

### 改了什么

`SYSTEM_PROMPT` 的目标句从

```
Objective: build profitable transport routes and grow the company.
```

改为

```
Objective: operate and grow a transport company.

How this project scores a run (a fact about the environment, not advice):
- A run is scored by the cargo delivered per game day, measured over a fixed number
  of game days (the horizon stated in the decision context).
- Accounting note: building spends cash up front and loans accrue interest, so a
  company's income is normally negative while routes are being built - a negative
  year-to-date income does not by itself mean the routes are not working.
```

**为什么这是事实而不是策略**：它描述"本项目如何评分"（环境的一部分，agent 有权知道）
与一条会计事实；它**没有**说该怎么玩。既有守卫 `assertNoStrategy` 仍然全绿。

**为什么必须改**：实验判据是 `deliveredRun`，而提示词要求"profitable"。
实测 106 局里 `income>0` 的仅 **9 局**（施工期年为负）——**目标通常不可达**，
agent 在为一件做不到的事优化，而"它为什么优化"与"我们量什么"不匹配（MEMORY D25 同源）。

### 真机观察（`/tmp/m2a`，`--scenario prebuilt --game-days 30`，n=1/臂）

| 臂 | 决策 | 工具调用 | 工具分布 | 车辆 | deliveredRun |
|---|---|---|---|---|---|
| control（`--no-memory`）| 2 | 6 | observe 6 / inspect_route 6 / set_pause 2 / **add_vehicles 3** | 13 | **0** |
| treatment | 5 | 11 | （同上）| **32** | **0** |

**只陈述观察，不做因果断言**：车队规模明显上升（13 / 32，S0 证明的饱和点约 15），
但两局 `deliveredRun` 仍为 0——30 游戏日的窗口里，预建线路的施工占满了窗口，
车辆来不及产生运量。**这是窗口问题，不是提示词效果的证据**；
要判定 M2 是否改变了行为/结果，需要 horizon ≥300 的对照（尚未做）。

### 兼容性代价（必须记住）

提示词是**全局**改动：**2026-09-19 之前与之后的行为指标不可直接比较**
（工具分布、决策数、车队规模都可能被这条事实改变）。跨日期比较必须在文档中说明。

## 10.80 M3 能力盘点：环境到底允许 agent 做哪些动作（2026-09-19）

**为什么盘点先于写代码**：判断"agent 能不能玩"要沿**环境暴露了多少动作**这条链查，
四层（环境命令 → 工具 → 工具能否观测效果 → 决策次数）里任何一层是瓶颈，
优化其它层都不会让它变成可能（MEMORY D32）。本节是**事实**，不是计划。

### 第 1 层：Admin/GS 命令面（`bridge-gs/main.nut` 的 `Dispatch`）

| 命令 | 作用 | 变更世界？ | 已包成工具？ |
|---|---|---|---|
| `ping` / `status` | 存活与自检 | ❌ | — |
| `blueprint` | 放一份线路蓝图（标牌集合）| ✅ | ✅ `build_bus_route` |
| `add_vehicles` | 放 `V:<count>` 车队标牌 | ✅ | ✅ `add_vehicles` |
| `demo` | v0.2 演示（无参数）| ✅ | — |
| `clear` | 删除所有 `NUTZ:` 标牌 | ✅ | — |

### 第 2 层：执行器标牌协议（GS 放、Executor AI 读）

| 标牌 | 含义 |
|---|---|
| `NUTZ:bp:<job>:S:fr=<front>:eg=<engine>` | A 站 |
| `NUTZ:bp:<job>:E:fr=<front>` | B 站 |
| `NUTZ:bp:<job>:D:fr=<front>` | 车库 |
| `NUTZ:bp:<job>:W:<i>` | 路径点 |
| `NUTZ:bp:<job>:V:<count>` | **车队规模** |

**关键事实（源码确证，`executor-ai/main.nut:CheckAddVehicles`）**：

1. `V:<count>` **本身是双向的**：`cur < want` → `CloneVehicle`（克隆头车）扩容；
   `cur > want` → **卖车**（"newest first; never the lead vehicle"）并置相位 `fleet<cur>`。
2. **下限是 1**：头车永不被卖，所以"退役整条线路"**做不到**。
3. `V` 的 count `< 1` 被当作**没有请求**（`if (want < 1) { … return; }`）——不是"全部卖掉"。
4. 车队请求**只对当前 job 生效**；对别的 job 的请求会明确回一句 `fleet_otherjob j<k>`（G3 修的就是这个沉默跳过）。

### 结论（对 M3 的直接含义）

- **最便宜的真扩展不是写新 Squirrel，而是把一个已存在的能力正名暴露**：
  执行器早就支持**缩编**，而工具叫 `add_vehicles`、契约只讲扩容 →
  **能力存在、却不是 agent 能想到去用的动作**（"名字即契约"，名字说加就只能加）。
- 想再往上（整条线路退役、换车、选货、其他运输方式）**都需要新的执行器能力**，
  不是包一层工具就能得到——那是更大的增量，要单独设计与真机验证。

## 10.81 M3-1 真机结果：车队杠杆**被阶段门控**（探针证伪源码推断，2026-09-19）

### 我原本的推断（错的）

读 `executor-ai/main.nut:CheckAddVehicles` 后我写下：`V:<count>` **本来就双向**，
所以"缩编"这个能力一直存在、只是没被正名暴露（SPEC §10.80）。据此把工具改名为
`set_route_vehicles`、契约写清双向语义与"下限 1 / 0 不是退役"。

### 探针（`--v02 --add-vehicles 12 --shrink-to 4 --game-days 300`，`/tmp/m31`）

```
[v02] S4 live route: vehicles=3 stations=2
[v02] baseline probe: requested 12, observed fleet 3 -> 15        ← 扩容成功（相位 EX fleet12 j101）
[v02] shrink probe: requesting 4 vehicles on job=101 (fleet is 15)
[v02] shrink probe: requested 4, observed fleet DID NOT shrink (still 15)   ← 缩编没有发生
...
[v02] RESULT: executorPhase="EX @66,99 road d69 j101"   deliveredCargo=248
```

缩编请求之后再未出现任何 `fleet` 相位，`route-stats.vehicles` 全程停在 **32**，
结局时执行器仍在**修路**（`road d69`）。

### 根因：调用点有守卫

```squirrel
} else if (this._stage == "done" && this._vehicle >= 0) {
    this.CheckAddVehicles();      // ← 只在 done 阶段被调用（executor-ai/main.nut:115）
```

**车队请求只在执行器不施工时被读**，因此：

1. 请求是**被推迟**，不是被丢弃（标牌留在邮箱里）；
2. 但在有活可干的一局里，执行器**大部分时间不在 `done`**——本局它在缩编请求之后
   再没回到过 `done`，请求等于**永不生效**；
3. 这给 **D20** 补上结构性解释：当年 agent 把同一个 `count:15` 重发 **8 次**、车队始终 6
   ——原因不只是"沉默的跳过"，还包括"请求根本没被读到"。

### 我的探针本身也错过一次

第一版探针发完只等 60 秒 → 差一点把结论写成"环境不支持缩编"。
正确的探针必须**先等到执行器 `done` 再发**（已改成：等 `done` 再发、最长 300 s）。
**教训（D34）**：源码里存在一个分支 ≠ 它在**可达状态**下会被调用——
读完分支还要读**调用点的守卫**。

### 对 M3 的影响（诚实结论）

- 工具改名与契约（双向、下限 1、`0` 不是退役）**是改进**，保留；
- 工具现在**回报当前执行器阶段**（事实）：否则模型只能看到"请求了、什么都没变"，
  会学到"请求车队没用"这种错误因果（D20 同源）；
- 但**"车队规模"目前不是一个可靠可用的动作**：`M3-1b` 需要改执行器
  （把最新的 `V:` 请求锁存并在阶段允许时尽快应用，或把车队管理从阶段机里挪出来），
  改完仍要用同一条探针在真机上证明**扩容与缩编都真的发生**。

## 10.82 第一性原理复检：能力面、空缺与协同结论（2026-09-19）

> 触发：项目所有者问"当前 harness 还缺什么？能否自主玩 + 自进化？机制是否完善？
> 是否充分用了 pi-agent-core？还需要哪些协同（CoDesign）工作？"
> 本节是**用实际安装产物核对**后的答案（不是凭印象）。

### A. 库的能力面（`@earendil-works/pi-agent-core@0.85.1`，据 `dist/*.d.ts` 导出表）

根入口 `.` 导出**远不止 `Agent`**：

| 族 | 导出（节选） | 我们 |
|---|---|---|
| Agent 核心 | `Agent`、`AgentOptions`、`AgentTool` | ✅ 用了 `Agent` |
| **完整 harness** | `AgentHarness`（`prompt`/`skill`/`promptFromTemplate`/`compact`/`drive`/`lane(s)`/`steer`/`followUp`/`nextRun`/`setActiveTools`/`setModel`/`setThinkingLevel`/`appendMessage`/`appendCustomEntry`/`findEntries`/`navigateTree`/`resume`/`getResult`/`recordUsage`/`waitForIdle`） | ❌ **完全未用** |
| **会话后端** | `./harness/session`：`JsonlSessionRepo`、`MemorySessionRepo`、`MemoryStorage`、`fork`/`commit`/`mutation-line`、类型化 `values`（`getValue`/`scanValues`/`readList`）、`scanEntries`/`scanBranch`/`scanUsage` | ❌ 未用（自建 `SessionStore` + JSONL） |
| **压缩** | `compact`、`compactWithRequest`、`prepareCompaction`、`shouldCompact`、`estimateContextTokens`、`estimateTokens`、`getLastAssistantUsage`、`DEFAULT_COMPACTION_SETTINGS`（`reserveTokens:16384`、`keepRecentTokens:20000`）、分支摘要 `generateBranchSummary` | ❌ **未用** |
| 技能/模板 | `Skill`、`PromptTemplate`（`./harness/skills`、`./harness/prompt-templates`） | ❌ 未用（提示词硬编码在 `runtime.ts`） |
| 工具集 | `./harness/tools`（读写/搜索/执行等内置工具） | ❌ 未用（领域工具自己写，**应当如此**：agent 不该能读写宿主文件） |
| 遥测 | `AGENT_TELEMETRY_SCHEMAS`、`defineTelemetrySchema`、`startAiSpan`/`startHarnessSpan`、`createTypedSpanStarter` | ❌ 未用（自建 `Telemetry`/audit/metrics） |
| 执行环境 | `./harness/env/nodejs`：`NodeExecutionEnv`、`Shell`、`FileSystem` | ❌ 未用（同上：环境越界风险） |
| 其他 | `./proxy`、`./search`、`setDefaultStreamFn`、`reduceLaneSnapshot` | ❌ 未用 |

**`AgentOptions` 逐项**：已用 `initialState`/`streamFn`/`convertToLlm`/`transformContext`/
`beforeToolCall`/`afterToolCall`/`thinkingLevel`/`thinkingBudgets`/`sessionId`；
**未用** `followUpMode`/`steeringMode`/`getApiKey`/`maxRetryDelayMs`/`onPayload`/`onResponse`/
`prepareNextTurn(WithContext)`/`shouldStopAfterTurn`/`toolExecution`/`transport`。

**`Agent` 实例方法**：只用 `prompt`/`state`/`subscribe`；未用 `steer`/`followUp`/`continue`/
`abort`/`reset`/`waitForIdle`/`hasQueuedMessages`/`signal` 及各队列清理。

### B. 四个问题的答案（证据）

**① 能自主玩一局吗？→ 能，但"玩法上限"被环境卡住。**
无人值守可跑完整局（100+ 局；`llm.kind=real`、`mode=agent`、触发器 `start/event/phase_change/wait_until`），
但动作面只有 6 个工具、其中变更型 3 个（`build_bus_route`/`set_route_vehicles`/`set_pause`），
而**车队杠杆被阶段门控**（§10.81），所以**可靠的运营动作实际只有 1–2 个**，
每 ~300 游戏日只有 **10–16 次**有后果的决策。结论同 **D32**：瓶颈在环境暴露的动作数。

**② 能自进化吗？→ 闭环存在，但缺"选择压力"。**
记录（反思 + 工具 + 审计）✅ · 存储（类型化、可推翻）✅ · 注入（记录式、非建议）✅ ·
推翻（`supersededBy` 已在真机生效）✅ · 归因（决策→结果台账）✅。
**但**：没有任何一环**按结果淘汰经验**——作废只来自模型自己的判断；
且"经验是否让成绩变好"**从未被验证**（A/B 因 CV 0.57–0.79 被推迟）。
所以现在准确说法是：**反思式自进化，而非结果式**。

**③ 机制完善吗？→ 测量链接近完备（G1–G6），有两处真空缺。**
- **上下文的峰值从未被记录**（此前只有累计 token）。1.48M token 单局（D16）+ 我们的剪枝
  是"最近 40 条消息、丢弃而非摘要" ⇒ **无法回答"离模型上下文窗口还有多远"**，
  也就无法判断是否需要压缩。→ **本次补 G6**（下面 §10.83）。
- **没有检索**：经验只按类别整体注入，agent 无法按需取用（M4 的 `recall`）。

**④ 充分用了库吗？→ 否，但是"有理由的未用"与"无理由的未用"混在一起了。**
- **应当未用**：内置工具、`NodeExecutionEnv`（文件/shell 越界——本项目铁律是 agent 不碰宿主）、
  execution env 类能力。
- **无理由未用（真缺口）**：`estimateContextTokens`/`shouldCompact`（判断与压缩）、
  `findEntries`/类型化会话值（检索底座）、`shouldStopAfterTurn`/`prepareNextTurn`（官方循环钩子）。
- **已用但方式可以更好**：`steeringMode`/`followUpMode` 未设（用默认），`abort`/`waitForIdle` 未用。

### C. 由本次复检得出的决策规则（写下来，避免每轮重猜）

1. **引入库机制的门槛是"实测暴露的问题"**，不是"库里有"。压缩与检索先量化（G6），
   再决定是否引入（ADR §10.74 已规定"引入前先在 SPEC 记理由"）。
2. **不引入会扩大 agent 权限的库能力**（文件/ shell / 执行环境）——那是领域边界，不是缺功能。
3. **能力审计必须对着安装产物（`.d.ts` 导出表）做**。§10.74 的审计把整个
   `harness/session` 压成一行"暂不引入"，于是**压缩、可查询历史、类型化会话值**
   三块能力被一起漏掉——这正是 §10.74 需要修订的原因（本轮已修其过时行）。

## 10.83 G6 实测：单次请求峰值 5–7k tokens ⇒ **不需要上下文压缩**（2026-09-19）

**方法**：`scripts/run-experiment.ts --dir /tmp/g6 --n 1 --scenario prebuilt --game-days 30 --seed 7`
（两臂各一局，真机、真实 provider）。

```
channel health: GS errors/run n=2 max=0 total=0  tool budget refusals/run n=2 max=0 total=0
                 peak request tokens: n=2 max=7324 total=12512
reflection: 2 run(s) recorded (0 failed), zero-tool-call runs 0, retried 0
            tool calls/run n=2 max=3 total=5   observations/run n=2 max=3 total=5
```

| 臂 | 决策 | 工具调用 | 单次请求峰值 | 峰值所在 turn | 累计 tokens | 模拟天数 |
|---|---|---|---|---|---|---|
| control | 2 | 9 | **5 188** | 6 | 24 802 | 31 |
| treatment | 3 | 9 | **7 324** | 9 | 44 808 | 32 |

**结论（可执行的决策）**：

1. **不需要引入上下文压缩。** 单次请求峰值 ~5–7k tokens，而所用模型的上下文窗口在
   10 万量级（>10×余量）；我们的剪枝（最近 40 条消息）在这个规模下**从未生效**。
   按 §10.74 的规定，这条"实测不需要"的结论要**写下来**，避免下一轮重新怀疑。
2. **D16 的"148 万 token 单局"是累计量，不是峰值**——它来自一次失控的决策
   （193 次工具调用），而 R1 的**每决策工具预算**（12）已经封住这个失效模式；
   本局 9 次调用/局、**0 次封顶拒绝**。
3. **披露路径已证明能收到数据**（D28）：这是它第一次在有新字段的真实数据上运行，
   两臂都有数字；旧数据仍显示 `not reported`（未测量 ≠ 0）。
4. **仍未测量的边界**：horizon 更长的局（300+ 游戏日、更多决策）峰值会不会显著更高？
   本局只有 2–3 次决策。**若做 M5 学习曲线（长局）**，届时用同一字段复核一次即可——
   这正是把它做成**每次运行都记录**的字段（而不是一次性探针）的原因。

## 10.84 M3-1b：车队杠杆真正的两处缺陷，与"缩编必须先进车库"（2026-09-19）

### 缺陷 1：`foreach` 在 array 上是 (下标, 值)，结算代码把它当成了 (值, 忽略)

Squirrel 语法（参考手册，2026-09-19 核对）：
`'foreach' '(' [index_id ','] value_id 'in' exp ')' stat` —— **双变量的第一个是下标**。

`_fleetOwned` 是普通 array（`[]` + `.append()`），却写成
`foreach (v, _ in this._fleetOwned)` 并把 `v` 当车辆 id 用。后果：

1. **计数错**：`AIVehicle.IsValidVehicle(v)` 数的是"id 等于 0..N-1 的车是否存在"；
2. **卖错车**：`SellVehicle(v)` 卖的是**与这条线路无关的 id**；
3. **守卫失效**：`if (v == this._vehicle)` 比较的是**下标与车辆 id**，
   于是"永不卖头车"这条守卫**从未生效过**。

真机表现：请求 12 → 车队 3 → **14**（是"克隆 11 辆到 12 辆"，不是"设为 12"）。

### 缺陷 2：车辆只能在**停在车库内**时被卖出

权威依据（OpenTTD `src/vehicle_cmd.cpp:261`，2026-09-19 核对）：

```cpp
if (!front->IsStoppedInDepot())
    return CommandCost(STR_ERROR_TRAIN_MUST_BE_STOPPED_INSIDE_DEPOT + to_underlying(front->type));
```

而克隆路径当场 `StartStopVehicle(cv)` 把车**开出了车库**，所以"当场卖车"必然失败。
实测证据（`/tmp/m31e`，相位 `fleets12L12s0f11C14`）：

```
fleets12L12s0f11C14
  cur=12  L(列表长度)=12  s(卖出)=0  f(引擎拒绝)=11  C(引擎真值车队)=14
```

**11 次 `SellVehicle` 全部被引擎拒绝，车队一辆没少**——而旧相位 `fleet4` 同时表示
"克隆到 4"与"卖到 4"两种完全相反的行为，这正是 D20 那类错误因果的来源。

### 修法（三处，全部有静态守卫）

1. **array 一律单变量** `foreach (vid in this._fleetOwned)`；本仓库对 array 用单变量、
   对 list/table 才用双变量（`foreach (sid, _ in AISignList())`）。
   守卫：`squirrel-api-guard.test.ts` 对已知 array 字段禁用双变量形式。
2. **头车计入本线路车队**（`_fleetOwned.append(v)` 于建车处）：`V:N` 自此表示
   **"这条线路应有 N 辆车"**，而不是"N 辆克隆"。
3. **缩编 = 送回车库 → 等它停下 → 再卖**：新增跨 tick 状态机
   `_fleetSell` + `ProcessFleetSells()`（`SendVehicleToDepot` → `IsStoppedInDepot` → `SellVehicle`），
   每轮推进一次。
4. **相位区分方向并带上引擎真值**：`fleetg<cur>L<len>C<owned>`（克隆）/
   `fleetsend<k>C<owned>`（已送车库待卖）/ `fleetsold<s>w<wait>b<blocked>C<owned>`（卖出）/
   `fleetok<want>C<owned>`（已满足，以前**什么都不说**）/ `fleet_wait<want>c<cur>L<len>`（推迟）。

### 为什么把引擎真值写进相位

harness 只能通过 admin 的 `CompanyStats`（周期性推送）看车队。当"相位说卖到 4"与
"admin 说还是 15"冲突时，无法判断是**卖车没生效**还是**读数陈旧**。执行器把
`CountOwnVehicles()`（引擎自己的计数）写进相位后，两种解释当场分开——
本次正是靠它确认"车队真的没少"，从而把根因锁定到引擎的卖车前置条件上。

### 兼容性（必须记住）

`V:N` 的**语义变了**：旧行为是"再克隆 N 辆"（`_fleetOwned` 从空开始计数，且头车不计入），
新行为是"这条线路应有 N 辆车"。因此 **2026-09-19 之前与之后的车队实验数字不可直接比较**
——包括 S0 神谕梯度（`/tmp/s0-v{6,12,18}-r*`，当年标称 fleet 9/15/21 实为 3+N）。

### 真机验证（`/tmp/m31f`，`--v02 --add-vehicles 12 --shrink-to 4 --game-days 300 --seed 7`）

```
EX fleetg12L12C14      ← 克隆到「线路 12 辆」（引擎真值 14）
EX fleetsend8C14       ← 送 8 辆回车库（12 - 4 = 8，目标算术正确）
EX fleetsold1g…w3b0C9  ← 卖出 1 辆、3 辆在路上，引擎真值 9
EX fleetsold1…w2b0C8
EX fleetsold1…w1b0C7
EX fleetsold1…w0b0C6   ← 持续收敛
[v02] shrink probe: requested 4, observed fleet 14 -> 10   ← 探针实测车队下降
```

**结论**：`V:<count>` 现在**双向可用**，`--shrink-to` 探针从假说变成量过的行为。
三处缺陷（array `foreach` 取下标、卖车前置条件、相位不辨方向）都有静态守卫。

### 遗留问题（已具名，尚未定性）

`fleetsend8` 只卖出 4 辆就 `w0`：其余 4 辆**从未被卖却也不存在了**——相位把它们报为
`g<gone>`（消失）而不是「卖出」。最可能的原因是执行器的阶段机在重建线路/车库时，
把停在车库里的待卖车一起删掉了（本局中执行器确实在 `fleetsold` 期间重新进入了 `road` 阶段）。
这条**已单独计数**（`fleetsold<s>g<gone>w<wait>b<blocked>C<owned>`），下一次真机运行即可判定，
不需要再猜。⚠️ 在那之前，「缩编到 N」只能描述为「分批卖出并逐步收敛」，
不能声称「一次请求即精确到 N」。

## 10.85 第一性原理复审：离"自主 + 自进化地玩"还差什么（2026-09-19）

> 触发：项目所有者第二次要求从第一性原理复审。本节**先量再判**：所有数字来自磁盘上
> 167–169 局的真实记录（`/tmp/*/sessions/*/`），不是回忆。

### A. 已经成立的部分（先说清楚，避免重复建设）

| 主张 | 证据 |
|---|---|
| 无人值守跑完整局 | 167 局 `brain.kind=real`；31/31 有记录者 `reachedHorizon=true` |
| **动作有后果** | 变更型工具调用 694 次（建线 350、车队 232、暂停 112）；**76/169 局同时使用了建线与车队** → M-PLAY 判据①在实际数据上已成立 |
| **决策时能看到自己上个动作的结果** | `DecisionContext.sinceLastDecision` 已含 `elapsedGameDays / moneyDelta / incomeDelta / vehiclesDelta / stationsDelta / 解码后的 phases / actions / notableEvents`（`src/agent/decision-context.ts`）——**局内 credit assignment 已存在** |
| 判据在近期运行里都被记录 | 最近 24h 的 25 局**全部**有 `scenario` + `deliveredRun`（130 局缺字段的是历史数据，不是当前缺口） |
| 经验可记录/注入/推翻 | M1/R2a/R2b 已验证（`supersedes` 真机生效） |

### B. 真缺口（按"是否阻塞主张"排序）

**B1 判据在常用配置下**恒为常数**（最隐蔽，已修）**

| horizon | 局数 | `deliveredRun > 0` |
|---|---|---|
| **30**（快速迭代用） | 19 | **0 局** |
| 120 | 2 | 1 |
| 300 | 6 | **6 局全部 > 0**（90 / 91 / 152 / 159 / 355 / 589） |

判据由 `COMPANY_ECONOMY.deliveredCargo` 积分而来，而那是**按季度重置**的计数器
（`QUARTER_DAYS = 90`，SPEC §10.65）。**短于一个季度的窗口只能观测到"没有变化"**。
所以"30 天的 A/B"不是样本不足，而是**判据恒为常数、什么都测不出来**——
把它读成"没有效果"就是一次静默的谎言。

**修法（G7，本轮已实现）**：
- `MIN_COMPARABLE_HORIZON_DAYS = 180`（2 个季度）与 `horizonIsComparable()`（`metrics.ts`）；
- `run-experiment.ts` 在**跑之前**拒绝短于下限的**比较**（并给出替代做法：单局 smoke 走 `pnpm run cli`）；
- `run-experiment.ts` 与 `m3-verdict.ts` 在结果里打印
  `!! OUTCOME IS CONSTANT: … it is NOT evidence of "no effect"`；
- 静态守卫：两个会下结论的脚本必须调用退化检查（D28：披露要留在判据路径上）。

**B2 没有**选择压力**（自进化缺的那一环）**

记录的环都在（记录/存储/注入/推翻/局内归因），但**没有任何一环按结果淘汰经验**——
作废只来自模型自己的判断。缺 `recall`（M4）与"哪条经验真的帮了忙"的判据（M5）。
结论：当前准确说法是**反思式自进化**，不是结果式。

**B3 玩法带宽：决策少、动作少**

决策数 167 局：中位 **6**、均值 6.5、max 17。工具调用里**读占 76%**
（estimate_route 1069 / observe 735 / inspect_route 470 对 变更 694）。
所以 agent 实际是**监督者**：6 次决策、2–4 个有后果动作。
要成为"玩家"，要么提高每局决策数（节拍/触发器），要么提高单次决策的后果（M3-2 复合动作）。

**B4 缺的关键动词：**退役****

现有动作 = 建线 / 调车队（已双向）/ 暂停。**没有"关掉亏损线路"**。
对一家运输公司而言这是最有后果的动词之一，也是 M3-2 的第一项。

**B5 学习曲线未测**（M5）：CV 0.57–0.79（300 天）⇒ 检出 +40% 需 ~36/臂 ≈ 19 h。
在 B1 修复之后，长局的判据至少是**会动的**，这是 M5 可行的前提。

### C. 结论（一句话版）

**"自主"**：能无人值守地**监督**一局并做出有后果的决策（判据①已成立）；
**"玩"**：缺**退役**这类关键动词与更高的后果密度（B3/B4）。
**"自进化"**：记录的环都有、局的归因也有，缺**选择压力**与**检索**（B2/M4）；
**"可测"**：判据只在够长的 horizon 上才会动（B1，已加守卫），学习曲线未测（B5）。

## 10.86 M3-2a：每线路登记表 + **退役**（2026-09-19）

### 为什么先修登记表

`_fleetOwned` / `_vehicle` 在**切 job 时被重置**（那是为了防状态泄漏，D-era 的教训），
副作用是执行器**不记得旧线路的车队**。于是一整类真实动作到不了可达状态：

- `V:` 请求只要针对旧 job 就被 `fleet_otherjob` 拒绝（D20 那条"重发 8 次"的结构性原因之一）；
- **"关掉一条正在亏钱的线路"根本做不到**——而真实场景恰恰是"先建的线后来亏钱"。

这与 D34 同型：能力看着存在，但**前置状态永远到不了**。修法：`_routes[job] = {vehicles, lead, depot, retired}`
作为**跨 job 保留**的唯一目的地，切 job 时**先登记再重置**（顺序有静态守卫）。

### 退役（`NUTZ:bp:<job>:X:1`）

- GS 新命令 `retire_route`（`{company, job}`）→ 放/替换 `X:` 标牌；ack 仍只说"请求已送达"。
- 执行器 `RetireRoute(job)`：把该线路**全部**车辆（**含头车**——普通缩编的下限 1 对退役不适用）
  送进 `_fleetSell`，由既有的"送回车库 → 停稳 → 卖出"状态机逐步卖掉；
  登记 `retired=true`、清掉该 job 的标牌（否则 `FindNextJob` 会把它当待建工作再建一遍）。
- 未知 job → 具名 `retire_unknown<job>`（静默会让模型以为退役生效）。
- 工具 `retire_route`（第 7 个工具，`executionMode: "sequential"`）：契约说明三点——
  整条线路含头车、只对执行器本局建过的线路有效、车辆必须停进车库才卖得掉（所以是逐步生效）。

### 真机发现：**动作生效了，信号却丢了**（D28 的机械版）

第一次真机（`/tmp/m32`）结果自相矛盾：公司车队 **8 → 2**（车确实被卖了），
却**一条 `retire`/`fleetsold` 相位都没有**。日志给出根因：

```
EX exc:the index 'rawin' does n…   (stage=error)
```

我把 `_retiredJobs` 初始化成 **array `[]`**，却对它调用 **table 方法 `.rawin()`** →
每一轮 `TickInner` 都在这一行抛异常：车辆是在异常之前被送去车库的（所以照样卖掉了），
而函数末尾的 `SetPhase("retire…")` **永远执行不到**。
**动作生效 + 汇报全丢**，harness 只能看到"莫名少了几辆车"。

修法与守卫：`_retiredJobs` 改为 table 集合（`in` 判存在、`<-` 建槽）。
更重要的是新增**用法矛盾守卫**：同一个标识符既 `.append(`（只有 array 才有）又 `.rawin(`
（只有 table 才有）= 运行时必炸。

⚠️ **这条守卫的第一版是空的**：它只检查"声明为 `[]` 又用 `.rawin(`"，
而我把声明从 `[]` 改成 `{}` 之后，它就再也看不见这个 bug——**重放同一处回归仍然全绿**。
改成**矛盾检测**（不看声明、只看用法是否互相排斥）后重放同一处回归才变红。
"守卫必须能被证明会失败"因此不是口号：本次是**我用重放亲手证明了第一版是假的**。

## 10.87 M3-2b：披露粘滞——让事件相位真的被采样到（2026-09-19）

### 问题（§10.86 未结案项）

公司名（`SetPhase`）是**单值、被采样**的通道：harness 每 500 ms 轮询，执行器每轮
（`Sleep(5)`）都改写它。施工相位（`R45 d0 a0 #2`）把稀疏的事件披露（`retire…`/`fleetsend…`）
**盖掉了**——`/tmp/m32c` 里动作全部生效、事件相位一条没进日志。
这不是"忘写日志"，是**通道性质**：采样通道装不下稀疏事件（MEMORY D39）。

### 修法：按消费者拆分入口

| 入口 | 语义 | 覆盖规则 |
|---|---|---|
| `SetPhase(p)` | "现在在做什么"（要新鲜） | 可覆盖任何相位 |
| `SetPhaseSticky(p, hold=15)` | "发生过什么"（要持久） | 之后 `hold` 轮内不被 `SetPhase` 覆盖 |
| `WritePhase(p)` | 诊断与底层写入 | **可抢占**（`exc:` 用它，错误不能被事件埋掉） |

所有车队/退役事件（`fleet_wait`/`fleetg`/`fleetsend`/`fleetsold`/`fleetok`/`retire*`）改走 sticky；
静态守卫逐个检查（并**用重放证明过会失败**：把 `fleetsold` 改回 `SetPhase` → 红）。

### 真机验收（`/tmp/m32d` 失败 → `/tmp/m32e` 通过）

`/tmp/m32d`：三次操作全部生效（3→8→7→2）但相位一条没进日志，且
`exc:wrong number of paramete`——**Squirrel 对调用时参数个数强校验**，
`SetPhaseSticky(p)` 单参调用直接炸（又是在"动作已执行、相位未发出"的位置）。
修法：`hold = null` 默认参数 + 守卫钉住签名。

`/tmp/m32e`（修后）：

```
fleet_wait6c1L1 → fleetg6L6C8 → fleet_wait3c6L6 → fleetsend3C8 → fleetsold1g0w0b0C2
三次操作：扩容 3→8、缩编 8→7、退役 7→2；exc: 计数 = 0
```

**结论**：至此"工具必须能观测自身效果"这条铁律在车队/退役动作上**真正成立**：
每个动作都有可见、可归因的信号（推迟的原因与计数、方向、卖出数、引擎真值）。

### 本阶段的缺陷模式（三连，同型）

`rawin` 用在 array 上、`cur` 先用后声明、单参调用强校验——**三者的症状完全一样**：
动作照常执行，只有**汇报路径**炸掉。若没有"相位是否真的进了日志"这个验收，
三个都不会被发现（功能测试全绿）。守卫现在各有一条，且都经过重放证明。

## 10.88 M3-2c：车队请求对**已登记的旧线路**生效（2026-09-19）

### 为什么这是 D20 的根因修复

`FleetRequests` 现在解析**所有** `V:` 标牌（不只当前 job）：
- 当前 job → 活字段（原行为）；
- **已登记 job → `_routes[job]`**（M3-2a 的登记表提供车队/头车/车库/`applied`）；
- 未知 job → 具名 `fleet_unknown<job>`（执行器只认本局自己建的线路）；
- 已退役 job → 具名 `fleet_retired<job>`（清空后的线路无从调车队）。

真实事故（D20）：agent 在建 job 102 时给 job 101 调车队 → `fleet_otherjob` 拒绝 →
**同一请求重发 8 次**、车队始终 6 —— 它学到的因果是"请求车队没用"。
现在这条链路上的每一环都有具名信号：推迟（`fleet_wait<w>j<job>c<cur>L<len>`）、
方向（`fleetg/fleetsend` 带 `j<job>`）、拒绝（unknown/retired）。

### 真机验证（`/tmp/m32f` 失败 → `/tmp/m32g` 通过）

`/tmp/m32f`：`--second-route` 探针**静默不执行**——
`--second-route` 在 switch 里被解析、也传给了 v02，但**没进 `parseArgs` 的返回值**，
`args.secondRoute` 恒为 undefined。**没有报错，一局真机白跑**（15 分钟）。
这是本仓库第三次"声明了但没接线"（shrink 探针一次、`--second-route` 一次、
更早 eslint 抓到过一次）→ 新增守卫：**switch 里被赋值的开关必须出现在返回值里**，
并用重放证明（把 `secondRoute` 从返回值拿掉 → 红）。
⚠️ 守卫第一版也是空的：`return {...}` 的结尾用 `indexOf` 猜，猜不到就切到文件末尾，
"返回集合"于是包含整个文件的标识符——重放不红。改成**花括号配平** + 自测后才真的抓到。

`/tmp/m32g`（修后）：

```
[v02] 2nd-route probe: sending build_bus_route job=102
[v02] 2nd-route probe: executor now on "EX work j102"
[v02] 2nd-route probe: requesting +3 on OLD job 101 (fleet is 6)
[v02] 2nd-route probe: OLD route fleet applied ✅ (6 -> 7)
相位：fleetok4j101C9 → fleet_wait3j101c4L4 → fleetsend1j101C9 → fleetok4j101C9
```

执行器在 **j102** 施工时处理了 j101 的请求：`count:3` 按**契约语义**（目标数量）执行为
"从 4 缩到 3"（`fleetsend1` 送 1 辆去车库）。探针注释里写的是"+3"——那是**我写探针时的语义错误**，
不是实现错误：`set_route_vehicles` 从 M3-1 起就是"设为目标数量"。

### 本阶段教训（第三次"声明了但没接线"）

探针、开关、指标字段——凡是"声明 → 赋值 → **必须出现在某个聚合点**"的链，
最后一环最容易漏，而漏掉的症状是**静默不执行**。守卫的写法也两次翻车：
先查声明（改声明就瞎）、再猜结尾（猜不到就全绿）。**重放证明**是唯一可信的验收。

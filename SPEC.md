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

**解法**: 时间必须可控。采用 **冻结-观察-决策-执行-解冻** 循环：
1. LLM 收到「需要决策」信号
2. 外部控制器 `pause` 游戏
3. 采集最新状态 → 喂给 LLM
4. LLM 产出结构化决策（计划 / 即时命令 / 等待条件）
5. 外部控制器把决策转成游戏可执行动作，`unpause`
6. 动作异步执行；外部监听结果事件；需要再决策时回到 1

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
| `tools` (AgentTool) | 每个高层动作一个 tool：`observe` `build_bus_route` `build_train_route` `add_vehicles` `adjust_orders` `pause` `unpause` `request_reflection` |
| `beforeToolCall` | 动作合法性预检（钱/状态/冷却），拒绝非法动作并给原因 |
| `afterToolCall` | 记录指标、审计、结果反馈给进化引擎 |
| `shouldStopAfterTurn` | 「这一 turn 结束就停」——执行器完成一轮动作后让出 |
| `steer/followUp` | 游戏中需要紧急重规划时注入 |
| session (harness) | 一局=一个 session 分支；跨局 lessons 独立存 |

### 4.2 决策循环（细粒度）
每局定义「决策点」（默认: 每月初，或事件触发）。循环:
1. Runner 在决策点 `pause` + 采集 rich state → 构造 `game_observation` 消息
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

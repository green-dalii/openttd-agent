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

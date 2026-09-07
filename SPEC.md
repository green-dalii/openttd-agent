# SPEC — OpenTTD LLM Agent Framework

> 状态: **v0.2 — 用户已拍板（D1-D10）+ 已固化两轮可行性调研**
> 版本: 2026-09-07
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

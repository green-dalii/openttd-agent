# Agent 决策循环与 Dashboard 控制

本文件是**决策循环**（框架如何驱动 LLM）与 **Dashboard 运行控制**的单一事实源。
**决策循环的权威定义在 `SPEC.md` §1.1（节拍矛盾）与 §4.2（决策循环细粒度）**——
本文件只是把它展开成可实现的契约。启动门禁见 `docs/STARTUP-AND-LIFECYCLE.md`；
前端契约见 `docs/DASHBOARD-UI.md`。

> **对齐记录（v0.6.0）**：本版的实现曾偏离 SPEC，具体偏离见 §2.0。凡本文件与
> SPEC 冲突，以 SPEC 为准。

---

## 1. 第一性原理：框架与智能的边界

**框架不提供任何策略、建议或引导。框架只做三件事：**

1. **呈现事实**：把游戏状态、上次动作的结果、经济变化如实喂给 LLM。
2. **提供动作面**：工具（observe / build_bus_route / add_vehicles / set_pause）即能力边界。
3. **驱动节奏**：在对的时机请求决策，并执行 LLM 的决定。

**所有决策与反馈都来自 pi-agent 的 LLM。** 框架里出现"你应该…"、"如果施工中就…"这类
措辞即违规——那是把智能搬回框架，会让 LLM 退化成执行器。

### 1.1 v0.5.0 前的实际行为（问题根源）

审计真机 Session 日志（`/tmp/openttd-agent-data/sessions/`）发现两个致命事实：

| 现象 | 根因 |
|---|---|
| 三个 Session 全是 `mode=watch`、`kind=faux`、`decisions=0` | 用户看到的是**内置 CPU AI**（`start_ai "CPU"`）在打，不是我们的 agent；dashboard 也没有任何入口能启动 agent |
| 即使 `--agent`，`maxTurns ?? 1` → **全局只决策一次** | LLM 在 1950-01-01 建一条线，此后框架只是观察，从不再次询问 |
| income/现金持续下降 | 上述两点叠加：建线后既不补车、也不调价、也不补救，因为**没人再问 LLM** |

结论：**"无脑操作"不是 LLM 的问题，是框架只问了一次。**

## 2. 决策循环契约（= SPEC §1.1 + §4.2）

### 2.0 v0.6.0 前的偏离（必须记住，避免回退）

| SPEC 要求 | 曾经的实现 | 后果 |
|---|---|---|
| §4.2 决策点**默认每月初** | 固定 90 游戏天 | 决策太少，模型没有机会纠偏 |
| §1.1 步骤 2/5：决策时**冻结游戏**（`pause` → 决策 → `unpause`） | **从不 pause** | 状态在 LLM 思考期间继续变化，模型基于过期数据决策 |
| §4.2 步骤 2：LLM 产出**结构化计划**（`goal/plan[]/immediate_action/wait_until/rationale`） | 只让它调工具 | 拿不到意图、无法审查计划、无法知道该何时再问 |
| §4.2 步骤 5：「到达下一决策点**或等待条件满足**」 | 无 `wait_until` 概念 | 节奏完全由框架拍脑袋决定 |

### 2.0.1 冻结-观察-决策-执行-解冻（SPEC §1.1 六步，逐步对应实现）

| SPEC 步骤 | 实现位置 |
|---|---|
| 1. LLM 收到「需要决策」信号 | `scheduler.take()` 返回 trigger |
| 2. 外部控制器 `pause` 游戏 | `client.rcon("pause")`，**决策前** |
| 3. 采集最新状态 → 喂给 LLM | `runDecision()`：`summarizeState` + `buildDecisionContext` |
| 4. LLM 产出结构化决策（计划/即时命令/等待条件） | prompt 要求 `goal/plan/immediate_action/wait_until/rationale` |
| 5. 决策转成可执行动作，`unpause` | 校验计划后 `client.rcon("unpause")` |
| 6. 异步执行；需要时回到 1 | executor 施工；GS 阶段事件 → `scheduler.request("phase_change")` |

**为什么必须冻结**：OpenTTD 是连续时钟（tick），LLM 是慢思考（1–30s）。不冻结时
模型看到的状态在它开口前就已过期，动作落在与决策假设不同的世界状态上。

### 2.1 触发条件（框架负责节奏，不是策略）

| 触发器 | 何时 | 理由 |
|---|---|---|
| `start` | 每次运行开始 | 必须给 LLM 一个开局决策 |
| `phase_change` | GS 报告施工阶段变化 | 施工是异步的；**阶段推进=世界变了** |
| `wait_until` | 上一轮计划给出的等待条件满足 | **由 LLM 自己决定何时再被问**（SPEC §4.2 步骤 5） |
| `interval` | 每 **30** 游戏天（每月初；SPEC §4.2 默认） | 兜底：即使模型没说等待条件，也要给它复盘机会 |
| `event` | 显著事件（车辆/站点增减、施工失败） | 异常值得注意 |
| `manual` | 用户在 dashboard 点 "Ask agent" | 人机协作 |

`wait_until` 优先级低于 `manual`/`event`，高于 `interval`：模型自己指定的唤醒点
比框架的兜底节拍更贴合实际。

**去重与节流**：同一轮内多个触发器只算一次决策；两次决策之间至少间隔
`minDecisionGapMs`（默认 5s），避免事件风暴把 token 烧光。

**上限**：`maxDecisions`（默认 0 = 不限制，随运行结束）。0 表示"由运行时决定"，
不再是"只做一次"。

### 2.1.1 结构化计划（SPEC §4.2 步骤 2）

prompt 要求模型在调用工具之外给出计划对象：

```json
{
  "goal": "一句话目标",
  "plan": ["步骤…"],
  "immediate_action": "本轮立刻执行的动作（对应某个 tool）",
  "wait_until": { "game_days": 30 } | { "condition": "phase contains 'EX done'" } | null,
  "rationale": "为什么这样决定"
}
```

- **不是框架在引导策略**：`goal/plan/wait_until` 的**内容全由模型填**，框架只规定
  「请说明你的意图与唤醒条件」这一**接口**（否则框架无法知道何时该再问）。
- `wait_until` 缺失或非法 → 退回 `interval`（每月）兜底，绝不因解析失败而停止决策。

### 2.2 反馈载荷（这是"智能"的来源）

每次决策喂给 LLM 的**不只是当前状态**，还有**因果**：

```ts
{
  trigger: "start" | "phase_change" | "interval" | "event" | "manual",
  now: { date, companies[], vehicles, stations, money, loan, income },   // 现状
  sinceLastDecision: {                                                   // 因果
    elapsedGameDays: number,
    moneyDelta: number, incomeDelta: number, vehiclesDelta: number,
    phases: string[],                    // 期间发生过的施工阶段
    actions: [{ tool, ok, summary }],    // 上次 LLM 做了什么、结果如何
    notableEvents: string[]              // 值得注意的原始事件摘要
  },
  history: string[]                      // 阶段性总结（压缩的长程记忆）
}
```

**为什么必须有 `sinceLastDecision`**：没有它，LLM 每次看到的是孤立快照，
无法判断"我上次加车后收入有没有改善"，也就无法做出智能调整。

### 2.3 长程记忆

`history` 由 `buildStageSummary` 的 note 累积（已有），注入时**压缩**为每行一条，
最多 N 条（默认 12），保证上下文不无限增长。这是 LLM 跨决策的唯一记忆来源。

### 2.4 禁止事项

- 框架**不得**在 prompt 里给出行动建议、优先级、"先做 X 再做 Y"。
- 框架**不得**因为"施工中"就跳过决策（旧 prompt 明示"施工中就报告并结束回合"）。
- 框架**不得**替模型决定 `wait_until` 的内容（只能规定该字段的**格式**，
  以及解析失败时的兜底节拍）。
- 框架**不得**静默吞掉 LLM 的工具调用失败——失败要进 `sinceLastDecision.actions`。

## 3. Dashboard 运行控制

### 3.1 架构：`--serve` 监督模式

问题：运行与 dashboard 是同一个进程的同一段代码，dashboard 无法控制"是否在跑"。

方案：新增 `--serve` 模式 = **只启动 dashboard + 监督器**，由用户在页面上启动运行。

```
pnpm run cli --serve --web-port 8080
  → WebServer（常驻）
  → RunSupervisor（可 start/stop/pause/resume）
      └─ 启动一个 run（agent|watch）时，把已存在的 WebServer 注入进去
```

**关键约束**：被监督的 run **不得**自己再起一个 WebServer（端口冲突/双份状态）。
`runAgent`/`runWatch` 因此接受可选 `opts.web`；给了就复用，没给才自建（保持 CLI 单跑兼容）。

### 3.2 REST 契约（`docs/DASHBOARD-API.md` 同步）

| 方法 | 路径 | 语义 |
|---|---|---|
| `GET` | `/api/run` | 当前运行状态：`{ state, sessionId, mode, since, error }` |
| `POST` | `/api/run/start` | `{ mode: "agent"\|"watch" }` → 启动（已在跑则 409） |
| `POST` | `/api/run/stop` | 优雅停止（等价 Ctrl-C）：finalize 为 `aborted` |
| `POST` | `/api/run/pause` | 暂停游戏（rcon pause）+ 停止决策计时 |
| `POST` | `/api/run/resume` | 恢复（rcon unpause）+ 重启计时 |

`state`: `idle | starting | running | paused | stopping`。

**为什么 stop 是 `aborted` 而不是 `completed`**：用户主动停止 ≠ 达成目标
（见 `STARTUP-AND-LIFECYCLE.md` §5.3）。

**安全**：控制接口只在 `--serve` 且绑定 127.0.0.1 时暴露；独立 `--agent` 运行时
`/api/run/start` 返回 409/404（已有运行）。

### 3.3 WS 帧

新增 `{ type: "run", data: RunState }`，状态变化即推送，页面无需轮询。

## 4. 游戏画面快照（审计阶段性成果）

### 4.1 事实边界：像素级截图在本架构下不可得

**SPEC §10.2 早已写明**："拿不到的（诚实边界）: 视觉像素"。2026-09-11 逐条实测确认：

| 尝试 | 结果 |
|---|---|
| dedicated server (`-D`) + rcon `screenshot` | `Screenshot failed!`（无帧缓冲） |
| 本机视频驱动列表 (`-h`) | 只有 `cocoa` / `cocoa-opengl`，**没有 `null`**，无法无窗口运行 |
| 窗口模式 `-v cocoa-opengl -g <save>` + rcon | `Could not change to foreground application. Error -50`；admin 端口未开 |
| GS/AI API 中的截图函数 | 不存在（GS API 无 screenshot） |

**结论**：本架构（headless dedicated）下拿不到游戏渲染的画面。这不是实现偷懒，
是 OpenTTD 的限制；要真截图必须引入带窗口的客户端或外部渲染器。

### 4.2 方案清单（按"接近真实画面"排序）

| # | 方案 | 真实度 | 代价 | 状态 |
|---|---|---|---|---|
| **A** | **数据示意图**（当前实现）：用 GS ack 真实 tile 坐标 + 公司数据画地图/路线/城镇 | 低（几何示意） | 0 | ✅ 已实现 |
| **B** | **地形抽样导出**：GS 用 `GSMap.GetTileType/GetTileHeight` 抽样（如 64×64=4096 点），Node 端合成 PNG/Canvas 色块图 | **中高**（真实地形、水域、城镇分布） | 中 | 建议 |
| **C** | **存档外渲染**：关机时已 `rcon save`；用外部工具（`openttd-map` / `OpenTTD_surveyor`，Python）渲染存档为真正的小地图 PNG | **高**（接近官方 minimap） | 中高（多一个外部依赖/流水线） | 可选 |
| **D** | **带窗口客户端截图**：非 dedicated 运行 + `screenshot` | 最高（真实画面） | 高（需要图形会话；本机实测不可用；破坏"headless 可复现"） | ❌ 不建议 |
| **E** | 假彩色统计图：由已有的 GDP/站/车/货流数据上色 | 低（不是地图） | 低 | 已被 A 覆盖 |

**为什么 B 是性价比最高的下一步**：`GSMap` 已在本项目 GS 里用过
（`bridge-gs/main.nut` 的 `GSMap.GetTileIndex/GetTileSizeX/IsBuildable`），
无需新依赖；抽样得到的 tile 类型足以画出**真实地形与水域**，比 A 的示意图接近游戏画面得多。

**B 的硬约束（SPEC §10.2）**：GS 推送 ≤ **1450B/条**，且受
`script_max_opcode_till_suspend` 执行预算限制。因此必须：
- **抽样而非全量**（256×256 = 65536 tile 会直接超预算；64×64 ≈ 4096 次调用较安全），
- **分帧推送**（每条消息一块，按行/按区，避免单条超限），
- 抽样值量化成 1 字节（枚举映射：水/草/林/路/铁/城镇/工业）后再编码。

**C 的接入方式**：`session.close()` 时已有存档，可在 `--serve` 的 stop 流程里
调用外部渲染器，把 PNG 落到 `<session>/stages/`；失败不影响主流程（非致命）。

### 4.3 当前实现（A）的诚实标注

前端在 Stage views 面板明确写出：
"diagram rendered from world data — OpenTTD's headless server has no framebuffer,
so a real screenshot is not possible"。**不得**把它当作游戏截图展示。

每个施工阶段存一份：`<session>/stages/NNN.json`，内容为 `stage-view.ts` 的
几何描述（地图边界、路线、城镇位置与人口、车库），Sessions 页可回放审计。

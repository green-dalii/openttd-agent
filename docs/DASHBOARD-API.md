# Dashboard API + Telemetry Contract (v0.3.0, FROZEN)

> **单一事实源**：本文件是 dashboard 前后端之间的冻结契约。后端与前端**并行开发**，
> 任何一方都不得单方面改字段名/形状。改契约 = 先改本文件 + 同步两侧。
>
> 事实依据（已在 node_modules 中**运行验证**，pi-ai / pi-agent-core 0.85.1）:
> - `@earendil-works/pi-ai/providers/all` 导出 `builtinModels()` / `getBuiltinProviders()` /
>   `getBuiltinModels(provider)` / `getBuiltinModel(provider, model)` / `getBuiltinModelDataGeneratedAt()`。
>   **实测: `getBuiltinProviders()` = 39 个静态目录 provider；`builtinModels()` 注册 40 个**
>   （多出的 `radius` 是纯动态 provider，无静态目录），合计 ~1900 个模型。
> - `findEnvKeys(provider)` / `getEnvApiKey(provider)` **只从 `@earendil-works/pi-ai/compat` 导出**
>   （顶层 index 不导出，`/utils/env-api-keys` 也不可用）→ 实读 ESM exports 后确认。
> - 每个内置 provider 自带 `auth`（apiKey 或 oauth），**环境变量自动解析**。实测
>   `models.getAuth(id)` 返回 `{ auth: { apiKey }, source }`，其中 `source` 为
>   `"stored credential"`（凭据store命中）或 `"DEEPSEEK_API_KEY"` 这类**环境变量名**；
>   未配置时返回 `undefined`。`checkAuth(id)` → `{ source, type }`。
> - `models.getAvailable(id)` 在无 auth 时返回 `[]`（只列**可认证**的模型）→ 目录浏览
>   要用 `getBuiltinModels(id)`（全量），不可用 `getAvailable`。
> - `CredentialStore` 是**应用注入**的（默认 `InMemoryCredentialStore`）→ 我们要自己实现
>   文件版，否则 dashboard 里填的 key 重启即丢。
> - `AssistantMessage.usage: Usage` = `{ input, output, cacheRead, cacheWrite, reasoning?,
>   totalTokens, cost:{ input, output, cacheRead, cacheWrite, total } }`。
> - `AssistantMessageEvent` 含 `thinking_start` / `thinking_delta` / `thinking_end` /
>   `text_delta` / `toolcall_end`；`AssistantMessage.content` = `(TextContent|ThinkingContent|ToolCall)[]`。
> - `Agent.subscribe((event, signal) => void)` 产出 `AgentEvent` =
>   `agent_start | agent_end | turn_start | turn_end | message_start | message_update |
>   message_end | tool_execution_start | tool_execution_update | tool_execution_end`。
> - `AssistantMessage.usage: Usage` = `{ input, output, cacheRead, cacheWrite, reasoning?,
>   totalTokens, cost:{ input, output, cacheRead, cacheWrite, total } }`。
> - `AssistantMessageEvent` 含 `thinking_start` / `thinking_delta` / `thinking_end` /
>   `text_delta` / `toolcall_end`；`AssistantMessage.content` = `(TextContent|ThinkingContent|ToolCall)[]`。
> - `Agent.subscribe((event, signal) => void)` 产出 `AgentEvent` =
>   `agent_start | agent_end | turn_start | turn_end | message_start | message_update |
>   message_end | tool_execution_start | tool_execution_update | tool_execution_end`。

---

## 1. 页面路由与静态资源（无构建链，按**角色**分目录）

```
src/web/public/
  pages/*.html           # 一个页面一个 HTML（只放 HTML）；URL 由文件名派生，见下表
  assets/css/style.css   # 全部样式（单文件，无预处理器）
  assets/js/*.js         # common.js（共享）+ 每页一个脚本
```

**URL 路由由文件名派生**（`src/web/server.ts` 的 `pageRoutes()`，单一事实源 = 磁盘上的文件）:

| URL | 文件 | 职责 |
|---|---|---|
| `GET /` | `pages/live.html` | Run：实时游戏 + agent 遥测（唯一的特例：URL 不等于文件名） |
| `GET /compare` | `pages/compare.html` | Compare：模型比较（四轴 / 配对判定） |
| `GET /configure` | `pages/configure.html` | Configure：provider 选型 + 密钥 + 运行旋钮 |
| `GET /sessions` | `pages/sessions.html` | History：历史局管理 / 复盘 / 记忆 |

**旧地址**：`/llm`（别名 → `/configure`）、`/providers`（302 → `/configure`）、`/evolution`（302 → `/sessions#memory`）——保留/重定向，页面的名字跟它回答的问题走。

**为什么路由是"派生"的而不是手写表**：手写表会和文件漂移——文件在、路由没有 ⇒ 浏览器只看到
一句 `not found`，看起来像"这个页面根本没做"。派生之后"加一个页面" = "加一个文件"，运行中
新增的文件也会被认到。**不是页面的 URL** 返回一张列出全部页面的 404 页，并写明"进程可能比
磁盘旧，请重启"。

- 导航按**四个问题**（CoDesign §4）：Run / Compare / History / Configure。URL 保持**扁平**（`/configure` 而非 `/pages/configure.html`）——文件可自由挪动，链接不会断。
- 更名/迁移页面时：内容没变就加进 `PAGE_ALIASES`（内部重写），**内容搬走了**就用 `PAGE_REDIRECTS`（302）——不留第二份。
- 强制约束（单测锁定 `web-api.test.ts` / `web-routing.test.ts`）: `public/` 根目录**不得**再有散落的
  html/css/js；每个路由目标文件必须存在且返回 200；导航里的每个链接必须能解析；HTML 里的每个
  `/xxx` 引用必须指向真实存在的文件或路由；`pages/**` 只放 `.html`、`assets/**` 只放对应后缀。
- **禁止引入构建链**（无 bundler/预处理/外部 CDN，离线可用）。

---

## 2. 类型（后端 TS 与前端 JS 必须一致）

**权威在代码里**：`src/agent/telemetry.ts`（`UsageView` / `StepRecord` / `TelemetrySnapshot`）、
`src/types.ts`（`GameEvent` / `SessionMeta`）。下面只写**页面依赖的口径**，不抄第二份定义。

- `UsageView`：token 计量**全部为 number**（`input`/`output`/`cacheRead`/`cacheWrite`/
  `reasoning`/`totalTokens`/`costTotal`）；缺失的 reasoning 填 0。
- `StepRecord`：一步 = 一条 assistant 消息 **或** 一次工具执行（`kind: "message" | "tool"`），
  `id` 会话内单调（`"s1"`, `"s2"`, …）、`turn` 从 1 开始；message 带 text/thinking/usage，
  tool 带 tool/args/ok/summary/durationMs。

### 2.3 TelemetrySnapshot

```ts
interface TelemetrySnapshot {
  sessionId: string | null;
  startedAt: number;                 // epoch ms
  lastActivityAt: number;
  turns: number;                     // 已开始的 turn 数
  activeTurn: number;                // 当前 turn（0 = 未开始）
  steps: StepRecord[];               // 有界（默认最近 400），oldest first
  usage: {
    total: UsageView;
    byTurn: { turn: number; usage: UsageView; steps: number }[];
    byTool: { tool: string; calls: number; failures: number; avgDurationMs: number }[];
  };
  totals: {
    decisions: number;               // 决策点（game_observation prompt）数
    messages: number;                // assistant 消息数
    toolCalls: number;
    toolFailures: number;
    retries: number;                 // 传输层重试次数（D6b；harness 路径可见）
    faults: number;                  // 运行时故障数（D6b；harness 路径可见）
  };
  // 最近的 retry/fault，最新在后，最多 10 条（只有消息，不含 payload）
  recentRuntimeIssues: { ts: number; kind: "retry" | "fault"; message: string }[];
  recentThinking: { turn: number; ts: number; text: string }[];  // 最近 5 条
  brain: { provider: string | null; model: string | null; kind: "real" | "faux" | null };
}
```

### 2.4 GameEvent（已存在，本次新增 UI 分类映射）

后端在 `GET /api/sessions/:id` 与 WS 事件里**保持原始 GameEvent 形状**，前端用
`categoryOf(kind)` 做分组与 Tag（见 §5）：

```ts
interface GameEvent { seq: number; ts: number; kind: string; payload: unknown; }
```

`category` 取值：`"date" | "economy" | "company" | "vehicle" | "station" | "town" |
"industry" | "script" | "protocol" | "other"`。

### 2.5 SessionMeta + Checkpoint

```ts
interface SessionMeta {
  id: string;                        // "20260910-213000-seed7"
  mode: "watch" | "agent" | "v02" | "probe";
  status: "running" | "completed" | "aborted" | "error";
  startedAt: number; endedAt?: number;
  seed: number; startYear: number; mapSize: [number, number];
  serverName: string; companyName: string;
  llm: { providerId: string; model: string; api: string; kind: "real" | "faux" };
  outcome?: { constructionDone?, phase?, vehicles?, stations?, money?, totalEvents? };
  totals: { events, decisions, toolCalls, toolFailures, usage: UsageView };
  checkpoints: SessionCheckpoint[];  // 阶段性总结
  error?: string;
}
interface SessionCheckpoint {
  at: number;                        // epoch ms
  gameDate: string;                  // "1950-03-01" 或 "unknown"
  turn: number;
  note: string;                      // 一句话阶段结论
  totals: { events: number; decisions: number; toolCalls: number; usage: UsageView };
}
```

### 2.6 快照里的经济曲线（`snapshot.companies[id].history`）

```ts
interface CompanyHistoryPoint {
  at: number;          // epoch ms
  year: number | null; // 游戏历法；首个日期事件前为 null
  month: number | null;
  money: number;
  loan: number;
  income: number;
}
```

- 曲线由**服务端**持有并随快照下发（有界 600 点），页面刷新不丢曲线。
  理由：曲线此前只存在页面内存里，刷新即清空——"服务端是真源"的规则要求它跟着快照走。
- 与 `checkpoint` 帧一样，这是**契约**：本文件是唯一权威，UI 文档只引用不再复述。

### 2.7 Provider catalog

```ts
interface CatalogProvider {
  id: string;                        // "openai"
  name: string;                      // 展示名（缺省 = id）
  baseUrl?: string;
  modelCount: number;
  apis: string[];                    // 去重后的 api 列表
  authTypes: ("apiKey" | "oauth")[];
  envKeys: string[];                 // 可用环境变量名（findEnvKeys），如 ["OPENAI_API_KEY"]
  auth: {                            // 由 checkAuth 给出
    configured: boolean;
    source: "stored" | "env" | "none";
    envVar?: string;                // env 命中时的变量名（如 "DEEPSEEK_API_KEY"）
  };
}

interface CatalogModel {
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  cost: { input: number; output: number };   // 每 1M token（直接取 Model.cost）
}
```

---

## 3. REST API

### 3.1 LLM / Providers

```
GET /api/llm
→ 200 {
    selection: {
      source: "catalog" | "custom";   // catalog = 内置 provider；custom = 自建 OpenAI 兼容端点
      providerId: string;             // catalog: "openai"；custom: 用户起的 id（默认 "openttd-llm"）
      model: string;
      api: string;
      baseUrl: string;                // custom 时有意义；catalog 时回 provider.baseUrl ?? ""
      contextWindow: number;
      maxTokens: number;
    },
    status: {
      configured: boolean;            // 可发起请求（key 或 env 就绪 且 base/model 非空）
      hasStoredKey: boolean;          // 已存密钥（不回显）
      envKeys: string[];              // 命中的环境变量名
      source: "stored" | "env" | "none";
      effective: { providerId: string; model: string; api: string; baseUrl: string };
      appliedFrom: "env" | "file" | "none";   // 当前生效来源（env 显式设置优先于文件）
    }
  }

POST /api/llm
  body { source?, providerId?, model?, api?, baseUrl?, contextWindow?, maxTokens?, apiKey? }
  - apiKey 缺省/空串 => **保持已存密钥**（绝不误清）；显式 null => 清除。
  - catalog 选择时 baseUrl/api/contextWindow/maxTokens 由**该模型**决定，忽略客户端传入。
  - catalog 的 model 必须是目录已知（内置快照 ∪ 已持久化的实时覆盖层），否则拒绝。
→ 200 同 GET /api/llm 的形状（**保存后**的视图：同一进程内立即可见，不需要重启）
→ 400 { error, problems: [{ code, message, hint }] }，且 **llm.json 不被改写**。
  code ∈ unknown_provider | unknown_model | …（见 src/agent/problems.ts）

GET /api/llm/catalog
→ 200 { generatedAt: number | null, providers: CatalogProvider[] }

GET /api/llm/catalog/:providerId
→ 200 { provider: CatalogProvider, models: CatalogModel[] }
→ 404 { error }

GET /api/llm/catalog/:providerId/refresh
→ 200 { provider: string, models: CatalogModel[], problems: Problem[], fetchedAt: number | null }
→ 400 { error, problems: Problem[] }    // 请求没法照做（no_credential / unknown_provider）
→ 502 { error, problems: Problem[] }    // 上游 provider 失败（401/403/404/连不上）
说明：
- `models` 是**快照 + live 覆盖层**的合并结果；`source: "live"` 的条目来自 provider 自己的
  /models 端点，其 `priceKnown: false`（价格未知，不是 0 元），`api`/上下文/上限借自同族模型。
- `problems[]` 是**结构化**的失败原因（`{code, message, hint}`）：`message` 带上试过的 URL 与
  状态（`<url> → HTTP 401`），`hint` 是服务端给的**下一步**。失败时 `models` 保留上次已知列表
  （端点说不出话 ≠ 模型消失了）。**状态码说明是谁的错**（400 = 缺凭据，502 = 上游失败）。
- 该端点**永不抛错**；刷新结果由 pi-ai 的 `ModelsStore` 持久化到 `<dataDir>/models-cache.json`，
  agent 进程启动时能恢复同一份覆盖层。

DELETE /api/llm/credentials/:providerId
→ 200 { ok: true }
```

### 3.2 遥测（live）

```
GET /api/telemetry → 200 TelemetrySnapshot
```

### 3.3 Sessions

```
GET /api/sessions
→ 200 { sessions: SessionMeta[] }          // newest first；读 index.json
  每局的 `outcome` 额外带**具名**结果类：`{ class, label, hint }`
  （服务端判定，见 SPEC §10.122；页面照抄，不再自己猜"这局算成功还是失败"）。

GET /api/sessions/:id
→ 200 {
    meta: SessionMeta,                      // 含完整 manifest + gameVersion
    telemetry: TelemetrySnapshot,           // 该局结束时的最终遥测
    events: GameEvent[],                    // 该局最近 N 条（默认 300，可 ?limit=）
    audit: { type: string; ts: number; [k: string]: unknown }[]   // audit.jsonl 解析
  }
→ 404 { error }

GET /api/sessions/groups?by=model|seed|backend
→ 200 { by: string, groups: [{ key, count, sessions: string[] }] }
→ 400 { error }                            // 未知的分组维度
```
分组键**由服务端给**（读度量行自己的字段）："哪个模型"有两个来源（请求的 vs 实际服务的），
页面自己按字符串猜就会和账本对不上。`model` 用 `manifest.servedModel`。

### 3.4 旧字段的处置

`GET /api/llm` 的旧字段已收敛进 `selection` / `status`，**不保留双形状**（避免第二个事实源）。
---

## 4. WS 协议

```
{ "type": "snapshot",  "data": { date, companies, totalEvents, recent, telemetry, sessionId, checkpoints } }
{ "type": "event",     "data": GameEvent }        // 游戏事件（原样）
{ "type": "telemetry", "data": TelemetrySnapshot }  // 遥测变化（节流 ≥ 250ms）
{ "type": "step",      "data": StepRecord }         // 单步（用于即时追加）
{ "type": "checkpoint","data": SessionCheckpoint }  // 阶段性总结（运行中产生）
```

- 新客户端连上：先收一帧 `snapshot`（含 `telemetry` 全量），此后收增量。
- 后端**必须节流** telemetry 帧（≥250ms），否则 thinking delta 会刷爆 WS。
- **`checkpoint` 必须在运行中产生**（`--agent` 每 decision turn 一条；`--watch` 每约 60
  事件一条），且 `snapshot.checkpoints` 带**全量 backlog**（含最终条）——否则
  「阶段性总结」面板在整局运行期间恒为空（见 `docs/DASHBOARD-UI.md` §7）。
- **`snapshot.sessionId`** 供 Live 页在遥测缺席（watch 模式）时仍能显示当前局 ID。
- **Session 状态可能是派生的**：`GET /api/sessions[/:id]` 返回的 `status` 已经过
  `effectiveStatus()` 处理——心跳超时的 `running` 会呈现为 `interrupted`。
  客户端**不得**再把 `running` 当作"一定活着"（见 `docs/STARTUP-AND-LIFECYCLE.md` §5）。

---

## 5. UI 分类与 Tag 规则（前端唯一实现）

`categoryOf(kind)`（**唯一实现**：`assets/js/charts.js`；分类只有 date / economy / company /
vehicle / station / town / industry / script / protocol / other 十类，每个 Tag 有稳定配色
`TAG_COLORS[category]`）——**本文档不再抄一份映射**，抄了就会漂移。

**关键字段摘要**（`briefOf(ev)` → 一行人类可读文本，替代裸 JSON）：`economy` → `£297.8k cash ·
income £1.2k · loan £100k`；`date` → `1950-03-01`；`company_info` → `#0 "EX work" · AI · president …`；
`gamescript` → `cmd=build_bus_route job=100`（含 `kind:ack/state/...`）；其余 → 紧凑键值对（最多
6 个字段），**不是** 140 字符截断的 JSON。

**保留原始形态**：每条事件提供「展开」按钮显示完整 JSON（满足"保留当前原始 log 形式"）。

---

## 6. 模块契约（后端新增文件）

→ **[`DASHBOARD-BACKEND.md`](DASHBOARD-BACKEND.md)**（遥测 / Session / provider 目录 /
凭据 / provider 装配 / `LlmConfig` 的契约）。线路形状在本文件；模块保证在那一篇。



### 3.5 跨局记忆 `/api/evolution`（v0.6.x）

`GET /api/evolution` — 进化层只读视图。缺 hook 时 404。

```json
{
  "metrics":    [ /* 每局一条 GameMetric，含 memory:{lessonsInjected,strategiesInjected} */ ],
  "lessons":    [ /* Lesson[]，按"更可信者胜"收敛后的库 */ ],
  "strategies": [ /* StrategyCard[]，候选池（含未通过门槛/未确认的） */ ],
  "normalizedSeries": [ /* 能力趋势的点：{ at, deliveredPerLine, operatingProfitPerLine,
                              deliveredPerVehicle, operatingProfitPerVehicle }，
                            按 at 从旧到新；**没测到是 null**（不是 0）——断点由页面画 */ ]
}
```

`POST /api/evolution/strategies/:id/enabled` + `{"enabled": true|false}`
—— SPEC §5.3 的**人工确认**闸门。这是本 API 唯一的写操作：
引擎只给建议，未经人工确认的策略不会参与注入。未知 id 返回 404（不假装成功）。

**注意** `strategies` 返回的是**候选池**，不是"可注入集合"。
可注入需要**两道独立的闸**同时通过：SPEC §5.3 的证据门槛（价值>阈值 且 已验证局≥2）
与人工确认标志。见 `docs/EVOLUTION.md` §2.2。

### 3.6 动作面（live）

```
GET /api/capabilities
→ 200 {
    generatedFrom: "actions",
    actions: [
      {
        name: string,                 // "observe" | "build_bus_route" | …
        effect: "read" | "write",     // 是否会改变游戏状态
        gate: {                       // null = 本局可用；否则说明本局不可用及原因
          key: string,                // "memory" | "gs_channel"（与 catalog.ts 的 TOOL_GATES 同源）
          reason: string              // 给模型看的原因（与工具拒绝时返回的文案**同一句**）
        } | null,
      },
      …
    ]
  }
→ 404 { error: "capabilities disabled" }   // 服务端未装配 capabilities hook（详见下）
```

设计要点（也是 v0.6.x 已达成的“动作面是一份事实”的基本约束）：

- **列表派生自活的工具数组**（`src/agent/tools/index.ts: createTools()`），
  而**不是**另一份手工名单：名称不可能漂移、新工具不表态会被守卫拦截
  （`test/unit/agent-tools.test.ts` 里 `ACTION_EFFECTS` 重放证明）。
- **门控键与原因文案与工具拒绝同源**（共用 `wiringRefusal()`），面板不会
  替 harness 说谎。
- `gate.reason` 是**给模型看的那一句**（“no memory is available…”），
  面板把它原样渲染给运营者，这样“动作为什么不工作”在 harness 与页面是同一句话。

**缺失语义**：服务端可以在 `WebServer` 创建器里选择不传 `capabilities` hook，
例如独立的 `--watch` 模式（无 agent）或纯静态 HTTP。与 `/api/telemetry` 一致：
**返回 404**，不是 200 + 空对象—— 面板据此**隐藏**，避免假装“环境中一个动作都没有”。

### 3.7 因果时间线（v0.6.x，B3）

```
GET /api/sessions/:id/timeline?limit=20&offset=0
→ 200 { rows: [{
    turn, trigger, ts, gameDate, goal,        // goal = 模型自述的目标（可为 null）
    tools: [{ tool, ok, summary, job }],     // job = 该工具下的 GS 单
    jobs:  [{ job, command, phases: [{ stage, phase, ts }] }],
    effect: { gameDays, money, income, vehicles, stations, delivered } | null,
  }], total, offset }
→ 404 { error }                               // 未知 session / 未装配 timeline hook
```

**一行 = 一次决策**（归属靠窗口：上一次决策之后、下一次决策之前）；**四段证据由 `job` 连接**
（工具下的单 → GS job → 相位 → 效果＝与下一次决策快照的差）。`effect` 为 `null` 表示**还没有
下一次快照**（"没测到"，不是"什么都没变"）。页面**不重算**：增量由服务端量出，缺失显示
`not measured`（不折成 0）。

### 3.8 Compare（v0.6.x，B4）

```
GET /api/compare?models=A,B&seed=7&backend=harness[&group=<groupId>]
→ 200 {
    conditions: BenchConditions,
    groups: [{ id, scaffoldHash, observationShapeHash, observationPolicy,
               runs, models, firstStartedAt, lastStartedAt }],   // "同一个问题"的分组
    selectedGroupId: string | null,                             // 下面的数字属于哪一组
    runsOutsideGroup: number,                                   // 别的组里的局（**不混进任何数字**）
    models: [{ model, requestedModels, runs, excluded, excludedReasons,
               ability, efficiency, stability: { …, outcomeDistribution:
                 [{ code, label, hint, count }] },   // 十类结局（服务端命名）
               growth }],   // 四轴（scorecard.ts）
    exclusions: [{ reason, count }],                        // 排除**按原因计数**
    comparison: { design: "paired", modelA, modelB, pairs, meanDiff, diffCi95,
                  verdict, message } | null,                 // 两个模型才有
    runs: [{ id, model, seed, backend, status, excluded, deliveredPerGameDay,
             deliveredRun, simulatedDays, totalTokens, costKnown, costTotal,
             lines, deliveredPerLine, operatingProfitPerLine,
             deliveredPerVehicle, operatingProfitPerVehicle }],
  }
→ 404 { error }                                            // 未装配 compare hook
```

**只读**：端点不写文件、不发起运行，只从**已有的度量行**算出。四轴来自 `buildScorecard`，
配对判定来自 `pairedComparison`，排除原因来自 `metricExclusion`——**页面不重算、也不下判断**
（含 `not determinable` 这类结论）。`costPerRun` 在**无价目表**的模型上是"没测到"，不是 `$0`。

**归一化读数（每条线 / 每辆车）**：`models[].ability.normalized` 是**均值 + 中位数**
（一条线都没建的局**不计入**，不是 0）；`runs[]` 里是**逐局**的同名读数（`lines` 是分母，
`null` = 没测到）⇒ 页面的"均值表 / 逐局表"两种模式**都读服务端这两处**，页面不重算。
**两条轴的单位不同**（每条线 / 每辆车 vs 每游戏日）⇒ 不共用一把尺子（见 `DASHBOARD-UI.md`）。

**分组（Issue #13 的决定 (b)）**：分组键 = **manifest 自己的三元组**（`scaffoldHash` +
`observationShapeHash` + `observationPolicy`）——脚手架、观测面结构、暴露的世界切片。不同 ⇒
**不是同一个问题** ⇒ 不混在一张表里比。一次只比**一组**：`group=<id>` 点名，默认组 = **局数
最多**的那组（2026-10-31 那轮 6 格基准因此自成一组）。别的组的局数由 `runsOutsideGroup` 披露，
**不折成 0、也不静默丢弃**。字段没记录过的局，其键为 `null`（"not recorded"，不是猜一个值）。

### 3.8b 比较计划（v0.6.x，Issue #48）

```
POST /api/compare/plan      body { models: [A,B], seeds: [7,8], gameDays?, tokenLimit?, costLimit? }
→ 200 { plan: { cells: [{ model, seed, facts: { providerId, model, api, contextWindow,
                                               maxTokens, costKnown } }],
              runCount, gameDays, tokenLimit, costLimit, thinkingLevel, toolBudget,
              memoryArm, scenario, backend, scaffoldHash, costKnown,
              problems: [] },
        problems: [] }
POST /api/compare/launch    body 同上
→ 200 { plan, problems: [], state: { status, total, completed, failed, current, cells } }
→ 400 { error, problems }      // 计划非法（旋钮/未知模型/无价目表却设了费用上限）
→ 409 { error }                // 已有运行或已有比较在跑（一局都没启动）
GET  /api/compare/plan        → 200 { status, total, completed, failed, current, cells }
```

**计划只估"运行"，不估结果**：几局、封顶、花费**能不能测**。字段名与 manifest 同名同义 ⇒
计划与跑完的 manifest 可逐字段比。`costKnown` 只有在**每格**的模型都有价目表时才是 true，
否则是"没测到"。格子**顺序**跑（一个进程只能跑一局）：一格失败被记下、后面的格子继续。

### 3.9 运行控制面（v0.6.x，B2）

```
GET  /api/run → 200 { state, mode, sessionId, startedAt, error }

POST /api/run/start
  body { mode?: "agent"|"watch", knobs?: { seed?, gameDays?, scenario?, memoryArm?,
                                          thinkingLevel?, toolBudget?, tokenLimit?,
                                          costLimit?, backend? } }
  - knobs 的值**原样**转发给 agent 层（web 层不认识旋钮，规则只有一份）。
  - 省略的字段 = 沿用**进程**的设置（env/CLI）；空串等同于省略。
→ 200 { state, mode, sessionId, startedAt, error }
→ 400 { error, problems: [{ code, message, hint }] }   // 非法旋钮；**没有游戏进程被启动**
→ 409 { error }                                       // 已有运行（冲突，不是坏请求）

POST /api/run/preview
  body { knobs?: { …同上… } }
→ 200 { preview: NextRunPreview | null, problems: Problem[] }
→ 404 { error }                                       // 服务端未装配 run hook
```

**`NextRunPreview` 的字段名 = manifest 的字段名**（同名同义）：解析后的模型事实 `model` /
`api` / `contextWindow` / `costKnown`（不是配置文件里可能过时的值）；本局生效的旋钮
`thinkingLevel` / `toolBudget` / `tokenLimit` / `costLimit` / `backend`；`scaffoldHash`
（提示词 + 工具 schema 的指纹，**不用开游戏**就能算出）；`observationShapeHash`（**观测面的
结构**指纹：有哪些世界事实、什么类型；值全抹掉 —— 只依赖代码，所以也**跑前就能算**，且
跨 seed 稳定）；仅预览有的补充事实 `providerId` / `maxTokens` / `seed` / `gameDays` /
`scenario` / `memoryArm`。

跑完才知道的字段（`servedModel` / `payloadHash` / `payloadShapeHash` / `payloadCount`）
**不在预览里**：预览只承诺它能兑现的（D79）。**预览与启动用同一条闸**：无法执行的花费上限
（模型无价目表）在预览里就被拒，不会预览出一局跑不起来的运行。

**问题码**（`src/agent/problems.ts`）：`invalid_knob`（旋钮非法）·
`unpriced_with_cost_cap`（无价目表却设了费用上限）· `unknown_provider` / `unknown_model` /
`no_credential`（没凭据）/ `invalid_base_url` / `provider_unavailable`（连不上）·
`endpoint_401`（key 被拒）/ `endpoint_403`（key 无权列模型）/ `no_model_endpoint`（没有
/models 端点）。**每个 code 只有一个规范 hint**（`problemHint`）：生产方只写"发生了什么"，
"下一步做什么"由词表给——同一个错在任何页面都长一个样，页面**不再用正则猜**。

### 3.10 线路诊断 `GET /api/run/diagnose`（Issue #113）

```
GET /api/run/diagnose[?job=<id>]
→ 200 { available: true, diagnoses: RouteDiagnosis[], facts: RouteDiagRoute[], errors: string[] }
→ 404 { error }   // 没有正在跑的局
→ 503 { error }   // 这一局没有 GS 通道（watch / observe-only）
→ 400 { error }   // job 不是数字
```

**按需**：不在周期载荷里（周期载荷不涨，SPEC §10.126），只在人点"why?"或模型调
`diagnose_route` 时问一次游戏。

**`RouteDiagnosis`** = `{ job, reason, label, detail }`：
- `reason` 是**封闭词表**里的 id（`src/agent/route-diagnosis.ts` 的 `ROUTE_DIAGNOSIS_REASONS`）；
- `label` 是服务端的**规范措辞**（一个 code 只有一份措辞；前端按 id 翻，没翻时用 `label`）；
- `detail` 是一句人话（给模型看的那一份）。

**`facts`** 是 GS 的原始读数（每端的车站/等待量/收货额度/评分/相邻路数，每辆车的位置/
订单/载量）。**缺读数按约定区分**：`-1` = 没测到（等待量、评分、改装载量）；
`null` = 没测到；`0` 在**收货额度**与**相邻路数**上是**真读数**（"不收货"/"没有相邻的路"）
⇒ 页面不许把它们画成同一件事。

**页面不许重算**：页面与 agent 的 `diagnose_route` 工具走**同一个** `diagnoseRoutes`
⇒ 人看到的理由与模型看到的是同一份，不会各说各话。

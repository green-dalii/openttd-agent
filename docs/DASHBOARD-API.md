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
  pages/                 # 一个页面一个 HTML（只放 HTML）
    live.html            #   Live  ：实时游戏 + agent 遥测
    llm.html             #   Providers：provider 目录选型 + 密钥
    sessions.html        #   Sessions：历史局管理 / 复盘
  assets/
    css/style.css        # 全部样式（单文件，无预处理器）
    js/
      common.js          # 共享：DOM/格式化/事件分类/WS 客户端/绘图/导航
      live.js            # 页面脚本：live.html
      providers.js       # 页面脚本：llm.html
      sessions.js        # 页面脚本：sessions.html
```

**URL 路由表**（`src/web/server.ts` 的 `PAGES`，单一事实源）:

| URL | 文件 | 职责 |
|---|---|---|
| `GET /` | `pages/live.html` | Live：实时游戏 + agent 遥测 |
| `GET /llm` | `pages/llm.html` | Providers：provider 目录选型 + 密钥（独立子页） |
| `GET /sessions` | `pages/sessions.html` | Sessions：历史局管理 / 复盘 |

- URL 保持**扁平**（`/llm` 而非 `/pages/llm.html`）——文件可自由挪动，链接不会断。
- 新增一个页面 = `pages/` 加一个 HTML + `assets/js/` 加一个脚本 + `PAGES` 加一行。
- 强制约束（单测锁定 `web-api.test.ts`）:
  - `public/` 根目录**不得**再有散落的 html/css/js；
  - 每个 `PAGES` 目标文件必须存在且返回 200（路由不会静默 404）；
  - HTML 里的每个 `/xxx` 引用必须指向真实存在的文件（防手误改路径）；
  - `pages/**` 只放 `.html`、`assets/css/**` 只放 `.css`、`assets/js/**` 只放 `.js`。
- **禁止引入构建链**（无 bundler/预处理/外部 CDN，离线可用）。

---

## 2. 类型（后端 TS 与前端 JS 必须一致）

### 2.1 Usage（token 计量；全部为 number）

```ts
interface UsageView {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;      // 缺失时填 0
  totalTokens: number;
  costTotal: number;      // Usage.cost.total
}
```

### 2.2 StepRecord（一步 = 一条 assistant 消息 或 一次工具执行）

```ts
interface StepRecord {
  id: string;             // 会话内单调: "s1", "s2", ...
  ts: number;             // epoch ms
  turn: number;           // 1-based（agent turn）
  kind: "message" | "tool";

  // kind === "message"
  text?: string;          // 可见文本（拼接 text 块）
  thinking?: string;      // 思考文本（拼接 ThinkingContent / thinking_delta）
  model?: string;
  provider?: string;
  stopReason?: string;    // "stop" | "toolUse" | "length" | "error" | "aborted" | ...
  usage?: UsageView;

  // kind === "tool"
  tool?: string;
  args?: unknown;
  ok?: boolean;
  summary?: string;
  data?: Record<string, unknown>;
  durationMs?: number;
}
```

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
  };
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
  startedAt: number;
  endedAt?: number;
  seed: number;
  startYear: number;
  mapSize: [number, number];
  serverName: string;
  companyName: string;
  llm: { providerId: string; model: string; api: string; kind: "real" | "faux" };
  outcome?: {
    constructionDone?: boolean;
    phase?: string;
    vehicles?: number;
    stations?: number;
    money?: string;
    totalEvents?: number;
  };
  totals: {
    events: number;
    decisions: number;
    toolCalls: number;
    toolFailures: number;
    usage: UsageView;
  };
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

### 2.6 Provider catalog

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
  - catalog 选择时 baseUrl/api 由目录决定，忽略客户端传入。
→ 200 同 GET /api/llm 的形状（保存后的视图）

GET /api/llm/catalog
→ 200 { generatedAt: number | null, providers: CatalogProvider[] }

GET /api/llm/catalog/:providerId
→ 200 { provider: CatalogProvider, models: CatalogModel[] }
→ 404 { error }

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

GET /api/sessions/:id
→ 200 {
    meta: SessionMeta,
    telemetry: TelemetrySnapshot,           // 该局结束时的最终遥测
    events: GameEvent[],                    // 该局最近 N 条（默认 300，可 ?limit=）
    audit: { type: string; ts: number; [k: string]: unknown }[]   // audit.jsonl 解析
  }
→ 404 { error }
```

### 3.4 旧接口兼容

`GET /api/llm` 的**旧字段**（`providerId/baseUrl/model/api/contextWindow/maxTokens/hasApiKey/configured`）
不再单独存在于顶层——已收敛进 `selection` / `status`。**前端全部改用新形状。**
（不保留双形状：避免第二个事实源。）

---

## 4. WS 协议

```
{ "type": "snapshot",  "data": { date, companies, totalEvents, recent, telemetry } }
{ "type": "event",     "data": GameEvent }        // 游戏事件（原样）
{ "type": "telemetry", "data": TelemetrySnapshot }  // 遥测变化（节流 ≥ 250ms）
{ "type": "step",      "data": StepRecord }         // 单步（用于即时追加）
```

- 新客户端连上：先收一帧 `snapshot`（含 `telemetry` 全量），此后收增量。
- 后端**必须节流** telemetry 帧（≥250ms），否则 thinking delta 会刷爆 WS。

---

## 5. UI 分类与 Tag 规则（前端唯一实现）

`categoryOf(kind)`：

| category | kinds |
|---|---|
| `date` | `date` |
| `economy` | `company_economy` `company_stats` |
| `company` | `company_new` `company_info` `company_remove` |
| `vehicle` | `vehicle_new` `vehicle_info` `vehicle_update` |
| `station` | `station_new` `station_info` |
| `town` | `town_new` `town_info` |
| `industry` | `industry_new` `industry_info` |
| `script` | `gamescript` |
| `protocol` | `welcome` `protocol` `error` `rcon_end` `console` |
| `other` | 其它 |

每个 Tag 有稳定配色（前端 `TAG_COLORS[category]`）。

**关键字段摘要**（`briefOf(ev)` → 一行人类可读文本，替代裸 JSON）：
- `economy` → `£297.8k cash · income £1.2k · loan £100k`
- `date` → `1950-03-01`
- `company_info` → `#0 "EX work" · AI · president …`
- `gamescript` → `cmd=build_bus_route job=100` （含 `kind:ack/state/...`）
- 其余 → 紧凑键值对（最多 6 个字段），**不是** 140 字符截断的 JSON。

**保留原始形态**：每条事件提供「展开」按钮显示完整 JSON（满足"保留当前原始 log 形式"）。

---

## 6. 模块契约（后端新增文件）

### 6.1 `src/agent/telemetry.ts`

```ts
export class Telemetry {
  constructor(opts?: { limit?: number; sessionId?: string });
  setBrain(b: { provider: string; model: string; kind: "real" | "faux" }): void;
  /** 计数一个决策点（runDecision 之前调用）。 */
  decisionPoint(): void;
  /** 喂 pi-agent-core 的 AgentEvent。 */
  ingestAgentEvent(ev: AgentEvent): void;
  snapshot(): TelemetrySnapshot;
  /** 每条 StepRecord 完成时回调（runner 用它做 JSONL 审计 + WS 推送）。 */
  onStep?: (rec: StepRecord) => void;
  /** 遥测发生变化时的轻量通知（runner 用于节流广播）。 */
  onActivity?: () => void;
}
```

要求：
- 只消费 `AgentEvent`（`message_update` 累积 thinking/text delta；`message_end` 落下
  带 `usage` 的 message step；`tool_execution_start/end` 产出 tool step 并算 duration）。
- **纯累积、无 IO、无网络**，便于单测（用 `fauxAssistantMessage`/手造事件）。
- `usage.total` = 所有 message step 的 `Usage` 逐项相加；`costTotal` 相加。
- `reasoning` 缺失按 0；`byTool` 的 `avgDurationMs` 为整数（四舍五入）。

### 6.2 `src/agent/session-store.ts`

```ts
export function newSessionId(seed: number, at?: Date): string;   // "20260910-213000-seed7"
export class SessionStore {
  constructor(dataDir: string);
  create(meta: Omit<SessionMeta, "checkpoints" | "totals"> & Partial<Pick<SessionMeta,"checkpoints"|"totals">>): SessionMeta;
  update(patch: Partial<SessionMeta>): SessionMeta;     // 写 meta.json + 刷新 index.json
  addCheckpoint(cp: SessionCheckpoint): void;
  appendEvent(ev: GameEvent): void;                      // events.jsonl
  appendAudit(rec: Record<string, unknown>): void;       // audit.jsonl
  saveTelemetry(t: TelemetrySnapshot): void;             // telemetry.json（末次全量）
  finalize(patch?: Partial<SessionMeta>): SessionMeta;
  get id(): string;
}
export function listSessions(dataDir: string): SessionMeta[];      // 读 index.json, newest first
export function readSession(dataDir: string, id: string, opts?: { limit?: number }): {
  meta: SessionMeta; telemetry: TelemetrySnapshot; events: GameEvent[]; audit: unknown[];
} | null;
export function buildStageSummary(meta: SessionMeta, gameDate: string, turn: number): string;
```

要求：
- 全部 IO 用 `node:fs`；**写入失败不得抛穿到 agent 循环**（try/catch + 忽略，审计同款语义）。
- `index.json` = `{ sessions: SessionMeta[] }`（newest first，最多留 200）。
- 目录：`<dataDir>/sessions/<id>/{meta.json,events.jsonl,audit.jsonl,telemetry.json}`。

### 6.3 `src/agent/provider-catalog.ts`

```ts
export function listCatalogProviders(): CatalogProvider[];          // 39 个，按 id 排序
export function listCatalogModels(providerId: string): CatalogModel[];
export function getCatalogProvider(providerId: string): CatalogProvider | undefined;
export function isCatalogProvider(providerId: string): boolean;
export function catalogGeneratedAt(): number | null;
```

要求：基于 `@earendil-works/pi-ai/providers/all`（`getBuiltinProviders` / `getBuiltinModels`）。

**`envKeys` 的求法（重要，勿“想当然”改回）**: pi-ai **不**在 provider 对象上暴露
环境变量清单（`envApiKeyAuth(name, envVars)` 把清单闭包掉了；anthropic/google 还用
自写 `resolve()` 读取 `ANTHROPIC_AUTH_TOKEN`/`GEMINI_API_KEY` 等非约定名）。
`findEnvKeys(id)` 也不返回“期望的名字”，而是返回**当前环境中已设置的**名字，
因此直接调用会得到 `undefined`（local 开发极易踩）。
正确做法（本仓库已验证 31/39）: 用**合成 env 探测** ——
对候选名逐个调用 `findEnvKeys(id, { [候选名]: "probe" })`，只有 pi-ai 真正接受的
名字才会被返回（**不触碰真实 process.env**）。候选 = 命名约定
（`ID_API_KEY` / 去分隔符版）+ 已核实的例外表（huggingface→`HF_TOKEN`、
google→`GEMINI_API_KEY`、moonshotai→`MOONSHOT_API_KEY`、kimi-coding→`KIMI_API_KEY`、
vercel-ai-gateway→`AI_GATEWAY_API_KEY`、azure-openai-responses→`AZURE_OPENAI_API_KEY`、
anthropic→三件套含 OAuth token）。
剩余 8 个（amazon-bedrock / google-vertex / github-copilot / openai-codex /
cloudflare-ai-gateway / cloudflare-workers-ai / opencode-go /
qwen-token-plan-individual）**没有** API-key 环境变量，改为返回 `hint` 文案
（AWS profile / ADC / OAuth 登录等），UI 据此给正确指引。
`auth.configured` / `auth.source` 用 `builtinModels({credentials}).checkAuth(id)` 判定：
`undefined` → `{configured:false, source:"none"}`；`source === "stored credential"` → `"stored"`；
其余（环境变量名）→ `"env"`。
**懒加载 + 记忆化**（目录较大，勿每次重建）。

### 6.4 `src/agent/file-credential-store.ts`

```ts
export class FileCredentialStore implements CredentialStore {
  constructor(file: string);   // <dataDir>/credentials.json
}
```

要求：实现 pi-ai 的 `CredentialStore`（`read/list/modify/delete`），JSON 落盘，
`modify` 串行化（per-provider promise chain，参照 `InMemoryCredentialStore` 语义），
文件权限 `0o600`，解析失败按空处理。

### 6.5 `src/agent/provider.ts` 扩展

```ts
export async function buildBrain(llm: LlmConfig, opts: { credentials?: CredentialStore }): Promise<BuiltProvider>;
```

要求：
- `source === "catalog"`（providerId 命中目录）→ 用 `builtinModels({ credentials })` +
  `getBuiltinModel(provider, model)`（或 `models.getModel`）拿 `Model`，`streamFn` 走
  `models.stream(model, context, options)`。**不再手建 provider。**
- 否则走现有 `custom` 路径（`createProvider` + 显式 baseUrl/apiKey，保持向后兼容）。
- 保留 `isLlmConfigured` 语义：catalog 模式下 model 非空即视为可配置（key 可由 env 提供）。

### 6.6 `LlmConfig` 扩展（`src/config.ts`）

新增字段（全部可选、向后兼容）：
```ts
source?: "catalog" | "custom";   // 默认: baseUrl 为空 => "catalog"（若 providerId 命中目录）否则 "custom"
```
`<dataDir>/llm.json` 同步新增 `source`。**旧文件（无 source）必须照旧可读。**

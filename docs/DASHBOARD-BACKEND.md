# DASHBOARD-BACKEND — 看板背后的后端模块契约

> **职责**：本文件回答一个问题：**看板依赖的那些后端模块各自承诺什么**
> （遥测累积、Session 落盘、provider 目录、凭据存储、provider 装配、LLM 配置）。
>
> **不含**：HTTP / WebSocket 的**线路形状**（→ [`DASHBOARD-API.md`](DASHBOARD-API.md)）；
> 页面与交互（→ [`DASHBOARD-UI.md`](DASHBOARD-UI.md)）；模型看到什么（→ 脚手架契约）。
>
> **为什么单独成篇**：模块契约与线路契约是**两个问题**——一个是"这些模块保证什么"，
> 一个是"页面能拿到什么形状"。挤在一份里，两边都要为对方的篇幅付账。


### 6.1 `src/agent/telemetry.ts`

接口：`Telemetry{ constructor({limit?, sessionId?}), setBrain, decisionPoint, ingestAgentEvent, snapshot, onStep?, onActivity? }`。

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
  create(meta): SessionMeta; update(patch): SessionMeta;      // 写 meta.json + 刷新 index.json
  addCheckpoint(cp): void; appendEvent(ev): void;              // events.jsonl
  appendAudit(rec): void; saveTelemetry(t): void;              // audit.jsonl / telemetry.json
  finalize(patch?): SessionMeta; get id(): string;
}
export function listSessions(dataDir: string): SessionMeta[];      // 读 index.json, newest first
export function readSession(dataDir, id, opts?): {
  meta: SessionMeta; telemetry: TelemetrySnapshot; events: GameEvent[]; audit: unknown[];
} | null;
export function readSessionTimeline(dataDir, id, opts?): { rows; total; offset } | null;  // 因果时间线
export function sessionHooks(dataDir: string): SessionHooks;   // **唯一的** hook 构造（server 与 runner 共用）
export function buildStageSummary(meta, gameDate, turn): string;
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
环境变量清单（`envApiKeyAuth` 把清单闭包掉了；anthropic/google 还用自写 `resolve()`
读 `ANTHROPIC_AUTH_TOKEN`/`GEMINI_API_KEY` 等非约定名）；`findEnvKeys(id)` 返回的也是
**当前环境中已设置**的名字（直接调用 ⇒ `undefined`，local 开发极易踩）。
正确做法（本仓库已验证 31/39）: 用**合成 env 探测** —— 对候选名逐个调用
`findEnvKeys(id, { [候选名]: "probe" })`，只有 pi-ai 真正接受的名字才会被返回
（**不触碰真实 process.env**）。候选 = 命名约定（`ID_API_KEY` / 去分隔符版）+
已核实的例外表（名单见 `src/agent/provider-catalog.ts`）。剩余 8 个**没有** API-key
环境变量（bedrock / vertex / copilot / codex / cloudflare×2 / opencode / qwen-plan），
改为返回 `hint` 文案（AWS profile / ADC / OAuth 登录等），UI 据此给正确指引。
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

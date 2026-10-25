# 运行配置的选择与真值（CoDesign，待审核）

> **这份文档回答一个问题**：用户在 Providers 页选的东西，凭什么等于**下一次运行真正用的东西**？
> 现在的答案是不凭什么——它有四份副本、三种校验、两个 API 值，而页面显示的和运行时用的不是同一个来源。
> 本文是**方案**，不是实现记录；通过后再改代码。
> 事实来源：2026-10-24 的真机复现（命令与输出见 §2）。边界声明见 `AGENTS.md` §9。

---

## 1. 第一性原理：一次运行只有一个配置真值

一次运行需要唯一一个答案：`(provider, model, api, baseUrl, auth, limits, scaffold)`。
它可以**被编辑**（页面上），可以被**存储**（`llm.json` + `credentials.json`），但**推导只能发生一次**。

今天推导发生了四次，各自独立：

| 位置 | 它认为的 "model" | 后果 |
|---|---|---|
| `llm.json`（磁盘） | 用户刚保存的 | 唯一正确的那个 |
| `deps.cfg`（serve 启动快照） | 启动那一刻的值 | **掩盖保存结果**（`cfg.x \|\| file.x` 的 `\|\|`） |
| 页面状态（Alpine `this.model`） | 用户点选的值 | 与磁盘无关 |
| 右侧面板 `effectiveRows()` | 目录里的模型对象 | 与 `selection` 无关（未知模型显示 `API —`） |

**判据**：如果"页面显示的模型"与"运行使用的模型"可以不同，那么**任何**关于配置的界面文案都是猜测。
这不是 UI 细节，而是把两个真值源接在了一起。

---

## 2. 真机复现（2026-10-24，`/tmp/openttd-agent-data`）

```
POST /api/llm {"source":"catalog","providerId":"minimax-cn","model":"MiniMax-M3.1-Flash"}
→ 200 {"selection":{"model":"MiniMax-M3.1", ...}}      ← 响应里是旧值
llm.json → model: "MiniMax-M3.1-Flash"                   ← 磁盘是对的
GET /api/llm → model: "MiniMax-M3.1"                     ← 同一进程内一直是旧值
（重启 serve）GET /api/llm → "MiniMax-M3.1-Flash"        ← 只有重启才看见
```

同时：保存的 `api` 是 `openai-completions`，而该模型真实 api 是 `anthropic-messages`
（`save()` 对 catalog 选择**强制**沿用 `cur.api`）。

四条互相矛盾的路径（都已实测）：

1. **保存**：接受任何模型 id（包括快照里没有的），写入文件，返回旧视图。
2. **视图**：`applyLlmSettingsFile(deps.cfg)` 中 `cfg.llm.x || file.x` ⇒ 进程启动快照赢 ⇒ 保存不可见。
3. **门禁**：`probeLlmReal` 调 `buildBrain(cfg.llm, { credentials })`，**没传 `modelsStore`**
   ⇒ 实时刷新得到的模型在这里是 "unknown model" ⇒ 门禁红，而运行路径其实能跑。
4. **运行**：`runCfg = applyLlmSettingsFile(cfg)`（重新读盘）+ `modelsStore`
   ⇒ 用的是新模型。**运行是对的，页面是错的，门禁是第三种答案。**

---

## 3. 问题清单（按"会不会骗人"排序）

| # | 问题 | 类型 | 证据 |
|---|---|---|---|
| A1 | 视图读启动快照，保存后不生效 | **撒谎** | §2 的 POST/GET |
| A2 | 保存响应返回旧视图（调用方只能信它） | **撒谎** | 同上 |
| A3 | catalog 保存把 `api` 固定成 `cur.api` | 数据错误 | `llm-api.ts` `source === "custom" ? apiCandidate : cur.api` |
| A4 | 未知模型静默接受 → 运行时/门禁才失败 | **撒谎** | 保存 200，`buildBrain` 抛错 |
| A5 | 门禁与运行不是同一份解析（`modelsStore` 缺失） | **撒谎** | §2 第 3 条 |
| B1 | 选中的模型不在快照里时，右侧面板 `API —`、Context `—` | 展示不全 | 截图 |
| B2 | `/api/llm` 的 `contextWindow/maxTokens` 来自配置默认值，不是模型的真实值 | 数据错误 | `selection` 128000/4096 vs 目录 1M/512k |
| B3 | 目录快照是 2026-09-04 的，页面只显示数量、不显示年代 | 展示不全 | 已修一半（freshness 行） |
| C1 | 自定义端点没有模型列表 | 缺失能力 | 页面仅有文本框 |
| C2 | 刷新只在 catalog 模式；`models()` 同步触发一次异步恢复但不等待 | 竞态 | `llm-api.ts` `void liveCatalog.refresh(...)` |
| C3 | 刷新失败原因是非结构化字符串，页面用正则猜"该做什么" | 结构缺失 | `providers-view.js` `refreshHint()` |

---

## 4. 方案：一个解析器，页面只渲染

### 4.1 新增唯一解析器 `src/agent/selection.ts`

```ts
export interface SelectionProblem {
  code: "unknown_provider" | "unknown_model" | "no_credential" | "unpriced_with_cost_cap"
      | "invalid_base_url" | "provider_unavailable";
  message: string;          // 发生了什么
  hint: string;             // 下一步做什么（可执行）
}
export interface ResolvedSelection {
  intent: { source: "catalog" | "custom"; providerId: string; model: string; api?: string; baseUrl?: string };
  resolved: { providerId: string; model: string; api: string; baseUrl: string;
              contextWindow: number; maxTokens: number; priceKnown: boolean; modelKnown: boolean };
  usable: boolean;                       // 能不能真的开跑
  problems: SelectionProblem[];
}

/** 唯一推导：页面视图、保存校验、门禁、运行都调它。 */
export function resolveSelection(input: {
  cfg: Config; stores: { credentials: CredentialStore; modelsStore: ModelsStore };
}): Promise<ResolvedSelection>;
```

四条路径改为：

| 路径 | 现在 | 改成 |
|---|---|---|
| `GET /api/llm` | 读启动快照 | `resolveSelection(loadConfig())`（**每次读盘**） |
| `POST /api/llm` | 写文件 → 返回旧视图 | 写文件 → `resolveSelection` → **`usable=false` 时 400 + problems**（文件不写） |
| preflight | 自己 `buildBrain` | 读 `resolveSelection().usable` + `problems`（与运行同一份） |
| runner | 自己 `buildBrain` | 用 `resolved`（`api/ctx/maxTokens` 都来自模型对象，不来自配置默认值） |

**代价**：`GET /api/llm` 会多做一次磁盘读 + pi-ai 注册表查表（微秒级）；`POST` 在拒绝时**不落盘**，
所以"保存成功"从此等于"下一局能用"。

### 4.2 页面状态：`draft` 与 `saved` 分离

- `saved`：**服务器返回的** `ResolvedSelection`（唯一真值，只由响应更新）。
- `draft`：用户正在改的东西（provider/model/baseUrl/key…）。
- 保存 = 提交 `draft` → 200 则 `saved = response`（不是本地回填）→ 页面显示的一律读 `saved`。
- 400 则**保留 `draft`**，把 `problems[]` 逐条显示在对应控件下方（每条带 hint）。
- 刷新页面 = 重新 `GET` → `saved` 与 `draft` 都从它初始化 ⇒ **报告里的"刷新后变回去"在结构上不可能**。

### 4.3 模型列表：一个端点，两种来源，结构化结果

```
GET /api/llm/models?provider=<id>            // catalog：snapshot + 持久化覆盖层
POST /api/llm/models                          // custom：{baseUrl, api, apiKey?} → 现场问端点
→ 200 { models: [{id, api, contextWindow, maxTokens, priceKnown, source: "snapshot"|"live"}],
        snapshotGeneratedAt: number|null, refreshedAt: number|null, problems: SelectionProblem[] }
```

- 页面显示 **"snapshot 2026-09-04（139 天前）· refreshed 2 分钟前 · N live"**，不再只是一个数字。
- `refresh` 的失败原因走 `problems[].code`（`no_credential` / `endpoint_401` / `no_model_endpoint`），
  页面按 code 渲染，**删掉现在用正则猜语义的 `refreshHint()`**。
- custom 模式复用同一个端点（`POST`），因此自定义端点也有列表。

### 4.4 运行配置预览（把"下一次会用什么"说清楚）

页面新增一块只读区，内容**全部来自 `saved.resolved`**：

```
next run → provider minimax-cn / model MiniMax-M3.1-Flash / api anthropic-messages
           context 1M in · 512k out / price unknown / thinking off / tool budget 12
           scaffold 7956ab6d8c86fa60
```

- 运行中保存时不假装生效：文案固定为 **"applies to the next run"**（今天页面也这么说，但没有证据支撑）。
- 与 manifest 的字段同名同义（`thinkingLevel` / `toolBudget` / `scaffoldHash` / `priceKnown`），
  这样"页面说的"和"度量行记的"用的是同一套词。

---

## 5. 实施顺序（每步独立可合并、可回滚）

| 步 | 内容 | 验收（必须全部） |
|---|---|---|
| **S1** ✅ | 修 A1/A2/A3/A4：视图每次读盘；POST 返回保存后的解析结果；catalog 保存写模型的真实 `api`/ctx/maxTokens；未知模型 400 | curl 复现脚本两行：保存后 GET 立刻是**新值**；未知模型得到 400 + 可读原因；不重启。<br>**已实现并真机验证，事实见 `SPEC.md` §10.117** |
| **S2** | 引入 `resolveSelection`，四条路径改用它（含 preflight 的 `modelsStore`） | 单测：同一输入下 GET / preflight / runner **三处解析结果逐字段相同**；live-only 模型门禁转绿 |
| **S3** | 页面 `draft`/`saved` 分离 + 结构化 problems 渲染 | 前端单测（保存→重载仍是新值）；浏览器探针：选未知模型 → 保存被拒且提示可执行；0 控制台 |
| **S4** | 统一模型列表端点（catalog + custom）+ 快照年代展示 | 真机：刷新成功/401/404 三种都显示对应文案；custom 端点能列模型 |
| **S5** | 运行配置预览 + "applies to the next run" 的证据化 | 页面显示的 `model/api/ctx/scaffold` 与下一次运行 manifest **逐字段相同**（真机两局比对） |

---

## 6. 明确不做

- 不在前端做任何**归一化或校验**（模型是否存在、api 是否匹配）——那是解析器的职责；
  页面一旦开始猜，就会再次和运行时分叉。
- 不引入前端框架/状态库：`draft`/`saved` 两个对象 + 一个 `GET` 足够。
- 不改 `docs/DASHBOARD-API.md` 已有的冻结契约形状，只**新增**端点与字段（向后兼容）。

---

## 7. 已决定（2026-10-24，所有者批准）

| 问题 | 决定 |
|---|---|
| 保存即校验（未知模型 400、不落盘） | **接受**。替代方案（保存成功但运行时拒绝）正是本次 bug 的来源 |
| S1 是否先单独发 | **先发 S1**：只修 bug（视图读盘 / 返回真值 / 写真实 api·ctx / 未知模型 400），不动页面结构 |
| next-run 预览的字段 | 采纳建议：`model / api / context / price known / thinking / tool budget / scaffold 前 8 位`；**新增字段必须能在 manifest 里找到同名项** |

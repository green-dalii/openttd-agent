# D6：迁 pi-agent-core `AgentHarness` —— CoDesign（2026-10-24，所有者已批准）

> **职责**：本文件是 D6 的**唯一权威**：为什么这样迁、迁哪些、不迁哪些、每步的验收与回滚，
> 以及执行时**不必再猜**的库事实（带坐标）。
> **边界**：脚手架的对外契约在 `docs/SCAFFOLD-CONTRACT.md`；未完成的进度在
> `ROADMAP.md`「阶段 D」；执行清单在 Issue #12。本文件不重复它们的结论。
>
> **批准的决策**：只做 **D6a + D6b**；**否决 D6c**（全量替换自研 session/telemetry）；
> **D6d**（反事实 fork）等真实 benchmark 跑过一轮再评估。
> **默认值**：D6a 落地时 harness **默认关**（`AGENT_HARNESS=0`），旧路径保留一个版本；
> D6b 完成后再评估是否翻默认。

---

## 1. 为什么是"新增一层"，不是"替换一层"

自研的 `session-store.ts`（725 行）+ `telemetry.ts`（432 行）已经是**看板与度量行的真源**：
5 个页面、`/api/telemetry`、`GameMetric` 的写入点都挂在上面。替换它们的收益是"少维护自研代码"，
代价是重写数据源 + 全量页面回归，而**对 benchmark 的可比性零增益**。

`AgentHarness` 真正独特、且我们现在**没有**的东西只有三样：

1. **可回放的 entry-tree 会话**（`Entry{id,parentId,seq}`，可 fork）——审计有争议的结果；
2. **真实请求 payload**（`before_payload`）——不是从源码算指纹，而是记录发出去的东西；
3. **更丰富的事件流**（`retry_*` / `compaction_*` / `fault`）——故障可见性。

所以：**新增一层（harness 拥有 LLM 转录），旧层不动（自研拥有运行记录与看板）**。

---

## 2. 五处阻抗不匹配与解法

| # | 不匹配 | 事实 | 解法 |
|---|---|---|---|
| **M1** | 单局多决策 vs "一次 prompt = 一个 run" | 我们的循环由**游戏事件**驱动唤醒（phase / interval / wait_until） | **一局 = 一个 harness session + 一个 lane；一次决策 = 一次 `lane.prompt()`**。调度器完全保留 |
| **M2** | 取 plan 的路径 | `lane.prompt()` 返回 `OperationResultRecord`（元数据），**不含消息** | 用 `lane.findEntries({type:"message", order:"newestFirst", limit:1})` 取最后一条 assistant，复用现有 `parsePlanFrom` |
| **M3** | 工具签名与执行顺序 | `AgentHarnessTool.execute(toolCallId, params, onUpdate, toolContext, invocation)`；harness **忽略** per-tool `executionMode` | 12 行适配器；**全局** `toolExecution:"sequential"`（现写动作本就串行）→ 必须实测每决策耗时与工具次数不退化 |
| **M4** | 上下文管理两套 | 我们 `keepRecent:40` 剪枝 + 注入；harness 有自动 compaction | **先关 compaction**（`compaction:{enabled:false}`），剪枝与注入搬到 `transform_context` hook |
| **M5** | 事件名不同 | telemetry 吃 `message_start`/`tool_execution_start`/…；harness 发 `message_start`/`tool_start`/`tool_end`/`usage` | 写**纯函数适配器**并单测，不改 telemetry 内部 |

---

## 3. 已核实的库事实（执行时照此，不必再猜）

| 事实 | 坐标 |
|---|---|
| harness 自己设置 provider 缓存亲和键 | `dist/harness/runtime/drive/generation.js:136`：`sessionId: \`${lane.session.metadata.id}:${lane.name}\`` ⇒ **缓存不会丢** |
| `lane.prompt` 只返回操作元数据 | `dist/harness/agent-harness.d.ts:648`（`Promise<RunResult>`，`RunResult` 包 `OperationResultRecord`） |
| 工具执行签名 | `dist/harness/types.d.ts:78`（`AgentHarnessTool = Omit<AgentTool,"execute"> & { execute(...5 参) }`） |
| harness 不看 per-tool `executionMode` | `runtime/` 内无 `executionMode` 命中；只有 `AgentHarnessOptions.toolExecution` 全局开关 |
| `NodeExecutionEnv` 即 `FileSystem` | `harness/types.d.ts:289`：`ExecutionEnv extends FileSystem, Shell`；`NodeExecutionEnv` implements `ExecutionEnv` |
| `Context` 现成可得 | `harness/context.d.ts` 重导出 `BACKGROUND_CONTEXT` / `withCancel` / `withAbortSignal` |
| 会话仓储 | `JsonlSessionRepo({fileSystem, sessionsRoot, now?})`（`session/jsonl/types.d.ts:34`） |
| 自动 compaction 可关 | `CompactionSettings{enabled, reserveTokens, keepRecentTokens}`（`compaction/compaction.d.ts:31`） |
| `Models` 我们本来就有 | `provider.ts` 已构造 `builtinModels()` / `createModels()`，随后丢弃 ⇒ 改为返回 `{models, model}`，**不需要 streamFn 兼容层** |
| D2 之后没有自定义消息要过滤 | `game_observation` 不再写入；`convertToLlm` 的过滤实际已是死代码 ⇒ 迁移无需对应能力 |

---

## 4. 分层方案

### D6a —— 一局 = 一个可回放会话（默认关）

**改动面**

| 文件 | 改什么 |
|---|---|
| `src/agent/provider.ts` | `buildBrain` 额外返回 `{models, model}`（旧 `streamFn` 出口保留） |
| `src/agent/harness-runtime.ts`（新） | `NodeExecutionEnv(<dataDir>)` + `JsonlSessionRepo({sessionsRoot: <dataDir>/sessions/<id>/harness})` + `createAgentHarness`，lane 名 `agent` |
| `src/agent/runtime.ts` | 工具适配器；`before_tool` 接管预算（**拒绝文案逐字不变**）；`transform_context` 接管剪枝 + lessons/成绩注入 |
| `src/agent/loop.ts` | `runDecision` 双路径；plan 从 transcript 取（M2） |
| `src/agent/telemetry.ts` | `ingestHarnessEvent`（纯函数适配器） |

**验收（缺一不可）**

1. `pnpm run gate` 绿（含适配器、适配后的工具形状单测）。
2. **AGENTS §5.1 八条真机断言全绿**（`llm.kind=real`、`mode=agent`、`decisions>=2`、
   `usage.totalTokens>0`、`audit` 有 `decision`+`action_result`、trigger 不全 `start`、
   `/api/telemetry` 正常、控制台干净）。
3. 同一 seed 跑两局：harness 会话文件存在且**能列回**（`findEntries` 取得到本次决策的 assistant 消息）。
4. **行为不变证据**：同一决策点的上下文 JSON 与旧路径逐字一致（除时间戳）；
   注入条数与顺序与旧路径相同（等价单测）。
5. 工具执行耗时/每决策调用次数与旧路径同量级（记录数字，不设主观阈值）。

**回滚**：`AGENT_HARNESS=0`（默认）→ 完全走旧路径；旧代码不删。

### D6b —— 真实 payload 与用量台账

| 改动 | 产出 |
|---|---|
| `before_payload` | manifest 增 `payloadHash`（**真实 payload**，与 D3b 的源码指纹并列，便于交叉验证） |
| usage 台账（`harness/usage.jsonl`） | 分数卡效率轴可读它；仍是可选字段，缺失为 `null` |
| `retry_*` / `fault` 事件 | 进 telemetry 步骤流（当前完全不可见） |

**验收**：两模型的 `payloadHash` 可对比；人为断流（stub 返 500）能在步骤流里看到 retry；gate 绿。

### D6c —— **否决**

全量替换 `session-store`/`telemetry`：对可比性零增益，回归面覆盖 5 个页面与 E2E 八条。

### D6d —— 待定（等 D5 真跑一轮）

反事实回放：同一存档 + 同一决策点 → 会话 fork → 两个模型各自继续。这是**消掉世界方差**的
最强手段，但需要存档/读档、世界态对齐、fork 后工具上下文重建，成本 ≥3 个当量。

---

## 5. 风险表

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 工具全串行 → 读动作变慢、token/时延退化 | 中 | 中 | D6a 验收第 5 条记录耗时/次数；必要时只给只读工具开并行（先实测） |
| harness compaction 与我们的剪枝打架 | 中 | **高**（提示词变化 → 不可比） | 第一版**明确关闭** compaction，并把该设置记进 manifest |
| 事件适配器漏事件 → 看板少数据 | 中 | 中 | 适配器单测 + 八条 E2E |
| 异常终止时取不到 assistant 消息 | 中 | 低 | 返回 `plan: null`（现有语义允许）并记 `fault` |
| 会话目录膨胀 | 低 | 低 | 观察一局体积；必要时再定保留策略 |

---

## 6. 三条不变量（执行时不得违反）

1. **harness 默认关**，两条路径都必须可跑（回滚是切开关，不是回滚代码）。
2. **关闭 harness 的 compaction**——同一时间只有一套上下文裁剪机制。
3. **验收必须含 AGENTS §5.1 八条真机断言**；单测绿不算完成。

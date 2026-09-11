# 启动前环境检查（Preflight）与 Session 生命周期

本文件是**启动门禁**的单一事实源。协议/接口见 `docs/DASHBOARD-API.md`，
前端 UX 见 `docs/DASHBOARD-UI.md`。

> 背景：此前 `--agent` 在 LLM 未配置时**静默降级为脚本化 faux**，照样启动游戏、
> 部署 GameScript、建一条公交线——用户看到的是一次"无脑模拟"。这是不允许的：
> **先决条件不满足就必须拒绝启动，而不是假装在工作。**

---

## 1. 原则

1. **失败要发生在副作用之前**。检查必须在 spawn OpenTTD / 写 dataDir / 部署 GS **之前**完成。
   今天 brain 装配在 boot 之后（`runner.ts` 已 boot 完毕才判断 LLM），必须前移。
2. **不静默降级**。缺 LLM 时不能"用 faux 顶上"。要跑无脑演示，必须**显式** `--offline-demo`。
3. **错误信息可执行**。每条失败都给出「为什么 + 怎么修」，并带上当前生效的值。
4. **检查是纯的、可测的**。`preflight()` 不产生副作用（probe LLM 除外，见 §3），
   返回结构化结果，由 CLI 决定如何呈现与退出。

## 2. 检查项（按顺序，快速失败）

| id | 级别 | 适用模式 | 判定 |
|---|---|---|---|
| `binary` | fail | watch/v02/agent/probe | `cfg.openttdBinary` 存在且可执行（`access(X_OK)`） |
| `dataDir` | fail | 全部 | 目录可创建且可写（写入并删除一个探针文件） |
| `ports` | fail | watch/v02/agent | admin/game 端口**当前未被占用** |
| `llmConfigured` | fail | agent | `isLlmConfigured()`（除非 `--offline-demo`） |
| `llmReachable` | fail | agent | 真实最小请求成功（§3）（除非 `--offline-demo`） |
| `gsFiles` | warn | watch/agent | Bridge/Executor GS 脚本存在（缺则构建期会失败） |

`--watch` 是**纯观测**（无 brain），因此**不要求 LLM**——这是刻意的，不是遗漏。

## 3. LLM 可用性探测（`probeLlm`）

配置完整（有 provider/model/key）**不等于可用**：key 可能失效、endpoint 可能不可达、
模型名可能已下线。因此发一次**最小真实请求**：

- 用 `buildBrain()` 拿到真实 provider/streamFn（即真正会被使用的那条路径），
  避免"检查的和用的不是同一个东西"。
- 发一条极短 prompt，取**首个事件**即视为可用，然后中止。
- 超时（默认 15s，`AbortSignal`）→ fail，文案区分「不可达/超时」与「认证失败」。
- 任何失败都**不打印密钥**（复用 `redactKey`）。

代价：消耗极少 token。这是刻意的——用户要的是"能不能用"，不是"配置看起来对不对"。

## 4. CLI 行为

```
[preflight] binary    ✓ /path/to/openttd
[preflight] dataDir   ✓ /tmp/openttd-agent-data (writable)
[preflight] ports     ✓ admin 3977, game 3979 free
[preflight] llm       ✓ catalog deepseek / deepseek-chat (responded in 412ms)
```
- 任一 `fail` → 打印失败项 + 修复建议，**退出码 1，且不启动任何东西**。
- `warn` 只提示，不阻断。
- `--skip-preflight`：跳过**非安全关键检查**（ports/gsFiles）用于调试；
  **`binary` 与 agent 模式的 LLM 检查不可跳过**（只能靠 `--offline-demo` 显式豁免）。

## 5. Session 生命周期

### 5.1 问题
`SIGKILL` / 崩溃 / 断电时 `finalize()` 不会执行，`meta.json` 永远停在 `running`，
Web 端于是把**已经死掉的局**显示为 "running"，误导用户。

### 5.2 解决：心跳 + 有效状态

- `SessionMeta.heartbeatAt: number`：运行期每 **2s** 刷新（与 `writeMeta` 同路径，原子写）。
- `status` 联合类型新增 **`interrupted`**：进程非正常结束/心跳过期。
- **有效状态**在**读取时**计算（`effectiveStatus(meta, now)`）：
  `status==="running" && now - (heartbeatAt||startedAt) > STALE_MS(10s)` ⇒ `interrupted`。
  读取时不改盘（幂等、无副作用），但 `listSessions`/`readSession`/REST 一律返回有效状态。
- **启动时和解（reconcile）**：新进程启动时扫描索引，把上一个进程遗留的过期
  `running` 局**写盘**标记为 `interrupted`（附 `endedAt` + `error:"interrupted"`），
  这样历史数据自愈，不留脏状态。
- stderr/未捕获异常：`uncaughtException`/`unhandledRejection` → 尽力 `finalize({status:"error"})`；
  `process.on("exit")` 里做同步收尾（写 meta 是同步的，可行）。
- 信号：`SIGINT`/`SIGTERM`（已有）+ **`SIGHUP`**（新增）。

### 5.3 判定表（真源）

| 事件 | 结果状态 |
|---|---|
| 正常跑完 / 到达目标 | `completed` |
| Ctrl-C（SIGINT）、SIGTERM、SIGHUP | `aborted`（优雅，有 `endedAt`） |
| 未捕获异常 / 未处理 rejection | `error`（带 message） |
| SIGKILL / 崩溃 / 断电 | 盘上是 `running` → 读取时算 `interrupted`；下次启动写盘固化 |

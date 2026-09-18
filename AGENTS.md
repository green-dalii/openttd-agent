# AGENTS.md — 开发规范

本文件约束**所有在此仓库工作的 agent/开发者**（含 Pi 本身与 subagents）。
任何修改必须遵守；冲突时本文档 > 个人偏好。

---

## 1. 项目本质（30 秒版）

TypeScript/Node (ESM, `type: module`) 单体框架：外部进程通过 **Admin Port TCP** 控制本机 **OpenTTD 15.0 dedicated server**，LLM agent（基于 `@earendil-works/pi-agent-core`）做决策，游戏内 **Bridge GS + Executor AI** 施工。

- 完整架构见 `SPEC.md`；渐进计划见 `ROADMAP.md`；**过程教训见 `MEMORY.md`**。
- 必须读 `SPEC.md` §2/§10（已验证协议事实）再动通信相关代码。
- **每次新 Session 开始或 compact 之后，按这个顺序读，再动手**：
  1. **`ROADMAP.md`** —— 顶部有 🔴 **NEXT-1/2/… 待办清单与可照抄的命令**；
     compact 后**从这里接续**，不要凭印象猜进度。
  2. **`SPEC.md` §10.20–§10.33** —— 最近一轮的全部实测结论（暂停是单向的、
     心跳从未响过、`--demo-seconds` 没生效、M3 饱和的根因、决策权交还）。
  3. **`MEMORY.md`** —— 快速自检清单 + A/B/C 各类教训。
  4. **`docs/EXECUTOR-ARCHITECTURE.md`** —— GS-only 改造的证据与四阶段计划。
  **本仓库的多数返工都源于"没读 SPEC 就实现"与"重复踩 MEMORY 里已记录的坑"；
  而最近一轮的返工源于"没读 ROADMAP 就继续"，故把它放在第一位。**
- **进度快查**: 当前开发阶段/验证状态/下一步见 `ROADMAP.md` 的「进度速览」+「待办」；
  真机实测事实（含 OpenTTD Squirrel 字符串坑、标牌可见性）见 `SPEC.md` §10.x；
  Squirrel 可复用 helper（Split/ToInt/SetPhase）的规范实现以 `src/game/squirrel/executor-ai/main.nut` 为准。

## 2. 铁律（不可违反）

1. **TDD 先行**：任何功能先写会失败的测试 → 再实现 → 全绿。
   - `test/unit/*` 纯单测（不碰真机/网络）。
   - 真机测试必须带 `@live` 标签并默认 skip（见 §5）。
2. **门禁必须绿**：提交/PR 前跑 `pnpm run gate`（typecheck + lint + test 一键）。任何人不得在红门禁下提交。
3. **不动用户全局 OpenTTD 配置**：游戏一律用**隔离 data dir**（`-c <dir>/openttd.cfg`，目录自建）。禁止读写 `~/Documents/OpenTTD`（除非是用户显式要求的共享场景）。
4. **协议有事实依据**：Admin Port 字节布局/枚举以 `SPEC.md` §2 + OpenTTD 源码为准；不确定先查源码/实测，禁止猜。改动协议层必须有对应 unit 测试锁定。
5. **类型单一事实源**：共享事件/消息类型定义在 `src/types.ts`（或对应 `types.ts`），禁止各处重复声明。
6. **无屎山**：纯函数与副作用分离；模块文件头写清「职责 / 禁止」；复杂逻辑不可读则拆分。
7. **命令带副作用用本仓库脚本**，不裸跑破坏性 shell（尤其涉及 data-dir 清理）。

## 3. 目录约定

```
src/
  game/        # OpenTTD 进程/Admin Port 协议/GS 通道/事件规范化
  agent/       # pi-agent-core 装配、tools、messages、prompts、context
  evolution/   # 局终反思/lessons/策略库/metrics
  memory/      # 持久化 (JSONL)
  web/         # HTTP/WS + public/ 静态前端
  config.ts    # 配置 schema (zod)
  types.ts     # 共享类型
  main.ts      # 入口装配
test/
  unit/        # 纯单测 (vitest)
  integration/ # 需真机标记 @live
scripts/       # dev 辅助 (gen-squirrel, setup-sandbox)
```

新增模块必须归位；拿不准问（或放 `src/util/` 纯工具）。

### 3.1 临时/一次性脚本（不得污染仓库根目录）

一次性的探针、验证、抓包脚本（CDP 探针、临时断言、手动触发脚本等）**一律放 `.scratch/`**，
并在用完时删除。**禁止**丢在仓库根目录。

- `.scratch/` 已在 `.gitignore` 中；根目录的 `probe*.mjs` / `vfy*.mjs` 也被 ignore。
- 根目录**只允许** `eslint.config.mjs` 这一个 `.mjs`（它有明确归属）。
- 为什么：根目录的临时文件极易被 `git add -A` 顺手提交（本仓库真实发生：
  CDP 探针 `probe2.mjs` 被提交进 `10eb8ef`），既脏仓库又让下一个人以为它有用。
- 判定：**如果这个脚本不是产品的一部分、也不进 `test/`，它就不该被 commit。**
- 由 `test/unit/repo-hygiene.test.ts` 静态守卫。

## 4. 技术栈/风格

- Node >= 22.19, TS strict, ESM。
- 运行时依赖**最小化**：`pi-agent-core`/`pi-ai`/`ws`/`zod` 级别；能用 node 内置就不用包。
- 前端**无构建链**：原生 HTML/JS/CSS + WS。
- 命名：文件 kebab-case；类 PascalCase；函数 camelCase；常量 UPPER_SNAKE。事件类型名 `*Event`。
- 类型优先：禁止 `any` 泄漏（协议层可用窄化 `unknown`）。
- 所有异步边界可取消/可超时（AbortSignal / timeout helper）。

## 5. 测试与门禁

> **fixture 必须来自真实样本**（2026-09-12 教训，代价一轮实验）：凡测试涉及
> 真实协议产物（阶段字符串、事件流、admin 包），fixture 必须抄自真实日志
> （存 `test/fixtures/` 或测试内注明来源），**不得手写臆想格式** ——
> 臆想格式让第一版修复测试全绿却静默失效。

- `pnpm test` — unit（快，纯）。**用 faux provider，无法发现"没接线"**。
- `pnpm run test:live` — 含 `@live` 真机集成（需要本机 OpenTTD 二进制 + 可写临时 data dir）。
  **涉及 agent/决策/遥测的改动必须跑这个**，断言见 §5.1。
- `pnpm run gate` = `typecheck && lint && test`。**红=停**。
- 新增测试命名：`*.test.ts`。协议 golden 字节样张放 `test/fixtures/`。

## 5.1 E2E 必须证明「智能真的接上了」（血泪教训）

**背景**：v0.3~v0.5 期间，`--agent` 的 E2E 只验证了"进程起来了、有 token 计数"，
但**从未验证 LLM 真的在驱动决策**。结果三个真机 Session 全是 `mode=watch` +
`kind=faux` + `decisions=0`——用户看到的是**内置 CPU AI** 在打，而面板一切正常。
这类"压根没接线"的错误，任何单元测试都抓不到。

**因此，任何关于 agent/决策/telemetry 的改动，E2E 必须至少证明以下全部：**

1. `meta.json.llm.kind === "real"`（不是 faux）
2. `meta.json.mode === "agent"`（不是 watch 顶包）
3. `totals.decisions >= 2`（**不是 1**——1 意味着"只问了一次"）
4. `totals.usage.totalTokens > 0`（真的有模型调用）
5. `audit.jsonl` 里有 `decision` 且带 `trigger`，并有 `action_result`
6. 决策 **trigger 不全是 `start`**（说明循环在持续运行）
7. Dashboard `/api/telemetry` 的 `usage.total.input > 0`、`steps.length > 0`
8. **浏览器控制台干净**，且是**在代码真的执行过的状态**下采集的（见 §5.2）

**新增/修改 `--agent`、loop、tools、telemetry、dashboard 遥测时，必须跑
`pnpm run test:live` 且上述断言全绿**（见 `test/live/agent-loop.test.ts`）。
只跑单测不算验证——单测用的是 faux provider，永远无法发现"没接线"。

## 5.2 前端/UI 改动："没有报错"只在代码真的跑过时才成立（血泪教训）

**背景**：把 Live 页迁 Alpine 后，我报告"三页 0 控制台错误"并与用户交接。
用户实测发现满屏 `Alpine Expression Error: ... reading 'children'` +
`Uncaught ReferenceError: m is not defined`。**报错是真的，我的"0 错误"是假的**：

1. 我的 E2E 跑在一次 **`stageViews` 仍为空**的会话上（agent 刚启动，还没到施工阶段），
   出错的 `<template x-for>` **从未渲染** → 不产生任何错误。
   **用一个没有数据的状态"验证"了刚写完的组件。**
2. 探针只监听 `Runtime.exceptionThrown` + `console.error`；Alpine 的表达式错误走
   **`console.warn`** → **被过滤器丢掉**。
3. 同类前科：uPlot 图表宿主误用 `<canvas>`，注入的 DOM 成了不渲染的 fallback content，
   而我当时测的是 **canvas 里的像素**（有像素 ≠ 用户看得见）。

**因此，任何前端/页面改动，验证必须满足：**

1. **在有真实数据的页面状态**下采集（agent 跑出 steps / 多轮 token / stage views 等），
   而不是空列表的初始态。空态通过 = 没验证。
2. 采集**全部控制台级别**（至少 error + warn），不能只过滤 error。
3. 断言**用户能观察到的东西**（元素可见性、DOM 文本、图表 wrapper 的实际盒子尺寸），
   **不是**代理指标（"有像素"、"没抛异常"、"进程起来了"）。
4. 迁移/重写动态模板后，**逐个交互元素人工点一遍**：
   模式开关、下拉、按钮、折叠 —— 因为"静默缺失的 UI"（功能没了但零报错）
   单测和回归测试都抓不到。本仓库已踩过 3 次：`companyCards()` 只被模板引用从未实现、
   Providers 的模式开关被整段删掉、`x-ref` 缺失导致两个下拉从未挂载。
5. 页面脚本的**纯逻辑抽到 `<page>-view.js`** 并写单测；组件只留 IO 与命令式部件。
   这样"业务规则丢失"能被测试挡住，剩下的"渲染没接上"用第 4 条人工过一遍。

## 6. 事实与教训记录（重要）

按**性质**分流，不要混写：

| 性质 | 写进 | 例 |
|------|------|-----|
| **系统事实**（协议/API/游戏机制） | `SPEC.md` 或 `docs/` | "`screenshot minimap` 可在 headless 下工作" |
| **架构取舍**（改了什么/为什么/代价） | `SPEC.md`（ADR 风格条目） | "为何用 vendored vendor 而非 CDN" |
| **开发准则**（应当怎么做） | `AGENTS.md` | 本文档 §2/§8/§9 |
| **过程教训**（踩过的坑/错误模式） | **`MEMORY.md`** | "用空状态验证了组件" |

- 任何「调研得出的新事实」不得只存在聊天里。
- **`MEMORY.md` 是跨 session 的过程记忆**：每次犯错（尤其重复犯错）后必须追加一条，
  写清「现象 / 根因 / 规则」，让下一个 session（或 compact 后的自己）不再踩。
- 准则与教训的分界：**可执行的规则**进 AGENTS（"必须/禁止"），**复盘叙述**进 MEMORY
  （"我做了什么、为什么错"）。两者可用指针互相引用。

## 7. 完成定义 (Definition of Done)

一个任务/版本算完成，当且仅当：
- [ ] 代码有测试且 `pnpm test` 绿
- [ ] `pnpm run gate` 绿
- [ ] 涉及 UI/前端时，已按 §5.2 在**有数据的状态**下验证（含 console.warn）
- [ ] **文档同步**：本阶段受影响的所有文档**一次性**更新完
      （`CHANGELOG.md` 行为/命令/配置变化 · `ROADMAP.md` 进度与待办 · `README.md` 用法 ·
      `MEMORY.md` 教训 · `SPEC.md`/`docs/` 事实）
- [ ] **文档正交**：同一事实只有一个权威位置，其余用**指针**（见 §9）
- [ ] 没有留下 TODO 假代码、死代码、`console.log` 调试残留

## 8. 提交卫生（禁止碎片化）

**一次逻辑变更 = 一个 commit。**

已提交但**仍属同一次工作**的修正（写错、写漏、补充说明）→ **`git commit --amend`**，
不要追加 `fix:` / `correct:` / `docs: 补充…` 之类的补丁 commit。

- **本仓库现有 remote**：`origin` = `github.com/green-dalii/openttd-agent`（2026-09-17 建，
  见 `ROADMAP.md` 顶部）。因此 amend 只对**尚未 push 的提交**安全；已 push 的提交要改，
  先确认没有别人基于它工作，再 `git push --force-with-lease`（**禁止**裸 `--force`）。
- 追加新 commit 的正当理由只有两个：(a) 已经 push / 他人可能基于它工作；
  (b) 这是**独立的后续目标**，不是本次工作的收尾。
- 判定标准：**「如果我在写第一版时就知道这些，还会单独提交吗？」** 答"不会"→ amend。

```sh
git commit --amend                      # 修正最后一次
git reset --soft HEAD~N && git commit   # 合并最近 N 次为一次
```

**反例（本仓库真实教训 2026-09-12）**：一次「把待办写入 ROADMAP」的文档工作产出 3 个 commit
——记录待办 → 补一个环境陷阱 → 修正自己写错的 VCS 说明。三次都是**同一次文档更新的收尾**，
后两次本应 amend 进第一次。碎片化不仅脏历史，还让"这一版到底改了什么"难以回答。

## 9. 文档职责与正交性

> **本节是文档职责的单一权威。** 各文档头部只写**两行边界声明**并指向本节，
> **不得**复制下表——否则本表本身就成了七份需要同步的拷贝。

**每个文档只有一个职责；同一事实只在一处权威，其余位置用指针。**

| 文档 | 唯一职责 | **不**应包含 |
|------|----------|--------------|
| `AGENTS.md` | 开发规范/铁律/提交卫生/**准则** | 系统细节、版本历史、进度 |
| `SPEC.md` | 系统**是什么** + 已验证系统事实 | 进度、命令用法、过程教训 |
| `ROADMAP.md` | **未完成**的进度与计划（里程碑状态/下一步/验收） | 已实现版本的细节、验收勾选历史、教训 |
| `CHANGELOG.md` | 每版**改了什么**（面向使用者与回滚） | 规范、未来计划、犯错复盘 |
| `README.md` | **怎么用**（命令/配置/架构速览） | 协议字节布局（指向 SPEC）、目录树（指向 CONTRIBUTING） |
| `CONTRIBUTING.md` | **怎么参与开发**（命令/目录树/流程/收尾清单的单一事实源） | 准则条文（指向 AGENTS）、系统事实（指向 SPEC） |
| `MEMORY.md` | **过程教训 + 当前方向/计划的活记忆**（现象/根因/规则/阶段状态，随时修订） | 系统事实、规范条文、逐版本进度 |
| `docs/*.md` | 单一主题的深入说明 | 被上述文档指针引用，不自我复制 |

### 9.1 写之前的两个判定问题

1. **「改一个事实需要动几个文件？」** > 1 就是有重复，改成指针。
2. **「这是一份计划、一份记录，还是一个教训？」**
   - 计划（还没做）→ `ROADMAP.md`
   - 记录（已经做了）→ `CHANGELOG.md`
   - 教训（我做错了什么）→ `MEMORY.md`
   - 事实（世界是怎样的）→ `SPEC.md` / `docs/`
   - 准则（应当怎么做）→ `AGENTS.md`

### 9.2 最容易犯的错：把「已完成」写进 ROADMAP

ROADMAP **只写给未完成的东西**。一个版本完成的那一刻，它的实现细节与验收结果
就变成了 **CHANGELOG** 的内容，留在 ROADMAP 里只会产生两份需要同步的历史。

同样，**修完一个 bug 后不要在 ROADMAP 里写根因复盘**——那是 CHANGELOG（改了什么）
+ MEMORY（为什么错）。

> **真实违规（2026-09-12）**：`ROADMAP.md` 曾积累 **139 行**逐版本的实现细节与
> 「验收 - [x] …」清单，与 `CHANGELOG.md` 大幅重复；同时待办段里塞着已完成项
> 的根因分析与实测数字。已删除并改为指针。

**已知违规**（发现即修）：`ROADMAP.md` 末尾曾复制一份「开发纪律」5 条，与本文档 §2 铁律
重复表述。已改为指针。跨文档引用统一写成 `见 AGENTS.md §2` 这种形式，不要重述内容。

# AGENTS.md — 开发规范

本文件约束**所有在此仓库工作的 agent/开发者**（含 Pi 本身与 subagents）。
任何修改必须遵守；冲突时本文档 > 个人偏好。

---

## 1. 项目本质（30 秒版）

TypeScript/Node (ESM, `type: module`) 单体框架：外部进程通过 **Admin Port TCP** 控制本机 **OpenTTD 15.0 dedicated server**，LLM agent（基于 `@earendil-works/pi-agent-core`）做决策，游戏内 **Bridge GS + Executor AI** 施工。

- 完整架构见 `SPEC.md`；渐进计划见 `ROADMAP.md`。
- 必须读 `SPEC.md` §2/§10（已验证协议事实）再动通信相关代码。
- **进度快查**: 当前开发阶段/验证状态/下一步见 `ROADMAP.md` 顶部「进度速览」+ 对应版本段；
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

## 4. 技术栈/风格

- Node >= 22.19, TS strict, ESM。
- 运行时依赖**最小化**：`pi-agent-core`/`pi-ai`/`ws`/`zod` 级别；能用 node 内置就不用包。
- 前端**无构建链**：原生 HTML/JS/CSS + WS。
- 命名：文件 kebab-case；类 PascalCase；函数 camelCase；常量 UPPER_SNAKE。事件类型名 `*Event`。
- 类型优先：禁止 `any` 泄漏（协议层可用窄化 `unknown`）。
- 所有异步边界可取消/可超时（AbortSignal / timeout helper）。

## 5. 测试与门禁

- `pnpm test` — unit（快，纯）。
- `pnpm run test:live` — 含 `@live` 真机集成（需要本机 OpenTTD 二进制 + 可写临时 data dir）。
- `pnpm run gate` = `typecheck && lint && test`。**红=停**。
- 新增测试命名：`*.test.ts`。协议 golden 字节样张放 `test/fixtures/`。

## 6. 事实记录（重要）

- 任何「调研得出的新事实」（协议细节/API 行为/游戏机制）→ 记入 `SPEC.md` 或 `docs/`；不得只存在聊天里。
- 架构取舍记录在 SPEC/ADR 风格条目（改了什么、为什么、代价）。

## 7. 完成定义 (Definition of Done)

一个任务/版本算完成，当且仅当：
- [ ] 代码有测试且 `pnpm test` 绿
- [ ] `pnpm run gate` 绿
- [ ] README/CHANGELOG 已更新（行为/命令/配置变化）
- [ ] 涉及协议/API 行为的新事实已固化进 SPEC/docs
- [ ] 没有留下 TODO 假代码、死代码、`console.log` 调试残留

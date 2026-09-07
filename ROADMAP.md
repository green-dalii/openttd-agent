# ROADMAP — OpenTTD LLM Agent Framework

> 渐进式开发计划。从 v0.0.1（脚手架 + MVP）开始，每版都保持「可运行 + 测试绿 + 门禁过」。
> 原则：**先打通最小闭环，再进化；任何版本不得以破坏测试/门禁为代价堆功能。**

---

## 版本规划

### 进度速览
- ✅ v0.0.1 — 脚手架 + MVP（Admin Port 最小闭环，真机验证通过）
- 🔵 **v0.1.0 — 观测闭环（M1）（当前）**
- ⬜ v0.2.0 — 最小决策闭环（M2）
- ⬜ v0.3.0 — 进化闭环（M3）
- ⬜ v0.4.0 — 打磨与广度（M4）

---

### v0.0.1 — 脚手架 + MVP（✅ 已完成，2026-09-07）
**目标**: 可运行的 TypeScript 工程骨架 + 首个**可验证的最小闭环**，证明「外部进程↔OpenTTD Admin Port」双向通道真实可用。

**已完成交付**
1. 工程脚手架: pnpm + TS strict ESM + vitest + eslint；`pnpm run gate` 门禁
2. `admin-protocol.ts`（帧编解码/枚举/reader/writer）+ `observer.ts`（事件规范化）+ `config.ts` + `process-manager.ts`（generate-then-patch 配置）+ `blueprint.ts`
3. CLI `--probe`: spawn → join → subscribe → poll → rcon → 打印规范化事件
4. 40 单测 + 真机 probe 通过（date raw 712223 = 1950-01-01 锚点验证）
5. pnpm 迁移完成（05a7541）

**里程碑映射**: M0（环境钉死）—— admin auth/进程/协议打通。

---

### v0.1.0 — 观测闭环（M1）（当前）
**目标**: Runner 长驻，实时接收 admin+GS 状态 → 规范事件 → Web 仪表盘可看现金/年份/公司。

**前置 spike 实证（2026-09-07, 真机验证）**
- `start_ai` 经 RCON 可创建公司: company_new → company_info（isAi:true, inauguratedYear）→ company_economy（poll 即时返回，无需等季度翻转）
- 本地无用户 AI 包，但 OpenTTD.app 内置 4 个 AI: AAAHogEx / CityLifeAI / CivilAI / CPU（`ai` 目录）；sandbox `-c` 目录自带空 `ai/` 子目录
- economy payload 含 **BigInt**（money/loan/income，开局 £100k 贷款）→ JSON 序列化需 BigInt-safe

**交付物**
1. `util/json.ts`: BigInt-safe `stringify`/`parse`（事件/日志/审计通用）
2. `game/admin-client.ts`: 完整 AdminClient 类（connect/join/auth/subscribe/poll/rcon/GS 通道/断线重连/事件回调）——从 run.ts probe 内联逻辑抽离
3. `game/observer.ts` 扩展 + `world-state.ts`: 内存态累计（公司表/日期/最近经济快照）+ 轮询节奏
4. `web/server.ts` + `web/hub.ts` + `web/public/*`: HTTP(静态) + WS 扇出；原生 HTML+Canvas 仪表盘 v1（现金/贷款/年份曲线 + 公司列表 + 事件流）
5. CLI: `--watch` 模式（spawn + start_ai + 长驻采集 + WS 广播）+ `--probe-ai`（一次性验证含公司观测）
6. 单元测试（json/codec 往返/observer/state）+ `@live` integration 标记
7. GS `PushState` 模板 v1（bridge-gs Squirrel 骨架 + 部署脚本，本版仅骨架）

**验收**
- [ ] 浏览器 live 看到公司现金/年份曲线 + 事件流
- [ ] `@live` integration 绿（真机: start_ai → economy 事件到达）
- [ ] `pnpm run gate` 全绿（新增测试覆盖）

**里程碑映射**: M1 观测闭环（AdminClient 订阅 company/date/economy + 基础仪表盘）。

---

### v0.2.0 — 最小决策闭环（M2）
**目标**: LLM 真正「玩」第一步 —— 观察→决策→施工→盈利回灌。

- Executor AI（Squirrel 施工 v0.1: bus route）
- Bridge GS 蓝图消费 → GSSign → executor
- Pi Agent Core 装配（tool: `observe/build_bus_route/add_vehicles/pause`）+ 自定义 AgentMessage
- `transformContext` 记忆注入 v1
- 验收: 一局 1950 地图跑通第一条盈利公交线；LLM 决策全量落审计

### v0.3.0 — 进化闭环（M3）
**目标**: 多局对比实验 + lessons 蒸馏注入 + 指标可视化。

- 局终结算/反思/lessons 蒸馏/注入下局
- metrics JSONL + 对比图
- 策略库 v1
- 验收: 同 seed 带/不带 lessons × 3 局出对比曲线

### v0.4.0 — 打磨与广度（M4）
- 铁路/货运 tool 扩展
- replay（事件时间线）
- 自愈（崩溃重启/续档）
- 文档完善 + SPEC 更新
- 对照模型基线（多 provider）

---

## 开发纪律（见 AGENTS.md 细则）
1. **TDD**: 先写失败测试 → 实现 → 绿；`@live` 标测试默认跳过，CI/手动 `--live` 跑
2. **门禁**: 每次提交前 `pnpm run gate` 必须绿（typecheck + lint + test）
3. **小步**: 每 PR 一个可验证目标；保持主干始终可运行
4. **零屎山**: 纯函数分离/类型单一事实源/模块职责+禁止项注释
5. **事实驱动**: 任何协议/行为假设先有源码/实测依据，写进 SPEC/ADR

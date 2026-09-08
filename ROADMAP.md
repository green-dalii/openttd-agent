# ROADMAP — OpenTTD LLM Agent Framework

> 渐进式开发计划。从 v0.0.1（脚手架 + MVP）开始，每版都保持「可运行 + 测试绿 + 门禁过」。
> 原则：**先打通最小闭环，再进化；任何版本不得以破坏测试/门禁为代价堆功能。**

---

## 版本规划

### 进度速览
- ✅ v0.0.1 — 脚手架 + MVP（Admin Port 最小闭环，真机验证通过）
- ✅ **v0.1.0 — 观测闭环（M1）（2026-09-08 完成）**
- 🔵 **v0.2.0 — 最小决策闭环（M2）（当前）**
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

### v0.1.0 — 观测闭环（M1）（✅ 已完成，2026-09-08）
**目标**: Runner 长驻，实时接收 admin+GS 状态 → 规范事件 → Web 仪表盘可看现金/年份/公司。

**前置 spike 实证（2026-09-07, 真机验证）**
- `start_ai` 经 RCON 可创建公司: company_new → company_info（isAi:true, inauguratedYear）→ company_economy（poll 即时返回，无需等季度翻转）
- 本地无用户 AI 包，但 OpenTTD.app 内置 4 个 AI: AAAHogEx / CityLifeAI / CivilAI / CPU（`ai` 目录）；sandbox `-c` 目录自带空 `ai/` 子目录
- economy payload 含 **BigInt**（money/loan/income，开局 £100k 贷款）→ JSON 序列化需 BigInt-safe

**交付物**
1. `util/json.ts`: BigInt-safe `stringify`/`parse`（事件/日志/审计通用）✅
2. `game/admin-client.ts`: 完整 AdminClient 类（connect/join/auth/subscribe/poll/rcon/GS 通道/断线重连/事件回调）——从 run.ts probe 内联逻辑抽离 ✅
3. `game/observer.ts` 扩展 + `world-state.ts`: 内存态累计（公司表/日期/最近经济快照）+ 轮询节奏 ✅
4. `web/server.ts` + `web/public/*`: HTTP(静态) + WS 扇出；原生 HTML+Canvas 仪表盘 v1（现金/贷款/年份曲线 + 公司列表 + 事件流）✅
5. CLI: `--watch` 模式（spawn + start_ai + 长驻采集 + WS 广播）+ 真机 live integration 测试 ✅
6. 单元测试（json/codec 往返/observer/state/web-server）+ `@live` integration 标记 ✅
7. GS `PushState` 模板 v1（bridge-gs Squirrel 骨架）—— 移到 v0.2.0（与 Bridge GS 一同落地更合理）

**验收**
- [x] 浏览器 live 看到公司现金/年份曲线 + 事件流（真机 `--watch` 实测: WS snapshot + 增量 economy/date 事件）
- [x] `@live` integration 绿（真机: start_ai CPU → company_economy 到达，5s 内）
- [x] `pnpm run gate` 全绿（59 单测 + 1 live skip）

**里程碑映射**: M1 观测闭环（AdminClient 订阅 company/date/economy + 基础仪表盘）。

---

### v0.2.0 — 最小决策闭环（M2）（当前）
**目标**: LLM 真正「玩」第一步 —— 观察→决策→施工→盈利回灌。
**当前阶段状态**: 通信地基已全部打通（见下方「已验证」），正在做 Executor 施工（"手"）。

**已验证（2026-09-08, 真机; 细节全在 SPEC §10.9-§10.13）**
- ✅ shutdown abort 修复（信号 handler 只翻 flag，不在回调里跑 async 收尾）§10.9
- ✅ 自定义 AI/GS 装入 sandbox + start_ai/list_game/attach GS 规则 §10.10
- ✅ Admin↔GS 双向 JSON 通道（AdminGameScript → GS ScriptEventAdminPort；GSAdmin.Send → TS）§10.11
- ✅ AdminClient 默认订阅含 Gamescript（GS 推送前提）§10.11
- ✅ **标牌邮箱可见性**: GS 必须以 `GSCompanyMode(executor公司id)` 放标牌，executor 的 AISignList 才看得到 §10.12
- ✅ 决策链路骨架全通: `pnpm run cli --v02` → boot(j-1) → GS demo 放标牌 → executor 读 NUTZ:bp:7 → 借贷 → phase=work(j7) §10.12
- ✅ `import("pathfinder.road", "Road", 4)` 库解析成功（铺路可用）；本地库 Graph.AyStar-6 等齐全
- ⚠️ **AI 公司没有 HQ**: `AICompany.GetCompanyHQ` 对 AI 无效 → 施工坐标必须来自标牌/外部，不能靠 HQ 选址
- 🔑 OpenTTD Squirrel 字符串语义（血泪）§10.13: `s[i]`=integer、单引号=integer、用双引号+find/slice、`"7".tointeger()==7`

**关键架构决策（已与用户对齐）**
- 施工坐标来源 = **方案 A（外部/GS 算坐标，executor 纯执行）**；v0.2 内由 GS（deity 全图视野）代选址填蓝图
- Executor = 纯"手"：读标牌 → 执行 DoCommand → SetPhase 汇报，不做选址决策
- 完整盈利线分多步子落地（每步真机可验），不一次冲 700 行 arena 移植

**实施分步（按依赖顺序，每步验收必须真机跑通才进下一步）**

- **S1. GS 选址 + 放站标牌（当前）**
  - BridgeV1 新增 `build_bus_route` cmd: 入参 {cmd, fromTown, toTown, company} → 用 GS API
    （GSTownList/GSMap/AITile 等价 GS 侧 API）找 A/B 镇边缘**既有道路旁的合法站址** + front
    → 放 `NUTZ:bp:<job>:S:fr=<front>` 和 `:E:fr=<front>` 标牌（**必须在 GSCompanyMode(company) 内**）
  - 验收: `--v02` 改为发 build_bus_route；GS ack 带 company_signs≥2；executor 收到 job
  - 文件: `src/game/squirrel/bridge-gs/main.nut` + `v02-runner.ts`

- **S2. Executor 建出第一个真实物件（bus station）**
  - ExecutorV1 解析 S 标牌得 {tile,front} → `AIRoad.BuildRoadStation(tile, front, ROADVEHTYPE_BUS, STATION_NEW)`
  - 处理 DoCommand 异步/错误码（AIError.GetLastError → SetPhase 编码）；成功则 phase=station_ok
  - 验收: 真机 economy/company_info 确认世界变了（station 建出、钱减少、phase=station_ok）
  - 文件: `executor-ai/main.nut`

- **S3. 完整双站 + 铺路（Pathfinder.Road）**
  - GS 放 S/E/D/W 全套标牌（两站 front + depot + 路径锚点）；Executor 用 Pathfinder.Road v4
    铺两站间 road（参照 arena PhaseRoad: pf.cost 调参 + FindPath(50) 循环）
  - 验收: 两站间 road 建成（可经 GS state / tile 查询确认）
  - 风险: pathfinder 可能失败（地形/资金）→ 需 abort 路径与重试

- **S4. 买 bus + 订单 + 跑起来**
  - Executor: BuildVehicle(bus) → depot → orders A→B→A → start
  - 验收: 车在跑（company_stats vehicles≥1）；跑若干月 economy 收入为正

- **S5. 盈利线闭环 + 观测确认（v0.2.0 验收）**
  - 完整链路脚本化跑通一条盈利公交线；Web/CLI 可见 cash 曲线向上
  - 文件: 端到端 @live 测试（test/live/）+ 文档

- **S6. Pi Agent（LLM）接线（v0.2.1）**
  - Pi Agent Core 装配 tool: observe/build_bus_route/add_vehicles/pause + AgentMessage
  - `transformContext` 记忆注入 v1；LLM 决策全量落审计

**验收（v0.2.0 总）**
- [ ] S1-S5 全过: 一局 1950 地图脚本化跑通第一条盈利公交线（可观测: cash 向上）
- [ ] v0.2.1: LLM 决策驱动同一条线（人工 prompt 验证一次）
- [ ] `pnpm run gate` 全绿；@live 集成绿

**里程碑映射**: M2 最小决策闭环。

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

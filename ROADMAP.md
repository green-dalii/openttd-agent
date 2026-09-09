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

### v0.2.0 — 决策闭环骨架：通信 + Executor"手"（M2 前半）（✅ 完成, 2026-09-09）
**目标**: 把"手"做完整 —— 外部/GS 规划 → 标牌邮箱 → Executor 全量施工 → 可观测经济反馈。
**范围修正（2026-09-09, 用户第一性原理对齐）**: "盈利"属于带脑（LLM）的完整 M2 验收；
无脑阶段（v0.2.0）只验收**决策闭环机械可运行 + 经济反馈可观测**。盈利验收移到 v0.2.1/S6。
（SPEC §10.8 M2 原始定义含 Pi Agent + LLM 决定；拆 ROADMAP 时曾把盈利误留在无脑 S5，已修正。）

**已验证（2026-09-08/09, 真机; 细节在 SPEC §10.9-§10.13 + 本轮新增待补）**
- ✅ shutdown abort 修复（信号 handler 只翻 flag）§10.9
- ✅ 自定义 AI/GS 装入 sandbox + start_ai/list_game/attach GS 规则 §10.10
- ✅ Admin↔GS 双向 JSON 通道 + AdminClient 默认订阅含 Gamescript §10.11
- ✅ 标牌邮箱可见性: GS 须 `GSCompanyMode(company)` 放标牌 §10.12
- ✅ OpenTTD Squirrel 字符串语义（双引号+find/slice+tointeger）§10.13
- ✅ **Executor 全量施工真机跑通**: boot→work→stA_ok→stB_ok→road_built(r30-46)→dpt_ok→dpt_conn→bus_live→done stN2 r* bus
- ✅ 世界级验收: `vehicles=3 stations=2`；车 R42-56 往返、@到站停靠、站排队被消化
- ✅ 经济反馈回灌: money/income 持续经 CompanyEconomy 观测（含 signed income 解析修复）
- ⚠️ **AI 公司无 HQ**: 施工坐标必须来自标牌/外部，不能靠 HQ 选址
- ⚠️ **Pathfinder.Road v4 + AyStar v6 (2012) 长路(>~60 tile)死锁/超慢**: FindPath 单次调用不返回；隔离 probe 证实。短距(<25 tile)秒回。→ GS 只能选短镇对。**脑阶段需分段铺路解除此限制（S6 前置技术债）**

**S1-S5 实施（全部 ✅ 真机通过, commits 744f626→2194305）**
- S1 GS 选址 + S/E 站标牌（company_signs=2）✅
- S2 Executor 建 2 个真实 bus station（done stN2；road-type 前置条件 root cause 已修）✅
- S3 Pathfinder.Road 铺两站间路 + 连通性验证（短镇对；AyStar 长路死锁 root cause 已记录）✅
- S4 depot + 3 bus + orders A→B→A + 运行（vehicles=3；depot 门连接 root cause 已修）✅
- S5 经济反馈闭环可观测（cash/income 持续回流；排队被 3 车消化）✅（非盈利验证, 见范围修正）

**验收（v0.2.0 总）**
- [x] S1-S5: 一局 1950 地图脚本化跑通一条**真实 bus route**（2站+路+depot+3车在跑, stats 可查）
- [x] 经济反馈可观测: CompanyEconomy money/income 持续回灌（runner S5 快照 + signed 解析）
- [x] `pnpm run gate` 全绿
- [ ] （移到 S6）"开始盈利" — 需脑决策 + 分段铺路解除长路线限制

**里程碑映射**: M2 前半（通信 + 手施工）；脑接线与盈利归 v0.2.1。

### v0.2.1 — Pi Agent（LLM）接线（M2 后半）（下一步）
- Pi Agent Core 装配 tool: observe/build_bus_route/add_vehicles/pause + AgentMessage
- **前置技术债: 分段铺路**（每段 ≤60 tile 拼接）解除 AyStar 长路死锁，让 LLM 可选远/长路线（票费高才有盈利）
- LLM 决策选镇对/路线/车队/贷款 → 复用已验证命令通道 → 结果回灌
- `transformContext` 记忆注入 v1；LLM 决策全量落审计
- **验收**: LLM（人工 prompt）驱动一条**盈利**公交线（SPEC §10.8 M2 完整验收）

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

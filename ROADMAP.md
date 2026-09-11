# ROADMAP — OpenTTD LLM Agent Framework

> 渐进式开发计划。从 v0.0.1（脚手架 + MVP）开始，每版都保持「可运行 + 测试绿 + 门禁过」。
> 原则：**先打通最小闭环，再进化；任何版本不得以破坏测试/门禁为代价堆功能。**

---

## 版本规划

### 进度速览
- ✅ v0.0.1 — 脚手架 + MVP（Admin Port 最小闭环，真机验证通过）
- ✅ **v0.1.0 — 观测闭环（M1）（2026-09-08 完成）**
- ✅ **v0.2.0 — 通信 + Executor「手」（M2 前半）（2026-09-09 完成）**
- 🔵 **v0.2.1 — Pi Agent「脑」接线（M2 后半）（接线完成，盈利验收待真实 LLM）**
- ✅ **v0.3.0 — Dashboard 打磨（观测/配置/复盘三页）（2026-09-10 完成）**
- ✅ **v0.4.0 — Dashboard UX 重构（可搜索选型 / 信息层级 / 图表）（2026-09-11 完成）**
- ✅ **v0.5.0 — 启动门禁 + Session 生命周期 + 图表语义（2026-09-11 完成）**
- ⬜ v0.3.1 — 进化闭环（M3）
- ⬜ v0.4.0 — 打磨与广度（M4）

---

### v0.5.0 — 启动门禁 + Session 生命周期（✅ 完成, 2026-09-11）
**目标**: 先决条件不满足就拒绝启动；进程异常结束时不再谎报 running；修正图表语义。

1. `src/agent/preflight.ts`：binary / dataDir / ports / llmConfigured / **llmReachable** / gsFiles，
   **在任何副作用之前**执行（不 spawn、不建 session）✅
2. **移除静默 faux 降级**：`--offline-demo` 是唯一显式豁免，UI 标注为非真实 LLM ✅
3. 心跳 + `interrupted` 派生状态 + 启动和解（历史自愈）✅
4. 崩溃兜底：`uncaughtException` / `unhandledRejection` / `SIGHUP` ✅
5. Token 图改**堆叠柱**（构成语义）+ 柱图**零基** + 空态定尺寸 ✅
6. Live 页排版对齐；Reasoning 独立面板 ✅

**验收**
- [x] `pnpm run gate` 全绿（202 passed / 1 skipped）
- [x] 三条拒绝路径（无 LLM / 无二进制 / 端口占用）均 `Nothing was started`，未 spawn、未写 session
- [x] SIGKILL 后重启和解 → 仪表盘由 running 变 interrupted；running/aborted/interrupted 同屏正确
- [x] 密钥零泄漏（输出中 `sk-` 计数 0）

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
- ✅ **分段贪心铺路已实现并真机验证**（SPEC §10.15）: AyStar v6 长路死锁解除——
  PhaseRoad 每 tick 只搜 ~20 tile 短段、probe 回退、末段直达 fB；GS 选镇放宽到
  [25..260]。真机: 109-tile 路线 103 段铺成 + bus 跑起（commit 见 §10.15 前）

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
- [x] 分段铺路解除长路线限制（v0.2.1 前置技术债, SPEC §10.15）
- [ ] （移到 S6）"开始盈利" — 需脑决策选择路线/投资规模

**里程碑映射**: M2 前半（通信 + 手施工）；脑接线与盈利归 v0.2.1。

### v0.2.1 — Pi Agent（LLM）接线（M2 后半）（✅ 接线完成, 2026-09-09）
- ✅ Pi Agent Core 装配 tool: `observe`/`build_bus_route`/`add_vehicles`/`set_pause` + `CustomAgentMessages`（`game_observation`/`action_result`）
- ✅ 前置技术债: 分段铺路（SPEC §10.15）—— LLM 可选远/长路线
- ✅ LLM 决策 → 复用已验证命令通道 → 结果回灌（真机: 真实 HTTP provider 驱动一条线）
- ✅ `transformContext` v1（历史剪枝 + lessons 注入 hook）；✅ 决策/动作 **JSONL 审计**
- ✅ **Provider 配置**: env / CLI flags / **Web dashboard 面板**（Base URL / Model / key / API），持久化 `<dataDir>/llm.json`，key 脱敏
- ⬜ **验收（未完成）**: 真实 LLM 驱动一条**盈利**公交线 —— 需用户提供 provider key + 更长观察期；架构与通道已就绪
- ⬜ 后置: 其余 tools（train/orders/reflection）、事件镜像给 Web、决策点绑定游戏月份、session 分支

### v0.3.0 — Dashboard 打磨（✅ 完成, 2026-09-10）
**目标**: 把 dashboard 从「极客 log 面板」做成能用的 Agent 控制台；
发挥 pi-ai 内置多 Provider 能力；引入多 Session 与遥测。

**已完成交付**
1. 三页式独立子页（Live `/` / Providers `/llm` / Sessions `/sessions`），
   按角色分目录 `pages/` + `assets/{css,js}/`，`PAGES` 路由表为单一事实源 ✅
2. **多 Provider**：pi-ai 内置 39 provider / ~1900 模型目录 + 环境变量自动检测
   （合成 env 探测出真实变量名，31/39）+ 文件版凭证存储（重启不丢）✅
3. **Agent 遥测**：token（总量/按 turn/按 tool）、思考流、每步 log、工具耗时/失败 ✅
4. **多 Session**：每局落盘（meta/events/audit/telemetry + index），含成绩单与阶段性总结 ✅
5. **事件结构化**：类别 Tag + 人类可读摘要 + 过滤；原始 JSON 默认折叠保留 ✅
6. 冻结契约 `docs/DASHBOARD-API.md` + 无构建链前端的门禁测试（`web-assets.test.ts`）✅

**验收**
- [x] `pnpm run gate` 全绿（151 passed / 1 skipped）
- [x] 真机 `--watch` 三页 200 + WS snapshot/event + session 落盘
- [x] 真机 `--agent`（仅 llm.json）REAL provider → token 计量 1790、步骤/审计/成绩单落盘
- [x] 无构建链前端不再有「看不见的语法错误」风险（`node --check` 门禁）

### v0.3.1 — 进化闭环（M3）
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

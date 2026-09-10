# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-09

### Added (决策闭环 M2)
**v0.2.0 — 通信 + Executor「手」（真机验证）**
- **`src/game/squirrel/bridge-gs/`**: BridgeV1 GS —— Admin↔游戏内双向 JSON 通道 + 标牌邮箱 + `build_bus_route`/`add_vehicles` 命令；规划层选镇对（分段铺路后可到 260 tile）
- **`src/game/squirrel/executor-ai/`**: ExecutorV1 AI —— 读标牌 → 建站 → **分段贪心铺路**（解除 AyStar v6 长路死锁）→ depot → 买 bus + 订单 + 运行；`SetPhase` 公司名编码对外汇报
- **`src/game/squirrel-deploy.ts`**: Squirrel 包部署 + sandbox `[game_scripts]` 选 GS
- **`src/game/v02-runner.ts` + CLI `--v02`**: 全链路 demo（GS 心跳 → 施工 → 经济反馈）

**v0.2.1 — Pi Agent「脑」（接线真机验证）**
- **`src/agent/`（新模块）**:
  - `runtime.ts`：pi-agent-core Agent 装配（tools + convertToLlm + transformContext + before/afterToolCall）
  - `tools/index.ts`：首批 4 个 tool —— `observe` / `build_bus_route` / `add_vehicles` / `set_pause`（typebox schema，异步 ack 语义）
  - `provider.ts`：用 **pi-ai 官方 `createProvider` + `openAICompletionsApi`** 从配置装配 provider（任意 OpenAI 兼容端点）
  - `llm-settings.ts`：`<dataDir>/llm.json` 持久化 + env>file 优先级 + key 脱敏视图
  - `context.ts`：`transformContext` 历史剪枝 + lessons 注入 hook（v0.3）
  - `audit.ts`：决策/动作 **JSONL 审计**（append-only，密钥自动脱敏）
  - `loop.ts`：决策点编排（observation → prompt → tools）
  - `messages.ts`：`CustomAgentMessages` 声明合并（`game_observation` / `action_result`）
  - `runner.ts` + CLI `--agent`：真实游戏 + 脑驱动的完整闭环
- **Web Dashboard**: 新增「LLM provider」面板（Base URL / Model / API key / API 类型）+ `GET|POST /api/llm`（key 永不回显）
- **`scripts/llm-stub.ts`**: 本地 OpenAI 兼容 stub（离线端到端验证接线，非 faux）

### Fixed
- **Executor 长路死锁**：Pathfinder.Road v4 + AyStar v6 对 >~60 tile 单次 FindPath 不返回 → 改**分段贪心铺路**（每段 ~20 tile + probe 回退 + 末段直达目标）
- **road type 前置条件**：`BuildRoadStation` 与 pathfinder 邻居探测都需 `AIRoad.SetCurrentRoadType(ROADTYPE_ROAD)`，否则恒失败
- **depot 门未接路**：车永远卡在 depot 内 → 补 `ConnectStop(depotTile, front)`
- **站入口方向**：pax 精扫须保持 GS 给的 front 相对方向，避免 `ERR_LAND_SLOPED`
- **income 符号**：协议 u64 承载负利润 → `BigInt.asIntN(64, …)`
- **观测期轮询**：company name 变更仅轮询可见；报告路径 API 必须包 try/catch（否则静默停止汇报）

### Verified (真机)
- **手**：`boot→work→stA_ok→stB_ok→road_built(r103)→dpt_ok→dpt_conn→bus_live→done stN2 r103 bus`；`vehicles=3 stations=2`；站队列被消化
- **脑**：真实 HTTP provider（`--agent` + 本地 OpenAI 兼容端点）→ LLM 工具调用 → 命令通道 → 施工 → 经济回灌；审计 JSONL 落盘
- **单测**：90 passed / 1 skipped（含本地 HTTP stub 的真实 provider 链路测试）

### Notes
- **"盈利"验收未完成**：属带脑决策质量（选镇/投资规模），需真实 LLM + 更长观察期（见 ROADMAP v0.2.1）
- 其余 tools（`build_train_route` / `adjust_orders` / `request_reflection`）、事件镜像给 Web、决策点绑定游戏月份 → 后置

## [0.1.0] - 2026-09-08

### Added (观测闭环 M1)
- **`src/game/admin-client.ts`**: 完整 AdminClient（connect/join/subscribe/poll/rcon/gs + 状态回调 + 优雅关闭）；默认订阅 date/company/economy/stats/console
- **`src/game/world-state.ts`**: 内存权威状态（日期/公司注册表/economy/stats/环形事件缓冲）
- **`src/game/runner.ts`**: 长驻观测循环（spawn → start_ai → AdminClient → WorldState → WebServer 广播 + 周期 poll）；SIGINT 优雅关闭
- **`src/game/ai-registry.ts`**: AI 可用性探测（已知内置集 + `OPENTTD_AI_LIST` 覆盖）
- **`src/util/json.ts`**: BigInt-safe 序列化（economy 的 u64 money/loan 不丢精度）
- **`src/web/server.ts` + `public/*`**: HTTP 静态 + WS 扇出；原生 HTML+Canvas 仪表盘（公司卡片/现金曲线/事件流），无构建链
- **CLI `--watch`**: 起服 + start_ai + 长驻采集 + Web 仪表盘；`--ai`/`--web-port` 参数
- **`test/live/observation.test.ts`**: @live 真机集成（`LIVE_TESTS=1` 才跑）
- **`ws` 依赖**: 唯一运行时依赖（WebSocket）

### Fixed
- `decodeErrorText` 修正: ServerError 是单 NUL 字符串而非 cstr 对
- economy payload 的 BigInt 在 JSON 序列化崩溃（probe 无公司从未触达）—— 现在全链路 BigInt-safe

### Verified (真机)
- `rcon start_ai "CPU"` → company_new → company_info(isAi) → company_economy(poll 即时返回, money=100000 loan=100000)
- `--watch` 端到端: dashboard HTTP 200; WS snapshot + 增量 economy/date 事件（seq 单调递增）; SIGINT 优雅关闭无残留

## [Unreleased]

### 规划中 (见 ROADMAP.md)
- v0.1.0: 观测闭环（Web 仪表盘 + GS rich state）
- v0.2.0: 最小决策闭环（Executor AI + Pi Agent）
- v0.3.0: 进化闭环（lessons/策略库/metrics）
- v0.4.0: 打磨与广度

## [0.0.1] - 2026-09-07

### Changed
- **包管理器切换到 pnpm**: 移除 `node_modules`/`package-lock.json`；改用 `pnpm-lock.yaml`；
  脚本从 `npm run *` 改为 `pnpm *`；移除未使用的 `zod` 依赖；声明
  `pnpm.onlyBuiltDependencies`（esbuild）允许构建脚本。磁盘占用更小、安装更快。
  （注：pnpm 传递 CLI 参数不需要 `--`，如 `pnpm run cli --probe`）

### Added (MVP — 脚手架 + Admin Port 最小闭环)
- **工程脚手架**: TypeScript strict + ESM + vitest + eslint flat config；`pnpm run gate`（typecheck+lint+test 一键门禁）
- **开发规范**: `AGENTS.md`（TDD 先行 / 门禁铁律 / 职责与禁止项）；`ROADMAP.md`（渐进式计划）
- **Admin Port 协议层** (`src/game/admin-protocol.ts`)
  - 完整 packet 类型枚举（值对齐 `tcp_admin.h`）+ UpdateType/Frequency 枚举
  - 帧编解码（u16 LE 含自身长度前缀 + u8 type + payload；NUL 结尾字符串；LE 整数）
  - `FrameWriter` / `ByteReader` / `FrameStreamParser`（增量流式拆帧）
- **Payload 解析** (`src/game/payload-parsers.ts`, `src/game/observer.ts`)
  - OpenTTD 日历算法（raw date → y/m/d；锚点 712223=1950-01-01 已真机校准）
  - CompanyEconomy/CompanyInfo/CompanyStats/Chat/Console/GameScript/Date 规范化事件
  - `decodeWelcome` / `decodeServerRconResponse`
- **蓝图通道** (`src/game/blueprint.ts`): 高层动作 → GS 蓝图 JSON（job 0..999 / path ≤200 校验）
- **进程管理** (`src/game/process-manager.ts`)
  - 隔离 data dir；generate-then-patch 配置（绕过 OpenTTD 15 覆盖手写 `secrets.cfg` 的行为）
  - spawn/stop/日志尾/`waitForAdminPort` 探活
- **配置** (`src/config.ts`): env 驱动的全量可配（二进制/端口/seed/年份/地图尺寸）
- **CLI** (`src/cli/run.ts`): `--probe`（真机最小闭环）+ `--dry-run`
- **测试**: 40 个单测（codec golden / 日历 / 蓝图 / observer / 配置 / 进程生命周期），全绿

### Changed
- `SPEC.md` v0.2: 固化两轮源码级调研（动作面/观察模型/通信链路/GS-only 候选）；v0.0.1 完成后新增 §10.6 M0 实测结果

### Fixed / Verified (M0 实测)
- Admin listener 需要 `secrets.cfg` 中非空 `admin_password`（OpenTTD 15 将密码移出 `openttd.cfg`）
- 手写 `secrets.cfg` 会被 OpenTTD 重建清空 → 必须先生成再 patch
- headless 起服参数与日历锚点均已真机校准
- 新地图无公司属预期行为（CompanyEconomy 需公司存在才推送）

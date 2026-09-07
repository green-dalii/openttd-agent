# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

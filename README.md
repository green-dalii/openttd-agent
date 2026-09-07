# openttd-agent

> LLM agent framework that autonomously plays — and self-evolves inside — OpenTTD.
> External brain (Pi `@earendil-works/pi-agent-core`) ↔ Admin Port TCP ↔ in-game Bridge GS / Executor AI.

**当前状态: v0.1.0 (观测闭环)** — 长驻采集 + 实时 Web 仪表盘；真机验证含公司经济观测。
完整设计见 [`SPEC.md`](SPEC.md)，开发计划见 [`ROADMAP.md`](ROADMAP.md)，开发规范见 [`AGENTS.md`](AGENTS.md)。

---

## 它能做什么（v0.1.0）

### 一键观测（长驻 + Web 仪表盘）
```
pnpm run cli --watch --seed 42
# 打开打印的 http://127.0.0.1:<port>/ 看实时仪表盘; Ctrl-C 优雅关闭
```

起一个**隔离的** OpenTTD 15.0 dedicated server（不碰你 `~/Documents/OpenTTD` 的配置），然后：
1. 生成 sandbox 配置（`openttd.cfg` + `secrets.cfg` 里的 `admin_password`）
2. 拉起 headless 服务器（`-D -t 1950 -G <seed>`）
3. `rcon start_ai "CPU"` 创建一家可观测的 AI 公司（公司才有 economy/价值曲线）
4. **AdminClient** 订阅 + 周期 poll 公司经济/日期
5. **Web 仪表盘** (HTTP + WS, 原生 HTML+Canvas)：公司卡片（现金/贷款/收入/价值）、现金曲线、事件流
6. Ctrl-C 优雅关闭（pause + 收尾）

### 一次性最小闭环
```
pnpm run cli --probe [--year 1950] [--seed 42] [--timeout-ms 15000]
```
起服 → admin join → 收 date/company 事件 → rcon pause → 优雅关，打印规范化事件。

### 真机集成测试
```bash
OPENTTD_BINARY=<路径> pnpm run test:live   # 需要 LIVE_TESTS=1 自动
```

---

## 快速开始

### 前置
- Node.js ≥ 22.19
- **pnpm ≥ 10**（本项目用 pnpm 管理依赖：快、省磁盘。
  `npm install -g pnpm`；npm 兼容层不维护）
- 本机 OpenTTD 15.x（Steam 安装路径已知；可用 `OPENTTD_BINARY` 覆盖）

### 安装
```bash
pnpm install
```

### 开发门禁（提交前必跑）
```bash
pnpm run gate          # typecheck + lint + test 一键
pnpm test              # 仅单测
pnpm run test:live     # 含真机集成 (需本机 OpenTTD)
```

### CLI
```bash
# 打印解析后的配置（不起服）—— CI/快速检查用
pnpm run cli --dry-run

# 真机最小闭环探测
pnpm run cli --probe [--year 1950] [--seed 42] [--timeout-ms 15000]

# 长驻观测 + Web 仪表盘 (v0.1.0)
pnpm run cli --watch [--seed 42] [--ai CPU] [--web-port 8080]
```

### 环境变量（全可配）
| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENTTD_BINARY` | Steam 路径 | OpenTTD 可执行文件 |
| `OPENTTD_DATA_DIR` | `/tmp/openttd-agent-data` | 隔离 data dir（自动生成/改写配置） |
| `OPENTTD_ADMIN_PORT` | `3977` | Admin Port |
| `OPENTTD_ADMIN_PASSWORD` | `openttd-admin` | Admin 密码（写入 sandbox `secrets.cfg`） |
| `OPENTTD_GAME_PORT` | `3979` | 游戏端口 |
| `OPENTTD_START_YEAR` | `1950` | 开局年份 |
| `OPENTTD_SEED` | 随机 | 地图种子（可复现） |
| `OPENTTD_MAP_SIZE` | `small` | `small\|medium\|large` = 256/512/1024 |
| `OPENTTD_SERVER_NAME` | `openttd-agent` | 服务器名 |
| `OPENTTD_AI_LIST` | 内置集 | 逗号分隔的可 start_ai AI 名（覆盖默认探测） |

---

## 架构速览

```
┌─────────────── Browser (Web UI, 未来) ───────────────┐
└───────────────────────┬──────────────────────────────┘
                        │ WebSocket
┌───────────────────────▼──────────────────────────────┐
│ Agent Runner (Node/TS 单进程)  [v0.1+]                │
│  · Pi Agent Core (LLM 决策)                          │
│  · AdminClient (纯 TS 协议)                          │
│  · ProcessManager / Observer / Blueprint             │
└───────────────────────┬──────────────────────────────┘
                        │ TCP Admin Port (双向 JSON + RCON)
┌───────────────────────▼──────────────────────────────┐
│ OpenTTD 15 dedicated server (headless)                │
│  · Bridge GS   — 状态推送 + 命令分发 (唯一 GS)        │
│  · Executor AI — 消费蓝图标牌施工 (公司替身)          │
└───────────────────────────────────────────────────────┘
```

**关键设计事实**（详见 SPEC §10）:
- Admin Port 的 RCON 面只做服务器级操作；**真正的"玩"（铺轨/建站/买车/订单）靠游戏内 Squirrel AI/GS API**。
- LLM = 脑（高层动作）→ 蓝图 JSON → Bridge GS → 标牌 → Executor AI 施工。
- 观察 = Admin 原生（公司级）+ GS `GSAdmin.Send`（城镇/工业/车辆级 rich state）。

---

## 目录

```
src/
  types.ts                  # 共享类型 (单一事实源)
  config.ts                 # env 配置 (zod-free, 手动校验)
  util/
    json.ts                 # BigInt-safe JSON (economy u64 金额)
  game/
    admin-protocol.ts       # Admin Port 字节编解码 (帧/枚举/reader/writer)
    payload-parsers.ts      # payload → 类型化对象 (含日历算法)
    observer.ts             # 原始包 → 规范化 GameEvent
    admin-client.ts         # 完整 AdminClient (connect/join/sub/poll/rcon/gs)
    world-state.ts          # 内存权威状态 (公司/日期/economy/事件缓冲)
    runner.ts               # 长驻观测循环 (v0.1.0 --watch)
    ai-registry.ts          # AI 可用性探测
    blueprint.ts            # 高层动作 → GS 蓝图 JSON (校验)
    process-manager.ts      # 服务器生命周期 (generate-then-patch 配置)
  web/
    server.ts               # HTTP 静态 + WS 扇出
    public/                 # 原生仪表盘 (index.html/app.js/style.css)
  cli/run.ts                # CLI: --probe / --dry-run / --watch
test/
  unit/                     # 纯单测 (vitest), 59 用例
  live/                     # 真机集成 (LIVE_TESTS=1 才跑)
  helpers/                  # live skip helper
```

## 已知边界 (v0.1.0)
- 观测到的是 **AI 公司**（start_ai 创建）；尚无 LLM agent 接线（v0.2）
- 仪表盘只读：WS 上行被忽略（v0.1 不做远程控制）
- Admin 认证为明文 + 仅 127.0.0.1（SPEC D11 权衡）
- AI 可用性探测是「已知集」而非文件系统扫描（tar 未解包时文件系统不可靠，见 ai-registry）

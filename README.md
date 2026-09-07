# openttd-agent

> LLM agent framework that autonomously plays — and self-evolves inside — OpenTTD.
> External brain (Pi `@earendil-works/pi-agent-core`) ↔ Admin Port TCP ↔ in-game Bridge GS / Executor AI.

**当前状态: v0.0.1 (MVP)** — 工程脚手架 + 已验证的「外部进程 ↔ OpenTTD Admin Port」最小闭环。
完整设计见 [`SPEC.md`](SPEC.md)，开发计划见 [`ROADMAP.md`](ROADMAP.md)，开发规范见 [`AGENTS.md`](AGENTS.md)。

---

## 它能做什么（v0.0.1）

```
npm run cli -- --probe
```

起一个**隔离的** OpenTTD 15.0 dedicated server（不碰你 `~/Documents/OpenTTD` 的配置），然后：
1. 生成 sandbox 配置（`openttd.cfg` + `secrets.cfg` 里的 `admin_password`）
2. 拉起 headless 服务器（`-D -t 1950 -G <seed>`）
3. 通过 **Admin Port (TCP 3977)** 完成认证 + 订阅 Date + 轮询公司经济
4. 收到并解码真实 `ServerDate`（如 `raw 712223 → 1950-01-01`）
5. `rcon pause` 并优雅关闭

这就是整个框架的地基：**外部 TypeScript 进程能可靠地连接、观察、控制 OpenTTD**。

---

## 快速开始

### 前置
- Node.js ≥ 22.19
- 本机 OpenTTD 15.x（Steam 安装路径已知；可用 `OPENTTD_BINARY` 覆盖）

### 安装
```bash
npm install
```

### 开发门禁（提交前必跑）
```bash
npm run gate          # typecheck + lint + test 一键
npm test              # 仅单测
npm run test:live     # 含真机集成 (需本机 OpenTTD)
```

### CLI
```bash
# 打印解析后的配置（不起服）—— CI/快速检查用
npm run cli -- --dry-run

# 真机最小闭环探测
npm run cli -- --probe [--year 1950] [--seed 42] [--timeout-ms 15000]
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
  game/
    admin-protocol.ts       # Admin Port 字节编解码 (帧/枚举/reader/writer)
    payload-parsers.ts      # payload → 类型化对象 (含日历算法)
    observer.ts             # 原始包 → 规范化 GameEvent
    blueprint.ts            # 高层动作 → GS 蓝图 JSON (校验)
    process-manager.ts      # 服务器生命周期 (generate-then-patch 配置)
  cli/run.ts                # CLI: --probe / --dry-run
test/unit/                  # 纯单测 (vitest), 40 用例
```

## 已知边界 (v0.0.1)
- 尚无公司/GS/Executor AI —— 新地图无公司是预期的（见 SPEC §10.6-6）
- 尚无 LLM agent 接线（v0.2）
- Admin 认证为明文 + 仅 127.0.0.1（SPEC D11 权衡）

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

# v0.2 决策闭环（手）：Bridge GS + Executor AI 自动建一条公交线
pnpm run cli --v02 --demo-seconds 150

# v0.2.1 决策闭环（脑）：pi-agent-core LLM 决策 → 命令通道 → 施工 → 回灌
pnpm run cli --agent --demo-seconds 240 \
  --llm-base-url https://api.openai.com/v1 --llm-model gpt-4o-mini --llm-key "$OPENAI_API_KEY"
```

### LLM Provider 配置（v0.2.1）
脑（LLM）通过 **pi-ai 官方 provider 组件**接入，支持任意 OpenAI 兼容端点
（OpenAI / DeepSeek / 本地 llama.cpp·vLLM / 网关）。三种配置方式，优先级
**环境变量 > `<dataDir>/llm.json` > 未配置**：

1. **环境变量 / CLI 参数**
   ```bash
   export LLM_BASE_URL=https://api.deepseek.com/v1
   export LLM_MODEL=deepseek-chat
   export LLM_API_KEY=sk-...
   pnpm run cli --agent
   # 或: pnpm run cli --agent --llm-base-url ... --llm-model ... --llm-key ...
   ```
2. **Web Dashboard 面板**：`pnpm run cli --watch` 打开 `http://127.0.0.1:<port>/`，
   在「LLM provider」面板填写 Base URL / Model / API key / API 类型并 Save
   （写入 `<OPENTTD_DATA_DIR>/llm.json`，下次 agent 运行生效；key 不会回显）。
   > 面板只在 `--watch` 模式存在（`--agent` 不起 WebServer）；
   > `LLM_*` 环境变量仍然**优先于**面板保存的文件值。
3. **未配置时**：`--agent` 回退到离线 faux provider（脚本化，仅演示接线，**不是真 LLM**）。

**配置文件落盘位置**（dashboard / 后续 CLI 保存都写这里）：

```
<OPENTTD_DATA_DIR>/llm.json        # 默认: /tmp/openttd-agent-data/llm.json
├─ providerId / baseUrl / model / api
└─ apiKey                          # 明文存储（仅本机 127.0.0.1，勿提交/勿共享）
```
同一目录还落 `agent-audit.jsonl`（决策/动作审计）。

### 端到端验证（真机，两种方式）

**方式 A — 纯 CLI（最快）**
```bash
pnpm exec tsx scripts/llm-stub.ts 8787 &              # 本地 OpenAI 兼容 stub
LLM_BASE_URL=http://127.0.0.1:8787/v1 LLM_MODEL=stub LLM_API_KEY=stub \
  pnpm run cli --agent --demo-seconds 150
# 期望: [agent] brain: REAL provider ... → tool build_bus_route: ok=true
#       → GS ack → executor 施工 → 经济回灌
```

**方式 B — dashboard 保存 → 文件生效（验证持久化链路）**
```bash
export OPENTTD_DATA_DIR=/tmp/e2e-data OPENTTD_SEED=7
pnpm exec tsx scripts/llm-stub.ts 8787 &
pnpm run cli --watch --seed 7 --web-port 8187 &

curl -s http://127.0.0.1:8187/api/llm              # 初始: configured=false
curl -s -X POST http://127.0.0.1:8187/api/llm -H 'content-type: application/json' \
  -d '{"baseUrl":"http://127.0.0.1:8787/v1","model":"stub","apiKey":"sk-x"}'
cat $OPENTTD_DATA_DIR/llm.json                     # ← 配置文件就落在这里

# Ctrl-C 停掉 watch，然后用**另一个进程**验证文件真的生效（清空所有 LLM env）
env -u LLM_BASE_URL -u LLM_MODEL -u LLM_API_KEY -u LLM_PROVIDER -u LLM_API \
    -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  pnpm run cli --agent --demo-seconds 150
# 期望: [agent] brain: REAL provider ... (key=sk-x…xxxx 已脱敏)
#       [agent] audit: <dataDir>/agent-audit.jsonl
```
真机实测结论（2026-09-09）：dashboard 保存→文件→另一个进程 `--agent` 读到并走
REAL provider、真发 HTTP、产生 `build_bus_route` 调用（SPEC §10.16-8）。

### 环境变量（全可配）
| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENTTD_BINARY` | Steam 路径 | OpenTTD 可执行文件 |
| `OPENTTD_DATA_DIR` | `/tmp/openttd-agent-data` | 隔离 data dir（自动生成/改写配置） |
| `OPENTTD_ADMIN_PORT` | `3977` | Admin Port |
| `OPENTTD_ADMIN_PASSWORD` | `openttd-admin` | Admin 密码（写入 sandbox `secrets.cfg`） |
| `OPENTTD_GAME_PORT` | `3979` | 游戏端口 |
| `OPENTTD_START_YEAR` | `1950` | 开局年份 |
| `LLM_BASE_URL` | *(空)* | LLM provider base URL（OpenAI 兼容）；空=未配置 |
| `LLM_MODEL` | *(空)* | 模型 id（如 `gpt-4o-mini` / `deepseek-chat`） |
| `LLM_API_KEY` | *(空)* | API key（别名：`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`） |
| `LLM_PROVIDER` | `openttd-llm` | provider id（写入 pi-ai 注册表） |
| `LLM_API` | `openai-completions` | 流式 API（`openai-completions` \| `anthropic-messages`） |

> LLM 面板保存的设置文件位置 = `<OPENTTD_DATA_DIR>/llm.json`（默认
> `/tmp/openttd-agent-data/llm.json`）；env 显式设置时**覆盖**该文件。
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

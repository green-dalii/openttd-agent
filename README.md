# openttd-agent

> LLM agent framework that autonomously plays — and self-evolves inside — OpenTTD.
> External brain (Pi `@earendil-works/pi-agent-core`) ↔ Admin Port TCP ↔ in-game Bridge GS / Executor AI.

**当前状态: v0.6.0 (决策循环对齐 SPEC + 运行控制)** — 观测 + 决策闭环 + 三页式 Dashboard（Live / Providers / Sessions）、
39 个内置 provider 目录、token 计量、历史局复盘与运行对比。**盈利验收待真实 LLM key**。
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
| `LLM_SOURCE` | *(自动)* | `catalog`（内置 provider，只需 provider+model）\| `custom`（自建端点） |

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
    server.ts               # HTTP 路由表(PAGES) + REST + WS 扇出
    public/
      pages/                # 一页一个 HTML
        live.html           #   Live     ：实时游戏 + agent 遥测
        providers.html      #   Providers：provider 目录选型 + 密钥
        sessions.html       #   Sessions ：历史局管理 / 复盘
      assets/css/style.css  # 全部样式 + 设计 token
      assets/js/
        charts.js           # 图表模块（折线/柱/环/迷你线，自建无依赖）
        common.js           # 共享 UI 原语（格式化/组合框/Toast/WS）
        live.js             # 页面脚本：live.html
        providers.js        # 页面脚本：providers.html
        sessions.js         # 页面脚本：sessions.html
  cli/run.ts                # CLI: --probe / --dry-run / --watch / --v02 / --agent
test/
  unit/                     # 纯单测 (vitest), 151 用例
  live/                     # 真机集成 (LIVE_TESTS=1 才跑)
  helpers/                  # live skip helper
docs/
  DASHBOARD-API.md          # dashboard 前后端**冻结契约**（改前必读）
```

## 三种启动方式怎么选

| 命令 | LLM | 能否控制 | 面板表现 |
|---|---|---|---|
| `pnpm run cli --watch --seed 7 --web-port 8187` | 无（观察内置 AI） | 只能 Ctrl-C | **Token/步骤是空的，这是正常的** |
| `pnpm run cli --agent --web-port 8187` | 需要 | 只能 Ctrl-C | token/步骤/思考/阶段图齐全 |
| `pnpm run cli --serve --web-port 8187` | 需要 | **页面可 开始/停止/暂停/恢复** | 同上，且可切换 agent/watch |

`--watch` 与 `--seed 7` **不冲突**，命令可直接用——它只是"只看不打"，
所以看不到 LLM 的决策与 token。想看智能行为就用 `--agent` 或 `--serve`。

## 运行控制（v0.6.0）

```bash
pnpm run cli --serve --web-port 8080
```
常驻 dashboard，**页面即可开始 / 停止 / 暂停 / 恢复**一次运行，无需重启进程：

| 操作 | 端点 | 说明 |
|---|---|---|
| 状态 | `GET /api/run` | `idle \| starting \| running \| paused \| stopping` |
| 开始 | `POST /api/run/start` `{mode:"agent"\|"watch"}` | 已在跑则 **409**（不会静默替换） |
| 停止 | `POST /api/run/stop` | 优雅停止，session 记为 **`aborted`** |
| 暂停/恢复 | `POST /api/run/pause` \| `/resume` | 游戏级 pause + 决策节拍停/启 |

> **`--agent` 与 `--watch` 的区别**：`--agent` 有 LLM（才有 token/步骤/思考）；
> `--watch` **只观察游戏内置 AI**，因此那些面板**本来就会是空的**——
> 页面现在会直接说明这一点，并给你「Start agent」按钮。

## 决策循环（v0.6.0，对齐 SPEC §1.1/§4.2）

框架只是框架：**不给建议、不做策略**，只负责「何时问、问什么、把决定交给执行器」。

- **冻结-观察-决策-执行-解冻**：决策前 `pause`，决策后 `unpause`（否则模型思考时世界还在变）
- **触发**：开局 / 施工阶段变化 / 模型自定的 `wait_until` / 每月兜底 / 显著事件 / 手动
- **喂给模型的是因果**：不止当前状态，还有 `sinceLastDecision`（金额与车辆变化、
  期间阶段、上次动作结果）——这样它才知道自己上一次的改动有没有起效
- **模型产出结构化计划**：`{goal, plan[], immediate_action, wait_until, rationale}`

## 启动门禁（v0.5.0）

**先决条件不满足就拒绝启动，绝不静默跑假模拟。** 每个模式启动前都会检查：

```
$ pnpm run cli --agent --web-port 8080
[preflight] ERROR: prerequisites not met
  ✓ binary     /Applications/.../openttd
  ✓ dataDir    /tmp/openttd-agent-data (writable)
  ✓ ports      admin 3977, game 3979 free
  ✗ llmConfigured no provider/model configured
      → Configure one on the Providers page (pnpm run cli --agent --web-port 8080),
        or set LLM_PROVIDER/LLM_MODEL. To run the scripted demo instead, pass --offline-demo.
Nothing was started: fix the items above and run again.
```

| 检查 | 说明 |
|---|---|
| `binary` | OpenTTD 可执行文件存在**且可执行** |
| `dataDir` | 数据目录可创建可写 |
| `ports` | admin/game 端口未被占用 |
| `llmConfigured` | agent 模式**必须**配好 provider/model（`--watch` 是纯观测，不需要 LLM） |
| `llmReachable` | 对 LLM 发一次**真实最小请求**——配置完整 ≠ 可用（key 失效/端点不可达/模型下线） |
| `gsFiles` | GameScript 源（warn，不阻断） |

- `--offline-demo` — **唯一**允许无 LLM 运行的显式开关（会在 UI 标注为非真实 LLM）
- `--skip-preflight` — 只跳过非安全项用于调试；二进制与 LLM 检查不可跳过
- 检查**在任何副作用之前**完成：不会 spawn 游戏、不会写 session

## 阶段性画面（真实小地图）

每个施工阶段自动抓一张**真实小地图**（`screenshot minimap`，256×256 PNG），
存 `<session>/stages/NNN.png`，与同名的几何描述 JSON 配对：

- 小地图由**地图数据**渲染，不需要帧缓冲 → headless dedicated server 也能出图
- 视口截图（`screenshot`）**在 headless 下不可用**（需要 3D 视口），实测 `Screenshot failed!`
- 抓取失败时前端自动降级为示意图（由 GS ack 的真实 tile 坐标绘制）
- 仪表盘 Stage views 实时显示；Sessions 页可回放整局所有阶段图

## Session 生命周期（v0.5.0）

进程被 `kill -9` / 崩溃 / 断电时 `finalize()` 不会执行。此前该 Session 会**永远显示
running**，误导用户。现在：

| 结束方式 | 状态 |
|---|---|
| 正常跑完 | `completed` |
| Ctrl-C / SIGTERM / SIGHUP | `aborted`（优雅，有 `endedAt`） |
| 未捕获异常 | `error`（带 message） |
| `kill -9` / 崩溃 / 断电 | 盘上 `running` → 读取时判为 **`interrupted`**；下次启动写盘固化 |

机制：runner 每 2s 写 `heartbeatAt`；读取时 `effectiveStatus()` 判断心跳是否超时
（15s）→ 返回 `interrupted`（**不写盘**，幂等）；新进程启动时
`reconcileStaleSessions()` 把遗留的过期记录固化，历史自愈。

> 详见 [`docs/STARTUP-AND-LIFECYCLE.md`](docs/STARTUP-AND-LIFECYCLE.md)。

## Dashboard（v0.3.0）

三个独立子页（原生 HTML/JS/CSS，**无构建链**）。信息按**紧迫性**分层——
一个长跑的用户回来只想先知道三件事：还在跑吗？在赚钱吗？agent 正常吗？

| 页面 | URL | 内容 |
|---|---|---|
| **Live** | `/` | ① **KPI 条**（Cash/Income/Value/Loan/Fleet/Tokens，带环比 delta + 迷你趋势线）② **Agent**（token 构成、失败率、按 turn 柱图可切 Tokens/Cost、工具延迟表、步骤流可过滤、思考流）③ **Economy**（多序列现金曲线，hover 十字线 + tooltip）④ **Activity**（事件流：类别 chips **带计数**、搜索、**暂停**、原始 JSON 折叠）⑤ **阶段总结时间线** |
| **Providers** | `/providers` | **可搜索组合框**（键盘可用：↑↓/Enter/Esc）从 **pi-ai 内置 39 provider / ~1900 模型**中选型，**按「Ready now / Needs a key」分组**；自动检测环境变量（`DEEPSEEK_API_KEY`、`HF_TOKEN`、`GEMINI_API_KEY`…），已就绪时明确写「无需粘贴」；也支持自建 OpenAI 兼容端点 |
| **Sessions** | `/sessions` | 总览 KPI（完成率/累计 token/花费）+ 卡片式历史列表（含 built/incomplete 徽章）+ 单局复盘（成绩单、token 环图、阶段总结、步骤流、事件流搜索）+ **两次运行对比**（带 Δ 列） |

> 旧 URL `/llm` 仍可用（`PAGE_ALIASES` 内部重写，不再 404）。

```bash
pnpm run cli --watch --web-port 8080      # Live + Providers + Sessions
pnpm run cli --agent --web-port 8080      # 同上 + Agent 遥测（token/思考/步骤）
```

**落盘位置**（全部在 `<OPENTTD_DATA_DIR>`，默认 `/tmp/openttd-agent-data`）:

```
llm.json                     # dashboard 选中的 provider/model/endpoint 选择
credentials.json             # catalog 密钥（0600；绝不回显、绝不在日志里）
agent-audit.jsonl            # 决策/动作审计（append-only）
sessions/index.json          # 历史局索引
sessions/<id>/meta.json      #   局元数据 + 成绩单 + 阶段性总结
sessions/<id>/events.jsonl   #   该局游戏事件
sessions/<id>/audit.jsonl    #   该局决策/步骤/动作
sessions/<id>/telemetry.json #   该局末次遥测（token/步骤）
```

> - 数据/接口契约: [`docs/DASHBOARD-API.md`](docs/DASHBOARD-API.md)（含 WS 协议与 Tag 分类规则）
> - 前端/UX 契约: [`docs/DASHBOARD-UI.md`](docs/DASHBOARD-UI.md)（设计 token、组合框/图表契约、页面信息架构）

## 已知边界 (v0.3.0)
- **盈利验收仍未完成**：需要真实 LLM key + 更长观察期（见 ROADMAP v0.2.1）
- Admin 认证为明文 + 仅 127.0.0.1（SPEC D11 权衡）
- AI 可用性探测是「已知集」而非文件系统扫描（tar 未解包时文件系统不可靠，见 ai-registry）
- OAuth 类 provider（github-copilot / openai-codex / amazon-bedrock / google-vertex）
  在 dashboard 里**只能看到提示**，尚不支持交互式登录流程
- 费用（cost）为 0 时显示 `$0`：本地端点/目录未提供价格时属正常

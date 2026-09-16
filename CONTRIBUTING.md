# CONTRIBUTING — 参与开发指南（命令 / 目录 / 流程的唯一事实源）

> **文档职责**（边界以 `AGENTS.md` §9 为唯一权威）：本文是**怎么参与开发**的
> 操作指南——环境、命令、目录结构、每阶段收尾清单。
> **不收录**：开发准则与铁律（→ `AGENTS.md`，本文只放指针）、系统事实
> （→ `SPEC.md`）、进度（→ `ROADMAP.md`）、版本内容（→ `CHANGELOG.md`）。
>
> **为什么目录树在这里而不是 README**：目录树是高频漂移区（README 曾缺失
> 整个 `agent/` 节、测试数停留在 100+ 个 commit 之前）——收敛到一个地方，
> README 只放指针。

## 1. 环境与前置

- Node >= 22.19，pnpm。
- OpenTTD 15.0（本机 Steam 路径见 `SPEC.md` §D0 环境事实表）。
- 游戏一律用**隔离 data dir**（`-c <dir>/openttd.cfg`），禁止读写
  `~/Documents/OpenTTD`（AGENTS 铁律 3）。
- LLM 凭据：`<dataDir>/credentials.json` + `llm.json`（Providers 页或手写）。

## 2. 命令

| 命令 | 用途 |
|---|---|
| `pnpm run gate` | **提交前必跑**：typecheck + lint（0 警告）+ vendor:check + test |
| `pnpm test` | 纯单测（快，无真机） |
| `pnpm run test:live` | 真机集成（`@live` 标记，需本机 OpenTTD + 可写临时 data dir） |
| `pnpm run gen-squirrel` | 从 `src/game/squirrel/*/main.nut` 生成游戏侧脚本包 |
| `pnpm run cli --agent --seed 7 --no-memory --demo-seconds 200` | 单局真机校准（命令模板见 `ROADMAP.md` 待办区） |
| `pnpm run cli --watch --web-port 8187` | 观测模式（内置 AI，token 面板为空是正常的） |
| `pnpm run cli --serve --web-port 8187` | 页面可 Start/Stop 的模式 |
| `pnpm exec tsx scripts/loop-health.ts <dataDir>` | 循环健康度仪器（决策数/触发分布/空转率） |
| `pnpm exec tsx scripts/m3-verdict.ts <dataDir>` | A/B 判定（含 confounded 守卫） |

## 3. 目录结构（单一事实源，改动目录时**必须**同步此树）

```
src/
  types.ts                  # 共享类型 (单一事实源)
  config.ts                 # env 配置 (手动校验)
  util/json.ts              # BigInt-safe JSON (economy u64 金额)
  game/
    admin-protocol.ts       # Admin Port 字节编解码 (帧/枚举/reader/writer)
    payload-parsers.ts      # payload → 类型化对象 (含日历算法)
    observer.ts             # 原始包 → 规范化 GameEvent
    admin-client.ts         # AdminClient (connect/join/sub/poll/rcon/gs)
    world-state.ts          # 内存权威状态 (公司/日期/economy/事件缓冲)
    runner.ts               # 长驻观测循环 (--watch 模式)
    gs-events.ts            # GS→harness 事件契约 (typebox, Phase A)
    executor-status.ts      # 执行器相位语义 (stage/描述; detail 重建)
    ai-registry.ts          # AI 可用性探测
    blueprint.ts            # 高层动作 → GS 蓝图 JSON (校验)
    process-manager.ts      # 服务器生命周期 (generate-then-patch 配置)
    minimap.ts              # 小地图截图
    wire-snapshot.ts        # dashboard 线上快照
    squirrel/
      bridge-gs/main.nut    # Bridge GS: 命令分发 + 标牌 + 事件中继 (A2)
      executor-ai/main.nut  # Executor AI: FIFO 队列施工状态机
  agent/
    runner.ts               # runAgent 装配 + 进程生命周期 (Phase B 后 650 行)
    signal-hub.ts           # 信号消费: GS 事件→新闻门/账本/boot 缓冲
    decision-loop.ts        # 决策节拍: scheduler→runDecision→因果窗口
    reflect-run.ts          # 局终结算 + 反思 + metrics 上报
    loop-control.ts         # 决策循环纯判据 (deadline/cap/wait)
    runner-helpers.ts       # 纯工具
    route-ledger.ts         # 决策→结果账本 (credit assignment)
    estimate.ts             # 路线造价下界 (事实, 不表态)
    loop.ts                 # 单次决策编排 (observe→LLM→plan)
    decision-context.ts     # 因果窗口数据结构 (tracker)
    scheduler.ts            # 决策调度 (start/phase/event/wait)
    context.ts              # transformContext: 剪枝 + lessons 注入
    tools/index.ts          # LLM 工具 (observe/observe_towns/build_bus_route/…)
    serve.ts / runtime.ts / preflight.ts / telemetry.ts / audit.ts
  evolution/
    memory.ts               # 记忆加载 + lesson 注入 provider
    lessons.ts              # lesson 契约与三道闸 (归一/去重/限量)
    strategies.ts           # 策略卡片 + 双重入库门槛
    reflect.ts              # 反思 evidence 归约
    reflection-run.ts       # 局终反思调用
    route-facts.ts          # 结构化路线记忆 (C-1, 不经 LLM)
    metrics.ts              # A/B 对照 + confounded 守卫
    store.ts / types.ts     # 持久化 + 实体契约
  web/
    server.ts               # HTTP 路由表(PAGES) + REST + WS 扇出
    public/                 # 无构建链前端 (Alpine + 原生 JS)
  cli/run.ts                # CLI: --probe / --dry-run / --watch / --v02 / --agent
scripts/                    # dev 辅助 (gen-squirrel / loop-health / m3-verdict …)
test/
  unit/                     # 纯单测 (vitest)
  live/                     # 真机集成 (@live 标记, LIVE_TESTS=1 才跑)
  fixtures/                 # 协议 golden 字节样张 (来自真机, 不发明)
docs/                       # 单主题深入说明 (指针从 AGENTS §9 表进入)
```

## 4. 开发流程（铁律摘要，全文见 `AGENTS.md` §2）

1. **TDD 先行**：先写会失败的测试（golden 样张必须来自真机/真实日志，禁止发明格式）。
2. **门禁绿**：`pnpm run gate` 红 = 停；0 警告。
3. **重构行为不变的证明**：既有测试零语义改动全绿 + 真机冒烟
   （参照 Phase B 的做法：纯函数先抽+单测，impure 体 1:1 搬，静态不变量测试
   跟随代码位置更新但断言内容不变）。
4. **工具必须观察自己的效果，或明确拒绝**（"永远说'是'的工具毁掉学习"）。
5. **harness 红线**：给 agent 的事实不含建议词（"prefer/should/better"）——
   注入格式测试要断言这一点（见 `route-facts.test.ts`）。

## 5. 每阶段（每个 commit）收尾清单

> 教训 MEMORY E1：把每个 commit 当一次收尾，别攒到"阶段结束"。

- [ ] `pnpm run gate` 绿（0 警告）
- [ ] **文档四件套自问**——任一不反映此刻现实就补进**同一个 commit**：
  - `CHANGELOG.md`：这个 commit 改了什么（使用者视角）
  - `ROADMAP.md`：状态/下一步是否仍准确；已完成项当场划掉写指针
  - `MEMORY.md`：新教训（现象→根因→规则）+ §0 状态列
  - `SPEC.md`：新系统事实（§10.x 追加）
- [ ] 真机行为有变 → 已跑真机校准局并留存日志（日志是证据，不删）
- [ ] 无 TODO 假代码 / 死代码 / console.log 残留 / 临时脚本进根目录（→ `.scratch/`）

## 6. 文档正交性速查

| 想写的东西 | 去哪 | 出处 |
|---|---|---|
| 怎么跑/目录结构 | 本文 | — |
| 应当怎么做（准则） | `AGENTS.md` | §2/§5/§8 |
| 系统是什么/实测事实 | `SPEC.md` | §10.x |
| 这版改了什么 | `CHANGELOG.md` | [Unreleased] |
| 还没做什么 | `ROADMAP.md` | 待办区 |
| 为什么错了（复盘） | `MEMORY.md` | A–F 节 |
| 当前方向与阶段状态 | `MEMORY.md` §0 | 活记忆 |
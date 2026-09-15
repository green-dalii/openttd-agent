# REFACTOR-PLAN — 收敛方向与分阶段实施（2026-09-12）

> **唯一职责**：本项目从"走一步看一步"转向收敛的重构计划：阶段划分、每阶段
> 验收标准、不漂移机制。状态更新写 ROADMAP，事实写 SPEC，教训写 MEMORY。
> **背景**：项目所有者三项决策（2026-09-12）——
> ① Dashboard 是交付目标但**后置**（先解决框架可用、好用）；② **先单线路跑通**
> 再扩 NEXT-2；③ **渐进式**重构，每阶段除验证外须**对齐目标 + 方向 + 阶段记录**。

## 0. 第一性诊断（为什么重构这里）

业务命题：*LLM agent 能否从环境信号中学会玩 OpenTTD（可测量的学习曲线）？*
回答它需要：**① 标定过的仪器** ② 有出题空间的任务 ③ 方差控制。其余皆外围。

历史错位：v0.3–v0.6 修产品表面，而仪器核心通道至今是
**31 字符公司名 + 标牌 + 正则解析**（"给显微镜装红木外壳，镜片还是毛玻璃"）。
六轮低级错误的共同根因：**先实现、后逆向、再补契约**——协议没有单一事实源。

## 1. 阶段划分与验收

### Phase A — GS JSON 事件通道（根因修复，P0）

**目标**：harness 面向的所有执行器状态/事件全部为类型化 JSON；公司名/正则解析从
harness 侧退役。

- A1 类型契约：`src/game/gs-events.ts` 定义事件 schema（zod）：
  `phase {job, stage, stageDetail, counters, money}` / `done {job, gameDate}` /
  `route-brief {job, from, to, tiles}` / `err`（已有）。
  **先写失败测试**（golden 样张来自真机抓包，不发明格式）。
- A2 GS 侧中继：bridge-gs 读 executor 公司名/标牌 → 解析**一次**（Squirrel，带
  helper 单测）→ `GSAdmin.Send` 发 JSON 事件。心跳改为**变化才发**（事件化后
  心跳概念退役）。
- A3 harness 侧接线：executor-status.ts 的正则解码改为事件消费；
  `phaseStage`/`isErrorPhase`/`jobFromPhase` 全部退役或降为内部兼容层。
- A4 真机验证：cal 系列 ≥2 局，事件流完整、loop-health 保持 HEALTHY。

**验收**：`grep -c 'startsWith\|\.match(' src/agent/runner.ts` 归零（或仅剩注释）；
gate 全绿；两局真机事件流断言通过；SPEC §10.44 记录。

**先验证后定**（不阻塞，探针定夺）：标牌文本长度上限 ≥ 100 字符 → executor→GS
改走标牌；否则保持公司名一跳，约束封死在 GS 解析器内。

### Phase B — runner.ts 拆分（P0，行为不变）

1,055 行 → 四个模块，纯搬运 + gate 锁定，**不改任何行为**：

| 新模块 | 职责 | 从 runner 迁出 |
|---|---|---|
| `agent/game-session.ts` | 进程生命周期、data-dir、清理、启动门禁 | 进程/初始化段 |
| `agent/signal-hub.ts` | GS 事件消费、观察构建、账本 | GS 消息处理段 |
| `agent/decision-loop.ts` | 决策触发（stage gate）、scheduler、审计 | 循环段 |
| `agent/reflect-run.ts` | 局终结算、reflection、metrics 上报 | 收尾段 |

**验收**：runner.ts ≤ 250 行装配代码；gate 全绿（测试零改动——这是"行为不变"
的证明）；每模块文件头写职责/禁止（§2 铁律 6）。

### Phase C — 记忆与实验脚手架（P1）

1. **结构化记忆**：账本的路线事实（pair→格数/造价/结局）**不经 LLM** 直接入库
   （`evolution/route-facts.jsonl`）；LLM 反思只写判断类 lesson。
2. **失败局教训降权**：0 下单局不产出 lesson（无可学习策略）。
3. **实验代码化**：`scripts/run-experiment.ts` — arms/seeds/n 进参数，自动跑矩阵、
   出账本、m3-verdict、**token/决策归一守卫**（§10.43 教训）。
4. **单线路标定跑**：≥3 局，loop-health HEALTHY + 下单率记录 → 然后才谈 NEXT-2。

**验收**：一条命令完成 A/B 全流程；trt 注入内容包含结构化路线事实；下单率方差
有数字记录。

### Phase D — 卫生（P2，穿插做）

- 删 `src/game/v02-runner.ts`（310 行死代码）
- 75 处静默 catch 分诊：该记日志的记，该抛的抛
- Dashboard **冻结**（只修 bug 不加功能），待 ①–③ 完成后评估前端框架引入

## 2. 不漂移机制（每阶段收尾必做）

1. **验证**：gate 全绿 + 该阶段真机断言（见各阶段验收）。
2. **对齐**：阶段报告必须含三行——「对照 Phase 目标：完成了什么 / 偏离了什么 /
   下阶段方向是否仍成立」。
3. **记录**：SPEC（事实）/ CHANGELOG（改动）/ ROADMAP（状态与待办）/ MEMORY
   （教训）一次性更新（§7 DoD）。
4. **回看**：每阶段结束重读本文件 §0 诊断——若接下来的工作不在杀死根因或
   出题给记忆，停下来问项目所有者。

## 3. 明确不做（本计划范围内）

- 不换前端框架（Dashboard 后置，仅冻结）
- 不扩任务纵深（NEXT-2 等 Phase C 标定跑之后）
- 不重写 Admin Port 二进制协议（已验证，是对的）
- 不动 executor 的游戏内施工逻辑（标牌邮箱协议保留——那是游戏内通信，
  约束不同；本计划只改 harness 面向的通道）

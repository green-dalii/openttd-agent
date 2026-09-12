# ROADMAP — OpenTTD LLM Agent Framework

> **本文件只收录「未完成的进度与计划」**：里程碑状态、下一步做什么、验收标准。
>
> **不收录**（按 `AGENTS.md` §9 的文档职责表，冲突以该表为准）：
> - 各版本**已经做了什么** → `CHANGELOG.md`（唯一权威）
> - 开发准则 / 铁律 / 提交卫生 → `AGENTS.md`
> - 系统事实与协议细节 → `SPEC.md`、`docs/`
> - 踩过的坑与教训 → `MEMORY.md`
>
> 曾经这里堆过 139 行「已完成版本的实现细节与验收勾选」，与 CHANGELOG 重复。
> 已删除并改为指针 —— 判定方法：**改一个事实需要动几个文件？> 1 就是有重复。**

---

## 里程碑（SPEC §9）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** 环境钉死 | 二进制 / 隔离 data dir / admin auth | ✅ |
| **M1** 观测闭环 | 规范事件 + Web 仪表盘 | ✅ |
| **M2** 最小决策闭环 | bridge GS + executor + Pi Agent 决策 | ✅ |
| **M3** 进化闭环 | 局终结算 + 反思 + lessons + 注入下局 + 对比图 | 🔵 **实现已完成，验收待跑**（见下） |
| **M4** 打磨 | 策略库 / replay / 自愈 / 多模型基线 | ⬜ |

---

## 进度速览

> 每个版本**一行**。细节一律去 `CHANGELOG.md`。

| 版本 | 一句话 | 细节 |
|---|---|---|
| v0.0.1 | 脚手架 + Admin Port 最小闭环 | `CHANGELOG.md` |
| v0.1.0 | 观测闭环（规范化事件 + 仪表盘） | 同上 |
| v0.2.0 | 通信 + Executor「手」（标牌邮箱） | 同上 |
| v0.2.1 | Pi Agent「脑」接线 | 同上 |
| v0.3.0 | Dashboard 三页化 + provider 目录 | 同上 |
| v0.4.0 | Dashboard UX 重构（信息层级 / 图表） | 同上 |
| v0.5.0 | 启动门禁 + Session 生命周期 | 同上 |
| v0.6.0 | 决策循环对齐 SPEC + 运行控制 + 阶段画面 | 同上 |
| v0.6.x | 记忆闭环（P1–P6）+ 前端三页迁 Alpine + Evolution 页 | 同上 |

**当前门禁**：`pnpm run gate` 全绿（脚本定义见 `package.json`；具体数字以本地执行为准，
**不在此处固化**——它会随每次提交变化，写死必然过期）。

---

## 待办

### 0. RL Harness 范围审核（已完成 2026-09-12）

结果见 `docs/RL-HARNESS-SCOPE-AUDIT.md`：7 条注入通道全部逐条判定。
2 处违反已修（`DO:`/`AVOID:` 祈使句注入、有库就自动注入）。
**1 处待你决定**：跨局记忆系统本身是否该存在（建议保留能力、默认关闭；已如此）。
另修 3 个「门禁看得到、runner 收不到」的转发缺陷（含 `--agent --offline-demo` 一直没生效）。

### 1. M3 验收：跑出对照曲线（**唯一阻塞 M3 的事**）

实现已完成（见 `CHANGELOG.md` v0.6.x；设计见 `docs/EVOLUTION.md`），
但**还没有真实数据**。验收（SPEC §9）：**同 seed 带 / 不带 lessons 各 3 局，出对比曲线**。

- [ ] 用真实 LLM key 跑 6 局（同 seed，3 局注入 lessons、3 局不注入）
- [ ] `/evolution` 页 `verdictOk()` 变真、两臂卡片有数
- [ ] 把结果固化：若结论成立则记入 `SPEC.md`；若不成立也照实记

**注意**：注入默认**关闭**（SPEC §5.3 人工确认闸门）。要先在 `/evolution` 页确认策略卡片，
或在库中放入 lessons，否则 6 局都会落在「无记忆」臂。

### ✅ 2. Token usage 图表 → **堆叠面积图**（已完成 2026-09-12）

- 已改为**堆叠面积图**（你的要求），实现与验证见 `CHANGELOG.md`
- 关键：倒序绘制（大者先画）+ 不透明填充到轴，小面积覆盖其下半部分
- 实测：纵向连续三段 `Reasoning → Output → Input`，无缝、无混色
- **`docs/DASHBOARD-UI.md` §6c 需要同步更新**（它记录的结论仍是"堆叠柱"）

### 3. M4 打磨（未开工，SPEC §9）

- [ ] 铁路 / 货运 tool 扩展
- [ ] replay（结构化事件时间线回放，D10）
- [ ] 自愈（崩溃重启 / 续档）
- [ ] 对照模型基线（多 provider）
- [ ] 前端：各页面的空态 / 错误态一致性审计

### 3b. 执行器架构改造：GS-only（调研完成，待实施）

**根因（不是"没写完"，是选错架构）**：`SPEC.md` §10 选了 Executor AI + 标牌邮箱，
起因是"AI 不能直接收 admin 消息"。这条约束派生出三个**结构性**残疾：
标牌中继命令、31 字符公司名回报、一次性状态机。

**关键发现**：那条约束**根本不必要**。OpenTTD 源码证实
（`script_companymode.hpp` / `script_road.hpp` / `script_vehicle.hpp`，均 `@api ai game`）：
GS 在 company mode 下可以施工，且文档原文是
*"this is like the real player is executing the commands"*。
→ **Executor AI 是一个可以删掉的组件。**
`SPEC.md` L355 早已预警此事（"架构可简化为 GS-only"），但那个 spike 从未做。

**已完成**：调研 + 证据 + 四阶段实施计划 → `docs/EXECUTOR-ARCHITECTURE.md`
**已完成的实测**：`probe_cm` 探针已写出并跑过一轮，得到一条负面事实
（第二条 admin 连接发不到 GS，见 SPEC §10.24）；该探针改动因改动过程出错已回退。

- [ ] 阶段一：GS 启动时自触发探针，真机证实 company mode 可施工
- [ ] 阶段二：执行器逻辑移入 GS，结构化上报
- [ ] 阶段三：删除 Executor AI + 标牌邮箱
- [ ] 阶段四：扩动作面（真人在用的操作类别，见文档 §3）

### 4. Harness 给 agent 的信息是否足够（**本次审计的核心问题**）

你的问题："是不是 Harness 给 agent 传递游戏环境和参数不足？为什么持续亏钱、
看不到智能反馈、也不新增车辆赚钱？"

审计结论（分三层，**不要混为一谈**）：

1. **agent 确实看到了亏损** —— `sinceLastDecision` 里有 `moneyDelta` / `incomeDelta` /
   `vehiclesDelta` / `phases` / `actions` / `notableEvents`（`src/agent/decision-context.ts`）。
   它不是在盲跑。
2. **但它的动作面无法解决真正的问题**。可用工具只有
   `observe` / `build_bus_route` / `add_vehicles` / `set_pause`。
   而当前亏钱的**根因是执行器卡在 `road` 阶段**（见第 3 项）—— 这 4 个工具没有一个能改变它。
   所以"看不到智能反馈"不是模型不聪明，是**它做什么都不起作用**。
3. **执行器的阶段字符串对 agent 是不透明的**。`EX rd s0 r0 j100` / `EX hb road #11`
   在 Squirrel 里有明确语法（`rd`=修路、`s0`=第 0 段、`r0`=重试 0），
   但 agent 只拿到原始字符串。**这是 Harness 该补的"事实"**（属于接口词汇表，
   不是策略）：不解释它，agent 看到的就只是噪声。

- [ ] 把执行器阶段字符串的**语法**作为事实提供给 agent（不是"看到 rd 就该等"这种建议）
- [ ] 评估动作面是否足以让 agent 影响盈亏（当前不足；这是 M2「手」的能力问题，
      不是 agent 的智力问题）

### 4b. 执行器启动期的**不稳定**（新发现，2026-09-12）

同一命令（`--agent --offline-demo --seed 7`）三次运行，执行器行为不一致：

| 运行 | 结果 |
|---|---|
| ex1 | 停在 `EX boot j-1`，方案已下发（GS ack 3 个标牌），执行器**没接** |
| ex3 | 同上 |
| ex2 | 正常推进 `work → stA_ok → stB_ok → road_start`（ack 后 4 秒内） |

GS 侧坐标每次一致（`tileA 34878 / depot 38478`），所以不是 GS 的随机性。
**未定位根因**：怀疑是 `AISignList()` 的可见性与启动竞态，但**尚未证实**。
在此之前，任何"执行器已经好了"的结论都不能成立。

- [ ] 定位 `boot` 不推进的原因（加一条执行器自检上报：扫到几个标牌、名字前缀是什么）

### 5. 执行器卡在 `road` 阶段（**新的未解决项**，2026-09-12 排查发现）

用户在 e2e 中观察到：两个站点已建成（`stations: 2`），但执行器长期停在**修路**阶段
（心跳 `hb road #11`、阶段 `rd s0 r0`），从未进入 `bus` 阶段去买第一台车。
后果是车队恒为 0，而 `add_vehicles` 在 0 车时不可能生效（见 `SPEC.md` §10.20）。

- [ ] 复现：跑一局，观察阶段是否稳定停在 `road`
- [ ] 定位 `PhaseRoad()` 无法推进的原因（贪心分段 + 探针回退逻辑；
      可能是地形/资金导致每段都失败，但**没有可观测的失败原因**——目前只有 `road_stuck`）
- [ ] 让失败可诊断：把 `LayPath`/`FindSegment` 的失败原因（地形、资金、已有建筑）
      带进阶段字符串，否则只能靠猜

**为什么值得优先**：这是"手"是否真的能施工的核心问题；没有它，agent 再聪明也无法
让公司赚钱（M2/M3 的盈利能力都依赖它）。

### 6. 已知未收口项（非阻塞）

- **文档守卫**：`test/unit/alpine-templates.test.ts` 只查结构，未查「页面引用了不存在的元素 id」。
  同类静默失败已出现 3 次（`MEMORY.md` B7），值得再加一条静态检查。
- **预提交孤儿符号报告**：25 个中 24 个是误报（`window.UI` 导出等），但**每次提交都刷屏**，
  应该把误报规则写进配置，否则真孤儿会被噪声淹没。
- **Tom Select 重启**：阶段 3 因浏览器端不工作而回退（见 `CHANGELOG.md`），
  重启前应按 `docs/FRONTEND-DEPENDENCIES-AUDIT.md` 第 3 步先与 Choices.js / Slim Select 实测对比。

---

## 开发纪律

见 `AGENTS.md`（**唯一权威**）。本节只放指针，不重述内容。

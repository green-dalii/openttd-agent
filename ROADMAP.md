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
| **M2** 最小决策闭环 | bridge GS + executor + Pi Agent 决策 | ✅ **真机验收通过**（2 站 / 3 车 / 63 段路，SPEC §10.29） |
| **M3** 进化闭环 | 局终结算 + 反思 + lessons + 注入下局 + 对比图 | 🔵 **引擎完成；第一次 A/B 无效**（agent 当时无决策可做，§10.31/§10.32）。决策空间已交还（§10.33），**待用新空间重跑 → NEXT-1** |
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
| v0.6.x+ | 决策账本 + 类型化 GS 事件通道（Phase A）+ runner 五模块拆分（Phase B） | CHANGELOG [Unreleased] / SPEC §10.39–§10.49 |

**当前门禁**：`pnpm run gate` 全绿（脚本定义见 `package.json`；具体数字以本地执行为准，
**不在此处固化**——它会随每次提交变化，写死必然过期）。

---

## 待办

> **方向与阶段状态的活记忆**：`MEMORY.md` §0（2026-09-12 三项决策：
> Dashboard 后置、先单线路跑通、渐进式重构+每阶段对齐）。
> **每阶段收尾**：CHANGELOG / ROADMAP / MEMORY / SPEC 一次性同步（AGENTS §7 DoD）。

> **接手须知（2026-09-17 更新）**
> - 门禁：`pnpm run gate` 必须全绿（**局数不写死**——写死必然过期）。
> - **开工前必读**：`MEMORY.md` §0（方向）+ §0b（NEXT-2 方案/状态）+
>   `SPEC.md` §10.53–§10.61（本轮全部实测结论）。
> - **真机实验期间不要跑 gate**（preflight 断言端口空闲 → 假红；MEMORY D5）。
> - **remote**：`origin` = `git@github.com:green-dalii/openttd-agent.git`（**private**，
>   2026-09-17 创建）。amend 仅对未 push 的提交安全；已 push 的改动用
>   `--force-with-lease`，不要裸 `--force`。
> - **subagent 不可用**（缺 `@earendil-works/pi-server`）——所有活都内联做。

### ✅ 已收口（2026-09-12～15，细节见 CHANGELOG [Unreleased] 与 SPEC §10.34–§10.49）

- ~~NEXT-1 M3 重跑~~ → **已完成**（§10.42，首次有效对照：记忆无收益、下单率是主方差源）
- ~~NEXT-1b/1c 心跳与新闻门~~ → **已完成并超越**（Phase A：类型化事件通道，心跳概念退役）
- ~~NEXT-2b 信号架构~~ → **Phase A–B 落地**（GS JSON 事件 + runner 五模块拆分）
- 决策→结果账本 → **已接入反思**（§10.41，cal8 反思写出关于选择的 lesson）
- FIFO 队列 + 契约文本 + err 通道 → **已真机验证**（cal6/cal7 双线路闭环）

### ✅ Phase C 收官（2026-09-15，SPEC §10.50）——C-1/C-2/C-3 代码全绿 + calC 标定 HEALTHY；下单率 2/3

> 依据：§10.43 审计——记忆无收益的三层原因（lesson 无含金量 / 任务太浅 /
> 失败局噪声）。C-1/C-2 直接治第一层与第三层。

- **C-1 结构化记忆**：路线事实（pair→tiles/cost/outcome）由账本**确定性直入**
  `evolution/route-facts.jsonl`，不经 LLM 散文化；注入时与 lessons 并列。
- **C-2 失败局教训降权**：0 下单局不产出 lesson（无可学习策略，纯噪声）。
- **C-3 实验脚手架**：实验矩阵脚本（arms/seeds/n 参数化，落地后路径在此登记），
  一条命令跑完矩阵 + m3-verdict + **token/决策归一守卫**（§10.43 归因教训）。
- **C-4 单线路标定 ≥3 局**：用 `scripts/loop-health.ts` 确认 HEALTHY +
  下单率数字记录 → 用 `scripts/m3-verdict.ts` 出判定 → 再用 C-1/C-2 的新
  记忆格式重跑 M3 A/B（NEXT-2 的科学问题）。

标定命令（实测模板，`<N>` 换局号；判定与账本解读见 SPEC §10.40–§10.42）：

```bash
pkill -f "OpenTTD.app/Contents/MacOS/openttd"; sleep 2
rm -rf /tmp/cal<N> && mkdir -p /tmp/cal<N> \
  && cp <provider-dir>/credentials.json <provider-dir>/llm.json /tmp/cal<N>/   # 凭证目录自定
OPENTTD_DATA_DIR=/tmp/cal<N> pnpm run cli --agent --seed 7 --no-memory --demo-seconds 200 \
  > /tmp/cal<N>.log 2>&1
grep -E "RESULT:" /tmp/cal<N>.log
```

### ✅ M3 A/B 已获得可判读结论（2026-09-15/16，SPEC §10.51–§10.52）——记忆在此任务上显著更贵、效果不可辨

- 三轮（m3g/m3h/m3i）合读：**tok/决策 +26%/+41%/+41% 方向一致**——注入记忆使
  每次决策贵 26–41%（唯一稳定信号）；**建成率随窗口与路线长度波动**，treatment
  分别更高/更低/更低；站点数（分级）两臂几乎相同（5.60 vs 5.20）。
- 结论：任务太浅，记忆没有出题空间，成本却每次决策都付。**不再在单线路任务上重跑 A/B。**
- **下一步 = NEXT-2（扩决策空间）**：多线路/收益递增/重复博弈，给记忆赚回成本的
  机会——这是三轮数据推导出的优先级，不是拍脑袋。

### 🟡 NEXT-2 收尾 A/B 已跑（2026-09-17，SPEC §10.62）——方向有利但 n=5 不可判定

- 数据：delivered 均值 23.2 vs 11.2（favor 记忆），**中位 0 vs 15（favor 对照）**，
  零率 60% vs 40%，tok/决策仅 **+7%**；`delivered delta +12`。
- **不可判定**：delivered 是零膨胀重尾量，一局 77 撑起总和 → 均值与中位数符号相反。
- **下一步（唯一有意义的）**：**加大样本**（重尾量的 n 需求远大于 5）+
  **报告中位/零率/自助法**而非均值；判据守卫按量定制（已实现 `deliveredConclusive`）。

### ~~🔴 原计划：NEXT-2 收尾——memory A/B，判据用 delivered（2026-09-17）~~

**为什么是这一步**：三轮 M3（§10.52）判"记忆在此任务上无收益"，但当时的判据
（money/income/建成率）**全部被施工花费与窗口截断污染**。本轮已把判据换成干净的量：

- `deliveredCargo`（N2-4b，§10.57）：不受施工花费与贷款影响，`0` 与"缺读数"区分；
- **oracle 基线**（§10.58）：程序确定策略 delivered = **20 / 31** → **任务有梯度**；
- 决策空间已被行使（§10.55）：decisions/game **8.0**、模型**首次用 `add_vehicles`**。

**因此现在可以问一个有意义的问题**：注入记忆（含线路经济事实，§10.53–§10.54）
能否提高 delivered？

```bash
# 两臂各 5 局，500s，seed 7；treatment 注入记忆（默认），control 加 --no-memory
rm -rf /tmp/n2ab3 && mkdir -p /tmp/n2ab3 \
  && cp <provider-dir>/credentials.json <provider-dir>/llm.json /tmp/n2ab3/
pnpm exec tsx scripts/run-experiment.ts --dir /tmp/n2ab3 --n 5 --demo-seconds 500 --seed 7
# 判据：delivered delta（主）+ built-rate 守卫；money/income 只看不判
```

**验收**：`delivered delta` 与守卫结论（`conclusive`）如实记录进 SPEC；无论正负
**都必须报告**——这一轮的价值在于判据终于可信。

**前置已满足**：`--vary memory`（默认）· `arm` 分配时记录（§10.56）· 冻结默认关（§10.61）。

### ✅ 冻结问题已判定：默认不冻结（2026-09-17，SPEC §10.59–§10.61）

- **旧结论被推翻**（§10.59）：`pause`/`unpause` 双向有效（实测 `getdate` 冻结→恢复），
  "暂停单向"的真因是 `pause_on_join=true` 且无客户端。
- **可选冻结已实现并验证**（§10.60）：`--freeze`，暂停/恢复都要回执确认 +
  `finally` 恢复 + 120s 看门狗；真机 5/5 局有 3–8 次确认暂停、0 恢复失败。
- **A/B 判定**（§10.61）：frozen delivered **0/5** vs unfrozen **2/5（15、13）**，
  建成率 0.20 vs 0.60，且冻结局**少走约 10% 游戏天数**——暂停时脚本 tick 停，
  施工在模型思考期间无法推进，而施工墙钟正是本任务瓶颈。
  → **默认不冻结**；若重测决策质量，必须按**游戏时间**对齐 + `delivered/游戏天数` 归一化。

### 🟠 之后（原序号保留，前置条件未变）

- **NEXT-2 扩决策空间** → **已在做，见上「当前」**（多线路/收益递增/重复博弈；
  线路经济信号与组合管理动作已落地）。
- **NEXT-3 地图大小旋钮 / NEXT-4 GS-only 架构 / NEXT-5 M4 打磨**：次序不变。
- **NEXT-6 已知未收口项（合并两份清单，非阻塞）**：
  - ~~pause 探针~~ → **2026-09-17 实测完成**（§10.59：双向有效，原因见上节）
  - process-manager flaky 测试（spawn 时序 812ms 窗口）
  - GS 事件 detail 字段（§10.45 妥协，Squirrel 表赋值怪癖）
  - v02-runner 删除（**380 行**，2026-09-17 实测；Phase D 卫生项）
  - alpine-templates 静态守卫升级（页面引用不存在的元素 id，B7 同类）
  - 预提交孤儿符号误报规则写进配置（25 个/次刷屏淹没真孤儿）
  - Tom Select 重启前按 FRONTEND-DEPENDENCIES-AUDIT 第 3 步实测对比

### 📌 已完成但值得知道的事（细节在 SPEC，不在这里复述）

| 事 | 一句话 | 位置 |
|---|---|---|
| 执行器跑通完整公交线 | 2 站 / 3 车 / 63 段路，车在跑 | SPEC §10.29 |
| ~~控制台 `pause` 是单向的~~ | **2026-09-17 实测推翻**（双向有效；真因是 `pause_on_join=true`）| SPEC §10.28 更正在 §10.59 |
| 心跳从来没响过 | 判据用了脚本 tick，执行器一直没有存活信号 | SPEC §10.27 |
| `--demo-seconds` 从来没用 | 决策循环无截止检查 | SPEC §10.30 |
| `compareArms` 曾会把 bug 算成结论 | 未排除 `interrupted` 局 | 见 `CHANGELOG` |
| 决策权交还 agent | 城镇可选，实测 `from=9,to=1` | SPEC §10.33 |
| 执行器解码器 | 含车辆遥测族 `R/S/D/@/B/X` | SPEC §10.29 |

---

## 开发纪律

见 `AGENTS.md`（**唯一权威**）。本节只放指针，不重述内容。

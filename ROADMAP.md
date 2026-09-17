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

> **接手须知（2026-09-15 更新）**
> - `pnpm run gate` 全绿（842 passed / 9 skipped）。
> - **开工前必读**：`MEMORY.md` §0（方向）+ `SPEC.md` §10.34–§10.49（最近结论）。
> - **无 remote**：所有提交都是本地的，不要 push。
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
  && cp /tmp/openttd-agent-data/credentials.json /tmp/openttd-agent-data/llm.json /tmp/cal<N>/
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

### 🟡 待决策：决策期间是否冻结世界（2026-09-17，证据 SPEC §10.59）

原设计（SPEC §1.1 step 2）决策前 `pause`、决策后 `unpause`，2026-09-12 因"暂停不可
恢复"废除，改为"快照 + 增量汇报"。**2026-09-17 实测推翻该归因**：`pause` → `getdate`
冻结；`unpause` → 日期恢复推进（真因更可能是 `pause_on_join=true` 且无客户端）。

| 方案 | 好处 | 代价 |
|---|---|---|
| 现状：不暂停 | 墙钟不浪费；世界变化被如实汇报 | 动作落在模型没见过的状态上（实录：`inspect_route` 报 0 辆车时上下文已是 6 辆）|
| 冻结：pause→决策→unpause（rconAwait 确认 + 看门狗重试）| 动作落在模型真正见过的世界上 | 思考期间游戏不推进；`--demo-seconds` 与游戏天数脱钩 |

**下一步（待所有者确认）**：以"已验证的冻结"做同 seed A/B（freeze vs no-freeze），
判据用 delivered。

### 🟠 之后（原序号保留，前置条件未变）

- **NEXT-2 扩决策空间**：A/B 后开（多线路收益递增/重复博弈——给记忆和
  策略出真题）。
- **NEXT-3 地图大小旋钮 / NEXT-4 GS-only 架构 / NEXT-5 M4 打磨**：次序不变。
- **NEXT-6 已知未收口项（合并两份清单，非阻塞）**：
  - ~~pause 探针~~ → **2026-09-17 实测完成**（§10.59：双向有效，原因见上节）
  - process-manager flaky 测试（spawn 时序 812ms 窗口）
  - GS 事件 detail 字段（§10.45 妥协，Squirrel 表赋值怪癖）
  - v02-runner 删除（310 行死代码，Phase D）
  - alpine-templates 静态守卫升级（页面引用不存在的元素 id，B7 同类）
  - 预提交孤儿符号误报规则写进配置（25 个/次刷屏淹没真孤儿）
  - Tom Select 重启前按 FRONTEND-DEPENDENCIES-AUDIT 第 3 步实测对比

### 📌 已完成但值得知道的事（细节在 SPEC，不在这里复述）

| 事 | 一句话 | 位置 |
|---|---|---|
| 执行器跑通完整公交线 | 2 站 / 3 车 / 63 段路，车在跑 | SPEC §10.29 |
| 控制台 `pause` 是单向的 | **"执行器假死"的最终根因** | SPEC §10.28 |
| 心跳从来没响过 | 判据用了脚本 tick，执行器一直没有存活信号 | SPEC §10.27 |
| `--demo-seconds` 从来没用 | 决策循环无截止检查 | SPEC §10.30 |
| `compareArms` 曾会把 bug 算成结论 | 未排除 `interrupted` 局 | 见 `CHANGELOG` |
| 决策权交还 agent | 城镇可选，实测 `from=9,to=1` | SPEC §10.33 |
| 执行器解码器 | 含车辆遥测族 `R/S/D/@/B/X` | SPEC §10.29 |

---

## 开发纪律

见 `AGENTS.md`（**唯一权威**）。本节只放指针，不重述内容。

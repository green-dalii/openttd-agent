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

**当前门禁**：`pnpm run gate` 全绿（脚本定义见 `package.json`；具体数字以本地执行为准，
**不在此处固化**——它会随每次提交变化，写死必然过期）。

---

## 待办

> **接手须知（2026-09-12 收尾状态）**
> - `git` 干净，`pnpm run gate` 全绿（780 passed / 9 skipped）。
> - **开工前必读**：`SPEC.md` §10.20–§10.33（这几节是最近一轮的全部结论），
>   以及 `docs/EXECUTOR-ARCHITECTURE.md`。
> - **无 remote**：所有提交都是本地的，不要 push。
> - **subagent 不可用**（缺 `@earendil-works/pi-server`，已核实 5+ 次）——所有活都内联做。

---

### 🔴 NEXT-1：用新的决策空间重跑 M3（**当前唯一有科学意义的一步**）

**为什么**：`SPEC.md` §10.31 的第一次 A/B **无效** —— 两臂无差异，
根因不是地图太小，而是 **agent 当时没有决策可做**（看不到城镇、
工具描述还叫它别选）。§10.33 已把决策权交还（实测 agent 开始传 `from=9,to=1`）。
**决策空间变了，实验必须重跑。**

**怎么做**（照抄即可）：

```bash
# 真实 key 已在 /tmp/openttd-agent-data/{credentials,llm}.json（provider=minimax-cn, model=MiniMax-M3）
rm -rf /tmp/m3b && mkdir -p /tmp/m3b
cp /tmp/openttd-agent-data/credentials.json /tmp/openttd-agent-data/llm.json /tmp/m3b/

# 对照臂 3 局（--no-memory；反思仍会写 lessons 进库）
for i in 1 2 3; do
  pkill -f "OpenTTD.app/Contents/MacOS/openttd"; sleep 3
  OPENTTD_DATA_DIR=/tmp/m3b pnpm run cli --agent --seed 7 --no-memory --demo-seconds 200 > /tmp/m3b-a$i.log 2>&1
done
# 处理臂 3 局（默认注入）
for i in 1 2 3; do
  pkill -f "OpenTTD.app/Contents/MacOS/openttd"; sleep 3
  OPENTTD_DATA_DIR=/tmp/m3b pnpm run cli --agent --seed 7 --demo-seconds 200 > /tmp/m3b-b$i.log 2>&1
done

# 读结论（规则全在服务端 metrics.ts，不在浏览器里重算）
pnpm exec tsx scripts/m3-verdict.ts /tmp/m3b
```

> 收尾时实测：`pnpm exec tsx -e '...'` **不工作**（eval 模式解析不了带 `.js` 的 ESM import）。
> 所以结论读取落成了 `scripts/m3-verdict.ts`。

**验收**：`arms.conclusive === true`，并把结果固化进 `SPEC.md`（**真假结论都要记**）。

**⚠️ 先确认一件事**：`--demo-seconds 200` 是否足够建成？
第一次 A/B 用 200 秒时 6/6 全部 `constructionDone=true`。
若新局普遍 `false`，说明局长不够，调大再跑（否则指标又被截断）。

**⚠️ 仍然可能饱和**：即使 agent 现在会选城镇，**它仍然只能下"建一条线"这一个决定**。
若这次两臂还是无差异，**不要再加局数** —— 那是决策空间仍然太窄的信号，
应转去做 NEXT-2。

---

### 🔴 NEXT-2：继续扩决策空间（若 NEXT-1 无信号）

NEXT-1 只补了"选哪个城镇对"。要让 lessons 真正有作用点，还需要**选择有后果**：

- [ ] **车队规模由 agent 定**：`add_vehicles` 目前只能克隆头车，且 0 车时拒绝（§10.20）。
      改成"买 N 台"或"克隆到 N 台"，让 agent 权衡运力与维护成本。
- [ ] **多条线路**：目前 `_stage = "done"` 后执行器永久 idle（**一次性状态机**）。
      要让 agent 能下第二条线的指令 —— 这需要先做 NEXT-4（GS 常驻）。
- [ ] **预算约束**：agent 面对有限资金时才有取舍。
- [ ] **`observe()` 补上地形/距离/成本估计** —— 有选项才谈得上"选得好不好"。

**判定标准**：一个改动只有让"不同选择导致**不同且可学习**的结果"时才值得做。

---

### 🟠 NEXT-3：地图大小作为难度旋钮（等决策空间够宽之后再开）

`OPENTTD_MAP_SIZE=small|medium|large`（256²/512²/1024²）。

**已实测的事实**（`SPEC.md` §10.32）：large（1024²）下同一 seed 仍然挑 **同一个 tile 62,136**，
站数仍是 2，但 **280 秒建不完**（`constructionDone=false`）。

→ 地图变大改变的是 **harness 的施工难度**，不是 **agent 的自由度**。
在决策空间够宽之前，它只会让实验更慢、更可能截断。

---

### 🟠 NEXT-4：GS-only 架构改造（调研完成，实施待做）

**根因**：`SPEC.md` §10 选了 Executor AI + 标牌邮箱，起因是"AI 不能直接收 admin 消息"。
这条约束派生出三个**结构性**残疾：标牌中继命令、**31 字符公司名回报**、
**一次性状态机**（一局只能建一条线）。

**关键发现**：那条约束**根本不必要**。OpenTTD 源码证实
（`script_companymode.hpp` / `script_road.hpp` / `script_vehicle.hpp` 均 `@api ai game`）：
GS 在 company mode 下能施工，文档原文是 *"this is like the real player is executing
the commands"*。→ **Executor AI 是可以删掉的组件。**
完整证据与四阶段计划见 `docs/EXECUTOR-ARCHITECTURE.md`。

- [x] **阶段一：已通过** —— 真机证实 GS 可对公司施工并**扣公司的钱**
      （`money 298825 → 298518`）。见 SPEC §10.25
- [ ] **阶段 1b：买车/订单/启动** —— `probe_cm` 探针代码已写（含 depot/engine/buy/order/start），
      但**从未成功触发过**。当时的拦路石（游戏被暂停）已修（§10.28），**现在值得重试**。
      注意：探针要**在 GS periodic tick 里自触发**（启动时触发会被静默丢弃，见 §10.25.1）
- [ ] 阶段二：执行器逻辑移入 GS，结构化上报（替掉 31 字符公司名）
- [ ] 阶段三：删除 Executor AI + 标牌邮箱
- [ ] 阶段四：扩动作面（真人的操作类别，见架构文档 §3）

**这条线是 NEXT-2 的"多条线路"的前置条件**（GS 常驻才能接新指令）。

---

### 🟡 NEXT-5：M4 打磨（SPEC §9，未开工）

- [ ] 铁路 / 货运 tool 扩展
- [ ] replay（结构化事件时间线回放，D10）
- [ ] 自愈（崩溃重启 / 续档）
- [ ] 对照模型基线（多 provider）
- [ ] 前端：各页面的空态 / 错误态一致性审计

---

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

### 🟡 NEXT-6：已知未收口项（非阻塞）

- **文档守卫**：`test/unit/alpine-templates.test.ts` 只查结构，未查「页面引用了不存在的元素 id」。
  同类静默失败已出现 3 次（`MEMORY.md` B7），值得再加一条静态检查。
- **预提交孤儿符号报告**：25 个中 24 个是误报（`window.UI` 导出等），但**每次提交都刷屏**，
  应该把误报规则写进配置，否则真孤儿会被噪声淹没。
- **Tom Select 重启**：阶段 3 因浏览器端不工作而回退（见 `CHANGELOG.md`），
  重启前应按 `docs/FRONTEND-DEPENDENCIES-AUDIT.md` 第 3 步先与 Choices.js / Slim Select 实测对比。

---

## 开发纪律

见 `AGENTS.md`（**唯一权威**）。本节只放指针，不重述内容。

# RL Harness 范围审核（2026-09-12）

## 0. 审核依据

本文的判定标准**不是**我的偏好，而是项目所有者重申的范围：

> 这是一个让 agent 以强化学习思路操作 OpenTTD 的项目。
> **初始化只给 agent 传递背景知识**（这是什么游戏、怎么操作等等）。
> **任何策略、方法等不能做注入干扰 agent 的行为。**
> 本质是一个 **RL Harness**：只做正确的环境交互操作 + 正确的信息传递反馈。
> 一切智能行为需要 agent 通过环境来学习。

把它拆成可执行的判据（下文逐条对照）：

| 判据 | 含义 |
|---|---|
| **J1 背景知识** | 允许：游戏是什么、怎么操作、世界机制 |
| **J2 无策略注入** | 禁止：告诉 agent「该做什么」 |
| **J3 正确交互** | 工具必须真能改变世界，或明确拒绝 |
| **J4 正确反馈** | 工具对结果的陈述必须与世界一致 |

> 判据的边界（§5.1 已有雏形，此处固化）：**契约前提 ✅ / 世界事实与因果 ✅ / 交互协议 ✅ / 策略 ❌**。
> 一个测试："这句话是在描述世界，还是在替它做决定？"

---

## 1. 注入通道清单（全部）

agent 在**一局之内**能收到的每一条文字，逐条分类：

| # | 通道 | 位置 | 内容 | 判定 |
|---|---|---|---|---|
| 1 | `SYSTEM_PROMPT` | `src/agent/runtime.ts:28` | 世界机制（施工异步、金钱/利息、候车需求）+ 协议 | ✅ J1 |
| 2 | 每轮决策 prompt | `src/agent/loop.ts:106` | 结构化事实 + JSON 接口 | ✅ J1 |
| 3 | 决策上下文 | `src/agent/decision-context.ts:141` | 纯数据（delta/phases/actions/events），**无散文** | ✅ J1 |
| 4 | 工具 description | `src/agent/tools/index.ts` | 契约（这是函数签名） | ✅ J1 |
| 5 | 工具拒绝信息 | 同上 | 契约（为什么做不到） | ✅ J1 |
| 6 | **lessons 注入** | `src/evolution/lessons.ts:199` + `src/agent/context.ts:52` | **`DO:` / `AVOID:` + "Lessons from previous games"** | ❌ **违反 J2** |
| 7 | **strategies 注入** | `src/evolution/strategies.ts:267` | `WORKED: build_bus_route with {...} (avg +N/game)` | ⚠️ 见 §3 |

通道 1–5 在 2026-09-12 已清理并被**机械守卫**覆盖
（`test/unit/agent-runtime.test.ts`：SYSTEM_PROMPT / 每个工具 description /
每个拒绝信息都不得出现策略措辞）。

---

## 2. 违反项（已修）

### 2.1 祈使句注入 —— `DO:` / `AVOID:`

`formatForInjection` 把经验渲染成 **`DO: …` / `AVOID: …`**，再由
`context.ts` 以 **`user` 角色**、**每一次 LLM 调用都前置**注入：

```
Lessons from previous games:
- AVOID: <经验>
- DO: <经验>
```

三重问题：① 内容是**祈使句**（违反 J2）；② 位置是 user 消息**最前面**（最强影响力位）；
③ **每次调用重注入**（无法被历史稀释）。

**修复**：改为对过去的**陈述** ——
`Previously an action like this paid off: …` / `…did not pay off: …`，
标题改为 `Recorded outcomes from your own previous games:`。

### 2.2 自动注入 —— 有库就注入

`loadMemory()` 只要库里**有内容就注入**，没有任何开关。也就是说
"agent 靠环境学习"会悄悄变成"harness 把结论递给 agent"，而且**没有任何一处会告诉你它发生了**。

**修复**：新增 `LoadMemoryOptions.inject`，**默认 `false`**；
`inject !== true` 时**连库都不读**（保证 `lessonsInjected: 0` 是真话，而不是"读了但没注入"）。
显式入口：`--inject-memory`。

> 这不是删除能力：M3 的"带/不带 lessons"对照实验仍可做，但必须**显式要求**。
> 默认行为与项目范围一致。

---

## 3. 待你决定：跨局记忆本身是否该存在

即使措辞改成陈述句（§2.1 已做），**"跨局记忆"这件事本身**仍与
「初始化只给背景知识」有张力：

- 支持保留：它是 **agent 自己**过往局的结果，不是人写的策略；且 SPEC §5.3 已要求人工确认；
  它也是 M3 对照实验的对象。
- 支持移除：它让 agent 在第 N 局开始时，拿到一个**它没有通过本局环境得到的结论**。
  严格意义上的 RL harness 只提供环境；跨局学习应由 agent 自己维护的记忆承担。

**我的建议**：保留能力、默认关闭（即 §2.2 的状态），并把它明确定位成
**受控实验装置**而不是默认功能。是否要连库都不再写入，需要你决定 ——
**我没有单方面删除 6 个 phase 的工作。**

---

## 4. 交互与反馈（J3 / J4）

### 4.1 已修：`add_vehicles` 谎报成功（SPEC §10.20）

`ok: true` 是**硬编码**的，命令写进 socket 就返回；GS 的 ack（`placed:1`）指的是
**标牌被放置**，与"车造出来了"无关。而它当时**根本不可能成功**：执行器
`CheckAddVehicles` 靠 `AIVehicle.CloneVehicle` 克隆头车，0 车时静默 `return`。

**这是 J4 的核心违反**：一个永远说"成功"的工具会摧毁 agent 的学习能力 ——
它会把"什么都没变"归因于**世界**，而不是"这个动作不可能"。

现在：检查 `snapshot()`，`vehicles === 0` 时**拒绝**；执行器发 `SetPhase("fleet_noveh")`。

### 4.2 审查后判定为**合规**：`build_bus_route` 的 `ok: true`

它同样是 fire-and-forget（`ok` 只表示"命令已发出"）。**但**：
SYSTEM_PROMPT 现在明确陈述了契约 ——
*"A tool result reports the outcome of the REQUEST it was given, which is not the
same as the resulting change in the world. observe() reports the world."*

契约被如实告知 + summary 明说 `sent …; construction runs asynchronously`，
因此符合 J4。（`ok` 语义仍偏弱，见 §6。）

---

## 5. 已确认**不需要**修改的部分

审核中特别检查、结论为合规：

- `buildDecisionContext` 返回**纯结构化数据**，无散文、无建议。
- 每轮 prompt 显式声明 `Facts, nothing else is implied by their order`。
- `src/` 全量 grep `you should|recommend|suggest|prefer|only then|^DO:|^AVOID:`
  —— 仅剩注释，无实际文案。
- 记忆计数与注入内容一致（`memoryCounts`），"读了没注入"不会污染 M3 自变量。

---

## 6. 遗留（非阻塞）

- **`ActionResult.ok` 语义偏弱**：一个布尔承载"已投递"与"已改变世界"两种含义。
  当前靠 SYSTEM_PROMPT 的契约段落弥补。更稳的做法是显式区分
  `delivered` / `confirmed`，但那是对外契约变更，需你确认。
- **执行器阶段字符串对 agent 不透明**（`EX rd s0 r0 j100`）。
  按本审核的判据，这属于 **J1 背景知识缺口**（接口词汇表），**应当补**，
  但它不是策略 —— 补齐后 agent 仍要自己决定这些阶段意味着什么。见 ROADMAP 第 1 项。

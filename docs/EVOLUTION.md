# 进化闭环（记忆系统）设计

> **职责**：本文件是**记忆系统的设计与数据契约**（SPEC §5 的实现细节）。
> **禁止**：进度/计划（→ `ROADMAP.md`）；过程教训（→ `MEMORY.md`）；开发准则（→ `AGENTS.md`）。
> 上位事实来源：`SPEC.md` §5（三机制 / 收敛防抖）、§5.1（局生命周期）、§9 M3（验收）。

---

## 1. 为什么需要它（问题陈述）

SPEC §5.1 定义的局生命周期是**闭环**：

```
新局 → 加载 policy(注入 lessons) → 玩到终止 → 结算 metrics
     → 反思(LLM 归因) → 蒸馏(lessons + strategy) → 下一局
```

截至 v0.6.0 只实现了**结算 metrics 这一段**。后果：

- 每一局**完全独立**——上一局踩的坑，下一局照样踩。
- `src/agent/context.ts` 的 `lessonsProvider` 自 v0.2.1 起就是一个**没人喂的空 hook**：
  `runner.ts` 调用 `pruningTransformContext({ keepRecent: 40 })`，从不传 provider。
- 没有跨局证据，就无法回答"这套 prompt/策略到底有没有变好"。

M3 验收（SPEC §9）：**同 seed 带/不带 lessons 各 3 局可出对比曲线**。
因此记忆系统的第一等公民是**可对照**，而不是"看起来在学"。

---

## 2. 数据契约

### 2.1 Lesson（泛化教训）

SPEC §5.2 #1：局终反思 → 短 lessons → 语义检索 → 下局开局注入 system；
**带置信度/来源局，可被后续局覆盖**。

```ts
interface Lesson {
  id: string;              // 稳定 id（规范化文本的 hash），去重/覆盖的键
  text: string;            // 一句话教训（注入给 LLM 的就是它）
  kind: "do" | "dont";     // 做对 / 做错
  confidence: number;      // 0..1，来源局的证据强度
  evidence: string[];      // 支撑它的**游戏事实**（金额/年份/事件），禁止空
  sourceSessionId: string; // 来源局（SPEC: 带来源）
  sourceSeed: number;      // 同 seed 对照实验的分组键
  createdAt: number;
  supersededBy?: string;   // 被后续局覆盖（SPEC: 可被覆盖）
}
```

**`evidence` 非空是硬约束**：SPEC §5.3 明令"反思 prompt 显式禁止臆测因果（只接受游戏事实佐证）"。
没有事实支撑的教训不得进入库——这是防止记忆系统退化成"LLM 自说自话"的第一道闸。

### 2.2 StrategyCard（策略卡片）

SPEC §5.2 #2：把"高收益动作模板"存为卡片（参数化的成功模式）。

```ts
interface StrategyCard {
  id: string;                                    // 由**代码**从 action + 白名单参数派生
  name: string;                                  // 如 "bus_route_medium_town"
  action: string;                                // 必须是工具目录里的写动作
  params: Record<string, number | string>;       // 参数化成功模式（证据，不是身份）
  profitPerDayPerRun?: number[];                 // **每局**一个利润速率（每游戏日）
  evidence: string[];
  sourceSessionIds: string[];
  createdAt: number;
}
```

**身份归代码所有（2026-11-01）**：`id` 只由 `action`（封闭词表，`STRATEGY_ACTIONS`，
必须与 `ACTION_EFFECTS` 的写动作一致）加**白名单参数**（`cargo` / `engine` / `mode`）派生。
旧实现把模型写的自由文本＋全部参数一起哈希，于是同一个想法换个镇号或换种措辞就是新卡，
`已验证局 ≥ 2` 在**结构上不可达**。模型现在只能提供模式与证据，不能决定"这是不是一张新卡"；
它写一个不存在的动作名会被**拒绝**，理由里带完整词表。

**入库门槛（SPEC §5.3 硬性）**：`每游戏日利润 > 阈值` **且** `已验证局 ≥ 2`。
“已验证局数”= **独立局数**，不是读数个数：`profitPerDayPerRun[i]` 与 `sourceSessionIds[i]`
**一一对应**，一局只留一个读数。存数组而不是标量，使门槛可判定而不是靠印象。

> **一局只算一局（2026-11-10 真机发现）**：一局里模型可以记多条同模式采样 ⇒ 旧实现
> 把每条采样都追加进 `profitPerDayPerRun`，而闸把数组长度当成“验证局数”⇒
> **单局三条高值采样就能过闸**。真机（seed 11，502 日）实测正是这样：一张卡的
> `profitPerDayPerRun` 里有 3 个读数而 `sourceSessionIds` 只有 1 个局。
> 现在合并时按局去重、读数与来源局保持同序，闸按**不同局**计数。

**价值口径是利润增量，且由代码盖章**：每局的读数来自这一局自己的记录，**不是模型自报的金额**。理由与 D86 同类：
余额被贷款、初始资金与造价时点主导，拿它当成绩等于让最容易混淆的量决定记忆。
每局长度不同（60 日 vs 300 日），所以单位必须是速率。
旧卡（只有模型自报 `valuePerRun`）**没有**利润读数 ⇒ 不可晋升：那是"没测到"，不是"测到 0"。

> **读数的口径（2026-11-11 P0b 修正落地，`SPEC.md` §10.55 / §10.76）**：
> 卡片上的 `profitPerDay` 现在是 **本局净现金流 ÷ 这一局实际经过的游戏日**。
> - **分子**：净现金流 = `money − loan`。这不是估算：引擎创建公司时 `money = current_loan`
>   ⇒ `money − loan` 自创建起为 0；每笔费用都做 `money -= cost` 与
>   `yearly_expenses += cost`（同一笔），借款让两者同增同减 ⇒ **任何窗口的
>   `Δ(money − loan)` 就是净现金流，跨 1 月 1 日成立**。
> - **分母**：这一局**实际经过**的游戏日（episode 的 `simulatedDays`），不是整年长度，
>   也不是绝对游戏日。模型看到的 `deliveredPerGameDay` 用的是同一个分母 ⇒ 看到的速率
>   与被记下来的速率是同一个数。
> - **跨年**：读数按**日历年**分段（`src/game/profit-meter.ts`）。引擎在 1 月 1 日**先**发
>   admin 年度读数（携带**上一整年**的完整值）、**之后**才清零计数器 ⇒ 那条读数是上一段的
>   终点；每段还会用引擎自报的整年值**对账**，对不上就报差值（缺口），不折零。
> - **阈值单位**：`每游戏日 > 5000/300 ≈ 16.67` 现在明确为**“年收入目标 5000”**（净现金流口径）。
> - **旧两局按修正口径不可重算**（数据目录已删 + 归档曾丢掉全部经济事件）⇒ 修正前的“没有一局
>   达到门槛”不再成立；只能说：修正后的分子含建设年的净支出 ⇒ 速率 ≤ 旧读数 ⇒ 门槛在那两局上
>   **不可达**（精确值不可重算）。
> - **运营利润 vs 净现金流**：净现金流含基建/购车/利息；运营利润（收入 − 运行成本）是引擎的
>   `GSVehicle.GetProfitThisYear()`，同样年边界归零。**公司级的连续台账已落地**
>   （`src/game/operating-profit.ts`，2026-11-13；GS 按需 `company_fleet`）：首条读数只建基线、
>   之后只加增量、卖车冻结在账上、跨年只挪参照点；不完整时明说"是下界"。它与净现金流是
>   **两个量**，不可互换（“这条线赚不赚钱”是运营利润，“这一局花了多少”是净现金流）。
>
> **口径的另一半在 harness 自己的时钟上**（2026-11-11 已修，PR #110）：`gameDayFromRawDate` 用的是**虚构的
> 360 天年**，`route-stats.ts` 的年内天数用 `gameDate % 365` ⇒ **凡是"每游戏日"的读数，分母都
> 不是引擎的日历天**。现在时钟就是引擎的日历（唯一实现：`src/game/calendar.ts`），季度边界用引擎
> 的季度，线路"每日收益"的分母是引擎日历的年内第几天（`SPEC.md` §10.76）。
> 模型看到的 `deliveredPerGameDay` 以前传的是**绝对游戏日**（距 1950-01-01）⇒ 与指标分母不同源，
> 现已统一成“这一局经过的天数”（P0b）。

> **`strategies.jsonl` 是候选池，不只是"已入库"的赢家。**
> 门槛要求两局验证，所以第一局的样本**必须有个地方存**——早期实现只写通过门槛的卡片，
> 结果第一局样本被丢弃、第二局永远只看到自己，门槛**永远不可能通过**（测试抓到的）。
> 因此文件保存合并后的完整候选池，而**可注入性**在 `selectStrategies()` 里由
> **两道独立的闸**共同决定：
> 1. SPEC §5.3 的**证据门槛**（价值+已验证局数）——防过早自信；
> 2. 人类的 **`enabled` 标志**——防未经审核的建议生效。
>
> 两者缺一不可，且理由不同：前者关乎证据质量，后者关乎人类把关。

### 2.3 注入记录（对照实验的自变量）

`GameMetric.memory = { lessonsInjected, strategiesInjected }` 记录**这一局实际注入了多少**。
没有它，"带/不带 lessons"不构成对照（已实现）。

---

## 3. 三道闸（防止记忆系统自己跑偏）

SPEC §5.3 的四条收敛防抖，逐条落到实现：

| SPEC §5.3 | 实现 |
|---|---|
| 每 lessons 限量、去重、带来源/时间戳 | `selectLessons()` 限量；`dedupeLessons()` 按规范化文本去重并保留置信度高/新者；`sourceSessionId` + `createdAt` 是必填字段 |
| 策略入库需「价值>阈值 **且** 已验证局≥2」 | `promoteStrategies()` 双重门槛，任一不满足即拒绝 |
| 反思 prompt 显式禁止臆测因果 | `buildReflectionPrompt()` 内含禁令；**且** `evidence` 为空的 lesson 在解析阶段被丢弃 |
| v0.1 进化引擎**只读建议**，人类在 UI 确认后才全局生效 | lessons 写入 `enabled: false` 的建议区；只有被 UI 确认（或显式 `--auto-lessons`）的才参与注入 |

最后一条容易被当成形式主义，但它决定了"跑飞"时的可恢复性：
一个把错误教训固化进库的系统，比没有记忆的系统更糟。**默认关，人工开。**

---

## 4. 注入路径（为什么用 user 消息而不是 system）

`src/agent/context.ts` 的现有实现把 lessons 作为一条 **user** 消息放在最近窗口之前，
而不是改写 system prompt：

- `transformContext` 的输入是**消息数组**，pi-agent-core 的 system prompt 在更上层装配；
- 作为 user 消息注入，**剪枝与注入的交互是显式的**（测试可断言顺序），
  且不会因为 system 被重建而静默丢失。

注入内容必须**可辨认**（前缀 `Lessons from previous games:`），
否则模型与人都无法区分"这是本局观察"还是"这是跨局建议"。

---

## 5. 反思（LLM 归因）的约束

反思是唯一让 LLM 参与"总结"的环节，风险也最高：它极易产出听起来合理、
但游戏里根本没发生过的因果解释。

因此：

1. **只给事实**：输入是 `GameMetric` + 该局的**结构化证据**（阶段动作与结果、关键事件），
   不是自由文本叙述。
2. **prompt 显式禁令**：禁止"可能/大概/也许是因为"式表述；每条教训必须附游戏事实。
3. **输出 schema 强校验**：`{ lessons: [{text, kind, evidence[]}] }`，
   `evidence` 为空的条目**整条丢弃**（不是降级，是丢弃）。
4. **纯函数边界**：prompt 构造与响应解析都是纯函数（可单测）；
   只有"发请求"这一步是副作用。

---

## 6. 与 metrics 账本的关系

```
局结束
  ├─ recordMetricSafe()      → metrics.jsonl（已实现，含注入计数）
  └─ reflectAndDistil()      → lessons.jsonl / strategies.jsonl（本设计）
                                   │
下一局开局 ─── selectLessons() ────┘
```

两条线**独立失败**：反思失败不得影响 metrics 记账（反之亦然）。
记账是**对照实验的地基**，比蒸馏更重要——先保证数据在，再谈学习。

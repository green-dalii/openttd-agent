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
  id: string;
  name: string;                                  // 如 "bus_route_medium_town"
  action: string;                                // 对应工具名，如 "build_bus_route"
  params: Record<string, number | string>;       // 参数化成功模式
  valuePerRun: number[];                         // **每局**一个收益样本
  evidence: string[];
  sourceSessionIds: string[];
  createdAt: number;
}
```

**入库门槛（SPEC §5.3 硬性）**：`价值 > 阈值` **且** `已验证局 ≥ 2`。
`valuePerRun.length` 就是"已验证局数"——存数组而不是标量，使门槛可判定而不是靠印象。

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

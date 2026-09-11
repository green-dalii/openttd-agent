# Dashboard UI — 设计契约（v0.4.0）

本文件是 dashboard **前端**的单一事实源：设计 token、组件契约、图表 API、页面信息架构。
协议/接口契约见 `docs/DASHBOARD-API.md`（本文件不重复，只引用）。

> 改前端前先读本文件；改本文件必须同步改代码与测试（`test/unit/web-assets.test.ts` 会校验结构）。

---

## 0. 第一性原理：这个 dashboard 是给谁用的

**用户是一个「不在电脑前的 operator」**：他启动了一次长跑（几十分钟到几小时），
偶尔回来看一眼。所以页面必须回答**按紧迫性排序**的四个问题：

| # | 问题 | 页面位置 | 呈现形式 |
|---|---|---|---|
| 1 | **它活着吗？在跑吗？** | 顶部常驻条 | 连接 pill + session + 模式 + 运行时长 |
| 2 | **它在赚钱吗？** | KPI 条（首屏） | 6 个 tile：大数字 + 环比 delta + sparkline |
| 3 | **agent 表现正常吗？** | Agent 面板 | token 构成环图、失败率、工具延迟、思考流 |
| 4 | **刚刚发生了什么？** | 底部长列表 | 步骤流 + 事件流（可过滤/暂停/搜索） |

**反面清单（本版要消灭的）**：
- ❌ 两个并排的滚动列表让用户"在列表里找列表"（Provider/Model 旧实现）
- ❌ 平铺一堆同级 panel，没有层级 → 用户不知道先看哪里
- ❌ 画布图无交互（无 tooltip/legend/坐标轴），且未按 DPR 渲染（视网膜屏发虚）
- ❌ 常驻面板永远是空的（dead UI：Live 页「阶段性总结」曾因字段不存在而永不填充）
- ❌ 反馈只在表单底部一行小字（保存成功/失败容易被忽略）

---

## 1. 设计 token（`assets/css/style.css` `:root`）

暗色为唯一主题。数值只允许在 `:root` 定义，组件里一律引用变量。

```
--bg / --bg-sunken / --panel / --panel-2 / --line / --line-strong
--ink / --ink-dim / --muted          # 文字三级
--accent(#ffb347) / --info(#5fb3ff) / --pos(#7bc96f) / --neg(#e06c75) / --warn
--c1..--c8                            # 图表分类色板（与 --pos/--neg 同源）
--r-sm(6) --r-md(10) --r-lg(14) --sp-1..--sp-5   # 圆角与间距刻度
```

图表色板必须与表格/图例中的颜色**一一对应**（同一个 tool 在表和图里同色）。

## 2. 组件契约

| 组件 | 类名 | 说明 |
|---|---|---|
| 组合框 | `.cbx` | **可搜索下拉框**（见 §3），替换滚动列表 |
| KPI tile | `.kpi` | 值 + 标签 + 可选 delta + 可选 sparkline |
| 面板 | `.panel` | 标题 + 可选 `actions` 插槽 + 内容 |
| 分组标题 | `.group` | 大分组（Economy / Agent / Activity） |
| 徽章 | `.badge.ok/.bad/.live` | 状态 |
| 类别标签 | `.tag-<category>` | 事件分类配色（`DASHBOARD-API.md` §5） |
| Toast | `#toasts` | 右下角自动消失提示（保存成功/失败） |
| 重连 pill | `#g-link` | `live` / `reconnecting…(n)` |

## 3. 组合框（`.cbx`）契约 —— 本版核心 UX 修复

**为什么**：39 个 provider × ~1900 个 model 不是"列表内容"，而是"单选控件"。
用户已经知道自己要用哪个（"我有 deepseek key"），所以第一交互是**搜索**，不是滚动。

`common.js` 导出 `UI.combobox(root, opts)`，`opts`：

```ts
{
  options: () => Option[],      // 每次打开时求值（支持异步筛选前的最新数据）
  value:    () => string,       // 当前选中 id
  onChange: (id) => void,
  placeholder: string,
  groups:   (o: Option) => string,   // 分组标题（如 "Ready now" / "Needs a key"）
  render:   (o: Option) => string,   // 选项行 HTML（名称 + 徽章 + 副行）
  search:   (o: Option, q: string) => boolean,
  empty:    string,
}
```

行为要求（产品级）：
1. 闭合态是一个**按钮**，显示当前值 + caret；点击/Enter/空格展开。
2. 展开后焦点进入搜索框，输入即过滤（**无 debounce**，本地数组）。
3. **键盘**：`↑`/`↓` 移动、`Home`/`End`、`Enter` 选中、`Esc` 关闭且不改变选择。
4. 分组标题不可选；高亮项自动滚入视野。
5. 点击外部 / `Esc` / 选中项 → 关闭。
6. ARIA：`role="combobox"` + `aria-expanded` + `aria-activedescendant` + `role="listbox"/"option"`。
7. 无匹配时显示 `empty` 文案，**不得**显示空白弹层。

## 4. 图表模块契约（`assets/js/charts.js` → `window.Charts`）

**为什么自建而不引库**：本项目要求**离线可用 + 无构建链**；所需图形只有
折线/柱/环/迷你线四种。自建 ~300 行可精确控制 tooltip、DPR、配色，且无第三方
体积与版本漂移。若未来需要复杂图形再评估 vendored 库（需记录 ADR）。

**加载期约束（可测性关键）**：文件在**加载时不得触碰 `document`/`window` 的 DOM**，
只能在函数体内访问 → 因此可在 `node:vm` 沙箱（`{window:{}}`）中加载并单测纯函数。

```ts
window.Charts = {
  line(canvas, { series: {name,color,data:number[],dashed?}[], labels?: string[],
                 format?: (v)=>string, area?: boolean, yZero?: boolean, height?: number }),
  bars(canvas, { items: {label,value,color?,sub?}[], format?: (v)=>string, horizontal?: boolean }),
  donut(canvas, { slices: {label,value,color}[], center?: {value:string,label:string} }),
  sparkline(canvas, number[], { color?: string, area?: boolean }),
  destroy(canvas),
  util: { niceTicks, niceDomain, donutSlices, fmtCompact, scaleLinear },
};
```

实现要求：
- **DPR**：按 `devicePixelRatio` 设置 `canvas.width/height`，`ctx.scale` 后按 CSS 像素绘制。
- **ResizeObserver** 重绘（不支持时静默跳过）。
- 重复调用同一 canvas = 重绘（状态存 `WeakMap`），不叠加监听器；`destroy` 释放。
- **折线**：网格 + y 轴刻度文字 + x 轴首尾标签 + hover 竖线 + tooltip（最近点）。
- **柱**：`horizontal` 时按值排序展示 top N，柱尾带数值。
- **环图**：`donutSlices` 计算弧段；中心可放文案。
- tooltip 用**惰性创建**的共享 DOM 节点 `#chart-tip`（`position:fixed`）。
- `prefers-reduced-motion` 时不做任何动画。

## 5. 页面信息架构

### 5.1 Live（`/`）
```
[sticky header]  brand + nav | link pill · session · mode/brain · elapsed
[KPI strip]      Cash · Income/yr · Company value · Vehicles · Stations · Tokens
[Economy]        (2/3) 多序列折线（money/loan + 图例 + hover tooltip）
[Agent]          (1/3) 运行状态 · token 环图 · 成本 · 失败率
[Throughput]     每 turn token 柱状 + 工具调用/延迟表
[Activity]       Steps（过滤：全部/LLM/工具/失败） | Events（类别 chips + 搜索 + 暂停）
[Stages]         阶段性总结时间线（**运行中持续追加**，不再是 shutdown 才写）
```

### 5.2 Providers（`/providers`，`/llm` 为兼容别名）
```
[选择器]  模式 segmented（内置 / 自定义端点）
          Provider combobox（分组：Ready now / Needs a key）
          Model combobox（搜索 + ctx/价格副行）
          凭据（按 provider 状态给出不同提示；env 已就绪时明确说"无需粘贴"）
[摘要]    "agent 将如何运行" 实时预览 + 保存/清除
```
保留「自定义 OpenAI 兼容端点」作为逃生舱（local llama.cpp / vLLM / gateway）。

### 5.3 Sessions（`/sessions`）
```
[KPI]        总局数 · 完成数 · 成功构建率 · 累计 token · 累计成本
[列表]       卡片：状态徽章 + 模式 + seed + 时长 + 结果（车/站/现金）+ 元数据
[复盘]       成绩单 · token 构成 · 阶段性总结时间线 · 步骤流 · 事件流
```

## 6. 交互与可达性基线
- 顶栏 `sticky`；连接状态变化用 `aria-live="polite"`。
- 视图偏好（隐藏的类别、自动滚动、选中 session）存 `localStorage`，刷新不丢。
- `:focus-visible` 明显焦点环；`prefers-reduced-motion` 关闭过渡。
- 空态必须**教会**用户下一步（给出可复制命令），不能只写 "no data"。
- 事件流支持**暂停**（阅读时不被新事件冲走）+ 搜索 + 类别计数。

## 6b. 浏览器实测发现并修复的问题（v0.4.0 真机）

前端**没有构建链也没有 DOM 单测**，所以这一层的问题只能靠真机 + CDP 发现。
记录在此，避免回退：

| 症状 | 根因 | 修复 |
|---|---|---|
| 空状态图表高 449px，一有数据就"跳" | 空数据分支跳过 `fit()`，画布停留在默认 300×200 backing store；`canvas{width:100%}` 无 CSS 高度 → 3:2 box | 空状态也走 `fit()`（`sizedClear`），并加回归测试 |
| 迷你趋势线两条画的是同一份数据 | `paintSparks(root,data,colors)` 只接受一个序列，却按 canvas 个数循环 | 改为按 tile 对齐的 `paintSparks(root, perTile[])` |
| 大数字后面粘着 `−£1` 之类 | delta chip 被拼进 `.kpi-v` 内部 | chip 移到独立 `.kpi-hint` 行；`.kpi` 顺序改为 label→value→hint→spark |
| 组合框分组标题重复 14 次 | 选项未按分组排序，同组不连续 ⇒ 分组无意义 | 组合框新增 `sort`，调用方按组优先级排序（Ready→Needs key→OAuth） |
| 组合框闭合态显示长搜索提示 | 未选择时回退到 `opts.placeholder` | 新增 `emptyLabel`（短提示），placeholder 只用于搜索框 |
| 行业收入显示 `£18446744073.71B` | **协议层**把有符号 `int64` 当 `uint64` 读（见下） | `ByteReader.int64()`；`parseCompanyEconomy` 金额字段改用它 |
| 刷新后现金曲线只剩一个点 | 历史只存在页面内存里，违反"服务端是真源" | 历史上移到 `WorldState`（有界 600 点），`snapshot` 携带，前端做 seed |

**`income` 有符号性（与 `SPEC.md` §10.6 一致）**：OpenTTD 的 `Money` 是 `int64`，
`Send_uint64` 只序列化 8 字节，读出必须还原符号；否则亏损公司永远显示约 1.8e19。
新增 `ByteReader.int64()` 并把 `money/loan/income/companyValue` 全部改为有符号读取。

## 6c. 数据可视化：选对图形（v0.5.0 实测修正）

图表类型由**数据语义**决定，不是审美：

| 场景 | 用 | 不用 | 原因 |
|---|---|---|---|
| 时间序列（现金/贷款） | 折线 | — | 连续量，斜率有意义 |
| **构成**（每轮 token 的 in/out/reasoning） | **堆叠柱** | ~~折线~~ | 输入约是输出的 20 倍，折线会全部压在**同一像素带**（实测 3px 内），大片空白且读不出占比。堆叠柱同时给出"总量"（柱高）与"构成"（分段） |
| 类别比较（工具调用/延迟） | 横向条 / 柱 | — | 长度可比，标签可读 |
| 单个占比 | 环图 | — | 中心可放汇总数字 |
| KPI 趋势 | 迷你线 | — | 只表达方向，不给刻度 |

**柱状图必须零基**：`niceDomain()` 会在最小值下方留约 4% 内边距；对非负序列（token、
调用数）会把 y 轴拉到 0 以下，柱子悬空、下方一条死区（实测悬空 30px）。柱图统一走
`zeroBasedDomain()` → `[0, niceMax]`。折线图保留内边距（序列可能不从 0 起）。

**空状态也要定尺寸**：无数据分支此前跳过 `fit()`，画布停在默认 300×200 backing store；
配合 `canvas{width:100%}` 且无 CSS 高度 → 3:2 方框（实测高 449px），一有数据就"跳"。
现在空状态同样走 `fit()`（`sizedClear`）。

**超量要说明**：堆叠柱最多 24 根，超出时在图上标注 "…earlier turns hidden"，不静默截断。

## 7. WS 帧补充（与 `DASHBOARD-API.md` §4 同步）
新增 `{ type: "checkpoint", data: SessionCheckpoint }`：阶段性总结**在运行中**产生时推送。
`snapshot` 载荷增加 `checkpoints: SessionCheckpoint[]`，使刷新/晚订阅者也能看到历史。
理由：原实现只在 shutdown 写 checkpoint，导致 Live 页的总结面板在整局运行期间恒为空。

`snapshot.companies[id].history` 同样携带**有界**经济序列（`WorldState` 持有），
理由：曲线此前只存在于页面内存，刷新即清空。

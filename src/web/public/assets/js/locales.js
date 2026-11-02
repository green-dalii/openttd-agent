/**
 * Message catalog — the dashboard's Chinese translations.
 *
 * 职责: `msgid`（英文源文本）→ 中文。**英文不需要这张表**（回落即英文），
 *   所以这张表只存译文；源文本仍写在标记/脚本里（gettext 模型，见 i18n.js）。
 *
 * 规则:
 *   - **键必须与源文本逐字相同**（`test/unit/i18n.test.ts` 的守卫会核对），
 *     源文本改了 ⇒ 这条失配 ⇒ 守卫报错，而不是页面悄悄回落到英文。
 *   - 带插值的句子用 `{0}` 占位（两边同形）；运行时按捕获组回填。
 *   - **服务端来的文案不在这张表里**（结局词表、问题 hint）：服务端只有一份
 *     规范文案（B5 的「每个 code 只有一个规范 hint」），前端再翻一份就是第二份。
 *     服务端词汇按 id 本地化是下一步（前端有 id，不靠猜文案）。
 */

window.I18nMessages = {
  "zh": {
    /* ---- 页头与导航 ---- */
    "Run": "运行",
    "Compare": "比较",
    "History": "历史",
    "Configure": "配置",

    /* ---- Run 页：冷启动的三步引导 ---- */
    "Choose the model": "选择模型",
    "Set the limits": "设定上限",
    "Start the run": "开始这一局",
    "Open Configure": "打开配置页",
    "Open run settings": "打开运行设置",
    "The provider and model decide how the agent thinks. Keys live in a file outside the repository, never in it.":
      "provider 与模型决定了 agent 怎么思考。密钥放在仓库之外的文件里，从不进仓库。",
    "Seed, game days, token cap and cost cap are optional — an empty field keeps the server's own setting.":
      "seed、游戏日数、token 上限、花费上限都是可选的 —— 留空就沿用服务端自己的设置。",
    "Start agent plays with that model. Observe only records what the built-in AI does, with no model calls at all.":
      "Start agent 用那个模型自己打；Observe only 只记录内置 AI 做了什么，不产生任何模型调用。",

    /* ---- Compare 页：比较计划（Issue #48） ----
       注："Token cap" 是**服务端结局词表**里的类名（outcome.ts），按 B5 的
       "服务端只有一份规范文案" 规则**不进这张表** —— 它在中文界面里保持英文，
       与配置页的同名旋钮一致。 */
    "Plan a comparison": "计划一次比较",
    "the server says what it would run, before it runs it": "跑之前，服务端先说它会跑什么",
    "Models": "模型",
    "Seeds": "世界种子",
    "Preview the plan": "预览计划",
    "Launch this plan": "按计划开跑",
    "no models yet — the plan needs at least one": "还没有模型 —— 计划至少要一个模型",
    "pick at least one model": "至少选一个模型",
    "add at least one seed": "至少填一个世界种子",
    "a comparison is already running": "已经有一个比较在跑",
    "preview the plan first": "先预览计划",
    "Cost": "花费",
    "measurable": "可测",
    "no horizon": "不限视界",
    "no cap": "不设上限",
    "Cell": "格子",
    "Comparison running: ": "比较进行中：",
    "Last comparison: ": "上一次比较：",
    " — now running ": " —— 正在跑 ",
    " — every cell finished": " —— 每一格都跑完了",
    " cell(s) failed": " 格失败",
    "Each game is a full run; they run one after another.": "每一格都是一局完整的运行；它们一个接一个地跑。",
    "Run the plan": "开始跑计划",

    /* ---- Compare 页 ---- */
    "same worlds, different models — every number computed by the server": "同一批世界，不同模型 —— 每个数字都由服务端算出",
    "Four axes per model": "每个模型的四个轴",
    "Result / Efficiency / Reliability / Growth": "成绩 / 效率 / 可靠性 / 成长",
    "Model": "模型",
    "Runs": "局数",
    "Excluded": "被排除",
    "Result": "成绩",
    "Efficiency": "效率",
    "Reliability": "可靠性",
    "Growth": "成长",
    "Delivered / game day": "每日交付",
    "Median": "中位数",
    "Stations": "车站",
    "Vehicles": "车辆",
    "Delivered / M tokens": "每百万 token 的交付",
    "Tokens / decision": "每次决策的 token",
    "Seconds / run": "每局秒数",
    "Cost / run": "每局花费",
    "Tool failure rate": "工具失败率",
    "GS errors / run": "每局 GS 错误",
    "not determinable": "不可判定",
    "not measured": "未测到",
    "unknown": "未知",
    "Outcomes": "结局",
    "Paired comparison": "配对比较",
    "Excluded runs": "被排除的局",
    "The runs": "这些局",
    "Backend": "后端",
    "Seed": "种子",
    "Delivered / day": "每日交付",
    "Status": "状态",
    "counted": "计入",
    "Loading…": "加载中…",

    /* ---- Run 页 ---- */
    "No run is active": "当前没有运行中的局",
    "Start a run to see the agent's decisions, token usage and steps.":
      "开一局，就能看到 agent 的决策、token 用量与每一步。",
    "Start agent": "启动 agent",
    "Observe only": "只观察",
    "Pause": "暂停",
    "Stop": "停止",
    "Just happened": "刚刚发生",
    "Diagnostics": "诊断",
    "Current goal": "当前目标",
    "Last action": "上一个动作",
    "Last decision": "上次决策",
    "Turns": "轮次",
    "Phase": "阶段",
    "Brain": "大脑",
    "Cash": "现金",
    "Fleet": "车队",
    "Loan": "贷款",
    "Income / yr": "年收入",
    "Value (last yr)": "价值（去年）",
    "details ▸": "详情 ▸",
    "no decision recorded yet": "还没有记录任何决策",
    "No decisions recorded yet — the timeline fills as the agent decides.":
      "还没有决策记录 —— agent 每做一次决定，时间线上就多一行。",

    /* ---- History 页 ---- */
    "Completed": "已完成",
    "Success": "成功率",
    "Tokens": "token",
    "Spend": "花费",
    "Training": "训练",
    "Memory": "记忆",
    "Replay": "回放",
    "Manifest": "清单",
    "Token usage": "token 用量",
    "Token breakdown": "token 构成",
    "Tool failures": "工具失败",
    "Strategy candidates": "策略候选",
    "Type": "类型",
    "Detail": "详情",
    "Map": "地图",
    "Town": "城镇",
    "Town detail": "城镇详情",
    "Events": "事件",
    "Agent activity": "agent 活动",
    "Data": "数据",
    "Reasoning": "推理",
    "Reasoning budget": "推理预算",
    "Tool budget": "工具预算",
    "thinking budget": "思考预算",

    /* ---- Configure 页 ---- */
    "Choose how the agent thinks": "选择 agent 怎么想",
    "Model selection": "模型选择",
    "How the agent will run": "agent 怎么跑",
    "Where this is stored": "存在哪里",
    "Ready providers": "已就绪的 provider",
    "Credentials": "凭据",
    "API key": "API 密钥",
    "Save configuration": "保存配置",
    "Clear stored key": "清除已存的 key",
    "Run settings": "运行设置",
    "Run knobs": "运行旋钮",
    "Next run": "下一局",
    "Game days": "游戏天数",
    "Scenario": "场景",
    "Memory arm": "记忆臂",
    "Thinking": "思考",
    "Cost cap": "花费上限",
    "Preview": "预览",
    "Start with these settings": "用这些设置开跑",
    "blank = the server's seed": "留空 = 用服务端默认的种子",
    "blank = no horizon": "留空 = 不设视界",
    "blank = no cap": "留空 = 不设上限",
    "blank = no cap (USD)": "留空 = 不设上限（美元）",
    "(server default)": "（服务端默认）",
    "Built-in": "内置",
    "Custom endpoint": "自定义端点"
  }
};

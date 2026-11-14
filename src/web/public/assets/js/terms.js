/**
 * Server vocabulary, translated **by id**.
 *
 * 职责: 结局十类、问题码、度量口径、旋钮取值这些**服务端拥有的词**，在前端
 *   按 **id** 翻，而不是把服务端的文案抄进前端词表（B5：服务端只有一份规范文案）。
 *
 * 为什么按 id 而不是按文案：
 *   - 按文案 ⇒ 前端词表里会出现服务端的措辞 ⇒ 那是**第二份**规范文案 ⇒
 *     服务端改一个字，前端就悄悄回落到英文（而且没人知道）；
 *   - 按 id ⇒ 前端只认 **id**（`outcome.token_cap`、`problem.no_credential`），
 *     服务端的措辞仍然只有一份；id 没翻时**回落到服务端的原文**（不是空白）。
 *
 * 键的形状：
 *   `outcome.<code>` / `outcome.<code>.hint` —— 结局十类（B5：封闭词表）
 *   `problem.<code>` —— 问题码的规范 hint（只写动作，不写事实）
 *   `measure.<id>` —— 度量口径（服务端给的 measure / splitMeasure）
 *   `metric.<id>.label` / `metric.<id>.unit` —— 逐轴指标目录里的措辞
 *   `knob.<key>.<value>` —— 旋钮取值的显示名（**取值本身**仍是服务端的 id）
 *
 * 守卫（`test/unit/i18n.test.ts`）：服务端能产出的每个 id 都必须在这里有词条 ——
 * 词表由**服务端**的清单校验（`OUTCOME_CLASSES` / `PROBLEM_CODES` /
 * `PAIRED_METRICS`），所以新增一个 id 而忘了翻 ⇒ gate 直接红。
 */

window.I18nTerms = {
	/* ---- 结局十类（B5：服务端判定，前端按 id 翻） ---- */
	"outcome.delivered": "交付了",
	"outcome.delivered.hint": "这一局交付了货物与旅客 —— 是真结果",
	"outcome.delivered_nothing": "建了，但没交付",
	"outcome.delivered_nothing.hint": "施工完成了，但什么都没送出去 —— 看线路与车辆",
	"outcome.no_construction": "什么都没建",
	"outcome.no_construction.hint": "这一局在有任何施工完成前就结束了 —— agent 一次线都没铺起来",
	"outcome.refused": "所有工具调用都被拒绝",
	"outcome.refused.hint": "模型根本没机会动手：每次调用都被拒 —— 参数不对，或者预算用完了",
	"outcome.paused_by_agent": "被 agent 自己暂停",
	"outcome.paused_by_agent.hint": "这一局是从里面停掉的（set_pause）—— 不是学习结果",
	"outcome.world_frozen": "世界冻住了",
	"outcome.world_frozen.hint": "停的是环境，不是 agent —— 不是学习结果",
	"outcome.wall_clock_cap": "到了墙钟上限",
	"outcome.wall_clock_cap.hint": "这一局在到视界之前就用完了时间 —— 是短答案，不是差答案",
	"outcome.token_cap": "到了 token 上限",
	"outcome.token_cap.hint": "这一局在到视界之前就用完了 token —— 把上限调高才能跑完",
	"outcome.cost_cap": "到了花费上限",
	"outcome.cost_cap.hint": "这一局在到视界之前就用完了花费 —— 把上限调高才能跑完",
	"outcome.unknown": "未知",
	"outcome.unknown.hint": "读数不够，说不出是哪一类 —— 不等于「什么都没发生」",

	/* ---- 问题码（只写动作，不写事实；事实属于 message） ---- */
	"problem.invalid_knob": "在配置页改掉标出来的那个旋钮，然后重开",
	"problem.unknown_provider": "在 provider 页从目录里选一个 provider",
	"problem.unknown_model": "在 provider 页按「从 provider 刷新」，然后从列表里选一个模型",
	"problem.no_credential": "在 provider 页填入 API 密钥并保存",
	"problem.unpriced_with_cost_cap": "去掉花费上限，或者换一个带价目表的模型",
	"problem.invalid_base_url": "在 provider 页填端点地址（例如 http://127.0.0.1:11434/v1）",
	"problem.provider_unavailable": "检查端点地址与网络，然后重试",
	"problem.endpoint_401": "provider 拒收了已存的密钥：在下面重新填一遍，然后刷新",
	"problem.endpoint_403": "这个密钥可能没有列模型的权限：内置快照仍然是权威来源",
	"problem.no_model_endpoint": "这个 provider 没有模型列表端点：内置快照是唯一来源",

	/* ---- 度量口径（服务端的 measure / splitMeasure） ---- */
	"measure.delivered": "货物 + 旅客交付量",
	"measure.splitByCargoType": "交付到被监视的城镇/产业（按货种）",

	/* ---- 逐轴指标目录（PAIRED_METRICS 的措辞） ---- */
	"metric.ability.deliveredPerGameDay.label": "货物 + 旅客交付量",
	"metric.ability.deliveredPerGameDay.unit": "每游戏日",
	"metric.ability.cargoDeliveredPerGameDay.label": "货物交付量",
	"metric.ability.cargoDeliveredPerGameDay.unit": "每游戏日",
	"metric.ability.operatingProfitPerGameDay.label": "运营利润（运货收入 − 运行成本）",
	"metric.ability.operatingProfitPerGameDay.unit": "每游戏日",
	"metric.ability.stations.label": "车站数",
	"metric.ability.stations.unit": "局末",
	"metric.ability.vehicles.label": "车辆数",
	"metric.ability.vehicles.unit": "局末",
	"metric.efficiency.deliveredPerMillionTokens.label": "货物 + 旅客交付量",
	"metric.efficiency.deliveredPerMillionTokens.unit": "每百万 token",
	"metric.efficiency.tokensPerDecision.label": "token",
	"metric.efficiency.tokensPerDecision.unit": "每次决策",
	"metric.efficiency.secondsPerRun.label": "墙钟",
	"metric.efficiency.secondsPerRun.unit": "每局秒数",
	"metric.efficiency.costPerRun.label": "花费",
	"metric.efficiency.costPerRun.unit": "每局",
	"metric.stability.toolFailureRate.label": "失败的工具调用",
	"metric.stability.toolFailureRate.unit": "占全部调用的比例",
	"metric.stability.gsErrorsPerRun.label": "GS 错误",
	"metric.stability.gsErrorsPerRun.unit": "每局",

	/* ---- 旋钮取值（取值本身仍是服务端的 id；这里只是显示名） ---- */
	"knob.scenario.freeform": "自由开局",
	"knob.scenario.prebuilt": "预建场景",
	"knob.memoryArm.treatment": "有记忆",
	"knob.memoryArm.control": "无记忆",
	"knob.thinkingLevel.off": "关闭",
	"knob.thinkingLevel.minimal": "最低",
	"knob.thinkingLevel.low": "低",
	"knob.thinkingLevel.medium": "中",
	"knob.thinkingLevel.high": "高",
	"knob.thinkingLevel.xhigh": "很高",
	"knob.thinkingLevel.max": "最高",
	"knob.backend.agent": "agent 驱动",
	"knob.backend.harness": "只跑脚本",
};

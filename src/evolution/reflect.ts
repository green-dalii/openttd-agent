/**
 * Reflection — 局终反思的 prompt 构造与响应解析（SPEC §5.1 反思阶段）。
 *
 * 职责: 把一局的**结构化事实**编成 prompt，并把模型的响应**强校验**成
 *   lessons / 策略采样。除"发请求"之外全是纯函数。
 * 事实来源: SPEC §5.1（反思）、§5.3（禁止臆测因果、只接受游戏事实佐证）,
 *   docs/EVOLUTION.md §5。
 * 禁止: 在此发网络请求或读写磁盘（由调用方 runner 负责）。
 *
 * 为什么校验这么严:反思是幻觉进入**长期记忆**的唯一入口。模型很擅长给出听起来
 * 合理、但游戏里根本没发生过的因果解释;一旦入库,它会在之后每一局被重复注入。
 * 所以宁可整条丢掉,不可放行。
 */


/**
 * 反思输入里"已记录了什么"的容量上限。
 *
 * 为什么要有上限：这是唯一一处把**库**塞进提示词的地方，不做限制会让提示词
 * 随游戏数线性增长。只给最近的一批，够支持 `supersedes` 即可。
 */
export const MAX_RECORDED_SHOWN = 24;

/** Structured facts about the finished game — the only input reflection gets. */
export interface ReflectionFacts {
	sessionId: string;
	seed: number;
	/**
	 * 已记录的观察（id + 文本），只为让 `supersedes` 有用武之地。
	 * 缺省为空数组 —— 反思在"库为空"与"没提供库"时都不该编 id。
	 */
	recorded?: { id: string; text: string }[];
	summary: {
		money: number;
		/**
		 * Cargo delivered during the run (the harness's own outcome metric, SPEC
		 * §10.65) and the simulated length of the episode.
		 *
		 * Why they belong here: the reflection used to see only money, which is
		 * dominated by construction spending and loans - i.e. lessons were being
		 * distilled from the most confounded signal available, while the
		 * experiment scored the agent on cargo throughput. Reflection must reason
		 * about the quantity the run is judged by, or memory learns the wrong
		 * subject. Absent stays absent (never printed as 0).
		 */
		delivered?: number | null;
		simulatedDays?: number | null;
		/** Why the episode ended: "horizon" | "wall_cap" | null (unknown). */
		episodeStop?: string | null;
		vehicleCount: number;
		stationCount: number;
		decisions: number;
		toolCalls: number;
		toolFailures: number;
		constructionDone: boolean | null;
		durationMs: number;
	};
	/** Action outcomes / notable events, already reduced to factual statements. */
	evidence: string[];
}

/**
 * Phrases that mark a causal guess rather than an observation (SPEC §5.3).
 *
 * Deliberately narrow: only textbook speculation. "may" is excluded so that
 * "Maytown" / "monthly" are not rejected — a false positive here silently
 * deletes a real lesson, which is worse than letting one guess through.
 */
const SPECULATION_PATTERNS: RegExp[] = [
	/\bprobably\b/i,
	/\bperhaps\b/i,
	/\bmaybe\b/i,
	/\bi\s+think\b/i,
	/\bit\s+(might|may|could)\s+have\b/i,
	/\bseems?\s+(like|that)\b/i,
	/\bpresumably\b/i,
	/\bi\s+(guess|assume|suspect)\b/i,
	/\b(possibly|likely)\s+because\b/i,
	/可能/,
	/大概/,
	/也许/,
	/似乎/,
	/估计是/,
	/应该是因为/,
];

/** True when the sentence speculates about causes instead of citing game facts. */
export function isSpeculative(text: unknown): boolean {
	if (typeof text !== "string" || !text) return false;
	return SPECULATION_PATTERNS.some((re) => re.test(text));
}

export interface ReflectionPrompt {
	system: string;
	user: string;
}

/**
 * Build the reflection prompt.
 *
 * The prohibition on speculation is stated in BOTH the system and the user turn:
 * it is the single constraint that keeps the memory library from filling with
 * confident nonsense, and instructions buried in one place are easy to drift from.
 */
export function buildReflectionPrompt(facts: ReflectionFacts): ReflectionPrompt {
	const s = facts.summary;
	const factsBlock = facts.evidence.length
		? facts.evidence.map((e) => `- ${e}`).join("\n")
		: "(no structured evidence was recorded for this game)";

	const system = [
		"You review one finished OpenTTD game and record what was OBSERVED.",
		"",
		"HARD RULES:",
		"1. Record OBSERVATIONS about what happened - never advice, orders or",
		"   recommendations. 'The route delivered 137 units' is an observation;",
		"   'build one route first' / 'you should add vehicles' are instructions and",
		"   will be REJECTED by the validator (and you will be told why).",
		"2. Do NOT speculate about causes. Do not use words like probably, perhaps,",
		"   maybe, seems, or I think. If the game did not record it, you do not know it.",
		"3. Every entry MUST cite game facts in its `evidence` array AND carry the",
		"   measured reading it is about in `outcome` ({metric, before, after}).",
		"   Either one missing means the entry is discarded, so omitting it only",
		"   wastes the entry.",
		"4. Only report what the evidence below supports. Do not invent events.",
		"5. Keep each entry to one short sentence.",
		"6. If an entry below CONTRADICTS something already recorded (see the current",
		"   library), name the ids it replaces in `supersedes`. A later game",
		"   disproving an earlier record is normal - say so instead of staying silent.",
		"",
		"",
		// 协议由**工具**定义（R2b）。这里只说明怎么用，不再贴 JSON schema：
		// 参数由工具 schema 校验，写错了会被拒并告知理由。
		// ⚠️ 提示词与运行时是**同一份契约的两半**：改一边必须改另一边，
		// 且由 `reflect-tools.test` / `evolution-reflect.test.ts` 的交叉守卫看住
		// （真机事故 2026-09-19：运行时已改成工具，提示词还在要求"Reply with JSON"，
		// 模型于是老老实实回 JSON、一个工具都没调 → "0 lessons kept" 看起来像
		// "这局没什么可学的"，实际是契约两半不一致）。
		"Record what you observed by CALLING THE TOOLS:",
		"- record_lesson: call it once per observation (it takes text, outcome, evidence,",
		"  optional confidence and optional supersedes).",
		"- record_strategy: call it for a parameterised pattern this game provides a",
		"  measured sample for (action, params, value, evidence).",
		"Call them as many times as you have entries. A rejected call tells you the",
		"reason - fix it and call again. If this game recorded nothing worth keeping,",
		"call nothing at all (that is a valid answer).",
	].join("\n");

	const user = [
		`Game session ${facts.sessionId} (seed ${facts.seed}) has ended.`,
		"",
		"Outcome:",
		`- final money: ${s.money}`,
		// The outcome the harness actually scores. Printed only when measured.
		...(typeof s.delivered === "number"
			? [
					`- cargo delivered during the run: ${s.delivered}${
						typeof s.simulatedDays === "number" && s.simulatedDays > 0
							? ` over ${s.simulatedDays} game days (${(s.delivered / s.simulatedDays).toFixed(2)}/game day)`
							: ""
					}`,
				]
			: ["- cargo delivered during the run: not measured"]),
		...(s.episodeStop ? [`- the episode ended because: ${s.episodeStop}`] : []),
		`- vehicles: ${s.vehicleCount}, stations: ${s.stationCount}`,
		`- construction completed: ${s.constructionDone === null ? "unknown" : String(s.constructionDone)}`,
		`- LLM decisions: ${s.decisions}, tool calls: ${s.toolCalls}, failures: ${s.toolFailures}`,
		`- duration: ${Math.round(s.durationMs / 1000)}s`,
		"",
		"Recorded evidence (the only facts you may rely on):",
		factsBlock,
		// 现库：反思需要看到**已记录了什么**，否则 `supersedes` 无从产生，
		// 而 `supersededBy` 从 Phase C 起就存在却从未被赋值 —— 记忆只增不减（R2）。
		...(() => {
			const lib = (facts.recorded ?? []).slice(0, MAX_RECORDED_SHOWN);
			if (lib.length === 0) return ["", "Already recorded: (nothing yet)"];
			return [
				"",
				`Already recorded (${lib.length}${(facts.recorded?.length ?? 0) > lib.length ? ` of ${facts.recorded!.length}` : ""} entries; cite an id in \`supersedes\` to replace one):`,
				...lib.map((l) => `- [${l.id}] ${l.text}`),
			];
		})(),
	].join("\n");

	return { system, user };
}

/**
 * R2b（2026-09-18）：JSON 解析路径已删除。
 *
 * 反思现在走 pi-agent-core 的 Agent + `record_lesson`/`record_strategy` 工具
 * （见 reflect-tools.ts）：参数由 schema 校验，拒绝会作为工具错误**回到模型**。
 * 保留"输出 JSON 再解析"会造成两条并存的契约（提示词一套、工具一套），
 * 而本项目已为"两个地方描述同一个事实"付过代价（MEMORY D19/D22）。
 * 校验的唯一实现在 `lessons.ts:validateLesson` 与 `reflect-tools.ts`。
 */

/** Stage checkpoint + acted-tool facts fed into the reflection prompt as evidence. */
interface EvidenceInput {
	stages?: { gameDate?: unknown; turn?: unknown; note?: unknown }[];
	actions?: { tool?: unknown; ok?: unknown; summary?: unknown }[];
}

export function buildReflectionEvidence(input: EvidenceInput): string[] {
	const out: string[] = [];
	for (const s of Array.isArray(input?.stages) ? input.stages : []) {
		const when = typeof s?.gameDate === "string" && s.gameDate ? s.gameDate : "?";
		const turn = Number.isFinite(Number(s?.turn)) ? `turn ${Number(s?.turn)}` : "?";
		const note = typeof s?.note === "string" ? s.note.replace(/\s+/g, " ").trim() : "";
		if (!note) continue;
		out.push(`${when} (${turn}): ${note}`);
	}
	for (const a of Array.isArray(input?.actions) ? input.actions : []) {
		const tool = typeof a?.tool === "string" ? a.tool : "";
		if (!tool) continue;
		const summary =
			typeof a?.summary === "string" ? a.summary.replace(/\s+/g, " ").trim() : "";
		out.push(`${tool} -> ${a?.ok === false ? "failed" : "ok"}${summary ? `: ${summary}` : ""}`);
	}
	return out;
}

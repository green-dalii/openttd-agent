/**
 * Run knobs — the settings of ONE run (not of the process).
 *
 * 职责: 把「这一局用什么旋钮」解析成一份**已校验**的清单，并把它落到
 *   Config（世界/脚手架/花费上限）与运行选项（游戏日/场景/记忆臂/后端）上。
 * 为什么需要它: 旋钮此前只存在于 env/CLI（进程级），于是「从页面起一局」不可能——
 *   页面能改的旋钮，一个都传不到 runner。
 * 铁律:
 *   - **校验规则只有一份**: 思考档/工具预算复用 `resolveScaffoldKnobs`，花费上限复用
 *     `resolveRunLimits`（把请求值拼成同形的 env 记录喂进去），所以页面与 CLI
 *     永远用同一套规则（不另写一份 ⇒ 不会漂移）。
 *   - 非法值**报错并给出下一步**，不静默回退（静默回退会让"我扫了 high 档"变成谎话）。
 *   - 缺省 = 沿用进程配置（env/CLI 定的值），页面不传的旋钮不改变行为。
 *   - **页面不归一化**: 请求里的值按原样进来（字符串也收），由这里严格解析。
 *     页面做归一化就会出现"页面说 12、服务器收到 12"这种对不上的中间态。
 * 事实来源: docs/DASHBOARD-CODESIGN.md §4.4/§5（B2）；Issue #34。
 * 禁止: 在此做 IO；在此猜测模型/凭据（那是 selection.ts 的职责）。
 */

import { resolveScaffoldKnobs, type ThinkingLevelName } from "./scaffold-knobs.js";
import { resolveRunLimits } from "./run-budget.js";
import { ProblemError, type Problem } from "./problems.js";

/** Which runtime drives the loop. */
export type RunBackend = "agent" | "harness";

/**
 * A knob value as it arrives from the page.
 *
 * Strings are accepted **verbatim** (the page forwards what the user typed) and
 * parsed strictly here: "12abc" and "12.5" are errors, not 12.
 */
export type KnobValue = number | string | null | undefined;

/**
 * The knobs of one run, as the page sent them.
 *
 * The values are unparsed: the page does not normalize them (a page-side
 * "12abc" → 12 would make the page and the server disagree about what ran).
 */
export interface RunKnobInput {
	/** World seed (integer >= 1). */
	seed?: KnobValue;
	/**
	 * Which model this run uses.
	 *
	 * Why it is a knob and not a process setting: a **comparison** runs several
	 * models in one process (Issue #48), and each cell must name its own model.
	 * Absent = the process's current selection (the common case).
	 *
	 * Only the **shape** is checked here (a non-empty name); whether the model
	 * exists is the resolver's business (selection.ts), so the rule is not
	 * written twice.
	 */
	model?: KnobValue;
	/** Episode horizon in simulated game days (integer >= 1). */
	gameDays?: KnobValue;
	/** "freeform" (default) or "prebuilt" (a route exists before the window opens). */
	scenario?: KnobValue;
	/** Which memory arm: treatment (memory injected) or control (not). */
	memoryArm?: KnobValue;
	/** Thinking level (off|minimal|low|medium|high|xhigh|max). */
	thinkingLevel?: KnobValue;
	/** Tool calls allowed per decision (integer >= 1). */
	toolBudget?: KnobValue;
	/** Stop after this many tokens (null = no cap). */
	tokenLimit?: KnobValue;
	/** Stop after this much spend in USD (null = no cap). */
	costLimit?: KnobValue;
	/** Which runtime drives the loop: the plain agent or the pi-agent-core harness. */
	backend?: KnobValue;
}

/**
 * Read the knobs out of a raw request body.
 *
 * The web layer forwards whatever the page sent; only the **shape** is
 * interpreted here (a value that is not text/number/null is a type error the
 * parser reports — it is never silently dropped, because a dropped knob would
 * quietly fall back to the default and the run would differ from the preview).
 */
export function knobInputFrom(raw: Record<string, unknown> | undefined): RunKnobInput {
	const out: Record<string, unknown> = {};
	if (!raw) return out as RunKnobInput;
	for (const [key, value] of Object.entries(raw)) {
		if (value === null || value === undefined) {
			out[key] = value;
			continue;
		}
		if (typeof value === "number" || typeof value === "string") {
			out[key] = value;
			continue;
		}
		// Anything else (object, boolean, array) is kept as its text form so the
		// parser can say "this is not a number" instead of ignoring the field.
		out[key] = typeof value === "boolean" ? String(value) : JSON.stringify(value);
	}
	return out as RunKnobInput;
}

/** The knobs after validation: every field present and legal. */
export interface RunKnobs {
	/** The world seed this run uses (the process seed when the page left it blank). */
	seed: number;
	/** The model this run uses (null = the process's current selection). */
	model: string | null;
	gameDays: number | null;
	scenario: "freeform" | "prebuilt";
	memoryArm: "treatment" | "control";
	thinkingLevel: ThinkingLevelName;
	toolBudget: number;
	tokenLimit: number | null;
	costLimit: number | null;
	backend: RunBackend;
}

/**
 * The values a run falls back to when the page does not name a knob.
 *
 * These come from the **process** (env/CLI), so "the page did not touch it"
 * means "keep what the operator configured on the command line".
 */
export interface RunKnobDefaults {
	/** The process seed (already resolved; the page may override it). */
	seed: number;
	/** The process's current model (null when the page names one). */
	model: string | null;
	gameDays: number | null;
	scenario: "freeform" | "prebuilt";
	memoryArm: "treatment" | "control";
	thinkingLevel: ThinkingLevelName;
	toolBudget: number;
	tokenLimit: number | null;
	costLimit: number | null;
	backend: RunBackend;
}

function bad(message: string, hint: string): Problem {
	return { code: "invalid_knob", message, hint };
}

/** Is this value "not provided" (empty field / null)? */
function isAbsent(v: KnobValue): boolean {
	return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * Parse a knob value as a positive integer.
 *
 * Strict on purpose: "12abc" and "12.5" are typos the user must see, not
 * something to round away silently.
 */
function parseInt(
	raw: KnobValue,
	name: string,
	opts: { min: number; max: number; problems: Problem[] },
): number | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === "string" && raw.trim() === "") return null;
	if (typeof raw === "number") {
		if (!Number.isInteger(raw)) {
			opts.problems.push(bad(`${name} must be a whole number, got ${raw}`, `use a whole number between ${opts.min} and ${opts.max}`));
		} else if (raw < opts.min || raw > opts.max) {
			opts.problems.push(bad(`${name} must be between ${opts.min} and ${opts.max}, got ${raw}`, `use a number between ${opts.min} and ${opts.max}`));
		}
		return raw;
	}
	const text = raw.trim();
	if (!/^-?\d+$/.test(text)) {
		opts.problems.push(bad(`${name} must be a whole number, got "${text}"`, `use a whole number between ${opts.min} and ${opts.max}`));
		return null;
	}
	const n = Number(text);
	if (!Number.isSafeInteger(n) || n < opts.min || n > opts.max) {
		opts.problems.push(bad(`${name} must be between ${opts.min} and ${opts.max}, got "${text}"`, `use a number between ${opts.min} and ${opts.max}`));
		return null;
	}
	return n;
}

/** Parse a knob value as one of a fixed set of words. */
function parseWord(
	raw: KnobValue,
	name: string,
	allowed: readonly string[],
	problems: Problem[],
): string | null {
	if (isAbsent(raw)) return null;
	const text = String(raw).trim();
	if (!allowed.includes(text)) {
		problems.push(
			bad(
				`${name} must be one of ${allowed.join(" | ")}, got "${text}"`,
				name === "backend" && text === "harness"
					? "the harness backend is off by default: start the server with AGENT_HARNESS=1 to enable it"
					: `pick one of: ${allowed.join(", ")}`,
			),
		);
		return null;
	}
	return text;
}

/**
 * Resolve the knobs of one run.
 *
 * Throws `ProblemError` (→ HTTP 400 with `problems[]`) when a value is illegal:
 * the caller gets **what is wrong and what to do**, and nothing starts.
 */
export function resolveRunKnobs(
	input: RunKnobInput,
	defaults: RunKnobDefaults,
	allowedBackends: readonly RunBackend[] = ["agent", "harness"],
): RunKnobs {
	const problems: Problem[] = [];

	const seed =
		parseInt(input.seed, "seed", { min: 1, max: 2 ** 31 - 1, problems }) ?? defaults.seed;
	// The model's **shape** only: a name, or nothing (the process's model).
	// Existence is the resolver's call (selection.ts) — one rule, not two.
	let model: string | null = defaults.model;
	if (!isAbsent(input.model)) {
		const text = String(input.model).trim();
		if (!text || text.length > 200) {
			problems.push(
				bad(
					text ? `the model name is too long (${text.length} characters)` : "the model name is empty",
					"pick a model from the list",
				),
			);
		} else {
			model = text;
		}
	}
	const gameDays =
		parseInt(input.gameDays, "gameDays", { min: 1, max: 100_000, problems }) ?? defaults.gameDays;
	const scenario =
		(parseWord(input.scenario, "scenario", ["freeform", "prebuilt"], problems) as
			| "freeform"
			| "prebuilt"
			| null) ?? defaults.scenario;
	const memoryArm =
		(parseWord(input.memoryArm, "memoryArm", ["treatment", "control"], problems) as
			| "treatment"
			| "control"
			| null) ?? defaults.memoryArm;
	const backend = (parseWord(input.backend, "backend", allowedBackends, problems) as RunBackend | null) ??
		defaults.backend;

	// The scaffold knobs and the spend caps are validated by the SAME functions
	// the CLI uses (fed a synthetic env record) — a second rule set would drift.
	let thinkingLevel = defaults.thinkingLevel;
	let toolBudget = defaults.toolBudget;
	try {
		const knobs = resolveScaffoldKnobs({
			LLM_THINKING: isAbsent(input.thinkingLevel) ? defaults.thinkingLevel : String(input.thinkingLevel),
			LLM_TOOL_BUDGET: isAbsent(input.toolBudget)
				? String(defaults.toolBudget)
				: String(input.toolBudget),
		});
		thinkingLevel = knobs.thinkingLevel;
		toolBudget = knobs.toolBudget;
	} catch (e) {
		problems.push(
			bad(
				e instanceof Error ? e.message : String(e),
				"thinking level: off|minimal|low|medium|high|xhigh|max; tool budget: a positive integer",
			),
		);
	}

	let tokenLimit = defaults.tokenLimit;
	let costLimit = defaults.costLimit;
	try {
		const limits = resolveRunLimits({
			LLM_TOKEN_LIMIT: isAbsent(input.tokenLimit)
				? defaults.tokenLimit === null
					? ""
					: String(defaults.tokenLimit)
				: String(input.tokenLimit),
			LLM_COST_LIMIT: isAbsent(input.costLimit)
				? defaults.costLimit === null
					? ""
					: String(defaults.costLimit)
				: String(input.costLimit),
		});
		tokenLimit = limits.tokens;
		costLimit = limits.cost;
	} catch (e) {
		problems.push(
			bad(
				e instanceof Error ? e.message : String(e),
				"token limit: a positive integer; cost limit: a positive number of USD",
			),
		);
	}

	if (problems.length > 0) throw new ProblemError(problems);

	return {
		seed,
		model,
		gameDays,
		scenario,
		memoryArm,
		thinkingLevel,
		toolBudget,
		tokenLimit,
		costLimit,
		backend,
	};
}

/**
 * The knobs as they would be with this input — without throwing.
 *
 * The preview needs to show what WOULD happen; the start path needs to refuse.
 */
export function previewRunKnobs(
	input: RunKnobInput,
	defaults: RunKnobDefaults,
	allowedBackends: readonly RunBackend[] = ["agent", "harness"],
): { knobs: RunKnobs | null; problems: Problem[] } {
	try {
		return { knobs: resolveRunKnobs(input, defaults, allowedBackends), problems: [] };
	} catch (e) {
		if (e instanceof ProblemError) return { knobs: null, problems: e.problems };
		throw e;
	}
}

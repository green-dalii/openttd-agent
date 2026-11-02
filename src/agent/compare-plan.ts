/**
 * Compare plan — "what a comparison would run, before it runs".
 *
 * 职责: 把「我要比较这两个模型、这几个 seed」变成一份**可核对的清单**：
 *   哪些局会跑、每局用什么模型和 seed、封顶怎么设、花费能不能测。
 * 为什么需要它（Issue #48）：Compare 页以前**只能看**已经跑完的局，"发起比较"
 *   只能在 Run 页手敲旋钮 —— 于是"比较"与"发起"分属两个页面，且**跑之前看不到**
 *   会跑几局、花费能不能测。计划区把这件事搬到 Compare 上，并让它**由服务端算**。
 *
 * 铁律:
 *   - **一个事实一个名字**：计划里的字段名与 manifest / preview 同名同义
 *     （model / seed / gameDays / tokenLimit / costLimit / backend /
 *     scaffoldHash / costKnown）。预览 == 跑完的 manifest 可以逐字段比。
 *   - **计划不是承诺**：花费"能不能测"由**每个格子的模型有没有价目表**决定；
 *     没有价目表就是 `not measured`，不是 0，也不是"大概免费"。
 *   - **不预测结果**：计划估的是**运行**（几局、封顶、花费口径），不估模型能打多少分
 *     （那是跑完之后 History / Compare 的事）。
 *   - **非法输入报错并给出下一步**，不静默回退（静默回退会让"我选了 3 个 seed"
 *     变成一场只有 1 个 seed 的比较，而且页面不会知道）。
 *
 * 事实来源: docs/DASHBOARD-CODESIGN.md §4.2；Issue #48。
 * 禁止: 在此做 IO（IO 由调用方注入：模型的解析在 selection.ts）；在此猜价格。
 */

import { previewRunKnobs, type RunBackend, type RunKnobDefaults, type RunKnobInput, type RunKnobs } from "./run-knobs.js";
import { scaffoldHash } from "./scaffold-fingerprint.js";
import { SYSTEM_PROMPT } from "./runtime.js";
import { createTools } from "./tools/index.js";
import type { AgentDeps } from "./types.js";
import type { Problem } from "./problems.js";

/** How many models / seeds a plan may hold (the ceiling is a refusal, not a clamp). */
export const MAX_PLAN_MODELS = 8;
export const MAX_PLAN_SEEDS = 8;

/** What the page sends: the models, the seeds and the knobs every cell shares. */
export interface ComparePlanInput extends RunKnobInput {
	/** The models to compare (names as the ledger spells them). */
	models?: unknown;
	/** The worlds to run on (integers >= 1). */
	seeds?: unknown;
}

/** One run of the matrix: a model on a seed. */
export interface ComparePlanCell {
	/** The model this cell runs. */
	model: string;
	/** The world seed this cell runs on. */
	seed: number;
}

/** The facts about one cell's model, resolved server-side. */
export interface ComparePlanModelFacts {
	/** The provider that will serve the model. */
	providerId: string;
	/** The model id. */
	model: string;
	/** The streaming API the model uses. */
	api: string;
	/** The model's context window. */
	contextWindow: number;
	/** The model's output cap. */
	maxTokens: number;
	/** Whether this model's spend is measurable (it has a price table). */
	costKnown: boolean;
}

/** A cell with its model's facts. */
export interface ComparePlanCellFacts extends ComparePlanCell {
	/** The model's facts (resolved server-side; never guessed by the page). */
	facts: ComparePlanModelFacts;
}

/**
 * The plan: what the comparison would run.
 *
 * `cells` carries the matrix in order; `runCount` is how many runs it starts.
 */
export interface ComparePlan {
	/** Every cell of the matrix, in order (model-major). */
	cells: ComparePlanCellFacts[];
	/** How many runs the plan starts (= cells.length, named for the page). */
	runCount: number;
	/** The episode horizon every cell uses. */
	gameDays: number | null;
	/** The token cap every cell uses. */
	tokenLimit: number | null;
	/** The cost cap every cell uses. */
	costLimit: number | null;
	/** The thinking level every cell uses. */
	thinkingLevel: RunKnobs["thinkingLevel"];
	/** The tool budget every cell uses. */
	toolBudget: number;
	/** The memory arm every cell uses. */
	memoryArm: RunKnobs["memoryArm"];
	/** The scenario every cell uses. */
	scenario: RunKnobs["scenario"];
	/** The backend every cell runs on. */
	backend: RunBackend;
	/** The scaffold fingerprint every cell runs with (same as the manifest's). */
	scaffoldHash: string;
	/**
	 * Whether the plan's **spend** is measurable.
	 *
	 * True only when **every** cell's model has a price table: a plan where one
	 * model is unpriced has an unknown total, and "partly known" is not a number.
	 */
	costKnown: boolean;
	/** Why the plan cannot be built/run (empty when it can). */
	problems: Problem[];
}

function bad(message: string, hint: string): Problem {
	return { code: "invalid_knob", message, hint };
}

/**
 * Parse the models and the seeds of a plan.
 *
 * The lists are **not** silently trimmed: a model list with a blank entry or a
 * seed that is not a whole number is a typo the user must see, because a plan
 * that quietly drops one seed is a plan that compares fewer worlds than the
 * one on screen.
 */
export function parseComparePlan(input: ComparePlanInput): {
	models: string[];
	seeds: number[];
	problems: Problem[];
} {
	const problems: Problem[] = [];

	const rawModels = Array.isArray(input.models) ? input.models : [];
	const models: string[] = [];
	for (const raw of rawModels) {
		const text = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
		if (!text) {
			problems.push(bad("a model name in the plan is empty", "pick the models from the list"));
			continue;
		}
		if (models.includes(text)) {
			problems.push(bad(`the plan names "${text}" twice`, "each model appears once in the plan"));
			continue;
		}
		models.push(text);
	}
	// "No models" is only reported when the user sent **nothing**; an invalid
	// entry is reported once, by its own message.
	if (rawModels.length === 0) {
		problems.push(bad("the plan has no models", "pick at least one model to compare"));
	}
	if (models.length > MAX_PLAN_MODELS) {
		problems.push(
			bad(
				`the plan names ${models.length} models (the limit is ${MAX_PLAN_MODELS})`,
				"compare fewer models per plan, or launch several plans",
			),
		);
	}

	const rawSeeds = Array.isArray(input.seeds) ? input.seeds : [];
	const seeds: number[] = [];
	for (const raw of rawSeeds) {
		const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim();
		if (!/^\d+$/.test(text)) {
			problems.push(
				bad(`the seed "${text}" is not a whole number`, "seeds are whole numbers, e.g. 4242"),
			);
			continue;
		}
		const n = Number(text);
		if (n < 1 || n > 2 ** 31 - 1) {
			problems.push(bad(`the seed ${n} is out of range`, "seeds are between 1 and 2147483647"));
			continue;
		}
		if (seeds.includes(n)) {
			problems.push(bad(`the seed ${n} appears twice`, "each world appears once in the plan"));
			continue;
		}
		seeds.push(n);
	}
	if (rawSeeds.length === 0) {
		problems.push(bad("the plan has no seeds", "add at least one world seed to run on"));
	}
	if (seeds.length > MAX_PLAN_SEEDS) {
		problems.push(
			bad(
				`the plan names ${seeds.length} seeds (the limit is ${MAX_PLAN_SEEDS})`,
				"compare fewer worlds per plan, or launch several plans",
			),
		);
	}

	return { models, seeds, problems };
}

/** The cells of the matrix, in order (model-major: every seed of model 1, then model 2). */
export function planCells(models: string[], seeds: number[]): ComparePlanCell[] {
	const cells: ComparePlanCell[] = [];
	for (const model of models) {
		for (const seed of seeds) cells.push({ model, seed });
	}
	return cells;
}

/**
 * The scaffold fingerprint, computed without a running game.
 *
 * Same probe as the next-run preview (run-preview.ts): the fingerprint covers
 * the prompt and the tools' name/description/schema — static facts — so the
 * plan can promise the same scaffold the run will use.
 */
export function planScaffoldHash(): string {
	const exploding = new Proxy(
		{},
		{
			get(_t, prop) {
				throw new Error(`the scaffold probe must not read the world (${String(prop)})`);
			},
		},
	);
	const deps = exploding as unknown as AgentDeps;
	return scaffoldHash(SYSTEM_PROMPT, createTools(deps) as never);
}

/**
 * The knobs every cell shares.
 *
 * Parsed with the **same** rules the single run uses (run-knobs.ts), so the
 * plan's caps are the caps the run will apply — not a second rule set.
 */
export function planKnobs(
	input: ComparePlanInput,
	defaults: RunKnobDefaults,
	allowedBackends: readonly RunBackend[],
): { knobs: RunKnobs | null; problems: Problem[] } {
	const parsed = previewRunKnobs(input, defaults, allowedBackends);
	return { knobs: parsed.knobs, problems: parsed.problems };
}

/**
 * Assemble the plan from the parsed pieces and the resolved model facts.
 *
 * `factsByModel` carries the server-resolved facts per model. A model that is
 * **not** in the map was not resolved (unknown) — the caller reports it.
 */
export function assembleComparePlan(args: {
	cells: ComparePlanCell[];
	knobs: RunKnobs;
	factsByModel: Map<string, ComparePlanModelFacts>;
	problems?: Problem[];
}): ComparePlan {
	const cells: ComparePlanCellFacts[] = args.cells.map((cell) => ({
		...cell,
		facts: args.factsByModel.get(cell.model) ?? {
			providerId: "",
			model: cell.model,
			api: "",
			contextWindow: 0,
			maxTokens: 0,
			costKnown: false,
		},
	}));
	return {
		cells,
		runCount: cells.length,
		gameDays: args.knobs.gameDays,
		tokenLimit: args.knobs.tokenLimit,
		costLimit: args.knobs.costLimit,
		thinkingLevel: args.knobs.thinkingLevel,
		toolBudget: args.knobs.toolBudget,
		memoryArm: args.knobs.memoryArm,
		scenario: args.knobs.scenario,
		backend: args.knobs.backend,
		scaffoldHash: planScaffoldHash(),
		// "Partly known" is not a number: the plan's spend is measurable only
		// when **every** cell's model is priced.
		costKnown: cells.length > 0 && cells.every((c) => c.facts.costKnown),
		problems: args.problems ?? [],
	};
}

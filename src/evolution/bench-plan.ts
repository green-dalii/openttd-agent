/**
 * Benchmark matrix planner (D5a) — turn a model list into isolated cells.
 *
 * 职责: 把"比较几个模型"变成一张**可执行、可审计、不污染**的局清单。
 * 为什么存在: 基准评测最容易犯的错不是统计，而是**格与格之间互相污染**（共用
 *   data dir ⇒ 一个模型的记忆流进下一个）与**世界不一致**（不同 seed/场景却
 *   当成同一题）。这里把两条都变成**结构性保证**，不是纪律。
 * 铁律:
 *   - 每格独立 data dir（目录名对模型/seed/重复可辨，便于人工回看）。
 *   - 世界参数逐字相同：同 scenario / horizon / startYear / mapSize / seed 组。
 *   - 样本量不足声明效应时**跑前拒绝**（复用 P2-3 的 requiredSampleSize）。
 * 禁止: IO、启动进程、读配置——这里是纯规划，执行在 scripts/bench.ts。
 */

import { requiredSampleSize } from "./metrics.js";

/** The world every cell of one matrix shares. */
export interface BenchWorld {
	scenario: "freeform" | "prebuilt";
	horizonDays: number;
	startYear: number;
	mapSize: [number, number];
}

export interface BenchPlanInput {
	/** Model ids (as the pi-ai provider expects them). */
	models: string[];
	/** Map seeds; every model runs every seed (pairing needs that). */
	seeds: number[];
	/** Runs per (model, seed) - repeats estimate within-cell variance. */
	repeats: number;
	world: BenchWorld;
	/** Root directory for the per-cell data dirs. */
	root: string;
	/**
	 * Pre-registration (P2-3): declared effect and assumed CV. When present and
	 * the plan cannot reach the required n, planning REFUSES - before any run.
	 */
	power?: { effectSize: number; cv: number };
}

/** One run in the matrix. */
export interface BenchCell {
	model: string;
	seed: number;
	/** 1-based repeat index within (model, seed). */
	repeat: number;
	/** This cell's own data dir: memory can never cross cells. */
	dataDir: string;
	world: BenchWorld;
}

export interface BenchPlan {
	cells: BenchCell[];
	/** True when a power declaration was supplied (see `power`). */
	preRegistered: boolean;
	/** Runs per model - the n a power calculation applies to. */
	runsPerModel: number;
	/** The declaration that was checked, when one was given. */
	power?: { effectSize: number; cv: number; requiredPerArm: number };
}

/** Filesystem-safe model label (models can carry slashes: "openai/gpt-x"). */
function slug(model: string): string {
	return model.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * Plan the matrix.
 *
 * Throws when the plan is not worth running: no models, no repeats, or a
 * sample too small to detect the declared effect.
 */
export function planMatrix(input: BenchPlanInput): BenchPlan {
	const models = [...new Set((input.models ?? []).map((m) => String(m).trim()).filter((m) => m !== ""))];
	if (models.length === 0) throw new Error("planMatrix: no model given - a matrix needs at least one model");
	if (!Number.isInteger(input.repeats) || input.repeats < 1) {
		throw new Error(`planMatrix: repeats must be an integer >= 1 (got ${input.repeats})`);
	}
	const seeds = [...new Set((input.seeds ?? []).filter((s) => Number.isInteger(s)))];
	if (seeds.length === 0) throw new Error("planMatrix: no seed given - every cell must name the world it runs");

	const runsPerModel = seeds.length * input.repeats;
	let power: BenchPlan["power"];
	if (input.power) {
		const requiredPerArm = requiredSampleSize(input.power.cv, input.power.effectSize);
		if (!(runsPerModel >= requiredPerArm)) {
			throw new Error(
				`planMatrix: under-powered - this matrix gives ${runsPerModel} run(s) per model, but detecting ` +
					`+${Math.round(input.power.effectSize * 100)}% at CV ${Math.round(input.power.cv * 100)}% needs ` +
					`${requiredPerArm}. Pre-registered rule: refuse, do not report a p-value.`,
			);
		}
		power = { ...input.power, requiredPerArm };
	}

	const cells: BenchCell[] = [];
	for (const model of models) {
		for (const seed of seeds) {
			for (let repeat = 1; repeat <= input.repeats; repeat++) {
				cells.push({
					model,
					seed,
					repeat,
					// Model / seed / repeat are all in the path: a directory name is
					// the only thing a human has when auditing a disputed number.
					dataDir: `${input.root.replace(/\/+$/, "")}/${slug(model)}/seed-${seed}/rep-${repeat}`,
					world: { ...input.world, mapSize: [...input.world.mapSize] as [number, number] },
				});
			}
		}
	}

	return { cells, preRegistered: input.power !== undefined, runsPerModel, ...(power ? { power } : {}) };
}

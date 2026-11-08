/**
 * Benchmark report (D5b) — the human-readable half of the scorecard.
 *
 * 职责: 把分数卡渲染成可读的 Markdown，让"这个模型测得怎样"能被人看懂、被引用。
 * 为什么存在: 机器可读的 JSON 进不了评审会；而人读报告最容易骗人的地方是
 *   **数字不带 n、条件、排除数**。这里强制每个数字旁边都有它的样本量与测量条件。
 * 铁律: 缺失写 "not measured"（不写 0、不留空）；被排除的局写在表下方。
 * 禁止: 评语（"更好/更差"）——只陈述数字与其条件。
 */

import type { ModelCard, Scorecard } from "./scorecard.js";
import type { PairedComparison } from "./bench-stats.js";

/** Format a number or say plainly that it was not measured. */
function num(v: number | null, digits = 2): string {
	return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "not measured";
}

function pct(v: number | null): string {
	return typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "not measured";
}

/** Render the scorecard as Markdown. Never empty: an empty card says so. */
export function renderReportMarkdown(
	card: Scorecard,
	generatedAt = new Date(),
	comparisons: PairedComparison[] = [],
): string {
	const c = card.conditions;
	const lines: string[] = [];
	lines.push("# Benchmark report");
	lines.push("");
	lines.push(`Generated: ${generatedAt.toISOString()}`);
	lines.push("");
	lines.push("## Measurement conditions");
	lines.push("");
	lines.push(`- scenario: ${c.scenario ?? "not recorded"}`);
	lines.push(`- horizon: ${c.horizonDays === null ? "not recorded" : `${c.horizonDays} game days`}`);
	lines.push(`- seeds: ${c.seeds.length > 0 ? c.seeds.join(", ") : "not recorded"}`);
	lines.push(`- repeats per (model, seed): ${c.repeats > 0 ? c.repeats : "not recorded"}`);
	lines.push("");

	if (card.models.length === 0) {
		lines.push("## Models");
		lines.push("");
		lines.push("No model has any run yet - nothing to report.");
		return `${lines.join("\n")}\n`;
	}

	// ---- ability + efficiency ----
	lines.push("## Ability and efficiency");
	lines.push("");
	// 表头写清「交付」到底算什么（服务端措辞）：admin 的计数含客运，
	// 只写 "delivered" 会让人以为是纯货物吨数（SPEC §10.65）。
	lines.push(
		`| model | runs | ${card.models[0]?.ability.measure ?? "delivered"}/game-day (mean) | (median) | stations | vehicles | ` +
			`${card.models[0]?.efficiency.measure ?? "delivered"} per 1M tokens | tokens/decision | s/run |`,
	);
	lines.push("|---|---|---|---|---|---|---|---|---|");
	for (const m of card.models) {
		lines.push(
			`| ${m.model}${requestedNote(m)} | ${m.runs} | ${num(m.ability.mean)} | ${num(m.ability.median)} | ${num(m.ability.stations, 1)} | ` +
				`${num(m.ability.vehicles, 1)} | ${num(m.efficiency.deliveredPerMillionTokens, 0)} | ` +
				`${num(m.efficiency.tokensPerDecision, 0)} | ${num(m.efficiency.secondsPerRun, 0)} |`,
		);
	}
	lines.push("");

	// ---- stability ----
	lines.push("## Stability");
	lines.push("");
	lines.push("| model | tool failure rate | GS errors/run | outcome classes |");
	lines.push("|---|---|---|---|");
	for (const m of card.models) {
		lines.push(
			`| ${m.model} | ${pct(m.stability.toolFailureRate)} | ${num(m.stability.gsErrorsPerRun)} | ${outcomeText(m)} |`,
		);
	}
	lines.push("");

	// ---- growth ----
	lines.push("## Growth (within-model trend)");
	lines.push("");
	for (const m of card.models) {
		lines.push(`- **${m.model}**: ${m.growth.verdict} - ${m.growth.message}`);
	}
	lines.push("");

	// ---- paired comparison (per axis) ----
	//
	// Every axis that can be compared pair by pair gets a row: what is compared,
	// in what unit, the verdict and n. The reader has to be able to see WHICH
	// question was answered - "the numbers differ" without the axis is not a
	// result (Issue #87).
	lines.push("## Paired comparison");
	lines.push("");
	if (comparisons.length === 0) {
		lines.push("No paired comparison in this report (it needs two models on the same seeds).");
		lines.push("");
	} else {
		const pairs = new Map<string, PairedComparison[]>();
		for (const c of comparisons) {
			const key = `${c.modelA} vs ${c.modelB}`;
			const list = pairs.get(key);
			if (list) list.push(c);
			else pairs.set(key, [c]);
		}
		for (const [key, list] of pairs) {
			lines.push(`### ${key}`);
			lines.push("");
			lines.push("Design: paired (same seed, same repeat).");
			lines.push("");
			lines.push("| axis | what is compared | better | verdict | pairs | mean difference | 95% CI |");
			lines.push("|---|---|---|---|---|---|---|");
			for (const c of list) {
				const ci = c.diffCi95 ? `[${c.diffCi95[0].toFixed(2)}, ${c.diffCi95[1].toFixed(2)}]` : "not measured";
				const better =
					c.betterModel === null
						? c.betterWhen === null
							? "no quality"
							: "not determinable"
						: `${c.betterModel} (${c.betterWhen} is better)`;
				lines.push(
					`| ${c.axisLabel} | ${c.label} (${c.unit}) | ${better} | ${c.verdict} | n=${c.pairs.length} | ` +
						`${c.meanDiff === null ? "not measured" : c.meanDiff.toFixed(3)} | ${ci} |`,
				);
			}
			lines.push("");
		}
		lines.push(
			"\"not determinable\" means the interval cannot decide (too few pairs, or it contains 0) - " +
				"it is not a statement that the two models are equal. \"no quality\" marks a metric that " +
				"carries no better/worse (more stations is not automatically better).",
		);
		lines.push("");
	}

	// ---- exclusions ----
	const excluded = card.models.filter((m) => m.excluded > 0);
	if (excluded.length > 0) {
		lines.push("## Runs left out of the numbers above");
		lines.push("");
		for (const m of excluded) {
			const reasons = [...new Set(m.excludedReasons)].map((r) => `${r} x${m.excludedReasons.filter((x) => x === r).length}`);
			lines.push(`- ${m.model}: ${m.excluded} run(s) - ${reasons.join("; ")}`);
		}
		lines.push("");
	}

	lines.push("---");
	lines.push("");
	lines.push(
		"Every number above is computed only from comparable runs (see the exclusions). " +
			"Values that were not measured are written as \"not measured\" rather than zero.",
	);
	return `${lines.join("\n")}\n`;
}

/**
 * Show the requested ids when they differ from what served the runs.
 *
 * A gateway can answer with another model; merging two requested models into
 * one served model is correct, but doing it silently would misrepresent the
 * benchmark (and the pairing would look like "two models, no pairs").
 */
function requestedNote(m: ModelCard): string {
	const others = m.requestedModels.filter((r) => r !== m.model);
	return others.length === 0 ? "" : ` (requested: ${others.join(", ")})`;
}

function outcomeText(m: ModelCard): string {
	const entries = Object.entries(m.stability.outcomes);
	if (entries.length === 0) return "not recorded";
	return entries.map(([k, v]) => `${k} x${v}`).join(", ");
}

/**
 * Print the M3 A/B verdict for a data directory.
 *
 * 职责: 读一个 dataDir 的 evolution 账本，打印两臂对比（服务端规则，不在别处重算）。
 * 禁止: 在这里实现任何比较规则 —— 规则唯一实现在 `src/evolution/metrics.ts`
 *   （`compareArms`），本脚本只是把它打出来。
 *
 * 用法:
 *   pnpm exec tsx scripts/m3-verdict.ts /tmp/m3b
 *
 * 为什么要有这个脚本（2026-09-12）:
 * ROADMAP 里原本写的是 `pnpm exec tsx -e '...'` 单行命令 —— **它不工作**：
 * `tsx -e` 在 eval 模式下解析不了带 `.js` 后缀的 ESM import
 * （`Cannot find module './src/evolution/web-view.js'`）。
 * 收尾时实测过。交接文档里的命令必须是**跑得通**的，所以落成文件。
 */
import { evolutionView, type EvolutionView } from "../src/evolution/web-view.js";
import { degradationStats, deliveredOutcome, formatMetricStat, powerVerdict, learningCurve, experienceOutcomes } from "../src/evolution/metrics.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { reflectionStats } from "../src/evolution/reflection-stats.js";

const dataDir = process.argv[2];
if (!dataDir) {
	console.error("usage: tsx scripts/m3-verdict.ts <dataDir>");
	process.exit(2);
}

const view: EvolutionView = evolutionView(dataDir);
const { arms, metrics } = view;

console.log(`dataDir : ${dataDir}`);
// 被 agent 自己按停在世界里的局**不参与 A/B**（SPEC §10.101），但必须报出来：
// 一个实验里悄悄少了几局、而报告没写，是最容易被误读成"结果更干净"的情况。
const blocked = metrics.filter((m) => m.blockedByPause === true);
// W2（SPEC §10.102）：世界冻住的局同样不进 A/B，但原因**不同**（没有人停它），
// 所以分开报：两个数字合并成一个，读者就分不清"被停掉"与"世界不动了"。
const frozen = metrics.filter((m) => m.worldFrozen === true);
const exclusions = [
  blocked.length ? `${blocked.length} ended while paused (stopped by someone)` : "",
  frozen.length ? `${frozen.length} ended with the world frozen` : "",
].filter(Boolean);
console.log(
  `runs    : ${metrics.length} recorded${exclusions.length ? ` (${exclusions.join("; ")} — excluded from A/B)` : ""}`,
);
console.log("");
console.log(`verdict : ${arms.conclusive ? "CONCLUSIVE" : "not enough data"}`);
console.log(`note    : ${arms.note || "(none)"}`);
console.log("");
const fmt = (label: string, a: typeof arms.withLessons) =>
	console.log(
		`${label.padEnd(14)} n=${a.count}  money=${a.meanMoney ?? "—"}  tokens=${a.meanTokens ?? "—"}  ` +
			`built=${a.builtRate ?? "—"}  stations=${a.meanStations?.toFixed(2) ?? "—"}  ` +
			`income=${a.meanIncome?.toFixed(0) ?? "—"}(n=${a.incomeReported})  ` +
			`delivered=${a.meanDelivered?.toFixed(0) ?? "—"}(n=${a.deliveredReported})`,
	);
fmt("with lessons", arms.withLessons);
fmt("without", arms.withoutLessons);
console.log("");
if (arms.treatmentWithoutInjection > 0) {
	console.log(
		`WARNING       : ${arms.treatmentWithoutInjection} treatment run(s) received NO memory (intervention did not arrive)`,
	);
}
console.log(`money delta   : ${arms.moneyDelta ?? "—"}`);
console.log(`income delta  : ${arms.incomeDelta?.toFixed(0) ?? "—"}`);
// 降级披露（SPEC §10.66 + R1）：GS 通道错误与工具封顶都会让本局的数字
// 来自一个被削弱的 agent，必须在任何收益主张之前打印。规则唯一实现在
// src/evolution/metrics.ts（曾经这里把 ArmSummary 当账本行用，
// 于是这行永远显示 "not reported" —— 见 metrics.ts 的注释）。
{
	const rowsOf = (arm: string) => view.metrics.filter((m) => m.arm === arm);
	const wit = degradationStats(rowsOf("treatment"));
	const wit_out = degradationStats(rowsOf("control"));
	console.log(
		`channel health (GS errors/run): with-memory ${formatMetricStat(wit.gsErrors)}  ` +
			`without ${formatMetricStat(wit_out.gsErrors)}  ` +
			`(>0 means the agent ran with a partially broken GS channel - SPEC §10.66)`,
	);
	console.log(
		`tool budget (refusals/run): with-memory ${formatMetricStat(wit.toolBudgetBlocks)}  ` +
			`without ${formatMetricStat(wit_out.toolBudgetBlocks)}  ` +
			`(>0 means the agent hit its per-decision ceiling - R1)`,
	);
	// G6：单次请求峰值 = "离模型上下文窗口还有多远"的事实（累计 token 回答不了）。
	// 两者都为 not reported 说明没有任何一局量到过（旧记录也算未测量）。
	console.log(
		`peak request tokens: with-memory ${formatMetricStat(wit.peakRequestTokens)}  ` +
			`without ${formatMetricStat(wit_out.peakRequestTokens)}  ` +
			`(G6 - decides whether context compaction is needed at all)`,
	);
	// P2-3 统计预登记：n 够不够检出**声明的**效应量？不够 → 拒绝比较。
	// 声明效应量 = argv[3]（默认 +20%，预登记值）；事后改口径就是把预登记废掉。
	{
		const effect = Number(process.argv[3] ?? 0.2);
		const vals = view.metrics
			.map((m) => Number(m.deliveredRun))
			.filter((v) => Number.isFinite(v));
		const nPerArm = Math.min(
			view.metrics.filter((m) => m.arm === "treatment").length,
			view.metrics.filter((m) => m.arm === "control").length,
		);
		const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
		const sd = vals.length
			? Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length)
			: 0;
		const cv = mean !== 0 ? Math.abs(sd / mean) : null;
		const v = powerVerdict({ declaredEffect: Number.isFinite(effect) ? effect : null, observedCv: cv, actualN: nPerArm });
		console.log(`power: ${v.message}`);
		if (v.detectable === false) process.exitCode = 1;
	}
	// P2-2 M5：学习曲线（预登记检验——CI 含 0 = 「该设计下不可判定」）。
	// 局按 startedAt 排序，deliveredRun 对局序号。
	{
		const ordered = [...view.metrics]
			.filter((m) => Number.isFinite(Number(m.deliveredRun)) && m.blockedByPause !== true)
			.sort((a, b) => Number(a.startedAt ?? 0) - Number(b.startedAt ?? 0));
		const curve = learningCurve(ordered.map((m, i) => ({ index: i, delivered: Number(m.deliveredRun) })));
		console.log(
			`learning curve (M5): n=${curve.n} spearman=${curve.spearman?.toFixed(2) ?? "—"} ` +
				`slope=${curve.slopePerRun?.toFixed(2) ?? "—"}/run -> ${curve.verdict}`,
		);
		console.log(`  ${curve.message}`);
	}
	// P2-2 M4b：哪条经验被用过、用过它的局的成绩分布（**观测性**，不做因果主张）。
	// 数据源：audit 的 recall 记录（ids）× 该局结果（时间窗 join）。
	{
		const auditPath = join(dataDir, "agent-audit.jsonl");
		if (existsSync(auditPath)) {
			type RecallHit = { ts: number; ids: string[] };
			const hits: RecallHit[] = [];
			for (const line of readFileSync(auditPath, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const rec = JSON.parse(line);
					if (rec.type === "recall" && Array.isArray(rec.ids) && rec.ids.length) {
						hits.push({ ts: Number(rec.ts) || 0, ids: rec.ids.map(String) });
					}
				} catch {
					/* 行损坏不致命（观测性数据） */
				}
			}
			const rows = view.metrics;
			const runs = rows.map((m) => {
				const start = Number(m.startedAt ?? 0);
				const end = start + Number(m.durationMs ?? 0);
				const ids = new Set<string>();
				for (const h of hits) {
					if (h.ts >= start && (end === 0 || h.ts <= end)) for (const id of h.ids) ids.add(id);
				}
				return {
					runId: String(m.id ?? start),
					recalledIds: [...ids],
					outcome: Number.isFinite(Number(m.deliveredRun)) ? Number(m.deliveredRun) : null,
				};
			});
			const dist = experienceOutcomes(runs);
			if (dist.length === 0) {
				console.log("experience use (M4b): no recall recorded - nothing was ever retrieved.");
			} else {
				console.log(`experience use (M4b): ${dist.length} experience(s) recalled at least once (observational, not causal):`);
				for (const x of dist.slice(0, 12)) {
					console.log(
						`  ${x.experienceId}: used in ${x.runs} run(s), delivered mean ${x.mean ?? "—"} median ${x.median ?? "—"}`,
					);
				}
			}
		} else {
			console.log("experience use (M4b): no audit file - usage not measurable in this data dir.");
		}
	}
	// G7：判据能不能动，必须先于"有无效果"的主张（SPEC §10.85）。
	{
		const dep = deliveredOutcome(view.metrics);
		if (dep.degenerate) {
			console.log(
				`!! OUTCOME IS CONSTANT: ${dep.measured} of ${view.metrics.length} run(s) measured, ` +
					`none delivered anything -> this comparison cannot detect an effect (SPEC §10.85).`,
			);
		}
	}
	// M1：反思的产出率（0 调用的局 = 协议/接线信号，不是"没什么可学"）
	const refl = reflectionStats(dataDir);
	console.log(
		`reflection: ${refl.runs} run(s) recorded (${refl.failedRuns} failed), ` +
			`zero-tool-call runs ${refl.zeroCallRuns}, retried ${refl.runsWithRetry}  ` +
			`tool calls/run ${formatMetricStat(refl.toolCalls)}  ` +
			`observations/run ${formatMetricStat(refl.lessonsSaved)}`,
	);
	// 两种成因分开报：协议/接线信号 ≠ 基础设施故障（曾把后者报成前者）
	if (refl.failedRuns > 0) {
		console.log(
			`WARNING: ${refl.failedRuns} reflection run(s) FAILED before recording anything` +
				(refl.firstError ? ` (first: ${refl.firstError})` : "") +
				" - that is an infrastructure signal, not a protocol one.",
		);
	}
	if (refl.zeroCallRuns > 0) {
		console.log(
			"WARNING: at least one run's reflection called NO recording tool - that is a " +
				"protocol/wiring signal, not 'nothing to record' (see M1 / SPEC §10.78).",
		);
	}
}

console.log(
	`delivered delta: ${arms.deliveredDelta?.toFixed(0) ?? "—"}  (least confounded outcome)  ` +
		`source=${arms.deliveredSource === "run" ? "deliveredRun (integrated past the quarterly reset)" : "delivered (RAW partial-quarter counter - not comparable)"}`,
);
console.log("");
console.log("Reminder: rules live in src/evolution/metrics.ts (compareArms).");
console.log("Interrupted runs are excluded by design - their outcome is the");
console.log("operator pressing Ctrl-C, not the agent's result.");

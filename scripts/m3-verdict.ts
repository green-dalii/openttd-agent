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
import { degradationStats, formatMetricStat } from "../src/evolution/metrics.js";
import { reflectionStats } from "../src/evolution/reflection-stats.js";

const dataDir = process.argv[2];
if (!dataDir) {
	console.error("usage: tsx scripts/m3-verdict.ts <dataDir>");
	process.exit(2);
}

const view: EvolutionView = evolutionView(dataDir);
const { arms, metrics } = view;

console.log(`dataDir : ${dataDir}`);
console.log(`runs    : ${metrics.length} recorded`);
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

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
// Channel health (SPEC §10.66): a partially broken GS channel degrades per run
// and hides inside the comparison. Print it before any benefit claim.
{
	const health = (rows: typeof arms.withLessons[]) =>
		rows.map((m) => m.gsErrors).filter((v): v is number => typeof v === "number");
	const hw = health([arms.withLessons]);
	const hc = health([arms.withoutLessons]);
	const worst = (l: number[]) => (l.length ? Math.max(...l) : null);
	const fmtH = (l: number[]) =>
		l.length ? `n=${l.length} max=${worst(l)} total=${l.reduce((a, b) => a + b, 0)}` : "not reported";
	console.log(
		`channel health (GS errors/run): with-memory ${fmtH(hw)}  without ${fmtH(hc)}  ` +
			`(>0 means the agent ran with a partially broken GS channel - SPEC §10.66)`,
	);
}

console.log(
	`delivered delta: ${arms.deliveredDelta?.toFixed(0) ?? "—"}  (least confounded outcome)  ` +
		`source=${arms.deliveredSource === "run" ? "deliveredRun (integrated past the quarterly reset)" : "delivered (RAW partial-quarter counter - not comparable)"}`,
);
console.log("");
console.log("Reminder: rules live in src/evolution/metrics.ts (compareArms).");
console.log("Interrupted runs are excluded by design - their outcome is the");
console.log("operator pressing Ctrl-C, not the agent's result.");

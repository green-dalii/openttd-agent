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
			`income=${a.meanIncome?.toFixed(0) ?? "—"}(n=${a.incomeReported})`,
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
console.log("");
console.log("Reminder: rules live in src/evolution/metrics.ts (compareArms).");
console.log("Interrupted runs are excluded by design - their outcome is the");
console.log("operator pressing Ctrl-C, not the agent's result.");

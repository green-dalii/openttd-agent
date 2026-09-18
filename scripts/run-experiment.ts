/**
 * Experiment matrix runner (Phase C-3).
 *
 * 职责: 把"M3 A/B"从手写 bash 循环变成一条命令：control 臂（--no-memory）与
 *   treatment 臂各跑 n 局，然后复用服务端规则（compareArms，src/evolution/metrics.ts）
 *   打印判定 —— 含 C-3 的 token/决策归一守卫。
 * 禁止: 在这里实现比较规则（唯一实现在 metrics.ts）；不自动清理 dataDir 之外的东西。
 *
 * 用法（实测模板）:
 *   pnpm exec tsx scripts/run-experiment.ts --dir /tmp/m3d --n 3 --demo-seconds 200 --seed 7
 *
 * 前置: <dir>/credentials.json + llm.json 已就位（复制自 /tmp/openttd-agent-data）。
 * 本脚本不做 preflight —— 它就是研究者自己跑的，失败会显式报错。
 */
import { spawnSync } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { evolutionView } from "../src/evolution/web-view.js";

interface Args {
	dir: string;
	n: number;
	seconds: number;
	/** Simulated horizon in game days (G1); undefined = wall-clock only. */
	gameDays?: number;
	/** S1/G4 scenario; both arms MUST use the same one (comparability). */
	scenario?: "freeform" | "prebuilt";
	seed: number;
}

function parseArgs(argv: string[]): Args {
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const dir = get("--dir");
	if (!dir) {
		console.error(
		"usage: tsx scripts/run-experiment.ts --dir <dataDir> [--n 3] (--game-days 400 | --demo-seconds 900) [--scenario freeform|prebuilt] [--seed 7] [--vary memory|freeze]",
	);
		process.exit(2);
	}
	if (!existsSync(join(dir, "credentials.json")) || !existsSync(join(dir, "llm.json"))) {
		console.error(`ERROR: ${dir} must contain credentials.json and llm.json (copy from the provider setup dir).`);
		process.exit(2);
	}
	return {
		dir,
		n: Number(get("--n") ?? 3),
		// G1 (SPEC §10.68): prefer a SIMULATED horizon. `--demo-seconds` stays as
		// the wall-clock safety cap so a stalled world cannot hang the round.
		gameDays: get("--game-days") ? Number(get("--game-days")) : undefined,
		seconds: Number(get("--demo-seconds") ?? 900),
		scenario: (get("--scenario") ?? undefined) as "freeform" | "prebuilt" | undefined,
		seed: Number(get("--seed") ?? 7),
		// 自变量（2026-09-17）：memory = 记忆注入（默认）；freeze = 决策期冻结世界。
		// 两个臂必须只差这一个变量，否则比较又在撒谎。
		vary: (get("--vary") ?? "memory") as "memory" | "freeze",
	};
}


/**
 * 两臂的额外 CLI 参数。**唯一的区别必须只有自变量本身**（MEMORY D4）：
 *   memory: treatment = 注入记忆；control = --no-memory
 *   freeze: treatment = --freeze（决策期冻结世界）；control = 不冻结，且两臂
 *           都 --no-memory（记忆不是本轮的自变量，必须钉住）
 */
function controlFlags(_vary: "memory" | "freeze"): string[] {
	// control 永远不注入记忆；freeze 轮里它也钉住不冻结。
	return ["--no-memory"];
}
function treatmentFlags(vary: "memory" | "freeze"): string[] {
	// freeze 轮：两臂都 --no-memory（记忆不是本轮自变量），只差冻结。
	return vary === "freeze" ? ["--no-memory", "--freeze"] : [];
}

function runOne(
	label: string,
	dir: string,
	seed: number,
	seconds: number,
	gameDays: number | undefined,
	scenario: "freeform" | "prebuilt" | undefined,
	extra: string[],
): number {
	console.log(`### ${label} start ${new Date().toISOString()}`);
	// Per-run log files: the A/B verdict needs post-mortem access to each run's
	// stdout (reflection lines, RESULT, executor phases). inherit-only loses
	// them to the terminal scrollback (m3e lesson).
	const fd = openSync(join(dir, `${label}.log`), "a");
	const r = spawnSync("pnpm", ["run", "cli", "--agent", `--seed`, String(seed), "--demo-seconds", String(seconds),
		...(gameDays ? ["--game-days", String(gameDays)] : []),
		...(scenario ? ["--scenario", scenario] : []), ...extra], {
		stdio: ["ignore", fd, fd],
		env: { ...process.env, OPENTTD_DATA_DIR: dir },
	});
	const code = r.status ?? -1;
	console.log(`### ${label} done rc=${code}`);
	return code;
}

const args = parseArgs(process.argv.slice(2));
const codes: Record<string, number[]> = { control: [], treatment: [] };
for (let i = 1; i <= args.n; i++) {
	// cleanup between runs: the game must die or the next one can't bind the port
	spawnSync("pkill", ["-f", "OpenTTD.app/Contents/MacOS/openttd"]);
	spawnSync("sleep", ["2"]);
	codes.control.push(
		runOne(`ctl${i}`, args.dir, args.seed, args.seconds, args.gameDays, args.scenario, controlFlags(args.vary)),
	);
	spawnSync("pkill", ["-f", "OpenTTD.app/Contents/MacOS/openttd"]);
	spawnSync("sleep", ["2"]);
	codes.treatment.push(
		runOne(
			`trt${i}`,
			args.dir,
			args.seed,
			args.seconds,
			args.gameDays,
			args.scenario,
			treatmentFlags(args.vary),
		),
	);
}
spawnSync("pkill", ["-f", "OpenTTD.app/Contents/MacOS/openttd"]);

const view = evolutionView(args.dir, args.vary);
console.log("");
console.log(`=== verdict (${args.dir}) ===`);
console.log(
	`vary: ${args.vary}  (${
		args.vary === "freeze"
			? "treatment = frozen decisions; control = snapshots only; BOTH --no-memory"
			: "treatment = memory injected; control = --no-memory"
	})`,
);
console.log(`runs: ${view.metrics.length}  conclusive: ${view.arms.conclusive}`);
console.log(`note: ${view.arms.note || "(none)"}`);
const fmt = (label: string, a: typeof view.arms.withLessons) =>
	console.log(
		`${label.padEnd(12)} n=${a.count} money=${a.meanMoney?.toFixed(0) ?? "—"} ` +
			`tokens=${a.meanTokens?.toFixed(0) ?? "—"} tok/dec=${a.tokensPerDecision?.toFixed(0) ?? "—"} ` +
			`built=${a.builtRate?.toFixed(2) ?? "—"} stations=${a.meanStations?.toFixed(2) ?? "—"} ` +
			`income=${a.meanIncome?.toFixed(0) ?? "—"}(n=${a.incomeReported}) ` +
			`delivered=${a.meanDelivered?.toFixed(0) ?? "—"}(n=${a.deliveredReported}) ` +
			`med=${a.medianDelivered ?? "—"} zero=${fmtRate(a.zeroDeliveredRate)} ` +
			// 障碍率 = 非零局占比，DGP 的参数本体（力量模拟里最有力量的那个）
			`deliveryRate=${fmtRate(a.deliveryRate)}`,
	);
const armLabel = args.vary === "freeze" ? ["frozen", "not frozen"] : ["with lessons", "without"];
const fmtRate = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
fmt(armLabel[0]!, view.arms.withLessons);
fmt(armLabel[1]!, view.arms.withoutLessons);
if (view.arms.treatmentWithoutInjection > 0) {
	console.log(
		`WARNING: ${view.arms.treatmentWithoutInjection} treatment run(s) received NO memory at all` +
			" - the intervention did not arrive (fresh data dir?), so those runs dilute the arm.",
	);
}
console.log(
	`hurdle stats: Fisher p=${view.arms.deliveryPValue?.toFixed(4) ?? "—"} ` +
		`MannWhitney p=${view.arms.mannWhitneyPValue?.toFixed(4) ?? "—"} ` +
		`meanDiff 95%CI=[${view.arms.meanDiffCi ? `${view.arms.meanDiffCi[0].toFixed(1)}, ${view.arms.meanDiffCi[1].toFixed(1)}` : "—"}]`,
);
console.log(
	`delivered conclusion: ${
		view.arms.deliveredConclusive ? "DECIDABLE (both arms at sample floor)" : "not decidable (sample below floor)"
	}`,
);
if (view.arms.deliveredNote) console.log(`NOTE: ${view.arms.deliveredNote}`);
console.log(
	`money delta: ${view.arms.moneyDelta?.toFixed(0) ?? "—"}` +
		// N2-4: money is spending-dominated (building costs money), so the flow
		// metric is the one that can say whether the lines earn anything.
		`  income delta: ${view.arms.incomeDelta?.toFixed(0) ?? "—"}` +
		`  delivered delta: ${view.arms.deliveredDelta?.toFixed(0) ?? "—"}`,
);
console.log(`exit codes: control=${codes.control.join(",")} treatment=${codes.treatment.join(",")}`);
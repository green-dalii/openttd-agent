/**
 * Benchmark matrix runner (D5a/D5b/D5c).
 *
 * 职责: 一条命令跑完"模型 × seed × 重复"的矩阵，每格独立 data dir，然后产出
 *   机器可读 JSON 与人读 Markdown 报告（分数卡四轴 + 配对比较）。
 * 为什么与 `run-experiment.ts` 分开: 那个脚本测的是**一个变量**（记忆/冻结）的两臂；
 *   这里测的是**多个模型**在同一世界上的能力，切分方式、记录与报告都不一样。
 * 铁律（都在纯函数里，有单测）:
 *   - 每格独立目录（`planMatrix`）；世界逐字相同；
 *   - 功效不足**跑前拒绝**（`planMatrix` 的预登记闸）；
 *   - 每个数字都带 n 与测量条件（`buildScorecard` / `renderReportMarkdown`）；
 *   - 缺失写 "not measured"，不写 0。
 * 禁止: 在此实现统计规则（唯一实现在 `src/evolution/`）；不清理 root 之外的东西。
 *
 * 用法（先 dry-run 看矩阵，再真跑）:
 *   pnpm exec tsx scripts/bench.ts --root /tmp/bench --models m-a,m-b --seeds 11,22 \
 *     --repeats 3 --game-days 300 --scenario prebuilt --dry-run
 *   pnpm exec tsx scripts/bench.ts --root /tmp/bench ... --effect 0.5 --cv 1
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planMatrix, type BenchWorld } from "../src/evolution/bench-plan.js";
import { buildScorecard, type BenchConditions } from "../src/evolution/scorecard.js";
import { renderReportMarkdown } from "../src/evolution/bench-report.js";
import { pairedComparison } from "../src/evolution/bench-stats.js";
import { readMetrics } from "../src/evolution/store.js";
import type { GameMetric } from "../src/evolution/metrics.js";

interface Args {
	root: string;
	models: string[];
	seeds: number[];
	repeats: number;
	gameDays: number;
	scenario: "freeform" | "prebuilt";
	startYear: number;
	mapSize: [number, number];
	dryRun: boolean;
	/** Optional pre-registration (P2-3): refuse an under-powered matrix. */
	effect?: number;
	cv?: number;
	/** Seconds per run (wall-clock cap); 0 = none. */
	seconds: number;
}

const USAGE = `usage: tsx scripts/bench.ts --root <dir> --models a,b --seeds 11,22 [--repeats 3]
  [--game-days 300] [--scenario prebuilt|freeform] [--start-year 1950] [--map 256x256]
  [--seconds 900] [--effect 0.5 --cv 1] [--dry-run]

  Every (model, seed, repeat) cell gets its own data dir under <root>, so memory
  never crosses cells. --effect/--cv pre-register the comparison: an
  under-powered matrix is refused before any run starts.`;

function parseArgs(argv: string[]): Args {
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
	};
	const has = (flag: string): boolean => argv.includes(flag);
	const list = (flag: string): string[] =>
		(get(flag) ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	const map = (get("--map") ?? "256x256").toLowerCase().split("x");
	return {
		root: get("--root") ?? "",
		models: list("--models"),
		seeds: list("--seeds").map((s) => Number(s)).filter((n) => Number.isInteger(n)),
		repeats: Number(get("--repeats") ?? 1),
		gameDays: Number(get("--game-days") ?? 300),
		scenario: (get("--scenario") ?? "prebuilt") === "freeform" ? "freeform" : "prebuilt",
		startYear: Number(get("--start-year") ?? 1950),
		mapSize: [Number(map[0] ?? 256), Number(map[1] ?? 256)],
		dryRun: has("--dry-run"),
		...(get("--effect") !== undefined ? { effect: Number(get("--effect")) } : {}),
		...(get("--cv") !== undefined ? { cv: Number(get("--cv")) } : {}),
		seconds: Number(get("--seconds") ?? 900),
	};
}

/** Kill only the game binaries this machine started for benchmarks. */
function cleanupGame(): void {
	spawnSync("pkill", ["-f", "OpenTTD.app/Contents/MacOS/openttd"]);
	spawnSync("sleep", ["2"]);
}

function runCell(cell: { model: string; seed: number; dataDir: string }, world: BenchWorld, seconds: number): number {
	mkdirSync(cell.dataDir, { recursive: true });
	const logPath = join(cell.dataDir, "run.log");
	const fd = openSync(logPath, "a");
	// The model is passed through the same env var the CLI already uses, so the
	// benchmark never needs a second code path into the agent.
	const r = spawnSync(
		"pnpm",
		[
			"run",
			"cli",
			"--agent",
			"--seed",
			String(cell.seed),
			"--game-days",
			String(world.horizonDays),
			"--scenario",
			world.scenario,
			"--year",
			String(world.startYear),
			"--demo-seconds",
			String(seconds),
		],
		{
			stdio: ["ignore", fd, fd],
			env: {
				...process.env,
				OPENTTD_DATA_DIR: cell.dataDir,
				LLM_MODEL: cell.model,
			},
		},
	);
	return r.status ?? -1;
}

const args = parseArgs(process.argv.slice(2));
if (!args.root || args.models.length === 0 || args.seeds.length === 0) {
	console.error(USAGE);
	process.exit(2);
}

const world: BenchWorld = {
	scenario: args.scenario,
	horizonDays: args.gameDays,
	startYear: args.startYear,
	mapSize: args.mapSize,
};

let plan;
try {
	plan = planMatrix({
		models: args.models,
		seeds: args.seeds,
		repeats: args.repeats,
		world,
		root: args.root,
		...(args.effect !== undefined && args.cv !== undefined ? { power: { effectSize: args.effect, cv: args.cv } } : {}),
	});
} catch (e) {
	// Pre-registration refusals are the point, not a bug: print them plainly.
	console.error(`!! ${(e as Error).message}`);
	process.exit(1);
}

console.log(`matrix: ${plan.cells.length} cell(s), ${plan.runsPerModel} run(s) per model`);
console.log(`world: scenario=${world.scenario} horizon=${world.horizonDays} startYear=${world.startYear} map=${world.mapSize.join("x")}`);
if (plan.power) {
	console.log(`pre-registered: +${Math.round(plan.power.effectSize * 100)}% effect at CV ${Math.round(plan.power.cv * 100)}% (needs ${plan.power.requiredPerArm}/model)`);
} else {
	console.log("pre-registered: no (a comparison from this matrix will report 'not determinable' rather than a p-value)");
}
for (const c of plan.cells) console.log(`  ${c.model} seed=${c.seed} rep=${c.repeat} -> ${c.dataDir}`);

if (args.dryRun) process.exit(0);

// --- run the matrix (serial: one game instance at a time) ---
let failed = 0;
for (const cell of plan.cells) {
	cleanupGame();
	const code = runCell(cell, world, args.seconds);
	if (code !== 0) {
		failed++;
		console.log(`!! ${cell.model} seed=${cell.seed} rep=${cell.repeat} rc=${code} (log: ${join(cell.dataDir, "run.log")})`);
	}
}
cleanupGame();

// --- report ---
const conditions: BenchConditions = {
	scenario: world.scenario,
	horizonDays: world.horizonDays,
	seeds: args.seeds,
	repeats: args.repeats,
};
const all: GameMetric[] = plan.cells.flatMap((c) => {
	try {
		return readMetrics(c.dataDir);
	} catch {
		return [];
	}
});
const card = buildScorecard(all, { conditions });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(args.root, { recursive: true });
const jsonPath = join(args.root, `bench-${stamp}.json`);
writeFileSync(jsonPath, `${JSON.stringify({ plan, conditions, scorecard: card }, null, 2)}\n`, "utf8");
const mdPath = join(args.root, `bench-${stamp}.md`);
writeFileSync(mdPath, renderReportMarkdown(card), "utf8");

console.log("");
console.log(`runs: ${plan.cells.length - failed} ok, ${failed} failed`);
console.log(`report: ${jsonPath}`);
console.log(`        ${mdPath}`);

// Pairwise, paired-by-seed comparisons (only meaningful with >= 2 models).
if (args.models.length >= 2) {
	console.log("");
	console.log("paired comparisons (same seed, same repeat):");
	for (let i = 0; i < args.models.length; i++) {
		for (let j = i + 1; j < args.models.length; j++) {
			const cmp = pairedComparison(all, args.models[i]!, args.models[j]!);
			console.log(`  ${args.models[i]} vs ${args.models[j]}: ${cmp.verdict} - ${cmp.message}`);
		}
	}
}

process.exit(failed === 0 ? 0 : 1);

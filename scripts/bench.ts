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
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planMatrix, type BenchWorld } from "../src/evolution/bench-plan.js";
import { buildScorecard, type BenchConditions } from "../src/evolution/scorecard.js";
import { renderReportMarkdown } from "../src/evolution/bench-report.js";
import { pairedComparisons } from "../src/evolution/bench-stats.js";
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
	/**
	 * A credentials file to copy into every cell's data dir.
	 *
	 * 为什么需要: 每个格子是**独立**的 data dir（记忆不得跨格），而模型的 key
	 * 只存在于**仓库之外**的 `credentials.json`（仓库里不许有 key）⇒ 不复制
	 * 进去，每一格都会因为"没有凭证"而失败。
	 */
	credentials?: string;
	/**
	 * A provider model list (`models-cache.json`) to copy into every cell.
	 *
	 * 为什么需要: 走**目录**（catalog）这条路的 provider，模型清单存在
	 * `<dataDir>/models-cache.json`（Providers 页"从 provider 刷新"写下的那份）
	 * ⇒ 新的 data dir 里没有它 ⇒ 运行前的闸会说"provider 不认识这个模型"。
	 * 把同一份清单复制进每一格 ⇒ 每格看到的是**同一个 provider 的同一份清单**
	 * ⇒ 矩阵比较的仍然是同一个问题。
	 */
	modelsCache?: string;
}

const USAGE = `usage: tsx scripts/bench.ts --root <dir> --models a,b --seeds 11,22 [--repeats 3]
  [--game-days 300] [--scenario prebuilt|freeform] [--start-year 1950] [--map 256x256]
  [--seconds 900] [--effect 0.5 --cv 1] [--credentials <file>] [--models-cache <file>]
  [--dry-run]

  Every (model, seed, repeat) cell gets its own data dir under <root>, so memory
  never crosses cells. --effect/--cv pre-register the comparison: an
  under-powered matrix is refused before any run starts. --credentials copies a
  credentials file into every cell (the key must stay out of the repository);
  --models-cache copies the provider's model list (same reason).`;

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
		...(get("--credentials") !== undefined ? { credentials: get("--credentials")! } : {}),
		...(get("--models-cache") !== undefined ? { modelsCache: get("--models-cache")! } : {}),
	};
}

/** Kill only the game binaries this machine started for benchmarks. */
function cleanupGame(): void {
	spawnSync("pkill", ["-f", "OpenTTD.app/Contents/MacOS/openttd"]);
	spawnSync("sleep", ["2"]);
}

/**
 * Copy the credentials file into one cell's data dir.
 *
 * 铁律: ① **只复制，不打印**（key 不进日志、不进报告）；② 目标权限 0600；
 * ③ 每格一份（格子之间不共享）⇒ 复制的是**文件**，不是进程的环境变量。
 */
export function installCredentials(source: string, cellDir: string): void {
	const target = join(cellDir, "credentials.json");
	copyFileSync(source, target);
	chmodSync(target, 0o600);
}

/**
 * Copy the provider's model list into one cell's data dir.
 *
 * 为什么需要: 目录（catalog）provider 的模型清单在 `<dataDir>/models-cache.json`
 * ⇒ 新目录里没有它 ⇒ 运行前的闸会说"provider 不认识这个模型"⇒ 矩阵第一格就
 * 失败。这份清单是 provider 自己的（Providers 页刷新时拿到的），复制它只是把
 * **同一个 provider 的同一份清单**放进每一格。
 */
export function installModelsCache(source: string, cellDir: string): void {
	copyFileSync(source, join(cellDir, "models-cache.json"));
}

/**
 * Check the credentials file **before** the matrix starts.
 *
 * 为什么要在跑前查: 缺凭证的格子会**跑到一半**才失败 ⇒ 已经烧掉的 token 与
 * 时间全部白花 ⇒ 凭证的事要在**第一格之前**说清楚。
 */
export function checkCredentials(source: string | undefined): void {
	if (!source) return;
	const path = resolve(source);
	if (!existsSync(path)) {
		throw new Error(`credentials file not found: ${path}`);
	}
}

/** The same check for the provider's model list (fail before the first cell). */
export function checkModelsCache(source: string | undefined): void {
	if (!source) return;
	const path = resolve(source);
	if (!existsSync(path)) {
		throw new Error(`models cache not found: ${path}`);
	}
}

function runCell(
	cell: { model: string; seed: number; dataDir: string },
	world: BenchWorld,
	seconds: number,
	credentials?: string,
	modelsCache?: string,
): number {
	mkdirSync(cell.dataDir, { recursive: true });
	if (credentials) installCredentials(credentials, cell.dataDir);
	if (modelsCache) installModelsCache(modelsCache, cell.dataDir);
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

/**
 * True when this file is the process entry point.
 *
 * 为什么需要: 单测要 import 这个脚本里的**纯函数**（凭证的复制与检查）⇒ 顶层
 * 代码必须不自动跑（否则 import 就开始跑矩阵了）。
 *
 * **必须比较 realpath**: macOS 的 `/tmp` 是 `/private/tmp` 的符号链接 ⇒
 * `import.meta.url` 带的是**解析后**的路径，而 `process.argv[1]` 带的是
 * **调用时**的路径 ⇒ 直接比字符串会**判成"不是入口"** ⇒ 脚本**什么都不做**
 * 就退出（静默无操作，最坏的一种失败）。仓库放在符号链接路径下时会踩到。
 */
export function isEntryPoint(): boolean {
	const arg = process.argv[1];
	if (!arg) return false;
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(arg);
	} catch {
		return false;
	}
}

function main(argv: string[]): number {
	const args = parseArgs(argv);
	if (!args.root || args.models.length === 0 || args.seeds.length === 0) {
		console.error(USAGE);
		return 2;
	}

	// The credentials are checked **before** the first cell: a missing key would
	// otherwise fail half-way through the matrix.
	try {
		checkCredentials(args.credentials);
		checkModelsCache(args.modelsCache);
	} catch (e) {
		console.error(`!! ${(e as Error).message}`);
		return 1;
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
		return 1;
	}

	console.log(`matrix: ${plan.cells.length} cell(s), ${plan.runsPerModel} run(s) per model`);
	console.log(`world: scenario=${world.scenario} horizon=${world.horizonDays} startYear=${world.startYear} map=${world.mapSize.join("x")}`);
	if (plan.power) {
		console.log(`pre-registered: +${Math.round(plan.power.effectSize * 100)}% effect at CV ${Math.round(plan.power.cv * 100)}% (needs ${plan.power.requiredPerArm}/model)`);
	} else {
		console.log("pre-registered: no (a comparison from this matrix will report 'not determinable' rather than a p-value)");
	}
	for (const c of plan.cells) console.log(`  ${c.model} seed=${c.seed} rep=${c.repeat} -> ${c.dataDir}`);

	if (args.dryRun) return 0;

	// --- run the matrix (serial: one game instance at a time) ---
	let failed = 0;
	for (const cell of plan.cells) {
		cleanupGame();
		const code = runCell(cell, world, args.seconds, args.credentials, args.modelsCache);
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
	// The paired verdicts, per axis (Issue #87): one comparison per metric that
	// can be compared pair by pair, so the report answers every axis instead of
	// only the main one.
	const pairComparisons: Record<string, ReturnType<typeof pairedComparisons>> = {};
	const allComparisons: ReturnType<typeof pairedComparisons> = [];
	for (let i = 0; i < args.models.length; i++) {
		for (let j = i + 1; j < args.models.length; j++) {
			const list = pairedComparisons(all, args.models[i]!, args.models[j]!);
			pairComparisons[`${args.models[i]} vs ${args.models[j]}`] = list;
			allComparisons.push(...list);
		}
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	mkdirSync(args.root, { recursive: true });
	const jsonPath = join(args.root, `bench-${stamp}.json`);
	writeFileSync(jsonPath, `${JSON.stringify({ plan, conditions, scorecard: card, comparisons: pairComparisons }, null, 2)}\n`, "utf8");
	const mdPath = join(args.root, `bench-${stamp}.md`);
	writeFileSync(mdPath, renderReportMarkdown(card, new Date(), allComparisons), "utf8");

	console.log("");
	console.log(`runs: ${plan.cells.length - failed} ok, ${failed} failed`);
	console.log(`report: ${jsonPath}`);
	console.log(`        ${mdPath}`);

	// Pairwise, paired-by-seed comparisons (only meaningful with >= 2 models).
	if (args.models.length >= 2) {
		console.log("");
		console.log("paired comparisons (same seed, same repeat), per axis:");
		for (let i = 0; i < args.models.length; i++) {
			for (let j = i + 1; j < args.models.length; j++) {
				const pair = `${args.models[i]} vs ${args.models[j]}`;
				for (const cmp of pairedComparisons(all, args.models[i]!, args.models[j]!)) {
					console.log(`  [${cmp.axisLabel}] ${cmp.label} (${cmp.unit}): ${cmp.verdict} - ${cmp.message}`);
				}
				console.log(`  (${pair})`);
			}
		}
	}

	return failed === 0 ? 0 : 1;
}

if (isEntryPoint()) {
	process.exit(main(process.argv.slice(2)));
}

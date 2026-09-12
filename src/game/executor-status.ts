/**
 * Executor phase vocabulary — decode `EX ...` company names into facts.
 *
 * 职责: 把执行器借公司名上报的**原始字符串**翻译成结构化事实 + 一句话叙述。
 * 禁止: 在此给出"下一步该做什么"。这里只做翻译 —— 契约/环境事实 ✅，
 *   策略 ❌（SPEC §10.22）。
 *
 * 为什么需要（2026-09-12）:
 * 执行器唯一的回报通道是公司名（OpenTTD 上限 31 字符，SPEC §10.10），所以它把
 * 阶段压成了 `EX rd s0 r0 j100` 这种电报体。agent 拿到的是**噪声**：
 * 「rd」是什么？「s0」是第 0 段还是第 0 站？「r0」是重试 0 次还是半径 0？
 * 语法只存在于 Squirrel 源码里，模型无从知道。
 *
 * 等价于：让人去玩一个只显示 `rd s0 r0` 的游戏。补上这层翻译属于
 * **接口词汇表**（就像函数签名），不是替 agent 做决定 —— 补齐之后，
 * "这个阶段意味着什么、值不值得等"仍然完全由 agent 自己判断。
 */

/** What the executor is doing right now. */
export type ExecutorStage =
	| "boot"
	| "work"
	| "station"
	| "road"
	| "depot"
	| "vehicle"
	| "fleet"
	| "done"
	| "heartbeat"
	| "error"
	| "unknown";

export interface ExecutorPhase {
	/** The original string, e.g. `EX rd s0 r0 j100`. */
	raw: string;
	/** Phase text with the `EX ` prefix and job suffix removed. */
	phase: string;
	stage: ExecutorStage;
	/** Blueprint job id from the `j<N>` suffix, or null. */
	job: number | null;
	/**
	 * True when this is a periodic liveness beat rather than a state change.
	 * The runner should not treat a heartbeat as news.
	 */
	heartbeat: boolean;
	/** True when the executor reported an exception. */
	error: boolean;
	/** Human/LLM-readable single sentence. Always non-empty for known input. */
	description: string;
	/** Extra decoded fields, only present when the phase carries them. */
	detail?: Record<string, string | number>;
}

const STAGE_BY_PREFIX: [string, ExecutorStage][] = [
	["exc:", "error"],
	["hb ", "heartbeat"],
	["boot", "boot"],
	["work", "work"],
	["st", "station"],
	["road", "road"],
	["rd ", "road"],
	["dpt", "depot"],
	["bus_", "vehicle"],
	["fleet", "fleet"],
	["done", "done"],
];

/** Station-slot suffix → what it means. `stA_ok` → slot `A`, outcome `ok`. */
const STATION_OUTCOME: Record<string, string> = {
	wait: "waiting for the site to be clear",
	scan: "searching for a buildable site",
	ok: "station built",
	giveup: "gave up - no buildable site found nearby",
	retry: "retrying on a new site",
	place_e: "station placement failed",
	slope_warn: "site is on a slope, may need flattening",
};

const DEPOT_OUTCOME: Record<string, string> = {
	nowhere: "no depot site found",
	giveup: "gave up building the depot",
	retry: "retrying the depot site",
	ok: "depot built",
	door_e: "could not place the depot entrance",
	noconn: "depot is not connected to the road",
	conn: "depot connected to the road",
};

const VEHICLE_OUTCOME: Record<string, string> = {
	nocargo: "no cargo available at the station",
	noeng: "no engine available to buy",
	live: "vehicle is running",
	buy_e: "vehicle purchase failed",
	start_e: "vehicle could not be started",
};

function num(v: string | undefined): number | null {
	if (v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * Decode one executor phase string.
 *
 * Never throws and never guesses: an unrecognised phase keeps its raw text and
 * is labelled `unknown`, because silently inventing a meaning would be worse
 * than admitting we do not have one.
 */
export function decodeExecutorPhase(input: string): ExecutorPhase {
	const raw = String(input ?? "").trim();
	const base: ExecutorPhase = {
		raw,
		phase: raw,
		stage: "unknown",
		job: null,
		heartbeat: false,
		error: false,
		description: raw ? `executor reports: ${raw}` : "no executor phase reported yet",
	};

	let s = raw;
	if (s.startsWith("EX ")) s = s.slice(3).trim();

	// Trailing ` j<number>` is the blueprint job id, present on every phase.
	let job: number | null = null;
	const jobMatch = /\s+j(-?\d+)\s*$/.exec(s);
	if (jobMatch) {
		job = num(jobMatch[1]) ?? null;
		s = s.slice(0, jobMatch.index).trim();
	}
	base.phase = s;
	base.job = job;

	for (const [prefix, stage] of STAGE_BY_PREFIX) {
		if (s === prefix || s.startsWith(prefix)) {
			base.stage = stage;
			break;
		}
	}

	// --- heartbeat: `hb <stage> #<n>` — liveness, not news ---
	const hb = /^hb\s+(\S+)\s*#(\d+)$/.exec(s);
	if (hb) {
		base.heartbeat = true;
		base.stage = "heartbeat";
		base.detail = { innerStage: hb[1]!, beat: num(hb[2]) ?? 0 };
		base.description =
			`executor is alive and still working on "${hb[1]}" ` +
			`(heartbeat #${hb[2]}). No state change since the last beat.`;
		return base;
	}

	// --- exception: `exc:<message>` ---
	if (s.startsWith("exc:")) {
		base.error = true;
		const msg = s.slice(4).trim();
		base.detail = { message: msg };
		base.description = `executor raised an error and may have stopped progressing: ${msg}`;
		return base;
	}

	if (s === "boot") {
		base.description = "executor started and is waiting for a blueprint to work on.";
		return base;
	}
	if (s === "work") {
		base.description = "executor received a blueprint: it funded the company and is starting construction.";
		return base;
	}

	// --- station: `st<slot>_<outcome>` / `st<slot>...` ---
	const st = /^st([A-Za-z])_?(\w*)$/.exec(s);
	if (st) {
		const slot = st[1]!;
		const outcome = st[2] || "unknown";
		const what = STATION_OUTCOME[outcome] ?? `state "${outcome}"`;
		base.stage = "station";
		base.detail = { slot, outcome };
		base.description = `building station ${slot}: ${what}.`;
		return base;
	}
	// The `@` form the executor also emits while scanning.
	if (s.startsWith("@")) {
		base.stage = "station";
		base.description = `executor is scanning for a station site: ${s}`;
		return base;
	}

	// --- road ---
	if (s === "road_start") {
		base.description = "both stations are built; the executor is starting the road between them.";
		return base;
	}
	if (s === "road_built") {
		base.description = "the road between the two stations is complete.";
		return base;
	}
	if (s === "road_nofront") {
		base.error = true;
		base.description =
			"the executor has no station front tile to build from, so it stopped. The stations were not registered as buildable fronts.";
		return base;
	}
	if (s === "road_stuck") {
		base.error = true;
		base.description =
			"the executor could not find or lay any road toward the second station and gave up on the route.";
		return base;
	}
	const seg = /^road seg(\d+) d(\d+)$/.exec(s);
	if (seg) {
		base.detail = { segment: num(seg[1]) ?? 0, remainingTiles: num(seg[2]) ?? 0 };
		base.description =
			`road segment ${seg[1]} laid; about ${seg[2]} tiles still to go to the far station.`;
		return base;
	}
	const rd = /^rd s(\d+) r(\d+)$/.exec(s);
	if (rd) {
		base.detail = { segment: num(rd[1]) ?? 0, retry: num(rd[2]) ?? 0 };
		base.description =
			`road segment ${rd[1]}: still searching for a route (search attempt ${rd[2]}). ` +
			`The pathfinder has not returned a path yet - this is work in progress, not a failure.`;
		return base;
	}
	const rdRetry = /^rd retry(\d+)$/.exec(s);
	if (rdRetry) {
		base.detail = { retry: num(rdRetry[1]) ?? 0 };
		base.description = `road search hit an obstacle and is retrying with a shorter probe (attempt ${rdRetry[1]}).`;
		return base;
	}
	const rdLay = /^rd layr(\d+)$/.exec(s);
	if (rdLay) {
		base.detail = { retry: num(rdLay[1]) ?? 0 };
		base.description =
			`laying the road failed on this attempt (retry ${rdLay[1]}); the executor will try a shorter path.`;
		return base;
	}

	// --- depot ---
	const dpt = /^dpt_?(\w*)$/.exec(s);
	if (dpt) {
		const outcome = dpt[1] || "unknown";
		if (outcome.startsWith("e")) {
			base.error = true;
			base.detail = { message: outcome.slice(1) };
			base.description = `depot build failed: ${outcome.slice(1)}`;
			return base;
		}
		const what = DEPOT_OUTCOME[outcome] ?? `state "${outcome}"`;
		base.stage = "depot";
		base.detail = { outcome };
		base.description = `building the depot: ${what}.`;
		return base;
	}

	// --- vehicle ---
	if (s.startsWith("bus_") || s.startsWith("fleet")) {
		const outcome = s.replace(/^bus_/, "").replace(/^fleet_?/, "");
		const what = VEHICLE_OUTCOME[outcome] ?? `state "${outcome}"`;
		base.stage = s.startsWith("fleet") ? "fleet" : "vehicle";
		base.detail = { outcome };
		if (s === "fleet_noveh") {
			base.description =
				"a fleet change was requested but the company owns no vehicle to copy, so nothing was done.";
			return base;
		}
		base.description = `vehicles: ${what}.`;
		return base;
	}

	// --- done: `done stN<n> r<segs> bus|nobus` ---
	const done = /^done stN(\d+) r(\d+) (\S+)$/.exec(s);
	if (done) {
		base.stage = "done";
		base.detail = {
			stations: num(done[1]) ?? 0,
			roadSegments: num(done[2]) ?? 0,
			vehicles: done[3]!,
		};
		base.description =
			`construction finished: ${done[1]} bus stop(s) and ${done[2]} road segment(s) exist; ` +
			`the executor reports ${done[3] === "bus" ? "a vehicle is running" : "no vehicle is running"}. ` +
			`The executor now idles - it will not start anything further on its own.`;
		return base;
	}

	return base;
}

/**
 * Decode a window of phases and collapse consecutive heartbeats.
 *
 * A run of `hb road #1..40` is 40 identical facts; handing all of them to the
 * model wastes context and buries the one line that changed. Only the LAST
 * heartbeat of each run is kept, annotated with how many were seen.
 */
export function decodePhaseWindow(phases: readonly string[]): ExecutorPhase[] {
	const out: ExecutorPhase[] = [];
	let beats = 0;
	for (const p of phases) {
		const d = decodeExecutorPhase(p);
		if (d.heartbeat) {
			beats++;
			continue;
		}
		if (beats > 0 && out.length > 0) {
			// Attribute the beats to the phase that preceded them.
			out[out.length - 1]!.description += ` (stayed in this state for ${beats} heartbeat(s))`;
		}
		beats = 0;
		out.push(d);
	}
	if (beats > 0 && out.length > 0) {
		out[out.length - 1]!.description += ` (stayed in this state for ${beats} heartbeat(s))`;
	}
	// No non-heartbeat phases at all: report the last beat so the caller still
	// learns the executor is alive.
	if (out.length === 0 && phases.length > 0) out.push(decodeExecutorPhase(phases[phases.length - 1]!));
	return out;
}

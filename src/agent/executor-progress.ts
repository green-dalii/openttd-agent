/**
 * Construction-progress meter — the executor as a fact the agent can reason about.
 *
 * 职责：把 executor 的阶段电报体（`rd s<seg> r<step> d<dist> p<fails>`、
 *   `hb road #n s<seg> j<job>`）积分为**可推理的施工事实**：还需铺多少格、
 *   实测吞吐（格/游戏日）、按当前速率的 ETA、以及"多久没有实际推进"。
 * 禁止：任何策略、任何 IO。只做观测聚合。
 *
 * 为什么（SPEC §10.67 第 3 层 / MEMORY D17）：这一局的结局由**单线程、慢速的施工
 * executor** 决定，而 agent 看不到它：它在一局里连下 68/110/161/239/271 格的线路，
 * 全部排在同一条 FIFO 后面；它只能用轮询填满盲区（单局 193 次工具调用）。
 * "这条路来不来得及建好"是**事实问题**，harness 有责任回答它。
 *
 * 字段语义来自 Squirrel 源码而非字段名（executor-ai/main.nut:420,462）：
 * `d` = `AIMap.DistanceManhattan(_roadCur, farStation)` = **还需铺的格数**，
 * 随道路推进而下降；`r` = 当前段内的寻路搜索步数，**不代表推进**。
 * 这个区分是刻意保留的：搜索在动 ≠ 路在前进。
 */

export interface ExecPhaseSample {
	/** Simulated day this sample was taken. */
	gameDay: number;
	/** Job the executor is working on (-1 = none/boot). */
	job: number;
	/** Segmented-road index, when the phase carries it. */
	segment?: number;
	/** Tiles STILL TO GO (falls as the road advances). */
	remainingTiles?: number;
	/** Pathfinder step within the current segment. */
	step?: number;
}

export interface ExecutorProgressReport {
	job: number | null;
	segment: number | null;
	/** Tiles still to go, or null when never reported. */
	remainingTiles: number | null;
	/** Measured tiles per game day, or null while the road has not advanced. */
	tilesPerDay: number | null;
	/** Game days to reach the far station at the measured rate. */
	etaDays: number | null;
	/**
	 * Game days since `remainingTiles` last CHANGED (null = never reported).
	 * A stage that carries no distance does not refresh it, so treat this as
	 * "the reported number is this old", not as proof the executor stopped.
	 */
	stalledDays: number | null;
	/** Current pathfinder step (activity, not progress). */
	searchStep: number | null;
	/** Distinct jobs this executor has worked on (FIFO queue evidence). */
	jobsSeen: number;
}

export interface ExecutorProgress {
	observe(sample: ExecPhaseSample): void;
	report(gameDay: number): ExecutorProgressReport;
}

export function createExecutorProgress(): ExecutorProgress {
	let job: number | null = null;
	let segment: number | null = null;
	let remaining: number | null = null;
	let step: number | null = null;
	/** First sample of the current progress run: the baseline for the rate. */
	let base: { gameDay: number; remaining: number } | null = null;
	/** Most recent sample where the road actually advanced. */
	let lastAdvance: { gameDay: number; remaining: number } | null = null;
	const jobs = new Set<number>();

	return {
		observe(sample) {
			if (Number.isFinite(sample.job) && sample.job >= 0) jobs.add(sample.job);
			// A new job invalidates the previous rate: the tiles belonged to
			// another route, so averaging across them would invent a throughput.
			if (job !== null && Number.isFinite(sample.job) && sample.job !== job) {
				base = null;
				lastAdvance = null;
				remaining = null;
			}
			job = Number.isFinite(sample.job) ? sample.job : job;
			if (sample.segment !== undefined) segment = sample.segment;
			if (sample.step !== undefined) step = sample.step;
			if (sample.remainingTiles === undefined) return;
			const r = sample.remainingTiles;
			if (remaining === null) {
				remaining = r;
				if (base === null) base = { gameDay: sample.gameDay, remaining: r };
				lastAdvance = { gameDay: sample.gameDay, remaining: r };
				return;
			}
			if (r < remaining) {
				// The road advanced: this is the only event that counts as progress.
				remaining = r;
				lastAdvance = { gameDay: sample.gameDay, remaining: r };
				if (base === null) base = { gameDay: sample.gameDay, remaining: r };
				return;
			}
			// Same or larger remaining distance (a new segment re-measures from the
			// current front): keep the last known value, do not fake progress.
			if (r > remaining && base !== null && lastAdvance !== null) {
				// Segment boundary: re-baseline so the rate stays honest.
				base = { gameDay: lastAdvance.gameDay, remaining: remaining };
			}
			remaining = r;
		},
		report(gameDay) {
			const days = base && lastAdvance ? lastAdvance.gameDay - base.gameDay : 0;
			const moved = base && lastAdvance ? base.remaining - lastAdvance.remaining : 0;
			const tilesPerDay = days > 0 && moved > 0 ? moved / days : null;
			const etaDays =
				tilesPerDay !== null && remaining !== null && tilesPerDay > 0 ? remaining / tilesPerDay : null;
			return {
				job,
				segment,
				remainingTiles: remaining,
				tilesPerDay,
				etaDays,
				stalledDays: lastAdvance ? Math.max(0, gameDay - lastAdvance.gameDay) : null,
				searchStep: step,
				jobsSeen: jobs.size,
			};
		},
	};
}

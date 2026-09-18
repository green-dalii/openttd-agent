/**
 * Episode clock — the measurement unit of a run.
 *
 * 职责：定义"一次观测"的边界。局以**模拟时间（游戏日）**结束；墙钟只作**安全上限**。
 *   输出 simulatedDays / daysRemaining / reachedHorizon / stopReason。
 * 禁止：任何策略、任何 IO。纯函数式的状态检查。
 *
 * 为什么（SPEC §10.68）：同样 `--demo-seconds 900` 的六局分别推进
 * 449 / 445 / 273 / 445 / 0 / 448 游戏日——墙钟→模拟时间的换算率随
 * ① 机器负载 ② agent 自己的 `set_pause` ③ 冻结机制 而变。结局近似与推进的游戏
 * 时间成正比，于是"同一个实验里的两局"是**长度不同的世界**；那局 0 游戏日的运行
 * 还被记成 `deliveredRun=0`——**"世界停住了"与"什么都没运"无法区分**。
 * 把边界改到模拟时间后：机器负载只影响**耗时**，不影响**答案**；未达上限的局
 * 由 `reachedHorizon=false` 显式标注，绝不冒充结果。
 */

export interface EpisodePlan {
	/** Stop after this many SIMULATED days. null = run until the wall cap. */
	horizonDays?: number | null;
	/** Wall-clock safety cap in ms. null = no cap. */
	capMs?: number | null;
	/** Wall clock at episode start (ms). */
	startedAtMs: number;
	/** Simulated day at episode start. */
	startGameDay: number;
}

export interface EpisodeInput {
	gameDay: number;
	nowMs: number;
}

export type EpisodeStopReason = "horizon" | "wall_cap" | null;

export interface EpisodeState {
	/** Simulated days elapsed since the episode started (never negative). */
	simulatedDays: number;
	/** Simulated days left before the horizon; null when no horizon is set. */
	daysRemaining: number | null;
	/** True when the simulated horizon has been satisfied. */
	reachedHorizon: boolean;
	/** Why the episode should stop now (null = keep going). */
	stopReason: EpisodeStopReason;
}

export interface Episode {
	check(input: EpisodeInput): EpisodeState;
	/** The plan, for logging and for writing into the metric. */
	plan: { horizonDays: number | null; capMs: number | null; startGameDay: number };
}

export function createEpisode(plan: EpisodePlan): Episode {
	const horizonDays = plan.horizonDays && plan.horizonDays > 0 ? plan.horizonDays : null;
	const capMs = plan.capMs && plan.capMs > 0 ? plan.capMs : null;
	// Highest day seen: a stale or reset report must not shrink elapsed time
	// (the GS rebroadcasts state; a replayed packet is not a rewind).
	let highWater = plan.startGameDay;

	return {
		plan: { horizonDays, capMs, startGameDay: plan.startGameDay },
		check({ gameDay, nowMs }) {
			if (Number.isFinite(gameDay) && gameDay > highWater) highWater = gameDay;
			const simulatedDays = Math.max(0, highWater - plan.startGameDay);
			const daysRemaining = horizonDays === null ? null : Math.max(0, horizonDays - simulatedDays);
			const reachedHorizon = horizonDays !== null && simulatedDays >= horizonDays;
			const capHit = capMs !== null && nowMs - plan.startedAtMs >= capMs;
			return {
				simulatedDays,
				daysRemaining,
				reachedHorizon,
				stopReason: reachedHorizon ? "horizon" : capHit ? "wall_cap" : null,
			};
		},
	};
}

/**
 * Prebuilt scenario (S1/G4) — the route exists BEFORE the measurement window.
 *
 * 职责：在测量窗打开之前，用**确定性蓝图**建好一条可运营线路，并等到它真的能运货
 *   （≥2 站 + ≥1 车辆），然后才把控制权交给决策循环。
 * 禁止：任何策略、任何对 agent 的建议。它只负责"把场景准备好并如实报告是否准备好"。
 *
 * 为什么（SPEC §10.67–§10.72）：自由局里结局主要由"executor 有没有在窗口内把路建完"
 * 决定（同车队下 delivered 从 0 到 527），而有后果的决策只有开头 1–3 个；S0 oracle
 * 梯度又证明**车队规模是真杠杆但只在 3–15 辆区间陡峭**。把施工移出测量窗后，
 * 整局都是**管理决策**，效应量才落得进陡峭区间。
 *
 * 诚实边界：场景没准备好时**必须**如实返回 `ready=false`（timeout / order_refused），
 * 让调用方标注这一局；"假装场景就绪"会让一局无意义的运行看起来像一次测量。
 */

export interface PrebuiltSignals {
	stations: number;
	vehicles: number;
}

/** A town as the world state reports it (id + position). */
export interface BlueprintTown {
	id: number;
	x: number;
	y: number;
}

/**
 * The shortest sensible pair of towns for the blueprint.
 *
 * Why the **nearest** pair (2026-11-17, E2 seed 22's real cause): the road is
 * built in segments, one pathfinder search each, spread over ticks ⇒ the
 * construction time grows with the distance. The GS used to pick the pair with
 * the **highest population**, which on some maps is very far away ⇒ the build
 * did not finish inside the wait ⇒ **the measurement window never opened** ⇒
 * that run was not a measurement at all (D131).
 *
 * The blueprint needs a route that is **operable in time**, so: the nearest
 * pair that is not trivially short. Deterministic: the same map ⇒ the same
 * pair (ties broken by id).
 *
 * null = no usable pair (not enough towns, or their positions were not
 * measured) ⇒ the caller must not invent one.
 */
/**
 * All usable town pairs, **closest first** (deterministic).
 *
 * Why a list and not one pair (2026-11-17, E2 seed 22): the nearest pair on
 * that map was **not connectable by road** (the pathfinder found no route to
 * any probe ⇒ the road was never laid ⇒ the measurement window never opened).
 * ⇒ The blueprint tries the pairs in order until one builds; each attempt is
 * bounded, so a hopeless pair costs seconds, not the whole budget.
 *
 * Order: by distance, then by ids ⇒ the same map always yields the same
 * sequence (a run is reproducible).
 */
export function pickBlueprintTownPairs(
	towns: readonly BlueprintTown[],
	opts: { minDistance?: number; maxPairs?: number } = {},
): { a: number; b: number; distance: number }[] {
	const minDistance = opts.minDistance ?? 15;
	const maxPairs = opts.maxPairs ?? 6;
	const usable = (towns ?? []).filter(
		(t) =>
			t &&
			typeof t.id === "number" &&
			Number.isFinite(t.id) &&
			typeof t.x === "number" &&
			Number.isFinite(t.x) &&
			typeof t.y === "number" &&
			Number.isFinite(t.y),
	);
	const out: { a: number; b: number; distance: number }[] = [];
	for (let i = 0; i < usable.length; i++) {
		for (let j = i + 1; j < usable.length; j++) {
			const a = usable[i]!;
			const b = usable[j]!;
			const distance = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
			if (distance < minDistance) continue;
			out.push({ a: a.id, b: b.id, distance });
		}
	}
	out.sort((p, q) => (p.distance !== q.distance ? p.distance - q.distance : p.a !== q.a ? p.a - q.a : p.b - q.b));
	return out.slice(0, maxPairs);
}

export function pickBlueprintTowns(
	towns: readonly BlueprintTown[],
	opts: { minDistance?: number } = {},
): { a: number; b: number } | null {
	const minDistance = opts.minDistance ?? 15;
	const usable = (towns ?? []).filter(
		(t) =>
			t &&
			typeof t.id === "number" &&
			Number.isFinite(t.id) &&
			typeof t.x === "number" &&
			Number.isFinite(t.x) &&
			typeof t.y === "number" &&
			Number.isFinite(t.y),
	);
	if (usable.length < 2) return null;
	let best: { a: number; b: number; d: number } | null = null;
	for (let i = 0; i < usable.length; i++) {
		for (let j = i + 1; j < usable.length; j++) {
			const a = usable[i]!;
			const b = usable[j]!;
			const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
			if (d < minDistance) continue;
			// Ties broken by the town ids ⇒ deterministic, not map-order dependent.
			if (!best || d < best.d || (d === best.d && (a.id < best.a || (a.id === best.a && b.id < best.b)))) {
				best = { a: a.id, b: b.id, d };
			}
		}
	}
	return best ? { a: best.a, b: best.b } : null;
}

/** A route is operable once it has two stations and at least one vehicle. */
export function isPrebuiltReady(s: PrebuiltSignals): boolean {
	return s.stations >= 2 && s.vehicles >= 1;
}

/** The hard ceiling on the prebuilt wait (20 minutes). */
const MAX_PREBUILT_WAIT_MS = 20 * 60_000;

/**
 * How long **one** town pair may take before the blueprint tries the next one.
 *
 * 为什么有它：最靠近的一对**不一定连得通**（E2 seed 22：寻路找不到任何探针 ⇒
 * 路永远铺不成）⇒ 蓝图按距离依次试 ⇒ ⇒ 一对没救的对只能花掉它自己那份预算，
 * 不能把整局的等待吃光。
 */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 180_000;

/**
 * How long the prebuilt scenario may wait for an operable route.
 *
 * 为什么不能固定 20 分钟（2026-11-16，E2 矩阵）：蓝图**按 seed 确定性失败**时
 * （铺路重试后放弃），等待会烧满 20 分钟 ⇒ 那一局的墙钟预算被烧光 ⇒ 既没有
 * 测量窗口也没有跑满视界（E2 的 seed 22/55 两格如此）。⇒ 上限**不得越过本局的
 * 墙钟预算**；没有预算时才用 20 分钟。
 */
export function prebuiltTimeoutMs(runSeconds: number | undefined, overrideMs?: number): number {
	if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) {
		return Math.min(overrideMs, MAX_PREBUILT_WAIT_MS);
	}
	if (runSeconds !== undefined && Number.isFinite(runSeconds) && runSeconds > 0) {
		return Math.min(runSeconds * 1000, MAX_PREBUILT_WAIT_MS);
	}
	return MAX_PREBUILT_WAIT_MS;
}

export interface PrebuiltIo {
	/**
	 * Ask the GS for the deterministic blueprint (returns false when refused).
	 *
	 * `towns` is the pair to build (null = "you pick"), because the **nearest**
	 * pair is the one that finishes building inside the wait (see
	 * `pickBlueprintTowns`).
	 */
	sendOrder(towns?: { a: number; b: number } | null): boolean;
	/** Current company signals. */
	snapshot(): PrebuiltSignals;
	/**
	 * The towns the world knows about (positions measured; missing = absent).
	 *
	 * Optional: absent ⇒ the GS picks the pair (its own choice, which may be
	 * too far to build in time — see `pickBlueprintTowns`).
	 */
	towns?(): readonly BlueprintTown[];
	sleep(ms: number): Promise<void>;
	now(): number;
	log(line: string): void;
}

export interface PrebuiltResult {
	ready: boolean;
	reason: "ready" | "timeout" | "order_refused";
	/** How many samples were taken while waiting (diagnostic, not a metric). */
	waitedSamples: number;
	/** How many town pairs were tried (1 = the first one worked). */
	attempts: number;
	/** The pair that was used (null when nothing was built). */
	pair: { a: number; b: number } | null;
}

/**
 * Send the blueprint and wait until the route can carry cargo.
 *
 * `timeoutMs` bounds the wait in WALL clock because it protects the harness from a
 * wedged game; the episode clock still bounds the measurement itself.
 */
export async function runPrebuiltScenario(
	io: PrebuiltIo,
	opts: { timeoutMs: number; pollMs?: number; attemptTimeoutMs?: number },
): Promise<PrebuiltResult> {
	const pollMs = opts.pollMs ?? 1000;
	const started = io.now();
	// The pairs to try, **closest first** (deterministic). The nearest pair is
	// usually the one that builds in time, but it is not always *connectable*
	// (E2 seed 22) ⇒ several pairs are tried, each with its own budget.
	const pairs = pickBlueprintTownPairs(io.towns ? io.towns() : []);
	const candidates: ({ a: number; b: number } | null)[] = pairs.length
		? pairs.map((p) => ({ a: p.a, b: p.b }))
		: [null];
	let waitedSamples = 0;
	let attempts = 0;
	let refusals = 0;
	let last: { stations: number; vehicles: number } = { stations: 0, vehicles: 0 };

	for (const pair of candidates) {
		const remaining = opts.timeoutMs - (io.now() - started);
		if (remaining <= 0) break;
		attempts++;
		if (!io.sendOrder(pair)) {
			// The GS refused this pair (e.g. "no town pair") ⇒ try the next one.
			refusals++;
			io.log(`[agent] prebuilt: blueprint order REFUSED for the chosen pair - trying another`);
			continue;
		}
		io.log(
			pair
				? `[agent] prebuilt: blueprint sent (towns ${pair.a}→${pair.b}); waiting for an operable route…`
				: "[agent] prebuilt: blueprint sent; waiting for an operable route…",
		);
		// Each attempt gets its own slice of the budget: a hopeless pair must
		// not eat the whole wait.
		const attemptBudget = Math.min(
			opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
			opts.timeoutMs - (io.now() - started),
		);
		const attemptStart = io.now();
		for (;;) {
			const s = io.snapshot();
			waitedSamples++;
			last = s;
			if (isPrebuiltReady(s)) {
				io.log(
					`[agent] prebuilt: ready after ${waitedSamples} sample(s) ` +
						`(stations=${s.stations}, vehicles=${s.vehicles}, attempt ${attempts})`,
				);
				return { ready: true, reason: "ready", waitedSamples, attempts, pair };
			}
			if (io.now() - attemptStart >= attemptBudget) {
				io.log(
					`[agent] prebuilt: pair ${pair ? `${pair.a}→${pair.b}` : "(auto)"} did not become operable ` +
						`within ${Math.round(attemptBudget / 1000)}s (stations=${s.stations}, vehicles=${s.vehicles})`,
				);
				break;
			}
			if (io.now() - started >= opts.timeoutMs) {
				io.log(
					`[agent] prebuilt: TIMEOUT after ${waitedSamples} sample(s) ` +
						`(stations=${s.stations}, vehicles=${s.vehicles}) - this run is NOT a valid measurement`,
				);
				return { ready: false, reason: "timeout", waitedSamples, attempts, pair };
			}
			await io.sleep(pollMs);
		}
	}
	// Every candidate was **refused** ⇒ the GS would not take any of them ⇒ that is
	// a setup failure ("order_refused"), not a timeout: saying "timeout" would
	// blame the clock for a refusal.
	if (refusals > 0 && refusals === attempts) {
		io.log("[agent] prebuilt: the GS refused every blueprint order - scenario not set up");
		return { ready: false, reason: "order_refused", waitedSamples, attempts, pair: null };
	}
	io.log(
		`[agent] prebuilt: TIMEOUT after ${waitedSamples} sample(s) ` +
			`(stations=${last.stations}, vehicles=${last.vehicles}) - this run is NOT a valid measurement`,
	);
	return { ready: false, reason: "timeout", waitedSamples, attempts, pair: null };
}

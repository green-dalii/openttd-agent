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

/** A route is operable once it has two stations and at least one vehicle. */
export function isPrebuiltReady(s: PrebuiltSignals): boolean {
	return s.stations >= 2 && s.vehicles >= 1;
}

export interface PrebuiltIo {
	/** Ask the GS for the deterministic blueprint (returns false when refused). */
	sendOrder(): boolean;
	/** Current company signals. */
	snapshot(): PrebuiltSignals;
	sleep(ms: number): Promise<void>;
	now(): number;
	log(line: string): void;
}

export interface PrebuiltResult {
	ready: boolean;
	reason: "ready" | "timeout" | "order_refused";
	/** How many samples were taken while waiting (diagnostic, not a metric). */
	waitedSamples: number;
}

/**
 * Send the blueprint and wait until the route can carry cargo.
 *
 * `timeoutMs` bounds the wait in WALL clock because it protects the harness from a
 * wedged game; the episode clock still bounds the measurement itself.
 */
export async function runPrebuiltScenario(
	io: PrebuiltIo,
	opts: { timeoutMs: number; pollMs?: number },
): Promise<PrebuiltResult> {
	const pollMs = opts.pollMs ?? 1000;
	const started = io.now();
	if (!io.sendOrder()) {
		io.log("[agent] prebuilt: blueprint order REFUSED by the GS - scenario not set up");
		return { ready: false, reason: "order_refused", waitedSamples: 0 };
	}
	io.log("[agent] prebuilt: blueprint sent; waiting for an operable route…");
	let waitedSamples = 0;
	for (;;) {
		const s = io.snapshot();
		waitedSamples++;
		if (isPrebuiltReady(s)) {
			io.log(
				`[agent] prebuilt: ready after ${waitedSamples} sample(s) ` +
					`(stations=${s.stations}, vehicles=${s.vehicles})`,
			);
			return { ready: true, reason: "ready", waitedSamples };
		}
		if (io.now() - started >= opts.timeoutMs) {
			io.log(
				`[agent] prebuilt: TIMEOUT after ${waitedSamples} sample(s) ` +
					`(stations=${s.stations}, vehicles=${s.vehicles}) - this run is NOT a valid measurement`,
			);
			return { ready: false, reason: "timeout", waitedSamples };
		}
		await io.sleep(pollMs);
	}
}

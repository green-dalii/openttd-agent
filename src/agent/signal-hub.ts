/* eslint-disable no-console -- intentional runtime logging */
/**
 * Signal hub — the GS/admin event consumer (REFACTOR Phase B-3).
 *
 * 职责: 接收 AdminClient 的 `onEvent` 回调，统一处理：
 *   - world.ingest（规范化事件写世界状态）
 *   - web.publishEvent / session.appendEvent（dashboard 与 session 记账）
 *   - GS gamescript 通道（towns、状态采样、ack/err、exec 阶段）
 *   - executor phase 事件（§10.45 类型化 → stage gate + 账本 markDone）
 *   - company_stats notable 事件（决策触发）
 *
 * 提取原则: 1:1 搬迁 runner.ts 原 onEvent 块，零行为变更；测试零改动
 *   全绿是 "行为不变"的机械证明（与 B-1/B-2 同守则）。
 * 禁止: 决策（调度属 decision-loop）；signal 不在这里等待时间，
 *   只做事件→状态变化的事实记账。
 */
import type { GameEvent } from "../types.js";
import type { WorldState } from "../game/world-state.js";
import type { RouteLedger } from "./route-ledger.js";
import { createExecutorProgress, type ExecutorProgressReport } from "./executor-progress.js";
import { createExecutorErrorAssembler, decodeExecutorPhase, type ExecutorErrorMessage } from "../game/executor-status.js";
import { gameDayFromRawDate, convertDateToYmd } from "../game/payload-parsers.js";
import type { WebServer } from "../web/server.js";
import type { RouteStats } from "./route-stats.js";
import type { SessionStore } from "./session-store.js";

export interface SignalHubRefs {
	world: WorldState;
	/** Lazy: web starts null (no dashboard yet during boot). */
	getWeb(): WebServer | null;
	/** Lazy: session starts null during boot; replays via replayBootEvents(). */
	getSession(): SessionStore | null;
	routeLedger: RouteLedger;
	/** Source of truth for the current decision count (decision-loop in B-4). */
	getDecisionCount(): number;
	/** Wake the decision loop on a meaningful phase change (story gate). */
	onPhaseChange(phase: string): void;
	/** Wake the decision loop on a fleet/station change. */
	onNotableEvent(summary: string): void;
}

export interface SignalHub {
	onEvent(ev: GameEvent): void;
	/** Number of state events seen from the GS (proves the GS is ticking). */
	getGsCount(): number;
	/**
	 * GS replies that came back as errors (`kind:"err"`).
	 *
	 * Channel health, recorded per run because the failure is PARTIAL: a bad GS
	 * API call fails one request kind and leaves the rest working, at a rate that
	 * varies per run. SPEC §10.66 - 17 of 17 runs hit `IsStationTile` errors,
	 * ranging from 2 to 152, and nothing in the verdict showed it; the
	 * comparisons silently absorbed a degraded channel.
	 */
	getGsErrors(): number;
	/**
	 * Construction progress as FACTS (G2, SPEC §10.67 layer 3): tiles still to go,
	 * measured tiles per game day, ETA, and how long the road has NOT advanced.
	 * The episode is decided by this process, so the agent must be able to see it
	 * instead of polling a black box (measured: 193 tool calls in one episode).
	 */
	getExecutorProgress(): ExecutorProgressReport;
	/**
	 * Simulated day from the GS's own clock (raw date, ~every 3 game days), or
	 * null before the first GS state. Finer than the admin Date subscription,
	 * which is MONTHLY - the episode horizon needs the finer source.
	 */
	getGameDay(): number | null;
	/**
	 * The world clock as a FACT (W2): when the GS's own date last **advanced**,
	 * and how long ago that was. `frozenForMs === null` means "no GS date has
	 * ever been seen" — that is *unknown*, not "frozen" (null ≠ 0).
	 *
	 * Why the GS channel and not the admin `date` packet: measured on a real
	 * 90 s run, the admin date packet arrives ONCE, while the GS `state`
	 * report carries a fresh date every 200 script ticks (~3 game days). A
	 * freeze detector on the admin packet would see one sample and call
	 * everything frozen.
	 */
	getWorldClock(): { rawDate: number | null; lastAdvancedAtMs: number | null; frozenForMs: number | null };
	/**
	 * The executor's last **complete** exception text (2026-09-25, SPEC §10.103),
	 * reassembled from the producer's chunks. `null` = this run has not reported
	 * one — not "an empty error".
	 */
	getExecutorError(): ExecutorErrorMessage & { at: number } | null;
	/** Current executor stage, e.g. "boot" / "road" / "done" / "error". */
	getStage(): string;
	/** Last raw phase string (for the dashboard / RESULT line). */
	getPhase(): string;
	getReachedDone(): boolean;
	/** Drain events buffered during boot into the session. */
	replayBootEvents(session: SessionStore): void;
	/**
	 * Latest economics per route (NEXT-2 N2-1). GS sends raw readings every
	 * 200 ticks; the hub keeps the newest per job. Derived rates live in
	 * route-stats.ts so the arithmetic stays unit-testable.
	 */
	getRouteStats(): RouteStats[];
	/** Used by the decision loop to detect fleet/station deltas. */
	prevStats(): { vehicles: number; stations: number } | null;
	/** Last ack payload for build_bus_route (kept for the stage-view snapshot). */
	getLastRoute(): Record<string, unknown> | null;
}

/** Max events buffered before a session exists (early-connect frames). */
const BOOT_EVENT_CAP = 256;

export function makeSignalHub(refs: SignalHubRefs): SignalHub {
	const bootEvents: GameEvent[] = [];
	let gsStates = 0;
	/** GS error replies (channel health, SPEC §10.66). */
	let gsErrors = 0;
	let executorStage = "";
	let executorPhase = "";
	/** Raw OpenTTD date from the GS state channel (fine-grained episode clock). */
	let gsRawDate: number | null = null;
	/**
	 * W2: wall-clock ms of the last date **change** (not the last packet).
	 * The distinction is the whole feature: a channel that keeps delivering the
	 * same date is exactly what a frozen world looks like, and until this was
	 * recorded the repository had no way to tell the two apart — "the world did
	 * not advance" existed only as page copy.
	 */
	let lastDateAdvancedAtMs: number | null = null;
	/**
	 * Executor exception text, reassembled here (the hub is the single writer: it
	 * is the only place that sees every `exec` relay in order).
	 *
	 * The producer sends `exc<seq><marker><chunk>` because the company name — its
	 * only proven channel — is capped at 31 characters (measured: 31 accepted,
	 * 32+ silently rejected). The chunks are fed `p.raw`, NOT the decoded phase:
	 * the decoder's own suffix handling can eat a chunk's trailing space, and a
	 * missing space turns "cannot join" into "cannotjoin" (a confidently wrong
	 * error message is worse than none).
	 */
	const executorErr = createExecutorErrorAssembler();
	let executorError: (ExecutorErrorMessage & { at: number }) | null = null;
	const executorProgress = createExecutorProgress();
	/**
	 * Simulated day for progress maths. Same 360-day-year convention as the
	 * episode clock; only differences matter here, so the epoch is irrelevant.
	 */
	const gameDayNow = (): number => {
		const d = refs.world.snapshot().date;
		if (!d) return 0;
		return (d.year - 1950) * 360 + (d.month - 1) * 30 + (d.day - 1);
	};
	let reachedDone = false;
	let prevStats: { vehicles: number; stations: number } | null = null;
	let lastRoute: Record<string, unknown> | null = null;
	const routeStats = new Map<number, RouteStats>();

	/**
	 * The single path every event takes: world state → dashboard → session
	 * archive (or the boot buffer).
	 *
	 * It used to be inlined in `onEvent`. It is a named function now because the
	 * GS game clock is **synthesized** into a real `date` event below, and that
	 * event must reach exactly the same three places — a second, slightly
	 * different prologue is how a fact ends up on the page but not in the
	 * archive (MEMORY.md C1/D56).
	 */
	function recordEvent(ev: GameEvent): void {
		refs.world.ingest(ev);
		// Forward to the dashboard. The `--watch` runner has always done this
		// (src/game/runner.ts) but the agent path did not, so during `--agent`
		// - the main mode - the page received NO event frames at all: its
		// company mirror and history never advanced, and the KPIs stayed frozen
		// at whatever the connect-time snapshot said until a manual reload.
		// Same shape as the toWireSnapshot bug (MEMORY.md C1): two paths, one of
		// them missing a piece, and the other path "looking fine" hid it.
		refs.getWeb()?.publishEvent(ev);
		const session = refs.getSession();
		if (session) session.appendEvent(ev);
		else if (bootEvents.length < BOOT_EVENT_CAP) bootEvents.push(ev);
	}

	return {
		onEvent(ev) {
			recordEvent(ev);
			if (ev.kind === "gamescript") {
				const p = ev.payload as Record<string, unknown>;
				if (p.cmd === "state") {
					gsStates++;
					// W2: only a date **change** is the world advancing. The same
					// packet arriving again says nothing, and treating it as
					// progress is what would hide a frozen world.
					if (typeof p.date === "number") {
						if (p.date !== gsRawDate) {
							lastDateAdvancedAtMs = Date.now();
							// The GS clock is the only **fine-grained** date we get (the
							// admin DATE packet is Monthly — see WorldState.setDateFromRaw).
							// Turn each advance into a real `date` event so every consumer
							// of that event kind sees the world clock: the page's
							// world-rate tile, the agent's `observe`, the episode maths and
							// the session archive. `source:"gs"` records the origin — it is
							// an observation of OpenTTD's clock, not an admin packet, and
							// the archive must not pretend otherwise.
							//
							// 失败**不许**连坐：这一段里有 IO（归档写文件），抛出去会把
							// 同一份 state 里的城镇/产业/运量事实一起带走（SPEC §10.66 的
							// `IsStationTile` 就是这个形状：一处坏、整条通道按局退化）。
							// 所以它自己兜住，并且**说出来**（不静默）。
							try {
								refs.world.setDateFromRaw(p.date);
								recordEvent({
									seq: 0,
									kind: "date",
									ts: Date.now(),
									payload: { raw: p.date, ...convertDateToYmd(p.date), source: "gs" },
								} as unknown as GameEvent);
							} catch (e) {
								console.warn(`[agent] GS game clock update failed: ${e instanceof Error ? e.message : String(e)}`);
							}
						}
						gsRawDate = p.date;
					}
					// The GS owns the town list; the agent only reads it. Without
					// this the agent could not see the options it was choosing
					// between, which is what made the M3 experiment saturated
					// (SPEC §10.32).
					if (Array.isArray(p.town_list)) {
						refs.world.setTowns(
							(p.town_list as { id?: unknown; pop?: unknown; x?: unknown; y?: unknown; tc?: unknown }[]).map((t) => ({
								id: Number(t.id),
								population: Number(t.pop),
								x: Number(t.x),
								y: Number(t.y),
								// 主货种（GS 取该镇产量最高的 1–2 个）；形状不对就当没有这条事实。
								...(Array.isArray(t.tc)
									? {
											cargo: (t.tc as { label?: unknown; produced?: unknown; transported?: unknown }[]).map((c) => ({
												label: String(c.label ?? ""),
												produced: Number(c.produced) || 0,
												transported: Number(c.transported) || 0,
											})),
										}
									: {}),
							})),
							// `towns` 是 GS 报的**总数**（`town_list` 只是人口前 10 的取样）。
							typeof p.towns === "number" ? (p.towns as number) : undefined,
						);
					}
					// Sample the GS's own clock. This is the only way to tell
					// "the game is not running" from "the executor is not
					// looping": the GS sends these every 200 ticks, so if the
					// DATE does not advance, the game is stopped; if the date
					// advances but the executor stays silent, the executor is
					// starved of script ticks (ROADMAP 4b follow-up).
					// 产业/货种（P1）：GS 发的是**原始计数**；比率由前端派生，
					// 因为"利用率"有两种口径（SPEC §10.99）。
					if (Array.isArray(p.industry_list)) {
						refs.world.setIndustries(
							(p.industry_list as { id?: unknown; cargo?: unknown; name?: unknown; produced?: unknown; transported?: unknown; stock?: unknown }[]).map((i) => ({
								id: Number(i.id),
								cargo: String(i.cargo ?? ""),
								name: String(i.name ?? ""),
								produced: Number(i.produced),
								transported: Number(i.transported),
								stock: i.stock === null || i.stock === undefined ? null : Number(i.stock),
							})),
							// `industries` 是总数（`industry_list` 只是按产量取样的前 N 个）。
							typeof p.industries === "number" ? (p.industries as number) : undefined,
						);
					}
					if (Array.isArray(p.cargo_totals)) {
						refs.world.setCargoTotals(
							(p.cargo_totals as { label?: unknown; produced?: unknown; transported?: unknown }[]).map((c) => ({
								label: String(c.label ?? ""),
								produced: Number(c.produced) || 0,
								transported: Number(c.transported) || 0,
							})),
						);
					}
					// 公司口径（P2）：本会话累计（monitor）+ 游戏季度总量。
					// 缺字段时**不调用** setter：老 GS 与新 harness 混跑时不能清空已知事实。
					if (Array.isArray(p.own_delivered) || typeof p.own_quarter === "number" || p.own_monitored !== undefined) {
						refs.world.setCompanyCargo({
							byCargo: Array.isArray(p.own_delivered)
								? (p.own_delivered as { label?: unknown; amount?: unknown }[]).map((c) => ({
										label: String(c.label ?? ""),
										amount: Number(c.amount) || 0,
									}))
								: [],
							quarterDelivered: typeof p.own_quarter === "number" ? (p.own_quarter as number) : null,
							monitored: (() => {
								const m = p.own_monitored as { towns?: unknown; industries?: unknown } | undefined;
								if (!m || typeof m !== "object") return null;
								return { towns: Number(m.towns) || 0, industries: Number(m.industries) || 0 };
							})(),
						});
					}
					if (gsStates % 5 === 1) {
						console.log(
							`[agent] GS state #${gsStates} date=${String(p.date)} towns=${String(p.towns)} signs=${String(p.signs)}`,
						);
					}
				}
				else {
					if (p.kind === "err") gsErrors++;
					console.log(`[agent] GS: ${JSON.stringify(p)}`);
					// Executor phase events: the PRIMARY phase source (GS relay,
					// on-change every ~20 ticks). Replaces the company-name regex
					// decode retired in A3.
					if (p.kind === "exec") {
						// Reassemble a chunked exception before anything else looks at
						// the phase: an incomplete run must not be shown as a message.
						const assembled = executorErr.push(String(p.raw ?? ""), Date.now());
						if (assembled) executorError = { ...assembled, at: Date.now() };
						const stage = String(p.stage);
						const job = Number(p.job);
						if (stage === "done" && job >= 0) {
							refs.routeLedger.markDone(
								job,
								refs.getSession()?.current().checkpoints.at(-1)?.gameDate,
							);
						}
						// Every exec phase feeds the progress meter - heartbeats too:
						// they carry `#n s<seg>` and are the only signal while the
						// pathfinder is searching (no stage change to report).
						{
							const d = decodeExecutorPhase(String(p.raw));
							executorProgress.observe({
								gameDay: gameDayNow(),
								job: d.job ?? Number(p.job ?? -1),
								...(d.detail && typeof d.detail.segment === "number"
									? { segment: d.detail.segment }
									: {}),
								// `d<dist>` from the Squirrel source = tiles STILL TO GO.
								...(d.detail && typeof d.detail.distance === "number"
									? { remainingTiles: d.detail.distance }
									: {}),
								...(d.detail && typeof d.detail.retry === "number"
									? { step: d.detail.retry }
									: {}),
							});
						}
						// Stage change or an error phase is news; a heartbeat never is.
						if (!p.hb && (stage !== executorStage || stage === "error")) {
							executorStage = stage;
							executorPhase = String(p.raw);
							if (stage === "done") reachedDone = true;
							console.log(`[agent] executor phase -> "${p.raw}"`);
							refs.onPhaseChange(String(p.raw));
						}
					}
					// Route economics (N2-1): the first signal that lets a choice
					// be judged by its RESULT rather than by whether it finished.
					// Stored, not broadcast - it changes every 200 ticks, and a
					// value that always changes is not news (MEMORY §0b).
					if (p.kind === "route-stats") {
						const job = Number(p.job);
						if (Number.isInteger(job)) {
							const numOrUndef = (v: unknown): number | undefined => {
								const n = Number(v);
								return Number.isFinite(n) ? n : undefined;
							};
							routeStats.set(job, {
								job,
								vehicles: Number(p.vehicles) || 0,
								profit: Number(p.profit) || 0,
								waiting: Number(p.waiting) || 0,
								gameDate: Number(p.gameDate) || 0,
								// 去重所需：车辆 id + 两端站号 + 逐站等待（-1 = 不可得，
								// 保持 undefined 而不是 0 —— "这一端不是客运站"不是"零人"）。
								...(Array.isArray(p.vehiclesIds)
									? { vehiclesIds: p.vehiclesIds.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v)) }
									: {}),
								...(numOrUndef(p.endsA) !== undefined ? { endsA: numOrUndef(p.endsA) } : {}),
								...(numOrUndef(p.endsB) !== undefined ? { endsB: numOrUndef(p.endsB) } : {}),
								...(numOrUndef(p.waitA) !== undefined ? { waitA: numOrUndef(p.waitA) } : {}),
								...(numOrUndef(p.waitB) !== undefined ? { waitB: numOrUndef(p.waitB) } : {}),
							});
						}
					}
					// Remember the coordinates the executor acknowledged, so each
					// stage snapshot can draw the actual built route.
					if (p.kind === "ack" && p.cmd === "build_bus_route") {
						lastRoute = p;
						refs.routeLedger.record({
							job: Number(p.job),
							fromTown: Number(p.townA),
							toTown: Number(p.townB),
							decision: refs.getDecisionCount(),
							orderedAt: Date.now(),
						});
					}
				}
			}
			// rcon replies (2026-09-17): before this channel existed, every rcon was
			// fire-and-forget, so a failed save or a pause that never took effect
			// was indistinguishable from success in the logs.
			if (ev.kind === "rcon") {
				const p = ev.payload as { command?: string | null; message?: string };
				console.log(`[agent] rcon ${p.command ?? "?"}: ${p.message ?? ""}`);
			}
			// Notable events (fleet/station changes) are worth the model's
			// attention, so they open a decision window (scheduler throttles).
			if (ev.kind === "company_stats") {
				const st = ev.payload as { vehicles?: number; stations?: number };
				const dv = (st.vehicles ?? 0) - (prevStats?.vehicles ?? 0);
				const ds = (st.stations ?? 0) - (prevStats?.stations ?? 0);
				const parts: string[] = [];
				if (dv) parts.push(`vehicles ${dv > 0 ? "+" : ""}${dv}`);
				if (ds) parts.push(`stations ${ds > 0 ? "+" : ""}${ds}`);
				const summary = parts.length ? parts.join(", ") : null;
				prevStats = { vehicles: st.vehicles ?? 0, stations: st.stations ?? 0 };
				if (summary) refs.onNotableEvent(summary);
			}
		},
		getGsCount: () => gsStates,
		getGsErrors: () => gsErrors,
		getExecutorProgress: () => executorProgress.report(gameDayNow()),
		getGameDay: () => (gsRawDate !== null ? gameDayFromRawDate(gsRawDate) : null),
		getWorldClock: () => ({
			rawDate: gsRawDate,
			lastAdvancedAtMs: lastDateAdvancedAtMs,
			frozenForMs: lastDateAdvancedAtMs === null ? null : Date.now() - lastDateAdvancedAtMs,
		}),
		getExecutorError: () => executorError,
	getStage: () => executorStage,
		getPhase: () => executorPhase,
		getReachedDone: () => reachedDone,
		prevStats: () => prevStats,
		getLastRoute: () => lastRoute,
		getRouteStats: () => [...routeStats.values()].sort((a, b) => a.job - b.job),
		replayBootEvents(session) {
			for (const ev of bootEvents) session.appendEvent(ev);
			bootEvents.length = 0;
		},
	};
}
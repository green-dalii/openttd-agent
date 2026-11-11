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
import { decodeExecutorPhase, type ExecutorErrorMessage } from "../game/executor-status.js";
import { gameDayFromRaw, gameDayFromYmd, rawToYmd } from "../game/calendar.js";
import type { WebServer } from "../web/server.js";
import type { RouteStats } from "./route-stats.js";
import {
	attributeFreightDeliveries,
	type FreightAttributionResult,
} from "./freight-attribution.js";
import type { SessionStore } from "./session-store.js";

/**
 * Compose the phase string the decoder understands from a typed exec event.
 *
 * The typed GS event carries `note` (e.g. "rd s0 r13 d55 p0") and `job`
 * separately; the decoder expects the historical single string
 * ("EX <note> j<job>"). Returns "" when there is nothing to report.
 */
export function composePhaseText(raw: unknown, note: unknown, job: number): string {
	const rawText = typeof raw === "string" ? raw.trim() : "";
	if (rawText !== "" && rawText !== "undefined") return rawText;
	const noteText = typeof note === "string" ? note.trim() : "";
	if (noteText === "") return "";
	// Some notes already carry the job suffix ("work j100"); do not add it twice
	// (the decoder strips only the trailing one, leaving "work j100" as the
	// phase text).
	const hasJob = /\s+j-?\d+\s*$/.test(noteText);
	const jobSuffix = !hasJob && Number.isFinite(job) && job >= 0 ? ` j${job}` : "";
	return `EX ${noteText}${jobSuffix}`;
}

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
	/**
	 * 货运 F4（A4）：把逐 (货种, 产业) 的交付读数归到**我们的一条线**上。
	 *
	 * 归因值是**推导值**（引擎不记“哪辆车送到了哪”）⇒ 报告与页面必须标明它是
	 * 推导的；分不出来时给 `null` + 原因，不许猜。
	 */
	getFreightAttribution(): FreightAttributionResult;
	/** Used by the decision loop to detect fleet/station deltas. */
	prevStats(): { vehicles: number; stations: number } | null;
	/** Last ack payload for build_bus_route (kept for the stage-view snapshot). */
	getLastRoute(): Record<string, unknown> | null;
}

/** Max events buffered before a session exists (early-connect frames). */
const BOOT_EVENT_CAP = 256;

/**
 * 计数事实的缺失语义（D60）：**缺失/负值 → null，绝不折叠成 0**。
 *
 * 为什么：OpenTTD 的产业读数里 `-1` 是「该产业不涉此货」= 不适用。
 * 折叠成 0 就是捏造「运了 0 吨」（探针实测一个采样期 548 个负读数被这样折叠）。
 * `null ≠ 0` 是本仓库红线；`0` 只能是量出来的 0。
 */
function rawCount(v: unknown): number | null {
	// `null` 是 GS 自己的「不适用」编码（`main.nut`：负读数 → null），**不能**折成 0
	// —— `Number(null)` 恰好是 0，于是「这个产业不产这种货」会变成「运了 0 吨」
	//（D60/D76）。缺席（undefined）与空串同理。
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 会**拒绝模型命令**的 GS 命令：它们的拒绝必须让模型看见。
 *
 * 只收"模型发得出去、可能被拒"的命令；GS 内部的异常（route-stats 之类）
 * 不进这个集合 —— 那是 harness 自己的问题，不该占用模型的注意力。
 */
const COMMAND_REFUSALS = new Set([
	"build_bus_route",
	"build_freight_route",
	"set_route_cargo",
	"set_route_engine",
	"set_route_vehicles",
	"add_vehicles",
	"retire_route",
]);

export function makeSignalHub(refs: SignalHubRefs): SignalHub {
	const bootEvents: GameEvent[] = [];
	let gsStates = 0;
	/** GS error replies (channel health, SPEC §10.66). */
	let gsErrors = 0;
	/** 上一次报给模型的命令拒绝（去重：同一个拒绝不重复吵模型）。 */
	let lastRefusal = "";
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
	let executorError: (ExecutorErrorMessage & { at: number }) | null = null;
	const executorProgress = createExecutorProgress();
	/**
	 * Simulated day for progress maths. The game's calendar is the engine's
	 * calendar (see `src/game/calendar.ts`); only differences matter here, so
	 * the epoch is irrelevant.
	 */
	const gameDayNow = (): number => {
		const d = refs.world.snapshot().date;
		if (!d) return 0;
		return gameDayFromYmd(d.year, d.month, d.day);
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
									payload: { raw: p.date, ...rawToYmd(p.date), source: "gs" },
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
					// **观测策略**（2026-11-02）：GS 自己报它暴露了世界的哪一部分
					// （towns=all / industries=top12）。这是**观测面的事实**：策略不同 ⇒
					// 两次运行回答的不是同一个问题。GS 不报就是"没测到"（null），不是"全部"。
					if (typeof p.towns_policy === "string" || typeof p.industries_policy === "string") {
						const parts: string[] = [];
						if (typeof p.towns_policy === "string" && p.towns_policy.trim() !== "") {
							parts.push(`towns=${p.towns_policy.trim()}`);
						}
						if (typeof p.industries_policy === "string" && p.industries_policy.trim() !== "") {
							parts.push(`industries=${p.industries_policy.trim()}`);
						}
						refs.world.setObservationPolicy(parts.length ? parts.join(";") : null);
					}
					// **融资事实**（2026-11-02，Issue #13）：贷款上限 + 贷款的最小单位。
					// 利息率**引擎不暴露** ⇒ 不在这里编（"没测到"就是没测到）。
					if (p.loan_ceiling !== undefined || p.loan_interval !== undefined) {
						refs.world.setFinancing(
							typeof p.loan_ceiling === "number" ? p.loan_ceiling : null,
							typeof p.loan_interval === "number" ? p.loan_interval : null,
						);
					}
					if (Array.isArray(p.town_list)) {
						refs.world.setTowns(
							(p.town_list as { id?: unknown; name?: unknown; pop?: unknown; x?: unknown; y?: unknown; tc?: unknown }[]).map((t) => ({
								id: Number(t.id),
								// 名字（2026-09-25）：GS 侧 `GSTown.GetName` 已真机验证。
								// 空串保持空串，**不**把缺失写成 id 字符串 —— 那是编造。
								...(typeof t.name === "string" && t.name.trim() !== "" ? { name: t.name.trim() } : {}),
								population: Number(t.pop),
								x: Number(t.x),
								y: Number(t.y),
								// 主货种（GS 取该镇产量最高的 1–2 个）；形状不对就当没有这条事实。
								...(Array.isArray(t.tc)
									? {
											cargo: (t.tc as { label?: unknown; produced?: unknown; transported?: unknown }[]).map((c) => ({
												label: String(c.label ?? ""),
												produced: rawCount(c.produced),
												transported: rawCount(c.transported),
											})),
										}
									: {}),
							})),
							// `towns` 是 GS 报的**总数**（`town_list` 自 2026-11-02 起是**全部**城镇）。
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
								produced: rawCount(i.produced),
								transported: rawCount(i.transported),
								stock: rawCount(i.stock),
							})),
							// `industries` 是总数（`industry_list` 只是按产量取样的前 N 个）。
							typeof p.industries === "number" ? (p.industries as number) : undefined,
						);
					}
					if (Array.isArray(p.engines)) {
						// P1-2：可选车型目录（id/名字/速度/**能拉什么货**）——agent 要看得见选项才可能做选择。
						refs.world.setEngines(
							(p.engines as { id?: unknown; name?: unknown; speed?: unknown; cargo?: unknown }[])
								.filter((e) => Number.isInteger(Number(e.id)))
								.map((e) => ({
									id: Number(e.id),
									name: String(e.name ?? ""),
									speed: Number(e.speed) || 0,
									// 货运 F1：车型能拉的货（`GSEngine.GetCargoType`）。
									// null = 引擎没报（**不是**"什么都拉"）。
									cargo: typeof e.cargo === "string" && e.cargo !== "" ? e.cargo : null,
								})),
						);
					}
					// 货运 F1：全部产业的**位置与名字**（GS 的 `industry_index`）。
					// 线路要选"哪座矿 → 哪座厂" ⇒ 没坐标就选不了。
					if (Array.isArray(p.industry_index)) {
						refs.world.setIndustrySites(
							(p.industry_index as { id?: unknown; name?: unknown; x?: unknown; y?: unknown }[])
								.filter((s) => Number.isFinite(Number(s.id)))
								.map((s) => ({
									id: Number(s.id),
									name: String(s.name ?? ""),
									x: Number(s.x) || 0,
									y: Number(s.y) || 0,
								})),
						);
					}
					// 货运 F1：货种目录（哪些货是货运、谁产、谁收）——引擎算出的事实。
					if (Array.isArray(p.cargo_catalog)) {
						refs.world.setCargoCatalog(
							(p.cargo_catalog as {
								label?: unknown;
								freight?: unknown;
								producers?: unknown;
								consumers?: unknown;
							}[]).map((c) => ({
								label: String(c.label ?? ""),
								freight: c.freight === true,
								producers: Array.isArray(c.producers) ? c.producers.map(Number) : [],
								consumers: Array.isArray(c.consumers) ? c.consumers.map(Number) : [],
							})),
						);
					}
					// 货运 F3：**能装货的产方**（GS 的 `freight_links`）。
					// 车站收什么货是引擎按集货区算的 ⇒ "这里有煤"不等于"这里能装煤"。
					// 没有这条事实，模型会反复提出根本装不上货的线路。
					if (Array.isArray(p.freight_links)) {
						refs.world.setFreightLinks(
							(p.freight_links as { cargo?: unknown; producer?: unknown }[])
								.filter((l) => typeof l.cargo === "string" && l.cargo !== "" && Number.isFinite(Number(l.producer)))
								.map((l) => ({ cargo: String(l.cargo), producer: Number(l.producer) })),
						);
					}
					if (Array.isArray(p.cargo_totals)) {
						refs.world.setCargoTotals(
							(p.cargo_totals as { label?: unknown; produced?: unknown; transported?: unknown }[]).map((c) => ({
								label: String(c.label ?? ""),
								produced: rawCount(c.produced),
								transported: rawCount(c.transported),
							})),
						);
					}
					// 公司口径（货运 F2）：本会话累计（monitor 的**单轴**：货运交付到产业）
					// + 游戏季度总量 + 计量缺口。
					// 缺字段时**不调用** setter：老 GS 与新 harness 混跑时不能清空已知事实。
					if (Array.isArray(p.own_delivered) || typeof p.own_quarter === "number" || p.own_monitored !== undefined || p.own_gaps !== undefined || Array.isArray(p.own_by_industry)) {
						refs.world.setCompanyCargo({
							byCargo: Array.isArray(p.own_delivered)
								? (p.own_delivered as { label?: unknown; amount?: unknown }[]).map((c) => ({
										label: String(c.label ?? ""),
										amount: Number(c.amount) || 0,
									}))
								: [],
							// 货运 F4（A3）：逐 (货种, 产业) 的累计——归因的原料。
							// 旧 GS 不报这个字段 ⇒ 空数组（**不是**“每条都是 0”）。
							byIndustry: Array.isArray(p.own_by_industry)
								? (p.own_by_industry as { label?: unknown; industry?: unknown; amount?: unknown }[]).map((r) => ({
										label: String(r.label ?? ""),
										industry: Number(r.industry),
										amount: Number(r.amount) || 0,
									}))
								: [],
							quarterDelivered: typeof p.own_quarter === "number" ? (p.own_quarter as number) : null,
							monitored: (() => {
								const m = p.own_monitored as { cargoes?: unknown; destinations?: unknown } | undefined;
								if (!m || typeof m !== "object") return null;
								// 旧 GS 报的是「地图上有几座城/几个产业」，那不是监视范围 ⇒ 缺新字段
								// 就当**没有口径**，不能报 0（那等于说"一个目的地都没监视"）。
								const cargoes = Number(m.cargoes);
								if (!Number.isFinite(cargoes)) return null;
								const destinations = Number(m.destinations);
								return { cargoes, destinations: Number.isFinite(destinations) ? destinations : 0 };
							})(),
							gaps: (() => {
								const g = p.own_gaps as { dropped?: unknown; error?: unknown } | undefined;
								if (!g || typeof g !== "object") return null;
								const dropped = Number(g.dropped);
								if (!Number.isFinite(dropped)) return null;
								// 读失败时的错误全文（D95：失败不许静默）；没有错误就**不出现**这个键。
								const error = typeof g.error === "string" && g.error !== "" ? g.error : "";
								return { dropped, ...(error ? { error } : {}) };
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
					// **命令被拒绝 ⇒ 模型必须看见原因**（货运 F3）。
					//
					// 以前 GS 的 `err` 只进计数器与日志 ⇒ 模型以为命令发出去了，
					// 于是反复发同一个根本建不成的命令（D20 那一族：静默失败让模型
					// 学错因果）。货运的拒绝理由尤其多（货种不对 / 产方不产 /
					// 收方不收 / 附近没有能装货的车站）⇒ 不给理由，模型只能乱试。
					//
					// 只报**命令类**的拒绝：route-stats 之类的内部异常不该吵模型。
					if (p.kind === "err" && typeof p.cmd === "string" && COMMAND_REFUSALS.has(p.cmd)) {
						const reason = typeof p.reason === "string" ? p.reason : "no reason given";
						const line = `the game refused ${p.cmd}: ${reason}`;
						if (line !== lastRefusal) {
							lastRefusal = line;
							refs.onNotableEvent(line);
						}
					}
					// 推送事件（Issue #13 S7d）：引擎的事件原本被 GS 整个丢掉 ⇒
					// 模型看不到"车到了 / 车没了"。这里落进世界状态 ⇒ 进观测面。
					if (p.kind === "game_event") {
						const kind = String(p.event ?? "");
						// **null 不折成 0**（D60）：`Number(null) === 0` 是个陷阱。
						const num = (v: unknown): number | null => {
							if (v === null || v === undefined || v === "") return null;
							const n = Number(v);
							return Number.isFinite(n) ? n : null;
						};
						try {
							refs.world.pushWorldEvent({
								kind,
								vehicle: num(p.vehicle),
								station: num(p.station),
								industry: num(p.industry),
								town: num(p.town),
							});
						} catch (e) {
							console.warn(`[agent] game event dropped: ${e instanceof Error ? e.message : String(e)}`);
						}
						// 决策→结果台账（Issue #13）：推事件挂到**它那条线**上，
						// 于是"这个决策带来了什么"有了世界侧的证据（不只是"执行器说建好了"）。
						try {
							const d = refs.world.snapshot().date;
							const dateStr = d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : undefined;
							refs.routeLedger.noteVehicleEvent(num(p.vehicle), kind, dateStr);
						} catch (e) {
							console.warn(`[agent] game event not attributed: ${e instanceof Error ? e.message : String(e)}`);
						}
					}
					// Executor phase events: the PRIMARY phase source (GS relay,
					// on-change every ~20 ticks). Replaces the company-name regex
					// decode retired in A3.
					if (p.kind === "exec") {
						// P1-1a：错误**全文**随类型化事件到达（31 字符分块协议已删除）。
						const errText = typeof p.error === "string" && p.error.trim() !== "" ? p.error : null;
						if (errText) executorError = { message: errText, truncated: false, complete: true, at: Date.now() };
						const stage = String(p.stage);
						const job = Number(p.job);
						// Archive the phase so the causal timeline can be rebuilt
						// from a FINISHED session (B3). The exec event used to
						// live only in the live stream: a past run's phases were
						// simply gone, so "what did this decision set in motion,
						// and what happened to it?" could only be answered while
						// watching. Heartbeats are skipped — they carry no news.
						if (!p.hb && Number.isInteger(job) && job >= 0) {
							refs.getSession()?.appendAudit({
								type: "gs_exec",
								ts: Date.now(),
								job,
								stage,
								phase: composePhaseText(p.raw, p.note, job),
							});
						}
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
							const d = decodeExecutorPhase(String(p.note ?? p.raw ?? ""));
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
							// D3a: the typed exec event carries `note` + `job`
							// (NOT a `raw` string - that field only existed in the
							// retired company-name protocol). Composing the phase
							// string here is what gives the decoder the job id, and
							// the model the phase that says WHICH of its orders
							// this is. Before this, the phase string was
							// "undefined" and every phase fact reached the model
							// as "executor reports: undefined".
							const phaseText = composePhaseText(p.raw, p.note, job);
							executorPhase = phaseText;
							if (stage === "done") reachedDone = true;
							console.log(`[agent] executor phase -> "${phaseText}"`);
							refs.onPhaseChange(phaseText);
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
							// 车辆 → 线路的归属（决策→结果台账的连接键）。
							// **用 `fleetIds`（执行器注册表里这条线自己的车队），不用
							// `vehiclesIds`**（那是"此刻站在两端站上的车"，共享车站时**别的线
							// 的车也在里面** ⇒ 会把事件归到错的线上）。
							if (Array.isArray(p.fleetIds)) {
								refs.routeLedger.recordVehicleJobs(
									job,
									p.fleetIds.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v)),
								);
							}
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
								// 车队真值（执行器注册表）：目标规模 + 归属 id。
								// 缺失保持 undefined（未计量 ≠ 空车队，D60）。
								...(Array.isArray(p.fleetIds)
									? { fleetIds: p.fleetIds.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v)) }
									: {}),
								...(Array.isArray(p.fleetDepot)
									? { fleetDepot: p.fleetDepot.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v)) }
									: {}),
								...(numOrUndef(p.fleetApplied) !== undefined ? { fleetApplied: numOrUndef(p.fleetApplied) } : {}),
								// P1-2 生效值：改装货物（标签）/车型（引擎 id）。缺失 = 未改装/未计量。
								...(typeof p.cargoApplied === "string" ? { cargoApplied: p.cargoApplied } : {}),
							// **这条线运的货**（F3 的看板要用）：客运线 = PASS，
							// 货运线 = COAL/GOOD/…（GS 自报；缺席 = 未计量）。
							...(typeof p.cargoCarried === "string" ? { cargoCarried: p.cargoCarried } : {}),
							// 货运 F4（A3）：货运线的**两端产业 id**（产方 / 收方）。
							// 缺席 = 客运线（不适用）⇒ 不补 0（0 是真的产业 id 0）。
							...(numOrUndef(p.fromIndustry) !== undefined ? { fromIndustry: numOrUndef(p.fromIndustry) } : {}),
							...(numOrUndef(p.toIndustry) !== undefined ? { toIndustry: numOrUndef(p.toIndustry) } : {}),
								...(numOrUndef(p.engineApplied) !== undefined ? { engineApplied: numOrUndef(p.engineApplied) } : {}),
								...(numOrUndef(p.endsA) !== undefined ? { endsA: numOrUndef(p.endsA) } : {}),
								...(numOrUndef(p.endsB) !== undefined ? { endsB: numOrUndef(p.endsB) } : {}),
								...(numOrUndef(p.waitA) !== undefined ? { waitA: numOrUndef(p.waitA) } : {}),
								...(numOrUndef(p.waitB) !== undefined ? { waitB: numOrUndef(p.waitB) } : {}),
							});
						}
					}
					// Remember the coordinates the executor acknowledged, so each
					// stage snapshot can draw the actual built route.
					//
					// 货运 ack（F3）也要进地图：看板画的是**最后一条线路**，货运线
					// 同样是"一条线"（两端是货车站，不是客运站）。
					if (p.kind === "ack" && (p.cmd === "build_bus_route" || p.cmd === "build_freight_route")) {
						lastRoute = p;
					}
					// 台账登记**两种**线路，但**用两种形状**（货运 F4 / A5）：
					// 客运线的两端是城镇，货运线的两端是**产业**（+ 货种）⇒ 显式
					// 分开，而不是把产业塞进城镇字段（那会变成 `null/null`，而它
					// **还进模型上下文**）。
					if (p.kind === "ack" && p.cmd === "build_bus_route") {
						refs.routeLedger.record({
							kind: "passenger",
							job: Number(p.job),
							fromTown: Number(p.townA),
							toTown: Number(p.townB),
							decision: refs.getDecisionCount(),
							orderedAt: Date.now(),
							// D3a/S4: the GS assigns the job id, so the ack is the
							// only place that knows which command this job is.
							command: String(p.cmd),
						});
					}
					if (p.kind === "ack" && p.cmd === "build_freight_route") {
						const job = Number(p.job);
						const fromIndustry = Number(p.producer);
						const toIndustry = Number(p.consumer);
						const cargo = String(p.cargo ?? "");
						// 端点/货种缺一不可（缺了就是半条事实）⇒ 不记，也不编。
						if (
							Number.isInteger(fromIndustry) &&
							Number.isInteger(toIndustry) &&
							cargo !== ""
						) {
							refs.routeLedger.record({
								kind: "freight",
								job,
								fromIndustry,
								toIndustry,
								cargo,
								decision: refs.getDecisionCount(),
								orderedAt: Date.now(),
								command: String(p.cmd),
							});
						}
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
		getGameDay: () => (gsRawDate !== null ? gameDayFromRaw(gsRawDate) : null),
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
		// 货运 F4（A4）：读数在**世界状态**里（monitor 累计），线路在**route-stats**
		// 里（GS 报的两端产业 id + 货种）⇒ 两者在这里相遇并归因。
		getFreightAttribution: () => {
			const readings = refs.world.snapshot().companyCargo?.byIndustry ?? [];
			const lines = [...routeStats.values()].map((r) => ({
				job: r.job,
				cargo: r.cargoCarried,
				fromIndustry: r.fromIndustry,
				toIndustry: r.toIndustry,
			}));
			return attributeFreightDeliveries(readings, lines);
		},
		replayBootEvents(session) {
			for (const ev of bootEvents) session.appendEvent(ev);
			bootEvents.length = 0;
		},
	};
}
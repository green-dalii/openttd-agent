/**
 * Pure helpers extracted from runner.ts (REFACTOR Phase B-1).
 *
 * 职责: 零副作用的纯函数与常量。它们是 runner 的工具集；
 *   测试覆盖已有（runner-freeze-thaw、scheduler、telemetry 等），
 *   抽出只搬运不改行为。
 * 禁止: 任何 IO/状态依赖；任何对 runner 内部变量的引用。
 */
import type { TelemetrySnapshot } from "./telemetry.js";
import type { SessionTotals } from "./session-store.js";
import type { AgentDeps } from "./types.js";
import type { Config } from "../config.js";

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Format a game date for session checkpoints ("unknown" when not observed). */
export function formatGameDate(d: { year: number; month: number; day: number } | null): string {
	if (!d) return "unknown";
	return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/**
 * Copy live telemetry into the session record's totals.
 * Single source of truth for both per-turn and final writes.
 */
export function totalsFromTelemetry(
	prev: SessionTotals,
	t: TelemetrySnapshot,
	events: number,
): SessionTotals {
	const u = t.usage.total;
	return {
		events,
		decisions: t.totals.decisions,
		toolCalls: t.totals.toolCalls,
		toolFailures: t.totals.toolFailures,
		usage: {
			input: u.input,
			output: u.output,
			cacheRead: u.cacheRead,
			cacheWrite: u.cacheWrite,
			reasoning: u.reasoning,
			totalTokens: u.totalTokens,
			costTotal: u.costTotal,
			// G6：累计值回答不了"离上下文窗口还有多远"，峰值才能。
			//
			// 宽容读取是**有意**的：`telemetry.json` 可能是旧版本写的（没有 `peakRequest`），
			// 而这个函数既用于实时快照、也用于从磁盘读回的记录。缺形状 = **未测量**
			// （undefined/null），绝不编造成 0——"没测到"与"测到 0"是两件事。
			// 生产侧真的填上了值，由 `runner-helpers.test.ts` 与真机数据（SPEC §10.83）保证。
			peakRequestTokens: t.usage.peakRequest?.tokens,
			peakRequestTurn: t.usage.peakRequest?.turn ?? null,
		},
	};
}

/**
 * Describe a fleet/station change worth the model's attention, or null when
 * nothing notable happened. Facts only - the model decides what it means.
 */
export function describeNotable(
	prev: { vehicles: number; stations: number } | null,
	now: { vehicles?: number; stations?: number },
): string | null {
	if (!prev) return null;
	const parts: string[] = [];
	const dv = (now.vehicles ?? 0) - prev.vehicles;
	const ds = (now.stations ?? 0) - prev.stations;
	if (dv) parts.push(`vehicles ${dv > 0 ? "+" : ""}${dv}`);
	if (ds) parts.push(`stations ${ds > 0 ? "+" : ""}${ds}`);
	return parts.length ? parts.join(", ") : null;
}

/** Game days elapsed since the first observed date, for interval scheduling. */
export function gameDaysSinceStart(deps: AgentDeps): number {
	const d = deps.state.snapshot().date;
	if (!d) return 0;
	return (d.year - 1950) * 360 + (d.month - 1) * 30 + (d.day - 1);
}

/** Comparable numbers for the next decision's delta. */
export function baselineOf(snap: ReturnType<AgentDeps["state"]["snapshot"]>, gameDay: number) {
	const c = snap.companies.get(0) ?? [...snap.companies.values()][0];
	return {
		money: Number(c?.economy?.money ?? 0) || 0,
		income: c?.economy ? Number(BigInt.asIntN(64, c.economy.income)) || 0 : 0,
		vehicles: c?.stats?.vehicles ?? 0,
		stations: c?.stats?.stations ?? 0,
		gameDay,
	};
}

/** Human-readable description of the selected brain (never includes the key). */
export function describeBrainSelection(cfg: Config): string {
	const src = cfg.llm.source === "catalog" ? "catalog" : cfg.llm.baseUrl ? "custom" : "catalog";
	const where = src === "custom" ? `base=${cfg.llm.baseUrl}` : `provider=${cfg.llm.providerId}`;
	return `${where} model=${cfg.llm.model} api=${cfg.llm.api}`;
}

/** How often to refresh the session heartbeat (docs/STARTUP-AND-LIFECYCLE.md §5). */
export const HEARTBEAT_MS = 2000;

/**
 * 存档文件名净化（2026-09-16）：session id 直接进 rcon 与文件名，必须安全。
 * 只允许 [A-Za-z0-9._-]，其余替换为 '-'；空结果兜底 "game"。
 */
export function savegameName(sessionId: string): string {
	const cleaned = String(sessionId ?? "").replace(/[^A-Za-z0-9._-]/g, "-");
	// 兜底不仅针对空串："---" 这类无字母数字的名字同样不可用（路径过滤后只剩分隔符）
	return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "game";
}

/**
 * 控制通道（暂停/恢复）——**投递必须可观测**。
 *
 * 为什么单独抽出来（2026-09-23 真机）：dashboard 的 Pause 曾经是
 * `try { client?.rcon("pause") } catch {}` —— 两个问题：
 *   ① 不 `await`：异步失败根本不会进入 catch，**空 catch 什么都抓不到**；
 *   ② 不记录结果：页面于是可以永远声称"已暂停"，而世界可能仍在运行。
 *
 * 事实依据（OpenTTD `src/console_cmds.cpp` 的 `ConPauseGame`/`ConUnpauseGame`）：
 *   - `pause` / `unpause` 是**幂等**命令（不是 toggle）；重复 `pause` 打印 "Game is already paused."；
 *   - **专用服务器（`_networking`）在首次 `pause` 时不打印任何东西** ——
 *     所以 `reply === ""` 是**正常**的，表示命令往返完成（收到 `RCON_END`）；
 *     而 `reply === null` 表示**超时**，即投递未获确认。
 *
 * 因此返回值把"投递"与"效果"分开：投递由回执证明，效果只能由世界证明
 *（暂停时游戏日期停止前进）。
 */
export interface ControlChannel {
	rconAwait?: (command: string, timeoutMs?: number) => Promise<string | null>;
}

export interface ControlOutcome {
	/** 命令往返是否完成（收到 RCON_END）。 */
	delivered: boolean;
	/** 游戏回显的文本；`""` = 命令无输出（对 pause/unpause 是正常的）。 */
	reply: string | null;
	/** 通道不可用或抛错时的原因（此时 `delivered = false`）。 */
	error?: string;
}

export async function sendControlCommand(
	ch: ControlChannel | null | undefined,
	cmd: "pause" | "unpause",
): Promise<ControlOutcome> {
	if (!ch || typeof ch.rconAwait !== "function") {
		return { delivered: false, reply: null, error: "no rcon channel" };
	}
	try {
		const reply = await ch.rconAwait(cmd);
		// `null` = 超时（rconAwait 的实现），不是"空输出"。
		return reply === null
			? { delivered: false, reply: null, error: "no reply (timeout)" }
			: { delivered: true, reply };
	} catch (e) {
		return { delivered: false, reply: null, error: e instanceof Error ? e.message : String(e) };
	}
}

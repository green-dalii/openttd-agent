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
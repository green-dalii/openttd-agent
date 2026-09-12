/**
 * Unit tests — the metrics ledger on disk.
 *
 * 职责: 锁定 JSONL 账本的**幂等性**与**容错性**，这两点会直接决定跨局统计是否可信。
 *
 * 为什么重要: 一局结束可能经多条路径落账（正常收尾 / 崩溃后 reconcile /
 *   强杀后补写）。若不去重，同一局会被算两次，让"进化曲线"凭空变好看 ——
 *   而那正是这个功能唯一的说服力来源。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	appendMetric,
	compactMetrics,
	evolutionDir,
	metricsPath,
	readMetrics,
} from "../../src/evolution/store.js";
import type { SessionMetaLike } from "../../src/evolution/metrics.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "evo-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function meta(over: Partial<SessionMetaLike> = {}): SessionMetaLike {
	return {
		id: "s1",
		mode: "agent",
		status: "completed",
		startedAt: 100,
		endedAt: 200,
		seed: 7,
		llm: { kind: "real" },
		outcome: { constructionDone: true, money: "1000" },
		totals: { usage: { totalTokens: 10, costTotal: 0.1 } },
		...over,
	};
}

describe("metrics ledger", () => {
	it("starts empty", () => {
		expect(readMetrics(dir)).toEqual([]);
	});

	it("appends and reads back a run", () => {
		appendMetric(dir, meta());
		const list = readMetrics(dir);
		expect(list).toHaveLength(1);
		expect(list[0]!.id).toBe("s1");
		expect(list[0]!.money).toBe(1000);
	});

	it("records what was injected, so the control arm is distinguishable", () => {
		appendMetric(dir, meta({ id: "with" }), { lessonsInjected: 3 });
		appendMetric(dir, meta({ id: "without" }));
		const byId = Object.fromEntries(readMetrics(dir).map((m) => [m.id, m]));
		expect(byId["with"]!.memory.lessonsInjected).toBe(3);
		expect(byId["without"]!.memory.lessonsInjected).toBe(0);
	});

	it("never counts the same run twice, even when re-recorded", () => {
		// The crash-then-reconcile path records a session a second time.
		appendMetric(dir, meta({ id: "s1" }));
		appendMetric(dir, meta({ id: "s1", status: "interrupted", outcome: {} }));
		const list = readMetrics(dir);
		expect(list).toHaveLength(1);
		// Last write wins: the reconciled record is the newer truth.
		expect(list[0]!.status).toBe("interrupted");
	});

	it("keeps runs ordered oldest-first for charting", () => {
		appendMetric(dir, meta({ id: "b", startedAt: 500 }));
		appendMetric(dir, meta({ id: "a", startedAt: 100 }));
		expect(readMetrics(dir).map((m) => m.id)).toEqual(["a", "b"]);
	});

	it("survives a corrupt line instead of losing the whole ledger", () => {
		appendMetric(dir, meta({ id: "good1" }));
		appendFileSync(metricsPath(dir), "{ this is not json\n", "utf8");
		appendMetric(dir, meta({ id: "good2", startedAt: 300 }));
		const list = readMetrics(dir);
		expect(list.map((m) => m.id)).toEqual(["good1", "good2"]);
	});

	it("survives an entry with no id", () => {
		mkdirSync(evolutionDir(dir), { recursive: true });
		writeFileSync(metricsPath(dir), JSON.stringify({ seed: 1 }) + "\n", "utf8");
		expect(readMetrics(dir)).toEqual([]);
	});

	it("tolerates blank lines", () => {
		mkdirSync(evolutionDir(dir), { recursive: true });
		writeFileSync(metricsPath(dir), "\n\n", "utf8");
		expect(readMetrics(dir)).toEqual([]);
	});

	it("compacts away stale duplicate lines", () => {
		appendMetric(dir, meta({ id: "s1" }));
		appendMetric(dir, meta({ id: "s1", status: "aborted" }));
		appendMetric(dir, meta({ id: "s2", startedAt: 500 }));
		expect(readFileSync(metricsPath(dir), "utf8").trim().split("\n")).toHaveLength(3);
		const kept = compactMetrics(dir);
		expect(kept).toBe(2);
		expect(readFileSync(metricsPath(dir), "utf8").trim().split("\n")).toHaveLength(2);
		// And the surviving entry is the newer truth.
		expect(readMetrics(dir).find((m) => m.id === "s1")!.status).toBe("aborted");
	});
});

/**
 * The abandon path also belongs in the ledger.
 *
 * A hard-killed run (SIGKILL / power loss) never reaches `finalize`; only
 * startup reconciliation can record it. If this path were missed, the ledger
 * would silently lose every crashed game — and crashed games are exactly the
 * ones worth learning from. Verified here deterministically rather than by
 * killing a live process, which left ports bound and made the check unreliable.
 */
describe("ledger records abandoned runs (reconcile path)", () => {
	it("writes one interrupted entry when a stale run is reconciled", async () => {
		const { SessionStore, reconcileStaleSessions, newSessionId, STALE_AFTER_MS } =
			await import("../../src/agent/session-store.js");
		const startedAt = 1_000_000;
		const store = new SessionStore(dir);
		const meta = store.create({
			id: newSessionId(7, new Date(startedAt)),
			mode: "watch",
			status: "running",
			startedAt,
			seed: 7,
			startYear: 1950,
			mapSize: [256, 256],
			serverName: "x",
			companyName: "x",
			llm: { providerId: "", model: "", api: "openai-completions", kind: "faux" },
		});
		// No ledger entry yet: the run has not finished.
		expect(readMetrics(dir)).toEqual([]);

		// Pretend the process died long ago (heartbeat far in the past).
		const later = startedAt + STALE_AFTER_MS * 4;
		const changed = reconcileStaleSessions(dir, later);
		expect(changed).toContain(meta.id);

		const list = readMetrics(dir);
		expect(list).toHaveLength(1);
		expect(list[0]!.id).toBe(meta.id);
		expect(list[0]!.status).toBe("interrupted");
		// The run never produced an outcome, so this must read as unknown.
		expect(list[0]!.constructionDone).toBeNull();
		expect(Number.isFinite(list[0]!.durationMs)).toBe(true);

		// Reconciling again must not double-count it.
		reconcileStaleSessions(dir, later + 1000);
		expect(readMetrics(dir)).toHaveLength(1);
	});
});

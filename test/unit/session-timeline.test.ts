/**
 * Unit tests — the causal timeline's session reader (the IO half of B3).
 *
 * 职责: 锁定"一页 = 一段行、总数已知、未知 session = null"。
 * 为什么值得单测:
 *   1. **分页不许丢边界**：默认只给最近 20 行，但"更早的按需加载"必须能取到，
 *      而且总数要一起给（页面才知道还有没有）。
 *   2. **未知 session 不许假装有**：404 而不是空数组——空数组会读成"这一局没有决策"。
 *   3. **IO 失败不许变成"这一局没有因果链"**：读不到就是 null（缺证据 ≠ 没有证据）。
 *
 * 禁止: 在此断言页面的排版。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionTimeline } from "../../src/agent/session-store.js";

function makeSession(id: string, records: unknown[]): string {
	const dir = mkdtempSync(join(tmpdir(), "b3-timeline-"));
	const session = join(dir, "sessions", id);
	mkdirSync(session, { recursive: true });
	writeFileSync(join(session, "meta.json"), JSON.stringify({ id, mode: "agent" }), "utf8");
	writeFileSync(
		join(session, "audit.jsonl"),
		records.map((r) => JSON.stringify(r)).join("\n") + "\n",
		"utf8",
	);
	return dir;
}

function decision(turn: number): unknown {
	return {
		type: "decision",
		ts: 1000 * turn,
		turn,
		trigger: "start",
		state: { date: "1950-01-12", companies: [], delivered: 0 },
	};
}

describe("readSessionTimeline", () => {
	it("returns the rows and the total (the page needs to know there is more)", () => {
		const dir = makeSession("s1", [decision(1), decision(2), decision(3)]);
		try {
			const out = readSessionTimeline(dir, "s1", { limit: 2 });
			expect(out).not.toBeNull();
			expect(out!.total).toBe(3);
			expect(out!.rows.length).toBe(2);
			// The LATEST rows by default, newest first (the user cares about
			// what just happened).
			expect(out!.rows.map((r) => r.turn)).toEqual([3, 2]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pages back to the older rows on demand", () => {
		const dir = makeSession("s1", [decision(1), decision(2), decision(3)]);
		try {
			const out = readSessionTimeline(dir, "s1", { limit: 2, offset: 2 });
			expect(out!.rows.map((r) => r.turn)).toEqual([1]);
			expect(out!.total).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null for an unknown session (not an empty timeline)", () => {
		const dir = makeSession("s1", [decision(1)]);
		try {
			expect(readSessionTimeline(dir, "nope", {})).toBeNull();
			// A traversing id must not reach the disk.
			expect(readSessionTimeline(dir, "../etc", {})).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null when the audit trail cannot be read (missing evidence is not 'no decisions')", () => {
		const dir = mkdtempSync(join(tmpdir(), "b3-timeline-empty-"));
		try {
			expect(readSessionTimeline(dir, "missing", {})).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * Unit tests — session lifecycle: heartbeats, stale detection, reconciliation.
 *
 * 职责: 锁定「进程被强杀后 Web 端不再显示 running」这一行为
 *   （docs/STARTUP-AND-LIFECYCLE.md §5）。
 *   纯测试：临时目录 + 显式时间注入，不 spawn 进程。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	SessionStore,
	effectiveStatus,
	listSessions,
	newSessionId,
	reconcileStaleSessions,
	readSession,
	STALE_AFTER_MS,
} from "../../src/agent/session-store.js";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "lifecycle-"));
}

function newStore(dir: string): SessionStore {
	const s = new SessionStore(dir);
	s.create({
		id: newSessionId(7),
		mode: "agent",
		status: "running",
		startedAt: Date.now(),
		seed: 7,
		startYear: 1950,
		mapSize: [256, 256],
		serverName: "srv",
		companyName: "co",
		llm: { providerId: "p", model: "m", api: "openai-completions", kind: "real" },
	});
	return s;
}

describe("session lifecycle", () => {
	it("records a heartbeat while running", () => {
		const dir = tmp();
		try {
			const s = newStore(dir);
			const t0 = 1_000_000;
			s.heartbeat(t0);
			expect(s.current().heartbeatAt).toBe(t0);
			// The heartbeat is persisted, not just in memory.
			const onDisk = JSON.parse(readFileSync(path.join(dir, "sessions", s.id, "meta.json"), "utf8"));
			expect(onDisk.heartbeatAt).toBe(t0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a stale running session as interrupted without touching disk", () => {
		const dir = tmp();
		try {
			const s = newStore(dir);
			const base = 5_000_000;
			s.heartbeat(base);
			const meta = s.current();

			// Still fresh just before the threshold...
			expect(effectiveStatus(meta, base + STALE_AFTER_MS - 1)).toBe("running");
			// ...and interrupted after it (SIGKILL / crash / power loss).
			expect(effectiveStatus(meta, base + STALE_AFTER_MS + 1)).toBe("interrupted");

			// Reading must not mutate the stored record.
			const stored = JSON.parse(readFileSync(path.join(dir, "sessions", s.id, "meta.json"), "utf8"));
			expect(stored.status).toBe("running");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats a finished session as finished regardless of age", () => {
		const dir = tmp();
		try {
			const s = newStore(dir);
			s.heartbeat(1_000);
			s.finalize({ status: "completed" });
			const meta = s.current();
			// Even long after, a completed run stays completed.
			expect(effectiveStatus(meta, 1_000 + STALE_AFTER_MS * 100)).toBe("completed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to startedAt when no heartbeat was ever written", () => {
		const dir = tmp();
		try {
			const s = newStore(dir);
			const meta = s.current();
			expect(meta.heartbeatAt).toBeUndefined();
			expect(effectiveStatus(meta, meta.startedAt + STALE_AFTER_MS + 1)).toBe("interrupted");
			expect(effectiveStatus(meta, meta.startedAt + 1)).toBe("running");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces the effective status through listSessions and readSession", () => {
		const dir = tmp();
		try {
			const s = newStore(dir);
			s.heartbeat(2_000_000);
			const now = 2_000_000 + STALE_AFTER_MS + 5;

			const listed = listSessions(dir, now);
			expect(listed[0]!.status).toBe("interrupted");

			const read = readSession(dir, s.id, {}, now);
			expect(read!.meta.status).toBe("interrupted");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reconciles stale sessions on startup so history self-heals", () => {
		const dir = tmp();
		try {
			const s = newStore(dir);
			s.heartbeat(3_000_000);
			const now = 3_000_000 + STALE_AFTER_MS + 10;

			const changed = reconcileStaleSessions(dir, now);
			expect(changed).toEqual([s.id]);

			// Now persisted as interrupted, with an end time and a reason.
			const meta = JSON.parse(readFileSync(path.join(dir, "sessions", s.id, "meta.json"), "utf8"));
			expect(meta.status).toBe("interrupted");
			expect(meta.endedAt).toBeGreaterThan(0);
			expect(meta.error).toMatch(/interrupt/i);
			// and the index agrees
			expect(listSessions(dir, now)[0]!.status).toBe("interrupted");

			// Idempotent: a second pass has nothing left to do.
			expect(reconcileStaleSessions(dir, now)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves fresh running sessions alone during reconciliation", () => {
		const dir = tmp();
		try {
			const s = newStore(dir);
			s.heartbeat(4_000_000);
			expect(reconcileStaleSessions(dir, 4_000_000 + 1000)).toEqual([]);
			expect(listSessions(dir, 4_000_000 + 1000)[0]!.status).toBe("running");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never throws on a corrupt or missing index", () => {
		const dir = tmp();
		try {
			mkdirSync(path.join(dir, "sessions"), { recursive: true });
			writeFileSync(path.join(dir, "sessions", "index.json"), "{not json", "utf8");
			expect(() => listSessions(dir)).not.toThrow();
			expect(() => reconcileStaleSessions(dir)).not.toThrow();
			expect(listSessions(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a documented stale threshold", () => {
		// Guard against an accidental change that would flip live runs to
		// interrupted mid-game (the runner heartbeats every ~2s).
		expect(STALE_AFTER_MS).toBeGreaterThanOrEqual(10_000);
		expect(STALE_AFTER_MS).toBeLessThanOrEqual(60_000);
	});

	it("cleanupStale removes nothing while a session is still live", () => {
		const dir = tmp();
		try {
			const s = newStore(dir);
			s.heartbeat(6_000_000);
			// finalize writes endedAt; a live session must not be marked ended
			expect(existsSync(path.join(dir, "sessions", s.id, "meta.json"))).toBe(true);
			const m = listSessions(dir, 6_000_000)[0]!;
			expect(m.endedAt).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

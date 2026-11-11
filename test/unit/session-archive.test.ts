/**
 * Unit tests — the session archive must keep the readings it was given.
 *
 * 职责: 锁定"经济读数落盘"这件事（Issue #104 P0b 的前提）。
 *   曾经的现场: `company_economy` 的 payload 里 `money/loan/income` 是 **BigInt**
 *   （引擎的 u64），而归档用原生 `JSON.stringify` ⇒ 抛 TypeError ⇒ 被空 `catch`
 *   吞掉 ⇒ **每一条经济读数都被静默丢弃** ⇒ 局跑完之后读数序列不存在，
 *   "离线重算这一局"根本无从谈起（`src/util/json.ts` 早就写明禁止这么做）。
 * 纯测试：临时目录 + 真实的 SessionStore。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, newSessionId } from "../../src/agent/session-store.js";

function newStore(dir: string): SessionStore {
	const s = new SessionStore(dir);
	s.create({
		id: newSessionId(11),
		mode: "agent",
		status: "running",
		startedAt: Date.now(),
		seed: 11,
		startYear: 1950,
		mapSize: [256, 256],
		serverName: "srv",
		companyName: "co",
		llm: { providerId: "p", model: "m", api: "openai-completions", kind: "real" },
	});
	return s;
}

describe("session archive", () => {
	it("keeps a company economy reading (BigInt money) instead of dropping it", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "archive-"));
		try {
			const s = newStore(dir);
			s.appendEvent({
				seq: 7,
				kind: "company_economy",
				ts: 1_700_000_000_000,
				payload: { id: 0, money: 123_456n, loan: 50_000n, income: -42n, deliveredCargo: 7 },
			});
			const file = path.join(dir, "sessions", s.id!, "events.jsonl");
			const lines = readFileSync(file, "utf8").trim().split("\n");
			expect(lines).toHaveLength(1);
			const rec = JSON.parse(lines[0]!);
			expect(rec.kind).toBe("company_economy");
			// BigInt 落盘成十进制字符串（`stringifyJson` 的约定）。
			expect(rec.payload.money).toBe("123456");
			expect(rec.payload.loan).toBe("50000");
			expect(rec.payload.income).toBe("-42");
			expect(rec.payload.deliveredCargo).toBe(7);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the audit trail too (BigInt amounts must not vanish)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "archive-audit-"));
		try {
			const s = newStore(dir);
			s.appendAudit({ type: "decision", money: 9_999n });
			const file = path.join(dir, "sessions", s.id!, "audit.jsonl");
			const rec = JSON.parse(readFileSync(file, "utf8").trim());
			expect(rec.money).toBe("9999");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still writes ordinary events unchanged", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "archive-plain-"));
		try {
			const s = newStore(dir);
			s.appendEvent({ seq: 1, kind: "date", ts: 5, payload: { raw: 712_237, year: 1950, month: 1, day: 15 } });
			const file = path.join(dir, "sessions", s.id!, "events.jsonl");
			const rec = JSON.parse(readFileSync(file, "utf8").trim());
			expect(rec.payload.raw).toBe(712_237);
			expect(rec.kind).toBe("date");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

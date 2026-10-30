/**
 * The named outcome of a **session** (B5) — "every run can say what it was".
 *
 * 背景（CoDesign F5）：后端有 10 类成因，但页面只报得出 4 类；最可行动的一类
 * （`refused`：所有工具调用被拒）完全不可见——它恰恰是"模型在乱试"的信号。
 *
 * 这组断言锁：
 *   ① History 列表里每一局都带着**服务端判定的**结果类（不是页面自己猜的）。
 *   ② 名字与解释由服务端给（`describeOutcome`），页面只照抄。
 *   ③ 派生而非存储：类由事实算出，读数缺失时是 `unknown` 而不是"什么都没发生"。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, newSessionId, sessionHooks } from "../../src/agent/session-store.js";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "outcome-session-"));
}

/** A finished session with the given outcome facts. */
function finished(dir: string, outcome: Record<string, unknown>, totals: Record<string, unknown> = {}): void {
	const s = new SessionStore(dir);
	s.create({
		id: newSessionId(7),
		mode: "agent",
		status: "completed",
		startedAt: Date.now(),
		seed: 7,
		startYear: 1950,
		mapSize: [256, 256],
		serverName: "srv",
		companyName: "co",
		llm: { providerId: "p", model: "m", api: "openai-completions", kind: "real" },
	});
	s.update({ outcome, totals: { ...s.current().totals, ...totals } } as never);
}

describe("the session outcome class", () => {
	it("names a run that delivered", () => {
		const dir = tmp();
		try {
			finished(dir, { deliveredRun: 12, constructionDone: true });
			const rows = sessionHooks(dir).list() as { outcome?: { class?: string; label?: string; hint?: string } }[];
			expect(rows.length).toBe(1);
			expect(rows[0]!.outcome?.class).toBe("delivered");
			expect(rows[0]!.outcome?.label).toBeTruthy();
			expect(rows[0]!.outcome?.hint).toBeTruthy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("names a run whose every tool call was refused (the class that used to be invisible)", () => {
		const dir = tmp();
		try {
			finished(dir, { deliveredRun: 0 }, { toolCalls: 3, toolFailures: 3 });
			const rows = sessionHooks(dir).list() as { outcome?: { class?: string } }[];
			expect(rows[0]!.outcome?.class).toBe("refused");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("says 'unknown' when the readings are missing (not 'nothing happened')", () => {
		const dir = tmp();
		try {
			finished(dir, {});
			const rows = sessionHooks(dir).list() as { outcome?: { class?: string } }[];
			expect(rows[0]!.outcome?.class).toBe("unknown");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

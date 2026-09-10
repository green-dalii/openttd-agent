/**
 * Unit tests — context pruning (transformContext) + audit JSONL redaction.
 * 事实来源: SPEC §4.1（剪枝/注入）、§7（审计 JSONL）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruningTransformContext } from "../../src/agent/context.js";
import { AuditLog } from "../../src/agent/audit.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

function msg(role: string, i: number): AgentMessage {
	return { role, content: `m${i}` } as unknown as AgentMessage;
}

describe("pruningTransformContext", () => {
	it("keeps everything when under the window", async () => {
		const t = pruningTransformContext({ keepRecent: 5 });
		const out = await t([msg("user", 1), msg("assistant", 2)]);
		expect(out).toHaveLength(2);
	});

	it("prunes to the recent window", async () => {
		const t = pruningTransformContext({ keepRecent: 3 });
		const input = Array.from({ length: 10 }, (_, i) => msg("assistant", i));
		const out = await t(input);
		expect(out).toHaveLength(3);
		expect((out[0] as { content: string }).content).toBe("m7");
	});

	it("re-attaches the latest game_observation when it falls outside the window", async () => {
		const t = pruningTransformContext({ keepRecent: 2 });
		const input: AgentMessage[] = [
			{ role: "game_observation", date: "1950-01", state: {}, timestamp: 1 } as unknown as AgentMessage,
			msg("assistant", 1),
			msg("assistant", 2),
			msg("assistant", 3),
			msg("assistant", 4),
		];
		const out = await t(input);
		expect((out[0] as { role: string }).role).toBe("game_observation");
		expect(out).toHaveLength(3); // observation + last 2
	});

	it("injects lessons when the provider returns some", async () => {
		const t = pruningTransformContext({
			keepRecent: 5,
			lessonsProvider: () => ["prefer short profitable routes", "add buses when queues grow"],
		});
		const out = await t([msg("user", 1)]);
		expect((out[0] as { role: string }).role).toBe("user");
		expect((out[0] as { content: string }).content).toContain("prefer short profitable routes");
		expect(out).toHaveLength(2);
	});

	it("does not inject when no lessons", async () => {
		const t = pruningTransformContext({ keepRecent: 5, lessonsProvider: () => [] });
		const out = await t([msg("user", 1)]);
		expect(out).toHaveLength(1);
	});
});

describe("AuditLog", () => {
	it("appends JSONL records and redacts secrets", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
		try {
			const log = new AuditLog(dir, "a.jsonl");
			log.write({ type: "decision", ts: 1, turn: 1, date: "1950-01", state: { money: "1000" } });
			log.write({
				type: "action_result",
				ts: 2,
				tool: "build_bus_route",
				ok: true,
				summary: "sent",
				data: { apiKey: "sk-secret", cmd: "build_bus_route" },
			});
			const lines = readFileSync(log.path(), "utf8").trim().split("\n");
			expect(lines).toHaveLength(2);
			const rec2 = JSON.parse(lines[1]!) as { data: Record<string, string> };
			expect(rec2.data.apiKey).toBe("(redacted)");
			expect(rec2.data.cmd).toBe("build_bus_route");
			expect(lines.join("")).not.toContain("sk-secret");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

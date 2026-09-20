/**
 * Unit tests — provider catalog + session store (no network; temp dirs only).
 * 事实来源: docs/DASHBOARD-API.md §2.5/§2.6/§6.2/§6.3.
 */
import { describe, expect, it } from "vitest";
import { Telemetry } from "../../src/agent/telemetry.js";
import { WorldState } from "../../src/game/world-state.js";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	catalogGeneratedAt,
	expectedEnvKeys,
	getCatalogProvider,
	isCatalogProvider,
	listCatalogModels,
	listCatalogProviders,
} from "../../src/agent/provider-catalog.js";
import {
	SessionStore,
	buildStageSummary,
	listSessions,
	newSessionId,
	readSession,
} from "../../src/agent/session-store.js";
import type { GameEvent } from "../../src/types.js";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "ottd-dash-"));
}

describe("provider catalog (pi-ai built-ins)", () => {
	it("lists the built-in providers, sorted, with real model counts", () => {
		const providers = listCatalogProviders();
		expect(providers.length).toBeGreaterThanOrEqual(30);
		const ids = providers.map((p) => p.id);
		expect(ids).toContain("openai");
		expect(ids).toContain("anthropic");
		expect(ids).toContain("deepseek");
		expect([...ids].sort()).toEqual(ids); // sorted ascending
		for (const p of providers) {
			expect(p.modelCount).toBeGreaterThan(0);
			expect(p.apis.length).toBeGreaterThan(0);
			expect(p.authTypes.length).toBeGreaterThan(0);
		}
	});

	it("memoizes the catalog (stable reference, not rebuilt per call)", () => {
		expect(listCatalogProviders()).toBe(listCatalogProviders());
	});

	it("exposes models for a provider with the fields the UI needs", () => {
		const models = listCatalogModels("openai");
		expect(models.length).toBeGreaterThan(5);
		expect(listCatalogModels("openai")).toBe(models); // memoized per provider
		const m = models[0];
		expect(typeof m!.id).toBe("string");
		expect(typeof m!.api).toBe("string");
		expect(m!.contextWindow).toBeGreaterThan(0);
		expect(m!.maxTokens).toBeGreaterThan(0);
		expect(typeof m!.reasoning).toBe("boolean");
		expect(typeof m!.cost.input).toBe("number");
	});

	it("resolves a single provider and reports catalog membership", () => {
		expect(getCatalogProvider("openai")?.id).toBe("openai");
		expect(getCatalogProvider("definitely-not-a-provider")).toBeUndefined();
		expect(isCatalogProvider("deepseek")).toBe(true);
		expect(isCatalogProvider("definitely-not-a-provider")).toBe(false);
		expect(isCatalogProvider("")).toBe(false);
	});

	it("resolves the real env var names pi-ai accepts (not naive guesses)", () => {
		// Convention-based names.
		expect(expectedEnvKeys("openai")).toEqual(["OPENAI_API_KEY"]);
		expect(expectedEnvKeys("deepseek")).toEqual(["DEEPSEEK_API_KEY"]);
		expect(expectedEnvKeys("zai")).toEqual(["ZAI_API_KEY"]);
		// Verified exceptions: NOT the id-derived name.
		expect(expectedEnvKeys("huggingface")).toEqual(["HF_TOKEN"]);
		expect(expectedEnvKeys("google")).toEqual(["GEMINI_API_KEY"]);
		expect(expectedEnvKeys("moonshotai")).toEqual(["MOONSHOT_API_KEY"]);
		expect(expectedEnvKeys("kimi-coding")).toEqual(["KIMI_API_KEY"]);
		// anthropic accepts an API key OR an auth token.
		expect(expectedEnvKeys("anthropic")).toContain("ANTHROPIC_API_KEY");
		expect(expectedEnvKeys("anthropic")).toContain("ANTHROPIC_AUTH_TOKEN");
		// OAuth/cloud providers have no API-key env var at all.
		expect(expectedEnvKeys("amazon-bedrock")).toEqual([]);
		expect(expectedEnvKeys("github-copilot")).toEqual([]);
	});

	it("never invents an env var that pi-ai would reject", () => {
		// HF_TOKEN is real; the 'obvious' HUGGINGFACE_API_KEY is not.
		expect(expectedEnvKeys("huggingface")).not.toContain("HUGGINGFACE_API_KEY");
		expect(expectedEnvKeys("openai")).not.toContain("OPENAI_KEY");
	});

	it("does not mutate the real process environment while probing", () => {
		const before = JSON.stringify(Object.keys(process.env).sort());
		void listCatalogProviders();
		const after = JSON.stringify(Object.keys(process.env).sort());
		expect(after).toBe(before);
	});

	it("explains OAuth/cloud providers instead of showing a bogus env hint", () => {
		const providers = listCatalogProviders();
		for (const p of providers) {
			if (p.envKeys.length === 0) {
				// Either it has a hint, or it is a provider we knowingly left silent.
				expect(p.hint === undefined || p.hint.length > 0).toBe(true);
			}
		}
		const bedrock = providers.find((p) => p.id === "amazon-bedrock");
		expect(bedrock?.hint).toMatch(/AWS/i);
	});

	it("reports the catalog generation timestamp", () => {
		const at = catalogGeneratedAt();
		expect(typeof at).toBe("number");
		expect(at).toBeGreaterThan(0);
	});

	it("returns an empty model list for an unknown provider instead of throwing", () => {
		expect(listCatalogModels("definitely-not-a-provider")).toEqual([]);
	});
});

describe("session store", () => {
	it("builds sortable, filesystem-safe session ids", () => {
		const id = newSessionId(7, new Date("2026-09-10T21:30:00Z"));
		expect(id).toMatch(/^\d{8}-\d{6}-seed7$/);
		expect(id).not.toContain("/");
		expect(newSessionId(42, new Date("2026-01-02T03:04:05Z"))).toContain("seed42");
	});

	it("creates a session on disk and lists it", () => {
		const dir = tmp();
		try {
			const store = new SessionStore(dir);
			const meta = store.create({
				id: "sess-a",
				mode: "agent",
				status: "running",
				startedAt: 1000,
				seed: 7,
				startYear: 1950,
				mapSize: [256, 256],
				serverName: "t",
				companyName: "c",
				llm: { providerId: "openai", model: "gpt-5", api: "openai-responses", kind: "real" },
				totals: {
					events: 0,
					decisions: 0,
					toolCalls: 0,
					toolFailures: 0,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0,
						totalTokens: 0,
						costTotal: 0,
					},
				},
			});
			expect(meta.checkpoints).toEqual([]);
			expect(existsSync(path.join(dir, "sessions", "sess-a", "meta.json"))).toBe(true);

			const list = listSessions(dir);
			expect(list).toHaveLength(1);
			expect(list[0]!.id).toBe("sess-a");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("updates meta, appends checkpoints, events and audit records", () => {
		const dir = tmp();
		try {
			const store = new SessionStore(dir, {
				id: "sess-b",
				mode: "watch",
				status: "running",
				startedAt: 1,
				seed: 1,
				startYear: 1950,
				mapSize: [256, 256],
				serverName: "t",
				companyName: "c",
				llm: { providerId: "", model: "", api: "openai-completions", kind: "faux" },
				totals: {
					events: 0,
					decisions: 0,
					toolCalls: 0,
					toolFailures: 0,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0,
						totalTokens: 0,
						costTotal: 0,
					},
				},
				checkpoints: [],
			});
			store.update({ status: "completed", endedAt: 5000 });
			store.addCheckpoint(buildStageSummary(store.current(), "1950-03-01", 1));
			store.appendEvent({ seq: 1, ts: 10, kind: "date", payload: {} } as GameEvent);
			store.appendAudit({ type: "note", ts: 11, message: "hi" });
			store.finalize();

			const got = readSession(dir, "sess-b");
			expect(got).not.toBeNull();
			expect(got?.meta.status).toBe("completed");
			expect(got?.events).toHaveLength(1);
			expect(got?.events[0]!.kind).toBe("date");
			expect(got?.audit).toHaveLength(1);
			expect(got?.meta.checkpoints.length).toBeGreaterThanOrEqual(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists and reads back a telemetry snapshot", () => {
		const dir = tmp();
		try {
			const store = new SessionStore(dir);
			store.create({
				id: "sess-t",
				mode: "agent",
				status: "running",
				startedAt: 1,
				seed: 1,
				startYear: 1950,
				mapSize: [256, 256],
				serverName: "t",
				companyName: "c",
				llm: { providerId: "p", model: "m", api: "openai-completions", kind: "real" },
				totals: {
					events: 0,
					decisions: 0,
					toolCalls: 0,
					toolFailures: 0,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0,
						totalTokens: 0,
						costTotal: 0,
					},
				},
			});
			store.saveTelemetry({
				sessionId: "sess-t",
				startedAt: 1,
				lastActivityAt: 2,
				turns: 3,
				activeTurn: 3,
				steps: [],
				usage: {
					peakRequest: { tokens: 0, turn: null },
					total: {
						input: 5,
						output: 6,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0,
						totalTokens: 11,
						costTotal: 0,
					},
					byTurn: [],
					byTool: [],
				},
				totals: { decisions: 1, messages: 2, toolCalls: 0, toolFailures: 0 },
				recentThinking: [],
				brain: { provider: "p", model: "m", kind: "real" },
			});
			expect(readSession(dir, "sess-t")?.telemetry?.usage.total.input).toBe(5);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("survives corrupt/absent files and unknown ids", () => {
		const dir = tmp();
		try {
			mkdirSync(dir, { recursive: true });
			mkdirSync(path.join(dir, "sessions"), { recursive: true });
			writeFileSync(path.join(dir, "sessions", "index.json"), "{not json", "utf8");
			expect(listSessions(dir)).toEqual([]);
			expect(readSession(dir, "nope")).toBeNull();

			// A store must not throw when the index is corrupt.
			const store = new SessionStore(dir);
			expect(() =>
				store.create({
					id: "sess-c",
					mode: "watch",
					status: "running",
					startedAt: 1,
					seed: 1,
					startYear: 1950,
					mapSize: [256, 256],
					serverName: "t",
					companyName: "c",
					llm: { providerId: "", model: "", api: "openai-completions", kind: "faux" },
				}),
			).not.toThrow();
			expect(listSessions(dir).map((s) => s.id)).toEqual(["sess-c"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lists sessions newest first and ignores unknown ids for read", () => {
		const dir = tmp();
		try {
			const a = new SessionStore(dir);
			a.create({
				id: "old",
				mode: "watch",
				status: "completed",
				startedAt: 100,
				seed: 1,
				startYear: 1950,
				mapSize: [256, 256],
				serverName: "t",
				companyName: "c",
				llm: { providerId: "", model: "", api: "openai-completions", kind: "faux" },
			});
			const b = new SessionStore(dir);
			b.create({
				id: "new",
				mode: "agent",
				status: "running",
				startedAt: 200,
				seed: 1,
				startYear: 1950,
				mapSize: [256, 256],
				serverName: "t",
				companyName: "c",
				llm: { providerId: "", model: "", api: "openai-completions", kind: "faux" },
			});
			expect(listSessions(dir).map((s) => s.id)).toEqual(["new", "old"]);
			expect(readSession(dir, "missing")).toBeNull();
			// index.json is a real file, not a directory
			expect(JSON.parse(readFileSync(path.join(dir, "sessions", "index.json"), "utf8")).sessions).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("builds a staged summary with a human-readable note", () => {
		const cp = buildStageSummary(
			{
				id: "s",
				mode: "agent",
				status: "running",
				startedAt: 0,
				seed: 7,
				startYear: 1950,
				mapSize: [256, 256],
				serverName: "t",
				companyName: "c",
				llm: { providerId: "p", model: "m", api: "a", kind: "real" },
				totals: {
					events: 42,
					decisions: 3,
					toolCalls: 4,
					toolFailures: 1,
					usage: {
						input: 1000,
						output: 200,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0,
						totalTokens: 1200,
						costTotal: 0.05,
					},
				},
				checkpoints: [],
			},
			"1950-03-01",
			2,
		);
		expect(cp.gameDate).toBe("1950-03-01");
		expect(cp.turn).toBe(2);
		expect(cp.note).toContain("1950-03-01");
		expect(cp.note).toContain("1,200");
		expect(cp.note).toContain("42 events");
		expect(cp.totals.usage.totalTokens).toBe(1200);
	});
});

/**
 * Staged summaries must report the run's REAL numbers.
 *
 * Regression: agent mode only ever synced `events` into the session record, so
 * every checkpoint (and the sessions page) read "0 decisions, 0 tool calls,
 * 0 tokens" even for a run that spent thousands of tokens.
 * See docs/DASHBOARD-UI.md §7.
 */
describe("staged summary numbers", () => {
	it("reads counts and tokens from the telemetry actually ingested", () => {
		const tel = new Telemetry({ sessionId: "s", limit: 50 });
		tel.ingestAgentEvent({ type: "turn_start", turn: 1 } as never);
		tel.ingestAgentEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				usage: {
					input: 1200,
					output: 40,
					cacheRead: 10,
					cacheWrite: 0,
					reasoning: 7,
					totalTokens: 1240,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
				},
			},
		} as never);
		// Tool accounting comes from the real event pair, not a helper.
		tel.ingestAgentEvent({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "build_bus_route",
			args: {},
		} as never);
		tel.ingestAgentEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "build_bus_route",
			result: { ok: true, summary: "sent" },
		} as never);
		tel.decisionPoint();

		const snap = tel.snapshot();
		expect(snap.totals.toolCalls).toBe(1);
		expect(snap.usage.total.totalTokens).toBe(1240);

		// The summary is derived from totals, so a zero-token run can never be
		// printed when telemetry saw usage (this is what regressed).
		const meta = {
			id: "x", mode: "agent", status: "running", startedAt: 0, seed: 1, startYear: 1950,
			mapSize: [256, 256], serverName: "s", companyName: "c",
			llm: { providerId: "p", model: "m", api: "openai-completions", kind: "real" },
			checkpoints: [],
			totals: {
				events: 42, decisions: snap.totals.decisions, toolCalls: snap.totals.toolCalls,
				toolFailures: snap.totals.toolFailures,
				usage: {
					input: snap.usage.total.input, output: snap.usage.total.output,
					cacheRead: snap.usage.total.cacheRead, cacheWrite: snap.usage.total.cacheWrite,
					reasoning: snap.usage.total.reasoning, totalTokens: snap.usage.total.totalTokens,
					costTotal: snap.usage.total.costTotal,
				},
			},
		} as Parameters<typeof buildStageSummary>[0];
		const cp = buildStageSummary(meta, "1950-02-01", 1);
		expect(cp.note).toContain("1 decisions");
		expect(cp.note).toContain("1 tool calls");
		expect(cp.note).toContain("1,240 tokens");
		// Guard the actual regression: a run with usage must never summarize as
		// "0 tokens" (note: "1,240 tokens" legitimately CONTAINS "0 tokens").
		expect(cp.note).not.toMatch(/(?:^|\D)0 tokens/);
		expect(cp.totals.usage.totalTokens).toBe(1240);
		expect(cp.turn).toBe(1);
	});
});

/**
 * The dashboard is a VIEW: the cash curve must be owned by the server, so a
 * browser refresh or a late subscriber still sees the whole run.
 *
 * Regression: history lived only in page memory, so reloading a long-running
 * game showed a single-point chart (and an empty one before the first poll).
 */
describe("world-state economy history", () => {
	it("accumulates a bounded series and exposes it in the snapshot", () => {
		const world = new WorldState();
		const econ = (money: number, income: number) => ({
			seq: 0,
			kind: "company_economy" as const,
			ts: Date.now(),
			payload: { id: 0, money: BigInt(money), loan: 100000n, income: BigInt(income) } as never,
		});
		world.ingest({ seq: 1, kind: "company_new", ts: 1, payload: { id: 0 } as never });
		world.ingest(econ(1000, -50));
		world.ingest(econ(2000, -60));
		world.ingest(econ(3000, 10));

		const c = world.snapshot().companies.get(0)!;
		expect(c.history).toHaveLength(3);
		expect(c.history.map((h) => h.money)).toEqual([1000, 2000, 3000]);
		// Signed income is preserved (SPEC §10.6) - not 2^64.
		expect(c.history[0]!.income).toBe(-50);
		expect(c.history[2]!.income).toBe(10);
		// Latest economy still tracked separately.
		expect(c.economy?.money).toBe(3000n);
	});

	it("keeps the series bounded so a long run cannot grow without limit", () => {
		const world = new WorldState();
		for (let i = 0; i < 700; i++) {
			world.ingest({
				seq: i,
				kind: "company_economy",
				ts: i,
				payload: { id: 0, money: BigInt(i), loan: 0n, income: 0n } as never,
			});
		}
		const c = world.snapshot().companies.get(0)!;
		expect(c.history.length).toBeLessThanOrEqual(600);
		// The newest point must survive the cap.
		expect(c.history[c.history.length - 1]!.money).toBe(699);
	});
});

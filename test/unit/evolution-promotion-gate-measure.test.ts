/**
 * Integration-ish unit test — the promotion gate reads the operating-profit
 * reading end to end (reflection → stamped sample → card → gate).
 *
 * 事实来源: MEMORY.md §0.5（闸测错了量）；docs/EVOLUTION.md §2.2。
 * 禁止: 在此调用真实 LLM（用 faux）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runReflection } from "../../src/evolution/reflection-run.js";
import { readStrategies } from "../../src/evolution/store.js";
import { evaluatePromotion } from "../../src/evolution/strategies.js";
import type { ReflectionFacts } from "../../src/evolution/reflect.js";

const NOW = 1_700_000_000_000;

function reflectLlm(responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]) {
	const faux = createFauxCore({});
	faux.setResponses(responses);
	return { streamFn: faux.streamSimple, model: faux.getModel() };
}

const CALLS = () => [
	fauxAssistantMessage([
		fauxToolCall("record_strategy", {
			action: "build_freight_route",
			params: { cargo: "COAL" },
			evidence: ["IORE 80 tons delivered between 1950-01 and 1950-06"],
		}),
	]),
	fauxAssistantMessage("done"),
];

/** The run's facts: a run that BUILT (net cash flow negative) but EARNED (operating positive). */
function facts(over: Partial<ReflectionFacts["summary"]> = {}): ReflectionFacts {
	return {
		sessionId: "s1",
		seed: 11,
		summary: {
			money: 73608,
			delivered: 446,
			simulatedDays: 151,
			episodeStop: "horizon",
			vehicleCount: 29,
			stationCount: 14,
			decisions: 12,
			toolCalls: 44,
			toolFailures: 10,
			constructionDone: true,
			durationMs: 300000,
			// The real run's shape: building made the net cash flow negative.
			netCashFlow: -226392,
			profitPerDay: -1499.28,
			// …while the lines themselves earned.
			operatingProfit: 2134,
			operatingProfitPerDay: 14.13,
			operatingProfitComplete: true,
			income: -226392,
			...over,
		},
		evidence: ["7 route jobs built"],
	};
}

describe("晋升闸的度量：反思把运营利润盖到样本上（2026-11-14）", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});
	const freshDir = () => {
		dir = mkdtempSync(path.join(tmpdir(), "strategy-gate-"));
		return dir;
	};

	it("单局：样本带上两个读数，但闸因局数不足拒绝", async () => {
		const d = freshDir();
		await runReflection({ ...reflectLlm(CALLS()), dataDir: d, facts: facts(), now: NOW });
		const cards = readStrategies(d);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.profitPerDayPerRun).toEqual([-1499.28]);
		expect(cards[0]!.operatingProfitPerDayPerRun).toEqual([14.13]);
		const r = evaluatePromotion(cards[0]!);
		expect(r.promoted).toBe(false);
		expect(r.runs).toBe(1);
	});

	it("两局：净现金流为负，但运营利润过阈值 ⇒ 晋升（旧闸永远打不开的那个案例）", async () => {
		const d = freshDir();
		await runReflection({ ...reflectLlm(CALLS()), dataDir: d, facts: facts(), now: NOW });
		// The **top-level** sessionId is the game's id (the summary has no such
		// field) ⇒ the second run is a second game, not a rewrite of the first.
		await runReflection({
			...reflectLlm(CALLS()),
			dataDir: d,
			facts: { ...facts({ operatingProfitPerDay: 20, operatingProfit: 3000 }), sessionId: "s2" },
			now: NOW + 1000,
		});
		const cards = readStrategies(d);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.operatingProfitPerDayPerRun).toHaveLength(2);

		const r = evaluatePromotion(cards[0]!);
		// 阈值 16.67/日：均值 (14.13 + 20) / 2 = 17.07 ⇒ 过。
		expect(r.promoted).toBe(true);
		expect(r.value).toBeCloseTo(17.065, 3);
		// 净现金流仍被报出来（公司健康），但它不参与判定。
		expect(r.netCashFlowPerDay).toBeCloseTo(-1499.28, 2);
	});

	it("缺运营利润读数 ⇒ 不可判定（不折零），拒绝并说清缺什么", async () => {
		const d = freshDir();
		const f = facts();
		// 运营利润没测到（null）⇒ 只有净现金流。
		f.summary.operatingProfitPerDay = null;
		await runReflection({ ...reflectLlm(CALLS()), dataDir: d, facts: f, now: NOW });
		await runReflection({
			...reflectLlm(CALLS()),
			dataDir: d,
			facts: { ...facts(), sessionId: "s2", summary: { ...f.summary, operatingProfitPerDay: null } },
			now: NOW + 1000,
		});
		const cards = readStrategies(d);
		expect(cards[0]!.operatingProfitPerDayPerRun).toBeUndefined();
		const r = evaluatePromotion(cards[0]!);
		expect(r.promoted).toBe(false);
		expect(r.reason).toMatch(/operating profit/i);
	});
});

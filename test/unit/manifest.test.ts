/**
 * Run manifest projection — one field set, three consumers.
 *
 * 为什么需要这组断言：manifest 曾在 session finalize、metric 行、reflect-run 入参
 * **三处**各自按字段重建。每处都是一张白名单，于是 runner 新增的字段会在其中一处
 * 被静默丢掉（真机踩过两次：D3b、D6b 的 payloadHash 掉在 metrics.jsonl 之外）。
 * 这些测试锁的是"只剩一份投影"，不是某个字段的值。
 */

import { describe, expect, it } from "vitest";
import { MANIFEST_FIELDS, projectManifest } from "../../src/agent/manifest.js";
import { toGameMetric } from "../../src/evolution/metrics.js";
import type { SessionMeta } from "../../src/agent/session-store.js";

describe("projectManifest", () => {
	it("emits exactly the declared field set", () => {
		// If someone adds a field to RunManifest without adding it here, the guard
		// trips. If they add it to MANIFEST_FIELDS but not the projection, the
		// equality below trips.
		expect(Object.keys(projectManifest({})).sort()).toEqual([...MANIFEST_FIELDS].sort());
	});

	it("normalizes a missing manifest to null, never 0 or \"\"", () => {
		// "not measured" and "measured zero" are different claims (MEMORY D60).
		const p = projectManifest(undefined);
		for (const field of MANIFEST_FIELDS) expect(p[field]).toBeNull();
	});

	it("keeps provided values, including a zero payload count", () => {
		const p = projectManifest({ backend: "harness", payloadCount: 0, payloadHash: "abc" });
		expect(p.backend).toBe("harness");
		// 0 is a measurement ("nothing was sent"), not an absence.
		expect(p.payloadCount).toBe(0);
		expect(p.payloadHash).toBe("abc");
		expect(p.servedModel).toBeNull();
	});
});

describe("spend caps are part of the run's identity (P4)", () => {
	it("projects the caps, keeping 'no cap' distinct from 'not recorded'", () => {
		const p = projectManifest({ tokenLimit: 5000, costLimit: null });
		expect(p.tokenLimit).toBe(5000);
		// null here means "this run had no cost cap" and is a value, not a gap.
		expect(p.costLimit).toBeNull();
	});

	it("carries the caps into the metric row (a capped run must be explainable)", () => {
		const meta = {
			id: "s1",
			mode: "agent",
			status: "aborted",
			startedAt: 1000,
			endedAt: 2000,
			seed: 7,
			startYear: 1950,
			llm: { providerId: "p", model: "m", api: "openai-completions", kind: "real" },
			totals: { decisions: 2, toolCalls: 1, usage: { input: 10, output: 5, totalTokens: 15 } },
			manifest: { tokenLimit: 900, costLimit: 1.5 },
		} as unknown as SessionMeta;
		const m = toGameMetric(meta);
		expect(m.manifest?.tokenLimit).toBe(900);
		expect(m.manifest?.costLimit).toBeCloseTo(1.5, 6);
	});
});

describe("the metric row is not a narrower copy of the manifest", () => {
	it("carries every manifest field through toGameMetric", () => {
		const meta = {
			id: "s1",
			mode: "agent",
			status: "aborted",
			startedAt: 1000,
			endedAt: 2000,
			seed: 7,
			startYear: 1950,
			llm: { providerId: "p", model: "m", api: "openai-completions", kind: "real" },
			totals: { decisions: 2, toolCalls: 1, usage: { input: 10, output: 5, totalTokens: 15 } },
			manifest: projectManifest({
				servedModel: "m-served",
				backend: "harness",
				thinkingLevel: "off",
				toolBudget: 12,
				scaffoldHash: "scaffold",
				payloadHash: "payload",
				payloadCount: 3,
			}),
		} as unknown as SessionMeta;

		const row = toGameMetric(meta, { dataDir: "/tmp/does-not-matter" } as never);
		for (const field of MANIFEST_FIELDS) {
			expect(row.manifest?.[field], `manifest.${field} was dropped by toGameMetric`).not.toBeUndefined();
		}
		expect(row.manifest?.payloadHash).toBe("payload");
		expect(row.manifest?.backend).toBe("harness");
	});
});

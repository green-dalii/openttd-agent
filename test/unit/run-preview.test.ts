/**
 * The next-run preview must equal the run's manifest, field by field.
 *
 * 这是 B2 的验收核心（Issue #34）：页面说"下一次会用什么"，跑完的 manifest
 * 必须**逐字段相同**。否则预览就是一句谎话。
 *
 * 为什么这条测试值钱: 预览与 manifest 是**两条代码路径**（预览算一遍、跑的时候
 * 记一遍）。它们会漂移的唯一原因是"同一件事写了两遍"——而这条测试正是那个
 * 漂移的探测器（D74 的第二道防线）。
 */
import { describe, expect, it } from "vitest";
import { MANIFEST_FIELDS, projectManifest, type RunManifest } from "../../src/agent/manifest.js";
import { buildNextRunPreview, PREVIEW_MANIFEST_FIELDS } from "../../src/agent/run-preview.js";
import { resolveRunKnobs, type RunKnobDefaults } from "../../src/agent/run-knobs.js";

const DEFAULTS: RunKnobDefaults = {
	seed: 4242,
	gameDays: null,
	scenario: "freeform",
	memoryArm: "treatment",
	thinkingLevel: "off",
	toolBudget: 12,
	tokenLimit: null,
	costLimit: null,
	backend: "agent",
};

const SELECTION = {
	providerId: "minimax-cn",
	model: "MiniMax-M3.1-Flash",
	api: "anthropic-messages",
	contextWindow: 204800,
	maxTokens: 131072,
	costKnown: false,
};

describe("the preview and the manifest agree", () => {
	it("promises exactly the manifest fields it can know in advance", () => {
		// The manifest also carries `servedModel` / `payloadHash` / … — those are
		// only knowable AFTER the run (the provider may answer with a different
		// model). A preview that promised them would be guessing.
		for (const field of PREVIEW_MANIFEST_FIELDS) {
			expect(MANIFEST_FIELDS).toContain(field);
		}
		const postRunOnly = ["servedModel", "payloadHash", "payloadShapeHash", "payloadCount"];
		for (const field of postRunOnly) {
			expect(PREVIEW_MANIFEST_FIELDS).not.toContain(field);
		}
	});

	it("matches the manifest field by field for the knobs the page set", () => {
		const knobs = resolveRunKnobs(
			{
				seed: 99,
				gameDays: 180,
				scenario: "prebuilt",
				memoryArm: "control",
				thinkingLevel: "high",
				toolBudget: 5,
				tokenLimit: 120_000,
				costLimit: 2.5,
			},
			DEFAULTS,
			["agent"],
		);
		const preview = buildNextRunPreview(knobs, SELECTION);

		// What the runner records for this run (the same values, projected).
		const manifest: RunManifest = projectManifest({
			backend: knobs.backend,
			thinkingLevel: knobs.thinkingLevel,
			toolBudget: knobs.toolBudget,
			scaffoldHash: preview.scaffoldHash,
			tokenLimit: knobs.tokenLimit,
			costLimit: knobs.costLimit,
			model: SELECTION.model,
			api: SELECTION.api,
			contextWindow: SELECTION.contextWindow,
			costKnown: SELECTION.costKnown,
		});

		for (const field of PREVIEW_MANIFEST_FIELDS) {
			expect(manifest[field], `manifest.${field} != preview.${field}`).toBe(preview[field]);
		}
	});

	it("predicts the scaffold hash without a running game (it is a source-level fact)", () => {
		const knobs = resolveRunKnobs({}, DEFAULTS, ["agent"]);
		const preview = buildNextRunPreview(knobs, SELECTION);
		// The value the real run recorded (SPEC §10.124 / the live session of
		// 2026-10-30). If a tool's description or schema ever depends on the
		// world, this test fails instead of the preview quietly lying.
		//
		// 2026-10-30: 7956ab6d8c86fa60 → 3da8a64e1fbe818e（observe 的描述改写：
		// 它现在说清楚自己带哪些事实——城镇名字、货种总量、产业、车型）。
		expect(preview.scaffoldHash).toBe("3da8a64e1fbe818e");
	});

	it("keeps the cost-known fact honest (a live-only model has no price table)", () => {
		const knobs = resolveRunKnobs({}, DEFAULTS, ["agent"]);
		const preview = buildNextRunPreview(knobs, { ...SELECTION, costKnown: false });
		// false = unknown, not zero. The efficiency axis must read "not measured".
		expect(preview.costKnown).toBe(false);
	});
});

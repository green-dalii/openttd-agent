/**
 * Unit tests — the ONE selection resolver (S2 / Issue #33 的延伸).
 *
 * 职责: 锁住「四条路径（view / save / gate / runner）必须解出同一个答案」。
 * 事实来源: docs/SELECTION-STATE-CODESIGN.md §4.1；真机事故见 §2（A5）。
 * 禁止: 联网（catalog 恢复只读本地 store）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLiveCatalog } from "../../src/agent/live-catalog.js";
import { JsonModelsStore } from "../../src/agent/models-store.js";
import {
	createSelectionResolver,
	resolveWithCatalog,
	selectionStores,
} from "../../src/agent/selection.js";
import { buildBrain } from "../../src/agent/provider.js";
import { createLlmApi } from "../../src/agent/llm-api.js";
import { loadConfig } from "../../src/config.js";
import type { LlmConfig } from "../../src/config.js";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "selection-"));
}

const PROVIDER = "minimax-cn";

/** A live-only model: the provider reported it, it is not in the bundled snapshot. */
const LIVE_ONLY = {
	id: "MiniMax-M3.1-Flash",
	name: "MiniMax-M3.1-Flash",
	api: "anthropic-messages",
	provider: PROVIDER,
	baseUrl: "https://api.minimaxi.com/anthropic",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 204_800,
	maxTokens: 131_072,
};

/** Persist the live overlay the Providers page would have written. */
async function writeOverlay(dir: string): Promise<void> {
	const store = new JsonModelsStore(path.join(dir, "models-cache.json"));
	await store.write(PROVIDER, { models: [LIVE_ONLY], checkedAt: Date.now() } as never);
}

function catalogCfg(model: string): LlmConfig {
	return {
		providerId: PROVIDER,
		baseUrl: "",
		apiKey: "",
		model,
		api: "anthropic-messages",
		source: "catalog",
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

describe("resolveWithCatalog", () => {
	it("resolves a live-only model from the persisted overlay (no network)", async () => {
		const dir = tmp();
		try {
			await writeOverlay(dir);
			const resolver = createSelectionResolver(selectionStores(dir));
			const r = await resolver.resolve(catalogCfg("MiniMax-M3.1-Flash"));
			expect(r.valid).toBe(true);
			expect(r.problems).toEqual([]);
			expect(r.facts.model).toBe("MiniMax-M3.1-Flash");
			// The model's OWN api/limits, not the config's defaults.
			expect(r.facts.api).toBe("anthropic-messages");
			expect(r.facts.contextWindow).toBe(204_800);
			expect(r.facts.maxTokens).toBe(131_072);
			// A live-only model has no price table: cost is unknown, not free.
			expect(r.facts.costKnown).toBe(false);
			expect(r.facts.modelKnown).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports an unknown model with an actionable hint", async () => {
		const dir = tmp();
		try {
			const resolver = createSelectionResolver(selectionStores(dir));
			const r = await resolver.resolve(catalogCfg("No-Such-Model"));
			expect(r.valid).toBe(false);
			expect(r.facts.modelKnown).toBe(false);
			expect(r.problems[0]?.code).toBe("unknown_model");
			expect(r.problems[0]?.hint).toMatch(/refresh/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports an unknown provider", async () => {
		const dir = tmp();
		try {
			const resolver = createSelectionResolver(selectionStores(dir));
			// the provider IS known here; use a bogus id for the other branch
			const bogus = await resolver.resolve({ ...catalogCfg("x"), providerId: "not-a-provider" });
			expect(bogus.valid).toBe(false);
			expect(bogus.problems[0]?.code).toBe("unknown_provider");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("takes a custom endpoint at its word: no catalog to check", async () => {
		const dir = tmp();
		try {
			const resolver = createSelectionResolver(selectionStores(dir));
			const r = await resolver.resolve({
				providerId: "local",
				baseUrl: "http://127.0.0.1:11434/v1",
				apiKey: "k",
				model: "qwen3",
				api: "openai-completions",
				source: "custom",
				contextWindow: 32_000,
				maxTokens: 8_000,
			});
			expect(r.valid).toBe(true);
			expect(r.facts.modelKnown).toBe(true);
			expect(r.facts.costKnown).toBe(false);
			expect(r.facts.api).toBe("openai-completions");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a custom endpoint without a base URL", async () => {
		const dir = tmp();
		try {
			const resolver = createSelectionResolver(selectionStores(dir));
			const r = await resolver.resolve({
				providerId: "local",
				baseUrl: "",
				apiKey: "k",
				model: "qwen3",
				api: "openai-completions",
				source: "custom",
				contextWindow: 32_000,
				maxTokens: 8_000,
			});
			expect(r.valid).toBe(false);
			expect(r.problems[0]?.code).toBe("invalid_base_url");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the four paths must resolve identically (S2)", () => {
	it("gate, runner and view agree on a live-only model", async () => {
		const dir = tmp();
		try {
			await writeOverlay(dir);
			const stores = selectionStores(dir);

			// ③ gate + ④ runner: the brain the gate probes is the brain that runs.
			const built = await buildBrain(catalogCfg("MiniMax-M3.1-Flash"), stores);
			expect(built.model.id).toBe("MiniMax-M3.1-Flash");
			expect(String(built.model.api)).toBe("anthropic-messages");
			// The brain knows the price is unknown (live-only model).
			expect(built.costKnown).toBe(false);

			// ① view: the same facts the runner will use.
			const cfg = loadConfig({ OPENTTD_DATA_DIR: dir });
			const api = createLlmApi({ dataDir: dir, cfg, envLlm: cfg.llm });
			await api.llm.save({
				source: "catalog",
				providerId: PROVIDER,
				model: "MiniMax-M3.1-Flash",
			});
			const view = (await api.llm.get()) as {
				selection: { model: string; api: string; contextWindow: number; maxTokens: number };
			};
			expect(view.selection.model).toBe("MiniMax-M3.1-Flash");
			expect(view.selection.api).toBe("anthropic-messages");
			expect(view.selection.contextWindow).toBe(204_800);
			expect(view.selection.maxTokens).toBe(131_072);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("the gate does NOT reject a model the runner can run (A5)", async () => {
		const dir = tmp();
		try {
			await writeOverlay(dir);
			// The gate's brain build must find the overlay model. Before S2 the gate
			// built the brain WITHOUT the models store, so it answered "unknown
			// model" for a model the runner happily used.
			const built = await buildBrain(
				catalogCfg("MiniMax-M3.1-Flash"),
				selectionStores(dir),
			);
			expect(built.model.id).toBe("MiniMax-M3.1-Flash");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("createLiveCatalog + resolver agree on the same overlay", () => {
	it("the overlay is visible to both", async () => {
		const dir = tmp();
		try {
			await writeOverlay(dir);
			const store = new JsonModelsStore(path.join(dir, "models-cache.json"));
			const catalog = createLiveCatalog({ modelsStore: store });
			await catalog.refresh(PROVIDER, { allowNetwork: false });
			expect(catalog.models(PROVIDER).map((m) => m.id)).toContain("MiniMax-M3.1-Flash");

			const r = await resolveWithCatalog(catalog, catalogCfg("MiniMax-M3.1-Flash"));
			expect(r.valid).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

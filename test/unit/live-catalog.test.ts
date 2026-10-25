/**
 * Live catalog — the regression guard for "the model list never refreshes".
 *
 * 背景（真机核实）：pi-ai 的内置 provider 是**静态**的（没有 `refreshModels`），
 * 所以 `Models.refresh()` 对它们**直接跳过**——这不是缓存失效，而是根本没有刷新路径。
 * 并且**没有凭据时 `refresh()` 静默返回**（不报错），页面只会一直显示旧列表。
 *
 * 这组断言锁三件事：① 副本注册后真的会问 provider；② 新模型以 `source:"live"` +
 * `priceKnown:false` 出现（价格未知，不是 0 元）；③ 无凭据 / 端点失败都必须**说出口**。
 */

import { describe, expect, it, vi } from "vitest";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { createLiveCatalog, synthesizeModel } from "../../src/agent/live-catalog.js";
import { JsonModelsStore } from "../../src/agent/models-store.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROVIDER = "minimax-cn";

/** Minimal CredentialStore: pi-ai's interface has no shipped in-memory variant. */
function creds(withKey = true): CredentialStore {
	const entries = new Map<string, Credential>();
	if (withKey) entries.set(PROVIDER, { type: "api_key", key: "test-key" } as Credential);
	return {
		async read(providerId) {
			return entries.get(providerId);
		},
		async list() {
			return [];
		},
		async modify(providerId, fn) {
			const next = await fn(entries.get(providerId));
			if (next) entries.set(providerId, next);
			return entries.get(providerId);
		},
		async delete(providerId) {
			entries.delete(providerId);
		},
	};
}

/** A fetch that answers the provider's /models endpoint with the given ids. */
function modelsFetch(ids: string[]) {
	return vi.fn(async () =>
		new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }),
	) as unknown as typeof fetch;
}

describe("createLiveCatalog", () => {
	it("starts from the bundled snapshot, marked as such", () => {
		const cat = createLiveCatalog({ credentials: creds() });
		const models = cat.models(PROVIDER);
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(m.source).toBe("catalog");
			expect(m.priceKnown).toBe(true);
		}
	});

	it("adds models the provider reports, marked live with an unknown price", async () => {
		const cat = createLiveCatalog({ credentials: creds(), fetchImpl: modelsFetch(["MiniMax-M9"]) });
		const before = cat.models(PROVIDER).length;
		const result = await cat.refresh(PROVIDER, { force: true });
		expect(result.error).toBeNull();
		const added = result.models.find((m) => m.id === "MiniMax-M9");
		expect(added, "the newly reported model must appear").toBeTruthy();
		expect(added!.source).toBe("live");
		// Nobody told us a price: 0 must not read as "free" downstream.
		expect(added!.priceKnown).toBe(false);
		expect(added!.cost).toEqual({ input: 0, output: 0 });
		expect(result.models.length).toBe(before + 1);
	});

	it("does not duplicate a model the snapshot already knows", async () => {
		const known = createLiveCatalog({ credentials: creds() }).models(PROVIDER)[0]!.id;
		const cat = createLiveCatalog({ credentials: creds(), fetchImpl: modelsFetch([known]) });
		const result = await cat.refresh(PROVIDER, { force: true });
		expect(result.models.filter((m) => m.id === known)).toHaveLength(1);
		expect(result.models.find((m) => m.id === known)!.source).toBe("catalog");
	});

	it("says out loud that a credentialless refresh is skipped (pi-ai does it silently)", async () => {
		const fetchImpl = modelsFetch(["X"]);
		const cat = createLiveCatalog({ credentials: creds(false), fetchImpl });
		const result = await cat.refresh(PROVIDER, { force: true });
		expect(result.error).toMatch(/credential/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("keeps the previous list when the endpoint fails, and reports why", async () => {
		const failing = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
		const cat = createLiveCatalog({ credentials: creds(), fetchImpl: failing });
		const before = cat.models(PROVIDER).length;
		const result = await cat.refresh(PROVIDER, { force: true });
		expect(result.error).toMatch(/503/);
		expect(result.models.length).toBe(before);
	});

	it("respects the TTL unless forced (implicit calls stay cheap, explicit ones are real)", async () => {
		const fetchImpl = modelsFetch(["A"]);
		const cat = createLiveCatalog({ credentials: creds(), fetchImpl, ttlMs: 60_000 });
		await cat.refresh(PROVIDER, { force: true });
		await cat.refresh(PROVIDER);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		await cat.refresh(PROVIDER, { force: true });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("reports an unknown provider instead of pretending an empty list is the answer", async () => {
		const cat = createLiveCatalog({ credentials: creds() });
		const result = await cat.refresh("no-such-provider", { force: true });
		expect(result.error).toMatch(/unknown provider/i);
	});
});

describe("synthesizeModel", () => {
	it("borrows routing metadata from a sibling and leaves the price unknown", () => {
		const cat = createLiveCatalog({ credentials: creds() });
		const sibling = cat.registry.getModels(PROVIDER)[0]!;
		const m = synthesizeModel(PROVIDER, "brand-new", sibling as never) as unknown as Record<string, unknown>;
		expect(m.api).toBe(sibling.api);
		expect(m.baseUrl).toBe((sibling as unknown as Record<string, unknown>).baseUrl);
		expect(m.contextWindow).toBe((sibling as unknown as Record<string, unknown>).contextWindow);
		expect((m.cost as { input: number }).input).toBe(0);
	});
});

describe("JsonModelsStore", () => {
	it("round-trips entries and tolerates a corrupt file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "models-store-"));
		const file = join(dir, "models-cache.json");
		const store = new JsonModelsStore(file);
		expect(await store.read("p")).toBeUndefined();
		await store.write("p", { models: [{ id: "m" }] as never, checkedAt: 123 });
		expect((await store.read("p"))?.checkedAt).toBe(123);
		writeFileSync(file, "{ not json");
		expect(await store.read("p")).toBeUndefined();
		// A broken cache must be recoverable, not fatal.
		await store.write("p", { models: [] as never });
		expect(JSON.parse(readFileSync(file, "utf8")).p.models).toEqual([]);
		await store.delete("p");
		expect(await store.read("p")).toBeUndefined();
	});
});

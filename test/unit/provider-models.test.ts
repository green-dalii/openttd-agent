/**
 * Live model listing — "the list never refreshes" regression guard.
 *
 * 为什么值得锁：真正的 bug 不是"缓存坏了"，而是把 **pi-ai 的打包快照**当成了
 * "现在有哪些模型"。所以这里锁三件事：① 候选 URL 的形状（anthropic 风格 base URL
 * 的 `/models` 不是路由）；② 失败必须带着"试过什么、为什么失败"返回，而不是空列表；
 * ③ "端点回答了但没模型"与"根本没问到"是两种结论。
 */

import { describe, expect, it, vi } from "vitest";
import {
	createLiveModelsCache,
	fetchLiveModels,
	modelListUrls,
	normalizeModelList,
} from "../../src/agent/provider-models.js";

describe("modelListUrls", () => {
	it("appends /models for OpenAI-compatible base URLs", () => {
		expect(modelListUrls("https://api.deepseek.com/v1", "openai-completions")).toEqual([
			"https://api.deepseek.com/v1/models",
		]);
	});

	it("adds a /v1 fallback when the base URL has no version segment", () => {
		expect(modelListUrls("https://api.example.com", "openai-completions")).toEqual([
			"https://api.example.com/models",
			"https://api.example.com/v1/models",
		]);
	});

	it("knows that an anthropic-style base URL keeps models one level up", () => {
		// Real shape from pi-ai's catalog: minimax-cn → https://api.minimaxi.com/anthropic
		expect(modelListUrls("https://api.minimaxi.com/anthropic", "anthropic-messages")).toEqual([
			"https://api.minimaxi.com/v1/models",
			"https://api.minimaxi.com/anthropic/v1/models",
			"https://api.minimaxi.com/anthropic/models",
		]);
	});

	it("tolerates trailing slashes and empty input", () => {
		expect(modelListUrls("https://api.deepseek.com/v1/", "openai-completions")).toEqual([
			"https://api.deepseek.com/v1/models",
		]);
		expect(modelListUrls("  ", "openai-completions")).toEqual([]);
	});
});

describe("normalizeModelList", () => {
	it("reads the shapes providers actually return", () => {
		expect(normalizeModelList({ data: [{ id: "b" }, { id: "a" }] })).toEqual(["b", "a"]);
		expect(normalizeModelList({ models: [{ name: "x" }] })).toEqual(["x"]);
		expect(normalizeModelList([{ id: "c" }, "d"])).toEqual(["c", "d"]);
		expect(normalizeModelList({ data: ["e"] })).toEqual(["e"]);
	});

	it("dedupes but keeps the endpoint's order (it may be a preference order)", () => {
		expect(normalizeModelList({ data: [{ id: "b" }, { id: "a" }, { id: "b" }] })).toEqual(["b", "a"]);
	});

	it("returns nothing for responses with no usable list", () => {
		expect(normalizeModelList({ error: "nope" })).toEqual([]);
		expect(normalizeModelList(null)).toEqual([]);
		expect(normalizeModelList("plain text")).toEqual([]);
	});
});

describe("fetchLiveModels", () => {
	const ok = (body: unknown) =>
		vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

	it("returns the live ids and records what it tried", async () => {
		const fetchImpl = ok({ data: [{ id: "MiniMax-M4" }] }) as unknown as typeof fetch;
		const r = await fetchLiveModels({
			baseUrl: "https://api.minimaxi.com/anthropic",
			api: "anthropic-messages",
			apiKey: "secret",
			fetchImpl,
		});
		expect(r.models).toEqual(["MiniMax-M4"]);
		expect(r.problems).toEqual([]);
		expect(r.tried[0]).toBe("https://api.minimaxi.com/v1/models");
	});

	it("sends the key as a bearer header, and never in the URL", async () => {
		const fetchImpl = ok({ data: [] }) as unknown as typeof fetch;
		await fetchLiveModels({ baseUrl: "https://x.test/v1", apiKey: "sk-123", fetchImpl });
		const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
		expect(url).not.toContain("sk-123");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-123");
	});

	it("falls through to the next candidate when the first is not a route", async () => {
		const fetchImpl = vi.fn(async (url: string) =>
			url.endsWith("/anthropic/models")
				? new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 })
				: new Response("not found", { status: 404 }),
		) as unknown as typeof fetch;
		const r = await fetchLiveModels({
			baseUrl: "https://api.minimaxi.com/anthropic",
			api: "anthropic-messages",
			fetchImpl,
		});
		expect(r.models).toEqual(["m"]);
	});

	it("reports every failure instead of an empty list (asked ≠ has none)", async () => {
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
		const r = await fetchLiveModels({ baseUrl: "https://x.test/v1", fetchImpl });
		expect(r.models).toEqual([]);
		expect(r.problems.length).toBeGreaterThan(0);
		expect(r.problems[0]!.message).toMatch(/401/);
		expect(r.problems[0]!.message).toMatch(/x\.test/);
	});

	it("distinguishes an unparseable 200 from a failed request", async () => {
		const fetchImpl = vi.fn(async () => new Response("<html>hi</html>", { status: 200 })) as unknown as typeof fetch;
		const r = await fetchLiveModels({ baseUrl: "https://x.test/v1", fetchImpl });
		expect(r.problems[0]!.message).toMatch(/200 but no model list/);
	});

	it("never throws — a thrown fetch is one more reported problem", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const r = await fetchLiveModels({ baseUrl: "https://x.test/v1", fetchImpl });
		expect(r.problems[0]!.message).toMatch(/ECONNREFUSED/);
	});

	/* ---- B5: the failures carry CODES, so the page need not guess (CoDesign F8) ---- */

	it("names a rejected key with a code", async () => {
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
		const r = await fetchLiveModels({ baseUrl: "https://x.test/v1", fetchImpl });
		expect(r.problems[0]!.code).toBe("endpoint_401");
	});

	it("names a forbidden key with a code", async () => {
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
		const r = await fetchLiveModels({ baseUrl: "https://x.test/v1", fetchImpl });
		expect(r.problems[0]!.code).toBe("endpoint_403");
	});

	it("names a provider without a model-list endpoint", async () => {
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
		const r = await fetchLiveModels({ baseUrl: "https://x.test/v1", fetchImpl });
		expect(r.problems[0]!.code).toBe("no_model_endpoint");
	});

	it("names an unreachable provider", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const r = await fetchLiveModels({ baseUrl: "https://x.test/v1", fetchImpl });
		expect(r.problems[0]!.code).toBe("provider_unavailable");
	});

	it("carries no problems when the listing worked", async () => {
		const fetchImpl = ok({ data: [{ id: "m" }] }) as unknown as typeof fetch;
		const r = await fetchLiveModels({ baseUrl: "https://x.test/v1", fetchImpl });
		expect(r.problems).toEqual([]);
	});
});

describe("createLiveModelsCache", () => {
	const value = { models: ["a"], fetchedAt: 1, problems: [], tried: ["u"] };

	it("serves a cached answer inside the TTL", async () => {
		const cache = createLiveModelsCache(60_000);
		const fetcher = vi.fn(async () => value);
		await cache.get("k", fetcher);
		const second = await cache.get("k", fetcher);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(second.cached).toBe(true);
	});

	it("an explicit refresh always reaches the network (the point of the fix)", async () => {
		const cache = createLiveModelsCache(60_000);
		const fetcher = vi.fn(async () => value);
		await cache.get("k", fetcher);
		const refreshed = await cache.get("k", fetcher, { refresh: true });
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(refreshed.cached).toBe(false);
	});

	it("keys by provider+endpoint, so switching providers does not reuse a list", async () => {
		const cache = createLiveModelsCache(60_000);
		const fetcher = vi.fn(async () => value);
		await cache.get("a|u1", fetcher);
		await cache.get("a|u2", fetcher);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

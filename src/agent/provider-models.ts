/**
 * Live model listing (fix: "the model list is always old, it never refreshes").
 *
 * 职责: 向 provider 的 OpenAI 兼容 `/models` 端点**实时**取一次模型 id 列表，并把
 *   失败原因原样带回来（不抛错、不假装成功）。
 * 为什么需要: `provider-catalog.ts` 的列表是 **pi-ai 包内置的快照**（实测
 *   `generatedAt` 是打包日期），它不认识之后新发布的模型；而自定义端点根本没有目录。
 *   快照可以被当作"已知模型的说明书"，但不能被当作"现在有哪些模型"。
 * 铁律:
 *   - 失败要**说清试过哪些 URL、各自为什么失败**（"拿不到" ≠ "没有模型"）。
 *   - 成功但空列表 = 端点回答了但没有模型（与失败区分）。
 *   - **失败带 code**（B5）：页面按 code 渲染，不再用正则猜"401 该做什么"。
 *   - 不做猜测式 URL 拼接：候选顺序固定，且都写进错误里。
 * 禁止: 读取或打印密钥；本模块只把它放进请求头。
 */

import { problem, type Problem, type ProblemCode } from "./problems.js";

/** Result of one live listing attempt. */
export interface LiveModelsResult {
	/** Deduped ids, in the order the endpoint returned them. */
	models: string[];
	/** When the request completed (ms since epoch). */
	fetchedAt: number;
	/** Why the listing failed — one entry per attempt (empty when it worked). */
	problems: Problem[];
	/** URLs tried, in order (for the error message and for debugging). */
	tried: string[];
}

export interface FetchLiveModelsOptions {
	baseUrl: string;
	/** Which API family the provider speaks; changes the candidate URL shape. */
	api?: string | null;
	apiKey?: string | null;
	headers?: Record<string, string>;
	/** Injectable for tests. */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/** Drop trailing slashes so `${base}/models` never doubles them. */
function trimBase(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * Candidate URLs for a provider's model list, most likely first.
 *
 * Anthropic-style base URLs end in `/anthropic` (e.g. `https://api.minimaxi.com/anthropic`),
 * where `/models` is not a route; the OpenAI-compatible list lives one level up under
 * `/v1/models`. Exported so the error message and the tests agree on the order.
 */
export function modelListUrls(baseUrl: string, api?: string | null): string[] {
	const base = trimBase(baseUrl);
	if (!base) return [];
	const urls: string[] = [];
	const anthropic = (api ?? "").startsWith("anthropic");
	if (anthropic) {
		// Three real shapes seen in the wild: the OpenAI-compatible list one level
		// up, the vendor's own `/anthropic/v1/models`, and a route on the base itself.
		urls.push(`${base.replace(/\/anthropic$/, "")}/v1/models`);
		urls.push(`${base}/v1/models`);
		urls.push(`${base}/models`);
	} else {
		urls.push(`${base}/models`);
		if (!/\/v\d+$/.test(base)) urls.push(`${base}/v1/models`);
	}
	return [...new Set(urls)];
}

/**
 * Extract model ids from the shapes providers actually return.
 *
 * Accepts `{data:[{id}]}`, `{models:[{id|name}]}`, `[{id}]`, `{data:["id"]}` and
 * `{models:["id"]}`; anything else yields an empty list (and the caller reports
 * "the endpoint answered but no models were found", never "no models exist").
 */
export function normalizeModelList(body: unknown): string[] {
	const pick = (entry: unknown): string | null => {
		if (typeof entry === "string") return entry.trim() || null;
		if (entry && typeof entry === "object") {
			const e = entry as Record<string, unknown>;
			for (const key of ["id", "name", "model"]) {
				const v = e[key];
				if (typeof v === "string" && v.trim()) return v.trim();
			}
		}
		return null;
	};
	const arr = Array.isArray(body)
		? body
		: body && typeof body === "object"
			? ((body as Record<string, unknown>).data ?? (body as Record<string, unknown>).models)
			: null;
	if (!Array.isArray(arr)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of arr) {
		const id = pick(entry);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * The code for one failed attempt.
 *
 * 事实来源: HTTP 状态码本身（不是对错误文案做正则）——401/403/404 各有各的
 *   下一步动作，混成一句话就又得让页面去猜。
 */
function codeForStatus(status: number): ProblemCode {
	if (status === 401) return "endpoint_401";
	if (status === 403) return "endpoint_403";
	if (status === 404) return "no_model_endpoint";
	return "provider_unavailable";
}

/**
 * Ask the provider what models it has right now.
 *
 * Never throws: every failure becomes a structured problem with the tried URLs,
 * because "we could not ask" and "it has none" are different claims.
 */
export async function fetchLiveModels(opts: FetchLiveModelsOptions): Promise<LiveModelsResult> {
	const fetchedAt = Date.now();
	const urls = modelListUrls(opts.baseUrl, opts.api);
	if (!urls.length) {
		return {
			models: [],
			fetchedAt,
			problems: [problem("invalid_base_url", "no base URL configured")],
			tried: [],
		};
	}
	const doFetch = opts.fetchImpl ?? fetch;
	const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
	if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
	const problems: Problem[] = [];
	for (const url of urls) {
		try {
			const res = await doFetch(url, {
				headers,
				signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
			});
			if (!res.ok) {
				problems.push(problem(codeForStatus(res.status), `${url} → HTTP ${res.status}`));
				continue;
			}
			const body: unknown = await res.json().catch(() => null);
			const models = normalizeModelList(body);
			if (models.length) return { models, fetchedAt: Date.now(), problems: [], tried: urls };
			// Answered, but nothing parseable: say so rather than claiming success.
			problems.push(problem("provider_unavailable", `${url} → 200 but no model list in the response`));
		} catch (e) {
			problems.push(
				problem("provider_unavailable", `${url} → ${e instanceof Error ? e.message : String(e)}`),
			);
		}
	}
	return { models: [], fetchedAt, problems, tried: urls };
}

/**
 * Short-lived cache for live listings.
 *
 * Why any cache at all: the page asks on every dropdown open. Why a TTL rather
 * than a permanent cache: the whole point of this endpoint is freshness, so an
 * explicit `refresh` must always reach the network, and an implicit one must not
 * be older than `ttlMs`.
 */
export function createLiveModelsCache(ttlMs = 30_000) {
	const entries = new Map<string, { at: number; value: LiveModelsResult }>();
	return {
		async get(key: string, fetcher: () => Promise<LiveModelsResult>, opts: { refresh?: boolean } = {}) {
			const hit = entries.get(key);
			if (!opts.refresh && hit && Date.now() - hit.at < ttlMs) return { ...hit.value, cached: true };
			const value = await fetcher();
			entries.set(key, { at: Date.now(), value });
			return { ...value, cached: false };
		},
		clear() {
			entries.clear();
		},
	};
}

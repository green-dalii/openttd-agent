/**
 * Live model catalog — the provider's own model list, on top of pi-ai's snapshot.
 *
 * 职责: 用 **pi-ai 自己的动态目录机制**（`createProvider({fetchModels})` +
 *   `Models.refresh()` + `ModelsStore`）让内置 provider 的模型列表可以被刷新，
 *   并把"哪些模型是刚问到的、哪些是包里带来的"分开标记。
 * 为什么不是自己写缓存: pi-ai 已经拥有这套机制（`fetchModels` 覆盖层、事务化发布、
 *   `ModelsStore` 持久化、`errors` 收集）。我们只需要提供**这个 provider 怎么问**
 *   （URL 与解析）以及**新模型缺的元数据**从哪补（同族模型）。
 * 已核实的行为（读 `dist/models.js` 并真机验证）:
 *   - 内置 provider 是**静态**的（没有 `refreshModels`）⇒ `refresh()` 会直接跳过；
 *     注册一个带 `fetchModels` 的克隆后才会真正联网（真机：有凭据时
 *     `fetchModels` 被调用，`allowNetwork=true`）。
 *   - **没有凭据时 `refresh()` 静默返回**（不报错）⇒ 这一层必须自己把
 *     "没有凭据，刷新被跳过"说出口，否则页面显示旧列表而没有任何解释。
 *   - `refresh()` 的第一阶段 `allowNetwork=false`，用来恢复 `ModelsStore` 里的缓存。
 * 禁止: 猜测新模型的价格（= 0 且 `priceKnown=false`）；打印密钥。
 */

import {
	createProvider,
	type CredentialStore,
	type Model,
	type ModelsStore,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fetchLiveModels } from "./provider-models.js";
import type { CatalogModel } from "./provider-types.js";

/** What one refresh produced (always resolved, never thrown). */
export interface LiveRefreshResult {
	/** The provider's current known models (snapshot + overlay), as the UI renders them. */
	models: CatalogModel[];
	/** Human-readable reason the refresh did not happen / did not help, else null. */
	error: string | null;
	/** When the provider was last asked successfully (ms), null if never. */
	fetchedAt: number | null;
}

export interface LiveCatalog {
	/** Sync view: snapshot + whatever the last successful refresh added. */
	models(providerId: string): CatalogModel[];
	/** Ask the provider (or its stored cache) and return the merged list. */
	refresh(providerId: string, opts?: { force?: boolean; allowNetwork?: boolean }): Promise<LiveRefreshResult>;
	/** The underlying registry (the runner builds models from the same one). */
	readonly registry: MutableModels;
}

export interface LiveCatalogOptions {
	credentials?: CredentialStore;
	/** Persist refreshed lists so a restart does not lose them (pi-ai owns the format). */
	modelsStore?: ModelsStore;
	/** Injectable for tests. */
	fetchImpl?: typeof fetch;
	/** How long a successful live list stays fresh for non-forced calls. */
	ttlMs?: number;
	now?: () => number;
}

/** Project a pi-ai Model into the wire shape. */
function toCatalogModel(m: Model<string>, source: "catalog" | "live"): CatalogModel {
	const api = String(m.api);
	const ctx = Number((m as { contextWindow?: number }).contextWindow ?? 0);
	const max = Number((m as { maxTokens?: number }).maxTokens ?? 0);
	const cost = (m.cost ?? {}) as { input?: number; output?: number };
	return {
		id: String(m.id),
		name: String(m.name ?? m.id),
		api,
		contextWindow: ctx,
		maxTokens: max,
		reasoning: Boolean((m as { reasoning?: boolean }).reasoning),
		cost: { input: Number(cost.input ?? 0), output: Number(cost.output ?? 0) },
		source,
		// A live-only model has no price table anywhere; 0 here means unknown.
		priceKnown: source === "catalog",
	};
}

/**
 * Give a live-only id the metadata pi-ai needs to stream it.
 *
 * Only reachable for ids the snapshot does not know. Everything (api, baseUrl,
 * context window, max tokens) is borrowed from a sibling of the **same provider**,
 * and the price is left at 0 with `priceKnown=false` - so the scorecard will call
 * its cost "not measured" rather than free.
 */
export function synthesizeModel(providerId: string, id: string, sibling: Model<string>): Model<string> {
	const s = sibling as unknown as Record<string, unknown>;
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
	return {
		id,
		name: id,
		provider: providerId,
		api: sibling.api,
		baseUrl: sibling.baseUrl,
		input: (s.input as string[] | undefined) ?? ["text"],
		reasoning: false,
		cost: zero,
		contextWindow: Number(s.contextWindow ?? 0),
		maxTokens: Number(s.maxTokens ?? 0),
	} as unknown as Model<string>;
}

/**
 * Build a registry whose built-in providers can be refreshed on demand.
 *
 * Providers are patched lazily (only when asked for), so a page that never opens
 * the model list costs nothing.
 */
export function createLiveCatalog(opts: LiveCatalogOptions = {}): LiveCatalog {
	const registry: MutableModels = builtinModels(
		opts.credentials || opts.modelsStore
			? {
					...(opts.credentials ? { credentials: opts.credentials } : {}),
					...(opts.modelsStore ? { modelsStore: opts.modelsStore } : {}),
				}
			: undefined,
	);
	const ttlMs = opts.ttlMs ?? 60_000;
	const now = opts.now ?? (() => Date.now());
	const lastOk = new Map<string, number>();
	const lastError = new Map<string, string>();
	/** Ids the bundled snapshot knew, per provider - used to tell "live only" apart. */
	const baselineIds = new Map<string, Set<string>>();

	/** Replace the static provider with a clone that can fetch its own list. */
	function enable(providerId: string): string | null {
		const base = registry.getProvider(providerId);
		if (!base) return `unknown provider "${providerId}"`;
		if (base.refreshModels) return null; // already patched
		const siblings = base.getModels() as readonly Model<string>[];
		if (!siblings.length) return `provider "${providerId}" has no baseline model to borrow metadata from`;
		baselineIds.set(providerId, new Set(siblings.map((m) => String(m.id))));
		const sibling = siblings[0]!;
		const api = String(sibling.api);
		registry.setProvider(
			createProvider({
				id: providerId,
				name: base.name,
				baseUrl: base.baseUrl,
				headers: base.headers,
				auth: base.auth,
				models: siblings,
				// The provider object already carries the api streams; adapt them to the
				// ProviderStreams shape createProvider expects (same call signatures).
				api: {
					stream: base.stream.bind(base),
					streamSimple: base.streamSimple.bind(base),
				} as unknown as Parameters<typeof createProvider>[0]["api"],
				fetchModels: async (ctx: unknown) => {
					const c = ctx as { force?: boolean; credential?: { key?: string; access?: string } };
					const fresh = c;
					if (!fresh.force) {
						const at = lastOk.get(providerId);
						if (at !== undefined && now() - at < ttlMs) return [];
					}
					const credential = c.credential;
					const result = await fetchLiveModels({
						baseUrl: String(sibling.baseUrl ?? base.baseUrl ?? ""),
						api,
						apiKey: credential?.key ?? credential?.access ?? null,
						fetchImpl: opts.fetchImpl,
					});
					if (result.error) {
						lastError.set(providerId, result.error);
						// Keep the previous list: the endpoint told us nothing, which is not
						// evidence that the models disappeared.
						return [];
					}
					lastError.delete(providerId);
					lastOk.set(providerId, Date.now());
					const known = new Set(siblings.map((m) => String(m.id)));
					return result.models
						.filter((id) => !known.has(id))
						.map((id) => synthesizeModel(providerId, id, sibling));
				},
			} as never),
		);
		return null;
	}

	function models(providerId: string): CatalogModel[] {
		const provider = registry.getProvider(providerId);
		if (!provider) return [];
		const snapshot = baselineIds.get(providerId);
		return (registry.getModels(providerId) as readonly Model<string>[])
			.map((m) => toCatalogModel(m, snapshot && !snapshot.has(String(m.id)) ? "live" : "catalog"))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	return {
		registry,
		models,
		async refresh(providerId, refreshOpts = {}) {
			const enableError = enable(providerId);
			if (enableError) {
				return { models: models(providerId), error: enableError, fetchedAt: lastOk.get(providerId) ?? null };
			}
			// pi-ai silently skips providers it cannot authenticate; asking first turns
			// "the list is still old" into an explanation the page can show.
			const auth = await registry.getAuth(providerId).catch(() => undefined);
			if (!auth) {
				const error = `no credential configured for "${providerId}" (an unauthenticated refresh is skipped by the provider layer)`;
				lastError.set(providerId, error);
				return { models: models(providerId), error, fetchedAt: lastOk.get(providerId) ?? null };
			}
			const result = await registry.refresh({
				providers: [providerId],
				...(refreshOpts.force ? { force: true } : {}),
				// Run start restores the persisted overlay without a network call; the
				// Providers page is where a human asks for a fresh list.
				...(refreshOpts.allowNetwork === false ? { allowNetwork: false } : {}),
			});
			const err = result.errors.get(providerId);
			const error = err ? err.message : (lastError.get(providerId) ?? null);
			return { models: models(providerId), error, fetchedAt: lastOk.get(providerId) ?? null };
		},
	};
}

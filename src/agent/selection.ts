/**
 * Selection resolution — the ONE answer to "what will this run actually use?".
 *
 * 职责: 把「用户选了什么」(intent) 与「运行时真正会用什么」(facts) 分开，
 *   并给出一条**推导路径**供四条调用方共用：
 *     ① view   (GET  /api/llm)   —— 页面显示的
 *     ② save   (POST /api/llm)   —— 保存时的校验
 *     ③ gate   (preflight)       —— 启动门禁
 *     ④ runner (buildBrain)      —— 真正跑的
 * 为什么必须共用: 四条路径各解一次就会**各说各话**。2026-10-24 的真 bug：门禁说
 *   "unknown model"（它没读持久化的模型覆盖层），而运行其实能跑同一个模型。
 * 事实来源: docs/SELECTION-STATE-CODESIGN.md §4.1（唯一权威）。
 * 禁止: 在此发网络请求（除调用方显式要求刷新）；把"请求值"当成"生效值"；
 *   在此判断凭据（凭据状态由 statusFor/probe 负责，见 problems.ts 的说明）。
 */

import path from "node:path";
import type { CredentialStore, Model, Models, ModelsStore } from "@earendil-works/pi-ai";
import type { LlmConfig } from "../config.js";
import { CUSTOM_LLM_APIS } from "../config.js";
import { FileCredentialStore } from "./file-credential-store.js";
import { createLiveCatalog, type LiveCatalog } from "./live-catalog.js";
import { JsonModelsStore, modelsCachePath } from "./models-store.js";
import { isCatalogProvider } from "./provider-catalog.js";
import { resolveLlmSource } from "./llm-settings.js";
import type { Problem } from "./problems.js";

/** What the user asked for (before resolution). */
export interface SelectionIntent {
	source: "catalog" | "custom";
	providerId: string;
	model: string;
	/** Custom endpoints only: the streaming API the user picked. */
	api?: string;
	/** Custom endpoints only. */
	baseUrl?: string;
}

/** What the run will really use (after resolution). */
export interface SelectionFacts {
	providerId: string;
	model: string;
	api: string;
	baseUrl: string;
	contextWindow: number;
	maxTokens: number;
	/**
	 * Whether this model's cost is measurable (it has a non-zero price table).
	 *
	 * Named `costKnown` — the same name the metric row and the brain already use
	 * (D77: one fact, one name). A live-only model has no price table at all, so
	 * its cost is *unknown*, not zero.
	 */
	costKnown: boolean;
	/** Whether the provider id is a known built-in provider. */
	providerKnown: boolean;
	/**
	 * Whether the model id is known to the provider (snapshot **or** persisted
	 * live overlay). For a custom endpoint we take the user's word: there is no
	 * catalog to check against.
	 */
	modelKnown: boolean;
}

export interface ResolvedSelection {
	intent: SelectionIntent;
	facts: SelectionFacts;
	/**
	 * The selection is **coherent**: it names a provider/model that exists.
	 *
	 * Named `valid`, not `usable`: whether a run can actually *start* also needs
	 * a credential and a reachable endpoint, which this layer does not judge
	 * (one name, one fact — D77).
	 */
	valid: boolean;
	problems: Problem[];
	/**
	 * Catalog path only: the model object that will be streamed and the
	 * registry that owns it. The runner streams through **this** registry, so the
	 * model that was validated is the model that runs.
	 */
	catalog?: { model: Model<string>; models: Models };
}

/** The two stores a resolver needs (both are file-backed, both per data dir). */
export interface SelectionStores {
	/** App-owned credential store (so dashboard-saved keys are used). */
	credentials?: CredentialStore;
	/** Persisted overlay of models the provider reported live (pi-ai `ModelsStore`). */
	modelsStore?: ModelsStore;
}

/** The standard stores for a data dir (one place, so no caller builds its own). */
export function selectionStores(dataDir: string): SelectionStores {
	return {
		credentials: new FileCredentialStore(path.join(dataDir, "credentials.json")),
		modelsStore: new JsonModelsStore(modelsCachePath(dataDir)),
	};
}

/**
 * A resolver over one catalog.
 *
 * The catalog (and therefore the pi-ai registry with ~1900 models) is expensive
 * to build, so a resolver owns one and reuses it — the persisted live overlay
 * is restored from the store on every resolve, never from the network.
 */
export interface SelectionResolver {
	resolve(llm: LlmConfig): Promise<ResolvedSelection>;
}

/**
 * Build a resolver over the given stores.
 *
 * `catalog` may be injected when the caller already owns one (the Providers
 * page keeps one per process so the overlay survives reloads) — two catalogs
 * over the same store would agree, but one is cheaper and cannot drift.
 */
export function createSelectionResolver(
	stores: SelectionStores,
	catalog?: LiveCatalog,
): SelectionResolver {
	const owned =
		catalog ??
		createLiveCatalog({
			...(stores.credentials ? { credentials: stores.credentials } : {}),
			...(stores.modelsStore ? { modelsStore: stores.modelsStore } : {}),
		});
	return { resolve: (llm) => resolveWithCatalog(owned, llm) };
}

/** Any non-zero price means the cost is measurable (same rule as the brain). */
export function hasPriceTable(model: Model<string>): boolean {
	const c = model.cost as
		| { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
		| undefined;
	if (!c) return false;
	return [c.input, c.output, c.cacheRead, c.cacheWrite].some(
		(v) => typeof v === "number" && v > 0,
	);
}

/**
 * Resolve one selection against a prepared catalog.
 *
 * Catalog path: the model is looked up in the snapshot **plus** the persisted
 * live overlay (the overlay is restored from the store — never the network).
 * Custom path: the config *is* the truth (there is no catalog to check), and
 * the cost is unknown because a custom endpoint carries no price table.
 */
export async function resolveWithCatalog(
	catalog: LiveCatalog,
	llm: LlmConfig,
): Promise<ResolvedSelection> {
	const source = resolveLlmSource(llm);
	const problems: Problem[] = [];

	if (source === "custom") {
		const api = CUSTOM_LLM_APIS.includes(llm.api as (typeof CUSTOM_LLM_APIS)[number])
			? llm.api
			: "openai-completions";
		const baseUrl = llm.baseUrl.trim();
		if (!baseUrl) {
			problems.push({
				code: "invalid_base_url",
				message: "a custom endpoint needs a base URL",
				hint: "fill in the endpoint URL (e.g. http://127.0.0.1:11434/v1) on the Providers page",
			});
		}
		return {
			intent: { source, providerId: llm.providerId, model: llm.model, api, baseUrl },
			facts: {
				providerId: llm.providerId,
				model: llm.model,
				api,
				baseUrl,
				contextWindow: llm.contextWindow,
				maxTokens: llm.maxTokens,
				// A custom endpoint is registered with zero prices: unknown, not free.
				costKnown: false,
				providerKnown: true,
				modelKnown: true,
			},
			valid: problems.length === 0,
			problems,
		};
	}

	const providerId = llm.providerId;
	const providerKnown = isCatalogProvider(providerId);
	if (!providerKnown) {
		problems.push({
			code: "unknown_provider",
			message: `"${providerId}" is not a built-in provider`,
			hint: "pick a provider from the catalog on the Providers page",
		});
		return {
			intent: { source, providerId, model: llm.model },
			facts: {
				providerId,
				model: llm.model,
				api: llm.api,
				baseUrl: "",
				contextWindow: llm.contextWindow,
				maxTokens: llm.maxTokens,
				costKnown: false,
				providerKnown: false,
				modelKnown: false,
			},
			valid: false,
			problems,
		};
	}

	// Restore the persisted live overlay (store read, never the network) so a
	// model the Providers page listed is still selectable after a restart.
	await catalog.refresh(providerId, { allowNetwork: false }).catch(() => undefined);
	const known = catalog.models(providerId);
	const picked = known.find((m) => m.id === llm.model);
	if (!picked) {
		problems.push({
			code: "unknown_model",
			message: `provider "${providerId}" does not know model "${llm.model}"`,
			hint: 'press "Refresh from provider" on the Providers page, then pick a model from the list',
		});
		return {
			intent: { source, providerId, model: llm.model },
			facts: {
				providerId,
				model: llm.model,
				api: llm.api,
				baseUrl: "",
				contextWindow: llm.contextWindow,
				maxTokens: llm.maxTokens,
				costKnown: false,
				providerKnown: true,
				modelKnown: false,
			},
			valid: false,
			problems,
		};
	}

	const model = catalog.registry.getModel(providerId, llm.model);
	if (!model) {
		// The projection knows it but the registry does not — a broken overlay.
		// Report it as unknown rather than pretending it can run.
		problems.push({
			code: "unknown_model",
			message: `provider "${providerId}" listed "${llm.model}" but cannot serve it`,
			hint: 'press "Refresh from provider" on the Providers page to rebuild the model list',
		});
		return {
			intent: { source, providerId, model: llm.model },
			facts: {
				providerId,
				model: llm.model,
				api: picked.api,
				baseUrl: "",
				contextWindow: picked.contextWindow,
				maxTokens: picked.maxTokens,
				costKnown: false,
				providerKnown: true,
				modelKnown: false,
			},
			valid: false,
			problems,
		};
	}

	return {
		intent: { source, providerId, model: llm.model },
		facts: {
			providerId,
			model: llm.model,
			api: picked.api,
			baseUrl: String((model as { baseUrl?: string }).baseUrl ?? ""),
			contextWindow: picked.contextWindow,
			maxTokens: picked.maxTokens,
			costKnown: hasPriceTable(model),
			providerKnown: true,
			modelKnown: true,
		},
		valid: true,
		problems,
		catalog: { model, models: catalog.registry },
	};
}

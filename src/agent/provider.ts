/**
 * Agent provider — build a pi-ai provider from our LlmConfig (SPEC §4).
 *
 * 职责: 装配 brain 的 provider。两条路径（docs/DASHBOARD-API.md §6.5）:
 *   - **catalog**: pi-ai 内置 provider（39 个）——`builtinModels()` 已注册真实
 *     baseUrl/API/认证，我们只选模型，认证由 store/env 解析，**不再手建 provider**。
 *   - **custom**: 任意 OpenAI 兼容端点（baseUrl + apiKey + api），用
 *     `createProvider` 手建（向后兼容旧配置）。
 * 事实来源: pi-ai providers/all（builtinModels/getBuiltinModels）；models.d.ts
 *   （createProvider/createModels）；运行验证见 docs/DASHBOARD-API.md 顶部。
 * 禁止: 在此硬编码任何真实密钥；禁止在无配置时静默发起网络请求。
 */

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import type { CredentialStore, Model, ProviderStreams } from "@earendil-works/pi-ai";
import type { LlmConfig } from "../config.js";
import { CUSTOM_LLM_APIS } from "../config.js";
import { DEFAULT_LLM_PROVIDER_ID, resolveLlmSource } from "./llm-settings.js";
import { getCatalogProvider, listCatalogModels } from "./provider-catalog.js";

/** Lazily loaded streaming API impls (subpath exports; heavy modules). */
async function loadApi(api: string): Promise<ProviderStreams> {
	if (api === "anthropic-messages") {
		const m = await import("@earendil-works/pi-ai/api/anthropic-messages.lazy");
		return m.anthropicMessagesApi();
	}
	const m = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
	return m.openAICompletionsApi();
}

export interface BuiltProvider {
	model: Model<string>;
	/** Which path produced this provider (see docs §6.5). */
	source: "catalog" | "custom";
	/** streamFn compatible with pi-agent-core's StreamFn. */
	streamFn: (model: unknown, context: never, options?: never) => ReturnType<ReturnType<typeof createModels>["stream"]>;
}

/** Options for brain construction. */
export interface BuildBrainOptions {
	/**
	 * App-owned credential store. Required for catalog providers so that keys
	 * saved from the dashboard are used (pi-ai otherwise only reads env vars).
	 */
	credentials?: CredentialStore;
}

/**
 * Build the brain's provider. Two paths (docs/DASHBOARD-API.md §6.5):
 *
 * - **catalog**: a pi-ai built-in provider (39 available). We do NOT hand-build
 *   the provider; `builtinModels()` already registered it with its real baseUrl,
 *   APIs and auth, so we only pick the model and resolve auth via the injected
 *   credential store (falling back to the provider's env vars).
 * - **custom**: an arbitrary OpenAI-compatible endpoint (baseUrl + apiKey).
 *
 * Throws when the selection is incomplete or the model is unknown.
 */
export async function buildBrain(llm: LlmConfig, opts: BuildBrainOptions = {}): Promise<BuiltProvider> {
	const source = resolveLlmSource(llm);
	if (source === "catalog") return buildCatalogBrain(llm, opts);
	return buildCustomBrain(llm);
}

/** Select a model from the built-in catalog; auth comes from store/env. */
async function buildCatalogBrain(llm: LlmConfig, opts: BuildBrainOptions): Promise<BuiltProvider> {
	const providerId = llm.providerId;
	if (!providerId || !llm.model) {
		throw new Error("LLM not configured: pick a built-in provider and model in the dashboard (or set LLM_PROVIDER/LLM_MODEL).");
	}
	const known = listCatalogModels(providerId);
	const picked = known.find((m) => m.id === llm.model);
	if (!picked) {
		throw new Error(
			`unknown model "${llm.model}" for built-in provider "${providerId}"` +
				(known.length ? ` (e.g. ${known.slice(0, 3).map((m) => m.id).join(", ")})` : ""),
		);
	}
	const models = builtinModels(opts.credentials ? { credentials: opts.credentials } : {});
	const model = models.getModel(providerId, llm.model);
	if (!model) throw new Error(`provider "${providerId}" did not register model "${llm.model}"`);
	// Auth (apiKey from the credential store or the provider's env var) and the
	// request baseUrl are resolved by pi-ai per request — we pass none of them.
	const streamFn = (_m: unknown, context: never, options?: never) =>
		models.stream(model, context, options);
	return { model: model as Model<string>, source: "catalog", streamFn: streamFn as BuiltProvider["streamFn"] };
}

/**
 * Build a single-model provider from config. Throws if baseUrl/model missing —
 * callers should gate on `isLlmConfigured()`.
 */
export async function buildProvider(llm: LlmConfig): Promise<BuiltProvider> {
	const built = await buildCustomBrain(llm);
	return built;
}

/** Custom OpenAI-compatible endpoint (baseUrl/apiKey supplied by the user). */
async function buildCustomBrain(llm: LlmConfig): Promise<BuiltProvider> {
	if (!llm.baseUrl || !llm.model) {
		throw new Error("LLM not configured: set LLM_BASE_URL and LLM_MODEL (or use the dashboard/CLI).");
	}
	if (!CUSTOM_LLM_APIS.includes(llm.api as (typeof CUSTOM_LLM_APIS)[number])) {
		throw new Error(
			`unsupported api "${llm.api}" for a custom endpoint (${CUSTOM_LLM_APIS.join("|")})`,
		);
	}
	// providerId may be blank (no env/file id): apply the default here, at use
	// time, instead of baking it during a merge (see applyLlmSettingsFile).
	const providerId = llm.providerId || DEFAULT_LLM_PROVIDER_ID;
	const models = createModels();
	const provider = createProvider({
		id: providerId,
		name: `OpenTTD Agent (${providerId})`,
		baseUrl: llm.baseUrl,
		auth: {
			apiKey: {
				name: `${providerId} API key`,
				// Supply the configured key directly (no ambient env lookup).
				resolve: async () => ({ auth: { apiKey: llm.apiKey }, source: "config" }),
			},
		},
		models: [
			{
				id: llm.model,
				name: llm.model,
				api: llm.api,
				provider: providerId,
				baseUrl: llm.baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: llm.contextWindow,
				maxTokens: llm.maxTokens,
			} as Model<string>,
		],
		api: await loadApi(llm.api),
	});
	models.setProvider(provider);
	const model = models.getModel(providerId, llm.model);
	if (!model) throw new Error(`provider did not register model "${llm.model}"`);
	// Bind the models instance: pi-agent-core calls streamFn(model, context, options).
	const streamFn = (_m: unknown, context: never, options?: never) =>
		models.stream(model, context, options);
	return { model: model as Model<string>, source: "custom", streamFn: streamFn as BuiltProvider["streamFn"] };
}

/** Human-readable brain label for logs (never includes a key). */
export function describeBrain(llm: LlmConfig): string {
	const src = resolveLlmSource(llm);
	if (src === "catalog") {
		const p = getCatalogProvider(llm.providerId);
		return `catalog provider "${llm.providerId}"${p ? "" : " (unknown)"} model=${llm.model}`;
	}
	return `custom provider "${llm.providerId || DEFAULT_LLM_PROVIDER_ID}" model=${llm.model} base=${llm.baseUrl}`;
}

/** Redact a key for logs/UI (never print full secrets). */
export function redactKey(key: string): string {
	if (!key) return "(unset)";
	if (key.length <= 8) return "****";
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Remove a secret from arbitrary text (provider error bodies often echo the key
 * back). Distinct from `redactKey`, which *masks* a key for display; this one
 * *eliminates* it. Kept next to redactKey so key-safety lives in one place.
 */
export function scrubSecret(text: string, secret: string): string {
	if (!secret || secret.length < 4) return text;
	return text.split(secret).join("<redacted>");
}

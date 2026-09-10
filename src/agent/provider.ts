/**
 * Agent provider — build a pi-ai provider from our LlmConfig (SPEC §4).
 *
 * 职责: 用 pi-ai 官方组件（createProvider + openAICompletionsApi /
 *   anthropicMessagesApi）把配置（baseUrl / apiKey / model）装配成可用的
 *   Model + streamFn，供 pi-agent-core 的 Agent 使用。支持任意 OpenAI 兼容
 *   端点（OpenAI、DeepSeek、本地 llama.cpp/vLLM、网关…）。
 * 事实来源: pi-ai models.d.ts（createProvider/createModels）；pi 官方
 *   docs/custom-provider.md（createProvider + api 形状）。
 * 禁止: 在此硬编码任何真实密钥；禁止在无配置时静默发起网络请求。
 */

import { createModels, createProvider } from "@earendil-works/pi-ai";
import type { Model, ProviderStreams } from "@earendil-works/pi-ai";
import type { LlmConfig } from "../config.js";

/** Lazily loaded streaming API impls (subpath exports; heavy modules). */
async function loadApi(api: LlmConfig["api"]): Promise<ProviderStreams> {
	if (api === "anthropic-messages") {
		const m = await import("@earendil-works/pi-ai/api/anthropic-messages.lazy");
		return m.anthropicMessagesApi();
	}
	const m = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
	return m.openAICompletionsApi();
}

export interface BuiltProvider {
	model: Model<string>;
	/** streamFn compatible with pi-agent-core's StreamFn. */
	streamFn: (model: unknown, context: never, options?: never) => ReturnType<ReturnType<typeof createModels>["stream"]>;
}

/**
 * Build a single-model provider from config. Throws if baseUrl/model missing —
 * callers should gate on `isLlmConfigured()`.
 */
export async function buildProvider(llm: LlmConfig): Promise<BuiltProvider> {
	if (!llm.baseUrl || !llm.model) {
		throw new Error("LLM not configured: set LLM_BASE_URL and LLM_MODEL (or use the dashboard/CLI).");
	}
	const models = createModels();
	const provider = createProvider({
		id: llm.providerId,
		name: `OpenTTD Agent (${llm.providerId})`,
		baseUrl: llm.baseUrl,
		auth: {
			apiKey: {
				name: `${llm.providerId} API key`,
				// Supply the configured key directly (no ambient env lookup).
				resolve: async () => ({ auth: { apiKey: llm.apiKey }, source: "config" }),
			},
		},
		models: [
			{
				id: llm.model,
				name: llm.model,
				api: llm.api,
				provider: llm.providerId,
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
	const model = models.getModel(llm.providerId, llm.model);
	if (!model) throw new Error(`provider did not register model "${llm.model}"`);
	// Bind the models instance: pi-agent-core calls streamFn(model, context, options).
	const streamFn = (_m: unknown, context: never, options?: never) =>
		models.stream(model, context, options);
	return { model: model as Model<string>, streamFn: streamFn as BuiltProvider["streamFn"] };
}

/** Redact a key for logs/UI (never print full secrets). */
export function redactKey(key: string): string {
	if (!key) return "(unset)";
	if (key.length <= 8) return "****";
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

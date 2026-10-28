/**
 * LLM dashboard API — selection + credentials behind /api/llm (docs §3.1).
 *
 * 职责: 把「目录选型 + 密钥存储 + llm.json 持久化」收敛成一个可注入的 hook 对象，
 *   供 WebServer 使用（避免 runner 里堆 REST 逻辑）。两条路径:
 *   - catalog: 选 pi-ai 内置 provider，密钥存 credentials.json（FileCredentialStore）；
 *   - custom: 自建 OpenAI 兼容端点，baseUrl/api/apiKey 存 llm.json。
 *   get/save 均为**同步**（WebServer 直接序列化返回值）。
 * 事实来源: docs/DASHBOARD-API.md §3.1（冻结契约）；pi-ai compat.findEnvKeys。
 * 禁止: 回显明文密钥（对外只有 hasStoredKey/envKeys/source）；不写 dataDir 之外。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Config, LlmConfig } from "../config.js";
import { CUSTOM_LLM_APIS, isLlmConfigured } from "../config.js";
import {
	applyLlmSettingsFile,
	resolveLlmSource,
	saveLlmSettingsFile,
	settingsPath,
} from "./llm-settings.js";
import {
	catalogGeneratedAt,
	expectedEnvKeys,
	isCatalogProvider,
	listCatalogProvidersWithStatus,
} from "./provider-catalog.js";
import { FileCredentialStore } from "./file-credential-store.js";
import { createLiveCatalog } from "./live-catalog.js";
import { createSelectionResolver, type ResolvedSelection } from "./selection.js";
import { ProblemError } from "./problems.js";
import { JsonModelsStore, modelsCachePath } from "./models-store.js";
import type { CatalogHooks, WebServerOptions } from "../web/server.js";

export interface LlmApiDeps {
	dataDir: string;
	/** Fully merged config (env > file) — what the agent would actually use. */
	cfg: Config;
	/** Raw env-derived llm settings, to report whether env overrode the file. */
	envLlm?: LlmConfig;
}

/** The two hooks the web layer needs. */
export interface LlmApi {
	llm: NonNullable<WebServerOptions["llm"]>;
	catalog: CatalogHooks;
	/**
	 * The **resolved** facts of the current (saved) selection.
	 *
	 * Why the serve layer needs this: the next-run preview and the cost-cap
	 * gate must state the model that will *actually* run (its api, its context
	 * window, whether it has a price table) — not what the file happens to say.
	 * Same resolver as the view and the save path, so the page, the gate and
	 * the runner cannot disagree (S2).
	 */
	resolveCurrent: () => Promise<ResolvedSelection>;
}

/** Credential file path for a data dir (mirrors FileCredentialStore's default). */
export function credentialsPath(dataDir: string): string {
	return path.join(dataDir, "credentials.json");
}

/** Sync read of stored credential ids: the dashboard must answer GET without I/O tears. */
function storedProviderIds(file: string): Set<string> {
	try {
		if (!existsSync(file)) return new Set();
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		return new Set(Object.keys(raw ?? {}));
	} catch {
		return new Set();
	}
}

/** Build the /api/llm + /api/llm/catalog hooks for one runner. */
export function createLlmApi(deps: LlmApiDeps): LlmApi {
	const store = new FileCredentialStore(credentialsPath(deps.dataDir));
	/**
	 * One catalog per serve process: the overlay (models the provider reported
	 * live) must survive page reloads, and it is persisted to dataDir so the
	 * agent process can restore it too.
	 */
	const liveCatalog = createLiveCatalog({
		credentials: store,
		modelsStore: new JsonModelsStore(modelsCachePath(deps.dataDir)),
	});
	const credFile = credentialsPath(deps.dataDir);
	/**
	 * One resolver for the view AND the save path (S2): both must derive the
	 * same facts from the same catalog, or the page would validate against one
	 * answer and the runner would use another.
	 */
	const resolver = createSelectionResolver(
		{ credentials: store, modelsStore: new JsonModelsStore(modelsCachePath(deps.dataDir)) },
		liveCatalog,
	);

	/** Never returns the key itself — status only (contract §3.1). */
	function statusFor(
		llm: LlmConfig,
		facts: { providerId: string; model: string; api: string; baseUrl: string },
	): {
		configured: boolean;
		hasStoredKey: boolean;
		envKeys: string[];
		source: "stored" | "env" | "none";
		/**
		 * What the run will actually use — the **resolved** facts, not what the
		 * file happens to say (the file can name a model whose real api differs).
		 */
		effective: { providerId: string; model: string; api: string; baseUrl: string };
		appliedFrom: "env" | "file" | "none";
	} {
		const source = resolveLlmSource(llm);
		const stored = source === "catalog" ? storedProviderIds(credFile).has(llm.providerId) : Boolean(llm.apiKey);
		const envKeys =
			source === "catalog"
				? expectedEnvKeys(llm.providerId).filter((k) => Boolean(process.env[k]?.trim()))
				: [];
		const credSource: "stored" | "env" | "none" = stored ? "stored" : envKeys.length ? "env" : "none";

		// 来源以 `applyLlmSettingsFile` 写入的 `llmAppliedFrom` 为准（唯一知道真相的地方）。
		// `envLlm` 仅作回退：给**未合并过的** cfg 用（例如直接 `loadConfig(env)` 的测试），
		// 因为一旦合并过，`envLlm` 里已经掺了文件值，“env 是否覆盖了文件”就再也分不出来。
		const envOverrode =
			deps.cfg.llmAppliedFrom !== undefined
				? deps.cfg.llmAppliedFrom === "env"
				: Boolean(
						deps.envLlm &&
							(deps.envLlm.baseUrl || deps.envLlm.model || deps.envLlm.providerId || deps.envLlm.apiKey),
					);
		const fileExists = existsSync(settingsPath(deps.dataDir));

		return {
			configured: isLlmConfigured(llm) && (source === "custom" ? true : credSource !== "none"),
			hasStoredKey: stored,
			envKeys,
			source: credSource,
			effective: {
				providerId: facts.providerId,
				model: facts.model,
				api: facts.api,
				baseUrl: facts.baseUrl,
			},
			appliedFrom: envOverrode ? "env" : fileExists ? "file" : "none",
		};
	}

	/**
	 * Resolve the current (merged) selection.
	 *
	 * `applyLlmSettingsFile` re-reads the file every call, so this reflects a
	 * save that happened a moment ago — the same merge the runner will do.
	 */
	async function resolveCurrent(): Promise<ResolvedSelection> {
		return resolver.resolve(applyLlmSettingsFile(deps.cfg).llm);
	}

	/**
	 * The view of the current selection.
	 *
	 * It reports the **resolved** facts (the model's own api/context/limits),
	 * not the numbers the config file happens to carry: the file may name a
	 * model whose real api is different (a live-only model), and a view that
	 * disagrees with the runner is a view that lies (CoDesign §3 B2).
	 */
	async function currentView(): Promise<unknown> {
		const resolved = await resolveCurrent();
		const llm = applyLlmSettingsFile(deps.cfg).llm;
		const status = statusFor(llm, resolved.facts);
		return {
			selection: {
				source: resolved.intent.source,
				providerId: resolved.facts.providerId,
				model: resolved.facts.model,
				api: resolved.facts.api,
				// The **configured** base URL ("" for catalog providers, which
				// resolve their own endpoint). The provider's real endpoint is a
				// different fact and belongs to the next-run preview, not here.
				baseUrl: resolved.intent.baseUrl ?? "",
				contextWindow: resolved.facts.contextWindow,
				maxTokens: resolved.facts.maxTokens,
			},
			status,
			/**
			 * Whether a run can start **right now**: the selection is coherent AND
			 * a credential is available. The two are separate facts (a valid
			 * selection without a key cannot run; a key without a valid
			 * selection cannot run either), so the page must not conflate them.
			 */
			usable: resolved.valid && status.configured,
			problems: resolved.problems,
		};
	}

	async function save(body: unknown): Promise<unknown> {
		const b = (body ?? {}) as Record<string, unknown>;
		const cur = applyLlmSettingsFile(deps.cfg).llm;
		const source: "catalog" | "custom" =
			b.source === "catalog" || b.source === "custom" ? b.source : resolveLlmSource(cur);
		const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v.trim() : fallback);

		const providerId = str(b.providerId, cur.providerId);
		const model = str(b.model, cur.model);
		const baseUrl = source === "custom" ? str(b.baseUrl, cur.baseUrl) : "";
		let api: string;
		let contextWindow: number;
		let maxTokens: number;
		if (source === "catalog") {
			// A3 + A4: the **resolver** decides what this selection really is.
			// The model object supplies api/ctx/maxTokens (the old code copied
			// `cur.api`, pinning openai-completions onto an anthropic model), and
			// an unknown model is refused HERE rather than 200-ing a file that
			// only fails later at the gate (so "saved" now means "runnable").
			const resolved = await resolver.resolve({
				...cur,
				source: "catalog",
				providerId,
				model,
			});
			if (!resolved.valid) {
				throw new ProblemError(resolved.problems);
			}
			api = resolved.facts.api;
			contextWindow = resolved.facts.contextWindow;
			maxTokens = resolved.facts.maxTokens;
		} else {
			const apiCandidate = str(b.api, cur.api);
			api = CUSTOM_LLM_APIS.includes(apiCandidate as (typeof CUSTOM_LLM_APIS)[number])
				? apiCandidate
				: cur.api;
			contextWindow = typeof b.contextWindow === "number" ? b.contextWindow : cur.contextWindow;
			maxTokens = typeof b.maxTokens === "number" ? b.maxTokens : cur.maxTokens;
		}

		// Key semantics (contract §3.1): absent/blank keeps, explicit null clears.
		const cleared = b.apiKey === null;
		const provided = typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : "";

		if (source === "catalog") {
			// Catalog keys live in the credential store (that is where pi-ai reads
			// them). Use the synchronous path so the returned view is not stale.
			if (cleared) store.remove(providerId);
			else if (provided) store.set(providerId, { type: "api_key", key: provided });
			// A catalog selection must never keep a stale custom endpoint/key.
			saveLlmSettingsFile(deps.dataDir, {
				...cur,
				source,
				providerId,
				model,
				api,
				baseUrl: "",
				apiKey: "",
				contextWindow,
				maxTokens,
			});
		} else {
			const apiKey = cleared ? "" : provided || cur.apiKey;
			saveLlmSettingsFile(deps.dataDir, {
				...cur,
				source,
				providerId,
				model,
				api,
				baseUrl,
				apiKey,
				contextWindow,
				maxTokens,
			});
		}
		return currentView();
	}

	return {
		llm: { get: currentView, save },
		resolveCurrent,
		catalog: {
			generatedAt: () => catalogGeneratedAt(),
			providers: () => listCatalogProvidersWithStatus(deps.dataDir),
			// Sync view: bundled snapshot + whatever a previous refresh persisted.
			models: (providerId: string) => {
				if (!isCatalogProvider(providerId)) return null;
				void liveCatalog.refresh(providerId, { allowNetwork: false }).catch(() => undefined);
				return liveCatalog.models(providerId);
			},
			// Explicit refresh (the Providers page button): asks the provider, persists.
			refreshModels: (providerId: string, opts) => liveCatalog.refresh(providerId, opts),
			deleteCredential: (providerId: string) => {
				store.remove(providerId);
			},
		},
	};
}

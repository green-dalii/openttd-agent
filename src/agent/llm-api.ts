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
	listCatalogModels,
	listCatalogProvidersWithStatus,
} from "./provider-catalog.js";
import { FileCredentialStore } from "./file-credential-store.js";
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
	const credFile = credentialsPath(deps.dataDir);

	/** Never returns the key itself — status only (contract §3.1). */
	function statusFor(llm: LlmConfig): {
		configured: boolean;
		hasStoredKey: boolean;
		envKeys: string[];
		source: "stored" | "env" | "none";
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

		const envOverrode = Boolean(
			deps.envLlm &&
				(deps.envLlm.baseUrl || deps.envLlm.model || deps.envLlm.providerId || deps.envLlm.apiKey),
		);
		const fileExists = existsSync(settingsPath(deps.dataDir));

		return {
			configured: isLlmConfigured(llm) && (source === "custom" ? true : credSource !== "none"),
			hasStoredKey: stored,
			envKeys,
			source: credSource,
			effective: { providerId: llm.providerId, model: llm.model, api: llm.api, baseUrl: llm.baseUrl },
			appliedFrom: envOverrode ? "env" : fileExists ? "file" : "none",
		};
	}

	function currentView(): unknown {
		const llm = applyLlmSettingsFile(deps.cfg).llm;
		return {
			selection: {
				source: resolveLlmSource(llm),
				providerId: llm.providerId,
				model: llm.model,
				api: llm.api,
				baseUrl: llm.baseUrl,
				contextWindow: llm.contextWindow,
				maxTokens: llm.maxTokens,
			},
			status: statusFor(llm),
		};
	}

	function save(body: unknown): unknown {
		const b = (body ?? {}) as Record<string, unknown>;
		const cur = applyLlmSettingsFile(deps.cfg).llm;
		const source: "catalog" | "custom" =
			b.source === "catalog" || b.source === "custom" ? b.source : resolveLlmSource(cur);
		const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v.trim() : fallback);

		const providerId = str(b.providerId, cur.providerId);
		const model = str(b.model, cur.model);
		const apiCandidate = str(b.api, cur.api);
		const api =
			source === "custom" && CUSTOM_LLM_APIS.includes(apiCandidate as (typeof CUSTOM_LLM_APIS)[number])
				? apiCandidate
				: cur.api;
		const baseUrl = source === "custom" ? str(b.baseUrl, cur.baseUrl) : "";
		const contextWindow = typeof b.contextWindow === "number" ? b.contextWindow : cur.contextWindow;
		const maxTokens = typeof b.maxTokens === "number" ? b.maxTokens : cur.maxTokens;

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
		catalog: {
			generatedAt: () => catalogGeneratedAt(),
			providers: () => listCatalogProvidersWithStatus(deps.dataDir),
			models: (providerId: string) => (isCatalogProvider(providerId) ? listCatalogModels(providerId) : null),
			deleteCredential: (providerId: string) => {
				store.remove(providerId);
			},
		},
	};
}

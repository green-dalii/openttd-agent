/**
 * Provider catalog — expose pi-ai's built-in provider/model directory to the UI.
 *
 * 职责: 把 `@earendil-works/pi-ai/providers/all` 的**内置 provider 目录**（39 个
 *   provider / ~1900 模型）与认证状态整理成 dashboard 可直接渲染的形状，让用户
 *   **选** provider 而不是手填 baseUrl/model/api。
 * 事实来源: 运行验证过的 pi-ai 0.85.1 行为（见 docs/DASHBOARD-API.md 顶部）:
 *   - `getBuiltinProviders()` 静态目录 id；`builtinModels()` 注册 runtime provider；
 *   - `findEnvKeys` 只在 `@earendil-works/pi-ai/compat` 导出（顶层 index 无）；
 *   - `Models.checkAuth(id)` → `{source,type}`，source 为 "stored credential" 或
 *     环境变量名；未配置为 undefined。
 * 禁止: 在此模块发起网络请求（只读目录）；不缓存认证状态到跨进程文件。
 */

import { builtinModels, getBuiltinModelDataGeneratedAt, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { existsSync as fsExistsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { CatalogModel, CatalogProvider } from "./provider-types.js";

export type { CatalogModel, CatalogProvider } from "./provider-types.js";

/** The frozen source label pi-ai uses to report a store hit (contract §2.6). */
const STORED_SOURCE = "stored credential";

/**
 * Providers whose env vars are not derivable from the id by naming convention.
 * Verified against each provider module in pi-ai 0.85.1 (see §2.6 notes).
 */
const EXTRA_ENV_CANDIDATES: Record<string, string[]> = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"],
	moonshotai: ["MOONSHOT_API_KEY"],
	"moonshotai-cn": ["MOONSHOT_API_KEY"],
	huggingface: ["HF_TOKEN"],
	google: ["GEMINI_API_KEY"],
	"kimi-coding": ["KIMI_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	"azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
};

/**
 * Providers that auth WITHOUT a plain API-key env var (OAuth login, cloud IAM
 * profiles, or account-scoped configuration). Kept as an explicit list so the UI
 * can say precisely what to do instead of printing a misleading hint.
 */
const NON_ENV_AUTH: Record<string, string> = {
	"amazon-bedrock": "Uses AWS credentials/profile (no API key env var).",
	"google-vertex": "Uses Google Application Default Credentials.",
	"github-copilot": "Sign in with OAuth (subscription login).",
	"openai-codex": "Sign in with OAuth (Codex subscription).",
	"cloudflare-ai-gateway": "Needs a Cloudflare account id + API token.",
	"cloudflare-workers-ai": "Needs a Cloudflare account id + API token.",
	"opencode-go": "Subscription auth (no API key env var).",
	"qwen-token-plan-individual": "Subscription auth via the Qwen token plan.",
};

let providerCache: CatalogProvider[] | null = null;
const modelCache = new Map<string, CatalogModel[]>();
const envKeyCache = new Map<string, string[]>();

/**
 * Candidate env var names for a provider: naming convention first, then the
 * verified exceptions above (e.g. huggingface → `HF_TOKEN`).
 */
function candidateEnvNames(providerId: string): string[] {
	const upper = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	const solid = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "");
	return [...new Set([`${upper}_API_KEY`, `${solid}_API_KEY`, ...(EXTRA_ENV_CANDIDATES[providerId] ?? [])])];
}

/**
 * The env vars that can actually authenticate a provider.
 *
 * pi-ai does **not** expose the list on the provider object (it is closed over
 * inside `envApiKeyAuth`, and providers with custom `resolve()` – anthropic,
 * google – use arbitrary names). `findEnvKeys(id, env)` reports the configured
 * vars for a given env, so we probe with a **synthetic env**: no real process
 * env is touched, and only names pi-ai itself accepts are returned. This is why
 * `HUGGINGFACE_API_KEY` is correctly rejected in favour of `HF_TOKEN`.
 */
export function expectedEnvKeys(providerId: string): string[] {
	const cached = envKeyCache.get(providerId);
	if (cached) return cached;
	const confirmed = candidateEnvNames(providerId).filter((name) => {
		try {
			return Boolean(findEnvKeys(providerId as never, { [name]: "probe" } as never)?.includes(name));
		} catch {
			return false;
		}
	});
	envKeyCache.set(providerId, confirmed);
	return confirmed;
}

/**
 * Catalog providers annotated with credential status, using only sync reads
 * (the credential store file + environment). Async `checkAuth` is avoided here
 * so the REST handler can answer without tear-prone I/O.
 */
export function listCatalogProvidersWithStatus(
	dataDir: string,
	credentialIds?: ReadonlySet<string>,
): CatalogProvider[] {
	const stored = credentialIds ?? readStoredIds(path.join(dataDir, "credentials.json"));
	return listCatalogProviders().map((p) => {
		if (stored.has(p.id)) return { ...p, auth: { configured: true, source: "stored" as const } };
		const set = p.envKeys.find((k) => Boolean(process.env[k]?.trim()));
		if (set) return { ...p, auth: { configured: true, source: "env" as const, envVar: set } };
		return { ...p, auth: { configured: false, source: "none" as const } };
	});
}

/** Read credential ids from a credentials.json (sync, never throws). */
function readStoredIds(file: string): Set<string> {
	try {
		if (!fsExistsSync(file)) return new Set();
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		return new Set(Object.keys(raw ?? {}));
	} catch {
		return new Set();
	}
}

function authTypesFor(id: string): ("apiKey" | "oauth")[] {
	try {
		const prov = builtinModels({}).getProvider(id);
		const out: ("apiKey" | "oauth")[] = [];
		const auth = prov?.auth as Record<string, unknown> | undefined;
		if (auth && "apiKey" in auth) out.push("apiKey");
		if (auth && "oauth" in auth) out.push("oauth");
		return out.length ? out : ["apiKey"];
	} catch {
		return ["apiKey"];
	}
}

function toCatalogProvider(id: string): CatalogProvider {
	const models = getBuiltinModels(id as never);
	const apis = [...new Set(models.map((m) => String(m.api)))].sort();
	let baseUrl: string | undefined;
	try {
		baseUrl = builtinModels({}).getProvider(id)?.baseUrl;
	} catch {
		baseUrl = undefined;
	}
	return {
		id,
		name: id,
		baseUrl,
		modelCount: models.length,
		apis,
		authTypes: authTypesFor(id),
		envKeys: expectedEnvKeys(id),
		hint: NON_ENV_AUTH[id],
		auth: { configured: false, source: "none" as const },
	};
}

/** All built-in providers, sorted by id (memoized). */
export function listCatalogProviders(): CatalogProvider[] {
	if (providerCache) return providerCache;
	const ids = [...getBuiltinProviders()].sort();
	providerCache = ids.map(toCatalogProvider);
	return providerCache;
}

/** Models for one built-in provider (memoized per provider). */
export function listCatalogModels(providerId: string): CatalogModel[] {
	const cached = modelCache.get(providerId);
	if (cached) return cached;
	if (!isCatalogProvider(providerId)) {
		modelCache.set(providerId, []);
		return [];
	}
	const models = getBuiltinModels(providerId as never)
		.map((m) => ({
			id: String(m.id),
			name: String(m.name ?? m.id),
			api: String(m.api),
			contextWindow: Number(m.contextWindow ?? 0),
			maxTokens: Number(m.maxTokens ?? 0),
			reasoning: Boolean(m.reasoning),
			cost: { input: Number(m.cost?.input ?? 0), output: Number(m.cost?.output ?? 0) },
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	modelCache.set(providerId, models);
	return models;
}

/** One provider or undefined (no throw). */
export function getCatalogProvider(providerId: string): CatalogProvider | undefined {
	return listCatalogProviders().find((p) => p.id === providerId);
}

/** Whether an id is a built-in provider (drives catalog vs custom selection). */
export function isCatalogProvider(providerId: string): boolean {
	if (!providerId) return false;
	return getBuiltinProviders().includes(providerId as never);
}

/** Catalog generation timestamp (ms) from the generated model data. */
export function catalogGeneratedAt(): number | null {
	try {
		return getBuiltinModelDataGeneratedAt() ?? null;
	} catch {
		return null;
	}
}

/**
 * Providers annotated with live auth status. `checkAuth` returns undefined when
 * the provider cannot authenticate; `source` is either the store hit or the
 * environment variable name that supplied the key.
 */
export async function listCatalogProvidersWithAuth(
	credentials?: CredentialStore,
): Promise<CatalogProvider[]> {
	const models = builtinModels(credentials ? { credentials } : {});
	const out: CatalogProvider[] = [];
	for (const p of listCatalogProviders()) {
		let auth: CatalogProvider["auth"] = { configured: false, source: "none" };
		try {
			const check = await models.checkAuth(p.id);
			if (check) {
				const source = String(check.source ?? "");
				if (source === STORED_SOURCE) auth = { configured: true, source: "stored" };
				else if (source) auth = { configured: true, source: "env", envVar: source };
				else auth = { configured: true, source: "stored" };
			}
		} catch {
			/* unconfigured / resolution failure → report as not configured */
		}
		out.push({ ...p, auth });
	}
	return out;
}

/** Test seam: clear memoized catalogs (provider list + per-provider models). */
export function resetCatalogCache(): void {
	providerCache = null;
	modelCache.clear();
	envKeyCache.clear();
}

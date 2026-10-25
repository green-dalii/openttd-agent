/**
 * LLM settings persistence — dashboard/CLI-configured provider settings.
 *
 * 职责: 把 LLM provider 配置（baseUrl/model/key/provider/api）持久化到
 *   `<dataDir>/llm.json`，供 CLI 与 Web dashboard 读写。优先级:
 *   **环境变量 > 设置文件 > 未配置**（env 显式覆盖总是赢）。
 * 事实来源: SPEC §4（brain 装配）；config.ts LlmConfig。
 * 禁止: 记录/打印明文密钥（对外一律 redact）；写入其它目录。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { Config, LlmConfig } from "../config.js";
import { isLlmConfigured } from "../config.js";
import { isCatalogProvider } from "./provider-catalog.js";

export const LLM_SETTINGS_FILE = "llm.json";

/** Default provider id when neither env, CLI nor the settings file supplies one. */
export const DEFAULT_LLM_PROVIDER_ID = "openttd-llm";

export function settingsPath(dataDir: string): string {
	return path.join(dataDir, LLM_SETTINGS_FILE);
}

/** Read settings file; returns {} when missing/invalid (never throws). */
export function loadLlmSettingsFile(dataDir: string): Partial<LlmConfig> {
	try {
		const p = settingsPath(dataDir);
		if (!existsSync(p)) return {};
		const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
		const out: Partial<LlmConfig> = {};
		if (typeof raw.providerId === "string") out.providerId = raw.providerId;
		if (typeof raw.baseUrl === "string") out.baseUrl = raw.baseUrl;
		if (typeof raw.apiKey === "string") out.apiKey = raw.apiKey;
		if (typeof raw.model === "string") out.model = raw.model;
		if (typeof raw.api === "string") out.api = raw.api;
		if (raw.source === "catalog" || raw.source === "custom") out.source = raw.source;
		if (typeof raw.contextWindow === "number") out.contextWindow = raw.contextWindow;
		if (typeof raw.maxTokens === "number") out.maxTokens = raw.maxTokens;
		return out;
	} catch {
		return {};
	}
}

/** Persist settings (creates dataDir if needed). */
export function saveLlmSettingsFile(dataDir: string, s: LlmConfig): void {
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(settingsPath(dataDir), JSON.stringify(s, null, 2), "utf8");
}

/**
 * Merge settings file into a config's llm section. Env-provided values win;
 * the file fills anything env left blank.
 *
 * providerId deliberately has **no fallback here**: the default is applied at
 * use time (buildProvider) so a merge never bakes a non-empty value that would
 * then shadow the file on a later re-merge (dashboard GET after Save).
 *
 * 同时记录 `llmAppliedFrom`：**只有这里知道**每一格来自 env 还是文件。
 * 它刻意是	extbf{粘性}的——传入的 cfg 若已经合并过（llm-api 每次 GET 都会再合一次），
 * 那时已经分不出 env 与文件，重算只会把“文件”又报成“env”（2026-09-22 的真 bug）。
 */
export function applyLlmSettingsFile(cfg: Config): Config {
	const file = loadLlmSettingsFile(cfg.dataDir);
	/**
	 * 哪些格子是 env/CLI **明确提供**的。
	 *
	 * `cfg.llmProvided` 是权威（Config 造出来的那一刻记下的）；手工构造的 Config
	 * 没有它时，退回"非空即提供"——只对**没有默认值**的字段成立。`api` /
	 * `contextWindow` / `maxTokens` 在 env 缺省时会被填成默认值，若按"非空即提供"
	 * 处理，默认值就会永久遮住文件里的保存结果（这正是 A1/B2）。
	 */
	const pinned: Partial<LlmConfig> =
		cfg.llmProvided ?? {
			...(cfg.llm.providerId ? { providerId: cfg.llm.providerId } : {}),
			...(cfg.llm.baseUrl ? { baseUrl: cfg.llm.baseUrl } : {}),
			...(cfg.llm.apiKey ? { apiKey: cfg.llm.apiKey } : {}),
			...(cfg.llm.model ? { model: cfg.llm.model } : {}),
			...(cfg.llm.source ? { source: cfg.llm.source } : {}),
		};

	// 优先级：env/CLI（显式）> 设置文件（每次重读）> 默认值。
	const merged: LlmConfig = {
		providerId: pinned.providerId ?? file.providerId ?? "",
		baseUrl: pinned.baseUrl ?? file.baseUrl ?? "",
		apiKey: pinned.apiKey ?? file.apiKey ?? "",
		model: pinned.model ?? file.model ?? "",
		api: pinned.api ?? file.api ?? "openai-completions",
		source: pinned.source ?? file.source,
		contextWindow: pinned.contextWindow ?? file.contextWindow ?? 128_000,
		maxTokens: pinned.maxTokens ?? file.maxTokens ?? 4096,
		// D63 的教训：重建对象是丢字段的惯犯。`scaffold` 是 D4 的旋钮，
		// 这里少拷一次，CLI 的 --thinking/--tool-budget 就会被静默丢掉
		// （真机实测过一次：传 low/5 却仍按 off/12 跑）。
		...(cfg.llm.scaffold ? { scaffold: cfg.llm.scaffold } : {}),
		// Same trap, same fix: P4's spend caps live on llm too. Rebuilding this
		// object without copying them would turn `--llm-token-limit` into a flag
		// that is accepted and ignored (the D63 failure mode, third occurrence).
		...(cfg.llm.limits ? { limits: cfg.llm.limits } : {}),
	};
	const envProvided = Boolean(
		pinned.providerId ?? pinned.baseUrl ?? pinned.model ?? pinned.apiKey,
	);
	const fileProvided = Boolean(file.providerId || file.baseUrl || file.model || file.apiKey);
	const appliedFrom =
		cfg.llmAppliedFrom ?? (envProvided ? "env" : fileProvided ? "file" : "none");
	return { ...cfg, llm: merged, llmAppliedFrom: appliedFrom, llmProvided: pinned };
}

/** Safe-for-UI view: never returns the raw key. */
export interface LlmSettingsView {
	providerId: string;
	baseUrl: string;
	model: string;
	api: string;
	source: "catalog" | "custom";
	contextWindow: number;
	maxTokens: number;
	/** True when a key is stored (value itself is not returned). */
	hasApiKey: boolean;
	/** Whether the agent can currently make requests. */
	configured: boolean;
}

export function toSettingsView(llm: LlmConfig): LlmSettingsView {
	return {
		providerId: llm.providerId,
		baseUrl: llm.baseUrl,
		model: llm.model,
		api: llm.api,
		source: resolveLlmSource(llm),
		contextWindow: llm.contextWindow,
		maxTokens: llm.maxTokens,
		hasApiKey: llm.apiKey.length > 0,
		configured: isLlmConfigured(llm),
	};
}

/**
 * Decide catalog vs custom. Explicit `source` wins; legacy configs (no source)
 * are inferred: a blank baseUrl with a known built-in provider id is a catalog
 * selection, otherwise it is a custom endpoint.
 *
 * A completely EMPTY config resolves to "catalog": the built-in catalog is the
 * intended entry point, and answering "custom" made a fresh install open the
 * Providers page on "Custom endpoint" - a disabled Save prompting for a base URL
 * the user does not have. A real custom endpoint always carries a baseUrl.
 */
export function resolveLlmSource(llm: LlmConfig): "catalog" | "custom" {
	if (llm.source === "catalog" || llm.source === "custom") return llm.source;
	if (!llm.baseUrl) {
		if (!llm.providerId) return "catalog";
		if (isCatalogProvider(llm.providerId)) return "catalog";
	}
	return "custom";
}

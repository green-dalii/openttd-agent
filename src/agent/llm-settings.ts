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

export const LLM_SETTINGS_FILE = "llm.json";

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
		if (raw.api === "openai-completions" || raw.api === "anthropic-messages") out.api = raw.api;
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
 */
export function applyLlmSettingsFile(cfg: Config): Config {
	const file = loadLlmSettingsFile(cfg.dataDir);
	const merged: LlmConfig = {
		providerId: cfg.llm.providerId || file.providerId || "openttd-llm",
		baseUrl: cfg.llm.baseUrl || file.baseUrl || "",
		apiKey: cfg.llm.apiKey || file.apiKey || "",
		model: cfg.llm.model || file.model || "",
		api: cfg.llm.api || file.api || "openai-completions",
		contextWindow: cfg.llm.contextWindow || file.contextWindow || 128_000,
		maxTokens: cfg.llm.maxTokens || file.maxTokens || 4096,
	};
	return { ...cfg, llm: merged };
}

/** Safe-for-UI view: never returns the raw key. */
export interface LlmSettingsView {
	providerId: string;
	baseUrl: string;
	model: string;
	api: string;
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
		contextWindow: llm.contextWindow,
		maxTokens: llm.maxTokens,
		hasApiKey: llm.apiKey.length > 0,
		configured: isLlmConfigured(llm),
	};
}

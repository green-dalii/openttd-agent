/**
 * Unit tests — LLM settings persistence + provider build (no network).
 * 事实来源: SPEC §4; src/agent/llm-settings.ts, provider.ts contracts.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyLlmSettingsFile,
	loadLlmSettingsFile,
	saveLlmSettingsFile,
	settingsPath,
	toSettingsView,
} from "../../src/agent/llm-settings.js";
import { buildProvider, redactKey } from "../../src/agent/provider.js";
import type { Config, LlmConfig } from "../../src/config.js";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "llm-settings-"));
}

function baseCfg(dataDir: string, llm: Partial<LlmConfig> = {}): Config {
	return {
		openttdBinary: "/nonexistent",
		dataDir,
		adminHost: "127.0.0.1",
		adminPort: 3977,
		adminPassword: "pw",
		gamePort: 3979,
		serverName: "t",
		startYear: 1950,
		seed: 42,
		mapSizeX: 256,
		mapSizeY: 256,
		companyName: "t",
		llm: {
			providerId: "",
			baseUrl: "",
			apiKey: "",
			model: "",
			api: "openai-completions",
			contextWindow: 128000,
			maxTokens: 4096,
			...llm,
		},
	};
}

describe("llm settings file", () => {
	it("round-trips a saved config", () => {
		const dir = tmp();
		try {
			expect(loadLlmSettingsFile(dir)).toEqual({});
			const llm: LlmConfig = {
				providerId: "p1",
				baseUrl: "https://api.example.com/v1",
				apiKey: "sk-secret-123",
				model: "m1",
				api: "openai-completions",
				contextWindow: 64000,
				maxTokens: 2048,
			};
			saveLlmSettingsFile(dir, llm);
			expect(existsSync(settingsPath(dir))).toBe(true);
			expect(loadLlmSettingsFile(dir)).toEqual(llm);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns {} for a corrupt file instead of throwing", () => {
		const dir = tmp();
		try {
			saveLlmSettingsFile(dir, baseCfg(dir).llm);
			// corrupt it
			writeFileSync(settingsPath(dir), "{not json", "utf8");
			expect(loadLlmSettingsFile(dir)).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("applyLlmSettingsFile", () => {
	it("env-provided values win over the file", () => {
		const dir = tmp();
		try {
			saveLlmSettingsFile(dir, {
				providerId: "file",
				baseUrl: "https://file.example/v1",
				apiKey: "file-key",
				model: "file-model",
				api: "openai-completions",
				contextWindow: 1000,
				maxTokens: 100,
			});
			const cfg = baseCfg(dir, { baseUrl: "https://env.example/v1", model: "env-model" });
			const merged = applyLlmSettingsFile(cfg);
			expect(merged.llm.baseUrl).toBe("https://env.example/v1"); // env wins
			expect(merged.llm.model).toBe("env-model"); // env wins
			expect(merged.llm.apiKey).toBe("file-key"); // file fills the gap
			expect(merged.llm.providerId).toBe("file");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("file supplies everything when env is blank", () => {
		const dir = tmp();
		try {
			saveLlmSettingsFile(dir, {
				providerId: "dash",
				baseUrl: "http://localhost:1234/v1",
				apiKey: "k",
				model: "local-model",
				api: "openai-completions",
				contextWindow: 32000,
				maxTokens: 1024,
			});
			const merged = applyLlmSettingsFile(baseCfg(dir));
			expect(merged.llm.baseUrl).toBe("http://localhost:1234/v1");
			expect(merged.llm.model).toBe("local-model");
			expect(merged.llm.apiKey).toBe("k");
			expect(merged.llm.providerId).toBe("dash");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("toSettingsView", () => {
	it("never exposes the raw key", () => {
		const view = toSettingsView({
			providerId: "p",
			baseUrl: "https://x/v1",
			apiKey: "sk-super-secret",
			model: "m",
			api: "openai-completions",
			contextWindow: 1000,
			maxTokens: 100,
		});
		expect(view.hasApiKey).toBe(true);
		expect(view.configured).toBe(true);
		expect(JSON.stringify(view)).not.toContain("super-secret");
	});

	it("marks unconfigured when baseUrl/model missing", () => {
		const view = toSettingsView({
			providerId: "p",
			baseUrl: "",
			apiKey: "k",
			model: "",
			api: "openai-completions",
			contextWindow: 1,
			maxTokens: 1,
		});
		expect(view.configured).toBe(false);
	});
});

describe("redactKey", () => {
	it("masks short and long keys", () => {
		expect(redactKey("")).toBe("(unset)");
		expect(redactKey("abc")).toBe("****");
		expect(redactKey("sk-1234567890abcdef")).toBe("sk-1…cdef");
	});
});

describe("buildProvider", () => {
	it("throws when unconfigured", async () => {
		await expect(
			buildProvider({
				providerId: "p",
				baseUrl: "",
				apiKey: "",
				model: "",
				api: "openai-completions",
				contextWindow: 1,
				maxTokens: 1,
			}),
		).rejects.toThrow(/not configured/);
	});

	it("builds a model + streamFn for an OpenAI-compatible endpoint (no request made)", async () => {
		const built = await buildProvider({
			providerId: "test-llm",
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "k",
			model: "test-model",
			api: "openai-completions",
			contextWindow: 8000,
			maxTokens: 512,
		});
		expect(built.model.id).toBe("test-model");
		expect(built.model.provider).toBe("test-llm");
		expect(built.model.baseUrl).toBe("http://127.0.0.1:9/v1");
		expect(typeof built.streamFn).toBe("function");
	});
});

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
	resolveLlmSource,
	saveLlmSettingsFile,
	settingsPath,
	toSettingsView,
} from "../../src/agent/llm-settings.js";
import { buildProvider, redactKey } from "../../src/agent/provider.js";
import { loadConfig } from "../../src/config.js";
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

	it("keeps the file's providerId when re-applied (dashboard GET after Save)", () => {
		const dir = tmp();
		try {
			// CLI startup before any file exists: this merge must NOT bake a
			// non-empty providerId, or it would shadow the file on re-merge.
			const once = applyLlmSettingsFile(baseCfg(dir));
			// The dashboard panel then saves a provider (POST /api/llm).
			saveLlmSettingsFile(dir, {
				...once.llm,
				providerId: "dash",
				baseUrl: "http://127.0.0.1:8787/v1",
				apiKey: "k",
				model: "stub",
			});
			// The *same* process re-reads it (this is what GET /api/llm does).
			const twice = applyLlmSettingsFile(once);
			expect(twice.llm.providerId).toBe("dash");
			expect(twice.llm.baseUrl).toBe("http://127.0.0.1:8787/v1");
			expect(twice.llm.model).toBe("stub");
			// ...and repeated merges converge (idempotent).
			expect(applyLlmSettingsFile(twice).llm).toEqual(twice.llm);
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

	it("falls back to the default provider id when config omits one", async () => {
		const built = await buildProvider({
			providerId: "",
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "k",
			model: "test-model",
			api: "openai-completions",
			contextWindow: 8000,
			maxTokens: 512,
		});
		expect(built.model.provider).toBe("openttd-llm");
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

describe("resolveLlmSource: 全新安装应落在内置目录,而不是自定义端点", () => {
	// A fresh install has nothing configured, and the page mirrors this decision.
	// Returning "custom" here opened the Providers page on "Custom endpoint" with a
	// disabled Save and a prompt for a base URL the user does not have - a first
	// impression that reads like a broken page.
	it("完全未配置 -> catalog(内置目录才是默认入口)", () => {
		expect(resolveLlmSource({} as never)).toBe("catalog");
	});

	it("显式 source 优先", () => {
		expect(resolveLlmSource({ source: "custom" } as never)).toBe("custom");
		expect(resolveLlmSource({ source: "catalog" } as never)).toBe("catalog");
	});

	it("有 baseUrl -> custom(自定义端点一定带 baseUrl)", () => {
		expect(resolveLlmSource({ baseUrl: "http://127.0.0.1:9110/v1" } as never)).toBe("custom");
	});

	it("只给了内置 providerId(旧配置无 source) -> catalog", () => {
		expect(resolveLlmSource({ providerId: "deepseek" } as never)).toBe("catalog");
	});
});

/**
 * B1（Issue #33）——合并必须**每次重新读盘**。
 *
 * 旧的 `cfg.llm.x || file.x` 让"启动时合并进 cfg 的文件值"在后续合并里赢过文件，
 * 于是 Providers 页保存后 GET 一直是旧值（真机复现见 docs/SELECTION-STATE-CODESIGN.md §2）。
 * 修法是记住"哪些格子是 env/CLI 提供的"，而不是记住"合并结果"。
 */
describe("applyLlmSettingsFile: 每次重新读盘（B1）", () => {
	function write(dir: string, model: string): void {
		saveLlmSettingsFile(dir, {
			providerId: "minimax-cn",
			baseUrl: "",
			apiKey: "",
			model,
			api: "anthropic-messages",
			source: "catalog",
			contextWindow: 204_800,
			maxTokens: 131_072,
		});
	}

	it("file-derived values are re-read on every merge", () => {
		const dir = tmp();
		try {
			write(dir, "MiniMax-M2.7");
			const boot = applyLlmSettingsFile(loadConfig({ OPENTTD_DATA_DIR: dir }));
			expect(boot.llm.model).toBe("MiniMax-M2.7");
			write(dir, "MiniMax-M2.7-highspeed");
			// Same boot snapshot, new file contents: the file wins because nothing in
			// the env asked for a model.
			const again = applyLlmSettingsFile(boot);
			expect(again.llm.model).toBe("MiniMax-M2.7-highspeed");
			expect(again.llm.contextWindow).toBe(204_800);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("env-provided values still win across repeated merges", () => {
		const dir = tmp();
		try {
			write(dir, "MiniMax-M2.7");
			const boot = applyLlmSettingsFile(loadConfig({ OPENTTD_DATA_DIR: dir, LLM_MODEL: "from-env" }));
			expect(boot.llm.model).toBe("from-env");
			write(dir, "MiniMax-M2.7-highspeed");
			expect(applyLlmSettingsFile(boot).llm.model).toBe("from-env");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("config defaults do not shadow a saved contextWindow/maxTokens", () => {
		const dir = tmp();
		try {
			write(dir, "MiniMax-M2.7");
			const boot = applyLlmSettingsFile(loadConfig({ OPENTTD_DATA_DIR: dir }));
			// 128000/4096 are defaults, not env choices: they must not win over the file.
			expect(boot.llm.contextWindow).toBe(204_800);
			expect(boot.llm.maxTokens).toBe(131_072);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("LLM_CONTEXT_WINDOW still overrides the file when explicitly set", () => {
		const dir = tmp();
		try {
			write(dir, "MiniMax-M2.7");
			const boot = applyLlmSettingsFile(
				loadConfig({ OPENTTD_DATA_DIR: dir, LLM_CONTEXT_WINDOW: "64000" }),
			);
			expect(boot.llm.contextWindow).toBe(64_000);
			expect(boot.llm.maxTokens).toBe(131_072);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

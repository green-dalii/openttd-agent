/**
 * Unit tests — LLM dashboard API (selection + credential storage).
 * 事实来源: docs/DASHBOARD-API.md §3.1 (frozen contract). Pure: temp dirs, no network.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyLlmSettingsFile, saveLlmSettingsFile } from "../../src/agent/llm-settings.js";
import { createLlmApi, credentialsPath } from "../../src/agent/llm-api.js";
import { loadLlmSettingsFile, settingsPath } from "../../src/agent/llm-settings.js";
import { loadConfig } from "../../src/config.js";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "llm-api-"));
}

interface View {
	selection: {
		source: string;
		providerId: string;
		model: string;
		api: string;
		baseUrl: string;
	};
	status: {
		configured: boolean;
		hasStoredKey: boolean;
		envKeys: string[];
		source: string;
		appliedFrom: string;
	};
}

function apiFor(dir: string, env: Record<string, string> = {}) {
	const cfg = loadConfig({ OPENTTD_DATA_DIR: dir, ...env });
	return createLlmApi({ dataDir: dir, cfg, envLlm: cfg.llm });
}

describe("llm dashboard api", () => {
	it("starts unconfigured with the frozen selection/status shape", () => {
		const dir = tmp();
		try {
			const v = apiFor(dir).llm.get() as View;
			// A completely unconfigured install reports "catalog": the built-in provider
			// list is the intended entry point. It used to report "custom", which made a
			// fresh Providers page open on "Custom endpoint" with a disabled Save and a
			// prompt for a base URL the user does not have - a first run that reads as a
			// broken page. A real custom endpoint always carries a baseUrl.
			expect(v.selection.source).toBe("catalog");
			expect(v.selection.providerId).toBe("");
			expect(v.status.configured).toBe(false);
			expect(v.status.hasStoredKey).toBe(false);
			expect(v.status.appliedFrom).toBe("none");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saves a catalog selection to llm.json without storing a key there", () => {
		const dir = tmp();
		try {
			const api = apiFor(dir);
			const v = (api.llm.save({
				source: "catalog",
				providerId: "deepseek",
				model: "deepseek-chat",
			}) ?? {}) as View;

			expect(v.selection.source).toBe("catalog");
			expect(v.selection.providerId).toBe("deepseek");
			expect(v.selection.baseUrl).toBe("");

			const file = loadLlmSettingsFile(dir);
			expect(file.providerId).toBe("deepseek");
			expect(file.source).toBe("catalog");
			// Catalog keys must never be persisted into llm.json.
			expect(file.apiKey).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stores a catalog key in credentials.json and reports it immediately", () => {
		const dir = tmp();
		try {
			const api = apiFor(dir);
			api.llm.save({ source: "catalog", providerId: "deepseek", model: "deepseek-chat" });
			// Save a key, then read back in the SAME tick: this was a real bug
			// (the async credential write raced the view computation).
			const v = api.llm.save({
				source: "catalog",
				providerId: "deepseek",
				model: "deepseek-chat",
				apiKey: "sk-stored-123",
			}) as View;

			expect(v.status.hasStoredKey).toBe(true);
			expect(v.status.source).toBe("stored");
			expect(v.status.configured).toBe(true);

			const creds = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as Record<string, { key: string }>;
			expect(creds.deepseek?.key).toBe("sk-stored-123");
			// The raw key must never leak into the settings file.
			expect(readFileSync(settingsPath(dir), "utf8")).not.toContain("sk-stored-123");

			// A fresh GET (new API instance, new process in practice) agrees.
			const again = apiFor(dir).llm.get() as View;
			expect(again.status.hasStoredKey).toBe(true);
			expect(again.status.source).toBe("stored");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the stored key when saved blank, and clears it on null", () => {
		const dir = tmp();
		try {
			const api = apiFor(dir);
			api.llm.save({ source: "catalog", providerId: "openai", model: "gpt-4", apiKey: "sk-keep" });

			const blank = api.llm.save({ source: "catalog", providerId: "openai", model: "gpt-4" }) as View;
			expect(blank.status.hasStoredKey).toBe(true); // blank = keep

			const cleared = api.llm.save({
				source: "catalog",
				providerId: "openai",
				model: "gpt-4",
				apiKey: null,
			}) as View;
			expect(cleared.status.hasStoredKey).toBe(false); // null = clear
			expect(cleared.status.configured).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detects credentials coming from the environment", () => {
		const dir = tmp();
		const prev = process.env.DEEPSEEK_API_KEY;
		try {
			process.env.DEEPSEEK_API_KEY = "sk-from-env";
			const api = apiFor(dir);
			const v = api.llm.save({
				source: "catalog",
				providerId: "deepseek",
				model: "deepseek-chat",
			}) as View;
			expect(v.status.configured).toBe(true);
			expect(v.status.source).toBe("env");
			expect(v.status.envKeys).toContain("DEEPSEEK_API_KEY");
			expect(v.status.hasStoredKey).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
			else process.env.DEEPSEEK_API_KEY = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("switching catalog -> custom replaces the endpoint and keeps the API valid", () => {
		const dir = tmp();
		try {
			const api = apiFor(dir);
			api.llm.save({ source: "catalog", providerId: "openai", model: "gpt-4" });
			const v = api.llm.save({
				source: "custom",
				providerId: "local",
				model: "llama-3",
				baseUrl: "http://127.0.0.1:8080/v1",
				api: "openai-completions",
				apiKey: "sk-local",
			}) as View;
			expect(v.selection.source).toBe("custom");
			expect(v.selection.baseUrl).toBe("http://127.0.0.1:8080/v1");
			expect(v.status.configured).toBe(true);
			expect(loadLlmSettingsFile(dir).apiKey).toBe("sk-local");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores an unsupported api for custom endpoints", () => {
		const dir = tmp();
		try {
			const api = apiFor(dir);
			const v = api.llm.save({
				source: "custom",
				providerId: "x",
				model: "m",
				baseUrl: "http://127.0.0.1:9/v1",
				api: "google-generative-ai",
			}) as View;
			expect(v.selection.api).toBe("openai-completions"); // fell back, never stored garbage
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exposes the catalog with auth status and correct env var names", () => {
		const dir = tmp();
		try {
			const api = apiFor(dir);
			const providers = api.catalog.providers() as {
				id: string;
				envKeys: string[];
			}[];
			expect(providers.length).toBeGreaterThanOrEqual(30);
			const hf = providers.find((p) => p.id === "huggingface");
			expect(hf?.envKeys).toEqual(["HF_TOKEN"]);
			// Unknown provider => null (not an exception, not an empty list).
			expect(api.catalog.models("nope-not-real")).toBeNull();
			expect((api.catalog.models("openai") as unknown[]).length).toBeGreaterThan(5);
			expect(typeof api.catalog.generatedAt()).toBe("number");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deletes a stored credential via the catalog hook", () => {
		const dir = tmp();
		try {
			const api = apiFor(dir);
			api.llm.save({ source: "catalog", providerId: "openai", model: "gpt-4", apiKey: "sk-gone" });
			expect(existsSync(credentialsPath(dir))).toBe(true);
			api.catalog.deleteCredential("openai");
			const v = api.llm.get() as View;
			expect(v.status.hasStoredKey).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports appliedFrom=env when env overrides the saved file", () => {
		const dir = tmp();
		try {
			// Save a file selection first...
			apiFor(dir).llm.save({ source: "catalog", providerId: "openai", model: "gpt-4" });
			// ...then start with explicit env that wins over it.
			const cfg = loadConfig({
				OPENTTD_DATA_DIR: dir,
				LLM_PROVIDER: "deepseek",
				LLM_MODEL: "deepseek-chat",
			});
			const api = createLlmApi({ dataDir: dir, cfg, envLlm: cfg.llm });
			const v = api.llm.get() as View;
			expect(v.status.appliedFrom).toBe("env");
			expect(v.selection.providerId).toBe("deepseek");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * 回归排查（2026-09-22）：生产里 `envLlm` 传的是**合并后**的 cfg。
 *
 * `cli/run.ts` 先 `applyLlmSettingsFile(loadConfig(...))` 再交给 serve/runner，
 * 而三处调用点都写 `envLlm: cfg.llm`——于是"文件里存的值"被当成了"env 提供"，
 * `appliedFrom` 在**只有文件**的情况下会错报成 `"env"`，
 * Providers 页据此显示"env 覆盖了文件"（providers.js:123）——一句假的说明。
 *
 * 这条测试镜像生产：**没有任何 LLM_* env**，只有 llm.json。
 */
it("只有文件（无 env）时 appliedFrom 必须是 file，而不是 env", () => {
	const dir = tmp();
	try {
		saveLlmSettingsFile(dir, {
			source: "catalog",
			providerId: "openai",
			model: "gpt-4",
			api: "openai-completions",
			baseUrl: "",
			apiKey: "",
			contextWindow: 8192,
			maxTokens: 256,
		} as never);
		// 生产的顺序：先合并文件，再建 llm-api（envLlm 因此是合并结果）
		const merged = applyLlmSettingsFile(loadConfig({ OPENTTD_DATA_DIR: dir }));
		const api = createLlmApi({ dataDir: dir, cfg: merged, envLlm: merged.llm });
		const v = api.llm.get() as View;
		expect(v.selection.model).toBe("gpt-4");
		expect(v.status.appliedFrom).toBe("file");
		// 粘性：llm-api 每次 GET 都会**再合并一次**（save 后 GET 是常态）。
		// 若重算，"文件里的值"会被第二次误判成 env —— 这正是本 bug 的机制。
		const twice = applyLlmSettingsFile(merged);
		expect(twice.llmAppliedFrom).toBe("file");
		const api2 = createLlmApi({ dataDir: dir, cfg: twice, envLlm: twice.llm });
		expect((api2.llm.get() as View).status.appliedFrom).toBe("file");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

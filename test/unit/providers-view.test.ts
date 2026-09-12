/**
 * Unit tests — the Providers page view model.
 *
 * 职责: 锁定凭据面板的分支、生效配置表、保存可用性与请求体。
 *
 * 为什么值得单测: 凭据面板分支最多（env 变量 / 已存 key / 需要 OAuth / 完全没配），
 *   而它决定用户下一步该做什么；`saveBody()` 则决定**会不会把已存的 key 覆盖掉**。
 *   这两件都不能只靠肉眼。
 *
 * 禁止: 在此断言密钥明文被保存或回显（本页只处理"有没有 key"这一事实）。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/providers-view.js"), "utf8");

interface Model {
	providers: unknown[];
	models: unknown[];
	providerId: string;
	model: string;
	custom: boolean;
	modelsLoading: boolean;
	form: { baseUrl: string; api: string; model: string; key: string };
	catalogKey: string;
	providerCount(): number;
	readyProviders(): unknown[];
	readyCount(): string;
	selectionLabel(): string;
	catalogFieldsVisible(): boolean;
	customFieldsVisible(): boolean;
	authPanel(): { badge: string; badgeCls: string; hint: string; placeholder: string };
	effectiveRows(): [string, string][];
	saveReady(): boolean;
	canClearKey(): boolean;
	modelPlaceholder(): string;
	saveBody(): Record<string, unknown>;
	providerOptions(): { id: string; group: string; sub: string; search: string }[];
	modelOptions(): { id: string; search: string }[];
	setMsg(t: string, k: string): void;
}

function load(): Model {
	const sandbox: Record<string, unknown> = { console, JSON, Object, Array, Number, String, Math, Set, Map };
	sandbox.UI = {
		fmtInt: (v: unknown) => String(v),
		fmtTok: (v: unknown) => `${v}t`,
		esc: (v: unknown) => String(v),
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	return (sandbox.window as { ProvidersView: { create: () => Model } }).ProvidersView.create();
}

/** A catalog provider as the API returns it. */
function prov(over: Record<string, unknown> = {}) {
	return {
		id: "openai",
		modelCount: 20,
		apis: ["openai-responses"],
		envKeys: ["OPENAI_API_KEY"],
		auth: { configured: false, source: "none" },
		...over,
	};
}

describe("Providers view model", () => {
	describe("credentials panel", () => {
		it("asks for a provider before saying anything else", () => {
			const m = load();
			const p = m.authPanel();
			expect(p.hint).toMatch(/pick a provider/i);
			expect(p.badge).toBe("");
		});

		it("says an env var already works, and no action is needed", () => {
			// The best case for the user: nothing to paste.
			const m = load();
			m.providers = [prov({ auth: { configured: true, source: "env", envVar: "OPENAI_API_KEY" } })];
			m.providerId = "openai";
			const p = m.authPanel();
			expect(p.badgeCls).toBe("ok");
			expect(p.hint).toMatch(/already has/i);
			expect(p.placeholder).toMatch(/optional/i);
		});

		it("tells the user a stored key can be kept by leaving the field blank", () => {
			const m = load();
			m.providers = [prov({ auth: { configured: true, source: "stored" } })];
			m.providerId = "openai";
			const p = m.authPanel();
			expect(p.badgeCls).toBe("ok");
			expect(p.hint).toMatch(/leave the field blank/i);
			expect(p.placeholder).toMatch(/stored/i);
		});

		it("surfaces a provider's own OAuth/cloud hint instead of inventing one", () => {
			const m = load();
			m.providers = [prov({ id: "bedrock", hint: "Uses AWS credentials/profile.", auth: { configured: false } })];
			m.providerId = "bedrock";
			const p = m.authPanel();
			expect(p.badgeCls).toBe("warn");
			expect(p.hint).toBe("Uses AWS credentials/profile.");
		});

		it("names the env vars to export when a key is missing", () => {
			const m = load();
			m.providers = [prov({ envKeys: ["A_KEY", "B_KEY"] })];
			m.providerId = "openai";
			const p = m.authPanel();
			expect(p.badgeCls).toBe("bad");
			expect(p.hint).toContain("A_KEY");
			expect(p.hint).toContain("B_KEY");
		});

		it("falls back to a plain ask when nothing is known about the provider", () => {
			const m = load();
			m.providers = [prov({ envKeys: [], auth: {} })];
			m.providerId = "openai";
			expect(m.authPanel().hint).toMatch(/no key found/i);
		});
	});

	describe("effective configuration table", () => {
		it("describes the catalog selection", () => {
			const m = load();
			m.providers = [prov({ auth: { configured: true, source: "stored" } })];
			m.providerId = "openai";
			m.model = "gpt-x";
			m.models = [{ id: "gpt-x", api: "openai-responses", contextWindow: 200000, maxTokens: 8000 }];
			const rows = Object.fromEntries(m.effectiveRows());
			expect(rows.Mode).toMatch(/built-in/);
			expect(rows.Provider).toBe("openai");
			expect(rows.Model).toBe("gpt-x");
			expect(rows.API).toBe("openai-responses");
			expect(rows.Context).toContain("200000t");
			expect(rows.Auth).toMatch(/stored/i);
		});

		it("describes the custom endpoint selection", () => {
			const m = load();
			m.custom = true;
			m.form = { baseUrl: "http://127.0.0.1:8080/v1", api: "openai-completions", model: "llama", key: "k" };
			const rows = Object.fromEntries(m.effectiveRows());
			expect(rows.Mode).toMatch(/custom/i);
			expect(rows["Base URL"]).toBe("http://127.0.0.1:8080/v1");
			expect(rows.Auth).toMatch(/this form/);
		});

		it("never prints a key value, only where it comes from", () => {
			// The dashboard must never echo a secret.
			const m = load();
			m.custom = true;
			m.form = { baseUrl: "http://x/v1", api: "openai-completions", model: "m", key: "sk-super-secret" };
			const flat = m.effectiveRows().flat().join(" ");
			expect(flat).not.toContain("sk-super-secret");
		});
	});

	describe("save readiness", () => {
		it("needs a provider and a model in catalog mode", () => {
			const m = load();
			m.providerId = "openai";
			expect(m.saveReady()).toBe(false);
			m.model = "gpt-x";
			expect(m.saveReady()).toBe(true);
		});

		it("needs a base URL and a model for a custom endpoint", () => {
			const m = load();
			m.custom = true;
			expect(m.saveReady()).toBe(false);
			m.form.model = "llama";
			expect(m.saveReady()).toBe(false);
			m.form.baseUrl = " http://127.0.0.1:1/v1 ";
			expect(m.saveReady()).toBe(true);
		});
	});

	describe("save body", () => {
		it("omits the key when blank, so an existing credential survives", () => {
			// A blank field must mean "keep what is stored", never "erase it".
			const m = load();
			m.providerId = "openai";
			m.model = "gpt-x";
			expect(m.saveBody()).toEqual({ source: "catalog", providerId: "openai", model: "gpt-x" });
		});

		it("includes the key when the user pasted one", () => {
			const m = load();
			m.providerId = "openai";
			m.model = "gpt-x";
			m.catalogKey = "  sk-new  ";
			expect(m.saveBody().apiKey).toBe("sk-new");
		});

		it("sends an explicit empty key for a custom endpoint so it can be cleared", () => {
			const m = load();
			m.custom = true;
			m.form = { baseUrl: "http://x/v1", api: "openai-completions", model: "m", key: "" };
			expect(m.saveBody().apiKey).toBe("");
		});

		it("trims the custom fields", () => {
			const m = load();
			m.custom = true;
			m.form = { baseUrl: " http://x/v1 ", api: "openai-completions", model: " m ", key: "" };
			const b = m.saveBody();
			expect(b.baseUrl).toBe("http://x/v1");
			expect(b.model).toBe("m");
		});
	});

	describe("provider options", () => {
		it("groups by whether the user can act now, ready first", () => {
			const m = load();
			m.providers = [
				prov({ id: "bedrock", hint: "AWS", auth: { configured: false } }),
				prov({ id: "openai", auth: { configured: true, source: "env", envVar: "K" } }),
				prov({ id: "deepseek", envKeys: ["D"], auth: { configured: false } }),
			];
			const groups = m.providerOptions().map((o) => o.group);
			expect(groups[0]).toBe("Ready now");
			expect(groups).toContain("Needs cloud/OAuth credentials");
			expect(groups).toContain("Needs an API key");
		});

		it("makes env keys searchable", () => {
			const m = load();
			m.providers = [prov({ envKeys: ["OPENAI_API_KEY"] })];
			expect(m.providerOptions()[0]!.search).toContain("OPENAI_API_KEY");
		});
	});

	describe("misc", () => {
		it("counts ready providers for the header", () => {
			const m = load();
			m.providers = [prov({ auth: { configured: true } }), prov({ id: "b", auth: { configured: false } })];
			expect(m.readyCount()).toBe("1 / 2");
		});

		it("labels the current selection", () => {
			const m = load();
			expect(m.selectionLabel()).toBe("—");
			m.providerId = "openai";
			expect(m.selectionLabel()).toBe("openai");
			m.model = "gpt-x";
			expect(m.selectionLabel()).toBe("openai / gpt-x");
		});

		it("distinguishes 'loading models' from 'no models'", () => {
			const m = load();
			m.providerId = "openai";
			m.modelsLoading = true;
			expect(m.modelPlaceholder()).toMatch(/loading/i);
			m.modelsLoading = false;
			expect(m.modelPlaceholder()).toMatch(/no models/i);
		});

		it("offers to clear a stored key only for a catalog provider", () => {
			const m = load();
			expect(m.canClearKey()).toBe(false);
			m.providerId = "openai";
			expect(m.canClearKey()).toBe(true);
			m.custom = true;
			expect(m.canClearKey()).toBe(false);
		});
	});
});

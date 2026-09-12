/**
 * Unit tests — Providers 页的**保存链路**，走真实代码路径。
 *
 * 职责: 断言"点 Save 到底发出什么请求"、以及**发不出去时用户是否被告知**。
 * 事实来源: docs/DASHBOARD-API.md §3.1、docs/EVOLUTION.md（无关）。
 * 禁止: 断言模板结构；只断言"发了什么请求 + 如何反馈"。
 *
 * 本文件存在的唯一理由是一个真实事故（2026-09-12，用户报告）:
 *   在 Providers 页改了 Provider 和模型 → 点 Save **毫无反应** → 刷新后配置退回原样。
 *   实测复现: 选中 Provider 但**没选模型**时 `saveReady()` 为假，
 *   按钮 `disabled`；而 CSS 没有给 `:disabled` 任何样式，于是它
 *   `opacity:1 / cursor:pointer` —— **看起来完全可点**。
 *   点下去: 不发请求、不报错、不提示，`msg === ""`。
 *   沉默的禁用按钮与"保存坏了"在用户看来完全一样。
 *
 * 为什么以前没覆盖:后端确实被测了（`web-api.test.ts` POST /api/llm、
 *   `llm-api.test.ts` 的 save），**纯逻辑**也被测了（`saveReady()` / `saveBody()`）。
 *   缺的是两者之间那一段:**"按钮不可用时,用户看到什么"**。
 *   断言 `saveReady() === false` 是断言一个谓词,不是断言一次体验。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

/** Only the surface these tests drive; avoids `any` while staying honest about it. */
interface TestComponent {
	custom: boolean;
	providerId: string;
	model: string;
	form: { baseUrl: string; api: string; model: string; key: string };
	catalogKey: string;
	saving: boolean;
	msg: { text: string; kind: string };
	saveReady(): boolean;
	saveHint(): string;
	saveBody(): Record<string, unknown>;
	setMode(mode: string): void;
	save(): Promise<void>;
	[key: string]: unknown;
}

interface FetchCall {
	url: string;
	method: string;
	body?: string;
}
interface ToastCall {
	msg: string;
	kind?: string;
}

/**
 * Load the real Alpine component from providers.js.
 *
 * `@click` is Alpine's job, so the factory registered via `Alpine.data()` is
 * captured and driven directly — the same code the browser runs.
 */
function load(opts: { status?: number; error?: string; fetchThrows?: boolean } = {}) {
	const fetchLog: FetchCall[] = [];
	const toasts: ToastCall[] = [];
	let registered: (() => Record<string, unknown>) | null = null;

	const sandbox: Record<string, unknown> = {
		document: {
			getElementById: () => null,
			addEventListener: (name: string, fn: () => void) => {
				if (name === "alpine:init") fn();
			},
			querySelector: () => null,
			querySelectorAll: () => [],
			createElement: () => ({ style: {}, classList: { add: () => {} }, appendChild: () => {} }),
			body: { appendChild: () => {} },
			documentElement: {},
		},
		fetch: (url: string, init?: { method?: string; body?: unknown }) => {
			fetchLog.push({
				url: String(url),
				method: String(init?.method ?? "GET").toUpperCase(),
				...(init?.body === undefined ? {} : { body: String(init.body) }),
			});
			if (opts.fetchThrows) return Promise.reject(new Error("connection refused"));
			const status = opts.status ?? 200;
			return Promise.resolve({
				ok: status < 400,
				status,
				json: () =>
					Promise.resolve(
						opts.error
							? { error: opts.error }
							: { selection: { source: "catalog", providerId: "deepseek", model: "m" } },
					),
			});
		},
		console,
		JSON,
		Object,
		Array,
		Number,
		String,
		Math,
		Date,
		Set,
		Map,
		Intl,
		Promise,
		Error,
		setTimeout: (fn: () => void) => {
			fn();
			return 0;
		},
		UI: {
			$: () => null,
			esc: (v: unknown) => String(v),
			toast: (msg: string, kind?: string) =>
				toasts.push({ msg: String(msg), ...(kind ? { kind } : {}) }),
			renderNavInto: () => {},
			segmented: () => {},
			combobox: () => null,
			confirmDialog: () => Promise.resolve(true),
			getPref: (_k: string, d: unknown) => d,
			setPref: () => {},
			fmtInt: (v: unknown) => String(v),
			fmtMoney: (v: unknown) => `£${v}`,
		},
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	sandbox.Alpine = {
		data: (_name: string, factory: () => Record<string, unknown>) => {
			registered = factory;
		},
	};
	vm.createContext(sandbox);
	const src = readFileSync(join(PUBLIC_DIR, "assets/js/providers.js"), "utf8");
	const viewSrc = readFileSync(join(PUBLIC_DIR, "assets/js/providers-view.js"), "utf8");
	vm.runInContext(viewSrc, sandbox);
	vm.runInContext(src, sandbox);
	if (!registered) throw new Error("providers component did not register via Alpine.data");
	const make = registered as unknown as () => Record<string, unknown>;
	const component = make() as TestComponent;
	return { component, fetchLog, toasts };
}



describe("providers save: 禁用时必须说明原因（用户报告的事故）", () => {
	it("saveReady() 为假时,saveHint() 必须给出原因——绝不能是沉默的", () => {
		// The regression: the button was disabled, looked enabled, and said nothing.
		// A user cannot distinguish that from a broken save.
		const cases: Array<(c: TestComponent) => void> = [
			(c) => {
				c.custom = false;
				c.providerId = "";
				c.model = "";
			},
			(c) => {
				c.custom = false;
				c.providerId = "google";
				c.model = "";
			},
			(c) => {
				c.custom = true;
				c.form.baseUrl = "";
				c.form.model = "m";
			},
			(c) => {
				c.custom = true;
				c.form.baseUrl = "http://x/v1";
				c.form.model = "";
			},
		];
		for (const setup of cases) {
			const { component } = load();
			setup(component);
			expect(component.saveReady()).toBe(false);
			expect(
				String(component.saveHint()).length,
				"disabled save with no explanation is indistinguishable from a bug",
			).toBeGreaterThan(0);
			expect(component.saveHint()).not.toBe("");
		}
	});

	it("可用时不显示提示(不干扰正常流程)", () => {
		const { component } = load();
		component.custom = false;
		component.providerId = "deepseek";
		component.model = "deepseek-chat";
		expect(component.saveReady()).toBe(true);
		expect(component.saveHint()).toBe("");
	});

	it("选好 Provider 但没选模型时,提示明确指向模型（这正是用户踩到的状态）", () => {
		const { component } = load();
		component.custom = false;
		component.providerId = "google";
		component.model = "";
		expect(component.saveHint()).toMatch(/model/i);
	});

	it("自定义模式下分别指出 baseUrl 与 model 缺哪个", () => {
		const { component } = load();
		component.custom = true;
		component.form.baseUrl = "";
		component.form.model = "m";
		expect(component.saveHint()).toMatch(/url/i);
		component.form.baseUrl = "http://x/v1";
		component.form.model = "";
		expect(component.saveHint()).toMatch(/model/i);
	});
});

describe("providers save: 请求链路", () => {
	it("点 Save 会以 POST 把 saveBody() 发到 /api/llm", async () => {
		const { component, fetchLog } = load();
		component.custom = false;
		component.providerId = "deepseek";
		component.model = "deepseek-chat";
		await component.save();
		const post = fetchLog.find((c) => c.method === "POST");
		expect(post, "save() must actually send a request").toBeTruthy();
		expect(post!.url).toContain("/api/llm");
		expect(JSON.parse(post!.body!)).toMatchObject({
			source: "catalog",
			providerId: "deepseek",
			model: "deepseek-chat",
		});
	});

	it("成功后给出明确反馈(用户必须知道它成功了)", async () => {
		const { component, toasts } = load();
		component.custom = false;
		component.providerId = "deepseek";
		component.model = "deepseek-chat";
		await component.save();
		expect(String(component.msg && component.msg.text ? component.msg.text : component.msg)).toMatch(
			/saved/i,
		);
		expect(toasts.some((t) => /saved/i.test(t.msg))).toBe(true);
	});

	it("成功后不在页面上保留密钥", async () => {
		const { component } = load();
		component.custom = false;
		component.providerId = "deepseek";
		component.model = "deepseek-chat";
		component.catalogKey = "sk-secret";
		await component.save();
		expect(component.catalogKey).toBe("");
		expect(component.form.key).toBe("");
	});

	it("服务端拒绝时给出错误反馈,而不是静默", async () => {
		const { component, toasts } = load({ status: 400, error: "providerId is required" });
		component.custom = false;
		component.providerId = "deepseek";
		component.model = "m";
		await component.save();
		expect(toasts.some((t) => /failed/i.test(t.msg))).toBe(true);
	});

	it("网络异常时给出错误反馈,而不是静默", async () => {
		const { component, toasts } = load({ fetchThrows: true });
		component.custom = false;
		component.providerId = "deepseek";
		component.model = "m";
		await component.save();
		expect(toasts.some((t) => /failed/i.test(t.msg))).toBe(true);
	});

	it("保存中会置位 saving,结束后复位(按钮不会永久卡在 'Saving…')", async () => {
		const { component } = load();
		component.custom = false;
		component.providerId = "deepseek";
		component.model = "m";
		await component.save();
		expect(component.saving).toBe(false);
	});
});

describe("providers save: 自定义模式不得继承目录 Provider 的 id", () => {
	it("切到自定义后 providerId 不再是被选中的目录 Provider", async () => {
		// Real defect found while investigating: switching to Custom kept
		// providerId="deepseek" and wrote {"source":"custom","providerId":"deepseek"}
		// to llm.json - a hybrid record that mis-attributes the credential.
		const { component, fetchLog } = load();
		component.custom = false;
		component.providerId = "deepseek";
		component.model = "deepseek-chat";
		component.setMode("custom");
		component.form.baseUrl = "http://127.0.0.1:9110/v1";
		component.form.model = "my-model";
		await component.save();
		const post = fetchLog.find((c) => c.method === "POST");
		const body = JSON.parse(post!.body!);
		expect(body.source).toBe("custom");
		expect(body.providerId).not.toBe("deepseek");
	});

	it("切回目录模式时恢复之前选中的 Provider", () => {
		const { component } = load();
		component.custom = false;
		component.providerId = "deepseek";
		component.setMode("custom");
		component.setMode("catalog");
		expect(component.providerId).toBe("deepseek");
	});

});

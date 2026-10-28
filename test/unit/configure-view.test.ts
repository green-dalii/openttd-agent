/**
 * Unit tests — the Configure page's run knobs and the next-run preview.
 *
 * 职责: 锁定"表单怎么变成请求体"、"预览表显示什么"、"非法旋钮时用户看到什么"。
 *
 * 为什么值得单测（三条都踩过坑）:
 *   1. **前端不归一化**: 表单里的值必须**原样**发出。页面自己把 "12abc" 变成
 *      12 或者把空串变成 0，页面和服务器就会对"这一局用了什么"各说各话。
 *   2. **空字段 = 不用改**: 空串必须**省略**（而不是发 0），否则"页面没碰的旋钮"
 *      也会改变行为。
 *   3. **预览只画服务端给的**: 页面不重算 manifest——预览与跑出来的 manifest
 *      必须逐字段相同（见 run-preview.test.ts）。
 *
 * 禁止: 在此断言 manifest 的内容（那是服务端的事）。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/configure-view.js"), "utf8");

interface KnobField {
	key: string;
	label: string;
	hint?: string;
	options?: string[];
}

interface Model {
	knobs: Record<string, string>;
	preview: Record<string, unknown> | null;
	problems: { code: string; message: string; hint: string }[];
	previewError: string;
	previewing: boolean;
	runBusy: boolean;
	runMsg: { text: string; kind: string };
	previewSeq: number;
	previewTimer: unknown;
	previewDebounceMs: number;
	knobFields(): KnobField[];
	knobBody(): { knobs: Record<string, string> };
	previewRows(): [string, string][];
	previewStatus(): { kind: string; text: string };
	problemHints(): { code: string; message: string; hint: string }[];
	refreshPreview(): Promise<void>;
	schedulePreview(): void;
	startRun(): Promise<void>;
}

interface FetchCall {
	url: string;
	method: string;
	body?: string;
}

function load(opts: {
	status?: number;
	body?: unknown;
	fetchThrows?: boolean;
	fetchImpl?: (url: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
} = {}): {
	model: Model;
	calls: FetchCall[];
	toasts: { msg: string; kind?: string }[];
} {
	const calls: FetchCall[] = [];
	const toasts: { msg: string; kind?: string }[] = [];
	const sandbox: Record<string, unknown> = {
		console,
		JSON,
		Object,
		Array,
		Number,
		String,
		Math,
		Intl,
		Promise,
		Error,
		setTimeout,
		clearTimeout,
		fetch: (url: string, init?: { method?: string; body?: unknown }) => {
			calls.push({
				url: String(url),
				method: String(init?.method ?? "GET").toUpperCase(),
				...(init?.body === undefined ? {} : { body: String(init.body) }),
			});
			if (opts.fetchImpl) return opts.fetchImpl(url, init) as Promise<never>;
			if (opts.fetchThrows) return Promise.reject(new Error("connection refused"));
			const status = opts.status ?? 200;
			return Promise.resolve({
				ok: status < 400,
				status,
				json: () => Promise.resolve(opts.body ?? { preview: null, problems: [] }),
			});
		},
	};
	sandbox.UI = {
		fmtInt: (v: unknown) => String(v),
		fmtTok: (v: unknown) => `${v}t`,
		esc: (v: unknown) => String(v),
		toast: (msg: string, kind?: string) => toasts.push({ msg: String(msg), ...(kind ? { kind } : {}) }),
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	const model = (sandbox.window as { ConfigureView: { create: () => Model } }).ConfigureView.create();
	return { model, calls, toasts };
}

describe("ConfigureView: the knob form", () => {
	it("offers the knobs the server understands (the names are the server's)", () => {
		const { model } = load();
		const keys = model.knobFields().map((f) => f.key);
		expect(keys).toEqual([
			"seed",
			"gameDays",
			"scenario",
			"memoryArm",
			"thinkingLevel",
			"toolBudget",
			"tokenLimit",
			"costLimit",
			"backend",
		]);
	});

	it("sends the values as typed (the page does not normalize them)", () => {
		const { model } = load();
		model.knobs.seed = "12abc";
		model.knobs.toolBudget = "5";
		expect(model.knobBody().knobs).toMatchObject({ seed: "12abc", toolBudget: "5" });
	});

	it("omits an empty field (an untouched knob keeps the server's setting)", () => {
		const { model } = load();
		model.knobs.seed = "";
		model.knobs.toolBudget = "";
		model.knobs.thinkingLevel = "high";
		const body = model.knobBody();
		expect(body.knobs.seed).toBeUndefined();
		expect(body.knobs.toolBudget).toBeUndefined();
		expect(body.knobs.thinkingLevel).toBe("high");
	});
});

describe("ConfigureView: the next-run preview", () => {
	it("shows what the server resolved (the page does not compute it)", () => {
		const { model } = load();
		model.preview = {
			providerId: "minimax-cn",
			model: "MiniMax-M3.1-Flash",
			api: "anthropic-messages",
			contextWindow: 204800,
			maxTokens: 131072,
			costKnown: false,
			seed: 4242,
			gameDays: 180,
			scenario: "prebuilt",
			memoryArm: "control",
			thinkingLevel: "high",
			toolBudget: 5,
			tokenLimit: 120000,
			costLimit: null,
			backend: "agent",
			scaffoldHash: "7956ab6d8c86fa60",
		};
		const rows = Object.fromEntries(model.previewRows());
		expect(rows["Model"]).toBe("minimax-cn / MiniMax-M3.1-Flash");
		expect(rows["API"]).toBe("anthropic-messages");
		// An unpriced model must read as "unknown", not "$0.00" (D77/MEMORY D60).
		expect(rows["Price"]).toContain("unknown");
		expect(rows["Token cap"]).toBe("120000");
		expect(rows["Cost cap"]).toBe("no cap");
		expect(rows["Scaffold"]).toBe("7956ab6d");
	});

	it("says what is wrong when the server refuses (an empty panel reads as broken)", () => {
		const { model } = load();
		model.problems = [
			{ code: "invalid_knob", message: "thinkingLevel must be one of …", hint: "pick one of: off, high" },
		];
		const status = model.previewStatus();
		expect(status.kind).toBe("err");
		expect(status.text).toContain("thinkingLevel");
		expect(model.problemHints()[0]!.hint).toContain("pick one of");
	});

	it("asks the server for the preview and keeps the answer as-is", async () => {
		const { model, calls } = load({
			body: {
				preview: { providerId: "p", model: "m", api: "a", contextWindow: 1, maxTokens: 2, costKnown: true },
				problems: [],
			},
		});
		model.knobs.seed = "7";
		await model.refreshPreview();
		expect(calls[0]!.url).toBe("/api/run/preview");
		expect(calls[0]!.method).toBe("POST");
		expect(JSON.parse(calls[0]!.body!).knobs).toEqual({ seed: "7" });
		expect(model.preview!.model).toBe("m");
	});

	it("surfaces the server's problems instead of an empty panel", async () => {
		const { model } = load({
			status: 400,
			body: {
				error: "invalid knob",
				problems: [{ code: "invalid_knob", message: "seed must be a whole number", hint: "use a whole number" }],
			},
		});
		await model.refreshPreview();
		expect(model.preview).toBeNull();
		expect(model.problems[0]!.code).toBe("invalid_knob");
		expect(model.previewStatus().kind).toBe("err");
	});

	it("asks again after the knobs change (a preview that lags behind lies)", async () => {
		const { model, calls } = load({ body: { preview: { model: "m" }, problems: [] } });
		await model.refreshPreview();
		expect(calls.length).toBe(1);
		model.knobs.toolBudget = "7";
		model.schedulePreview();
		// Debounced: typing is many events, each must not become a request.
		expect(calls.length).toBe(1);
		await new Promise((r) => setTimeout(r, model.previewDebounceMs + 80));
		expect(calls.length).toBe(2);
		expect(JSON.parse(calls[1]!.body!).knobs).toEqual({ toolBudget: "7" });
	});

	it("drops a slow, older answer so it cannot overwrite a newer one", async () => {
		// Two overlapping requests: the FIRST resolves LAST. If it were applied,
		// the panel would describe a run the user is no longer about to make.
		const gates: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
		const { model } = load({
			fetchImpl: () =>
				new Promise((resolve, reject) => {
					gates.push({ resolve, reject });
				}),
		});
		const first = model.refreshPreview();
		const second = model.refreshPreview();
		await Promise.resolve();
		expect(model.previewSeq).toBe(2);
		// The newer request answers first...
		gates[1]!.resolve({ ok: true, status: 200, json: async () => ({ preview: { model: "new" }, problems: [] }) });
		await second;
		expect(model.preview!.model).toBe("new");
		// ...and the older one answers afterwards: it must be dropped.
		gates[0]!.resolve({ ok: true, status: 200, json: async () => ({ preview: { model: "old" }, problems: [] }) });
		await first;
		expect(model.preview!.model, "旧请求覆盖了新回答").toBe("new");
	});
});

describe("ConfigureView: starting a run with the knobs", () => {
	it("sends the same knobs it previews", async () => {
		const { model, calls } = load({ body: { preview: null, problems: [] } });
		model.knobs.seed = "42";
		model.knobs.thinkingLevel = "high";
		await model.startRun();
		const start = calls.find((c) => c.url === "/api/run/start");
		expect(start).toBeDefined();
		const body = JSON.parse(start!.body!) as { mode: string; knobs: Record<string, string> };
		expect(body.mode).toBe("agent");
		expect(body.knobs).toEqual({ seed: "42", thinkingLevel: "high" });
	});

	it("shows the server's refusal when the start is rejected", async () => {
		const { model, toasts } = load({
			status: 400,
			body: {
				error: "invalid knob",
				problems: [{ code: "invalid_knob", message: "seed must be a whole number", hint: "use a whole number" }],
			},
		});
		await model.startRun();
		expect(model.runMsg.kind).toBe("err");
		expect(model.runMsg.text).toContain("seed must be a whole number");
		expect(toasts.some((t) => t.kind === "err")).toBe(true);
	});
});

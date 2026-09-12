/**
 * Unit tests — Live page run controls, through the real code path.
 *
 * 职责: 断言"点 Start agent 到底发出了什么请求"，以及一次都没发出时如何反馈。
 *
 * 这个文件存在的唯一理由是一个真实事故（2026-09-11）:
 *   `pnpm run cli --serve` 下点 "start agent" 报
 *   `Request failed: ReferenceError: Cannot access 'body' before initialization`，
 *   浏览器控制台**干净**。原因: post() 里 `const body = await r.json()` 遮蔽了
 *   同名参数 `body`，`JSON.stringify(body)` 在 fetch 之前就落进 TDZ ——
 *   **一个字节都没发出去**，异常又被 catch 成 toast。
 *
 * 迁移到 Alpine 后（阶段 4）事件绑定改为 `@click`，DOM 上没有 `.onclick` 属性，
 * 因此这里改为**直接驱动组件方法**（`startRun` / `pauseResume` / `stopRun`）。
 * 这仍然覆盖那次事故的路径（请求构造 + 错误反馈），只是不再依赖手写的事件绑定，
 * Alpine 自身的指令由真机 E2E 覆盖。
 *
 * 禁止: 断言 Alpine 模板结构；只断言"发了什么请求 + 如何反馈"。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

interface FetchCall {
	url: string;
	method: string;
	body?: string;
}
interface ToastCall {
	msg: string;
	kind?: string;
}
interface Component {
	startRun(mode: string): Promise<boolean>;
	pauseResume(): Promise<boolean>;
	stopRun(): Promise<boolean>;
	runState(): string;
	runBusy(): boolean;
	runControl: boolean;
	run: unknown;
	init?(): unknown;
	[key: string]: unknown;
}

/**
 * Load the real Alpine component.
 *
 * `@click` bindings are Alpine's job, so the component factory is captured from
 * `Alpine.data()` and driven directly — that is the same code the browser runs.
 */
function load(
	opts: { run?: unknown; startStatus?: number; startError?: string; fetchThrows?: boolean } = {},
) {
	const fetchLog: FetchCall[] = [];
	const toasts: ToastCall[] = [];
	let registered: (() => Component) | null = null;

	const respond = (url: string) => {
		if (url.includes("/api/run/start")) {
			return {
				ok: (opts.startStatus ?? 200) < 400,
				status: opts.startStatus ?? 200,
				json: () =>
					Promise.resolve(
						opts.startError
							? { error: opts.startError }
							: { state: "starting", mode: "agent" },
					),
			};
		}
		if (url.includes("/api/run/pause")) {
			return { ok: true, status: 200, json: () => Promise.resolve({ state: "paused" }) };
		}
		if (url.includes("/api/run/resume")) {
			return { ok: true, status: 200, json: () => Promise.resolve({ state: "running" }) };
		}
		if (url.includes("/api/run/stop")) {
			return { ok: true, status: 200, json: () => Promise.resolve({ state: "idle" }) };
		}
		return { ok: true, status: 200, json: () => Promise.resolve(opts.run ?? { state: "idle" }) };
	};

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
			return Promise.resolve(respond(String(url)));
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
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: () => 0,
		UI: {
			$: () => null,
			esc: (v: unknown) => String(v),
			toast: (msg: string, kind?: string) => toasts.push({ msg: String(msg), ...(kind ? { kind } : {}) }),
			renderNav: () => "",
			renderNavInto: () => {},
			segmented: () => {},
			combobox: () => null,
			confirmDialog: () => Promise.resolve(true),
			getPref: (_k: string, d: unknown) => d,
			setPref: () => {},
			connectWs: () => ({ close: () => {} }),
			scrollToEnd: () => false,
			pickColor: () => "#5ac8fa",
			fmtInt: (v: unknown) => String(v),
			fmtMoney: (v: unknown) => `£${v}`,
			fmtTok: (v: unknown) => `${v}t`,
			fmtCost: (v: unknown) => `$${v}`,
			fmtDuration: (v: unknown) => `${v}ms`,
			fmtAgo: (v: unknown) => `${v}ago`,
			fmtClock: (v: unknown) => `c${v}`,
			fmtPct: (v: number, d?: number) => `${(v * 100).toFixed(d ?? 1)}%`,
			fmtGameDate: (v: unknown) => String(v),
			categoryOf: () => "other",
			categoryLabel: (c: unknown) => String(c),
			categoryClass: (c: unknown) => `t-${c}`,
			categoryCounts: () => ({ counts: {}, total: 0, order: [] }),
			eventMatches: () => true,
			briefOf: () => "",
		},
		Charts: { line: () => {}, stackedBars: () => {}, stageMap: () => {} },
		StageViewUI: { backdropStyle: () => "", overlayMarks: () => [], LEGEND: { ours: [], base: [] } },
		LiveView: {
			create: () =>
				({
					link: "", sessionId: null, date: null, companies: {}, recent: [], telemetry: null,
					steps: [], thinking: [], stages: [], stageViews: [], run: null, runControl: false,
					startedAt: null, evSearch: "", evHidden: new Set(), cashMetric: "money",
					tokenMetric: "total", stepFilter: "all", stepRaw: false, evRaw: false, follow: true,
					cashMetrics: [], tokenMetrics: [],
					primaryCompany: () => ({}), resultKpis: () => [], costKpis: () => [],
					companiesEmpty: () => true, cashSeries: () => [], cashLabels: () => [],
					tokenSeries: () => [], tokenItems: () => [], visibleSteps: () => [],
					categoryChips: () => [], visibleEvents: () => [], eventTotal: () => 0,
					notice: () => ({ show: false, kind: "", title: "", body: "", canStart: false, hint: "" }),
					// Reads `this.run` like the real model, so the pause/resume branch
					// is driven by the component's actual state.
					runState(this: { run?: { state?: string } }) {
						return (this.run && this.run.state) || "idle";
					},
					runBusy(this: { run?: { state?: string } }) {
						const st = (this.run && this.run.state) || "idle";
						return st === "starting" || st === "stopping";
					},
					brainLabel: () => "",
					nowSummary: () => ({ state: "idle", brain: "", lastDecision: "", intent: "", action: "—", turns: "" }),
					stageList: () => [], stageViewsNewestFirst: () => [], toolRows: () => [],
					runtimeRows: () => [], turnRows: () => [], thinkingNewestFirst: () => [],
					toggleCategorySet: () => new Set(),
				}) as never,
			CASH_METRICS: [],
			TOKEN_METRICS: [],
		},
		Alpine: {
			data: (_name: string, factory: () => Component) => { registered = factory; },
			magic: () => {},
			store: () => {},
		},
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	const src = readFileSync(join(PUBLIC_DIR, "assets/js/live.js"), "utf8");
	vm.runInContext(src, sandbox);

	const factory = registered as (() => Component) | null;
	if (!factory) throw new Error("live.js did not register an Alpine component");
	const component = factory();
	// Wire the $refs/$nextTick the real component reads.
	(component as Record<string, unknown>).$nextTick = (fn: () => void) => fn();
	(component as Record<string, unknown>).$refs = {};
	if (opts.run !== undefined) component.run = opts.run;
	component.runControl = true;

	return { component, fetchLog, toasts };
}

describe("Live run controls (real code path)", () => {
	it("start agent actually sends POST /api/run/start", async () => {
		const { component, fetchLog, toasts } = load();
		await component.startRun("agent");
		const calls = fetchLog.filter((c) => c.url.includes("/api/run/start") && c.method === "POST");
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ mode: "agent" });
		expect(toasts.filter((t) => t.kind === "err")).toEqual([]);
	});

	it("never reports a swallowed ReferenceError", async () => {
		// The exact failure the user hit: any TDZ/shadowing bug in the request path
		// would land here as an err toast.
		const { component, toasts } = load();
		await component.startRun("agent");
		await component.startRun("watch");
		await component.pauseResume();
		const errs = toasts.filter((t) => t.kind === "err").map((t) => t.msg);
		expect(errs.filter((m) => /ReferenceError|before initialization/.test(m))).toEqual([]);
	});

	it("start watch sends the watch mode", async () => {
		const { component, fetchLog } = load();
		await component.startRun("watch");
		expect(fetchLog.find((c) => c.url.includes("/start"))!.body).toBe(JSON.stringify({ mode: "watch" }));
	});

	it("pause posts to /api/run/pause when running, resume when paused", async () => {
		const running = load({ run: { state: "running" } });
		await running.component.pauseResume();
		expect(running.fetchLog.filter((c) => c.url.includes("/api/run/pause"))).toHaveLength(1);

		const paused = load({ run: { state: "paused" } });
		await paused.component.pauseResume();
		expect(paused.fetchLog.filter((c) => c.url.includes("/api/run/resume"))).toHaveLength(1);
	});

	it("surfaces a server-side refusal instead of failing silently", async () => {
		const { component, toasts } = load({
			startStatus: 409,
			startError: "no provider/model configured",
		});
		const ok = await component.startRun("agent");
		expect(ok).toBe(false);
		expect(toasts.some((t) => t.kind === "err" && t.msg.includes("no provider/model"))).toBe(true);
	});

	it("turns a dead server into a message, not an unhandled rejection", async () => {
		// The request failing outright must still resolve, with a visible message:
		// an uncaught rejection here would leave the button looking dead.
		const { component, toasts } = load({ fetchThrows: true });
		await expect(component.startRun("agent")).resolves.toBe(false);
		expect(toasts.some((t) => t.kind === "err" && t.msg.includes("Request failed"))).toBe(true);
	});
});

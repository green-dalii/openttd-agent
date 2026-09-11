/**
 * Front-end test harness — run the real page scripts without a browser.
 *
 * 职责: 在 `node:vm` 里按真实顺序加载 `src/web/public/` 的脚本，
 *   用**从真实 HTML 解析出的 id 集合**构造最小 DOM，从而能真正
 *   "点击按钮 → 断言发出了什么请求"。
 *
 * 为什么需要它（2026-09-11 教训）: live.js 的 run 控制按钮曾经
 *   **一次请求都发不出去**——`const body` 遮蔽了同名参数，`JSON.stringify(body)`
 *   在 TDZ 里抛 ReferenceError，而异常被 catch 成 toast，
 *   于是"按钮点了没反应"且浏览器控制台干净。语法检查（`node --check`）、
 *   静态检查（符号存在性）和 curl 直打 API 全都发现不了：
 *   只有"走真实用户路径"的测试才能发现。
 *
 * 禁止: 引入 jsdom/headless 浏览器（保持零依赖；真机画面由 @live 测试覆盖）。
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../../src/web/server.js";

export interface FetchCall {
	url: string;
	method: string;
	body?: string;
}

export interface ToastCall {
	msg: string;
	kind?: string;
}

export interface Harness {
	fetchLog: FetchCall[];
	toasts: ToastCall[];
	/** Real element for an id (auto-created so a removed id cannot crash the test). */
	el: (id: string) => AnyElement;
	/** Fire the element's onclick and let the resulting promise chain settle. */
	click: (id: string) => Promise<void>;
	flush: (turns?: number) => Promise<void>;
	/** The first error toast, or null — the "silently swallowed failure" signal. */
	errorToast: () => string | null;
	/** Clicks that reached the network, by path. */
	callsTo: (path: string, method?: string) => FetchCall[];
}

interface AnyElement {
	id: string;
	tagName: string;
	textContent: string;
	innerHTML: string;
	className: string;
	hidden: boolean;
	disabled: boolean;
	checked: boolean;
	value: string;
	onclick: (() => unknown) | null;
	[key: string]: unknown;
}

/** Canvas 2D context: every method is a no-op, the few getters return shapes. */
function ctx2d(): unknown {
	return new Proxy(
		{},
		{
			get: (_t, prop) => {
				if (prop === "measureText") return () => ({ width: 10 });
				if (prop === "createLinearGradient") return () => ({ addColorStop: () => {} });
				if (prop === "canvas") return undefined;
				return () => {};
			},
			set: () => true,
		},
	);
}

function makeElement(id: string, tag = "div"): AnyElement {
	const attrs: Record<string, string> = {};
	const childNodes: AnyElement[] = [];
	const el = {
		id,
		tagName: tag.toUpperCase(),
		textContent: "",
		innerHTML: "",
		className: "",
		hidden: false,
		disabled: false,
		checked: false,
		value: "",
		onclick: null as (() => unknown) | null,
		style: {} as Record<string, string>,
		dataset: {} as Record<string, string>,
		width: 300,
		height: 150,
		clientWidth: 300,
		clientHeight: 150,
		children: childNodes,
		classList: {
			add: () => {},
			remove: () => {},
			toggle: () => {},
			contains: () => false,
		},
		appendChild: (c: AnyElement) => {
			childNodes.push(c);
			return c;
		},
		insertBefore: (c: AnyElement) => c,
		removeChild: () => {},
		remove: () => {},
		setAttribute: (k: string, v: unknown) => {
			attrs[k] = String(v);
		},
		getAttribute: (k: string) => attrs[k] ?? null,
		removeAttribute: (k: string) => {
			delete attrs[k];
		},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => true,
		focus: () => {},
		blur: () => {},
		closest: () => null,
		parentElement: null,
		querySelector: () => makeElement(""),
		querySelectorAll: () => [] as AnyElement[],
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150, right: 300, bottom: 150 }),
		getContext: () => ctx2d(),
		scrollIntoView: () => {},
		// `el.scrollTop = el.scrollHeight` patterns in the live log view.
		scrollTop: 0,
		scrollHeight: 0,
		firstChild: null,
	};
	return el as unknown as AnyElement;
}

/**
 * Load one page + its scripts into a fresh VM context.
 *
 * `scripts` are paths relative to `src/web/public/`; `page` is relative to `pages/`.
 * Order matters — the real pages load common.js, then charts.js, then the page script.
 */
export function loadFrontend(opts: {
	page: string;
	scripts: string[];
	/** Override a response by URL substring (first match wins). */
	respond?: { match: string; status?: number; json?: unknown }[];
}): Harness {
	const html = readFileSync(join(PUBLIC_DIR, "pages", opts.page), "utf8");

	// The id set comes from the real HTML, so the harness tracks the real page.
	const ids = new Set<string>();
	for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]!);

	const elements = new Map<string, AnyElement>();
	const fetchLog: FetchCall[] = [];
	const toasts: ToastCall[] = [];

	const el = (id: string): AnyElement => {
		let found = elements.get(id);
		if (!found) {
			found = makeElement(id);
			elements.set(id, found);
		}
		return found;
	};
	// Pre-create the ids the HTML actually has.
	for (const id of ids) el(id);

	const document = {
		getElementById: (id: string) => el(id),
		querySelector: (sel: string) => (sel.startsWith("#") ? el(sel.slice(1)) : makeElement("")),
		querySelectorAll: () => [] as AnyElement[],
		createElement: (tag: string) => makeElement("", tag),
		createTextNode: (t: string) => ({ textContent: t }),
		addEventListener: () => {},
		removeEventListener: () => {},
		body: makeElement("body", "body"),
		documentElement: makeElement("html", "html"),
		hidden: false,
		visibilityState: "visible",
	};

	const fetchStub = (url: unknown, init?: { method?: string; body?: unknown }) => {
		const u = String(url);
		fetchLog.push({
			url: u,
			method: (init?.method ?? "GET").toUpperCase(),
			...(init?.body === undefined ? {} : { body: String(init.body) }),
		});
		const override = opts.respond?.find((r) => u.includes(r.match));
		const status = override?.status ?? 200;
		const payload = override ? (override.json ?? {}) : {};
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			json: () => Promise.resolve(payload),
			text: () => Promise.resolve(JSON.stringify(payload)),
		});
	};

	const sandbox: Record<string, unknown> = {
		document,
		fetch: fetchStub,
		console,
		Promise,
		Math,
		JSON,
		Date,
		Number,
		String,
		Boolean,
		Array,
		Object,
		Set,
		Map,
		Error,
		RegExp,
		parseInt,
		parseFloat,
		isNaN,
		isFinite,
		encodeURIComponent,
		decodeURIComponent,
		AbortController,
		// Timers are inert: the tests must not depend on real time passing.
		setTimeout: () => 0,
		clearTimeout: () => {},
		setInterval: () => 0,
		clearInterval: () => {},
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
		devicePixelRatio: 1,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		WebSocket: class {
			close() {}
			send() {}
		},
		localStorage: {
			store: {} as Record<string, string>,
			getItem(this: { store: Record<string, string> }, k: string) {
				return this.store[k] ?? null;
			},
			setItem(this: { store: Record<string, string> }, k: string, v: string) {
				this.store[k] = String(v);
			},
			removeItem(this: { store: Record<string, string> }, k: string) {
				delete this.store[k];
			},
		},
		location: { pathname: "/", hash: "", search: "", href: "http://127.0.0.1/" },
		navigator: { userAgent: "node", language: "en" },
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		performance: { now: () => 0 },
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	sandbox.self = sandbox;

	const ctx = vm.createContext(sandbox);

	for (const script of opts.scripts) {
		const code = readFileSync(join(PUBLIC_DIR, script), "utf8");
		vm.runInContext(code, ctx, { filename: script });
	}

	// Wrap toast AFTER common.js but BEFORE the page script would be ideal; since
	// the page script reads `window.UI.toast` at call time, wrapping now is enough.
	const ui = sandbox.UI as { toast?: (m: string, k?: string, t?: number) => void } | undefined;
	if (ui?.toast) {
		const original = ui.toast.bind(ui);
		ui.toast = (msg: string, kind?: string) => {
			toasts.push({ msg: String(msg), ...(kind === undefined ? {} : { kind: String(kind) }) });
			return original(msg, kind);
		};
	}

	const flush = async (turns = 12) => {
		for (let i = 0; i < turns; i++) await Promise.resolve();
	};

	return {
		fetchLog,
		toasts,
		el,
		flush,
		async click(id: string) {
			const target = el(id);
			if (typeof target.onclick !== "function") {
				throw new Error(`#${id} has no onclick handler wired`);
			}
			await target.onclick();
			await flush();
		},
		errorToast: () => toasts.find((t) => t.kind === "err")?.msg ?? null,
		callsTo: (path: string, method?: string) =>
			fetchLog.filter(
				(c) => c.url.includes(path) && (!method || c.method === method.toUpperCase()),
			),
	};
}

/**
 * WebServer — HTTP static + WebSocket relay for the live dashboard.
 *
 * 职责: 提供原生仪表盘静态资源 (web/public) + WS 通道。Runner 把 WorldState
 *   快照与增量事件经 `publish` 推给浏览器; 浏览器请求 `snapshot` 时回全量。
 * 技术: node:http + ws 包 (SPEC §6.2 允许的最小依赖)。
 * 禁止: 持有游戏状态 (只转发); 不透传非必要控制指令 (v0.1 只读仪表盘)。
 */

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { stringifyJson } from "../util/json.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(__dirname, "public");

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
};

export type WireMessage =
	| { type: "snapshot"; data: unknown }
	| { type: "event"; data: unknown }
	| { type: "telemetry"; data: unknown }
	| { type: "step"; data: unknown };

/** Provider catalog access (docs/DASHBOARD-API.md §3.1). */
export interface CatalogHooks {
	/** Catalog generation timestamp (ms) or null. */
	generatedAt: () => number | null;
	/** Providers annotated with credential status (sync: file + env reads only). */
	providers: () => unknown[];
	/** Models for one provider, or null when the provider is unknown. */
	models: (providerId: string) => unknown | null;
	/** Forget a stored credential (logout). */
	deleteCredential: (providerId: string) => void;
}

/** Session history access (docs/DASHBOARD-API.md §3.3). */
export interface SessionHooks {
	list: () => unknown[];
	read: (id: string, limit?: number) => unknown | null;
}

export interface WebServerOptions {
	host?: string;
	port?: number;
	/** Called when a client subscribes; return the current snapshot payload. */
	getSnapshot?: () => unknown;
	onFirstClient?: () => void;
	/**
	 * LLM settings read/write hooks (SPEC §4). Injected so this module stays
	 * agnostic of the agent layer. When absent, /api/llm returns 404.
	 */
	llm?: {
		/** Safe view (never includes the raw key). */
		get: () => unknown;
		/** Validate + persist; returns the new safe view. Throws on bad input. */
		save: (body: unknown) => unknown;
	};
	/** Live agent telemetry snapshot. Absent => 404. */
	telemetry?: () => unknown;
	/** Built-in provider directory. Absent => 404. */
	catalog?: CatalogHooks;
	/** Past sessions. Absent => 404. */
	sessions?: SessionHooks;
}

/**
 * Page routes: URL -> file under `public/`. The tree is split by role so the
 * layout stays obvious as pages grow (docs/DASHBOARD-API.md §1):
 *
 *   public/pages/*.html        one file per page
 *   public/assets/css/*.css    styles
 *   public/assets/js/*.js      shared + per-page scripts
 *
 * URLs stay flat (`/llm`, not `/pages/llm.html`) so links keep working even if
 * files move. Add a page by adding one row here + one file in `pages/`.
 */
export const PAGES: Record<string, string> = {
	"/": "pages/live.html",
	"/llm": "pages/llm.html",
	"/sessions": "pages/sessions.html",
};

export class WebServer {
	readonly port: number;
	readonly host: string;

	private httpServer: http.Server;
	private wss: WebSocketServer;
	private getSnapshot: () => unknown;
	private onFirstClient?: () => void;
	private llmHooks?: WebServerOptions["llm"];
	private telemetryHook?: WebServerOptions["telemetry"];
	private catalogHooks?: CatalogHooks;
	private sessionHooks?: SessionHooks;
	private clients = new Set<WebSocket>();
	private started = false;

	constructor(opts: WebServerOptions = {}) {
		this.host = opts.host ?? "127.0.0.1";
		this.port = opts.port ?? 0; // 0 = OS-assigned
		this.getSnapshot = opts.getSnapshot ?? (() => ({}));
		this.onFirstClient = opts.onFirstClient;
		this.llmHooks = opts.llm;
		this.telemetryHook = opts.telemetry;
		this.catalogHooks = opts.catalog;
		this.sessionHooks = opts.sessions;

		this.httpServer = http.createServer((req, res) => this.serveStatic(req, res));
		this.wss = new WebSocketServer({ noServer: true });

		this.httpServer.on("upgrade", (req, socket, head) => {
			this.wss.handleUpgrade(req, socket, head, (ws) => {
				this.wss.emit("connection", ws, req);
			});
		});

		this.wss.on("connection", (ws) => {
			this.clients.add(ws);
			if (this.clients.size === 1) this.onFirstClient?.();
			// Send full snapshot immediately.
			this.send(ws, { type: "snapshot", data: this.getSnapshot() });
			ws.on("message", () => {
				// v0.1: read-only dashboard; ignore inbound for now.
			});
			ws.on("close", () => this.clients.delete(ws));
			ws.on("error", () => this.clients.delete(ws));
		});
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		await new Promise<void>((resolve) => {
			this.httpServer.listen(this.port, this.host, () => resolve());
		});
	}

	get actualPort(): number {
		const addr = this.httpServer.address();
		return addr && typeof addr === "object" ? addr.port : this.port;
	}

	/** Push an incremental event to all connected browsers. */
	publishEvent(data: unknown): void {
		const msg: WireMessage = { type: "event", data };
		for (const ws of this.clients) this.send(ws, msg);
	}

	/** Push a fresh snapshot to all connected browsers. */
	publishSnapshot(data: unknown): void {
		const msg: WireMessage = { type: "snapshot", data };
		for (const ws of this.clients) this.send(ws, msg);
	}

	/** Push an agent telemetry snapshot (docs §4). Callers must throttle. */
	publishTelemetry(data: unknown): void {
		const msg: WireMessage = { type: "telemetry", data };
		for (const ws of this.clients) this.send(ws, msg);
	}

	/** Push one agent step (message/tool) for immediate UI append. */
	publishStep(data: unknown): void {
		const msg: WireMessage = { type: "step", data };
		for (const ws of this.clients) this.send(ws, msg);
	}

	clientCount(): number {
		return this.clients.size;
	}

	async stop(): Promise<void> {
		for (const ws of this.clients) {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		}
		this.clients.clear();
		this.wss.close();
		await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
	}

	private send(ws: WebSocket, msg: WireMessage): void {
		if (ws.readyState !== ws.OPEN) return;
		try {
			ws.send(stringifyJson(msg));
		} catch {
			/* dropped */
		}
	}

	private async serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			if (url.pathname === "/api/llm") {
				await this.handleLlmApi(req, res);
				return;
			}
			if (url.pathname.startsWith("/api/")) {
				await this.handleApi(req, res, url);
				return;
			}
			let p = decodeURIComponent(url.pathname);
			// Page route table first (see PAGES); then plain static files.
			const route = PAGES[p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p];
			if (route) p = `/${route}`;
			// Prevent path traversal.
			const filePath = path.normalize(path.join(PUBLIC_DIR, p));
			if (!filePath.startsWith(PUBLIC_DIR)) {
				res.writeHead(403).end("forbidden");
				return;
			}
			const data = await fs.readFile(filePath);
			const ext = path.extname(filePath).toLowerCase();
			res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
			res.end(data);
		} catch {
			res.writeHead(404).end("not found");
		}
	}

	/**
	 * Dispatch the non-LLM API routes (docs §3). Every hook is optional: a
	 * disabled feature answers 404 rather than 500.
	 */
	private async handleApi(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		url: URL,
	): Promise<void> {
		const json = (code: number, body: unknown) => {
			res.writeHead(code, { "content-type": "application/json" }).end(stringifyJson(body));
		};
		const segments = url.pathname.split("/").filter(Boolean); // ["api", ...]
		try {
			// GET /api/telemetry
			if (url.pathname === "/api/telemetry" && req.method === "GET") {
				if (!this.telemetryHook) return json(404, { error: "telemetry disabled" });
				return json(200, this.telemetryHook());
			}

			// /api/llm/catalog[...]
			if (segments[1] === "llm" && segments[2] === "catalog") {
				if (!this.catalogHooks) return json(404, { error: "catalog disabled" });
				if (req.method !== "GET") return json(405, { error: "method not allowed" });
				if (segments.length === 3) {
					return json(200, {
						generatedAt: this.catalogHooks.generatedAt(),
						providers: this.catalogHooks.providers(),
					});
				}
				const id = decodeURIComponent(segments[3] ?? "");
				const models = this.catalogHooks.models(id);
				if (models === null) return json(404, { error: `unknown provider "${id}"` });
				const provider = this.catalogHooks
					.providers()
					.find((p) => (p as { id?: string }).id === id);
				return json(200, { provider: provider ?? null, models });
			}

			// /api/llm/credentials/:id
			if (segments[1] === "llm" && segments[2] === "credentials") {
				if (!this.catalogHooks) return json(404, { error: "catalog disabled" });
				if (req.method !== "DELETE") return json(405, { error: "method not allowed" });
				const id = decodeURIComponent(segments[3] ?? "");
				if (!id) return json(400, { error: "missing provider id" });
				this.catalogHooks.deleteCredential(id);
				return json(200, { ok: true });
			}

			// /api/sessions[/:id]
			if (segments[1] === "sessions") {
				if (!this.sessionHooks) return json(404, { error: "sessions disabled" });
				if (req.method !== "GET") return json(405, { error: "method not allowed" });
				if (segments.length === 2) return json(200, { sessions: this.sessionHooks.list() });
				const id = decodeURIComponent(segments[2] ?? "");
				const limitRaw = Number(url.searchParams.get("limit"));
				const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
				const one = this.sessionHooks.read(id, limit);
				if (!one) return json(404, { error: `unknown session "${id}"` });
				return json(200, one);
			}

			return json(404, { error: "not found" });
		} catch (e) {
			json(500, { error: e instanceof Error ? e.message : String(e) });
		}
	}

	/**
	 * GET  /api/llm -> current settings (key redacted)
	 * POST /api/llm -> save settings { baseUrl, model, apiKey?, api?, provider? }
	 * Localhost-only by construction (server binds 127.0.0.1). The raw key is
	 * never returned.
	 */
	private async handleLlmApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (!this.llmHooks) {
			res.writeHead(404, { "content-type": "application/json" }).end('{"error":"llm api disabled"}');
			return;
		}
		const json = (code: number, body: unknown) => {
			res.writeHead(code, { "content-type": "application/json" }).end(stringifyJson(body));
		};
		try {
			if (req.method === "GET") {
				json(200, this.llmHooks.get());
				return;
			}
			if (req.method === "POST") {
				const raw = await readBody(req);
				const parsed: unknown = raw.length ? JSON.parse(raw) : {};
				json(200, this.llmHooks.save(parsed));
				return;
			}
			json(405, { error: "method not allowed" });
		} catch (e) {
			json(400, { error: e instanceof Error ? e.message : String(e) });
		}
	}
}

/** Read a small request body (bounded). */
async function readBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const c of req) {
		const buf = c as Buffer;
		total += buf.length;
		if (total > maxBytes) throw new Error("request body too large");
		chunks.push(buf);
	}
	return Buffer.concat(chunks).toString("utf8");
}

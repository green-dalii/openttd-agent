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
	| { type: "event"; data: unknown };

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
}

export class WebServer {
	readonly port: number;
	readonly host: string;

	private httpServer: http.Server;
	private wss: WebSocketServer;
	private getSnapshot: () => unknown;
	private onFirstClient?: () => void;
	private llmHooks?: WebServerOptions["llm"];
	private clients = new Set<WebSocket>();
	private started = false;

	constructor(opts: WebServerOptions = {}) {
		this.host = opts.host ?? "127.0.0.1";
		this.port = opts.port ?? 0; // 0 = OS-assigned
		this.getSnapshot = opts.getSnapshot ?? (() => ({}));
		this.onFirstClient = opts.onFirstClient;
		this.llmHooks = opts.llm;

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
			let p = decodeURIComponent(url.pathname);
			if (p === "/") p = "/index.html";
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

/**
 * Unit tests — dashboard REST surface (LLM catalog/settings, telemetry, sessions).
 * 事实来源: docs/DASHBOARD-API.md §3 (frozen contract). Uses fake hooks so this
 * stays pure (no pi-ai catalog build, no network).
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { PAGES, PAGE_ALIASES, PUBLIC_DIR, WebServer } from "../../src/web/server.js";

/** Recursive relative file listing under a directory (test helper). */
function listFiles(root: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...listFiles(root, rel));
		else out.push(rel);
	}
	return out;
}

interface Json {
	status: number;
	body: Record<string, unknown>;
}

describe("WebServer REST", () => {
	let server: WebServer | null = null;
	let port = 0;
	const deleted: string[] = [];

	afterEach(async () => {
		if (server) await server.stop();
		server = null;
		deleted.length = 0;
	});

	async function start(over: Partial<ConstructorParameters<typeof WebServer>[0]> = {}): Promise<void> {
		server = new WebServer({
			host: "127.0.0.1",
			port: 0,
			getSnapshot: () => ({ hello: "world" }),
			llm: {
				get: () => ({
					selection: { source: "catalog", providerId: "openai", model: "gpt-5", api: "openai-responses", baseUrl: "" },
					status: { configured: true, hasStoredKey: true, envKeys: [], source: "stored" },
				}),
				save: (body) => ({ saved: body }),
			},
			telemetry: () => ({ sessionId: "s1", totals: { toolCalls: 3 } }),
			catalog: {
				generatedAt: () => 1234,
				providers: () => [{ id: "openai", modelCount: 39, auth: { configured: true, source: "stored" } }],
				models: (id) => (id === "openai" ? [{ id: "gpt-5", api: "openai-responses" }] : null),
				deleteCredential: (id) => {
					deleted.push(id);
				},
			},
			sessions: {
				list: () => [{ id: "20260910-213000-seed7", mode: "agent", status: "completed" }],
				read: (id) => (id === "known" ? { meta: { id }, telemetry: null, events: [], audit: [] } : null),
			},
			...over,
		});
		await server.start();
		port = server.actualPort;
	}

	function req(method: string, path: string, body?: unknown): Promise<Json> {
		return new Promise<Json>((resolve, reject) => {
			const payload = body === undefined ? undefined : JSON.stringify(body);
			const r = http.request(
				{
					host: "127.0.0.1",
					port,
					path,
					method,
					headers: payload ? { "content-type": "application/json" } : undefined,
				},
				(res) => {
					let d = "";
					res.on("data", (c) => (d += c));
					res.on("end", () => {
						let parsed: Record<string, unknown> = {};
						try {
							parsed = d ? (JSON.parse(d) as Record<string, unknown>) : {};
						} catch {
							parsed = { raw: d };
						}
						resolve({ status: res.statusCode ?? 0, body: parsed });
					});
				},
			);
			r.on("error", reject);
			if (payload) r.write(payload);
			r.end();
		});
	}

	it("GET /api/llm returns the frozen selection/status shape", async () => {
		await start();
		const r = await req("GET", "/api/llm");
		expect(r.status).toBe(200);
		expect((r.body.selection as { providerId: string }).providerId).toBe("openai");
		expect((r.body.status as { configured: boolean }).configured).toBe(true);
	});

	it("POST /api/llm forwards the body to the save hook", async () => {
		await start();
		const r = await req("POST", "/api/llm", { source: "catalog", providerId: "deepseek", model: "deepseek-chat" });
		expect(r.status).toBe(200);
		expect(r.body.saved).toMatchObject({ source: "catalog", providerId: "deepseek" });
	});

	it("GET /api/telemetry returns the snapshot (and 404 when disabled)", async () => {
		await start();
		const r = await req("GET", "/api/telemetry");
		expect(r.status).toBe(200);
		expect((r.body.totals as { toolCalls: number }).toolCalls).toBe(3);
		if (server) await server.stop();
		await start({ telemetry: undefined });
		expect((await req("GET", "/api/telemetry")).status).toBe(404);
	});

	it("GET /api/llm/catalog lists providers + generation timestamp", async () => {
		await start();
		const r = await req("GET", "/api/llm/catalog");
		expect(r.status).toBe(200);
		expect(r.body.generatedAt).toBe(1234);
		expect((r.body.providers as unknown[]).length).toBe(1);
	});

	it("GET /api/llm/catalog/:id returns provider + models, 404 for unknown", async () => {
		await start();
		const ok = await req("GET", "/api/llm/catalog/openai");
		expect(ok.status).toBe(200);
		expect((ok.body.models as unknown[]).length).toBe(1);
		const missing = await req("GET", "/api/llm/catalog/nope");
		expect(missing.status).toBe(404);
	});

	it("DELETE /api/llm/credentials/:id clears the stored key", async () => {
		await start();
		const r = await req("DELETE", "/api/llm/credentials/openai");
		expect(r.status).toBe(200);
		expect(deleted).toEqual(["openai"]);
	});

	it("GET /api/sessions lists and /api/sessions/:id reads one", async () => {
		await start();
		const list = await req("GET", "/api/sessions");
		expect(list.status).toBe(200);
		expect((list.body.sessions as unknown[]).length).toBe(1);

		const one = await req("GET", "/api/sessions/known");
		expect(one.status).toBe(200);
		expect((one.body.meta as { id: string }).id).toBe("known");

		const missing = await req("GET", "/api/sessions/unknown");
		expect(missing.status).toBe(404);
	});

	it("serves every page route declared in the PAGES table", async () => {
		await start();
		// Guards the URL->file mapping so a page can never 404 silently.
		for (const [path, file] of Object.entries(PAGES)) {
			const res = await new Promise<number>((res, rej) => {
				http
					.get(`http://127.0.0.1:${port}${path}`, (r) => {
						r.resume();
						r.on("end", () => res(r.statusCode ?? 0));
					})
					.on("error", rej);
			});
			expect(res, `${path} -> ${file}`).toBe(200);
			expect(existsSync(join(PUBLIC_DIR, file)), file).toBe(true);
		}
	});

	it("serves static assets from the role-based tree", async () => {
		await start();
		for (const asset of [
			"assets/css/style.css",
			"assets/js/common.js",
			"assets/js/live.js",
			"assets/js/providers.js",
			"assets/js/sessions.js",
		]) {
			const r = await new Promise<{ status: number; body: string }>((res, rej) => {
				http
					.get(`http://127.0.0.1:${port}/${asset}`, (x) => {
						let d = "";
						x.on("data", (c) => (d += c));
						x.on("end", () => res({ status: x.statusCode ?? 0, body: d }));
					})
					.on("error", rej);
			});
			expect(r.status, asset).toBe(200);
			expect(r.body.length, asset).toBeGreaterThan(0);
		}
	});

	it("keeps pages out of asset dirs and vice versa (layout contract)", () => {
		const files = listFiles(PUBLIC_DIR);
		expect(files.some((f) => f.startsWith("pages/") && f.endsWith(".html"))).toBe(true);
		expect(files.some((f) => f.startsWith("assets/css/") && f.endsWith(".css"))).toBe(true);
		expect(files.some((f) => f.startsWith("assets/js/") && f.endsWith(".js"))).toBe(true);
		// No stray HTML/CSS/JS at the public root.
		expect(files.filter((f) => !f.includes("/"))).toEqual([]);
	});

	it("references only files that exist (catches broken href/src)", () => {
		for (const page of listFiles(PUBLIC_DIR).filter((f) => f.startsWith("pages/") && f.endsWith(".html"))) {
			const html = readFileSync(join(PUBLIC_DIR, page), "utf8");
			const refs = [...html.matchAll(/(?:href|src)="\/([^"]+)"/g)].map((m) => m[1]!);
			expect(refs.length, page).toBeGreaterThan(0);
			for (const ref of refs) {
				expect(existsSync(join(PUBLIC_DIR, ref)), `${page} -> ${ref}`).toBe(true);
			}
		}
	});

	it("serves legacy page aliases without a 404", async () => {
		await start();
		for (const [path, needle] of [
			["/llm", "Provider"],
			["/sessions", "Session"],
		] as const) {
			const res = await new Promise<string>((res, rej) => {
				http
					.get(`http://127.0.0.1:${port}${path}`, (r) => {
						let d = "";
						r.on("data", (c) => (d += c));
						r.on("end", () => res(d));
					})
					.on("error", rej);
			});
			expect(res.length).toBeGreaterThan(0);
			expect(res.toLowerCase()).toContain(needle.toLowerCase());
		}
	});

	it("returns 404 for api routes when hooks are absent", async () => {
		await start({ llm: undefined, catalog: undefined, sessions: undefined, telemetry: undefined });
		expect((await req("GET", "/api/llm")).status).toBe(404);
		expect((await req("GET", "/api/llm/catalog")).status).toBe(404);
		expect((await req("GET", "/api/sessions")).status).toBe(404);
	});

	it("rejects unsupported methods on the llm endpoint", async () => {
		await start();
		const r = await req("PUT", "/api/llm", {});
		expect(r.status).toBe(405);
	});
});

/**
 * Staged summaries must reach a live browser DURING a run, not only at shutdown
 * (docs/DASHBOARD-UI.md §7). These tests lock the WS frame + snapshot payload.
 */
describe("WebServer checkpoints", () => {
	let server: WebServer | null = null;
	let port = 0;
	afterEach(async () => {
		if (server) await server.stop();
		server = null;
	});

	async function startWithCheckpoints(): Promise<void> {
		server = new WebServer({
			host: "127.0.0.1",
			port: 0,
			getSnapshot: () => ({
				totalEvents: 5,
				checkpoints: [{ at: 1, gameDate: "1950-02-01", turn: 1, note: "first", totals: {} }],
			}),
		});
		await server.start();
		port = server.actualPort;
	}

	/** Collect WS frames until `want` arrives or the deadline passes. */
	function frames(want: string, timeoutMs = 3000): Promise<Record<string, unknown>[]> {
		return new Promise((resolve, reject) => {
			const got: Record<string, unknown>[] = [];
			const ws = new WebSocket(`ws://127.0.0.1:${port}`);
			const done = (err?: Error) => {
				ws.close();
				if (err) reject(err);
				else resolve(got);
			};
			const timer = setTimeout(() => done(new Error(`no '${want}' frame within ${timeoutMs}ms`)), timeoutMs);
			ws.on("message", (raw) => {
				const msg = JSON.parse(String(raw)) as Record<string, unknown>;
				got.push(msg);
				if (msg.type === want) {
					clearTimeout(timer);
					done();
				}
			});
			ws.on("error", (e) => {
				clearTimeout(timer);
				done(e);
			});
		});
	}

	it("broadcasts a checkpoint frame to a connected client", async () => {
		await startWithCheckpoints();
		const pending = frames("checkpoint");
		// Give the socket a moment to register, then publish like a runner would.
		await new Promise((r) => setTimeout(r, 120));
		server!.publishCheckpoint({
			at: 1234,
			gameDate: "1950-04-01",
			turn: 2,
			note: "2 decisions, 3 tool calls",
			totals: { events: 12 },
		});
		const got = await pending;
		const frame = got.find((m) => m.type === "checkpoint");
		expect(frame).toBeTruthy();
		const data = frame!.data as { gameDate: string; note: string };
		expect(data.gameDate).toBe("1950-04-01");
		expect(data.note).toContain("2 decisions");
	});

	it("serves the snapshot with the checkpoint backlog so a reload is not empty", async () => {
		await startWithCheckpoints();
		const got = await frames("snapshot");
		const snap = got.find((m) => m.type === "snapshot")!.data as { checkpoints: unknown[] };
		expect(Array.isArray(snap.checkpoints)).toBe(true);
		expect(snap.checkpoints).toHaveLength(1);
	});

	it("resolves the legacy /llm URL to the providers page", async () => {
		await startWithCheckpoints();
		expect(PAGE_ALIASES["/llm"]).toBe("/providers");
		expect(PAGES["/providers"]).toBe("pages/providers.html");
		const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			http
				.get({ host: "127.0.0.1", port, path: "/llm" }, (res) => {
					let d = "";
					res.on("data", (c) => (d += c));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d }));
				})
				.on("error", reject);
		});
		expect(r.status).toBe(200);
		expect(r.body).toContain("providers");
	});
});

/**
 * Stage images: the captured minimap must be reachable, and nothing else must be.
 * `screenshot minimap` is the only capture that works headless
 * (docs/AGENT-LOOP-AND-CONTROL.md §4), so this endpoint is how the dashboard shows
 * real game images instead of only a schematic.
 */
describe("WebServer stage images", () => {
	let server: WebServer | null = null;
	let port = 0;
	afterEach(async () => {
		if (server) await server.stop();
		server = null;
	});

	const PNG = Buffer.from(
		// 1x1 PNG (valid signature + IHDR) - enough to assert byte passthrough.
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
		"base64",
	);

	async function startWithStageFile(): Promise<void> {
		server = new WebServer({
			host: "127.0.0.1",
			port: 0,
			sessions: {
				list: () => [],
				read: () => null,
				stageFile: (id, file) => (id === "s1" && file === "001.png" ? PNG : null),
			},
		});
		await server.start();
		port = server.actualPort;
	}

	function get(path: string): Promise<{ status: number; type: string; body: Buffer }> {
		return new Promise((resolve, reject) => {
			http.get({ host: "127.0.0.1", port, path }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c as Buffer));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						type: String(res.headers["content-type"] ?? ""),
						body: Buffer.concat(chunks),
					}),
				);
			}).on("error", reject);
		});
	}

	it("serves an archived stage PNG with the right content type", async () => {
		await startWithStageFile();
		const r = await get("/api/sessions/s1/stages/001.png");
		expect(r.status).toBe(200);
		expect(r.type).toContain("image/png");
		expect(r.body.equals(PNG)).toBe(true);
	});

	it("404s for a stage that does not exist", async () => {
		await startWithStageFile();
		const r = await get("/api/sessions/s1/stages/999.png");
		expect(r.status).toBe(404);
	});

	it("404s (not 500) for a traversal attempt", async () => {
		await startWithStageFile();
		for (const bad of ["..%2F..%2Fopenttd.cfg", "001.png%2F..%2F..%2Fsecrets.cfg"]) {
			const r = await get(`/api/sessions/s1/stages/${bad}`);
			expect(r.status, bad).toBe(404);
			expect(r.type).toContain("json");
		}
	});

	it("404s when the server has no stage hook at all", async () => {
		server = new WebServer({ host: "127.0.0.1", port: 0, getSnapshot: () => ({}) });
		await server.start();
		port = server.actualPort;
		const r = await get("/api/sessions/s1/stages/001.png");
		expect(r.status).toBe(404);
	});
});

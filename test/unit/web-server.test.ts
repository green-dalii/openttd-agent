import { afterEach, describe, expect, it } from "vitest";
import { WebServer } from "../../src/web/server.js";
import WebSocket from "ws";
import http from "node:http";

describe("WebServer", () => {
	let server: WebServer | null = null;
	let port = 0;

	afterEach(async () => {
		if (server) await server.stop();
		server = null;
	});

	async function start(snapshot?: unknown): Promise<void> {
		server = new WebServer({
			host: "127.0.0.1",
			port: 0,
			getSnapshot: () => snapshot ?? { hello: "world" },
		});
		await server.start();
		port = server.actualPort;
	}

	it("serves index.html over HTTP", async () => {
		await start();
		const body = await new Promise<string>((res, rej) => {
			http.get(`http://127.0.0.1:${port}/`, (r) => {
				let d = "";
				r.on("data", (c) => (d += c));
				r.on("end", () => res(d));
			}).on("error", rej);
		});
		expect(body).toContain("openttd-agent");
	});

	it("pushes snapshot on WS connect and events after", async () => {
		await start({ hello: "world", n: 1 });
		const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
		const got: Array<{ type: string; data: unknown }> = [];
		ws.on("message", (d) => {
			const m = JSON.parse(d.toString()) as { type: string; data: unknown };
			got.push(m);
		});
		await new Promise<void>((res) => ws.on("open", () => res()));
		// Wait for initial snapshot
		await new Promise((r) => setTimeout(r, 100));
		expect(got.length).toBeGreaterThanOrEqual(1);
		expect(got[0]!.type).toBe("snapshot");
		expect(got[0]!.data).toEqual({ hello: "world", n: 1 });

		server!.publishEvent({ kind: "date", seq: 7 });
		await new Promise((r) => setTimeout(r, 100));
		const last = got[got.length - 1]!;
		expect(last.type).toBe("event");
		expect((last.data as { kind?: string }).kind).toBe("date");
		ws.close();
	});

	it("rejects path traversal", async () => {
		await start();
		const res = await new Promise<number>((res, rej) => {
			http.get(`http://127.0.0.1:${port}/../package.json`, (r) => res(r.statusCode ?? 0)).on("error", rej);
		});
		expect(res).toBe(404);
	});
});

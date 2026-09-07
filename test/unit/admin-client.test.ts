import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { AdminClient, type ClientStatus } from "../../src/game/admin-client.js";
import { loadConfig } from "../../src/config.js";
import {
	AdminPacketType,
	FrameWriter,
	FrameStreamParser,
	packCStr,
} from "../../src/game/admin-protocol.js";

/** Minimal fake admin server: decodes inbound, can push outbound frames. */
class FakeAdminServer {
	server: net.Server;
	port = 0;
	received: Array<{ type: number; payload: Uint8Array }> = [];
	private parser = new FrameStreamParser();
	onWelcome = true;
	sockets: net.Socket[] = [];

	constructor() {
		this.server = net.createServer((sock) => {
			this.sockets.push(sock);
			sock.on("data", (c) => {
				for (const pkt of this.parser.push(new Uint8Array(c))) {
					this.received.push({ type: pkt.type, payload: pkt.payload });
					if (pkt.type === AdminPacketType.AdminJoin) {
						if (this.onWelcome) {
							this.sendWelcome(sock);
						} else {
							this.sendError(sock, "password mismatch");
						}
					}
				}
			});
		});
	}

	async listen(): Promise<void> {
		this.server.listen(0, "127.0.0.1");
		await once(this.server, "listening");
		const addr = this.server.address();
		if (addr && typeof addr === "object") this.port = addr.port;
	}

	private frame(type: number, fill: (w: FrameWriter) => void): Buffer {
		const w = new FrameWriter();
		fill(w);
		return Buffer.from(w.build(type));
	}

	sendWelcome(sock: net.Socket): void {
		// welcome: server_name\0 revision\0 dedicated(bool) mapname\0 seed u32 landscape u8 startdate u32 sx u16 sy u16
		sock.write(
			this.frame(AdminPacketType.ServerWelcome, (w) =>
				w
					.str("test-server")
					.str("15.0")
					.bool(true)
					.str("map")
					.uint32(42)
					.uint8(0)
					.uint32(712223)
					.uint16(256)
					.uint16(256),
			),
		);
	}

	sendError(sock: net.Socket, msg: string): void {
		sock.write(this.frame(AdminPacketType.ServerError, (w) => w.raw(packCStr(msg))));
	}

	/** Push a ServerDate frame to all sockets. */
	pushDate(sock: net.Socket, raw: number): void {
		sock.write(this.frame(AdminPacketType.ServerDate, (w) => w.uint32(raw)));
	}

	close(): void {
		for (const s of this.sockets) s.destroy();
		this.server.close();
	}
}

function makeCfg(port: number) {
	return loadConfig({
		OPENTTD_ADMIN_PORT: String(port),
		OPENTTD_ADMIN_PASSWORD: "pw",
	});
}

describe("AdminClient", () => {
	let fake: FakeAdminServer;

	beforeEach(async () => {
		fake = new FakeAdminServer();
		await fake.listen();
	});
	afterEach(() => fake.close());

	it("connects, joins, auto-boots default subscriptions", async () => {
		const cfg = makeCfg(fake.port);
		const statuses: ClientStatus[] = [];
		const client = new AdminClient({
			cfg,
			callbacks: {
				onStatusChange: (s) => statuses.push(s),
				onWelcome: () => {},
			},
		});
		await client.connect();
		await new Promise((r) => setTimeout(r, 50)); // let welcome arrive
		expect(statuses).toContain("connected");
		expect(client.isAuthed()).toBe(true);

		const joinIdx = fake.received.findIndex((r) => r.type === AdminPacketType.AdminJoin);
		expect(joinIdx).toBeGreaterThanOrEqual(0);
		const afterJoin = fake.received.slice(joinIdx + 1);
		const freqTypes = afterJoin.filter((r) => r.type === AdminPacketType.AdminUpdateFrequency);
		expect(freqTypes.length).toBeGreaterThanOrEqual(4); // date/company/economy/stats/console
		client.close();
	});

	it("emits normalized date events", async () => {
		const cfg = makeCfg(fake.port);
		const events: unknown[] = [];
		const client = new AdminClient({
			cfg,
			callbacks: { onEvent: (e) => events.push(e) },
		});
		await client.connect();
		await new Promise((r) => setTimeout(r, 50)); // authed
		fake.pushDate(fake.sockets[0]!, 712223);
		await new Promise((r) => setTimeout(r, 100));
		expect(events.some((e) => (e as { kind?: string; payload?: { year?: number } }).kind === "date" && (e as { payload?: { year?: number } }).payload?.year === 1950)).toBe(true);
		client.close();
	});

	it("emits onError when server rejects join", async () => {
		const cfg = makeCfg(fake.port);
		fake.onWelcome = false;
		let resolveErr: (v: { kind: string; msg: string }) => void;
		const err = new Promise<{ kind: string; msg: string }>((res) => {
			resolveErr = res;
		});
		const client = new AdminClient({
			cfg,
			callbacks: { onError: (kind, msg) => resolveErr!({ kind, msg }) },
		});
		await client.connect();
		const e = await err;
		expect(e.msg).toContain("password mismatch");
		client.close();
	});
});

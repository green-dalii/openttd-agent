import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { AdminClient, type ClientStatus } from "../../src/game/admin-client.js";
import { loadConfig } from "../../src/config.js";
import {
	AdminPacketType,
	AdminUpdateType,
	AdminUpdateFrequency,
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
	/** 协议顺序：服务端连上后先发 ServerProtocol（真机如此）；false = 手动控制。 */
	autoProtocol = true;
	/** 前 N 个连接直接被服务端断开（模拟 OpenTTD 自举期踢连接）。 */
	destroyFirst = 0;
	sockets: net.Socket[] = [];

	constructor() {
		this.server = net.createServer((sock) => {
			this.sockets.push(sock);
			if (this.destroyFirst > 0) {
				this.destroyFirst--;
				sock.destroy();
				return;
			}
			if (this.autoProtocol) this.sendProtocol(sock);
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

	/** 服务端握手第一步：ServerProtocol（payload 内容客户端忽略）。 */
	sendProtocol(sock: net.Socket): void {
		sock.write(this.frame(AdminPacketType.ServerProtocol, (w) => w.str("15.3").uint16(1)));
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
		expect(freqTypes.length).toBeGreaterThanOrEqual(5); // date/company/economy/stats/console/gs
		// Bridge GS channel requires the Gamescript subscription (SPE §10.11).
		const gsFreq = freqTypes.find(
			(r) =>
				r.payload[0] === AdminUpdateType.Gamescript &&
				(r.payload[2]! | (r.payload[3]! << 8)) === AdminUpdateFrequency.Automatic,
		);
		expect(gsFreq, "AdminClient must subscribe Gamescript/Automatic by default").toBeTruthy();
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

/**
 * rconAwait（2026-09-17）：rcon 必须能等到回执，否则工具无法观测自己的效果。
 *
 * 契约来自 Resources/docs/admin_network.md:190-191：一次 rcon → **一个或多个**
 * SERVER_RCON 包，**最后**一个 ADMIN_PACKET_ADMIN_RCON_END。命令文本不回显
 * （真机实测：command 字段为空），所以按 FIFO 结算，不能按命令匹配。
 */
describe("rconAwait —— 等待 rcon 回执（FIFO + RCON_END）", () => {
	const reply = (srv: FakeAdminServer, lines: string[]) => {
		for (const l of lines) {
			const w = new FrameWriter();
			w.str("").str(l); // 真机不回显命令 → command 为空
			srv.sockets[0]!.write(Buffer.from(w.build(AdminPacketType.ServerRcon)));
		}
		const end = new FrameWriter();
		srv.sockets[0]!.write(Buffer.from(end.build(AdminPacketType.ServerRconEnd)));
	};

	const connect = async (srv: FakeAdminServer) => {
		const client = new AdminClient({
			cfg: loadConfig({ OPENTTD_ADMIN_PORT: String(srv.port), OPENTTD_ADMIN_PASSWORD: "x" }) as never,
			callbacks: {},
		} as never);
		await client.connect(2_000);
		for (let i = 0; i < 50 && srv.sockets.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
		return client;
	};

	it("多行回执在 RCON_END 时一次性返回（不是第一行就返回）", async () => {
		const srv = new FakeAdminServer();
		await srv.listen();
		const client = await connect(srv);
		const pending = client.rconAwait("list_cmds", 2_000);
		reply(srv, ["pause", "unpause", "setting"]);
		expect(await pending).toBe("pause\nunpause\nsetting");
		client.close();
		srv.close();
	});

	it("没有 RCON_END 的超时 → null（不把第一行当收尾）", async () => {
		const srv = new FakeAdminServer();
		await srv.listen();
		const client = await connect(srv);
		const pending = client.rconAwait("something", 300);
		const w = new FrameWriter();
		w.str("").str("partial line");
		srv.sockets[0]!.write(Buffer.from(w.build(AdminPacketType.ServerRcon)));
		expect(await pending).toBeNull();
		client.close();
		srv.close();
	});

	it("连续两次调用按 FIFO 结算（回执是有序的）", async () => {
		const srv = new FakeAdminServer();
		await srv.listen();
		const client = await connect(srv);
		const first = client.rconAwait("a", 2_000);
		reply(srv, ["A1"]);
		expect(await first).toBe("A1");
		const second = client.rconAwait("b", 2_000);
		reply(srv, ["B1"]);
		expect(await second).toBe("B1");
		client.close();
		srv.close();
	});
});

/**
 * 握手与自举竞态（2026-10-07 真机事故）：OpenTTD 的 admin 端口在**游戏就绪前**
 * 就监听（地图生成期间），旧实现在 TCP 连上后立刻发 JOIN，于是在自举窗口里被
 * 踢（`'' has disconnected`）或被 reset（ECONNRESET/EPIPE），而初始握手**没有
 * 重试**（autoReconnect 只管建立之后掉线）⇒ 一局直接报废。
 */
describe("AdminClient 握手：协议顺序 + 自举期重试", () => {
	it("JOIN 立即发，不等 ServerProtocol（实测该服务端「先收后说」，空等会死锁）", async () => {
		const fake = new FakeAdminServer();
		fake.autoProtocol = false; // 服务端保持沉默（真机如此：客户端不发它就不说）
		await fake.listen();
		const client = new AdminClient({ cfg: makeCfg(fake.port), callbacks: {} });
		await client.connect(2_000);
		await new Promise((r) => setTimeout(r, 120));
		// 2026-10-07 裸 socket 实测：服务端不先发字节。等 PROTOCOL 再 JOIN = 死锁。
		expect(fake.received.filter((p) => p.type === AdminPacketType.AdminJoin)).toHaveLength(1);
		// PROTOCOL 迟到时不得重复 JOIN（joinSent 幂等）
		fake.sendProtocol(fake.sockets[0]!);
		await new Promise((r) => setTimeout(r, 120));
		expect(fake.received.filter((p) => p.type === AdminPacketType.AdminJoin)).toHaveLength(1);
		client.close();
		fake.close();
	});

	it("connectAuthed：自举窗口被踢/被 reset 后有界重试，直到握手成功", async () => {
		const fake = new FakeAdminServer();
		fake.destroyFirst = 2; // 前两个连接直接被服务端断开
		await fake.listen();
		const client = new AdminClient({ cfg: makeCfg(fake.port), callbacks: {} });
		await client.connectAuthed(10_000);
		expect(client.isAuthed()).toBe(true);
		expect(fake.received.filter((p) => p.type === AdminPacketType.AdminJoin)).toHaveLength(1);
		client.close();
		fake.close();
	});

	it("connectAuthed：超时后抛错并停止（不能无限重试）", async () => {
		const fake = new FakeAdminServer();
		fake.destroyFirst = 999; // 永远踢
		await fake.listen();
		const client = new AdminClient({ cfg: makeCfg(fake.port), callbacks: {} });
		await expect(client.connectAuthed(1_200)).rejects.toThrow();
		expect(client.isAuthed()).toBe(false);
		client.close();
		fake.close();
	});
});

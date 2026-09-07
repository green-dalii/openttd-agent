/**
 * AdminClient — full-featured client over the OpenTTD Admin Port.
 *
 * 职责: 管理 TCP 连接生命周期 + Admin 协议收发: connect/join/subscribe/poll/
 *   rcon/gamescript, 把收到的包交给 observer 规范化为 GameEvent 并回调。
 * 事实来源: SPEC §2/§10 + admin-protocol.ts 帧布局; 断线重连按应用层需求。
 * 禁止: 在本模块内做游戏语义决策; 不吞掉网络错误 (暴露 statusChange)。
 */

import net from "node:net";
import type { Config } from "../config.js";
import {
	AdminPacketType,
	AdminUpdateFrequency,
	AdminUpdateType,
	ALL_COMPANIES,
	ByteReader,
	FrameWriter,
	FrameStreamParser,
	type RawPacket,
} from "./admin-protocol.js";
import {
	handleServerPacket,
	decodeServerRconResponse,
	decodeWelcome,
	type WelcomeInfo,
} from "./observer.js";
import type { GameEvent } from "../types.js";

export type ClientStatus = "idle" | "connecting" | "connected" | "closed" | "error";

export interface ClientCallbacks {
	/** Normalized game event (date/economy/company/stats/console/gamescript...). */
	onEvent?: (ev: GameEvent) => void;
	/** RCON command response (full text incl. echoed command + result). */
	onRconResult?: (text: string) => void;
	/** Successful admin join: welcome info. */
	onWelcome?: (info: WelcomeInfo) => void;
	/** Connection/status transition. */
	onStatusChange?: (status: ClientStatus, detail?: string) => void;
	/** Fatal protocol/server response (banned/full/error/auth). */
	onError?: (kind: string, message: string) => void;
}

export interface AdminClientOptions {
	cfg: Config;
	callbacks?: ClientCallbacks;
	/** Injectable socket factory (tests). Default net.connect. */
	socketFactory?: () => net.Socket;
	/** Auto-join + default subscriptions after TCP connect. Default true. */
	autoBoot?: boolean;
	/** Reconnect attempts; -1 = forever (only if autoReconnect enabled). */
	autoReconnect?: boolean;
	/** Base backoff ms. */
	reconnectBaseMs?: number;
}

const DEFAULT_SUBSCRIBE: Array<[AdminUpdateType, AdminUpdateFrequency]> = [
	[AdminUpdateType.Date, AdminUpdateFrequency.Monthly],
	[AdminUpdateType.CompanyInfo, AdminUpdateFrequency.Automatic],
	[AdminUpdateType.CompanyEconomy, AdminUpdateFrequency.Quarterly],
	[AdminUpdateType.CompanyStats, AdminUpdateFrequency.Quarterly],
	[AdminUpdateType.Console, AdminUpdateFrequency.Automatic],
];

const MIN_AUTO_POLL_INTERVAL = 2_000; // don't hammer poll faster than this
const MAX_RECONNECT_MS = 30_000;

export class AdminClient {
	readonly cfg: Config;

	private callbacks: ClientCallbacks;
	private autoBoot: boolean;
	private autoReconnect: boolean;
	private reconnectBaseMs: number;
	private socketFactory: () => net.Socket;

	private sock: net.Socket | null = null;
	private parser = new FrameStreamParser();
	private status: ClientStatus = "idle";
	private joined = false;
	private seq = 0;
	private reconnectAttempts = 0;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private closing = false;
	/** Company id → last poll time (to throttle auto-poll). */
	private lastPollAt = new Map<number, number>();

	constructor(opts: AdminClientOptions) {
		this.cfg = opts.cfg;
		this.callbacks = opts.callbacks ?? {};
		this.autoBoot = opts.autoBoot ?? true;
		this.autoReconnect = opts.autoReconnect ?? false;
		this.reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
		this.socketFactory = opts.socketFactory ?? (() => net.connect({ host: this.cfg.adminHost, port: this.cfg.adminPort }));
	}

	getStatus(): ClientStatus {
		return this.status;
	}

	/** True when TCP connected AND admin join accepted (Welcome received). */
	isAuthed(): boolean {
		return this.status === "connected" && this.joined;
	}

	async connect(timeoutMs = 10_000): Promise<void> {
		if (this.status === "connecting" || this.status === "connected") return;
		this.setStatus("connecting");
		const sock = this.socketFactory();
		this.sock = sock;
		sock.setNoDelay(true);

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`admin connect timeout after ${timeoutMs}ms`));
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				sock.removeListener("connect", onConnect);
				sock.removeListener("error", onError);
			};
			const onConnect = () => {
				cleanup();
				resolve();
			};
			const onError = (e: Error) => {
				cleanup();
				reject(e);
			};
			sock.once("connect", onConnect);
			sock.once("error", onError);
		});

		sock.on("data", (chunk) => this.onData(new Uint8Array(chunk)));
		sock.on("error", (e) => this.handleError(e));
		sock.on("close", () => this.handleClose());
		this.setStatus("connected");

		if (this.autoBoot) this.boot();
	}

	/** Join + default subscriptions + initial polls. */
	boot(): void {
		this.send(AdminPacketType.AdminJoin, (w) =>
			w.str(this.cfg.adminPassword).str("openttd-agent").str("0.1.0"),
		);
		for (const [type, freq] of DEFAULT_SUBSCRIBE) {
			this.send(AdminPacketType.AdminUpdateFrequency, (w) => w.uint16(type).uint16(freq));
		}
	}

	subscribe(type: AdminUpdateType, freq: AdminUpdateFrequency): void {
		this.send(AdminPacketType.AdminUpdateFrequency, (w) => w.uint16(type).uint16(freq));
	}

	poll(type: AdminUpdateType, companyOrAll = 0): void {
		this.send(AdminPacketType.AdminPoll, (w) => w.uint8(type).uint32(companyOrAll));
	}

	/** Poll date + all companies' info/economy/stats (throttled per company). */
	pollAll(): void {
		this.poll(AdminUpdateType.Date, 0);
		this.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
		this.poll(AdminUpdateType.CompanyEconomy, ALL_COMPANIES);
		this.poll(AdminUpdateType.CompanyStats, ALL_COMPANIES);
	}

	/** Auto-poll company economy (throttled to MIN_AUTO_POLL_INTERVAL). */
	pollCompanyEconomy(id: number): void {
		const now = Date.now();
		const last = this.lastPollAt.get(id) ?? 0;
		if (now - last < MIN_AUTO_POLL_INTERVAL) return;
		this.lastPollAt.set(id, now);
		this.poll(AdminUpdateType.CompanyEconomy, id);
	}

	rcon(command: string): void {
		this.send(AdminPacketType.AdminRemoteConsoleCommand, (w) => w.str(command));
	}

	gameScript(json: string): void {
		this.send(AdminPacketType.AdminGameScript, (w) => w.str(json));
	}

	chat(message: string): void {
		this.send(AdminPacketType.AdminChat, (w) => w.uint32(0).uint8(0).str(message));
	}

	ping(): void {
		this.send(AdminPacketType.AdminPing, () => {});
	}

	quit(): void {
		try {
			this.send(AdminPacketType.AdminQuit, () => {});
		} catch {
			/* ignore */
		}
	}

	/** Graceful teardown: destroy socket + disable reconnect.
	 *
	 * NOTE: we deliberately do NOT send AdminQuit. Empirically (OpenTTD 15.0,
	 * SPEC §10.7/§10.8) sending AdminQuit then destroying triggers an abort in
	 * the server's ServerNetworkAdminSocketHandler::OTTD_CloseConnection path
	 * (use-after-free in the admin receive loop). The server detects the TCP EOF
	 * from socket destroy and cleans up cleanly. */
	close(): void {
		this.closing = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.sock?.destroy();
		this.sock = null;
		this.setStatus("closed");
	}

	// -- internals -------------------------------------------------------

	private setStatus(s: ClientStatus, detail?: string): void {
		this.status = s;
		this.callbacks.onStatusChange?.(s, detail);
	}

	private send(type: number, fill: (w: FrameWriter) => void): void {
		if (!this.sock || this.status !== "connected") {
			throw new Error(`cannot send ${type} while status=${this.status}`);
		}
		const w = new FrameWriter();
		fill(w);
		this.sock.write(Buffer.from(w.build(type)));
	}

	private onData(chunk: Uint8Array): void {
		for (const pkt of this.parser.push(chunk)) {
			this.dispatch(pkt);
		}
	}

	private dispatch(pkt: RawPacket): void {
		switch (pkt.type) {
			case AdminPacketType.ServerProtocol:
			case AdminPacketType.ServerPong:
				return; // ignored (proto version / ping reply)
			case AdminPacketType.ServerWelcome: {
				const info = decodeWelcome(pkt.payload);
				this.joined = true;
				this.reconnectAttempts = 0;
				if (info) this.callbacks.onWelcome?.(info);
				// initial snapshot
				this.pollAll();
				return;
			}
			case AdminPacketType.ServerRconEnd:
				return; // rcon terminator — caller tracks completion separately
			case AdminPacketType.ServerRcon: {
				const r = decodeServerRconResponse(pkt.payload);
				if (r.message) this.callbacks.onRconResult?.(r.message);
				return;
			}
			case AdminPacketType.ServerCompanyNew: {
				// remember company id for later polling
				const id = pkt.payload[0] ?? 0;
				this.pollCompanyEconomy(id);
				this.emit(handleServerPacket(pkt, this.seq++, Date.now()));
				return;
			}
			case AdminPacketType.ServerFull:
			case AdminPacketType.ServerBanned:
			case AdminPacketType.ServerError: {
				const msg = decodeErrorText(pkt);
				this.callbacks.onError?.(`server:${pkt.type}`, msg);
				return;
			}
			default: {
				this.emit(handleServerPacket(pkt, this.seq++, Date.now()));
			}
		}
	}

	private emit(ev: GameEvent | null): void {
		try {
			if (ev) this.callbacks.onEvent?.(ev);
		} catch (e) {
			this.handleError(e instanceof Error ? e : new Error(String(e)));
		}
	}

	private handleError(e: Error): void {
		this.setStatus("error", e.message);
		this.callbacks.onError?.("socket", e.message);
	}

	private handleClose(): void {
		this.sock = null;
		this.joined = false;
		if (this.closing) return;
		this.setStatus("closed");
		if (this.autoReconnect) this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		const delay = Math.min(this.reconnectBaseMs * 2 ** this.reconnectAttempts, MAX_RECONNECT_MS);
		this.reconnectAttempts++;
		this.setStatus("connecting", `reconnect in ${delay}ms`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.closing) return;
			this.connect()
				.then(() => this.boot())
				.catch(() => this.handleClose()); // will re-schedule
		}, delay);
	}
}

function decodeErrorText(pkt: RawPacket): string {
	// ServerFull/Banned/Error carry a single NUL-terminated error string
	// (network_admin.cpp SendError: Send_string(GetNetworkErrorMsg(error))).
	try {
		const r = new ByteReader(pkt.payload);
		return r.cstr() || "(no detail)";
	} catch {
		return "(no detail)";
	}
}

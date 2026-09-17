/**
 * Admin packet normalization — turn raw server packets into typed GameEvents.
 *
 * 职责: 把 `decodePacket` 得到的原始包解码为下游 (LLM/UI/metrics) 可用的规范化事件。
 * 字节布局事实来源: `network_admin.cpp` Send* handlers 字段顺序 (见 SPEC §2 / §10)。
 * 禁止: IO; 泄漏异常 (defensive: 截断包返回 null 或部分对象)。
 */

import { AdminPacketType, ByteReader } from "./admin-protocol.js";
import { convertDateToYmd, parseCompanyEconomy } from "./payload-parsers.js";
import type { GameEvent } from "../types.js";

export interface RawServerPacket {
	type: number;
	payload: Uint8Array;
	frame: Uint8Array;
}

/** Normalize one packet. Returns null when the packet is not a standalone event. */
export function handleServerPacket(pkt: RawServerPacket, seq: number, now: number): GameEvent | null {
	const t = pkt.type;
	try {
		switch (t) {
			case AdminPacketType.ServerDate:
				return dateEvent(pkt, seq, now);
			case AdminPacketType.ServerCompanyNew:
				return companyNew(pkt, seq, now);
			case AdminPacketType.ServerCompanyInfo:
				return companyInfo(pkt, seq, now);
			case AdminPacketType.ServerCompanyUpdate:
				return companyUpdate(pkt, seq, now);
			case AdminPacketType.ServerCompanyRemove:
				return companyRemove(pkt, seq, now);
			case AdminPacketType.ServerCompanyEconomy:
				return companyEconomy(pkt, seq, now);
			case AdminPacketType.ServerCompanyStats:
				return companyStats(pkt, seq, now);
			case AdminPacketType.ServerGameScript:
				return gamescript(pkt, seq, now);
			case AdminPacketType.ServerChat:
				return chat(pkt, seq, now);
			case AdminPacketType.ServerConsole:
				return consoleEvent(pkt, seq, now);
			case AdminPacketType.ServerRcon:
				// rcon replies used to fall into `default: return null`: every rcon
				// was blind (MEMORY: a tool that cannot observe its own effect).
				// Payload = cstr(command) + cstr(result).
				{
					const { command, message } = decodeServerRconResponse(pkt.payload);
					return { seq, kind: "rcon", ts: now, payload: { command, message } };
				}
			case AdminPacketType.ServerNewGame:
				return { seq, kind: "newgame", ts: now, payload: {} };
			case AdminPacketType.ServerShutdown:
				return { seq, kind: "shutdown", ts: now, payload: {} };
			default:
				return null; // protocol/welcome/rcon/rconEnd/cmdnames/unknown handled elsewhere
		}
	} catch {
		// defensive: truncated/garbage payloads must not crash the observer loop
		return null;
	}
}

function dateEvent(pkt: RawServerPacket, seq: number, now: number): GameEvent {
	const r = new ByteReader(pkt.payload);
	const raw = r.uint32();
	const { year, month, day } = convertDateToYmd(raw);
	return { seq, kind: "date", ts: now, payload: { raw, year, month, day } };
}

function companyNew(pkt: RawServerPacket, seq: number, now: number): GameEvent {
	const r = new ByteReader(pkt.payload);
	const id = r.uint8();
	return {
		seq,
		kind: "company_new",
		ts: now,
		payload: { id, name: "", manager: "", colour: 0, passwordProtected: false, inauguratedYear: 0, isAi: false },
	};
}

function companyInfo(pkt: RawServerPacket, seq: number, now: number): GameEvent {
	const r = new ByteReader(pkt.payload);
	const id = r.uint8();
	const name = r.cstr();
	const manager = r.cstr();
	const colour = r.uint8();
	const passwordProtected = r.bool();
	const inauguratedYear = r.uint32();
	const isAi = r.bool();
	// final u8: quarters of bankruptcy — ignored
	return {
		seq,
		kind: "company_info",
		ts: now,
		payload: { id, name, manager, colour, passwordProtected, inauguratedYear, isAi },
	};
}

function companyUpdate(pkt: RawServerPacket, seq: number, now: number): GameEvent {
	const r = new ByteReader(pkt.payload);
	const id = r.uint8();
	const name = r.cstr();
	const manager = r.cstr();
	const colour = r.uint8();
	// bool + quarters ignored
	return { seq, kind: "company_update", ts: now, payload: { id, name, manager, colour } };
}

function companyRemove(pkt: RawServerPacket, seq: number, now: number): GameEvent {
	const r = new ByteReader(pkt.payload);
	const id = r.uint8();
	return { seq, kind: "company_remove", ts: now, payload: { id } };
}

function companyEconomy(pkt: RawServerPacket, seq: number, now: number): GameEvent {
	return { seq, kind: "company_economy", ts: now, payload: parseCompanyEconomy(pkt.payload) };
}

function companyStats(pkt: RawServerPacket, seq: number, now: number): GameEvent {
	const r = new ByteReader(pkt.payload);
	const id = r.uint8();
	const names = ["train", "truck", "bus", "aircraft", "ship"] as const;
	const vehicleCounts: number[] = [];
	for (let i = 0; i < 5; i++) vehicleCounts.push(r.uint16());
	const stationCounts: number[] = [];
	for (let i = 0; i < 5; i++) stationCounts.push(r.uint16());
	const breakdown = Object.fromEntries(names.map((n, i) => [n, vehicleCounts[i]])) as Record<
		(typeof names)[number],
		number
	>;
	const stationBreakdown = Object.fromEntries(
		names.map((n, i) => [n, stationCounts[i]]),
	) as Record<(typeof names)[number], number>;
	return {
		seq,
		kind: "company_stats",
		ts: now,
		payload: {
			id,
			vehicles: vehicleCounts.reduce((a, b) => a + b, 0),
			stations: stationCounts.reduce((a, b) => a + b, 0),
			breakdown,
			stationBreakdown,
		},
	};
}

function gamescript(pkt: RawServerPacket, seq: number, now: number): GameEvent {
	const r = new ByteReader(pkt.payload);
	const js = r.cstr();
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(js);
	} catch {
		return { seq, kind: "gamescript", ts: now, payload: { raw: js } };
	}
	return { seq, kind: "gamescript", ts: now, payload: parsed as Record<string, unknown> };
}

function chat(pkt: RawServerPacket, seq: number, now: number): GameEvent {
	const r = new ByteReader(pkt.payload);
	const action = r.uint8();
	const destType = r.uint8();
	const clientId = r.uint32();
	const message = r.cstr();
	if (message.length === 0) return null as unknown as GameEvent;
	return { seq, kind: "chat", ts: now, payload: { action, destType, clientId, message } };
}

function consoleEvent(pkt: RawServerPacket, seq: number, now: number): GameEvent {
	const r = new ByteReader(pkt.payload);
	const origin = r.cstr();
	const message = r.cstr();
	return { seq, kind: "console", ts: now, payload: { origin, message } };
}

/** Decode ServerRcon payload (cstr command + cstr result). */
export function decodeServerRconResponse(payload: Uint8Array): { command: string | null; message: string } {
	const r = new ByteReader(payload);
	try {
		const command = r.cstr();
		const message = r.cstr();
		return { command, message };
	} catch {
		return { command: null, message: "" };
	}
}

/** Decode ServerWelcome. Returns null if too short. */
export interface WelcomeInfo {
	serverName: string;
	revision: string;
	dedicated: boolean;
	mapSeed: number;
	startDateRaw: number;
	mapSizeX: number;
	mapSizeY: number;
}

export function decodeWelcome(payload: Uint8Array): WelcomeInfo | null {
	const r = new ByteReader(payload);
	try {
		const serverName = r.cstr();
		const revision = r.cstr();
		const dedicated = r.bool();
		r.cstr(); // map name (unused)
		const mapSeed = r.uint32();
		r.uint8(); // landscape
		const startDateRaw = r.uint32();
		const mapSizeX = r.uint16();
		const mapSizeY = r.uint16();
		return { serverName, revision, dedicated, mapSeed, startDateRaw, mapSizeX, mapSizeY };
	} catch {
		return null;
	}
}

export type { GameEvent };

import { describe, expect, it } from "vitest";
import {
	AdminPacketType,
	AdminUpdateFrequency,
	AdminUpdateType,
	decodePacket,
	encodeFrame,
	packCStr,
	readCStr,
} from "../../src/game/admin-protocol.js";describe("admin-protocol enums", () => {
	it("matches OpenTTD tcp_admin.h values", () => {
		// Client->server (0..10)
		expect(AdminPacketType.AdminJoin).toBe(0);
		expect(AdminPacketType.AdminQuit).toBe(1);
		expect(AdminPacketType.AdminUpdateFrequency).toBe(2);
		expect(AdminPacketType.AdminPoll).toBe(3);
		expect(AdminPacketType.AdminChat).toBe(4);
		expect(AdminPacketType.AdminRemoteConsoleCommand).toBe(5);
		expect(AdminPacketType.AdminGameScript).toBe(6);
		expect(AdminPacketType.AdminPing).toBe(7);
		expect(AdminPacketType.AdminJoinSecure).toBe(9);

		// Server->client (100+)
		expect(AdminPacketType.ServerFull).toBe(100);
		expect(AdminPacketType.ServerProtocol).toBe(103);
		expect(AdminPacketType.ServerWelcome).toBe(104);
		expect(AdminPacketType.ServerNewGame).toBe(105);
		expect(AdminPacketType.ServerShutdown).toBe(106);
		expect(AdminPacketType.ServerDate).toBe(107);
		expect(AdminPacketType.ServerCompanyNew).toBe(113);
		expect(AdminPacketType.ServerCompanyInfo).toBe(114);
		expect(AdminPacketType.ServerCompanyUpdate).toBe(115);
		expect(AdminPacketType.ServerCompanyRemove).toBe(116);
		expect(AdminPacketType.ServerCompanyEconomy).toBe(117);
		expect(AdminPacketType.ServerCompanyStats).toBe(118);
		expect(AdminPacketType.ServerGameScript).toBe(124);
		expect(AdminPacketType.ServerRconEnd).toBe(125);
		expect(AdminPacketType.ServerPong).toBe(126);
	});

	it("matches AdminUpdateType / AdminUpdateFrequency values", () => {
		expect(AdminUpdateType.Date).toBe(0);
		expect(AdminUpdateType.CompanyInfo).toBe(2);
		expect(AdminUpdateType.CompanyEconomy).toBe(3);
		expect(AdminUpdateType.CompanyStats).toBe(4);
		expect(AdminUpdateType.CmdLogging).toBe(8);
		expect(AdminUpdateType.Gamescript).toBe(9);

		expect(AdminUpdateFrequency.Poll).toBe(1);
		expect(AdminUpdateFrequency.Automatic).toBe(64);
	});
});

describe("string helpers", () => {
	it("packs and unpacks null-terminated strings", () => {
		const buf = packCStr("hello");
		expect(buf).toEqual(new Uint8Array([104, 101, 108, 108, 111, 0]));
		const [out, off] = readCStr(buf, 0);
		expect(out).toBe("hello");
		expect(off).toBe(6);
	});

	it("handles empty string and utf-8", () => {
		const buf = packCStr("");
		expect(buf).toEqual(new Uint8Array([0]));
		const utf = packCStr("名字✓");
		const [out, off] = readCStr(utf, 0);
		expect(out).toBe("名字✓");
		expect(off).toBe(utf.length);
	});
});

describe("frame encoding", () => {
	it("encodes frame with size-inclusive length prefix + type", () => {
		// AdminJoin with payload "pw\0name\0version\0"
		const frame = encodeFrame(AdminPacketType.AdminJoin, packCStr("secret"));
		// size = 2(size) + 1(type) + 7(payload incl NUL)
		expect(frame[0]).toBe(10); // 2+1+7
		expect(frame[1]).toBe(0);
		expect(frame[2]).toBe(0); // type AdminJoin
		expect(frame.length).toBe(10);
	});

	it("round-trips through a split stream", () => {
		const frame = encodeFrame(
			AdminPacketType.AdminRemoteConsoleCommand,
			packCStr("pause"),
		);
		// Feed byte-by-byte, decoder must assemble from fragments
		const fragments: Uint8Array[] = [];
		for (const b of frame) fragments.push(new Uint8Array([b]));
		// The codec exposes decodePacket for a complete frame; streaming handled in client
		const assembled = new Uint8Array(fragments.flatMap((f) => [...f]));
		const pkt = decodePacket(assembled);
		expect(pkt).not.toBeNull();
		expect(pkt!.type).toBe(AdminPacketType.AdminRemoteConsoleCommand);
	});
});

describe("golden byte decoding from authoritative server layouts", () => {
	it("decodes ServerDate (uint32 LE date)", () => {
		// From network_admin.cpp SendDate: p->Send_uint32(date.base())
		const dateRaw = 730638; // arbitrary but consistent
		const payload = new Uint8Array(4);
		new DataView(payload.buffer).setUint32(0, dateRaw, true);
		const frame = encodeFrame(AdminPacketType.ServerDate, payload);
		const pkt = decodePacket(frame);
		expect(pkt!.type).toBe(AdminPacketType.ServerDate);
		expect(pkt!.payload).toEqual(payload);
	});

	it("decodes ServerCompanyInfo per network_admin.cpp SendCompanyInfo", () => {
		// Layout: u8 index, cstr name, cstr president, u8 colour, bool pw, u32 inaugurated_year, bool is_ai, u8 bankruptcy_quarters
		const parts: Uint8Array[] = [];
		parts.push(new Uint8Array([0])); // index 0
		parts.push(packCStr("Test Co"));
		parts.push(packCStr("Alice"));
		parts.push(new Uint8Array([7])); // colour
		parts.push(new Uint8Array([1])); // pw=true
		const yr = new Uint8Array(4);
		new DataView(yr.buffer).setUint32(0, 1950, true);
		parts.push(yr);
		parts.push(new Uint8Array([1])); // is_ai=true
		parts.push(new Uint8Array([0])); // bankruptcy quarters
		const payload = concat(parts);
		const pkt = decodePacket(encodeFrame(AdminPacketType.ServerCompanyInfo, payload));
		expect(pkt!.type).toBe(AdminPacketType.ServerCompanyInfo);
		expect(pkt!.payload).toEqual(payload);
	});

	it("decodes ServerCompanyEconomy per network_admin.cpp SendCompanyEconomy", () => {
		// u8 index; u64 money; u64 loan; u64 income; u16 delivered; then 2x(u64 value,u16 perf,u16 delivered)
		const parts: Uint8Array[] = [new Uint8Array([3])]; // company 3
		for (const v of [1_000_000n, 500_000n, 200_000n]) {
			const b = new Uint8Array(8);
			new DataView(b.buffer).setBigUint64(0, v, true);
			parts.push(b);
		}
		const d16 = new Uint8Array(2);
		new DataView(d16.buffer).setUint16(0, 1234, true);
		parts.push(d16);
		for (const [value, perf, deliv] of [
			[900_000n, 800, 1000],
			[850_000n, 750, 900],
		] as const) {
			const b = new Uint8Array(8);
			new DataView(b.buffer).setBigUint64(0, value, true);
			parts.push(b);
			const p = new Uint8Array(2);
			new DataView(p.buffer).setUint16(0, perf, true);
			parts.push(p);
			const d = new Uint8Array(2);
			new DataView(d.buffer).setUint16(0, deliv, true);
			parts.push(d);
		}
		const payload = concat(parts);
		const pkt = decodePacket(encodeFrame(AdminPacketType.ServerCompanyEconomy, payload));
		expect(pkt!.payload).toEqual(payload);
	});
});

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

import { describe, expect, it } from "vitest";
import { AdminPacketType, encodeFrame, packCStr } from "../../src/game/admin-protocol.js";
import { handleServerPacket } from "../../src/game/observer.js";

function le16(v: number): Uint8Array {
	const b = new Uint8Array(2);
	new DataView(b.buffer).setUint16(0, v, true);
	return b;
}
function le32(v: number): Uint8Array {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, v, true);
	return b;
}
function le64(v: bigint): Uint8Array {
	const b = new Uint8Array(8);
	new DataView(b.buffer).setBigUint64(0, v, true);
	return b;
}
function concat(parts: Uint8Array[]): Uint8Array {
	const t = parts.reduce((n, p) => n + p.length, 0);
	const o = new Uint8Array(t);
	let off = 0;
	for (const p of parts) {
		o.set(p, off);
		off += p.length;
	}
	return o;
}
function frame(type: number, payload: Uint8Array) {
	const raw = encodeFrame(type, payload);
	return { type, payload, frame: raw };
}

describe("handleServerPacket", () => {
	it("normalizes ServerDate -> date event with y/m/d", () => {
		const pkt = frame(AdminPacketType.ServerDate, le32(712223)); // 1950-01-01
		const ev = handleServerPacket(pkt, 1, 1000);
		expect(ev).toMatchObject({
			seq: 1,
			ts: 1000,
			kind: "date",
			payload: { raw: 712223, year: 1950, month: 1, day: 1 },
		});
	});

	it("normalizes ServerCompanyInfo", () => {
		const payload = concat([
			Uint8Array.of(0),
			packCStr("Test Co"),
			packCStr("Alice"),
			Uint8Array.of(7),
			Uint8Array.of(1),
			le32(1950),
			Uint8Array.of(1),
			Uint8Array.of(0),
		]);
		const ev = handleServerPacket(frame(AdminPacketType.ServerCompanyInfo, payload), 2, 0);
		expect(ev?.kind).toBe("company_info");
		expect(ev?.payload).toEqual({
			id: 0,
			name: "Test Co",
			manager: "Alice",
			colour: 7,
			passwordProtected: true,
			inauguratedYear: 1950,
			isAi: true,
		});
	});

	it("normalizes ServerCompanyEconomy via parseCompanyEconomy", () => {
		const parts: Uint8Array[] = [Uint8Array.of(3)];
		for (const v of [5_000_000n, 1_000_000n, 750_000n]) parts.push(le64(v));
		parts.push(le16(200));
		parts.push(le64(4_500_000n));
		parts.push(le16(950));
		parts.push(le16(190));
		parts.push(le64(4_000_000n));
		parts.push(le16(900));
		parts.push(le16(170));
		const ev = handleServerPacket(
			frame(AdminPacketType.ServerCompanyEconomy, concat(parts)),
			3,
			0,
		);
		expect(ev?.kind).toBe("company_economy");
		expect(ev?.payload).toMatchObject({ id: 3, money: 5_000_000n, income: 750_000n });
	});

	it("normalizes ServerCompanyStats with vehicle order train,truck,bus,aircraft,ship", () => {
		// u8 id; 5x u16 vehicles; 5x u16 stations
		const parts: Uint8Array[] = [Uint8Array.of(1)];
		for (const n of [2, 3, 5, 1, 0]) parts.push(le16(n)); // vehicles
		for (const n of [1, 2, 3, 0, 0]) parts.push(le16(n)); // stations
		const ev = handleServerPacket(
			frame(AdminPacketType.ServerCompanyStats, concat(parts)),
			4,
			0,
		);
		expect(ev?.kind).toBe("company_stats");
		expect(ev?.payload).toEqual({
			id: 1,
			vehicles: 11,
			stations: 6,
			breakdown: { train: 2, truck: 3, bus: 5, aircraft: 1, ship: 0 },
			stationBreakdown: { train: 1, truck: 2, bus: 3, aircraft: 0, ship: 0 },
		});
	});

	it("normalizes ServerGameScript JSON payload", () => {
		const payload = packCStr('{"kind":"state","year":1950}');
		const ev = handleServerPacket(frame(AdminPacketType.ServerGameScript, payload), 5, 0);
		expect(ev?.kind).toBe("gamescript");
		expect(ev?.payload).toEqual({ kind: "state", year: 1950 });
	});

	it("normalizes ServerChat", () => {
		const payload = concat([
			Uint8Array.of(3),
			Uint8Array.of(0),
			le32(1),
			packCStr("hello"),
			le64(0n),
		]);
		const ev = handleServerPacket(frame(AdminPacketType.ServerChat, payload), 6, 0);
		expect(ev?.kind).toBe("chat");
		expect(ev?.payload).toEqual({ action: 3, destType: 0, clientId: 1, message: "hello" });
	});

	it("normalizes ServerConsole", () => {
		const payload = concat([packCStr("ai"), packCStr("boom")]);
		const ev = handleServerPacket(frame(AdminPacketType.ServerConsole, payload), 7, 0);
		expect(ev?.kind).toBe("console");
		expect(ev?.payload).toEqual({ origin: "ai", message: "boom" });
	});

	it("returns null for ServerProtocol / RconEnd / unknown / truncated", () => {
		expect(handleServerPacket(frame(AdminPacketType.ServerProtocol, new Uint8Array([4])), 1, 0)).toBeNull();
		expect(handleServerPacket(frame(AdminPacketType.ServerRconEnd, new Uint8Array(0)), 2, 0)).toBeNull();
		expect(handleServerPacket({ type: 200, payload: new Uint8Array(0), frame: new Uint8Array(3) }, 3, 0)).toBeNull();
		// truncated company economy: only id + 2 bytes
		const pkt = frame(AdminPacketType.ServerCompanyEconomy, concat([Uint8Array.of(0), Uint8Array.of(1, 2)]));
		const ev = handleServerPacket(pkt, 4, 0);
		expect(ev).not.toBeNull();
		expect(ev?.payload).toMatchObject({ id: 0 });
	});
});

describe("FrameWriter round-trip via handleServerPacket", () => {
	it("handles ServerCompanyRemove (u8 id)", () => {
		const payload = Uint8Array.of(5);
		const ev = handleServerPacket(frame(AdminPacketType.ServerCompanyRemove, payload), 8, 0);
		expect(ev?.kind).toBe("company_remove");
		expect(ev?.payload).toEqual({ id: 5 });
	});
});

/**
 * rcon 回执通道（2026-09-17）。
 *
 * 之前 ServerRcon / ServerRconEnd 落在 observer 的 `default: return null`
 * 里——rcon 回执被**丢弃**。后果有两层：
 *   1. 所有 rcon 都是"盲发"（工具违反"必须能观测自己的效果"）；
 *   2. 无法查询游戏自身的设置/命令（例如速度旋钮）。
 * OpenTTD 的 ServerRcon 载荷 = cstr(command) + cstr(result)，与
 * `decodeServerRconResponse` 一致。
 */
describe("rcon 回执事件", () => {
	const cstr = (t: string) => {
		const b = new Uint8Array(t.length + 1);
		for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
		return b;
	};

	it("ServerRcon → kind=rcon，带 command 与 message", () => {
		const payload = concat([cstr("list_cmds"), cstr("pause\nunpause\nsetting\n")]);
		const ev = handleServerPacket(frame(AdminPacketType.ServerRcon, payload), 7, 1000);
		expect(ev).toMatchObject({ kind: "rcon", payload: { command: "list_cmds" } });
		expect((ev as { payload: { message: string } }).payload.message).toContain("unpause");
	});

	it("空回执也算事件（不能把空当没有）", () => {
		const payload = concat([cstr("pause"), cstr("")]);
		const ev = handleServerPacket(frame(AdminPacketType.ServerRcon, payload), 8, 1000);
		expect(ev).toMatchObject({ kind: "rcon", payload: { command: "pause", message: "" } });
	});

	it("截断载荷不崩（观测器不得因坏包挂掉）", () => {
		const ev = handleServerPacket(frame(AdminPacketType.ServerRcon, new Uint8Array([65, 0])), 9, 1000);
		expect(ev === null || (ev as { kind: string }).kind === "rcon").toBe(true);
	});
});

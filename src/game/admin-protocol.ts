/**
 * Admin Port wire protocol — types, enums, frame codec.
 *
 * 职责: Admin Port (OpenTTD `-D` dedicated) 的字节级编解码 + 常量。
 * 事实来源: `src/network/core/tcp_admin.h` + `network_admin.cpp` + `packet.cpp`
 *   (OpenTTD master, 兼容 15.x)。所有值已由单测 golden 锁定。
 * 禁止: 不在此模块发起 IO / 连接；不猜测未知包（忽略 forward-compat）。
 */

/* ------------------------------------------------------------------ *
 * Packet types (tcp_admin.h `enum class PacketAdminType : uint8_t`)
 * ------------------------------------------------------------------ */

export const enum AdminPacketType {
	// Client -> Server
	AdminJoin = 0,
	AdminQuit = 1,
	AdminUpdateFrequency = 2,
	AdminPoll = 3,
	AdminChat = 4,
	AdminRemoteConsoleCommand = 5,
	AdminGameScript = 6,
	AdminPing = 7,
	AdminExternalChat = 8,
	AdminJoinSecure = 9,
	AdminAuthenticationResponse = 10,

	// Server -> Client
	ServerFull = 100,
	ServerBanned = 101,
	ServerError = 102,
	ServerProtocol = 103,
	ServerWelcome = 104,
	ServerNewGame = 105,
	ServerShutdown = 106,
	ServerDate = 107,
	ServerClientJoin = 108,
	ServerClientInfo = 109,
	ServerClientUpdate = 110,
	ServerClientQuit = 111,
	ServerClientError = 112,
	ServerCompanyNew = 113,
	ServerCompanyInfo = 114,
	ServerCompanyUpdate = 115,
	ServerCompanyRemove = 116,
	ServerCompanyEconomy = 117,
	ServerCompanyStats = 118,
	ServerChat = 119,
	ServerRcon = 120,
	ServerConsole = 121,
	ServerCmdNames = 122,
	ServerCmdLoggingOld = 123,
	ServerGameScript = 124,
	ServerRconEnd = 125,
	ServerPong = 126,
	ServerCmdLogging = 127,
	ServerAuthRequest = 128,
	ServerEnableEncryption = 129,
}

/** Update types (tcp_admin.h `enum class AdminUpdateType : uint8_t`). */
export const enum AdminUpdateType {
	Date = 0,
	ClientInfo = 1,
	CompanyInfo = 2,
	CompanyEconomy = 3,
	CompanyStats = 4,
	Chat = 5,
	Console = 6,
	CmdNames = 7,
	CmdLogging = 8,
	Gamescript = 9,
	End = 10,
}

/**
 * Update frequencies (tcp_admin.h `enum class AdminUpdateFrequency : uint8_t`).
 * Used as a bitmask in the ServerProtocol advertisement; send a single bit value.
 */
export const enum AdminUpdateFrequency {
	Poll = 1,
	Daily = 2,
	Weekly = 4,
	Monthly = 8,
	Quarterly = 16,
	Annually = 32,
	Automatic = 64,
}

/** UINT32_MAX marker: poll/subscribe "all companies/clients". */
export const ALL_COMPANIES = 0xffff_ffff;
export const ALL_CLIENTS = 0xffff_ffff;

/** Max poll id for a company/client. */
export const NETWORK_ADMIN_UPDATE_TYPE_INVALID = 0xff;

/** Current admin protocol version (SendProtocol). */
export const NETWORK_GAME_ADMIN_VERSION = 4;

/* ------------------------------------------------------------------ *
 * Frame layout (packet.cpp):
 *   uint16 LE size   — inclusive of the 2 size bytes + 1 type byte + payload
 *   uint8  type
 *   payload...
 * Strings are UTF-8, NUL-terminated (Send_string appends '\0').
 * Integers little-endian fixed width; bool = 1 byte.
 * ------------------------------------------------------------------ */

export const FRAME_SIZE_BYTES = 2;
export const FRAME_TYPE_BYTES = 1;
export const MIN_FRAME_BYTES = FRAME_SIZE_BYTES + FRAME_TYPE_BYTES;

/** A fully assembled raw frame (incl. size+type header). */
export interface RawPacket {
	type: number;
	/** Payload bytes (everything after the type byte). */
	payload: Uint8Array;
	/** Full frame (size prefix + type + payload). */
	frame: Uint8Array;
}

/** Builder for outgoing frames. */
export class FrameWriter {
	private readonly parts: Uint8Array[] = [];
	private size = 0;

	uint8(v: number): this {
		this.pushByte(v & 0xff);
		return this;
	}

	bool(v: boolean): this {
		return this.uint8(v ? 1 : 0);
	}

	uint16(v: number): this {
		this.pushByte(v & 0xff);
		this.pushByte((v >>> 8) & 0xff);
		return this;
	}

	uint32(v: number): this {
		this.pushByte(v & 0xff);
		this.pushByte((v >>> 8) & 0xff);
		this.pushByte((v >>> 16) & 0xff);
		this.pushByte((v >>> 24) & 0xff);
		return this;
	}

	uint64(v: bigint): this {
		for (let i = 0; i < 8; i++) {
			this.pushByte(Number(v & 0xffn));
			v >>= 8n;
		}
		return this;
	}

	/** Null-terminated UTF-8 string. */
	str(s: string): this {
		this.push(packCStr(s));
		return this;
	}

	/** Raw payload bytes (e.g. pre-built). */
	raw(bytes: Uint8Array): this {
		this.parts.push(bytes);
		this.size += bytes.length;
		return this;
	}

	/** Build the frame: [size u16 LE][type u8][payload]. */
	build(type: number): Uint8Array {
		const payloadLen = this.size;
		const frameLen = MIN_FRAME_BYTES + payloadLen;
		if (frameLen > 0xffff) {
			throw new Error(`frame too large: ${frameLen} bytes`);
		}
		const out = new Uint8Array(frameLen);
		out[0] = frameLen & 0xff;
		out[1] = (frameLen >>> 8) & 0xff;
		out[2] = type & 0xff;
		let off = MIN_FRAME_BYTES;
		for (const p of this.parts) {
			out.set(p, off);
			off += p.length;
		}
		return out;
	}

	private pushByte(b: number): void {
		this.parts.push(Uint8Array.of(b));
		this.size += 1;
	}

	private push(bytes: Uint8Array): void {
		this.parts.push(bytes);
		this.size += bytes.length;
	}
}

/** Encode a frame from a raw payload. */
export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
	return new FrameWriter().raw(payload).build(type);
}

/** Decode one complete frame (must be ≥ MIN_FRAME_BYTES, size field consistent). */
export function decodePacket(frame: Uint8Array): RawPacket | null {
	if (frame.length < MIN_FRAME_BYTES) return null;
	const size = frame[0]! | (frame[1]! << 8);
	if (size !== frame.length) return null;
	return {
		type: frame[2]!,
		payload: frame.subarray(MIN_FRAME_BYTES),
		frame,
	};
}

/**
 * Incremental frame parser over a byte stream.
 * Feed chunks via `push`; complete frames arrive on the callback.
 */
export class FrameStreamParser {
	private buf: Uint8Array = new Uint8Array(0);

	/** @returns any complete frames decoded from the chunk (may be empty). */
	push(chunk: Uint8Array): RawPacket[] {
		const merged = new Uint8Array(this.buf.length + chunk.length);
		merged.set(this.buf, 0);
		merged.set(chunk, this.buf.length);
		this.buf = merged;

		const out: RawPacket[] = [];
		for (;;) {
			if (this.buf.length < MIN_FRAME_BYTES) break;
			const size = this.buf[0]! | (this.buf[1]! << 8);
			if (size < MIN_FRAME_BYTES || size > this.buf.length) break;
			const frame = this.buf.subarray(0, size);
			const pkt = decodePacket(frame);
			if (pkt) out.push(pkt);
			this.buf = this.buf.subarray(size);
		}
		// Keep remaining bytes only (re-buffer without copy cost concern; subarray view)
		if (this.buf.length === 0) this.buf = new Uint8Array(0);
		return out;
	}
}

/* ------------------------------------------------------------------ *
 * Byte reader for payloads
 * ------------------------------------------------------------------ */

/** Sequential little-endian reader over a payload. */
export class ByteReader {
	private off = 0;
	constructor(readonly buf: Uint8Array) {}

	/** Remaining bytes available. */
	get remaining(): number {
		return this.buf.length - this.off;
	}

	uint8(): number {
		if (this.off >= this.buf.length) throw new RangeError("read past end");
		return this.buf[this.off++]!;
	}

	bool(): boolean {
		return this.uint8() !== 0;
	}

	uint16(): number {
		this.need(2);
		const v = this.buf[this.off]! | (this.buf[this.off + 1]! << 8);
		this.off += 2;
		return v;
	}

	uint32(): number {
		this.need(4);
		const v =
			this.buf[this.off]! |
			(this.buf[this.off + 1]! << 8) |
			(this.buf[this.off + 2]! << 16) |
			(this.buf[this.off + 3]! << 24);
		this.off += 4;
		return v >>> 0;
	}

	uint64(): bigint {
		this.need(8);
		let v = 0n;
		for (let i = 7; i >= 0; i--) {
			v = (v << 8n) | BigInt(this.buf[this.off + i]!);
		}
		this.off += 8;
		return v;
	}

	/**
	 * Read a **signed** 64-bit value (two's complement).
	 *
	 * OpenTTD's `Money` is int64 and `Send_uint64` merely serializes its 8 bytes,
	 * so money/loan/income/company-value must be read as signed: a losing company
	 * otherwise reads as ~1.8e19 (SPEC §10.6).
	 */
	int64(): bigint {
		return BigInt.asIntN(64, this.uint64());
	}

	/** Read a NUL-terminated UTF-8 string. */
	cstr(): string {
		const start = this.off;
		while (this.off < this.buf.length && this.buf[this.off] !== 0) this.off++;
		if (this.off >= this.buf.length) throw new RangeError("unterminated string");
		const s = new TextDecoder().decode(this.buf.subarray(start, this.off));
		this.off += 1; // skip NUL
		return s;
	}

	/** Read remaining raw bytes. */
	rest(): Uint8Array {
		const out = this.buf.subarray(this.off);
		this.off = this.buf.length;
		return out;
	}

	private need(n: number): void {
		if (this.off + n > this.buf.length) throw new RangeError("read past end");
	}
}

/* ------------------------------------------------------------------ *
 * String helpers
 * ------------------------------------------------------------------ */

/** Encode a string as NUL-terminated UTF-8 bytes. */
export function packCStr(s: string): Uint8Array {
	const bytes = new TextEncoder().encode(s);
	const out = new Uint8Array(bytes.length + 1);
	out.set(bytes, 0);
	return out;
}

/**
 * Read a NUL-terminated string from a buffer at `off`.
 * @returns [string, nextOffset]
 */
export function readCStr(buf: Uint8Array, off: number): [string, number] {
	let end = off;
	while (end < buf.length && buf[end] !== 0) end++;
	const s = new TextDecoder().decode(buf.subarray(off, end));
	return [s, end + 1];
}

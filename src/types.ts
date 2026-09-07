/**
 * Shared event/type definitions — single source of truth.
 *
 * 职责: 定义跨模块共享的规范化类型（协议事件、游戏事件、蓝图）。
 * 禁止: 不在此模块外重复声明同名类型; 不混入 IO/副作用。
 */

/** Monotonic event sequence number. */
export type EventSeq = number;

/** Normalized game date. */
export interface GameDate {
	/** Raw OpenTTD date (days since 0-01-01). */
	raw: number;
	year: number;
	month: number; // 1..12
	day: number; // 1..31
}

export interface CompanySnapshot {
	id: number;
	name: string;
	manager: string;
	/** Colour ID byte. */
	colour: number;
	passwordProtected: boolean;
	/** Inaugurated game year. */
	inauguratedYear: number;
	isAi: boolean;
	shareholders?: number[];
}

export interface CompanyEconomy {
	id: number;
	money: bigint;
	loan: bigint;
	income: bigint;
	deliveredCargo?: number;
	companyValue?: bigint;
	performanceLastYear?: number;
	performancePrevYear?: number;
}

export interface VehicleBreakdown {
	train: number;
	lorry: number;
	bus: number;
	plane: number;
	ship: number;
}

export interface CompanyStats {
	id: number;
	vehicles: number;
	stations: number;
	breakdown: VehicleBreakdown;
}

/** Kind of normalized event emitted by the observer. */
export type GameEventKind =
	| "connected"
	| "disconnected"
	| "date"
	| "company_info"
	| "company_new"
	| "company_update"
	| "company_economy"
	| "company_stats"
	| "company_remove"
	| "console"
	| "chat"
	| "gamescript"
	| "newgame"
	| "shutdown";

/** A normalized, structured event from the OpenTTD world. */
export interface GameEvent {
	seq: EventSeq;
	kind: GameEventKind;
	ts: number; // epoch ms
	payload: unknown;
}

/**
 * A high-level action the LLM/runner wants the game to perform.
 * This is the cross-boundary action envelope (v0.1: blueprint family only).
 */
export type HighLevelAction =
	| { type: "blueprint"; blueprint: Blueprint }
	| { type: "rcon"; command: string }
	| { type: "pause" }
	| { type: "unpause" };

/** A build blueprint handed to the Bridge GS (mirrors arena grammar). */
export interface Blueprint {
	/** Job id in 0..999, unique per in-world blueprint. */
	job: number;
	/** [tile, roadFrontTile] pairs for stations A and B. */
	stations: [[number, number], [number, number]];
	/** Ordered road tile sequence between the fronts. */
	path: number[];
	/** [tile, front] for the depot. */
	depot: [number, number];
	/** Engine id; -1 = executor picks. */
	engine: number;
}

/** JSON envelope sent over the Admin GameScript channel. */
export interface GsAdminCommand {
	cmd: string;
	[key: string]: unknown;
}

export interface GsBlueprintCommand extends GsAdminCommand {
	cmd: "blueprint";
	job: number;
	stations: [[number, number], [number, number]];
	path: number[];
	depot: [number, number];
	engine: number;
}

/**
 * Blueprint command encode/decode for the Admin -> GameScript channel.
 *
 * 职责: 高层施工动作 (Blueprint) 与发送给 Bridge GS 的 JSON 命令之间的
 *   双向转换 + 校验。纯函数。
 * 事实来源: arena `blueprint.py` 语法 (NUTZ 标牌; job 0..999; path ≤200;
 *   station/depot = [tile, front])。
 * 禁止: IO; 猜测游戏内布局。
 */

import type { Blueprint, GsBlueprintCommand, GsAdminCommand } from "../types.js";

export class BlueprintError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BlueprintError";
	}
}

const MAX_JOB = 999;
const MAX_PATH_TILES = 200;

/** Validate a blueprint, returning a list of human-readable problems ([] = ok). */
export function validateBlueprint(bp: Blueprint): string[] {
	const problems: string[] = [];
	if (!Number.isInteger(bp.job) || bp.job < 0 || bp.job > MAX_JOB) {
		problems.push(`job must be integer in 0..${MAX_JOB}, got ${bp.job}`);
	}
	const checkPair = (label: string, p: [number, number]) => {
		if (!Array.isArray(p) || p.length !== 2) {
			problems.push(`${label} must be a [tile, front] pair`);
			return;
		}
		const [tile, front] = p;
		if (!Number.isInteger(tile) || tile < 0) problems.push(`${label}.tile must be >= 0`);
		if (!Number.isInteger(front) || front < 0) problems.push(`${label}.front must be >= 0`);
	};
	checkPair("stations[0]", bp.stations?.[0]);
	checkPair("stations[1]", bp.stations?.[1]);
	checkPair("depot", bp.depot);
	if (!Array.isArray(bp.path) || bp.path.length === 0) {
		problems.push("path must be non-empty");
	} else if (bp.path.length > MAX_PATH_TILES) {
		problems.push(`path too long (${bp.path.length} > ${MAX_PATH_TILES})`);
	} else {
		for (const t of bp.path) {
			if (!Number.isInteger(t) || t < 0) {
				problems.push("path contains a non-integer / negative tile");
				break;
			}
		}
	}
	if (!Number.isInteger(bp.engine)) problems.push("engine must be an integer (-1 = auto)");
	return problems;
}

function assertValid(bp: Blueprint): void {
	const problems = validateBlueprint(bp);
	if (problems.length > 0) throw new BlueprintError(problems.join("; "));
}

/** Build the {cmd:"blueprint", ...} admin->GS command object. */
export function buildBlueprintCommand(bp: Blueprint): GsBlueprintCommand {
	assertValid(bp);
	return { cmd: "blueprint", job: bp.job, stations: bp.stations, path: bp.path, depot: bp.depot, engine: bp.engine };
}

/** Compact JSON for the blueprint command (sent over AdminGameScript). */
export function blueprintToGsJson(bp: Blueprint): string {
	return JSON.stringify(buildBlueprintCommand(bp));
}

/** Parse + validate a received blueprint JSON command. */
export function parseBlueprintCommand(jsonStr: string): GsBlueprintCommand {
	let obj: unknown;
	try {
		obj = JSON.parse(jsonStr);
	} catch (e) {
		throw new BlueprintError(`invalid JSON: ${(e as Error).message}`);
	}
	if (typeof obj !== "object" || obj === null) throw new BlueprintError("not an object");
	const o = obj as Record<string, unknown>;
	if (o.cmd !== "blueprint") throw new BlueprintError('cmd must be "blueprint"');
	if (typeof o.job !== "number") throw new BlueprintError("job missing");
	if (!Array.isArray(o.stations) || o.stations.length !== 2) throw new BlueprintError("stations must be [a,b]");
	if (!Array.isArray(o.path)) throw new BlueprintError("path missing");
	if (!Array.isArray(o.depot) || o.depot.length !== 2) throw new BlueprintError("depot must be [tile,front]");
	if (typeof o.engine !== "number") throw new BlueprintError("engine missing");
	const bp: Blueprint = {
		job: o.job as number,
		stations: [o.stations[0] as [number, number], o.stations[1] as [number, number]],
		path: o.path as number[],
		depot: o.depot as [number, number],
		engine: o.engine as number,
	};
	assertValid(bp);
	return { cmd: "blueprint", ...bp };
}

/** Generic admin->GS JSON envelope serializer. */
export function encodeGsAdminCommand(cmd: GsAdminCommand): string {
	return JSON.stringify(cmd);
}

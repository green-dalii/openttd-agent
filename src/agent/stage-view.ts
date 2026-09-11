/**
 * Stage view — a map diagram derived from world data, not a screenshot.
 *
 * 职责: 把某一时刻的世界数据（公司、施工阶段、GS ack 的坐标）压成一份**可渲染的
 *   几何描述**，供前端画出示意图；每到一个施工阶段存一份，形成"阶段性画面"。
 * 为什么不是截图: OpenTTD **dedicated server 没有帧缓冲**，rcon `screenshot`
 *   实测返回 `Screenshot failed!`。像素级截图需要带窗口的客户端，属架构变更
 *   （docs/AGENT-LOOP-AND-CONTROL.md §4）。本模块给出诚实的替代：
 *   用真实坐标画的示意图。
 * 事实来源: docs/AGENT-LOOP-AND-CONTROL.md §4；tile 编码见 SPEC §2 / OpenTTD TileIndex。
 * 禁止:
 *   - 声称这是游戏截图（前端必须标注"示意图"）。
 *   - 产生 NaN 坐标（前端 canvas 会画到屏幕外）；坏数据一律丢弃。
 */

/** One drawn marker, in normalised map coordinates (0..1). */
export interface StageMarker {
	kind: "town" | "depot" | "station" | "vehicle";
	x: number;
	y: number;
	label: string;
	/** Relative importance (town population, fleet size) for sizing. */
	size?: number;
}

/** A line between two normalised points. */
export interface StageRoute {
	from: { x: number; y: number };
	to: { x: number; y: number };
	label: string;
}

export interface StageCompany {
	id: number;
	name: string;
	money: number;
	vehicles: number;
	stations: number;
}

/** Raw GS ack payload describing the built route (see main.nut "ack"). */
export interface StageRouteInput {
	tileA?: unknown;
	tileB?: unknown;
	frontA?: unknown;
	frontB?: unknown;
	depot?: unknown;
	townA?: unknown;
	townB?: unknown;
	popA?: unknown;
	popB?: unknown;
}

export interface StageViewInput {
	gameDate: string;
	mapSize: [number, number];
	companies: { id: number; name?: string | null; money?: unknown; vehicles?: unknown; stations?: unknown }[];
	route?: StageRouteInput | null;
	phase?: string;
}

export interface StageView {
	gameDate: string;
	width: number;
	height: number;
	phase?: string;
	companies: StageCompany[];
	markers: StageMarker[];
	routes: StageRoute[];
}

/** OpenTTD tile index -> map coordinates (tile = y * width + x). */
export function tileToXY(tile: number, mapWidth: number): { x: number; y: number } {
	const w = mapWidth > 0 ? mapWidth : 1;
	return { x: tile % w, y: Math.floor(tile / w) };
}

function num(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function normalise(
	tile: unknown,
	mapSize: [number, number],
): { x: number; y: number } | null {
	const t = num(tile);
	if (t === null || t < 0) return null;
	const [w, h] = mapSize;
	if (!(w > 0) || !(h > 0)) return null;
	const { x, y } = tileToXY(t, w);
	return { x: x / w, y: y / h };
}

/**
 * Build the renderable description for one moment.
 *
 * Pure: no IO, no rendering, no assumptions about the canvas.
 */
export function buildStageView(input: StageViewInput): StageView {
	const [w, h] = input.mapSize;
	const companies: StageCompany[] = (input.companies ?? []).map((c, i) => ({
		id: num(c.id) ?? i,
		name: c.name ?? `Company ${c.id ?? i}`,
		money: num(c.money) ?? 0,
		vehicles: num(c.vehicles) ?? 0,
		stations: num(c.stations) ?? 0,
	}));

	const markers: StageMarker[] = [];
	const routes: StageRoute[] = [];

	const r = input.route;
	if (r) {
		const towns: { tile: unknown; pop: unknown; id: unknown }[] = [
			{ tile: r.tileA, pop: r.popA, id: r.townA },
			{ tile: r.tileB, pop: r.popB, id: r.townB },
		];
		const pops = towns.map((t) => num(t.pop) ?? 0);
		const maxPop = Math.max(1, ...pops);
		towns.forEach((t, i) => {
			const p = normalise(t.tile, input.mapSize);
			if (!p) return;
			markers.push({
				kind: "town",
				x: p.x,
				y: p.y,
				label: String(num(t.id) ?? "?"),
				size: pops[i]! / maxPop,
			});
		});
		const depot = normalise(r.depot, input.mapSize);
		if (depot) markers.push({ kind: "depot", x: depot.x, y: depot.y, label: "depot" });

		const a = normalise(r.tileA, input.mapSize);
		const b = normalise(r.tileB, input.mapSize);
		if (a && b) {
			routes.push({
				from: a,
				to: b,
				label: `${num(r.townA) ?? "?"} ↔ ${num(r.townB) ?? "?"}`,
			});
		}
	}

	return {
		gameDate: input.gameDate,
		width: w,
		height: h,
		...(input.phase ? { phase: input.phase } : {}),
		companies,
		markers,
		routes,
	};
}

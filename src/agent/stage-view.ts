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

/**
 * The region worth looking at, as a normalised centre plus a zoom factor.
 *
 * 为什么需要（2026-09-12 实测）: `screenshot minimap` 对 256×256 地图输出
 * 256×256 的 PNG —— **1 像素/格**。一次施工只改几格，图上因此只差 1-2 个像素，
 * 于是"每个阶段的画面看起来一样"（实测 6 次抓取仅 3 张不同，且游戏日期全是
 * 1950-01-01）。这不是抓取频率问题，而是分辨率问题，所以由服务端给出窗口、
 * 前端裁剪放大，让改动可见。
 */
export interface StageFocus {
	/** Window centre, normalised to the map (0..1). */
	x: number;
	y: number;
	/** How much to magnify: the window spans 1/scale of the map. */
	scale: number;
}

export interface StageView {
	gameDate: string;
	width: number;
	height: number;
	phase?: string;
	companies: StageCompany[];
	markers: StageMarker[];
	routes: StageRoute[];
	/**
	 * Absent when there is nothing to look at (no markers/routes), in which case
	 * the whole map is the honest view.
	 */
	focus?: StageFocus;
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
/** Zoom limits: 1 = whole map, 12 = ~21 tiles across on a 256 map. */
const MIN_FOCUS_SCALE = 1;
const MAX_FOCUS_SCALE = 12;
/** Never crop tighter than a window that shows some context around the work. */
const MIN_WINDOW_SPAN = 0.06;

/**
 * Pick the window that makes this stage's work visible.
 *
 * Bounds come from the markers and route endpoints (all normalised), padded so
 * the work never touches the frame edge. Returns undefined when there is nothing
 * to frame. Pure.
 */
function computeFocus(markers: StageMarker[], routes: StageRoute[]): StageFocus | undefined {
	const xs: number[] = [];
	const ys: number[] = [];
	for (const m of markers) {
		if (Number.isFinite(m.x) && Number.isFinite(m.y)) {
			xs.push(m.x);
			ys.push(m.y);
		}
	}
	for (const r of routes) {
		for (const p of [r.from, r.to]) {
			if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
				xs.push(p.x);
				ys.push(p.y);
			}
		}
	}
	if (!xs.length || !ys.length) return undefined;

	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);

	// Pad by 60% of the span so the work sits in context, and never go tighter
	// than MIN_WINDOW_SPAN (a single-tile span would otherwise zoom to the max).
	const spanX = Math.max(maxX - minX, MIN_WINDOW_SPAN);
	const spanY = Math.max(maxY - minY, MIN_WINDOW_SPAN);
	const span = Math.max(spanX, spanY) * 1.6;

	const scale = Math.max(
		MIN_FOCUS_SCALE,
		Math.min(MAX_FOCUS_SCALE, 1 / span),
	);
	// Centre on the work, then clamp so the window stays inside the map.
	const half = 1 / (2 * scale);
	const cx = Math.min(Math.max((minX + maxX) / 2, half), 1 - half);
	const cy = Math.min(Math.max((minY + maxY) / 2, half), 1 - half);
	return {
		x: Math.round(cx * 10000) / 10000,
		y: Math.round(cy * 10000) / 10000,
		scale: Math.round(scale * 100) / 100,
	};
}

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

	const focus = computeFocus(markers, routes);
	return {
		gameDate: input.gameDate,
		width: w,
		height: h,
		...(input.phase ? { phase: input.phase } : {}),
		companies,
		markers,
		routes,
		...(focus ? { focus } : {}),
	};
}

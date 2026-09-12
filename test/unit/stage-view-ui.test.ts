/**
 * Unit tests — stage view rendering helpers.
 *
 * 职责: 锁定"放大到施工窗口"的坐标数学，以及叠加标记的过滤。
 *   这是纯计算，因此可以在没有浏览器的情况下完整验证（见
 *   docs/FRONTEND-DEPENDENCIES-AUDIT.md 的分层原则）。
 *
 * 背景（2026-09-12 实测）: 256×256 地图的小地图是 256×256 像素 = 1 像素/格，
 *   一次施工只差 1-2 像素，导致"每个阶段的画面看起来一样"。
 *   放大到施工窗口是修复；这里的数学一旦错位，图就会指错地方。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/stage-view-ui.js"), "utf8");

interface StageUi {
	bgPosition: (p: number, scale: number) => number;
	inWindow: (p: number, centre: number, scale: number) => number;
	backdropStyle: (url: string, focus: { x: number; y: number; scale: number }) => string;
	overlayMarks: (view: unknown) => { kind: string; [k: string]: unknown }[];
	overlaySvg: (view?: unknown) => string;
	// Marks are split so each Alpine x-for sees a flat, single-rooted list
	// (MEMORY.md B2). Kept here so the page cannot silently lose the split.
	routesOf: (marks?: unknown) => { kind: string; [k: string]: unknown }[];
	pointsOf: (marks?: unknown) => { kind: string; [k: string]: unknown }[];
	pointClass: (m?: unknown) => string;
	pointRadius: (m?: unknown) => number;
	LEGEND: { ours: unknown[]; base: unknown[] };
}

function api(): StageUi {
	const sandbox: Record<string, unknown> = { console, Number, Math, Object, Array, String };
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	return (sandbox.window as { StageViewUI: StageUi }).StageViewUI;
}

describe("stage view UI", () => {
	describe("centring maths", () => {
		it("centres the focus point when zoomed", () => {
			const s = api();
			// A point at the centre must land at 50% for any zoom.
			for (const z of [1, 2, 4, 8, 12]) {
				expect(s.bgPosition(0.5, z), `scale ${z}`).toBeCloseTo(50, 6);
			}
		});

		it("keeps the map edge in view at maximum zoom", () => {
			// Zoomed 8x on the top-left, the window covers 1/8 of the map, so the
			// top-left corner must sit at the element's edge, not off it.
			const s = api();
			const z = 8;
			// At 8x the window covers 1/8 of the map, so the smallest centre the
			// server will emit is 1/16 (it clamps the window inside the map).
			// The map edge then lands exactly on the element edge.
			expect(s.inWindow(0, 1 / 16, z)).toBeCloseTo(0, 6);
			expect(s.inWindow(1 / 8, 1 / 16, z)).toBeCloseTo(100, 6);
			// bgPosition for that centre puts the image's left edge at the centre.
			// q = (0.5 - p*z)/(1 - z); q*(W - z*W) = W/2 when p=0.
			expect(s.bgPosition(0, z)).toBeCloseTo((-0.5 / 7) * 100, 4);
		});

		it("round-trips: a map point and its window position agree", () => {
			// inWindow is the inverse of the crop, so a point that bgPosition puts
			// at the centre must read back as 50%.
			const s = api();
			for (const [p, z] of [[0.2, 4], [0.75, 3], [0.5, 6]] as const) {
				expect(s.inWindow(p, p, z), `p=${p} z=${z}`).toBeCloseTo(50, 6);
			}
		});

		it("degenerates to plain centring at scale 1", () => {
			const s = api();
			expect(s.bgPosition(0.3, 1)).toBe(50);
			expect(s.bgPosition(0.9, 1)).toBe(50);
		});

		it("never produces NaN for missing focus data", () => {
			const s = api();
			const style = s.backdropStyle("/x.png", undefined as never);
			expect(style).not.toContain("NaN");
			expect(style).toContain("background-size:100.00%");
		});
	});

	describe("backdrop style", () => {
		it("embeds the image URL and the zoom", () => {
			const s = api();
			const style = s.backdropStyle("/api/sessions/a/stages/001.png", { x: 0.5, y: 0.5, scale: 4 });
			expect(style).toContain("/api/sessions/a/stages/001.png");
			expect(style).toContain("background-size:400.00%");
		});

		it("escapes quotes so a crafted filename cannot break out of url()", () => {
			const s = api();
			expect(s.backdropStyle('/a".png', { x: 0.5, y: 0.5, scale: 1 })).not.toContain('"/a".png"');
		});
	});

	describe("overlay marks", () => {
		const view = {
			focus: { x: 0.5, y: 0.5, scale: 4 },
			routes: [{ from: { x: 0.45, y: 0.45 }, to: { x: 0.55, y: 0.55 }, label: "A ↔ B" }],
			markers: [
				{ kind: "town", x: 0.45, y: 0.45, label: "17" },
				{ kind: "depot", x: 0.55, y: 0.55, label: "depot" },
			],
		};

		it("converts each route into window coordinates", () => {
			const s = api();
			const marks = s.overlayMarks(view);
			const route = marks.find((m) => m.kind === "route")!;
			// 0.45 in a 4x window centred on 0.5 -> (0.45-0.5)*4+0.5 = 0.3 -> 30%
			expect(route.x1).toBeCloseTo(30, 6);
			expect(route.x2).toBeCloseTo(70, 6);
		});

		it("drops marks that fall outside the window", () => {
			// A town far from the work must not be drawn at a misleading edge position.
			const s = api();
			const marks = s.overlayMarks({
				...view,
				markers: [...view.markers, { kind: "town", x: 0.01, y: 0.01, label: "far" }],
			});
			expect(marks.filter((m) => m.kind === "town")).toHaveLength(1);
		});

		it("survives an empty or malformed view", () => {
			const s = api();
			expect(() => s.overlayMarks(undefined)).not.toThrow();
			expect(s.overlayMarks(undefined)).toEqual([]);
			expect(
				s.overlayMarks({ markers: [null, { kind: "town", x: "nope" }], routes: [null] }),
			).toEqual([]);
		});

		it("keeps the label so the overlay is readable", () => {
			const s = api();
			const town = s.overlayMarks(view).find((m) => m.kind === "town")!;
			expect(town.label).toBe("17");
		});
	});

	describe("legend", () => {
		it("separates what we draw from the game's own base-map colours", () => {
			// The distinction matters: we can vouch for our overlay, not for
			// OpenTTD's internal minimap palette.
			const s = api();
			expect(s.LEGEND.ours.length).toBeGreaterThan(0);
			expect(s.LEGEND.base.length).toBeGreaterThan(0);
		});

		it("documents the water/land colours measured from real captures", () => {
			const s = api();
			const labels = (s.LEGEND.base as { label: string }[]).map((b) => b.label).join(" ");
			expect(labels).toMatch(/water/i);
			expect(labels).toMatch(/land/i);
		});
	});

	describe("mark splitting (Alpine x-for contract)", () => {
		// Alpine's x-for allows exactly ONE root element per template. Branching
		// with <template x-if> inside one x-for puts two siblings in the template,
		// which breaks Alpine's traversal. Split the marks instead.
		const marks = [
			{ kind: "route", x1: 1, y1: 2, x2: 3, y2: 4 },
			{ kind: "town", x: 5, y: 6 },
			{ kind: "depot", x: 7, y: 8 },
		];

		it("routesOf keeps only routes", () => {
			const s = api();
			const r = s.routesOf(marks) as { kind: string }[];
			expect(r).toHaveLength(1);
			expect(r[0]!.kind).toBe("route");
		});

		it("pointsOf keeps everything that is not a route", () => {
			const s = api();
			const r = s.pointsOf(marks) as { kind: string }[];
			expect(r.map((m) => m.kind)).toEqual(["town", "depot"]);
		});

		it("the two halves partition the input (nothing lost, nothing duplicated)", () => {
			const s = api();
			const r = s.routesOf(marks).length;
			const p = s.pointsOf(marks).length;
			expect(r + p).toBe(marks.length);
		});

		it("tolerates undefined/empty input", () => {
			const s = api();
			expect(s.routesOf(undefined)).toEqual([]);
			expect(s.pointsOf(undefined)).toEqual([]);
			expect(s.routesOf([])).toEqual([]);
		});

		it("skips null entries instead of throwing", () => {
			const s = api();
			expect((s.pointsOf([null, { kind: "town", x: 1, y: 1 }]) as unknown[]).length).toBe(1);
		});

		it("pointClass maps kinds to the classes the CSS defines", () => {
			const s = api();
			expect(s.pointClass({ kind: "town" })).toBe("ov-town");
			expect(s.pointClass({ kind: "depot" })).toBe("ov-depot");
			expect(s.pointClass({ kind: "other" })).toBe("ov-other");
			expect(s.pointClass(null)).toBe("ov-other");
		});

		it("pointRadius makes towns bigger than depots", () => {
			const s = api();
			expect(s.pointRadius({ kind: "town" })).toBeGreaterThan(s.pointRadius({ kind: "depot" }));
		});
	});

	describe("overlaySvg (why marks are string-built, not templated)", () => {
		// A <template> inside <svg> is SVG-namespaced with no `.content`, so Alpine's
		// x-for throws "reading 'children'" and the loop var never binds. Measured in
		// Chrome: { ns: 'SVG', isHTMLTemplate: false, contentDefined: false }.
		// So the marks are generated as a string and injected with x-html.
		// Coordinates are normalized 0..1 world positions; inWindow() maps them to
		// window percentages: ((p - centre) * scale + 0.5) * 100.
		const view = {
			focus: { x: 0.5, y: 0.5, scale: 1 },
			routes: [{ label: "A-B", from: { x: 0.2, y: 0.2 }, to: { x: 0.6, y: 0.6 } }],
			markers: [
				{ kind: "town", label: "T", x: 0.4, y: 0.4 },
				{ kind: "depot", label: "D", x: 0.45, y: 0.45 },
			],
		};

		it("emits a single well-formed <svg> with <line> and <circle>", () => {
			const svg = api().overlaySvg(view);
			expect(svg.startsWith("<svg ")).toBe(true);
			expect(svg.endsWith("</svg>")).toBe(true);
			expect(svg).toContain("<line class=\"ov-route\"");
			expect(svg).toContain("<circle class=\"ov-town\"");
			expect(svg).toContain("<circle class=\"ov-depot\"");
			// no template element may ever appear in the injected markup
			expect(svg).not.toContain("<template");
		});

		it("carries viewBox/preserveAspectRatio so it scales over the cropped image", () => {
			const svg = api().overlaySvg(view);
			expect(svg).toContain('viewBox="0 0 100 100"');
			expect(svg).toContain('preserveAspectRatio="none"');
		});

		it("returns empty string when there is nothing to draw", () => {
			expect(api().overlaySvg({ focus: { x: 0.5, y: 0.5, scale: 1 } })).toBe("");
			expect(api().overlaySvg(undefined)).toBe("");
			expect(api().overlaySvg({ routes: [], markers: [] })).toBe("");
		});

		it("never emits NaN into a coordinate attribute", () => {
			const svg = api().overlaySvg({
				focus: { x: 0.5, y: 0.5, scale: 1 },
				markers: [
					{ kind: "town", x: 0.33, y: 0.66 },
					{ kind: "town", x: Number.NaN, y: 0.1 },
					{ kind: "town", x: 0.4, y: Number.POSITIVE_INFINITY },
				],
			});
			expect(svg).not.toContain("NaN");
			expect(svg).not.toContain("Infinity");
			// the two unusable markers are dropped, only the valid one remains
			expect((svg.match(/<circle/g) || []).length).toBe(1);
		});

		it("markup carries no user-controlled text (labels never reach the SVG)", () => {
			// The aria-label is built from counts only, so hostile labels cannot be
			// injected. This is why there is no escaping bug to have here.
			const svg = api().overlaySvg({
				focus: { x: 0.5, y: 0.5, scale: 1 },
				routes: [{ label: 'x"><script>alert(1)</script>', from: { x: 0.4, y: 0.4 }, to: { x: 0.6, y: 0.6 } }],
			});
			expect(svg).not.toContain("<script>");
			expect(svg).not.toContain("alert(1)");
			expect(svg).toContain('aria-label="overlay: 1 route(s), 0 marker(s)"');
		});

		it("omits routes whose endpoints are outside the window", () => {
			const svg = api().overlaySvg({
				focus: { x: 0.05, y: 0.05, scale: 1 },
				routes: [{ from: { x: 0.95, y: 0.95 }, to: { x: 0.99, y: 0.99 } }],
			});
			expect(svg).toBe("");
		});
	});
});

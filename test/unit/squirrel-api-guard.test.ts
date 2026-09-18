/**
 * Guard: the Squirrel packs must not call Game Script API that does not exist.
 *
 * Why a static test: the packs only execute inside OpenTTD, so a bad API name
 * cannot fail a unit test - it fails on the real machine, and it fails
 * *partially*: `{"cmd":"route_stats","detail":{"reason":"the index 'X' does not
 * exist"},"kind":"err"}` comes back for that one request while every other
 * request keeps working. That is the worst failure shape: the channel degrades
 * per-run instead of dying.
 *
 * Evidence for the first entry (SPEC §10.66): `GSStation.IsStationTile` was
 * called inside the radius-scan fallback of `StationNear`, so it only ran when
 * the executor had shifted a site. Every one of the 17 runs in /tmp/ab900 and
 * /tmp/cal900 hit it (1145 occurrences), with wildly different severity - one
 * run got 240 route-stats replies, another got 20 (and delivered nothing). The
 * comparisons from those rounds were therefore measuring a broken channel.
 *
 * Rule: an entry may only be added here when the error was seen on the wire.
 * Do not add "probably wrong" names - the list is evidence, not opinion.
 */
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKS = ["src/game/squirrel/bridge-gs", "src/game/squirrel/executor-ai"];

/** API references observed to be invalid at runtime, with the observed reason. */
const KNOWN_BAD_CALLS = [
	{
		call: "GSStation.IsStationTile",
		reason: "the index 'IsStationTile' does not exist",
		use: "GSStation.GetStationID(tile) + GSStation.IsValidStation(id) - the predicate lives on GSTile, not GSStation",
	},
];

function packFiles(): string[] {
	return PACKS.flatMap((p) => globSync(`${p}/**/*.nut`)).sort();
}

/**
 * Strip comments before scanning. The comments in the packs *name* the bad API
 * on purpose (that is how the next reader learns why the call is gone), so a
 * raw substring search would forbid documenting the trap it exists to prevent.
 */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("Squirrel packs: no calls to API that does not exist", () => {
	it("finds the pack sources (the guard would be vacuous otherwise)", () => {
		const files = packFiles();
		expect(files.length).toBeGreaterThan(0);
		expect(files.some((f) => f.endsWith("bridge-gs/main.nut"))).toBe(true);
	});

	it.each(KNOWN_BAD_CALLS)("does not call $call ($reason)", ({ call }) => {
		const offenders = packFiles().filter((f) => stripComments(readFileSync(f, "utf8")).includes(call));
		expect(offenders, `${call} does not exist in the GS API; use the documented alternative`).toEqual([]);
	});

	it("keeps the station lookup that the radius scan needs", () => {
		// Deleting the scan would also silence the error - and would silently
		// report "no vehicles" for every route whose site the executor shifted.
		const src = readFileSync(path.join("src/game/squirrel/bridge-gs/main.nut"), "utf8");
		expect(src).toContain("function StationNear(");
		expect(src).toContain("GSStation.GetStationID(cand)");
		expect(src).toContain("GSStation.IsValidStation(cs)");
	});
});

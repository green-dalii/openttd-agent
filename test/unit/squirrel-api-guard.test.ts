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

/**
 * M3-1b：车队请求必须在**任何阶段**都被尝试应用（2026-09-19，SPEC §10.81/§10.84）。
 *
 * 真机证伪（§10.81）：`CheckAddVehicles()` 只挂在
 * `} else if (this._stage == "done" && this._vehicle >= 0) {`，而一局的大部分时间
 * 执行器在施工（`road`），实测中它发完缩编请求后**再没回到过 `done`** → 请求永不生效，
 * 而工具只会说"请求已发出"，于是模型学到"请求车队没用"（D20 同源）。
 *
 * 为什么用静态断言：Squirrel 只在 OpenTTD 里跑，单测跑不到它；但"调用点是否被阶段门控"
 * 恰恰是**源码结构**就能钉住的事实——这正是本次返工的根因形态，所以值得守卫。
 */
describe("Squirrel 执行器：车队请求的调用点不得被阶段门控", () => {
	const src = stripComments(readFileSync(path.join("src/game/squirrel/executor-ai/main.nut"), "utf8"));

	it("TickInner 在非 done 阶段也会尝试（节流），而不是只在 done", () => {
		// 有节流的尝试：形如 `this._loopSeq % N == 0` 且其分支里调用 CheckAddVehicles
		expect(src).toMatch(/TickInner[\s\S]*?%\s*\d+\s*==\s*0[\s\S]{0,200}?CheckAddVehicles\(\)/);
	});

	it("调用不再要求 `_vehicle >= 0`（否则无头车时静默消失）", () => {
		const gated = /_stage == "done" && this\._vehicle >= 0[\s\S]{0,80}?CheckAddVehicles\(\)/.test(src);
		expect(gated, "`_vehicle >= 0` 作为调用前置条件会让请求在无车时被静默丢弃").toBe(false);
	});

	it("不能应用时必须有**具名**理由（静默 = 模型必然学错因果）", () => {
		for (const phase of ["fleet_noveh", "fleet_nodepot", "fleet_wait"]) {
			expect(src, `缺少具名拒绝/推迟相位：${phase}`).toContain(`"${phase}"`);
		}
	});
});

/**
 * `foreach` 在 **array** 上的双变量形式是 (下标, 值)，不是 (值, 忽略)。
 *
 * 语法权威（Squirrel 参考手册，2026-09-19 核对）：
 *   `'foreach' '(' [index_id ','] value_id 'in' exp ')' stat`
 * 也就是说 `foreach (v, _ in arr)` 里的 `v` 是**下标**。
 *
 * 实测代价（SPEC §10.84）：`_fleetOwned` 是 array，却被写成双变量并当下标为车辆 id 用，
 * 于是①"数车队"数的是"id 等于 0..N-1 的车是否存在"、②`SellVehicle(v)` 卖的是
 * **与线路无关的 id**、③"永不卖头车"的守卫拿下标与车辆 id 比较，**从未生效**。
 * 真机表现：请求 12 → 车队 3→15（是"再克隆 12"，不是"设为 12"）；请求 4 → 相位说
 * `fleet4` 而公司车队始终 15（一辆都没少）。
 *
 * 本仓库对 array 一律用**单变量**形式（`foreach (d in dirs)`），双变量只用于
 * list/table（`foreach (sid, _ in AISignList())`）。这条守卫把该约定钉死。
 */
describe("Squirrel packs: array 上的 foreach 不得使用双变量形式", () => {
	/** 已知是普通 array 的字段名（`[]` 字面量初始化 / `.append(` 赋值）。 */
	const ARRAY_FIELDS = ["_fleetOwned", "_doneJobs", "_builtRoad", "_roadCur", "keep", "dirs", "towns", "vlist"];

	it.each(ARRAY_FIELDS)("不对 array %s 使用 foreach (x, y in …)", (field) => {
		const offenders = packFiles().filter((f) => {
			const src = stripComments(readFileSync(f, "utf8"));
			return new RegExp(`foreach\\s*\\(\\s*\\w+\\s*,\\s*\\w+\\s+in\\s+[^)]*${field}`).test(src);
		});
		expect(offenders, `${field} 是 array：双变量 foreach 的第一个变量是下标，请用单变量`).toEqual([]);
	});

	it("车队会计用单变量形式（值），并包含头车", () => {
		const src = stripComments(readFileSync(path.join("src/game/squirrel/executor-ai/main.nut"), "utf8"));
		expect(src).toContain("foreach (vid in this._fleetOwned)");
		// 头车必须计入本线路车队，否则 `V:N` 永远比真实车队少 1
		expect(src).toMatch(/this\._fleetOwned\.append\(v\)/);
	});
});

/**
 * 缩编必须先"送回车库"再卖（SPEC §10.84）。
 *
 * 权威依据（OpenTTD `src/vehicle_cmd.cpp:261`）：
 *   `if (!front->IsStoppedInDepot()) return CommandCost(STR_ERROR_*_MUST_BE_STOPPED_INSIDE_DEPOT…)`
 * 真机证据（`/tmp/m31e`，相位 `fleets12L12s0f11C14`）：对正在跑的克隆车当场
 * `SellVehicle`，11 次全部被拒绝，车队一辆没少。所以"缩编"只能是一个多轮动作。
 */
describe("Squirrel 执行器：缩编必须先送回车库", () => {
	const src = stripComments(readFileSync(path.join("src/game/squirrel/executor-ai/main.nut"), "utf8"));

	it("卖出前使用 SendVehicleToDepot，并用 IsStoppedInDepot 判断时机", () => {
		expect(src).toContain("AIVehicle.SendVehicleToDepot(vid)");
		expect(src).toContain("AIVehicle.IsStoppedInDepot(vid)");
	});

	it("卖车是个跨 tick 的过程，不是当场循环（否则必然静默失败）", () => {
		expect(src).toContain("function ProcessFleetSells()");
		// 必须在 TickInner 里每轮推进（否则待卖的车永远等不到下一次检查）
		expect(src).toMatch(/TickInner\(\)[\s\S]*?this\.ProcessFleetSells\(\);/);
	});

	it("待卖列表在换 job 时被清空（否则会去卖上一份工作的车）", () => {
		expect(src).toMatch(/_fleetApplied = -1;[\s\S]{0,200}?_fleetSell = \[\];/);
	});
});

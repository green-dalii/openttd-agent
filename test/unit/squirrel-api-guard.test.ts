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
/** Blank out string literals so identifier scans cannot match keys/words inside them. */
function stripStrings(src: string): string {
	return src.replace(/"(?:\\.|[^"\\])*"/g, '""');
}

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

/**
 * M3-2a：**每线路登记表** + **退役**（SPEC §10.86）。
 *
 * 现状（本轮复审）：`_fleetOwned` / `_vehicle` 在切 job 时被重置，所以执行器
 * **不记得旧线路的车队**——于是①`V:` 请求一旦针对旧 job 就被 `fleet_otherjob` 拒绝、
 * ②"关掉一条正在亏钱的旧线路"这件事**根本做不到**（真实场景恰恰是先建的线要收摊）。
 * 这与 D34 同型：能力看着有，实际到不了可达状态。
 *
 * Squirrel 只在 OpenTTD 里跑，但"有没有按线路记住车队"是**源码结构**就能钉住的事实。
 */
describe("Squirrel 执行器：按线路登记 + 退役", () => {
	const src = stripComments(readFileSync(path.join("src/game/squirrel/executor-ai/main.nut"), "utf8"));

	it("存在按 job 键控的线路登记表（而不是只有当前 job 的字段）", () => {
		// Squirrel 用 `<-` 新建槽位、`=` 覆盖已有槽位，两者都算
		expect(src).toMatch(/this\._routes\[(this\._job|job)\]\s*(<-|=)/);
		expect(src).toContain("_routes");
	});

	it("切 job 时把当前线路存进登记表（否则旧线路的车队丢失）", () => {
		// 顺序是「先登记再重置」（否则旧线路的车队会先被清空）：
		expect(src).toMatch(/this\._routes\[this\._job\] <- \{[\s\S]{0,400}?this\._job = next;/);
	});

	it("退役必须能卖掉**头车**（普通缩编的下限 1 对退役不适用）", () => {
		// 退役路径里不能只复用"跳过头车"的缩编逻辑
		expect(src).toMatch(/function RetireRoute/);
		expect(src).toMatch(/RetireRoute[\s\S]{0,800}?SendVehicleToDepot/);
	});

	it("退役只接受**已知**线路（未知 job 必须具名拒绝，不能静默）", () => {
		expect(src).toMatch(/retire_unknown/);
	});

	it("退役后该 job 的标牌被清除（否则会被 FindNextJob 再次捡起来重建）", () => {
		expect(src).toMatch(/RetireRoute[\s\S]{0,1200}?retired/);
	});
});

/**
 * array 上不能调 **table 方法**（`rawin` / `len` 之外的表操作）。
 *
 * 真机证据（`/tmp/m32`，相位 `EX exc:the index 'rawin' does n…`）：
 * 我把 `_retiredJobs` 当 table 用（`.rawin(job)`），却把它初始化成 array `[]`，
 * 于是每一轮 `TickInner` 都抛异常——**车照样被卖掉了（8→2），但退役/卖出的相位
 * 一条都没发出来**。也就是说：动作生效了、信号却全丢了，harness 只能看到"莫名少了几辆车"。
 *
 * 这正是 D28 的机械版：**披露必须真的能发出来**。守卫在这里的价值是：
 * 这类错误在 Squirrel 里只有运行时才炸，而炸掉的是**汇报**，不是动作本身。
 */
describe("Squirrel packs: 一个标识符不能既当 array 又当 table 用", () => {
	/**
	 * 判据是**用法矛盾**，不是声明：
	 *   `.append(` / `.push(` 只有在 array 上才对；`.rawin(` / `.rawdelete(` / `.rawget(`
	 *   只有在 table 上才对。同一个标识符两者都用过 = 运行时必炸。
	 *
	 * 为什么不能只查声明（第一版就是这么写的，**实测抓不到回归**）：我把 `_retiredJobs`
	 * 从 `[]` 改成 `{}` 的同时又写回 `.rawin()`，声明检查就再也看不见它了。
	 * 而**矛盾检测**不依赖声明——重放同一个 bug 会被当场抓住（下面有一条自测证明这件事）。
	 */
	/** ident → { array: boolean, table: boolean }（`this.` 前缀可选）。 */
	function usageKinds(src: string): Map<string, { array: boolean; table: boolean }> {
		const out = new Map<string, { array: boolean; table: boolean }>();
		const bump = (id: string, k: "array" | "table") => {
			const cur = out.get(id) ?? { array: false, table: false };
			cur[k] = true;
			out.set(id, cur);
		};
		for (const m of src.matchAll(/(?:this\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\[(?:[^\]]*)\]\s*<-/g)) bump(m[1]!, "table");
		for (const m of src.matchAll(/(?:this\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(append|push)\s*\(/g)) bump(m[1]!, "array");
		for (const m of src.matchAll(/(?:this\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(rawin|rawdelete|rawget)\s*\(/g))
			bump(m[1]!, "table");
		return out;
	}

	it.each(packFiles())("%s: 没有标识符同时被当 array 与 table", (f) => {
		const src = stripComments(readFileSync(f, "utf8"));
		const bad = [...usageKinds(src)]
			.filter(([, k]) => k.array && k.table)
			.map(([id]) => id);
		expect(bad, "同一个标识符既 `.append(` 又 `.rawin(`：其中一种用法必然在运行时抛异常").toEqual([]);
	});

	it("矛盾检测本身有效（人造样本必须被抓到）", () => {
		const sample = "_x = {};\n  this._x.rawin(1);\n  this._x.append(2);\n";
		const bad = [...usageKinds(sample)].filter(([, k]) => k.array && k.table).map(([id]) => id);
		expect(bad).toEqual(["_x"]);
	});

	it("车队/线路登记用 table，车队列表用 array（各自用法一致）", () => {
		const src = stripComments(readFileSync(path.join("src/game/squirrel/executor-ai/main.nut"), "utf8"));
		expect(src).toMatch(/_routes = \{\}/);
		expect(src).toMatch(/_retiredJobs = \{\}/);
		expect(src).toMatch(/_fleetOwned = \[\]/);
	});
});

/**
 * 变量**先用后声明**：Squirrel 会在运行时抛 `the index 'X' does not exist`。
 *
 * 真机证据（`/tmp/m32b`）：`fleet_wait` 相位里用了 `cur`，而 `local cur = 0;` 在它**后面**
 * → 每次"首次车队请求"都抛异常。后果很微妙：**动作照样在下一轮生效**（所以功能测不出来），
 * 但**推迟信号全丢**，日志只剩一条 `exc:` 错误相位。这正是 D28 那一类："汇报路径"先坏，
 * 而"功能"看起来还好。
 *
 * 判据：同一个函数体内，某个 `local X` 之前不得出现对 `X` 的读取。
 * 参数在签名里声明，因此签名结束才算函数体开始。
 */
describe("Squirrel packs: 局部变量不得先用后声明", () => {
	/** 粗略切出函数体（从 `function name(...)` 到下一个同缩进的 `function`）。 */
	function functionBodies(src: string): { name: string; sig: string; body: string }[] {
		const out: { name: string; sig: string; body: string }[] = [];
		const re = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(src)) !== null) {
			const start = m.index + m[0].length;
			const next = src.indexOf("\n    function ", start);
			out.push({ name: m[1]!, sig: m[2]!, body: src.slice(start, next === -1 ? src.length : next) });
		}
		return out;
	}

	/** 绑定出现的位置：签名参数、foreach 变量、local 声明。 */
	function bindings(fn: { sig: string; body: string }): Map<string, number> {
		const at = new Map<string, number>();
		const put = (id: string, pos: number) => {
			if (!at.has(id)) at.set(id, pos);
		};
		// 签名参数（位置 0，永远算已声明）
		for (const p of fn.sig.split(",")) {
			const id = p.trim().replace(/=.*$/, "").trim();
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) put(id, 0);
		}
		const scans: [RegExp, number][] = [
			// foreach (a in …) / foreach (a, b in …)：两个标识符都是绑定
			[/foreach\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*([A-Za-z_][A-Za-z0-9_]*)\s*)?in/g, 1],
			[/local\s+([A-Za-z_][A-Za-z0-9_]*)/g, 1],
		];
		for (const [re, gi] of scans) {
			for (const m of fn.body.matchAll(re)) {
				put(m[gi]!, m.index!);
				if (m[2]) put(m[2], m.index!);
			}
		}
		return at;
	}

	it.each(packFiles())("%s: 没有函数在绑定前读取标识符", (f) => {
		// 必须先去掉字符串字面量：`obj.rawin("job")` 里的 "job" 会被 \bjob\b 匹配到，
		// 而那只是键名（第一版守卫就是这么误报 5 处 GS 命中的）。
		const src = stripStrings(stripComments(readFileSync(f, "utf8")));
		const problems: string[] = [];
		for (const fn of functionBodies(src)) {
			const at = bindings(fn);
			for (const [id, declAt] of at) {
				if (declAt === 0) continue;
				const before = fn.body.slice(0, declAt);
				const re = new RegExp(`(^|[^.A-Za-z0-9_])${id}\\b`, "gm");
				let hit: RegExpExecArray | null;
				let found = false;
				while ((hit = re.exec(before)) !== null) {
					// 排除**表字面量的键**：`{ engine = "unset" }` 里的 `engine` 是键名，不是变量读。
					const after = before.slice(hit.index + hit[0].length).match(/^\s*=/);
					const beforeCh = before.slice(0, hit.index).match(/([{,(]|\[)\s*$/);
					if (after && beforeCh) continue;
					found = true;
					break;
				}
				if (found) problems.push(`${fn.name}: 在绑定前使用了 ${id}`);
			}
		}
		expect(problems, "Squirrel 会在运行时抛 `the index 'X' does not exist`（汇报路径先坏）").toEqual([]);
	});

	it("该守卫会失败（自测：人造的先用后声明必须被抓到）", () => {
		const sample = "function F() {\n        this.SetPhase(\"x\" + later);\n        local later = 1;\n    }";
		const fn = functionBodies(sample)[0]!;
		const at = bindings(fn);
		const later = at.get("later");
		expect(later).toBeDefined();
		expect(/later\b/.test(fn.body.slice(0, later))).toBe(true);
	});
});

/**
 * M3-2b：披露必须**粘住**才可能被采样到（SPEC §10.86 未结案 → §10.87）。
 *
 * 通道性质：公司名是**单值、被采样**的（harness 每 500 ms 轮询），而执行器每轮都改写它。
 * 真机 `/tmp/m32c`：退役**生效了**（车队 8→2），但 `retire…`/`fleetsend…`/`fleetg…`
 * 相位**一条都没进日志**——被施工相位盖掉了。动作生效 + 信号丢失 = 工具无法观测自身效果。
 *
 * 修法：事件相位走上带粘滞的入口（保持 N 轮不被普通活动相位覆盖），诊断类（`exc:`）可抢占。
 */
describe("Squirrel 执行器：事件披露必须粘滞", () => {
	// 注意：这里**不能** stripStrings——要检查的关键字本身就是字符串字面量（`"fleet_wait" 等），
	// 去掉字符串等于把被测对象删掉（第一版就是这么写的，于是必然误报）。
	const src = stripComments(readFileSync(path.join("src/game/squirrel/executor-ai/main.nut"), "utf8"));

	it("存在粘滞入口，且普通 SetPhase 在粘滞期内不覆盖", () => {
		expect(src).toContain("function SetPhaseSticky(");
		expect(src).toMatch(/function SetPhase\(p\)\s*\{[\s\S]{0,300}?_phaseHoldUntil/);
	});

	it("所有车队/退役事件都走粘滞入口（漏一个 = 那条披露又会被盖掉）", () => {
		for (const kind of ["fleet_wait", "fleetg", "fleetsend", "fleetsold", "fleetok", "retire"]) {
			const direct = src.includes('SetPhaseSticky("' + kind);
			const wrapped = new RegExp('SetPhaseSticky\\(\\s*\\n?\\s*"' + kind).test(src);
			expect(direct || wrapped, kind + " 必须用 SetPhaseSticky，否则会被施工相位盖掉").toBe(true);
		}
	});

	it("诊断相位（exc:）绕过粘滞：错误不能被事件埋掉", () => {
		expect(src).toContain('WritePhase("exc:"');
	});

	it("SetPhaseSticky 的 hold 必须有默认值（Squirrel 强校验参数个数，单参调用会炸）", () => {
		expect(src).toMatch(/function SetPhaseSticky\(p, hold = null\)/);
	});
});

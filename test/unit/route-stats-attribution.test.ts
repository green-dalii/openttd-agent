/**
 * 逐线读数的**归属**（2026-11-15）：车辆数与利润必须算在**这条线自己**的头上。
 *
 * 现象（真机证据，`/tmp/ottd-e1/b24-s11` 的 route-stats 事件）：
 *   - job 1：注册表 `fleetIds` = 10 辆车，GS 报的 `vehicles` = **20**、
 *     `profit` = 14152（≈2 × 7076）⇒ **同一批车被数了两遍**；
 *   - job 9：注册表 `fleetIds` = **[]**（这条线根本没建成），
 *     GS 仍报 `vehicles` = 10、`profit` = 7076 ⇒ **那是别人的车、别人的利润**。
 *
 * 根因：`GSVehicleList_Station(s)` 返回的是**服务该站的车**（不是"此刻停在那儿的车"）
 *   ⇒ ① 一条线的车在**两个端点站**各出现一次 ⇒ 扫两个站就翻倍；
 *   ⇒ ② 站被**共用**时，别条线的车也会被算进来。
 *
 * 规则：逐线的车辆与利润只按**执行器注册表**（`RouteVehicles`）算。
 *
 * 为什么要有这个静态守卫：这个错误**不报错**（GS 照常发事件，数字看着像真的），
 * 而且它直接进**模型上下文**（模型据此判断哪条线赚钱）⇒ 静默地污染决策。
 * 单元测试跑不到 Squirrel ⇒ 只能静态锁住"别再把站点扫描拿回来"。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const GS = "src/game/squirrel/bridge-gs/main.nut";

/** 去掉注释（注释里会**故意**提到被禁的 API —— 那是给下一个读者的说明）。 */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** 取出 `function <name>(...) { ... }` 的函数体（按大括号配平）。 */
function functionBody(src: string, name: string): string {
	const start = src.indexOf(`function ${name}(`);
	expect(start, `GS 里找不到 ${name}`).toBeGreaterThan(-1);
	let i = src.indexOf("{", start);
	let depth = 0;
	for (; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) break;
		}
	}
	return src.slice(start, i);
}

describe("GS 的 route-stats：逐线读数按该线自己的车队", () => {
	const src = readFileSync(GS, "utf8");
	const body = stripComments(functionBody(src, "EmitRouteStats"));

	it("不再用站点扫描来数车/算利润（那会翻倍并串线）", () => {
		expect(body).not.toContain("GSVehicleList_Station");
	});

	it("按执行器注册表（RouteVehicles）取这条线的车队", () => {
		expect(body).toContain("RouteVehicles");
	});

	it("注册表不认识这条线时 vehicles/profit 是 0（真的没有车），不是 -1", () => {
		// "没测到"在这里**不适用**：注册表没有记录 = 执行器没建这条线 = 它没有车。
		// 用 -1 会让 TS 侧把"没有车"读成"读数失败"。
		expect(body).toMatch(/vehicles\s*=\s*vehIds\.len\(\)/);
	});
});

/**
 * 线路登记表**只允许一处重建**（2026-11-16）。
 *
 * 现象：每次车队变更/退役/改货/换车，代码都用 `this._routes[job] <- { … }`
 * **重建**这张表，只写回自己关心的那几个键 ⇒ 表里**其它字段被丢掉**。
 * 丢掉的 `lineCargo` 让**货运线没有 cargo 标签** ⇒ 逐 (货种, 收方产业) 的归因
 * **永远归不出来** ⇒ 逐线交付量一直是 null（F4 的功能在真机上从未出过一个数）；
 * 丢掉的 `endA/endB` 让诊断拿不到线路两端。
 *
 * 规则：**就地改字段**；只有"登记一条新线路"（RegisterRoute）可以重建整张表。
 */
describe("GS 的线路登记表只允许一处重建", () => {
	const src = readFileSync(GS, "utf8");
	const code = stripComments(src);
	const rebuilds = code.match(/this\._routes\[job\]\s*<-/g) ?? [];

	it("只有 RegisterRoute 一处重建（其余一律就地改字段）", () => {
		expect(rebuilds).toHaveLength(1);
	});

	it("就地改字段的写法都在（vehicles / lineCargo 不再被重建丢掉）", () => {
		expect(code).toMatch(/r\.vehicles\s*=/);
		expect(code).toMatch(/rr\.vehicles\s*=/);
	});
});

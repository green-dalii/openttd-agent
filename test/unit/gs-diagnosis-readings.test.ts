/**
 * GS 的**读数可信度**守卫（2026-11-18 真机踩到）。
 *
 * 事实：`GSVehicle.GetRefitCapacity` 只对**停在库里的车**答得出来（引擎前置
 * 条件："you must own the vehicle; the vehicle must be stopped in the depot"）。
 * 读不到时 OpenTTD 15.x 回 **4294967295**（UINT32_MAX）——那是
 * `res.Succeeded() ? refit_capacity : -1` 的有符号/无符号转换的副产品
 * （OpenTTD PR #15507）⇒ 那是**失败哨兵**，不是载量。
 *
 * 后果（真机）：路上的车全部读成哨兵 ⇒ 服务端据此把一条**活着**的线判成
 * "车没被改装"，并把 4294967295 原样写进诊断文案（用户可见的数字垃圾）。
 *
 * 为什么单独一个文件：这些守卫管的是**读数的含义**（不是"API 名字存不存在"），
 * 而 squirrel-api-guard 那份是"调用了不存在的 API"⇒ 两件事分开守。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const NUT = "src/game/squirrel/bridge-gs/main.nut";

describe("线路诊断的读数可信度", () => {
	it("GS 把引擎的失败哨兵（4294967295）写成 -1（没测到），不是载量", () => {
		const nut = readFileSync(NUT, "utf8");
		expect(nut).toMatch(/if \(refitCapacity == 4294967295\) refitCapacity = -1;/);
	});

	it("GS 报的是**被问的那条线**的 job（不是执行器当前正在做的那条）", () => {
		const nut = readFileSync(NUT, "utf8");
		expect(nut).toMatch(/raw\.rawset\("job", job\)/);
		expect(nut).toMatch(/raw\.rawset\("currentJob", this\._job\)/);
		expect(nut).toMatch(/raw\.rawset\("isCurrentJob", isCurrent\)/);
	});

	it("槽位读数只在**当前 job**时报（否则拿另一条线的地址冒充这一条）", () => {
		const nut = readFileSync(NUT, "utf8");
		expect(nut).toMatch(/if \(isCurrent\) \{[\s\S]*?raw\.rawset\("slotA"/);
		expect(nut).toMatch(/\} else \{[\s\S]*?raw\.rawset\("slotA", null\)/);
	});
});

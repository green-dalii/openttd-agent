/**
 * Unit tests — the observation surface's fingerprint.
 *
 * 职责: 守住这枚指纹的**两条**性质：
 *   1. **跨 seed 稳定**：同一个投影代码 ⇒ 同一枚指纹（否则跨局比较没法用它）。
 *   2. **对投影变化敏感**：投影多一个字段 ⇒ 指纹变（否则"不是同一个问题"就发现不了）。
 *
 * 为什么需要第三枚指纹（Issue #48 之后才暴露）：
 *   - `scaffoldHash` 覆盖提示词 + 工具，**不覆盖观测面**；
 *   - `payloadShapeHash` 覆盖真实请求，但**含世界** ⇒ 每个 seed 都不同 ⇒ 拿它跨局
 *     比较会**误报**（假警报比没警报更坏）。
 */

import { describe, expect, it } from "vitest";
import { observationShapeHash, shapeOf } from "../../src/agent/observation-shape.js";
import { observationShapeHash as projectionShapeHash } from "../../src/agent/world-facts.js";

describe("observation shape", () => {
	it("keeps the structure and drops the values", () => {
		const a = shapeOf({ x: 1, name: "alpha", list: [{ id: 1, pop: 2 }] });
		const b = shapeOf({ x: 99, name: "beta", list: [{ id: 7, pop: 8 }] });
		expect(a).toEqual(b);
	});

	it("does not let an extra field hide inside an equal shape", () => {
		const a = shapeOf({ x: 1 });
		const b = shapeOf({ x: 1, y: 2 });
		expect(a).not.toEqual(b);
	});

	it("ignores how many items an array holds (that is a fact about the world)", () => {
		const one = shapeOf({ towns: [{ id: 1, name: "a" }] });
		const two = shapeOf({ towns: [{ id: 1, name: "a" }, { id: 2, name: "b" }] });
		expect(one).toEqual(two);
	});

	it("is stable across calls (the same code ⇒ the same fingerprint)", () => {
		expect(observationShapeHash({ a: 1, b: [2] })).toBe(observationShapeHash({ a: 5, b: [9] }));
	});

	it("changes when the surface changes", () => {
		const before = observationShapeHash({ towns: [{ id: 1 }] });
		const after = observationShapeHash({ towns: [{ id: 1, name: "x" }] });
		expect(before).not.toBe(after);
	});

	it("the projection's own fingerprint is a stable 16-hex value", () => {
		const hash = projectionShapeHash();
		expect(hash).toMatch(/^[0-9a-f]{16}$/);
		expect(projectionShapeHash()).toBe(hash);
	});
});

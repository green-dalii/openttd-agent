/**
 * Payload shape hash — "the same request, apart from the numbers".
 *
 * 为什么这组断言重要：跨 seed 的可比性只靠一件事——把世界数值抹掉之后，两份请求
 * 仍然逐字相同。如果这个函数**太宽**（比如把顺序或字段也抹了），它会对真正的
 * 脚手架差异视而不见；**太严**（比如留下日期/金额），它永远不可能相等。
 * 两边都是"看起来绿、实际什么都没证明"。
 */

import { describe, expect, it } from "vitest";
import { normalizePayloadNumbers, payloadShapeHash } from "../../src/agent/payload-shape.js";

describe("normalizePayloadNumbers", () => {
	it("zeroes numbers at every depth, including inside arrays", () => {
		expect(normalizePayloadNumbers({ a: 1, b: [{ c: -2.5 }], d: "x" })).toEqual({
			a: 0,
			b: [{ c: 0 }],
			d: "x",
		});
	});

	it("blanks numeric runs inside text (the observation surface is text, not JSON)", () => {
		// 观测面是文本块："money 199214"、"1950-01-15"。只抹 JSON 数字的话，
		// 跨 seed 的哈希永远不可能相等。
		expect(normalizePayloadNumbers({ c: "money 199214 on 1950-01-15, 3 vehicles" })).toEqual({
			c: "money # on #-#-#, # vehicles",
		});
	});

	it("leaves non-numeric text alone: wording is the thing being compared", () => {
		const payload = { role: "user", content: "delivered nothing yet" };
		expect(normalizePayloadNumbers(payload)).toEqual(payload);
	});

	it("keeps null and booleans as they are (they are not measurements here)", () => {
		expect(normalizePayloadNumbers({ a: null, b: true, c: false })).toEqual({ a: null, b: true, c: false });
	});
});

describe("payloadShapeHash", () => {
	const base = {
		model: "stub",
		messages: [{ role: "system", content: "You control a company." }, { role: "user", content: "money 199199" }],
		tools: [{ name: "observe" }],
	};

	it("is equal for two seeds (different numbers, same question)", () => {
		// This is the whole point: the world's numbers are random per seed, so the
		// raw payload hash can never match - the shape hash can.
		const otherSeed = {
			...base,
			messages: [{ role: "system", content: "You control a company." }, { role: "user", content: "money 25103" }],
		};
		expect(payloadShapeHash(otherSeed)).toBe(payloadShapeHash(base));
	});

	it("changes when a single word changes", () => {
		const changed = {
			...base,
			messages: [{ role: "system", content: "You control a railway." }, base.messages[1]!],
		};
		expect(payloadShapeHash(changed)).not.toBe(payloadShapeHash(base));
	});

	it("changes when a field is dropped or added", () => {
		expect(payloadShapeHash({ ...base, tools: [] })).not.toBe(payloadShapeHash(base));
		expect(payloadShapeHash({ ...base, thinking: "low" })).not.toBe(payloadShapeHash(base));
	});

	it("changes when the order changes (ordering is part of what the model reads)", () => {
		const swapped = { ...base, messages: [base.messages[1]!, base.messages[0]!] };
		expect(payloadShapeHash(swapped)).not.toBe(payloadShapeHash(base));
	});

	it("is a stable 16-char hex prefix (safe to put in a manifest)", () => {
		expect(payloadShapeHash(base)).toMatch(/^[0-9a-f]{16}$/);
		expect(payloadShapeHash(base)).toBe(payloadShapeHash(base));
	});
});

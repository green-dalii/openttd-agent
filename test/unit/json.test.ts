import { describe, expect, it } from "vitest";
import { stringifyJson, bigintStrToNumber } from "../../src/util/json.js";

describe("stringifyJson (BigInt-safe)", () => {
	it("serializes BigInt as decimal string", () => {
		const out = stringifyJson({ money: 100000n, loan: -5000n });
		expect(out).toBe('{"money":"100000","loan":"-5000"}');
	});

	it("does not throw on nested BigInt payloads", () => {
		const payload = { id: 0, money: 100000n, income: 0n, nested: { v: 1n } };
		expect(() => stringifyJson(payload)).not.toThrow();
		const out = stringifyJson(payload);
		expect(out).toContain('"money":"100000"');
	});

	it("serializes plain objects normally (no BigInt mutation)", () => {
		const out = stringifyJson({ a: 1, b: "x", c: [1, 2] });
		expect(out).toBe('{"a":1,"b":"x","c":[1,2]}');
	});

	it("supports indentation", () => {
		const out = stringifyJson({ a: 1n }, 2);
		expect(out).toContain("\n  ");
	});
});

describe("bigintStrToNumber", () => {
	it("converts decimal string to number", () => {
		expect(bigintStrToNumber("100000")).toBe(100000);
		expect(bigintStrToNumber("-5000")).toBe(-5000);
		expect(bigintStrToNumber("0")).toBe(0);
	});

	it("handles undefined/null and non-finite gracefully", () => {
		expect(bigintStrToNumber(undefined)).toBe(0);
		expect(bigintStrToNumber(null)).toBe(0);
		expect(bigintStrToNumber("not-a-number")).toBe(0);
		expect(bigintStrToNumber(Number.NaN)).toBe(0);
	});

	it("accepts bigint directly", () => {
		expect(bigintStrToNumber(42n)).toBe(42);
	});
});

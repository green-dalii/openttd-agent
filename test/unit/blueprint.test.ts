import { describe, expect, it } from "vitest";
import {
	BlueprintError,
	blueprintToGsJson,
	buildBlueprintCommand,
	encodeGsAdminCommand,
	parseBlueprintCommand,
	validateBlueprint,
} from "../../src/game/blueprint.js";
import type { Blueprint } from "../../src/types.js";

const validBp: Blueprint = {
	job: 7,
	stations: [
		[100, 101],
		[300, 301],
	],
	path: [150, 160, 170],
	depot: [200, 201],
	engine: -1,
};

describe("buildBlueprintCommand / blueprintToGsJson", () => {
	it("builds a valid GsBlueprintCommand envelope", () => {
		const cmd = buildBlueprintCommand(validBp);
		expect(cmd).toEqual({ cmd: "blueprint", ...validBp });
	});

	it("serializes compact JSON (arena grammar)", () => {
		const json = blueprintToGsJson(validBp);
		expect(json).toBe(JSON.stringify({ cmd: "blueprint", ...validBp }));
		expect(json).not.toMatch(/\s/);
	});

	it("throws on invalid job/path/tile", () => {
		expect(() => buildBlueprintCommand({ ...validBp, job: 1000 })).toThrow(BlueprintError);
		expect(() => buildBlueprintCommand({ ...validBp, job: -1 })).toThrow(BlueprintError);
		expect(() => buildBlueprintCommand({ ...validBp, path: [] })).toThrow(BlueprintError);
		expect(() =>
			buildBlueprintCommand({ ...validBp, path: Array.from({ length: 201 }, (_, i) => i) }),
		).toThrow(BlueprintError);
		expect(() =>
			buildBlueprintCommand({ ...validBp, depot: [-5, 0] }),
		).toThrow(BlueprintError);
		expect(() =>
			buildBlueprintCommand({ ...validBp, stations: [[-1, 0], [1, 2]] }),
		).toThrow(BlueprintError);
	});
});

describe("parseBlueprintCommand", () => {
	it("round-trips through JSON", () => {
		const json = blueprintToGsJson(validBp);
		const parsed = parseBlueprintCommand(json);
		expect(parsed).toEqual({ cmd: "blueprint", ...validBp });
	});

	it("throws on malformed input", () => {
		expect(() => parseBlueprintCommand("not json")).toThrow(BlueprintError);
		expect(() => parseBlueprintCommand('{"cmd":"blueprint"}')).toThrow(BlueprintError);
		expect(() => parseBlueprintCommand('{"cmd":"other","job":1}')).toThrow(BlueprintError);
	});
});

describe("validateBlueprint", () => {
	it("returns [] for a valid blueprint", () => {
		expect(validateBlueprint(validBp)).toEqual([]);
	});

	it("lists problems for invalid input", () => {
		const problems = validateBlueprint({
			...validBp,
			job: 5000,
			path: [],
			depot: [-1, 2],
		});
		expect(problems.length).toBeGreaterThanOrEqual(3);
		for (const p of problems) expect(typeof p).toBe("string");
	});
});

describe("encodeGsAdminCommand", () => {
	it("serializes arbitrary admin->GS commands", () => {
		const json = encodeGsAdminCommand({ cmd: "ping", ts: 1 });
		expect(JSON.parse(json)).toEqual({ cmd: "ping", ts: 1 });
	});
});

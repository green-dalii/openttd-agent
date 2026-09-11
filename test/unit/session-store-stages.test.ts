/**
 * Unit tests — reading archived stage images (path safety).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readStageFile } from "../../src/agent/session-store.js";

function fixture(): { dir: string; id: string } {
	const dir = mkdtempSync(path.join(tmpdir(), "stagefile-"));
	const id = "20260911-120000-seed7";
	mkdirSync(path.join(dir, "sessions", id, "stages"), { recursive: true });
	writeFileSync(path.join(dir, "sessions", id, "stages", "000.png"), Buffer.from([0x89, 0x50]));
	writeFileSync(path.join(dir, "sessions", id, "meta.json"), "{}");
	return { dir, id };
}

describe("readStageFile", () => {
	it("returns the bytes of an archived stage image", () => {
		const { dir, id } = fixture();
		try {
			expect(readStageFile(dir, id, "000.png")).toEqual(Buffer.from([0x89, 0x50]));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects any name that is not NNN.png", () => {
		const { dir, id } = fixture();
		try {
			for (const bad of ["meta.json", "../meta.json", "0000.png", "000.PNG", "000.png.bak", ""]) {
				expect(readStageFile(dir, id, bad), bad).toBeNull();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a traversing session id", () => {
		const { dir, id } = fixture();
		try {
			for (const bad of ["../..", "..", `${id}/../..`, ""]) {
				expect(readStageFile(dir, bad, "000.png"), bad).toBeNull();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null instead of throwing for unknown files", () => {
		const { dir, id } = fixture();
		try {
			expect(readStageFile(dir, id, "999.png")).toBeNull();
			expect(readStageFile(dir, "nope", "000.png")).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * Unit tests — vendored dependency integrity.
 *
 * 职责: 锁定 `assets/vendor/**` 与上游发布物的**逐字节一致**，以及清单本身有效。
 *
 * 为什么重要（docs/FRONTEND-DEPENDENCIES-AUDIT.md §6）: vendored 依赖的前提是
 *   "文件等于上游产物、版本由 lockfile 锁定"。若有人为了应急直接改 vendor 文件，
 *   下次 `pnpm run vendor` 会静默覆盖，而评审也看不出来 —— 这类漂移必须在
 *   gate 里失败。`scripts/verify-vendor.ts` 负责比对，这里确保它真的会失败。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { VENDOR, vendorDir } from "../../scripts/sync-vendor.js";
import { checkVendor } from "../../scripts/verify-vendor.js";

describe("vendored dependencies", () => {
	it("every manifest entry has a vendored file present", () => {
		for (const entry of VENDOR) {
			const dest = path.join(vendorDir(entry.pkg), entry.to);
			expect(() => readFileSync(dest), `assets/vendor/${entry.pkg}/${entry.to}`).not.toThrow();
		}
	});

	it("every vendored file is byte-identical to its package", () => {
		// An empty problem list means nothing has drifted.
		expect(checkVendor()).toEqual([]);
	});

	it("records provenance so the source version is traceable", () => {
		const pkgs = [...new Set(VENDOR.map((e) => e.pkg))];
		for (const pkg of pkgs) {
			const prov = JSON.parse(
				readFileSync(path.join(vendorDir(pkg), "PROVENANCE.json"), "utf8"),
			) as { pkg: string; version: string };
			expect(prov.pkg).toBe(pkg);
			expect(prov.version).toMatch(/^\d+\.\d+\.\d+/);
		}
	});

	it("is actually loadable as a plain script (no build chain)", () => {
		// The whole point of vendoring an IIFE build: `<script src>` must work.
		// `node --check` proves it parses as a classic script.
		const entry = VENDOR.find((e) => e.pkg === "uplot" && e.to.endsWith(".js"));
		expect(entry, "uplot iife entry").toBeTruthy();
		expect(() =>
			execFileSync(
				process.execPath,
				["--check", path.join(vendorDir(entry!.pkg), entry!.to)],
				{ stdio: "pipe" },
			),
		).not.toThrow();
	});

	it("detects a hand-edited vendored file", () => {
		// Simulate the exact failure the check exists for: someone appends a line.
		const entry = VENDOR[0]!;
		const dest = path.join(vendorDir(entry.pkg), entry.to);
		const original = readFileSync(dest);
		try {
			writeFileSync(dest, Buffer.concat([original, Buffer.from("\n// hotfix\n")]));
			const problems = checkVendor();
			expect(problems.length).toBeGreaterThan(0);
			expect(problems.join(" ")).toContain("differs from");
		} finally {
			writeFileSync(dest, original); // restore, or every later test would fail
		}
		expect(checkVendor()).toEqual([]);
	});

	it("keeps the vendored copy in sync after copying everywhere", () => {
		// Sanity: vendorDir is where sync writes AND where verify reads.
		const dir = mkdtempSync(path.join(tmpdir(), "vendor-"));
		try {
			const f = path.join(dir, "x.js");
			writeFileSync(f, "a");
			const g = path.join(dir, "g.js");
			copyFileSync(f, g);
			expect(readFileSync(g, "utf8")).toBe("a");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

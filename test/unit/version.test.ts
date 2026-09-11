/**
 * Unit tests — version consistency.
 *
 * 职责: 强制 `package.json` 的 version 与 CHANGELOG 最新条目一致。
 *   为什么需要: 曾经漂移到 package.json=0.2.0 而 CHANGELOG 已到 0.4.0，导致
 *   归档 session / 用户报障无法对应到代码。
 * 事实来源: package.json + CHANGELOG.md。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION } from "../../src/version.js";

const ROOT = join(import.meta.dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

/** Version of the first (most recent) `## [x.y.z]` entry. */
function latestChangelogVersion(): string | null {
	const m = /^##\s*\[(\d+\.\d+\.\d+)\]/m.exec(changelog);
	return m ? m[1]! : null;
}

describe("version consistency", () => {
	it("package.json carries a semver", () => {
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("APP_VERSION reads from package.json rather than a hardcoded copy", () => {
		expect(APP_VERSION).toBe(pkg.version);
	});

	it("CHANGELOG's newest entry matches package.json", () => {
		// This is the drift that went unnoticed for 4 releases.
		const latest = latestChangelogVersion();
		expect(latest, "CHANGELOG has no [x.y.z] heading").not.toBeNull();
		expect(
			latest,
			`package.json says ${pkg.version} but CHANGELOG's newest entry is ${latest}`,
		).toBe(pkg.version);
	});

	it("documents the current version as the latest release in CHANGELOG", () => {
		// The newest entry must also be the highest (no stale ordering).
		const versions = [...changelog.matchAll(/^##\s*\[(\d+)\.(\d+)\.(\d+)\]/gm)].map(
			(m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const,
		);
		expect(versions.length).toBeGreaterThan(0);
		const [maj, min, pat] = versions[0]!;
		expect(`${maj}.${min}.${pat}`).toBe(pkg.version);
		for (let i = 1; i < versions.length; i++) {
			const [a1, b1, c1] = versions[i - 1]!;
			const [a2, b2, c2] = versions[i]!;
			const prev = a1 * 1e6 + b1 * 1e3 + c1;
			const cur = a2 * 1e6 + b2 * 1e3 + c2;
			expect(prev, "CHANGELOG entries must be newest-first").toBeGreaterThan(cur);
		}
	});

	it("never falls back to the unknown placeholder in a real checkout", () => {
		expect(APP_VERSION).not.toMatch(/unknown/);
	});
});

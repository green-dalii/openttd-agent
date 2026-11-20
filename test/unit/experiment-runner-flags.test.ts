/**
 * The experiment runner's two **honesty flags** (N1's pre-registration).
 *
 * ① `--measure-only`: a run that asks "how big would the effect have to be?"
 *    instead of "is there an effect?". The power gate must still REPORT the
 *    required n - but it must not refuse to start, and the output must say
 *    that no effect is claimed (otherwise the reader takes the CI for a verdict).
 * ② `--arm-order trt-first`: the control arm always ran first, so the second
 *    run of a pair enjoyed the warm start (and the provider's rate limit was
 *    spent by the first run) => a positive result could be an order effect.
 *    Alternating the order per seed cancels it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** A data dir that passes the runner's credential preflight. */
function dirWithProvider(): string {
	const dir = mkdtempSync(join(tmpdir(), "n1-flags-"));
	writeFileSync(join(dir, "credentials.json"), "{}");
	writeFileSync(join(dir, "llm.json"), "{}");
	return dir;
}

describe("实验 runner 的诚实旗标", () => {
	it("不加 --measure-only 时，功效不够就**拒绝开跑**（闸不被绕过）", () => {
		const dir = dirWithProvider();
		const r = spawnSync(
			"pnpm",
			["exec", "tsx", "scripts/run-experiment.ts", "--dir", dir, "--n", "1", "--game-days", "200"],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		expect(r.status).toBe(1);
		expect(r.stderr + r.stdout).toContain("Refusing to start");
		expect(r.stderr + r.stdout).toContain("UNDERPOWERED");
	});

	it("--measure-only ⇒ 照跑，但打印“需要多少对”与“不声称任何效应”", () => {
		const dir = dirWithProvider();
		const r = spawnSync(
			"pnpm",
			[
				"exec",
				"tsx",
				"scripts/run-experiment.ts",
				"--dir",
				dir,
				// --n 0 ⇒ **不真的开跑**（闸与旗标照样被检验）⇒ 单测不碰真机。
				"--n",
				"0",
				"--game-days",
				"200",
				"--measure-only",
				"--arm-order",
				"trt-first",
			],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 20000 },
		);
		const out = r.stdout + r.stderr;
		expect(out).toContain("measure-only");
		expect(out).toContain("claims NO effect");
		expect(out).not.toContain("Refusing to start");
	});

	it("披露交付量的**口径**（run = 整局累计 / raw = admin 当季计数，跨局不可比）", () => {
		const dir = dirWithProvider();
		const r = spawnSync(
			"pnpm",
			[
				"exec",
				"tsx",
				"scripts/run-experiment.ts",
				"--dir",
				dir,
				"--n",
				"0",
				"--game-days",
				"200",
				"--measure-only",
			],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 20000 },
		);
		const out = r.stdout + r.stderr;
		// D126：两个口径都在时，比较会自动回落；不披露 ⇒ 读者会把季度计数当交付量。
		expect(out).toContain("delivered source:");
		expect(out).toMatch(/run \(whole-run total|raw \(admin quarterly counter/);
	});
});

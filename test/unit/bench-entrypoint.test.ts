/**
 * Unit test — the benchmark script **runs** when it is invoked (issue #1).
 *
 * 职责: 锁定"脚本被调用时必须真的干活"。
 * 为什么存在: 入口判定用 `import.meta.url` 与 `process.argv[1]` **比字符串** ⇒
 *   macOS 上 `/tmp` 是 `/private/tmp` 的符号链接 ⇒ 两者一个是解析后的路径、
 *   一个是调用时的路径 ⇒ 判成"不是入口" ⇒ 脚本**静默什么都不做**就退出
 *   （没有输出、没有报错、退出码 0）⇒ 最坏的一种失败：矩阵"跑完了"，其实一格没跑。
 * 铁律: 入口判定必须比较 **realpath**。
 * 禁止: 在此真的跑矩阵（只跑 `--dry-run`，不启动游戏）。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("基准脚本被调用时真的干活", () => {
	it("--dry-run 打印矩阵（不是静默退出）", () => {
		const root = mkdtempSync(join(tmpdir(), "bench-dry-"));
		const r = spawnSync(
			"pnpm",
			[
				"exec",
				"tsx",
				"scripts/bench.ts",
				"--root",
				root,
				"--models",
				"m-a,m-b",
				"--seeds",
				"11",
				"--dry-run",
			],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("matrix: 2 cell(s)");
		expect(r.stdout).toContain("m-a seed=11");
		expect(r.stdout).toContain("m-b seed=11");
	});

	it("缺凭证文件 ⇒ 跑矩阵之前就报错（不是跑到一半才失败）", () => {
		const root = mkdtempSync(join(tmpdir(), "bench-nocred-"));
		const r = spawnSync(
			"pnpm",
			[
				"exec",
				"tsx",
				"scripts/bench.ts",
				"--root",
				root,
				"--models",
				"m-a",
				"--seeds",
				"11",
				"--credentials",
				join(root, "no-such-credentials.json"),
				"--dry-run",
			],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("not found");
	});

	it("缺 provider 的模型清单 ⇒ 跑矩阵之前就报错", () => {
		const root = mkdtempSync(join(tmpdir(), "bench-nomodels-"));
		const r = spawnSync(
			"pnpm",
			[
				"exec",
				"tsx",
				"scripts/bench.ts",
				"--root",
				root,
				"--models",
				"m-a",
				"--seeds",
				"11",
				"--models-cache",
				join(root, "no-such-models-cache.json"),
				"--dry-run",
			],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("models cache not found");
	});
});

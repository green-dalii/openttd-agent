/**
 * Unit tests — repository hygiene.
 *
 * 职责: 挡住"顺手提交了不该提交的东西"这类错误。它们不影响功能，但会永久留在历史里，
 *   并误导后来者以为那是产品的一部分。
 * 事实来源: AGENTS.md §3.1（临时脚本归 `.scratch/`）。
 * 禁止: 在此断言业务行为。
 *
 * 起因(2026-09-12):我在仓库根目录写 CDP 探针脚本 `probe2.mjs`，被 `git add -A`
 * 顺手提交进了 `10eb8ef`。用户指出这类临时文件应当集中存放并及时清理。
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** 仓库中被 git 跟踪的文件（不含未跟踪的本地垃圾）。 */
function trackedFiles(): string[] {
	const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
	return out.split("\n").filter(Boolean);
}

/** 一次性的探针/验证/抓包脚本：不属于产品，也不进 test/。 */
const SCRATCH_PATTERNS = [
	/^probe[\w-]*\.(mjs|cjs|js|ts)$/,
	/^vfy[\w-]*\.(mjs|cjs|js|ts)$/,
	/^verify[\w-]*\.(mjs|cjs|js|ts)$/,
	/^check[\w-]*\.(mjs|cjs|js|ts)$/,
	/^scratch[\w-]*\./,
	/^tmp[\w-]*\.(mjs|cjs|js|ts)$/,
	/\.tmp$/,
];

describe("repo hygiene: 临时脚本", () => {
	it("没有被跟踪的临时/探针脚本", () => {
		const offenders = trackedFiles().filter((f) => SCRATCH_PATTERNS.some((re) => re.test(f)));
		expect(
			offenders,
			`以下临时脚本被提交进了仓库，应移到 .scratch/（已在 .gitignore 中）或删除:\n` +
				offenders.map((f) => `  - ${f}`).join("\n"),
		).toEqual([]);
	});

	it("仓库根目录只有 eslint.config.mjs 这一个 .mjs 被跟踪", () => {
		const rootMjs = trackedFiles().filter((f) => !f.includes("/") && f.endsWith(".mjs"));
		expect(rootMjs).toEqual(["eslint.config.mjs"]);
	});

	it(".scratch/ 与根目录的探针模式都在 .gitignore 里", () => {
		const gi = readFileSync(join(ROOT, ".gitignore"), "utf8");
		expect(gi).toMatch(/^\/\.scratch\/$/m);
		expect(gi).toMatch(/^\/probe\*\.mjs$/m);
		expect(gi).toMatch(/^\/vfy\*\.mjs$/m);
	});

	it(".scratch/ 目录存在(约定，不靠记忆)", () => {
		expect(existsSync(join(ROOT, ".scratch"))).toBe(true);
	});
});

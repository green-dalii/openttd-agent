/**
 * Verify that vendored browser bundles match the installed packages byte-for-byte.
 *
 * 职责: 防止 `assets/vendor/**` 被手工编辑（或漏跑 `pnpm run vendor`）而与
 *   `node_modules` 的上游发布物不一致 —— 那会让"版本可审计"这个保证失效。
 *
 * 为什么需要（docs/FRONTEND-DEPENDENCIES-AUDIT.md §6）: vendored 依赖的整个前提是
 *   "文件逐字节等于上游发布物，版本由 lockfile 锁定"。一旦有人为了改个 bug 直接
 *   编辑 vendor 文件，下次 `pnpm run vendor` 会静默覆盖他的改动，而 CI 也不会发现。
 *   本脚本让这种漂移**在提交前失败**。
 *
 * 用法: `pnpm run vendor:check`（由 `gate` 调用）
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VENDOR, vendorDir } from "./sync-vendor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Compare every manifest entry; returns a list of problems (empty = ok). */
export function checkVendor(): string[] {
	const problems: string[] = [];
	for (const entry of VENDOR) {
		const src = path.join(ROOT, "node_modules", entry.pkg, entry.from);
		const dest = path.join(vendorDir(entry.pkg), entry.to);
		if (!existsSync(dest)) {
			problems.push(`missing vendored file: assets/vendor/${entry.pkg}/${entry.to} (run \`pnpm run vendor\`)`);
			continue;
		}
		if (!existsSync(src)) {
			problems.push(`missing package file: node_modules/${entry.pkg}/${entry.from} (run \`pnpm install\`)`);
			continue;
		}
		const a = sha256(src);
		const b = sha256(dest);
		if (a !== b) {
			problems.push(
				`vendored file differs from ${entry.pkg}/${entry.from}: ` +
					`assets/vendor/${entry.pkg}/${entry.to} (${b.slice(0, 12)}) != upstream (${a.slice(0, 12)}). ` +
					"Never hand-edit vendored files - run `pnpm run vendor`.",
			);
		}
	}
	return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const problems = checkVendor();
	if (problems.length) {
		console.error("vendor check FAILED:");
		for (const p of problems) console.error("  " + p);
		process.exitCode = 1;
	} else {
		console.log(`vendor check ok (${VENDOR.length} files match their packages)`);
	}
}

/**
 * Vendor third-party browser bundles into `src/web/public/assets/vendor/`.
 *
 * 职责: 把 `node_modules` 里的浏览器产物**复制**（不是手抄）到前端静态目录，
 *   让仪表盘保持**离线可用**（无 CDN），同时保持**可复现**（版本由
 *   `package.json` 的 devDependency 锁定，复制来源可审计）。
 *
 * 为什么是 vendored 而不是 CDN（docs/FRONTEND-DEPENDENCIES-AUDIT.md §6）:
 *   本项目连的是本机 OpenTTD，可能在**无外网**环境运行；CDN 会成为单点故障，
 *   也让"这个文件到底是哪个版本"变得不可追溯。
 *
 * 禁止:
 *   - 手工 `cp`：绕过本脚本就失去了"版本与来源可审计"这一保证。
 *   - 在此做压缩/转译/打包：vendored 文件必须与上游发布物**逐字节一致**，
 *     否则 `scripts/verify-vendor.ts` 的校验会失败。
 *
 * 用法: `pnpm run vendor`（幂等；可重复运行）
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** What to vendor and where it comes from. Keep this list explicit. */
export interface VendorEntry {
	/** npm package name (must be a devDependency). */
	pkg: string;
	/** Path inside the installed package. */
	from: string;
	/** File name inside `assets/vendor/<pkg>/`. */
	to: string;
}

/**
 * The vendoring manifest.
 *
 * `uplot` is used for line/bar charts. It is MIT, has zero dependencies, and
 * ships a plain IIFE build, so no bundler is involved (measured: 22 KB gzip for
 * the JS + 0.8 KB for the CSS - see docs/FRONTEND-DEPENDENCIES-AUDIT.md §2).
 */
export const VENDOR: VendorEntry[] = [
	{ pkg: "uplot", from: "dist/uPlot.iife.min.js", to: "uPlot.iife.min.js" },
	{ pkg: "uplot", from: "dist/uPlot.min.css", to: "uPlot.min.css" },
	// The type declarations are vendored too: they let `tsc --checkJs` type-check
	// our usage of the global `uPlot` (see tsconfig.frontend.json).
	{ pkg: "uplot", from: "dist/uPlot.d.ts", to: "uPlot.d.ts" },
];

/** Absolute directory a vendored package lands in. */
export function vendorDir(pkg: string): string {
	return path.join(ROOT, "src", "web", "public", "assets", "vendor", pkg);
}

/** Read an installed package's version (the provenance stamp). */
function pkgVersion(pkg: string): string {
	const p = path.join(ROOT, "node_modules", pkg, "package.json");
	if (!existsSync(p)) {
		throw new Error(
			`${pkg} is not installed. Run \`pnpm install\` (it must be a devDependency).`,
		);
	}
	return (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version;
}

/**
 * Copy every manifest entry into place. Idempotent.
 * Returns a short human-readable log of what happened.
 */
export function syncVendor(): string[] {
	const log: string[] = [];
	const versions = new Map<string, string>();

	for (const entry of VENDOR) {
		const src = path.join(ROOT, "node_modules", entry.pkg, entry.from);
		if (!existsSync(src)) {
			throw new Error(`missing vendor source: ${entry.pkg}/${entry.from}`);
		}
		const dir = vendorDir(entry.pkg);
		mkdirSync(dir, { recursive: true });
		const dest = path.join(dir, entry.to);
		const version = pkgVersion(entry.pkg);
		versions.set(entry.pkg, version);
		copyFileSync(src, dest);
		log.push(`  ${entry.pkg}@${version}  ${entry.from} -> assets/vendor/${entry.pkg}/${entry.to}`);
	}

	// A provenance file so a reader (or a future audit) can tell which upstream
	// version each vendored byte came from without consulting package.json.
	for (const [pkg, version] of versions) {
		writeFileSync(
			path.join(vendorDir(pkg), "PROVENANCE.json"),
			JSON.stringify({ pkg, version, generatedBy: "scripts/sync-vendor.ts" }, null, "\t") + "\n",
		);
	}
	return log;
}

// Only run when invoked directly (so tests can import the manifest).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const log = syncVendor();
		console.log("vendored:");
		for (const line of log) console.log(line);
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exitCode = 1;
	}
}

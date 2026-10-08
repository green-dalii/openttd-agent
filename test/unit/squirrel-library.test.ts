/**
 * Squirrel 库包（vendored 抽取件）守卫。
 *
 * 职责: 锁三件事 —— ① 依赖链三件套齐全且带 GPL 许可文本 ② GS 适配补丁在场
 *   （GSLibrary 基类 + 修改声明，GPL §2(a)）③ 部署把库放进 `<data>/game/library/`
 *   （GS 的库扫描树，SPEC §10.107）。
 * 禁止: 把库代码复制进 main.nut（GPL 边界，见库目录 README）。
 */
import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SQUIRREL_SRC, deploySquirrelPacks } from "../../src/game/squirrel-deploy.js";
import type { Config } from "../../src/config.js";

/** 依赖链：pathfinder.road → graph.aystar 6 → queue.binary_heap 1。 */
const LIBS = ["Pathfinder.Road-4", "Graph.AyStar.6", "Queue.BinaryHeap.1"];

describe("squirrel 库包（vendored）", () => {
	it("三件套齐全：main.nut + library.nut + license.txt（GPL v2 全文）", async () => {
		for (const name of LIBS) {
			for (const f of ["main.nut", "library.nut", "license.txt"]) {
				const st = await stat(path.join(SQUIRREL_SRC, "library", name, f));
				expect(st.isFile(), `${name}/${f}`).toBe(true);
			}
			const license = await readFile(path.join(SQUIRREL_SRC, "library", name, "license.txt"), "utf8");
			expect(license, name).toContain("GNU GENERAL PUBLIC LICENSE");
		}
	});

	it("GS 适配补丁在场且带修改声明（GPL §2(a)）", async () => {
		for (const name of LIBS) {
			const text = await readFile(path.join(SQUIRREL_SRC, "library", name, "library.nut"), "utf8");
			expect(text, `${name} 基类`).toContain("extends GSLibrary");
			expect(text, `${name} 未改回 AI 基类`).not.toContain("extends AILibrary");
			expect(text, `${name} 修改声明`).toContain("GS 适配补丁");
			expect(text, `${name} 来源记录`).toMatch(/MD5 [0-9a-f]{32}/);
		}
	});

	it("API 类已改 GS 名（GS 虚拟机不注册 AI 名，SPEC §10.107）", async () => {
		for (const name of LIBS) {
			const text = await readFile(path.join(SQUIRREL_SRC, "library", name, "main.nut"), "utf8");
			expect(text, `${name} 不得残留 AI* API 名`).not.toMatch(/\bAI[A-Z]\w*\b/);
			const lib = await readFile(path.join(SQUIRREL_SRC, "library", name, "library.nut"), "utf8");
			expect(lib, `${name} 修改声明含改名`).toContain("AIList");
		}
	});

	it("README 记录来源、原始 MD5 与许可边界", async () => {
		const readme = await readFile(path.join(SQUIRREL_SRC, "library", "README.md"), "utf8");
		expect(readme).toContain("GPL v2");
		expect(readme).toContain("聚合");
		for (const md5 of ["7a7e02051c0b2c177f10f2440e462de7", "300052317e050fbd12f983c995fa4000", "200e798ae4b3cfa6556e628eaa982e4b"]) {
			expect(readme).toContain(md5);
		}
	});

	it("部署把库目录放进 <data>/game/library/（GS 库扫描树）", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "lib-deploy-"));
		const cfg = { dataDir: dir } as Config;
		await deploySquirrelPacks(cfg);
		const entries = await readdir(path.join(dir, "game", "library"));
		for (const name of LIBS) expect(entries, name).toContain(name);
		const nut = await readFile(path.join(dir, "game", "library", "Pathfinder.Road-4", "library.nut"), "utf8");
		expect(nut).toContain("extends GSLibrary");
	});
});

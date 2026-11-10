/**
 * Unit tests — the benchmark matrix carries its own provider state (issue #1).
 *
 * 职责: 锁定"每一格是独立 data dir"与"key 只存在于仓库之外"这两条怎么共存:
 *   凭证必须**复制**进每一格（否则每格都因为"没有凭证"失败），而且
 *   **只复制不打印**、权限 0600、缺文件**在跑第一格之前**就说清楚。
 * 为什么存在: 每格独立目录是为了"记忆不得跨格"；而 key 不能进仓库 ⇒ 不复制
 *   进去，矩阵会跑到一半才失败，已经烧掉的 token 与时间全部白花。
 *   同理，走**目录**（catalog）provider 的模型清单存在 `<dataDir>/models-cache.json`
 *   ⇒ 新目录里没有它 ⇒ 第一格就会说"provider 不认识这个模型"。
 * 禁止: 在此断言任何 key 的内容（测试里只用假的字符串）。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkCredentials,
	checkModelsCache,
	installCredentials,
	installModelsCache,
} from "../../scripts/bench.js";

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("矩阵的每一格带着自己的 provider 状态", () => {
	it("凭证被复制进那一格，权限 0600", () => {
		const src = join(tmpDir("bcred-src-"), "credentials.json");
		writeFileSync(src, '{"minimax-cn":{"type":"api_key","key":"sk-test-not-a-real-key"}}', "utf8");
		const cell = tmpDir("bcred-cell-");
		installCredentials(src, cell);
		const target = join(cell, "credentials.json");
		expect(existsSync(target)).toBe(true);
		expect(readFileSync(target, "utf8")).toContain("sk-test-not-a-real-key");
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	it("两格各有一份 ⇒ 互不共享（格子之间不共享任何东西）", () => {
		const src = join(tmpDir("bcred-src-"), "credentials.json");
		writeFileSync(src, '{"p":{"key":"k"}}', "utf8");
		const a = tmpDir("bcred-a-");
		const b = tmpDir("bcred-b-");
		installCredentials(src, a);
		installCredentials(src, b);
		expect(join(a, "credentials.json")).not.toBe(join(b, "credentials.json"));
		expect(existsSync(join(a, "credentials.json"))).toBe(true);
		expect(existsSync(join(b, "credentials.json"))).toBe(true);
	});

	it("源文件权限太宽时，目标仍然是 0600", () => {
		const src = join(tmpDir("bcred-src-"), "credentials.json");
		writeFileSync(src, '{"p":{"key":"k"}}', "utf8");
		chmodSync(src, 0o644);
		const cell = tmpDir("bcred-cell-");
		installCredentials(src, cell);
		expect(statSync(join(cell, "credentials.json")).mode & 0o777).toBe(0o600);
	});

	it("缺凭证文件 ⇒ 跑矩阵**之前**就报出来", () => {
		expect(() => checkCredentials("/definitely/not/here/credentials.json")).toThrow(/not found/);
	});

	it("没给凭证文件 ⇒ 不报错（离线矩阵用 stub，不需要 key）", () => {
		expect(() => checkCredentials(undefined)).not.toThrow();
	});

	it("provider 的模型清单被复制进那一格（目录 provider 靠它认模型）", () => {
		const src = join(tmpDir("bmc-src-"), "models-cache.json");
		writeFileSync(src, '{"minimax-cn":{"models":[{"id":"m-1"}]}}', "utf8");
		const cell = tmpDir("bmc-cell-");
		installModelsCache(src, cell);
		expect(existsSync(join(cell, "models-cache.json"))).toBe(true);
		expect(readFileSync(join(cell, "models-cache.json"), "utf8")).toContain("m-1");
	});

	it("缺模型清单 ⇒ 跑矩阵之前就报出来", () => {
		expect(() => checkModelsCache("/definitely/not/here/models-cache.json")).toThrow(/not found/);
		expect(() => checkModelsCache(undefined)).not.toThrow();
	});
});

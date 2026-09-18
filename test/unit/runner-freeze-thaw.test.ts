/**
 * 决策循环的结构性不变量，都由真机事故换来。
 *
 * 职责: 锁定
 *   1. 决策循环**不得直接**用控制台 pause —— 只能经 `freeze.ts` 的验证型控制器
 *      （暂停/恢复要回执确认 + release 必须在 finally + 看门狗）
 *   2. `seconds` **真的**限制运行长度
 * 禁止: 在这里测 dashboard 的 pause/resume 控制接口（另一条路径）。
 *
 * **2026-09-17 更新（SPEC §10.59）**：原来这里写的是"暂停是单向的，绝不许用"。
 * 实测推翻了该归因（pause → getdate 冻结，unpause → 日期恢复推进；真因是
 * `pause_on_join=true` 且无客户端）。规则从"禁止暂停"改为"**只许验证型冻结**"，
 * 且必须能证明它真的冻住了（`freeze.stats()`）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const RUNNER = path.resolve("src/agent/runner.ts");
const src = readFileSync(RUNNER, "utf8");
// REFACTOR Phase B-4b: the decision-loop while body moved to decision-loop.ts.
// The structural invariants below must hold wherever the loop lives, so the
// assertions scan BOTH files (runner = assembly, decision-loop = loop body).
const LOOP_SRC = path.resolve("src/agent/decision-loop.ts");
const loopSrc = readFileSync(LOOP_SRC, "utf8");
const both = src + "\n" + loopSrc;

/** 去掉注释行 —— 解释性注释会引用被禁的写法，不该触发测试。 */
function codeLines(): string[] {
	return both
		.split("\n")
		.map((l) => {
			const t = l.trim();
			return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") ? "" : l;
		});
}

describe("runner: 决策循环不得暂停游戏", () => {
	it("决策循环附近没有 rcon(\"pause\") / rcon(\"unpause\")", () => {
		// 原设计在决策前后 pause/unpause，想让世界在 LLM 思考时不动。
		// 实际是**单向冻结**：rcon("pause") 把 Commands::Pause 投进游戏循环队列，
		// 一旦暂停该队列就不再排空，随后投进去的 unpause 永不执行。
		// 实测：带 pause 时游戏日历 120 秒只走 1 天；去掉后 1000 tick 走 13.5 天。
		const lines = codeLines();
		const callIdx = lines.findIndex((l) => /await ctx\.runDecision\(|await runDecision\(/.test(l));
		expect(callIdx).toBeGreaterThan(-1);
		const window = lines.slice(Math.max(0, callIdx - 60), callIdx + 60).join("\n");
		expect(window).not.toMatch(/rcon\(\s*["']pause["']\s*\)/);
		expect(window).not.toMatch(/rcon\(\s*["']unpause["']\s*\)/);
	});

	it("保留解释：为什么默认不暂停、以及为何冻结现在又是可选项", () => {
		// 两个都必须在场：旧结论（曾经这么以为）与新测量（推翻它）。少任何一个
		// 都会让后人重新在"信念"上盖楼（MEMORY D8）。
		expect(both).toMatch(/one-way/i);
		expect(both).toMatch(/measured FALSE|§10\.59|10\.59/);
	});

	it("冻结只能经 freeze 控制器，且 release 必须在 finally 里", () => {
		// §10.26 的永久冻结就是 unpause 不在 finally 里；这是那次的守卫升级版。
		const loop = loopSrc.split("\n");
		const acquireIdx = loop.findIndex((l) => /freeze\.acquire|freeze\?\.acquire/.test(l));
		expect(acquireIdx).toBeGreaterThan(-1);
		const tail = loop.slice(acquireIdx, acquireIdx + 40).join("\n");
		expect(tail).toMatch(/finally\s*\{/);
		expect(tail).toMatch(/release\(\)/);
		// 控制器本身才允许发 pause/unpause 字面量
		expect(loopSrc).not.toMatch(/rcon\(\s*["']pause["']\s*\)/);
		const freezeSrc = readFileSync(path.resolve("src/agent/freeze.ts"), "utf8");
		expect(freezeSrc).toMatch(/pause\(\)/);
		expect(freezeSrc).toMatch(/unpause\(\)/);
	});

	it("观察发生在询问模型之前（这是替代暂停的机制）", () => {
		const lines = codeLines();
		const snapIdx = lines.findIndex((l) => /const preSnap = (?:ctx\.)?deps\.state\.snapshot\(\)/.test(l));
		const callIdx = lines.findIndex((l) => /await ctx\.runDecision\(|await runDecision\(/.test(l));
		expect(snapIdx).toBeGreaterThan(-1);
		expect(callIdx).toBeGreaterThan(snapIdx);
	});
});

describe("runner: seconds 必须真的限制运行长度", () => {
	// 真机发现（2026-09-12）：`--demo-seconds 190` 实际跑了 **28 分钟**，
	// 直到我手动杀掉。251 次决策、20 台车 —— 运行是健康的，只是**没有上限**。
	//
	// 根因：决策循环是 `while (!stopRequested)`，**没有截止检查**；
	// `opts.seconds` 只在循环**之后**用于 `Promise.race([stopPromise, sleep(...)])`。
	// 即 seconds 限制的是"循环结束后还要等多久"—— 一个永远走不到的分支。
	//
	// 对 M3 对照实验（同 seed 各 3 局）这是致命的：局长不可控。
	it("决策循环内部有跳出（G1：episode 时钟优先，墙钟上限兜底）", () => {
		// 2026-09-18 起，运行长度由 EPISODE 时钟（模拟游戏日）决定，墙钟只剩
		// 安全上限；旧的 `deadline` 路径保留给没有 episode 的调用方（测试/旧路径）。
		// SPEC §10.68：墙钟预算 → 模拟时间不可比（同 900s 六局推进 0–449 游戏日）。
		const lines = codeLines();
		const loopIdx = lines.findIndex((l) => /while \(!ctx\.isStopRequested\(\)\)|while \(!stopRequested\)/.test(l));
		expect(loopIdx).toBeGreaterThan(-1);
		const head = lines.slice(loopIdx, loopIdx + 26).join("\n");
		expect(head).toMatch(/episode/);
		expect(head).toMatch(/stopReason === "horizon"/);
		expect(head).toMatch(/stopReason === "wall_cap"/);
		// 兜底路径仍在（没有 episode 时按墙钟截止）。
		expect(head).toMatch(/shouldBreakOnDeadline/);
	});

	it("截止时间由 opts.seconds 算出（<=0 / undefined 表示不限时）", () => {
		expect(both).toMatch(/opts\.seconds\s*&&\s*(?:ctx\.)?opts\.seconds\s*>\s*0/);
	});
});

describe("每局结束必须留下可载入的存档（2026-09-16 项目所有者要求）", () => {
	it("teardown 在停服前 rcon save（否则局结束后无法在游戏里回看）", () => {
		const lines = codeLines();
		const teardownIdx = lines.findIndex((l) => /async function teardown\(\)/.test(l));
		expect(teardownIdx).toBeGreaterThan(-1);
		const window = lines.slice(teardownIdx, teardownIdx + 25).join("\n");
		expect(window).toMatch(/rcon\(`save \$\{|rcon\("save /);
		// 存档必须发生在 mgr.stop() 之前（服务器一停，内存里的局就没了）
		const saveIdx = lines.findIndex((l, i) => i > teardownIdx && /rcon\(`save /.test(l));
		const stopIdx = lines.findIndex((l, i) => i > teardownIdx && /mgr\.stop\(\)/.test(l));
		expect(saveIdx).toBeGreaterThan(-1);
		expect(stopIdx).toBeGreaterThan(saveIdx);
	});
});

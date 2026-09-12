/**
 * runner.ts 的两个结构性不变量，都由真机事故换来。
 *
 * 职责: 锁定
 *   1. 决策循环**绝不**用控制台 pause 游戏
 *   2. `seconds` **真的**限制运行长度
 * 禁止: 在这里测 dashboard 的 pause/resume 控制接口（另一条路径）。
 *
 * 详见 SPEC §10.28（暂停是单向的）与 §10.30（seconds 没生效）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const RUNNER = path.resolve("src/agent/runner.ts");
const src = readFileSync(RUNNER, "utf8");

/** 去掉注释行 —— 解释性注释会引用被禁的写法，不该触发测试。 */
function codeLines(): string[] {
	return src
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
		const callIdx = lines.findIndex((l) => /await runDecision\(/.test(l));
		expect(callIdx).toBeGreaterThan(-1);
		const window = lines.slice(Math.max(0, callIdx - 60), callIdx + 60).join("\n");
		expect(window).not.toMatch(/rcon\(\s*["']pause["']\s*\)/);
		expect(window).not.toMatch(/rcon\(\s*["']unpause["']\s*\)/);
	});

	it("保留解释，否则后人会顺手把它优化回来", () => {
		expect(src).toMatch(/freeze was ONE-WAY|cannot be unpaused/i);
	});

	it("观察发生在询问模型之前（这是替代暂停的机制）", () => {
		const lines = codeLines();
		const snapIdx = lines.findIndex((l) => /const preSnap = deps\.state\.snapshot\(\)/.test(l));
		const callIdx = lines.findIndex((l) => /await runDecision\(/.test(l));
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
	it("决策循环内部有基于截止时间的跳出", () => {
		const lines = codeLines();
		const loopIdx = lines.findIndex((l) => /while \(!stopRequested\)/.test(l));
		expect(loopIdx).toBeGreaterThan(-1);
		const head = lines.slice(loopIdx, loopIdx + 12).join("\n");
		expect(head).toMatch(/deadline/);
		expect(head).toMatch(/Date\.now\(\)\s*>=\s*deadline/);
	});

	it("截止时间由 opts.seconds 算出（<=0 / undefined 表示不限时）", () => {
		expect(src).toMatch(/opts\.seconds\s*&&\s*opts\.seconds\s*>\s*0/);
	});
});

/**
 * runner.ts 的暂停不变量。
 *
 * 职责: 锁定"决策循环**绝不**用控制台 pause 游戏"。
 * 禁止: 在这里测 pause/resume 控制接口（那是 dashboard 按钮的路径，另一件事）。
 *
 * 为什么 (2026-09-12 真机根因):
 * 原设计在每次决策前 `rcon("pause")`、决策后 `rcon("unpause")`，想让 LLM 思考时
 * 世界不动。实际是**单向冻结**：`rcon("pause")` 会把
 * `Commands::Pause(PM_NORMAL, true)` 投进游戏循环的队列；一旦暂停，那个循环
 * 就不再排空队列，于是随后投进去的 unpause **永远不会执行**。
 * OpenTTD 的 console 处理函数写得很清楚：
 *
 *   if (_pause_mode.Test(PauseMode::Normal)) { Post(PM_NORMAL, false); }
 *   else if (_pause_mode.Any())
 *     "Game cannot be unpaused manually; disable pause_on_join/min_active_clients."
 *
 * 实测：带 pause 时游戏日历 120 秒只走 1 天，而 GS 仍在发状态（3200 脚本 tick）
 * —— 脚本在跑、世界不动，正是"暂停"的指纹。去掉 pause 后 1000 tick 走 13.5 天，
 * 执行器从 boot 一路推进到 road_start。
 *
 * 因此这个不变量是硬性的：一旦有人再把控制台 pause 加回决策循环，
 * 整套"执行器卡住"的症状会立刻复发，而且看起来像执行器的错。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const RUNNER = path.resolve("src/agent/runner.ts");
const src = readFileSync(RUNNER, "utf8");

describe("runner: 决策循环不得暂停游戏", () => {
	it("决策循环里没有 rcon(\"pause\")", () => {
		const lines = src.split("\n");
		// 决策循环以 FREEZE 注释所在区域为界；找 runDecision 的调用点，
		// 往前后各看 60 行，断言这段里没有控制台 pause。
		// Strip comments first: the block right above deliberately QUOTES the
		// `rcon("pause")` trap, and matching that would make this test fail for
		// the wrong reason (and tempt someone to delete the explanation).
		const code = lines
			.map((l) => {
				const t = l.trim();
				return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") ? "" : l;
			})
			.join("\n")
			.split("\n");
		const callIdx = code.findIndex((l) => /await runDecision\(/.test(l));
		expect(callIdx).toBeGreaterThan(-1);
		const window = code.slice(Math.max(0, callIdx - 60), callIdx + 60).join("\n");
		expect(window).not.toMatch(/rcon\(\s*["']pause["']\s*\)/);
		expect(window).not.toMatch(/rcon\(\s*["']unpause["']\s*\)/);
	});

	it("保留注释解释为什么不能加回来（否则后人会顺手优化回去）", () => {
		// 这条防的是"代码对了但没人知道为什么"：删掉注释的人会在
		// 半年后把它加回来。
		expect(src).toMatch(/freeze was ONE-WAY|cannot be unpaused/i);
	});

	it("观察必须发生在询问模型之前（这是替代暂停的机制）", () => {
		// 去掉暂停之后，"决策质量"靠的是：先取快照，再问模型，
		// 并把期间的变化用 sinceLastDecision 汇报回去。
		const lines = src.split("\n");
		const snapIdx = lines.findIndex((l) => /const preSnap = deps\.state\.snapshot\(\)/.test(l));
		const callIdx = lines.findIndex((l) => /await runDecision\(/.test(l));
		expect(snapIdx).toBeGreaterThan(-1);
		expect(callIdx).toBeGreaterThan(snapIdx);
	});
});
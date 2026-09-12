/**
 * runner.ts 的 freeze/thaw 结构守卫。
 *
 * 职责: 锁定 "决策前 rcon("pause") 之后,无论 runDecision 抛不抛,rcon("unpause")
 *   都会被执行"。这是 game state 与 GS tick 的命脉:如果 unpause 被异常跳过,
 *   游戏永远停在暂停状态 —— GS 不 tick,执行器不推进,agent 拿不到任何进度,
 *   表面上像是"半成品",实际上是个 unhandled-pause bug。
 *
 * 为什么这是静态测试而不是真机断言 (2026-09-12):
 * 真机只能看出"GS 不 tick",追到这里需要再跑若干分钟;静态测试一次扫描即可
 * 永久锁住这个不变量。
 *
 * 真机观察:三次相同命令 `--agent --offline-demo --seed 7` 的执行器永远停在
 *   `EX boot j-1`,期间 GS 周期发送 `"cmd":"state"` 出现 0 次。
 * grep 整个 runner.ts 原本找不到任何 `finally` 块。
 * 解:把 unpause 放进 `try { runDecision() } finally { unpause }`。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const RUNNER = path.resolve("src/agent/runner.ts");
const src = readFileSync(RUNNER, "utf8");

describe("runner: 决策循环的 freeze/thaw 不变量", () => {
	it("文件里至少存在一个 finally 块", () => {
		expect(src).toMatch(/\}\s*finally\s*\{/);
	});

	it("rcon(\"unpause\") 必须出现在某个 finally 块之内", () => {
		const blocks = [...src.matchAll(/\}\s*finally\s*\{([\s\S]*?)\n\t\}\s*$/gm)];
		expect(blocks.length).toBeGreaterThan(0);
		expect(blocks.some((m) => /\bunpause\b/.test(m[1]!))).toBe(true);
	});

	it("决策循环的 pause 之后,unpause 必须出现在 finally 里", () => {
		const lines = src.split("\n");
		// 锚定在 FREEZE 注释上 —— 它是决策循环里 pause 的标志。
		// control handler 里的 pause/resume 不算,因为它们有自己的正确结构,
		// 而且被这个测试误判会让本来对的东西变成假阳性。
		const freezeIdx = lines.findIndex((l) => /FREEZE while the LLM thinks/.test(l));
		expect(freezeIdx).toBeGreaterThan(-1);
		let pauseIdx = -1;
		for (let i = freezeIdx; i < freezeIdx + 20 && i < lines.length; i++) {
			if (/client\?\.rcon\(\s*["']pause["']\s*\)/.test(lines[i]!)) {
				pauseIdx = i;
				break;
			}
		}
		expect(pauseIdx).toBeGreaterThan(-1);
		// 该 pause 之后 50 行内必须出现 `} finally { ... unpause`
		const window = lines.slice(pauseIdx, pauseIdx + 50).join("\n");
		expect(window).toMatch(/\}\s*finally\s*\{[\s\S]{0,1200}unpause/);
	});
});
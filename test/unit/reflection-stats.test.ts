import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readReflectionRecords, reflectionStats } from "../../src/evolution/reflection-stats.js";

/**
 * M1（2026-09-19）：反思统计的唯一来源。
 *
 * 反思发生在 metric 行写入**之后**，所以这些数字只能来自审计；
 * 这里用**真实形状**的记录做夹具（reflect-run 实际写下的字段）。
 */
describe("reflection-stats: 反思到底有没有干活", () => {
	const mk = (rows: unknown[]) => {
		const dir = mkdtempSync(path.join(tmpdir(), "m1-stats-"));
		const sess = path.join(dir, "sessions", "s1");
		mkdirSync(sess, { recursive: true });
		writeFileSync(
			path.join(sess, "audit.jsonl"),
			rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n",
			"utf8",
		);
		return dir;
	};

	it("聚合 toolCalls / retries / saved，并单独数出 0 调用的局", () => {
		const dir = mk(
			[
				{ type: "reflection", toolCalls: 3, retries: 0, lessonsSaved: 3, rejections: [] },
				{ type: "reflection", toolCalls: 0, retries: 1, lessonsSaved: 0, rejections: [] },
				{ type: "decision", trigger: "start" },
			],
		);
		const s = reflectionStats(dir);
		expect(s.runs).toBe(2);
		expect(s.zeroCallRuns).toBe(1);
		expect(s.runsWithRetry).toBe(1);
		expect(s.toolCalls).toEqual({ reported: 2, max: 3, total: 3 });
		expect(s.retries).toEqual({ reported: 2, max: 1, total: 1 });
		expect(s.lessonsSaved).toEqual({ reported: 2, max: 3, total: 3 });
	});

	/**
	 * 2026-09-19 真机自证：provider 失败的那局 `ok:false` + `toolCalls:0`，
	 * 于是被计成"0 工具调用"，WARNING 把**网络故障**报成了"协议/接线信号"。
	 * 两个成因必须分开计数——混在一起就会把基础设施问题读成提示词问题。
	 */
	it("provider 失败的局不算「0 工具调用」（两种成因分开）", () => {
		const dir = mk([
			{ type: "reflection", ok: true, toolCalls: 3, retries: 0, lessonsSaved: 3 },
			{ type: "reflection", ok: true, toolCalls: 0, retries: 1, lessonsSaved: 0 },
			{ type: "reflection", ok: false, toolCalls: 0, retries: 0, lessonsSaved: 0, error: "stream ended" },
		]);
		const s = reflectionStats(dir);
		expect(s.runs).toBe(3);
		expect(s.failedRuns).toBe(1);
		// 只有 ok:true 且 0 调用的那局才算协议信号
		expect(s.zeroCallRuns).toBe(1);
		// 失败局不进 toolCalls 统计（它没机会调用）
		expect(s.toolCalls).toEqual({ reported: 2, max: 3, total: 3 });
	});

	it("没有反思记录 → 全部 null/runs=0（缺报 ≠ 0）", () => {
		const s = reflectionStats(mk([{ type: "decision" }]));
		expect(s.runs).toBe(0);
		expect(s.toolCalls).toBeNull();
		expect(s.retries).toBeNull();
		expect(s.lessonsSaved).toBeNull();
	});

	it("目录不存在 / 坏行不抛异常", () => {
		expect(readReflectionRecords("/tmp/definitely-not-a-dir-m1")).toEqual([]);
		const dir = mk(["{not json", { type: "reflection", toolCalls: 2 }]);
		expect(reflectionStats(dir).runs).toBe(1);
		expect(reflectionStats(dir).toolCalls?.total).toBe(2);
	});
});

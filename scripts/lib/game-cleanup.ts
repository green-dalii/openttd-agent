/**
 * Game cleanup — kill **only** the games this machine's experiments started.
 *
 * 为什么不能宽泛地 pkill（2026-11-16）：`pkill -f openttd` 会把**用户自己的实例**
 * 一起杀掉（MEMORY §0.4：用户的实例不得终止）。游戏进程的命令行里带
 * `-D <dataDir>`（`src/game/process-manager.ts`）⇒ 按**数据目录**过滤就是精确的。
 *
 * 为什么要一个实现（两个脚本都要用）：同一个概念只能有一处实现（MEMORY D116）——
 * 矩阵（`bench.ts`）与连跑实验（`run-experiment.ts`）的清理必须是**同一条规则**，
 * 否则一个脚本修好了、另一个还会杀用户实例。
 */
import { spawnSync } from "node:child_process";

/**
 * Which pids should be killed: the OpenTTD processes whose data dir is inside
 * `rootDir`. Pure (takes the `ps` output as a string) so it can be unit-tested
 * without starting a game.
 */
export function gamePidsToKill(psOutput: string, rootDir: string): number[] {
	const out: number[] = [];
	for (const line of psOutput.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(.*)$/);
		if (!m) continue;
		const pid = Number(m[1]);
		const cmd = m[2] ?? "";
		if (!cmd.includes("MacOS/openttd") && !/(^|\s)openttd(\s|$)/.test(cmd)) continue;
		// Only the games whose data dir is under this experiment's root.
		if (!cmd.includes(rootDir)) continue;
		out.push(pid);
	}
	return out;
}

/** Kill the games this experiment started (its own data dir) and nothing else. */
export function cleanupGame(rootDir: string): void {
	const ps = spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
	const pids = gamePidsToKill(ps.stdout ?? "", rootDir);
	for (const pid of pids) {
		try {
			process.kill(pid);
		} catch {
			/* already gone */
		}
	}
	if (pids.length > 0) spawnSync("sleep", ["2"]);
}

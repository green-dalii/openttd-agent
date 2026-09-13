/**
 * Decision-loop health report for one dataDir.
 *
 * 职责: 只读 `agent-audit.jsonl`，回答一个此前每轮都在手写 python 回答的问题：
 *   **这个循环是在问 agent 有意义的决定，还是在让它对着节流器空转？**
 * 禁止: 修改任何数据；规则不在这里实现（空转率阈值只是展示，不参与控制）。
 *
 * 用法:
 *   pnpm exec tsx scripts/loop-health.ts /tmp/hbfix3
 *
 * 背景（SPEC §10.35/§10.35.1）: agent 曾被自己的心跳唤醒（212 次决策里 197 次），
 * 其中 83% 的间隔里 money 一分未动 —— 那样的 A/B 测的是调度器节流参数，
 * 不是 agent。这个脚本把「空转率」变成一条可复查的数字。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface AuditRecord {
	type: string;
	ts: number;
	turn?: number;
	trigger?: string;
	state?: { companies?: { money?: string; vehicles?: number | null; stations?: number | null }[] };
	message?: string;
}

const dataDir = process.argv[2];
if (!dataDir) {
	console.error("usage: tsx scripts/loop-health.ts <dataDir>");
	process.exit(2);
}

const records = (JSON.parse(`[${readFileSync(join(dataDir, "agent-audit.jsonl"), "utf8").trim().replace(/\n/g, ",")}]`) as AuditRecord[]);
const decisions = records.filter((r) => r.type === "decision");
const actions = records.filter((r) => r.type === "action_result");
const plans = records.filter((r) => r.type === "note" && (r.message ?? "").startsWith("plan:"));

// Split into games (turn resets to 1).
const games: AuditRecord[][] = [];
let cur: AuditRecord[] = [];
for (const d of decisions) {
	if (d.turn === 1 && cur.length) {
		// 必须重新赋值而不是继续复用：games 里存的是引用，
		// 若复用同一个数组，每个游戏都包含之前所有游戏的决策，
		// 触发计数与空转率会按游戏序号被重复累计（首版真实 bug：
		// 212 次决策被数出 1272 个触发）。
		games.push(cur);
		cur = [];
	}
	cur.push(d);
}
if (cur.length) games.push(cur);

const sig = (r: AuditRecord): string => {
	const c = r.state?.companies?.[0];
	return `${c?.money ?? "?"}|${c?.stations ?? "?"}|${c?.vehicles ?? "?"}`;
};

let pairs = 0;
let idle = 0;
const triggers: Record<string, number> = {};
for (const g of games) {
	for (let i = 0; i < g.length; i++) {
		const t = g[i]!.trigger ?? "?";
		triggers[t] = (triggers[t] ?? 0) + 1;
		if (i > 0) {
			pairs++;
			if (sig(g[i]!) === sig(g[i - 1]!)) idle++;
		}
	}
}

const observe = actions.filter((a) => a.tool === "observe").length;
const plansPerGame = (plans.length / Math.max(games.length, 1)).toFixed(1);
const idleRate = pairs ? (idle / pairs) : 0;
const observeShare = actions.length ? observe / actions.length : 0;
const decisionsPerGame = (decisions.length / Math.max(games.length, 1)).toFixed(1);

console.log(`dataDir            : ${dataDir}`);
console.log(`games              : ${games.length}`);
console.log(`decisions/game     : ${decisionsPerGame}`);
console.log(`triggers           : ${JSON.stringify(triggers)}`);
console.log(`idle rate          : ${(idleRate * 100).toFixed(0)}%  (${idle}/${pairs} 决策间隔里 money/stations/vehicles 全没变)`);
console.log(`observe share      : ${(observeShare * 100).toFixed(0)}%  (${observe}/${actions.length})`);
console.log(`plan notes/game    : ${plansPerGame}  (unique ${new Set(plans.map((p) => p.message)).size})`);
console.log("");
// 阈值是经验参考线，不是控制参数：它只解释数字，不改变循环。
const healthy = idleRate < 0.3 && observeShare < 0.5 && Number(decisionsPerGame) <= 10;
console.log(`verdict            : ${healthy ? "HEALTHY" : "STILL BURNING DECISIONS ON NOTHING"}`);
if (!healthy) {
	console.log("  (§10.35: idle rate 应 < 30%，observe 占比应 < 50%，决策数应到个位数/局)");
}

/**
 * Route facts — 结构化记忆（Phase C-1，SPEC §10.43 修法 1 / §10.49 后续）。
 *
 * 职责: 把"哪条线被哪个决策订购、建成没有"以**确定性**方式入库与注入——
 *   不经 LLM 总结（§10.43 审计：反思散文格式摧毁了账本里已有的精确数据）。
 * 禁止: 任何评价或建议（"prefer/should"）——注入的是事实，评判是反思层的事；
 *   禁止丢数据（未完成的线如实保留 completed:false）。
 *
 * 存储形态: `<dataDir>/evolution/route-facts.jsonl`，跨局累积；
 *   同 (from,to,completed,doneDate) 去重——同一事实重复发生只记一次；
 *   同 pair 不同结局共存（上次建成、这次没建成，都是事实）。
 */
import { mkdirSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import type { RouteStats } from "../agent/route-stats.js";
import { join } from "node:path";

export interface RouteFact {
	from: number;
	to: number;
	/** The decision (turn) that ordered this route. */
	decision: number;
	completed: boolean;
	/** In-game date when the executor reported done, if observed. */
	doneDate?: string;
	/** Wall-clock ms when the fact was saved. */
	savedAt: number;
	/**
	 * N2-3: the OUTCOME of the line, not just whether it was ordered. Without
	 * these the memory can only recall "did I build it", never "was it worth
	 * anything" - which is exactly what the three A/B rounds measured (§10.52).
	 */
	vehicles?: number;
	waiting?: number;
	/** Year-to-date profit of the route's vehicles (Money; negative = loss). */
	profit?: number;
}

/** Ledger 中间形态（route-ledger.ts 的 all() 输出）。 */
export interface LedgerLine {
	order: { job: number; fromTown: number; toTown: number; decision: number; orderedAt: number };
	outcome: { completed: boolean; doneDate?: string };
}

/**
 * 账本 → 事实。1:1 转换，不美化、不丢弃。
 *
 * `statsByJob`（N2-3，可选）：同一 job 的 GS 经济读数。给了就带上结果，
 * 没给（旧调用方）行为不变；某个 job 没有读数时**照样记录事实**，只是没有
 * 经济字段——缺读数与缺线路是两件事，都不许静默消失。
 */
export function routeFactsFromLedger(
	lines: LedgerLine[],
	statsByJob?: Map<number, RouteStats>,
): Omit<RouteFact, "savedAt">[] {
	return lines.map((l) => {
		const base: Omit<RouteFact, "savedAt"> = {
			from: l.order.fromTown,
			to: l.order.toTown,
			decision: l.order.decision,
			completed: l.outcome.completed,
		};
		if (l.outcome.doneDate) base.doneDate = l.outcome.doneDate;
		const st = statsByJob?.get(l.order.job);
		if (st) {
			base.vehicles = st.vehicles;
			base.waiting = st.waiting;
			base.profit = st.profit;
		}
		return base;
	});
}

/**
 * 同一事实的幂等键：pair + 结局 + 完成日期 + **经济读数**。
 *
 * 经济读数进键是刻意的：同一条线这次亏 308、下次赚 5000 是**两个不同的观测**，
 * 用旧键会把新观测静默丢弃（"同一事实只记一次"若覆盖新信息，记忆就永远停在
 * 第一次看到的世界上）。
 */
function factKey(f: Omit<RouteFact, "savedAt">): string {
	const econ = `${f.vehicles ?? "-"}/${f.waiting ?? "-"}/${f.profit ?? "-"}`;
	return `${f.from}>${f.to}|${f.completed ? 1 : 0}|${f.doneDate ?? "-"}|${econ}`;
}

function factsPath(dir: string): string {
	return join(dir, "evolution", "route-facts.jsonl");
}

/** 追加保存（JSONL）；与已有事实幂等（同键跳过）。 */
export function saveRouteFacts(
	dataDir: string,
	facts: Omit<RouteFact, "savedAt">[],
): void {
	if (facts.length === 0) return;
	const path = factsPath(dataDir);
	mkdirSync(join(dataDir, "evolution"), { recursive: true });
	const existing = new Set(loadRouteFacts(dataDir).map(factKey));
	for (const f of facts) {
		if (existing.has(factKey(f))) continue;
		const rec: RouteFact = { ...f, savedAt: Date.now() };
		existing.add(factKey(f));
		appendFileSync(path, JSON.stringify(rec) + "\n");
	}
}

/** 读取全部事实；文件不存在 → 空（调用方决定注入什么，这里不造数据）。 */
export function loadRouteFacts(dataDir: string): RouteFact[] {
	const path = factsPath(dataDir);
	if (!existsSync(path)) return [];
	const out: RouteFact[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as RouteFact);
		} catch {
			// 损坏行跳过（不中断注入）；真实损坏应在写侧避免
		}
	}
	return out;
}

/**
 * 注入格式：纯事实句，供决策上下文与 lessons 并列。红线：无建议词。
 * N2-3：成品句尾附上结果读数（车辆/等待/利润），句子仍是陈述。
 */
export function formatRouteFactsForInjection(facts: RouteFact[]): string[] {
	return facts.map((f) => {
		const pair = `towns ${f.from}->${f.to}`;
		const head = f.completed
			? `route ${pair} was ordered at decision ${f.decision} and was built${f.doneDate ? ` (done ${f.doneDate})` : ""}`
			: `route ${pair} was ordered at decision ${f.decision} but no completion observed`;
		if (f.vehicles === undefined || f.waiting === undefined || f.profit === undefined) return head;
		return `${head}; at session end it had ${f.vehicles} vehicles, ${f.waiting} passengers waiting and ${f.profit} year-to-date profit`;
	});
}

/** 启动时快照的事实行 provider（闭包缓存；与 loadMemory 同款稳定性语义）。 */
export function makeRouteFactsProvider(dataDir: string): () => string[] {
	const facts = loadRouteFacts(dataDir);
	return () => formatRouteFactsForInjection(facts);
}

/**
 * Gated provider: `--no-memory` must disable route facts too, otherwise the
 * control arm receives injected memory and the A/B arms stop being two arms
 * (m3f: all six runs landed in treatment, 5 vs 1).
 */
export function routeFactsProviderFor(dataDir: string, enabled: boolean): () => string[] {
	return enabled ? makeRouteFactsProvider(dataDir) : () => [];
}

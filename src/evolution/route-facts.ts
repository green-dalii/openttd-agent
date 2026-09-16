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
}

/** Ledger 中间形态（route-ledger.ts 的 all() 输出）。 */
export interface LedgerLine {
	order: { job: number; fromTown: number; toTown: number; decision: number; orderedAt: number };
	outcome: { completed: boolean; doneDate?: string };
}

/** 账本 → 事实。1:1 转换，不美化、不丢弃。 */
export function routeFactsFromLedger(lines: LedgerLine[]): Omit<RouteFact, "savedAt">[] {
	return lines.map((l) => {
		const base: Omit<RouteFact, "savedAt"> = {
			from: l.order.fromTown,
			to: l.order.toTown,
			decision: l.order.decision,
			completed: l.outcome.completed,
		};
		if (l.outcome.doneDate) base.doneDate = l.outcome.doneDate;
		return base;
	});
}

/** 同一事实的幂等键：pair + 结局 + 完成日期。 */
function factKey(f: Omit<RouteFact, "savedAt">): string {
	return `${f.from}>${f.to}|${f.completed ? 1 : 0}|${f.doneDate ?? "-"}`;
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

/** 注入格式：纯事实句，供决策上下文与 lessons 并列。红线：无建议词。 */
export function formatRouteFactsForInjection(facts: RouteFact[]): string[] {
	return facts.map((f) => {
		const pair = `towns ${f.from}->${f.to}`;
		return f.completed
			? `route ${pair} was ordered at decision ${f.decision} and was built${f.doneDate ? ` (done ${f.doneDate})` : ""}`
			: `route ${pair} was ordered at decision ${f.decision} but no completion observed`;
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

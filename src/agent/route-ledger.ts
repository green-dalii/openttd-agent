/**
 * Route ledger — the decision→outcome link for credit assignment.
 *
 * 职责: 记录"哪个决策订购了哪条线"，以及该线后来的 observed 结果。
 *   反思（reflection）此前只拿到 outcome 汇总，写出的 lesson 是空洞的
 *   （"零失败调用显示了保守执行的可行性"，SPEC §10.34 实测）——
 *   因为它没有"这次选择带来了什么"可写。本模块把账接上。
 * 禁止: 任何评价（"选得好/差"）——只记事实与时间戳，评判是反思层的事。
 *
 * 事实来源: GS ack（job/townA/townB，SPEC §10.33）+ 执行器 done 阶段串（j<job>）。
 */

export interface RouteOrder {
	job: number;
	fromTown: number;
	toTown: number;
	/** Decision (turn) that ordered this route. */
	decision: number;
	/** Wall-clock ms when the ack arrived. */
	orderedAt: number;
}

export interface RouteOutcome {
	/** In-game date string when the executor reported done for this job. */
	doneDate?: string;
	/** Straight tile count reported by the executor's phase, if seen. */
	completed: boolean;
}

export interface LedgerLine {
	order: RouteOrder;
	outcome: RouteOutcome;
}

export class RouteLedger {
	private orders = new Map<number, RouteOrder>();
	private outcomes = new Map<number, RouteOutcome>();

	/** A build order was acked by the GS. */
	record(order: RouteOrder): void {
		this.orders.set(order.job, order);
		if (!this.outcomes.has(order.job)) {
			this.outcomes.set(order.job, { completed: false });
		}
	}

	/** The executor reported `done` for this job (phase `... j<job>`). */
	markDone(job: number, doneDate?: string): void {
		if (!this.orders.has(job)) return; // not ours / not tracked
		const o = this.outcomes.get(job);
		if (o) {
			o.completed = true;
			if (doneDate) o.doneDate = doneDate;
		}
	}

	/** Factual lines for reflection evidence: order + what was observed after. */
	lines(): string[] {
		const out: string[] = [];
		for (const job of [...this.orders.keys()].sort((a, b) => a - b)) {
			const order = this.orders.get(job)!;
			const outcome = this.outcomes.get(job)!;
			out.push(
				`route job ${job} (towns ${order.fromTown}->${order.toTown}) was ordered at ` +
					`decision ${order.decision}` +
					(outcome.completed
						? ` and the executor reported it built${outcome.doneDate ? ` on ${outcome.doneDate}` : ""}`
						: " but no completion was observed before the run ended"),
			);
		}
		return out;
	}

	all(): LedgerLine[] {
		return [...this.orders.keys()]
			.sort((a, b) => a - b)
			.map((job) => ({ order: this.orders.get(job)!, outcome: this.outcomes.get(job)! }));
	}
}

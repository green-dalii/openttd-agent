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

/** How many observed world events one route keeps (newest kept). */
export const ROUTE_EVENT_LIMIT = 20;

/**
 * A **passenger** route order (its two ends are towns).
 *
 * 货运 F4（A5）：台账的记录形状必须装得下它要记的事实 —— 客运线的两端是**城镇**，
 * 货运线的两端是**产业** ⇒ 两种**显式分开**的记录（而不是把产业塞进城镇字段：
 * 那样会变成 `null/null`，而它**还进模型上下文**，垃圾不只是脏数据）。
 */
export interface RouteOrder {
	kind: "passenger";
	job: number;
	fromTown: number;
	toTown: number;
	/** Decision (turn) that ordered this route. */
	decision: number;
	/** Wall-clock ms when the ack arrived. */
	orderedAt: number;
	/**
	 * The command that ordered this job (e.g. "build_bus_route").
	 *
	 * D3a/S4: the job id is assigned by the GS, so the tool's own receipt does
	 * not carry it - the ack does. Without this, an executor phase cannot be
	 * joined back to the agent's action.
	 */
	command?: string;
}

/**
 * A **freight** route order (its two ends are industries, plus the cargo).
 *
 * 事实来源: GS 的 `build_freight_route` ack（`producer`/`consumer`/`cargo`）。
 */
export interface FreightRouteOrder {
	kind: "freight";
	job: number;
	/** The producing industry (the line's start). */
	fromIndustry: number;
	/** The consuming industry (the line's end). */
	toIndustry: number;
	/** The cargo the line carries ("COAL", …). */
	cargo: string;
	/** Decision (turn) that ordered this route. */
	decision: number;
	/** Wall-clock ms when the ack arrived. */
	orderedAt: number;
	/** The command that ordered this job. */
	command?: string;
}

/** Either kind of route order. */
export type AnyRouteOrder = RouteOrder | FreightRouteOrder;

export interface RouteOutcome {
	/** In-game date string when the executor reported done for this job. */
	doneDate?: string;
	/** Straight tile count reported by the executor's phase, if seen. */
	completed: boolean;
	/**
	 * The **world events** observed for this route's vehicles (Issue #13: the
	 * decision→result ledger).
	 *
	 * Why: "the executor said it built the line" is not a result - "the first
	 * vehicle reached the station" is. The pushed events (Issue #13, S7d) are
	 * what make this measurable, and the vehicle→job mapping comes from the
	 * executor's own route statistics (`vehiclesIds`).
	 *
	 * Absent = **no event was observed for this route** (not "nothing
	 * happened": the vehicle may never have arrived before the run ended).
	 */
	observed?: { kind: string; vehicle: number | null; date?: string }[];
}

export interface LedgerLine {
	order: AnyRouteOrder;
	outcome: RouteOutcome;
}

export class RouteLedger {
	private orders = new Map<number, AnyRouteOrder>();
	private outcomes = new Map<number, RouteOutcome>();
	/** vehicle id -> the job whose route it belongs to (from the route stats). */
	private vehicleJobs = new Map<number, number>();

	/** A build order was acked by the GS (passenger or freight). */
	record(order: AnyRouteOrder): void {
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

	/**
	 * Learn which vehicles belong to which route (from the executor's route
	 * statistics: `vehiclesIds`).
	 *
	 * This is the join that turns a **pushed world event** (about a vehicle)
	 * into a fact about **a decision** (the decision that ordered that route).
	 */
	recordVehicleJobs(job: number, vehicleIds: number[]): void {
		for (const id of vehicleIds) {
			if (Number.isInteger(id) && id >= 0) this.vehicleJobs.set(id, job);
		}
	}

	/**
	 * Record a world event that was observed for one of our vehicles.
	 *
	 * The event is attached to the **route** (and therefore to the decision that
	 * ordered it). An event about a vehicle we do not know is ignored - we
	 * cannot attribute it to any of our decisions (attribution must not be
	 * guessed).
	 */
	noteVehicleEvent(vehicle: number | null, kind: string, date?: string): void {
		if (vehicle === null || !Number.isInteger(vehicle)) return;
		const job = this.vehicleJobs.get(vehicle);
		if (job === undefined) return;
		const outcome = this.outcomes.get(job);
		if (!outcome) return;
		const list = outcome.observed ?? [];
		// 同一辆车同一件事只记一次（事件可能重复到达）。
		if (list.some((e) => e.kind === kind && e.vehicle === vehicle)) return;
		list.push({ kind, vehicle, ...(date ? { date } : {}) });
		outcome.observed = list.slice(-ROUTE_EVENT_LIMIT);
	}

	/** The command that ordered this job (D3a/S4), if it was recorded. */
	commandForJob(job: number): string | undefined {
		return this.orders.get(job)?.command;
	}

	/** Factual lines for reflection evidence: order + what was observed after. */
	lines(): string[] {
		const out: string[] = [];
		for (const job of [...this.orders.keys()].sort((a, b) => a - b)) {
			const order = this.orders.get(job)!;
			const outcome = this.outcomes.get(job)!;
			// 两种线**各说各的**（货运 F4 / A5）：客运说城镇，货运说产业与货种。
			// 绝不说 “towns null->null”（那是把一条货运线塞进客运形状的后果，
			// 而它**还进模型上下文**）。
			const what =
				order.kind === "freight"
					? `freight route job ${job} (${order.cargo}, industry ${order.fromIndustry}->${order.toIndustry})`
					: `route job ${job} (towns ${order.fromTown}->${order.toTown})`;
			out.push(
				`${what} was ordered at decision ${order.decision}` +
					(outcome.completed
						? ` and the executor reported it built${outcome.doneDate ? ` on ${outcome.doneDate}` : ""}`
						: " but no completion was observed before the run ended") +
					(outcome.observed && outcome.observed.length
						? `; the world then reported: ${outcome.observed.map((e) => e.kind).join(", ")}`
						: ""),
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

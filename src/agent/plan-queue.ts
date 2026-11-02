/**
 * Plan queue — run a comparison's cells, one after another.
 *
 * 职责: 把一份计划（若干格子：模型 × seed）**按顺序**跑完，并在过程中对外报告
 *   "现在跑到哪一格、已经跑完几格、哪一格失败了"。
 * 为什么需要它（Issue #48）：一个进程只能跑一局（端口与 session 会互相踩），
 *   所以矩阵**不能并行**；而"跑完一局接着跑下一局"这件事必须有人负责 ——
 *   否则 Compare 页发起的计划停在第一格，后面的人以为它跑完了。
 * 铁律:
 *   - **一格一局**：每格都是一次完整的 run（同一个 supervisor、同一个端口），
 *     格与格之间不共享任何状态。
 *   - **一格失败不吞**：失败的格子被记下来，后面的格子**继续跑**（一轮比较里
 *     一个 seed 挂掉不该毁掉整轮），但状态里写明"有几格失败"。
 *   - **不猜结果**：队列只报告"跑没跑完"，分数由 History / Compare 说。
 * 禁止: 在此做先决检查（preflight 的职责）；在此启动游戏（那是 runner 的职责）。
 */

import type { ComparePlanCell } from "./compare-plan.js";

/** The state of one cell. */
export type PlanCellStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** One cell as the page sees it. */
export interface PlanQueueCell extends ComparePlanCell {
	status: PlanCellStatus;
	/** Why the cell failed (empty otherwise). */
	error: string | null;
}

/** The queue's whole state (what the page polls). */
export interface PlanQueueState {
	/** idle: nothing queued; running: a plan is in flight; done/failed: finished. */
	status: "idle" | "running" | "done" | "failed";
	/** How many cells the plan had. */
	total: number;
	/** How many cells finished (done or failed). */
	completed: number;
	/** How many cells failed. */
	failed: number;
	/** The cell being run right now. */
	current: ComparePlanCell | null;
	/** Every cell with its status. */
	cells: PlanQueueCell[];
	/** The plan-level error (empty when the cells carried it). */
	error: string | null;
}

export interface PlanQueueOptions {
	/** Called on every state change (the page polls, so this is for the log). */
	onChange?: (state: PlanQueueState) => void;
}

/**
 * Run one cell. Must resolve when the cell's run has **finished** (not when it
 * starts) and throw when the cell could not run.
 */
export type PlanCellRunner = (cell: ComparePlanCell) => Promise<void>;

/**
 * A sequential runner for a comparison's cells.
 *
 * Why a class and not a function: the queue has a **lifecycle** (cells in
 * flight, failures, completion) that the page asks about while it runs.
 */
export class PlanQueue {
	private readonly opts: PlanQueueOptions;
	private state: PlanQueueState = {
		status: "idle",
		total: 0,
		completed: 0,
		failed: 0,
		current: null,
		cells: [],
		error: null,
	};
	private running = false;
	private runner: PlanCellRunner | null = null;
	private cancelRequested = false;
	private idleWaiters: Array<() => void> = [];

	constructor(opts: PlanQueueOptions) {
		this.opts = opts;
	}

	/** The current state (a copy: callers must not mutate it). */
	getState(): PlanQueueState {
		return {
			...this.state,
			cells: this.state.cells.map((c) => ({ ...c })),
			current: this.state.current ? { ...this.state.current } : null,
		};
	}

	/** Is a plan in flight? */
	isBusy(): boolean {
		return this.running;
	}

	/**
	 * Queue a plan and start running it.
	 *
	 * Throws when a plan is already in flight — two plans would interleave their
	 * cells on one game port, which is exactly the collision the supervisor
	 * exists to prevent.
	 */
	start(cells: ComparePlanCell[], run: PlanCellRunner): void {
		if (this.running) throw new Error("a comparison is already running");
		this.running = true;
		this.runner = run;
		this.cancelRequested = false;
		this.state = {
			status: "running",
			total: cells.length,
			completed: 0,
			failed: 0,
			current: null,
			cells: cells.map((c) => ({ ...c, status: "pending", error: null })),
			error: null,
		};
		this.publish();
		void this.drain();
	}

	/** Ask the queue to stop after the current cell. */
	cancel(): void {
		this.cancelRequested = true;
	}

	/** Wait until the queue is idle (no plan in flight). */
	waitForIdle(): Promise<void> {
		if (!this.running) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	private async drain(): Promise<void> {
		try {
			for (const cell of this.state.cells) {
				if (this.cancelRequested) {
					cell.status = "skipped";
					continue;
				}
				cell.status = "running";
				this.state.current = { model: cell.model, seed: cell.seed };
				this.publish();
				try {
					await this.runner?.({ model: cell.model, seed: cell.seed });
					cell.status = "done";
				} catch (e) {
					// One cell's failure must not end the comparison: the remaining
					// worlds are still worth running, and the state says what failed.
					cell.status = "failed";
					cell.error = e instanceof Error ? e.message : String(e);
					this.state.failed += 1;
				}
				this.state.completed += 1;
				this.state.current = null;
				this.publish();
			}
			this.state.status = this.state.failed > 0 ? "failed" : "done";
		} catch (e) {
			this.state.status = "failed";
			this.state.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.running = false;
			this.state.current = null;
			this.publish();
			const waiters = this.idleWaiters;
			this.idleWaiters = [];
			for (const w of waiters) w();
		}
	}

	private publish(): void {
		this.opts.onChange?.(this.getState());
	}
}

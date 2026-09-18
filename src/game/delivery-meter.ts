/**
 * Delivery meter — turns OpenTTD's *quarterly* `deliveredCargo` counter into a
 * cumulative, window-aligned one.
 *
 * 职责：把周期性收到的 `ServerCompanyEconomy.deliveredCargo`（`cur_economy`
 *   的当季计数器，u16，每季重置）积分为"本次 session 从开始到现在运出多少货"。
 * 禁止：任何 IO、任何策略判断。纯累加，输入是 (gameDay, delivered) 序列。
 *
 * 为什么需要它（SPEC §10.65）：该字段**每季度归零**，所以"运行结束那一刻的读
 * 数"实际测的是**随机一段部分季度**的交付量 —— 恰好跨过季界的运行会记 0（建成
 * 却"零交付"），其余运行则各自覆盖 0–90 游戏天不等。用它做 A/B 判据，方差里混
 * 进了"运气好落在哪一季"，两轮实验因此得出相反方向。积掉季界后，"运出多少货"
 * 才成为一个**可比**的观测量。
 *
 * 诚实边界：抽到缺失读数只损失分辨率（计数器在季内单调），不算不完整；但**漏掉
 * 整季**会丢失该季的货物，故计入 `gaps` 并使 `complete=false`，让调用方可以拒绝
 * 把不完整的读数当完整读数用。
 */

/** One quarter is three 30-day months in this project's game-day convention. */
export const QUARTER_DAYS = 90;

export interface DeliveryMeterStats {
	/** Readings that carried a usable number. */
	samples: number;
	/** Readings skipped because the counter was absent/non-finite. */
	missing: number;
	/** Quarter boundaries crossed with the previous quarter's total carried over. */
	quarterChanges: number;
	/** Counter restarts seen inside one quarter (poll replay / server resync). */
	resyncs: number;
	/** Journal breaks: at least one whole quarter elapsed unseen. */
	gaps: number;
	/** True when the accumulation covers the window with no quarter skipped. */
	complete: boolean;
}

export interface DeliveryMeter {
	observe(gameDay: number, delivered: number | null | undefined): void;
	/** Cumulative deliveries, or null while no usable reading has arrived. */
	total(): number | null;
	/** Per-quarter totals in order (the last entry is still open). */
	quarterTotals(): number[];
	stats(): DeliveryMeterStats;
}

export function createDeliveryMeter(quarterDays = QUARTER_DAYS): DeliveryMeter {
	let started = false;
	let lastValue = 0;
	let quarterIdx = 0;
	let finalized = 0;
	let gaps = 0;
	let resyncs = 0;
	let missing = 0;
	let samples = 0;
	let changes = 0;
	const perQuarter: number[] = [];

	const finalize = () => {
		finalized += lastValue;
		perQuarter.push(lastValue);
	};

	return {
		observe(gameDay, delivered) {
			if (delivered === null || delivered === undefined || !Number.isFinite(delivered)) {
				missing++;
				return;
			}
			const value = Math.max(0, delivered);
			if (!started) {
				started = true;
				lastValue = value;
				quarterIdx = Math.floor(gameDay / quarterDays);
				samples++;
				return;
			}
			const q = Math.floor(gameDay / quarterDays);
			if (q > quarterIdx) {
				finalize();
				changes++;
				if (q - quarterIdx > 1) gaps++;
				quarterIdx = q;
				lastValue = value;
			} else if (value < lastValue) {
				// Same quarter but the counter went backwards: the server restarted
				// it. Bank what we saw and start counting again from here.
				finalize();
				resyncs++;
				lastValue = value;
			} else if (value > lastValue) {
				lastValue = value;
			}
			samples++;
		},
		total() {
			return started ? finalized + lastValue : null;
		},
		quarterTotals() {
			return [...perQuarter, lastValue];
		},
		stats() {
			return {
				samples,
				missing,
				quarterChanges: changes,
				resyncs,
				gaps,
				complete: started && gaps === 0,
			};
		},
	};
}

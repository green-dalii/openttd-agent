/**
 * 归一化读数（ROADMAP 待办 #4）—— 能力轴的"真根"。
 *
 * 问题：能力轴量的是**总量**（`deliveredRun / 游戏日`），而总量 = 数量 × 单位产出。
 * 基准矩阵的结论"能力轴 not determinable"就是这个分解造成的：M2.5 有一局**什么都没建**
 * （0 交付），别的局建了 7 条线（446 交付）⇒ 方差由"建没建/建了几条"主导，
 * 而那是**建造策略**的方差，不是模型能力的方差。
 *
 * 归一化把"数量"除掉，回答"模型建的**一条线**能运多少、能赚多少"。
 *
 * 口径（铁律）：
 * - **分子用公司级读数**（`deliveredRun` 整局累计、`operatingProfit` 运营利润）——
 *   它们是干净的；不用逐线读数，因为逐线利润是"当年迄今"且历史上归属算错过
 *   （`MEMORY.md` D127）。
 * - **分母是干净的计数**：线路数（GS 登记的线路）、车辆数。
 * - **"没测到" ≠ 0**：分子或分母缺读数 ⇒ null（不可判定），不是 0。
 * - **"一条线都没建" ≠ 每线产出 0**：分母为 0 ⇒ null。这类局在**这条轴上不可比**
 *   （它答的是另一个问题："模型动手了吗"），必须被排除并说明，而不是记成 0。
 *
 * 禁止：把 null 折叠成 0；用总量冒充归一化；为"好看"改口径。
 */
import type { GameMetric } from "./metrics.js";

/** 一局的归一化读数（全为 null = 不可判定，绝不是 0）。 */
export interface NormalizedRun {
	/** 这局建了几条线（GS 登记的线路数）；null = 没测到。 */
	lines: number | null;
	/** 每条线的交付量（整局累计交付 ÷ 线路数）。 */
	deliveredPerLine: number | null;
	/** 每条线的运营利润（运营利润 ÷ 线路数）。 */
	operatingProfitPerLine: number | null;
	/** 每辆车的交付量。 */
	deliveredPerVehicle: number | null;
	/** 每辆车的运营利润。 */
	operatingProfitPerVehicle: number | null;
}

/** 除法，但守住两条纪律：缺读数 ⇒ null；分母为 0 ⇒ null。 */
function ratio(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
	if (typeof numerator !== "number" || !Number.isFinite(numerator)) return null;
	if (typeof denominator !== "number" || !Number.isFinite(denominator) || denominator <= 0) return null;
	return numerator / denominator;
}

/**
 * 一局的归一化读数。
 *
 * `lines` 缺读数（老局没记这个字段）⇒ **每线读数全为 null**（不可判定）。
 * 这不是"保守"，而是正确：分子有、分母没有，比值无从谈起。
 */
export function normalizeRun(m: GameMetric): NormalizedRun {
	const lines = typeof m.lines === "number" && Number.isFinite(m.lines) ? m.lines : null;
	const delivered = typeof m.deliveredRun === "number" && Number.isFinite(m.deliveredRun) ? m.deliveredRun : null;
	const operating =
		typeof m.operatingProfit === "number" && Number.isFinite(m.operatingProfit) ? m.operatingProfit : null;
	const vehicles = typeof m.vehicles === "number" && Number.isFinite(m.vehicles) ? m.vehicles : null;
	return {
		lines,
		deliveredPerLine: ratio(delivered, lines),
		operatingProfitPerLine: ratio(operating, lines),
		deliveredPerVehicle: ratio(delivered, vehicles),
		operatingProfitPerVehicle: ratio(operating, vehicles),
	};
}

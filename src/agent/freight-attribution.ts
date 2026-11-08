/**
 * 货运 F4 / A4：把「送到某产业的货」归到**我们的一条线**上。
 *
 * 职责: 纯函数——给「逐 (货种, 产业) 的交付读数」与「我们有哪些货运线、它们服务
 *   哪个收方产业」，算出**每条线运了多少**。
 * 为什么存在: 引擎**不记**"哪辆车把哪批货送进了哪个站"，脚本 API 也没有车站累计
 *   货物的函数 ⇒ 逐线路的数字**只能由我们自己推导**（`docs/PER-LINE-DELIVERY-FEASIBILITY.md`
 *   §4.1）。推导缺的不是算法，是**读数**（A3 让 GS 报逐 (货种, 产业) 的增量）与
 *   **线路的端点**（A3 让 GS 报线路两端的产业 id）。
 * 禁止: 任何猜测（按比例分摊、就近归属、"大概是这条线"）——分不出来就说分不出来。
 *
 * 归因规则（唯一的口径，`docs/PER-LINE-DELIVERY-FEASIBILITY.md` §4.2）:
 *   - 某个 **(货种, 收方产业)** 只被**我们的一条**线服务 ⇒ 那批货归这条线；
 *   - 被**多条**线服务 ⇒ **不可分摊** ⇒ 记 `null` + 说明；
 *   - **我们没有线**服务它 ⇒ 归不了（不是我们任何一条线的成果）。
 *
 * 事实来源: `docs/PER-LINE-DELIVERY-FEASIBILITY.md` §4.2；SPEC §10.126。
 */

/** 一条货运线（GS 报的端点 + 货种）。 */
export interface FreightLine {
	/** The route's job id (the ledger's key). */
	job: number;
	/** The cargo this line carries ("COAL", …); absent = the line's cargo is unknown. */
	cargo?: string;
	/** The producing industry (the line's start). */
	fromIndustry?: number;
	/** The consuming industry (the line's end) — **where the delivery lands**. */
	toIndustry?: number;
}

/** 一条逐 (货种, 产业) 的交付读数（GS 的 cargo monitor 累计）。 */
export interface FreightDeliveryReading {
	/** The cargo ("COAL", …). */
	label: string;
	/** The destination industry id. */
	industry: number;
	/** How much was delivered there (cumulative). */
	amount: number;
}

/** One route's attributed delivery. */
export interface FreightAttribution {
	/** The route's job id. */
	job: number;
	/** The cargo this line carries. */
	cargo: string;
	/**
	 * How much this line delivered — **null when it cannot be attributed**.
	 *
	 * null ≠ 0: null means "we cannot tell which line delivered it"; 0 means
	 * "this line really delivered nothing".
	 */
	amount: number | null;
	/** Why it is null (null when the amount is known). */
	reason: string | null;
	/**
	 * Always true: the amount is a **derived** figure, not an engine reading.
	 *
	 * The engine does not record which vehicle delivered what where, so this
	 * number comes from our own rule. Every report must say so.
	 */
	derived: true;
	/** The rule that produced this row ("unique service" / "shared service" / …). */
	basis: string;
}

/** A delivery that belongs to the company but to **none** of our routes. */
export interface FreightUnattributed {
	/** The cargo. */
	label: string;
	/** The destination industry. */
	industry: number;
	/** How much was delivered there. */
	amount: number;
	/** Why it cannot be attributed. */
	reason: string;
}

/** The whole attribution result. */
export interface FreightAttributionResult {
	/** One row per line we know (in the order the lines were given). */
	routes: FreightAttribution[];
	/**
	 * Deliveries that no route of ours accounts for.
	 *
	 * Why they must be reported: the company delivered them, but the delivery
	 * landed at an industry that none of our routes serves (or landed there in
	 * a way we cannot tie to a route) ⇒ **dropping them silently** would make
	 * the attributed total look like the company total.
	 */
	unattributed: FreightUnattributed[];
}

/**
 * Attribute the deliveries to our freight lines.
 *
 * The lines are considered in the order given; the result follows that order,
 * so the report and the page list the routes the same way.
 */
export function attributeFreightDeliveries(
	readings: FreightDeliveryReading[],
	lines: FreightLine[],
): FreightAttributionResult {
	const rs = Array.isArray(readings) ? readings : [];
	const ls = Array.isArray(lines) ? lines : [];

	// Which of our lines serve which (cargo, destination industry)?
	const services = new Map<string, FreightLine[]>();
	for (const l of ls) {
		if (l.toIndustry === undefined || !Number.isInteger(l.toIndustry)) continue;
		const cargo = String(l.cargo ?? "");
		if (cargo === "") continue;
		const key = `${cargo}#${l.toIndustry}`;
		const list = services.get(key);
		if (list) list.push(l);
		else services.set(key, [l]);
	}

	// The delivered amount per (cargo, industry).
	const delivered = new Map<string, number>();
	for (const r of rs) {
		if (!r || typeof r.label !== "string" || r.label === "") continue;
		if (!Number.isInteger(r.industry)) continue;
		const amount = Number(r.amount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		const key = `${r.label}#${r.industry}`;
		delivered.set(key, (delivered.get(key) ?? 0) + amount);
	}

	// **没有任何读数 ⇒ 什么都没测到** ⇒ 没有归因结果（不是「每条线都是 0」）。
	// 区分：读数**在**，但没有某条线的份 ⇒ 那条线是 0（真的读数，见下）。
	if (delivered.size === 0) return { routes: [], unattributed: [] };

	const routes: FreightAttribution[] = ls.map((l) => {
		const cargo = String(l.cargo ?? "");
		const to = l.toIndustry;
		const key = to !== undefined && Number.isInteger(to) ? `${cargo}#${to}` : "";
		const candidates = key === "" ? [] : (services.get(key) ?? []);
		const amount = key === "" ? undefined : delivered.get(key);

		if (candidates.length === 0) {
			return {
				job: l.job,
				cargo,
				amount: null,
				reason:
					to === undefined || !Number.isInteger(to)
						? "the line has no industry endpoints (it is not a freight line)"
						: `no route of ours serves ${cargo} at industry ${to}`,
				derived: true as const,
				basis: "no route of ours serves this",
			};
		}
		if (candidates.length > 1) {
			const jobs = candidates.map((c) => c.job).join(", ");
			return {
				job: l.job,
				cargo,
				amount: null,
				reason: `${candidates.length} routes share ${cargo} at industry ${to} (jobs ${jobs}) - the delivery cannot be split between them`,
				derived: true as const,
				basis: "shared service",
			};
		}
		// Exactly one of our lines serves it ⇒ the delivery is that line's.
		// A missing reading means it delivered nothing (0 is a real reading).
		return {
			job: l.job,
			cargo,
			amount: amount ?? 0,
			reason: null,
			derived: true as const,
			basis: "unique service",
		};
	});

	// The deliveries that no route of ours accounts for.
	const attributed = new Set<string>();
	for (const l of ls) {
		if (l.toIndustry === undefined || !Number.isInteger(l.toIndustry)) continue;
		const cargo = String(l.cargo ?? "");
		if (cargo === "") continue;
		const key = `${cargo}#${l.toIndustry}`;
		// A shared service is *not* attributed ⇒ its delivery stays unattributed.
		if ((services.get(key) ?? []).length === 1) attributed.add(key);
	}
	const unattributed: FreightUnattributed[] = [];
	for (const [key, amount] of delivered) {
		if (attributed.has(key)) continue;
		const [label, industryText] = key.split("#");
		const industry = Number(industryText);
		const served = (services.get(key) ?? []).length;
		unattributed.push({
			label: String(label),
			industry,
			amount,
			reason:
				served === 0
					? `no route of ours serves ${label} at industry ${industry}`
					: `${served} routes share ${label} at industry ${industry} - the delivery cannot be split between them`,
		});
	}
	unattributed.sort((a, b) => b.amount - a.amount);

	return { routes, unattributed };
}

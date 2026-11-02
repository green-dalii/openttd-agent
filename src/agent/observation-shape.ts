/**
 * Observation shape fingerprint — "which surface did the model see?".
 *
 * 职责: 给**模型可见的观测面**算一枚**跨 seed 稳定**的指纹：投影的结构（有哪些事实、
 *   什么类型），不是它的值。
 * 为什么需要它（Issue #48 之后才暴露的问题）:
 *   - `scaffoldHash` 覆盖**提示词 + 工具 schema**，**不覆盖观测面** —— 观测面变了，
 *     两局看的仍是同一副脚手架，却**不是同一个问题**（§10.121 的"比较的是同一个问题"）。
 *   - `payloadShapeHash` 覆盖真实请求，但它**含世界**（城镇名、产业清单）⇒ **跨 seed
 *     必然不同** ⇒ 拿它跨局比较会**误报**"不是同一个问题"（假警报比没警报更坏）。
 *   ⇒ 于是需要第三枚指纹：**结构**指纹。它只依赖投影代码，**跑前就能算**，
 *     两局只要结构一样就是"同一个问题"，哪怕它们跑在不同 seed 上。
 *
 * 铁律:
 *   - **只取结构，不取值**：数值、名字、坐标全部抹掉（否则又变成 seed 依赖）。
 *   - **由探针算出**：用一个**填满所有分支**的探针世界跑一遍投影，取结果的形状 ——
 *     于是"投影多了/少了一个字段"必然改变指纹，而"世界里多了一座城"不会。
 *   - **缺失照旧是 null**：没算出来就是"没测到"，不是"结构为空"。
 *
 * 事实来源: SPEC §10.121；docs/SCAFFOLD-CONTRACT.md §7.1。
 * 禁止: 在此比较两局的**值**（那是别的事实，且值本来就该不同）。
 */

import { createHash } from "node:crypto";

/**
 * The **shape** of a value: its structure with every leaf replaced by its type.
 *
 * Arrays keep the shape of their first element (the probe fills them) but not
 * their length - "how many towns" is a fact about the world, not about the
 * observation surface.
 */
export function shapeOf(value: unknown): unknown {
	if (value === null || value === undefined) return "null";
	if (Array.isArray(value)) {
		return value.length === 0 ? [] : [shapeOf(value[0])];
	}
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) out[key] = shapeOf(obj[key]);
		return out;
	}
	return typeof value;
}

/** JSON with sorted keys, so the fingerprint cannot depend on key order. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
		.join(",")}}`;
}

/**
 * The fingerprint of an observation surface (a projected world).
 *
 * Same input structure ⇒ same hash, on any machine and any seed.
 */
export function observationShapeHash(facts: unknown): string {
	const shape = stableStringify(shapeOf(facts));
	return createHash("sha256").update(`observation:${shape}`, "utf8").digest("hex").slice(0, 16);
}

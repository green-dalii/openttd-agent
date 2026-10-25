/**
 * Payload shape hash — "the same request, apart from the numbers".
 *
 * 职责: 把一次真实请求（provider payload）里的**每个数值**归一化，再对结果取指纹。
 * 为什么需要: `payloadHash`（D6b）把数值也算进去，而世界状态本来就带随机数
 *   （钱、人口、日期、坐标）——于是**同一套脚手架在不同 seed 上必然是不同哈希**，
 *   "两条后端发出的请求相同" 这句话就永远无法被检验。
 *   归一化之后，相等意味着：结构、顺序、所有文案逐字相同，只有世界数值不同。
 * 判据: 相等 ⇒ 脚手架相同；不等 ⇒ 至少有一处文案/结构/顺序不同（这才是要抓的）。
 * 禁止: 猜测语义（不排序对象键以外的东西、不丢弃字段、不把 0 当缺失）。
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./scaffold-fingerprint.js";

/** Numeric runs in a string (integers, decimals) → a single placeholder. */
const NUMERIC_RUN = /\d+(?:\.\d+)?/g;

/**
 * Zero numbers and blank numeric runs in text.
 *
 * 为什么连文本里的数字也要抹: 本仓库的观测面是**文本块**（"money 199214"、"1950-01-15"），
 * 数值不走 JSON 数字。只归一化 JSON 数字的话，跨 seed 的哈希永远不会相等 —— 于是
 * "两条后端问了同一个问题" 依旧不可检验。
 * 代价（必须写明）: 两个只在数字上不同的**脚手架**也会被这份哈希视为相同。这不出事，
 * 因为系统提示词与工具 schema 的权威指纹是 `scaffoldHash`；本哈希只回答"除数值外
 * 是否同一问句"。
 */
export function normalizePayloadNumbers(value: unknown): unknown {
	if (typeof value === "number") return 0;
	if (typeof value === "string") return value.replace(NUMERIC_RUN, "#");
	if (Array.isArray(value)) return value.map(normalizePayloadNumbers);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = normalizePayloadNumbers(v);
		}
		return out;
	}
	return value;
}

/**
 * Fingerprint of the payload's shape (first 16 hex chars of sha256).
 *
 * Same model, same scaffold, different seed ⇒ same shape hash. Any difference in
 * wording, ordering or field set changes it, which is exactly the signal that
 * the two runs were not answering the same question.
 */
export function payloadShapeHash(payload: unknown): string {
	const shaped = stableStringify(normalizePayloadNumbers(payload));
	return createHash("sha256").update(shaped).digest("hex").slice(0, 16);
}

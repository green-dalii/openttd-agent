/**
 * BigInt-safe JSON helpers.
 *
 * 职责: 统一事件/日志/审计的 JSON 序列化。OpenTTD 经济字段是 u64
 *   (money/loan/income/companyValue), JS number 会丢精度, 内存中走 BigInt。
 *   BigInt 序列化为十进制字符串 (无 "n" 后缀) —— 便于 WS/JSONL/浏览器展示。
 * 事实来源: SPEC v0.1.0 spike —— economy payload 实测含 BigInt。
 * 禁止: 在事件/日志路径上直接 JSON.stringify (会抛 "Do not know how to
 *   serialize a BigInt")。
 */

/**
 * JSON.stringify with BigInt support.
 * BigInt -> decimal string; 其它值原样。
 */
export function stringifyJson(value: unknown, space?: number | string): string {
	return JSON.stringify(value, bigintReplacer, space);
}

function bigintReplacer(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? value.toString() : value;
}

/**
 * 供浏览器/日志把 BigInt 序列化产物里的十进制金额字符串转回可显示数字。
 * 展示用途: 超出 Number.MAX_SAFE_INTEGER 会失真, 但 OpenTTD 实际金额远小于
 * 2^53, 显示安全。若需精确计算请保持字符串/走 BigInt。
 */
export function bigintStrToNumber(s: string | number | bigint | undefined | null): number {
	if (s === undefined || s === null) return 0;
	if (typeof s === "number") return Number.isFinite(s) ? s : 0;
	if (typeof s === "bigint") return Number(s);
	const n = Number(s);
	return Number.isFinite(n) ? n : 0;
}

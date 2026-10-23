/**
 * Scaffold fingerprint (D3b / S9) — "which scaffold produced this run?".
 *
 * 职责: 给**脚手架**（系统提示词 + 工具集合）算一个稳定指纹，写进每一局的
 * manifest。基准评测的前提是"两局看到的是同一套脚手架"——没有指纹，这句话
 * 无法证明。
 * 为什么是指纹而不是文件 hash: 指纹算的是**真正发给模型的东西**（提示词与
 * 工具 schema），不是仓库里某个文件——文件可以没被用到，提示词可以拼装。
 * 铁律: 顺序是契约的一部分（工具顺序变了就是另一套脚手架）。
 */

import { createHash } from "node:crypto";

/** The parts of a tool that reach the model. */
export interface FingerprintableTool {
	name: string;
	description?: string;
	parameters?: unknown;
}

/**
 * A stable fingerprint of the scaffold: sha256 over the system prompt and the
 * tool set (name, description, schema) in order.
 */
export function scaffoldHash(systemPrompt: string, tools: readonly FingerprintableTool[]): string {
	const parts = [
		`prompt:${systemPrompt}`,
		...tools.map((t) => `tool:${t.name}|${t.description ?? ""}|${stableStringify(t.parameters)}`),
	];
	return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex").slice(0, 16);
}

/** JSON with object keys sorted, so key order cannot change the fingerprint. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

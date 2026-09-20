import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/run.js";

describe("--freeze 解析（SPEC §10.59）", () => {
	it("--freeze → true", () => {
		expect(parseArgs(["--agent", "--freeze"]).freeze).toBe(true);
	});
	it("不给 → false（默认不暂停）", () => {
		expect(parseArgs(["--agent"]).freeze).toBe(false);
	});
});

describe("v02 --add-vehicles 解析（baseline probe 用，2026-09-17）", () => {
	it("--add-vehicles N 解析为数字", () => {
		expect(parseArgs(["--v02", "--add-vehicles", "20"]).addVehicles).toBe(20);
	});
	it("不给则不出现", () => {
		expect((parseArgs(["--v02"]) as unknown as { addVehicles?: number }).addVehicles).toBeUndefined();
	});
	it("非整数报错", () => {
		expect(() => parseArgs(["--v02", "--add-vehicles", "abc"])).toThrow();
	});

	/**
	 * M3-1（2026-09-19）：`--shrink-to` 是双向探针的入口。
	 *
	 * 这里只锁**解析**（行为由真机探针量）。理由：本项目为"门禁看得到、runner 收不到"
	 * 付过代价（MEMORY A5）——新 flag 必须同时被解析**并**被转发到 v02 参数对象。
	 */
	it("--shrink-to 被解析", () => {
		expect(parseArgs(["--v02", "--add-vehicles", "12", "--shrink-to", "4"]).shrinkTo).toBe(4);
	});
	it("--shrink-to 不给则不出现", () => {
		expect((parseArgs(["--v02"]) as unknown as { shrinkTo?: number }).shrinkTo).toBeUndefined();
	});
	it("--shrink-to 非整数报错", () => {
		expect(() => parseArgs(["--v02", "--shrink-to", "abc"])).toThrow();
	});
});

/**
 * CLI 开关"解析了但没接线"的机械守卫。
 *
 * 真实事故（2026-09-19，M3-2c）：`--second-route` 在 `switch` 里被解析、也传给了 v02，
 * 但**没有出现在 `parseArgs` 的返回值里** → `args.secondRoute` 恒为 undefined →
 * 探针静默不执行。症状是"跑了一局真机、探针一句话都没打印"，而**没有任何报错**。
 * 这类缺陷本仓库已出现三次（shrink 探针、`--second-route`、以及更早的 eslint 抓到的
 * "声明但没用"），所以它值得一条守卫。
 */
describe("CLI：每个在 switch 里被赋值的开关都必须出现在 parseArgs 的返回值里", () => {
	const src = readFileSync("src/cli/run.ts", "utf8");

	/** 从 `return {` 开始按花括号配平取出返回块（不能用 indexOf 猜结尾——猜不到会切到文件末尾，
	 *  于是"返回集合"包含整个文件的标识符，守卫静默失效；第一版就是这样，重放没红）。 */
	function returnBlock(text: string): string | null {
		const at = text.indexOf("return {");
		if (at < 0) return null;
		let depth = 0;
		for (let i = text.indexOf("{", at); i < text.length; i++) {
			if (text[i] === "{") depth++;
			else if (text[i] === "}") {
				depth--;
				if (depth === 0) return text.slice(at, i + 1);
			}
		}
		return null;
	}

	/** switch 的 case 里被赋值的变量名。 */
	function assignedInCases(text: string): string[] {
		const out = new Set<string>();
		for (const m of text.matchAll(/case "--[a-z0-9-]+":\s*\n\s*([A-Za-z_]\w*)\s*=/g)) out.add(m[1]!);
		for (const m of text.matchAll(/case "--[a-z0-9-]+":\s*\n\s*[A-Za-z_]\w*\s*=\s*\n?\s*[A-Za-z_]\w*([A-Za-z_]\w*)\s*=/g))
			out.add(m[1]!);
		return [...out];
	}

	it("抽取器有效（自测：人造样本必须能找到缺失的开关）", () => {
		const sample = 'a = 1;\n\t\tcase "--x":\n\t\t\tlater = true;\n\t\t\tbreak;\n\treturn {\n\t\ta,\n\t};';
		const block = returnBlock(sample);
		expect(block).toContain("a,");
		const assigned = assignedInCases(sample);
		expect(assigned).toContain("later");
		const returned = new Set([...block!.matchAll(/([A-Za-z_]\w*)\s*[,:]/g)].map((m) => m[1]!));
		expect(returned.has("later")).toBe(false);
	});

	it("没有「解析了但没返回」的开关", () => {
		const block = returnBlock(src);
		expect(block, "找不到 parseArgs 的返回块：守卫无法工作，必须修守卫而不是放过").not.toBeNull();
		const returned = new Set([...block!.matchAll(/([A-Za-z_]\w*)\s*[,:]/g)].map((m) => m[1]!));
		const missing = assignedInCases(src).filter((v) => !returned.has(v));
		expect(missing, "这些开关被解析但没进 args：探针会静默不执行").toEqual([]);
	});
});

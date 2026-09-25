/**
 * 执行器错误分块：让**完整**错误文本到达事件流。
 *
 * 职责：锁定 {`exc<seq><marker><chunk>` 相位 → 完整消息} 的语法与装配规则，
 * 以及生产端不再预截断（源码级守卫——Squirrel 在这里无法真机跑）。
 * 禁止：在此断言"agent 该怎么做"。这里只验证**通道是否忠实**。
 *
 * 为什么需要（2026-09-25 真机）：一个 run 卡住时公司名只显示
 * `EX exc:can't execute over an un…`、车辆 0。错误文本在**生产端**被
 * `if (es.len() > 24) es = es.slice(0, 24);` 砍掉，而公司名上限 31 字符
 * （实测：31 接受，32+ 静默拒绝）——一条错误永远放不进一个名字。项目已实测并排除
 * 另外两条通道（AILog 在 macOS dedicated 0 输出，SPEC §10.10；AISign 建的标牌 GS 看不到），
 * 所以错误只能分块经公司名上报。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeSignalHub, type SignalHubRefs } from "../../src/agent/signal-hub.js";
import type { GameEvent } from "../../src/types.js";
import {
	createExecutorErrorAssembler,
	decodeExecutorErrorChunk,
	decodeExecutorPhase,
	isErrorPhase,
} from "../../src/game/executor-status.js";

/** 真实事故文本（`/tmp` 真机相位 `EX exc:can't execute over an un…` 的来源）。 */
const INCIDENT = "can't execute over an unfinished action";

/**
 * 复刻生产端 `ReportError` 的切片（`width`、5 块上限、末块让 1 字符给 `~`），
 * 用来造**真实形状**的相位——手写臆想的格式正是这个仓库栽过的坑。
 */
function chunkPhases(message: string, width: number): string[] {
	const chunks: string[] = [];
	for (let n = 0; n < 5 && n * width < message.length; n++) {
		chunks.push(message.slice(n * width, n * width + width));
	}
	if (chunks.length === 0) chunks.push("");
	const truncated = chunks.length * width < message.length;
	if (truncated) chunks[chunks.length - 1] = chunks[chunks.length - 1]!.slice(0, width - 1);
	return chunks.map((c, i) => {
		const last = i === chunks.length - 1;
		const marker = last ? (truncated ? "~" : "=") : ":";
		// 完整公司名：`EX <phase> j<job>`（harness 拿到的是这条 raw）。
		return `EX exc${i + 1}${marker}${c} j102`;
	});
}

/** 去掉注释：被测的字面量在注释里也出现过，不剥离就会误报（也会漏报）。 */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 取一个 Squirrel 函数的函数体（class 内缩进 4 空格，闭合括号同为 4 空格）。 */
function functionBody(src: string, name: string): string {
	const start = src.indexOf("function " + name + "(");
	if (start < 0) return "";
	const end = src.indexOf("\n    }", start);
	return end < 0 ? src.slice(start) : src.slice(start, end);
}

describe("executor-error-chunks: 分块相位解码", () => {
	it("`exc1:foo` 是第 1 块、还有后续块", () => {
		expect(decodeExecutorErrorChunk("exc1:foo")).toEqual({
			seq: 1,
			final: false,
			truncated: false,
			chunk: "foo",
		});
	});

	it("`exc2=bar` 是末块、消息完整", () => {
		expect(decodeExecutorErrorChunk("exc2=bar")).toEqual({
			seq: 2,
			final: true,
			truncated: false,
			chunk: "bar",
		});
	});

	it("`exc3~baz` 是末块且被生产端截断", () => {
		expect(decodeExecutorErrorChunk("exc3~baz")).toEqual({
			seq: 3,
			final: true,
			truncated: true,
			chunk: "baz",
		});
	});

	it("块文本里的空格与标点原样保留（它们就是消息本身）", () => {
		const d = decodeExecutorErrorChunk("exc2=over an unfinished action");
		expect(d && d.chunk).toBe("over an unfinished action");
	});

	it("非分块相位一律 null（不猜）", () => {
		for (const s of [
			"exc:boom", // 整条诊断（没有 seq/marker）
			"exc12:foo", // 两位数不是本语法（生产端最多 5 块）
			"exc1 foo", // 缺 marker
			"hb road #3",
			"rd s0 r0",
			"",
			"EX ",
		]) {
			expect(decodeExecutorErrorChunk(s), s).toBeNull();
		}
	});

	it("接受整条公司名（signal-hub 转发的就是 raw）", () => {
		expect(decodeExecutorErrorChunk("EX exc1:foo j102")?.seq).toBe(1);
		expect(decodeExecutorErrorChunk("EX exc1:foo j102")?.chunk).toBe("foo");
		// 只有 ` j<数字>` 才算作业号后缀：块文本里的 " j…" 不能被切掉。
		expect(decodeExecutorErrorChunk("EX exc1:can't join the j102 j102")?.chunk).toBe(
			"can't join the j102",
		);
	});
});

describe("executor-error-chunks: decodeExecutorPhase 认得分块相位", () => {
	it("分块 → stage error + error=true，块字段进 detail", () => {
		const d = decodeExecutorPhase("EX exc2=te over an unf j100");
		expect(d.stage).toBe("error");
		expect(d.error).toBe(true);
		expect(d.job).toBe(100);
		expect(d.phase).toBe("exc2=te over an unf");
		expect(d.detail).toMatchObject({ seq: 2, chunk: "te over an unf", final: 1, truncated: 0 });
		expect(d.description).toContain("te over an unf");
	});

	it("末块被截断时描述里说清楚（事实，不是猜测）", () => {
		const d = decodeExecutorPhase("EX exc1~can't execute over");
		expect(d.stage).toBe("error");
		expect(d.detail).toMatchObject({ truncated: 1 });
		expect(d.description).toContain("cut the message short");
	});

	it("整条 `exc:` 分支照旧工作", () => {
		const d = decodeExecutorPhase("EX exc:boom j100");
		expect(d.stage).toBe("error");
		expect(d.error).toBe(true);
		expect(d.detail).toMatchObject({ message: "boom" });
	});

	it("isErrorPhase 对分块也成立（错误不能因为换了写法而被降级）", () => {
		expect(isErrorPhase("EX exc1:can't execute over")).toBe(true);
		expect(isErrorPhase("EX exc2=te over an unf")).toBe(true);
		expect(isErrorPhase("EX exc:boom")).toBe(true);
		expect(isErrorPhase("EX hb road #3")).toBe(false);
	});
});

describe("executor-error-chunks: 装配器", () => {
	it("按序拼接，末块才产出消息", () => {
		const asm = createExecutorErrorAssembler();
		expect(asm.push("exc1:can't execute ove", 1000)).toBeNull();
		expect(asm.push("exc2:r an unfinished a", 1100)).toBeNull();
		expect(asm.push("exc3=ction", 1200)).toEqual({
			message: INCIDENT,
			truncated: false,
			complete: true,
		});
	});

	it("按真实宽度 17 切开的 39 字符事故文本逐字拼回（契约写 41，真实文本是 39）", () => {
		// 39 = len("can't execute over an unfinished action")；width 17 下两种长度都是 3 块，
		// 断言等价，而用**真实**文本比凑一个 41 字符的臆想字符串更有价值。
		expect(INCIDENT.length).toBe(39);
		const phases = chunkPhases(INCIDENT, 17);
		expect(phases).toHaveLength(3);
		expect(phases[0]).toBe("EX exc1:can't execute ove j102");
		expect(phases[2]).toBe("EX exc3=ction j102");
		const asm = createExecutorErrorAssembler();
		const results = phases.map((p, i) => asm.push(p, 1000 + i * 100));
		expect(results[results.length - 1]).toEqual({
			message: INCIDENT,
			truncated: false,
			complete: true,
		});
	});

	it("接受到裸相位（不经公司名包装）", () => {
		const asm = createExecutorErrorAssembler();
		expect(asm.push("exc1:foo", 1000)).toBeNull();
		expect(asm.push("exc2=bar", 1100)).toEqual({
			message: "foobar",
			truncated: false,
			complete: true,
		});
	});

	it("`~` 末块 → truncated（不完整必须被说出来）", () => {
		const asm = createExecutorErrorAssembler();
		// width 5：39 字符要 8 块 → 生产端的 5 块上限真的吃掉了尾部。
		const phases = chunkPhases(INCIDENT, 5);
		expect(phases).toHaveLength(5);
		expect(phases[4]).toContain("~");
		const results = phases.map((p, i) => asm.push(p, 1000 + i * 100));
		const out = results[results.length - 1];
		expect(out?.truncated).toBe(true);
		expect(out?.complete).toBe(true);
		expect(out?.message.length).toBeLessThan(INCIDENT.length);
		expect(INCIDENT.startsWith(out?.message ?? "")).toBe(true);
	});

	it("跳号（gap）丢弃缓冲，且绝不吐出半句", () => {
		const asm = createExecutorErrorAssembler();
		expect(asm.push("exc1:can't execute ove", 1000)).toBeNull();
		expect(asm.push("exc3=ction", 1100)).toBeNull(); // seq 3 而我们只到 1 → 缺字
		expect(asm.push("exc2:r an unfinished a", 1200)).toBeNull();
		expect(asm.push("exc3=ction", 1300)).toBeNull(); // 已经被丢弃，不能接着拼
		// 之后必须从 seq 1 重新开始才算一条消息。
		expect(asm.push("exc1:a", 1400)).toBeNull();
		expect(asm.push("exc2=b", 1500)).toEqual({ message: "ab", truncated: false, complete: true });
	});

	it("重复块也丢弃（重复的字符比缺字更不可信）", () => {
		const asm = createExecutorErrorAssembler();
		expect(asm.push("exc1:a", 1000)).toBeNull();
		expect(asm.push("exc2:b", 1100)).toBeNull();
		expect(asm.push("exc2:c", 1200)).toBeNull(); // seq 2 重复 → 丢弃缓冲，且不吐半句
		expect(asm.push("exc3=d", 1300)).toBeNull(); // 已丢弃，不能接着拼
		expect(asm.push("exc1:e", 1400)).toBeNull();
		expect(asm.push("exc2=f", 1500)).toEqual({
			message: "ef",
			truncated: false,
			complete: true,
		});
	});

	it("seq 1 重启：新错误替换旧队列", () => {
		const asm = createExecutorErrorAssembler();
		expect(asm.push("exc1:old message part one", 1000)).toBeNull();
		expect(asm.push("exc1:new message", 1100)).toBeNull(); // 重启，不是接在旧消息后面
		expect(asm.push("exc2=!", 1200)).toEqual({
			message: "new message!",
			truncated: false,
			complete: true,
		});
	});

	it("非分块相位不动缓冲区（心跳天天在发，不能当间隔）", () => {
		const asm = createExecutorErrorAssembler();
		expect(asm.push("exc1:can't execute ove", 1000)).toBeNull();
		expect(asm.push("EX hb road #42 s3 j102", 1100)).toBeNull();
		expect(asm.push("EX rd s0 r0 j102", 1200)).toBeNull();
		// 两条非分块相位夹在中间，缓冲区原样保留：第 2 块的 `=` 直接拼成完整消息。
		expect(asm.push("exc2=r an unfinished a", 1300)).toEqual({
			message: "can't execute over an unfinished a",
			truncated: false,
			complete: true,
		});
	});

	it("残块超过 30 s 被丢弃（两个错误的块拼在一起会造出假因果）", () => {
		const asm = createExecutorErrorAssembler();
		expect(asm.push("exc1:can't execute ove", 1000)).toBeNull();
		// 30 001 ms 后：残块过期 → 丢弃，且没有 seq 1 就不能算一条消息。
		expect(asm.push("exc2=r an unfinished a", 31_001)).toBeNull();
		expect(asm.push("exc3=ction", 31_100)).toBeNull();
		// 新的错误照常可以拼完整。
		expect(asm.push("exc1:fresh ", 31_200)).toBeNull();
		expect(asm.push("exc2=error", 31_300)).toEqual({
			message: "fresh error",
			truncated: false,
			complete: true,
		});
	});

	it("reset() 丢掉残块", () => {
		const asm = createExecutorErrorAssembler();
		expect(asm.push("exc1:a", 1000)).toBeNull();
		asm.reset();
		expect(asm.push("exc2=b", 1100)).toBeNull();
		expect(asm.push("exc1:a", 1200)).toBeNull();
		expect(asm.push("exc2=b", 1300)).toEqual({ message: "ab", truncated: false, complete: true });
	});
});

describe("executor-error-chunks: 源码守卫（Squirrel 在这里不可单测）", () => {
	const nut = stripComments(readFileSync("src/game/squirrel/executor-ai/main.nut", "utf8"));
	const gs = readFileSync("src/game/squirrel/bridge-gs/main.nut", "utf8");

	it("生产端不再预截断错误（旧的 slice(0, 24) 与 24 字符上限都没了）", () => {
		expect(nut).not.toContain("es.slice(0, 24)");
		expect(nut).not.toMatch(/es\.len\(\)\s*>\s*24/);
	});

	it("错误改走分块汇报：存在 ReportError，且 catch 调它", () => {
		expect(nut).toContain("function ReportError(");
		expect(nut).toContain("this.ReportError(es)");
	});

	it("分块宽度来自真实的 31 字符预算，并有下限与 5 块上限", () => {
		expect(nut).toContain("local width = 31 - 3 - 3 - 1 - 1 - (2 + (\"\" + this._job).len())");
		expect(nut).toContain("if (width < 4) width = 4;");
		expect(nut).toContain("while (n < 5 && n * width < es.len())");
	});

	it("相位写成 `exc<seq><marker><chunk>`，且错误文本先被净化", () => {
		expect(nut).toContain("this.WritePhase(\"exc\" + seq + marker");
		expect(nut).toContain("function SanitiseError(");
	});

	it("分块跨轮推进（每 5 轮一块），复用粘滞机制防止被覆盖", () => {
		expect(nut).toContain("function AdvanceErrorChunks()");
		expect(nut).toMatch(/this\._phaseHoldUntil = this\._loopSeq \+ 5;/);
		expect(nut).toContain("this.AdvanceErrorChunks();");
	});

	it("Bridge 的 ParseExecPhase 把 `exc<digit><marker>` 映射成带序号的 stage（否则指纹会抑制后续块）", () => {
		const body = functionBody(gs, "ParseExecPhase");
		expect(body.length).toBeGreaterThan(100);
		expect(body).toContain('stage = "error" + s.slice(3, 4)');
		// 整条 `exc:` → "error" 的旧映射必须保留。
		expect(body).toContain('else if (s.slice(0, 3) == "exc") stage = "error";');
	});

	it("页面消费错误字段，并显示截断标记（缺失时只是空串，不抛）", () => {
		const live = readFileSync("src/web/public/assets/js/live.js", "utf8");
		expect(live).toContain("this.executorError = s.executorError");
		expect(live).toContain("executorErrorText()");
		expect(live).toContain("…truncated");
	});
});

/**
 * 接线守卫（父 agent 补）：分块语法与装配器单测只能证明"零件对"，
 * 这一段证明**真的接上了** —— GS 的 `exec` 事件（带 `raw` 公司名）喂进 hub 之后，
 * `getExecutorError()` 必须给出**完整**消息。§10.101 的教训正是"契约对、机制没接"。
 */
describe("W3 接线：hub 把分块拼成完整消息", () => {
	function makeHub() {
		return makeSignalHub({
			world: { snapshot: () => ({ date: null }), ingest: () => {}, setTowns: () => {}, setIndustries: () => {}, setCargoTotals: () => {}, setCompanyCargo: () => {} },
			getWeb: () => null,
			getSession: () => null,
			routeLedger: { record: () => {}, all: () => [], markDone: () => {} },
			getDecisionCount: () => 0,
			onPhaseChange: () => {},
			onNotableEvent: () => {},
		} as unknown as SignalHubRefs);
	}

	function exec(raw: string): GameEvent {
		return { seq: 1, kind: "gamescript", ts: Date.now(), payload: { kind: "exec", raw, stage: "error1", job: 100 } } as unknown as GameEvent;
	}

	it("真机原文分 3 块 → getExecutorError 给出原句（不是 24 字符截断）", () => {
		const hub = makeHub();
		const raw = "can't execute over an unfinished action";
		const width = 17;
		const chunks: string[] = [];
		for (let i = 0; i < raw.length; i += width) chunks.push(raw.slice(i, i + width));
		chunks.forEach((c, i) => {
			const last = i === chunks.length - 1;
			hub.onEvent(exec(`EX exc${i + 1}${last ? "=" : ":"}${c} j100`));
		});
		const e = hub.getExecutorError();
		expect(e).not.toBeNull();
		expect(e!.message).toBe(raw);
		expect(e!.truncated).toBe(false);
		expect(typeof e!.at).toBe("number");
	});

	it("只到一半（末块没来）→ getExecutorError 仍是 null（不把半句话当消息）", () => {
		const hub = makeHub();
		hub.onEvent(exec("EX exc1:can't execute over j100"));
		expect(hub.getExecutorError()).toBeNull();
	});

	it("生产端截断（~）→ truncated=true，文本仍然完整拼接（标明不完整，不假装完整）", () => {
		const hub = makeHub();
		hub.onEvent(exec("EX exc1:aaaaaaaaaaaaaaa: j100"));
		hub.onEvent(exec("EX exc2~bbbbbbbbbbbbbbb j100"));
		const e = hub.getExecutorError();
		expect(e!.truncated).toBe(true);
		expect(e!.message).toBe("aaaaaaaaaaaaaaa:bbbbbbbbbbbbbbb");
	});

	it("块文本里的 ' j' 不会被当成作业号后缀（'cannot join' 不能粘成 'cannotjoin'）", () => {
		const hub = makeHub();
		hub.onEvent(exec("EX exc1:the company cannot j j100"));
		hub.onEvent(exec("EX exc2=oin the j100"));
		expect(hub.getExecutorError()!.message).toBe("the company cannot join the");
	});
});

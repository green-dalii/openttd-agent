/**
 * The causal timeline — one row per decision, four pieces of evidence joined by `job`.
 *
 * 职责: 把**一次决策的因果链**汇成一行：决策（触发/时刻/目标）→ 工具调用（结果）→
 *   GS job/相位 → 效果（本窗口的增量）。这是 B3 的服务端事实（docs/DASHBOARD-CODESIGN.md §4.1）。
 * 为什么需要: 一个决策的证据曾散在**六个互不相邻**的区块（当前意图/上次动作/agent 活动/
 *   agent 步骤/相位/动作面），用户要自己把时间线拼回来。后端早就按 `job` 把它们连上了
 *   （D3a / SPEC §10.114），**页面没有用**。
 * 铁律:
 *   - **归属靠窗口，不靠时间猜**：一次决策的工具属于"上一次决策之后、下一次决策之前"。
 *   - **连接键是 `job`**：工具下的单 → GS job → 相位，按 job 连；不按时间戳猜。
 *   - **缺失 = null**（D60）：没测到的增量不是 0；最后一个决策还没有"下一个快照"，
 *     它的效果就是 `null`（"还没测到"），不是"什么都没变"。
 * 禁止: 在此做判断（可比性/分数/是否算数是 metrics.ts / scorecard.ts 的职责）；
 *   在此发明事实（相位来自归档的 GS 事件，工具来自审计记录）。
 * 事实来源: docs/DASHBOARD-CODESIGN.md §4.1；SPEC §10.114（D3a 的 job 连接）。
 */

/** One tool call of a decision, with the job it ordered (null = it ordered nothing). */
export interface TimelineTool {
	tool: string;
	ok: boolean;
	summary: string;
	job: number | null;
}

/** The GS work a decision ordered, with the phases it went through. */
export interface TimelineJob {
	job: number;
	/** The command that ordered it (the tool that carried the job id). */
	command: string | null;
	phases: { stage: string; phase: string; ts: number }[];
}

/** What changed between this decision and the next one (null = not measured yet). */
export interface TimelineEffect {
	/** Simulated game days between the two decisions. */
	gameDays: number | null;
	money: number | null;
	income: number | null;
	vehicles: number | null;
	stations: number | null;
	delivered: number | null;
}

/** One decision's causal chain. */
export interface TimelineRow {
	turn: number | null;
	trigger: string | null;
	ts: number | null;
	/** The game date the decision was taken on. */
	gameDate: string | null;
	/** The goal the model stated (null = it stated none). */
	goal: string | null;
	tools: TimelineTool[];
	jobs: TimelineJob[];
	/** null for the last decision: there is no later snapshot to compare with. */
	effect: TimelineEffect | null;
}

/** The shape the audit trail writes for a decision's world snapshot. */
interface AuditState {
	date?: unknown;
	delivered?: unknown;
	companies?: unknown;
}

function num(v: unknown): number | null {
	if (v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function record(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Our company's numbers in an audit snapshot.
 *
 * The same rule the scorer uses (id 0, else the first one) so the timeline's
 * effect and the metric row talk about the SAME company - and both snapshots
 * of a pair are matched by **id**, so a reordering of the array cannot turn
 * two different companies into a fake delta.
 */
function companyOf(state: AuditState): Record<string, unknown> | null {
	const companies = Array.isArray(state.companies) ? state.companies : [];
	const records = companies.map(record).filter((c): c is Record<string, unknown> => c !== null);
	const byId = records.find((c) => Number(c.id) === 0);
	return byId ?? records[0] ?? null;
}

/** Simulated days between two game dates ("1950-01-12" → "1950-02-02" = 21). */
export function gameDaysBetween(from: string | null, to: string | null): number | null {
	if (!from || !to) return null;
	const parse = (d: string): number | null => {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
		if (!m) return null;
		const year = Number(m[1]);
		const month = Number(m[2]);
		const day = Number(m[3]);
		if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
		return (year * 12 + (month - 1)) * 31 + day;
	};
	const a = parse(from);
	const b = parse(to);
	if (a === null || b === null) return null;
	return b - a;
}

/** The delta between two audit snapshots (null where a reading is missing). */
function effectBetween(from: AuditState, to: AuditState): TimelineEffect {
	const a = companyOf(from);
	const b = companyOf(to);
	const delta = (x: unknown, y: unknown): number | null => {
		const p = num(x);
		const q = num(y);
		return p === null || q === null ? null : q - p;
	};
	return {
		gameDays: gameDaysBetween(typeof from.date === "string" ? from.date : null, typeof to.date === "string" ? to.date : null),
		money: delta(a?.money, b?.money),
		income: delta(a?.income, b?.income),
		vehicles: delta(a?.vehicles, b?.vehicles),
		stations: delta(a?.stations, b?.stations),
		delivered: delta(from.delivered, to.delivered),
	};
}

/**
 * Build the timeline from the session's audit records.
 *
 * The records are `unknown` on purpose: they come from a JSONL file that may
 * outlive the code that wrote it. A record that does not have the shape it
 * claims is skipped, never guessed at.
 */
export function buildCausalTimeline(records: readonly unknown[]): TimelineRow[] {
	// 1. The decisions, in order: they are the rows.
	const decisions: { rec: Record<string, unknown>; state: AuditState }[] = [];
	for (const raw of records) {
		const rec = record(raw);
		if (!rec || rec.type !== "decision") continue;
		const state = (record(rec.state) ?? {}) as AuditState;
		decisions.push({ rec, state });
	}
	if (decisions.length === 0) return [];

	const rows: TimelineRow[] = decisions.map((d) => ({
		turn: num(d.rec.turn),
		trigger: typeof d.rec.trigger === "string" ? d.rec.trigger : null,
		ts: num(d.rec.ts),
		gameDate: typeof d.state.date === "string" ? d.state.date : null,
		goal: null,
		tools: [],
		jobs: [],
		effect: null,
	}));

	// 2. Each decision's window: after it, before the next one.
	const windows: { tools: TimelineTool[]; goal: string | null; phases: Map<number, TimelineJob["phases"]> }[] =
		decisions.map(() => ({ tools: [], goal: null, phases: new Map() }));

	// The records are in file order, so one pass assigns each record to the
	// window of the decision it belongs to.
	let current = -1;
	for (const raw of records) {
		const rec = record(raw);
		if (!rec) continue;
		if (rec.type === "decision") {
			const idx = decisions.findIndex((d) => d.rec === rec);
			current = idx;
			continue;
		}
		if (current < 0) continue;
		const win = windows[current]!;
		if (rec.type === "plan") {
			const plan = record(rec.plan);
			const goal = plan && typeof plan.goal === "string" ? plan.goal : null;
			if (goal) win.goal = goal;
			continue;
		}
		if (rec.type === "action_result") {
			// A record without a tool name is not a tool call: skip it rather
			// than invent an empty one. A tool that FAILED is a real tool call
			// (the model must see its own mistakes) — only the name is required.
			if (typeof rec.tool !== "string" || rec.tool === "") continue;
			const data = record(rec.data);
			const job = num(data?.job);
			win.tools.push({
				tool: rec.tool,
				ok: rec.ok === true,
				summary: typeof rec.summary === "string" ? rec.summary : "",
				job: job === null ? null : Math.trunc(job),
			});
			continue;
		}
		if (rec.type === "gs_exec") {
			const job = num(rec.job);
			if (job === null) continue;
			const list = win.phases.get(job) ?? [];
			list.push({
				stage: typeof rec.stage === "string" ? rec.stage : "",
				phase: typeof rec.phase === "string" ? rec.phase : "",
				ts: num(rec.ts) ?? 0,
			});
			win.phases.set(job, list);
		}
	}

	// 3. Assemble: the tools of a window, the jobs they ordered, the phases of
	//    those jobs, and the effect measured against the NEXT decision.
	for (let i = 0; i < rows.length; i++) {
		const win = windows[i]!;
		const row = rows[i]!;
		row.goal = win.goal;
		row.tools = win.tools;
		const jobs = new Map<number, TimelineJob>();
		for (const tool of win.tools) {
			if (tool.job === null) continue;
			const existing = jobs.get(tool.job);
			if (existing) {
				// The first command that ordered it is the one that counts.
				if (!existing.command) existing.command = tool.tool;
				continue;
			}
			jobs.set(tool.job, { job: tool.job, command: tool.tool, phases: [] });
		}
		for (const [job, phases] of win.phases) {
			const entry = jobs.get(job);
			if (!entry) continue; // a phase of a job this decision did not order
			entry.phases = phases;
		}
		row.jobs = [...jobs.values()].sort((a, b) => a.job - b.job);
		const next = decisions[i + 1];
		row.effect = next ? effectBetween(decisions[i]!.state, next.state) : null;
	}

	return rows;
}

/**
 * Run manifest — the ONE projection of "what this run actually was".
 *
 * 职责: 定义 manifest 的字段集合，并提供一个把任意来源归一化的函数
 *   （缺失 → `null`：**没测到** 不等于 0/空，MEMORY D60）。
 * 为什么需要这个文件: manifest 曾在**三处**按字段重建（session finalize、
 *   metric 行、reflect-run 的入参），每一处都是一张白名单 —— 在 runner 里新增的
 *   字段会在其中一处被静默丢掉。真机已经踩过两次（D3b 一次、D6b 的 payloadHash
 *   又落在 metrics.jsonl 之外）。字段集合与投影只留一份，新增字段只需改这里。
 * 事实来源: SPEC §10.114（D3b）/ §10.115（D6b）；AGENTS §5.1。
 * 禁止: 在这里推断"应该是什么"（served model 来自 telemetry，指纹来自计算，
 *   由调用方提供）；本模块只做归一化，不做测量。
 */

export interface RunManifest {
	/** Model the provider actually served (may differ from the requested one). */
	servedModel: string | null;
	/**
	 * Which runtime drove the loop. Two manifests that look identical otherwise
	 * still differ in persistence and failure paths, so this must be recorded.
	 */
	backend: "agent" | "harness" | null;
	/** Thinking level actually applied ("off" when deliberation is off). */
	thinkingLevel: string | null;
	/** Per-decision tool-call budget actually applied. */
	toolBudget: number | null;
	/** Fingerprint of (system prompt + tool set) computed from source. */
	scaffoldHash: string | null;
	/** Fingerprint of the FIRST provider payload actually serialized (harness only). */
	payloadHash: string | null;
	/**
	 * Shape of that FIRST payload with every number normalized away (harness only).
	 * The raw hash cannot match across seeds - the world's numbers are random - so
	 * this is the only field that can answer "did two runs ask the same question".
	 */
	payloadShapeHash: string | null;
	/** Provider requests attempted (a retried request counts once per attempt). */
	payloadCount: number | null;
	/**
	 * Token cap applied to this run (null = no cap). Part of the run's identity:
	 * "it stopped early" is only interpretable with the cap that stopped it.
	 */
	tokenLimit: number | null;
	/** Cost cap applied to this run (null = no cap or not enforceable). */
	costLimit: number | null;
}

/**
 * Normalize a partial manifest into the full record.
 *
 * Absent fields become `null`, never `0` or `""`: "not measured" and "measured
 * zero" are different claims, and the benchmark's comparability rests on the
 * difference.
 */
export function projectManifest(src: Partial<RunManifest> | null | undefined): RunManifest {
	return {
		servedModel: src?.servedModel ?? null,
		backend: src?.backend ?? null,
		thinkingLevel: src?.thinkingLevel ?? null,
		toolBudget: src?.toolBudget ?? null,
		scaffoldHash: src?.scaffoldHash ?? null,
		payloadHash: src?.payloadHash ?? null,
		payloadShapeHash: src?.payloadShapeHash ?? null,
		payloadCount: src?.payloadCount ?? null,
		tokenLimit: src?.tokenLimit ?? null,
		costLimit: src?.costLimit ?? null,
	};
}

/** Field count, exported so a guard test can assert no projection drops one. */
export const MANIFEST_FIELDS = [
	"servedModel",
	"backend",
	"thinkingLevel",
	"toolBudget",
	"scaffoldHash",
	"payloadHash",
	"payloadShapeHash",
	"payloadCount",
	"tokenLimit",
	"costLimit",
] as const satisfies readonly (keyof RunManifest)[];

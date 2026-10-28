/**
 * Next-run preview — "what will the next run actually use?".
 *
 * 职责: 把**服务端解析出来的**下一次运行的事实汇总成一份**可核对的清单**。
 * 为什么需要它: 页面上的旋钮与真正生效的旋钮曾经是两套东西（env/CLI vs 页面）。
 *   预览让「下一次会用什么」成为一条**服务端事实**，页面只负责画出来。
 *
 * 字段命名（铁律）: 预览里凡是 manifest 也有的事实，**必须同名同义**
 *   （`thinkingLevel / toolBudget / tokenLimit / costLimit / backend /
 *   scaffoldHash / model / api / contextWindow / costKnown`）——
 *   这样"预览 == 跑完的 manifest"可以逐字段机器比对（D77：一个事实一个名字）。
 *   manifest 里**跑完才知道**的字段（`servedModel / payloadHash /
 *   payloadShapeHash / payloadCount`）**不在预览里**：预览只承诺它能兑现的。
 * 事实来源: docs/DASHBOARD-CODESIGN.md §4.4；docs/SELECTION-STATE-CODESIGN.md §4.4。
 * 禁止: 在此猜测 provider 会服务哪个模型；在此做 IO（除了它显式调用的解析器）。
 */

import { SYSTEM_PROMPT } from "./runtime.js";
import { scaffoldHash } from "./scaffold-fingerprint.js";
import { createTools } from "./tools/index.js";
import type { AgentDeps } from "./types.js";
import type { RunManifest } from "./manifest.js";
import type { RunKnobs } from "./run-knobs.js";

/**
 * The tool set's fingerprint, computed **without** a running game.
 *
 * Why this is honest: the fingerprint only covers the tools' *name, description
 * and schema* — never their behaviour — and those three are static. The probe
 * below proves it against the value the real run recorded (7956ab6d8c86fa60).
 *
 * The probe deps throw on every access: if a tool ever started reading the world
 * to build its description, this would explode loudly instead of quietly
 * predicting a hash the run would never have.
 */
function probeScaffoldHash(): string {
	const exploding = new Proxy(
		{},
		{
			get(_t, prop) {
				throw new Error(`the scaffold probe must not read the world (${String(prop)})`);
			},
		},
	);
	const deps = exploding as unknown as AgentDeps;
	return scaffoldHash(SYSTEM_PROMPT, createTools(deps) as never);
}

/**
 * The preview of one run.
 *
 * It carries the manifest's field names for every fact both know, plus the
 * run's shape (seed / horizon / scenario / arm) and the provider id.
 */
export interface NextRunPreview
	extends Pick<
		RunManifest,
		| "model"
		| "api"
		| "contextWindow"
		| "costKnown"
		| "thinkingLevel"
		| "toolBudget"
		| "tokenLimit"
		| "costLimit"
		| "backend"
		| "scaffoldHash"
	> {
	/** The provider that will serve the run. */
	providerId: string;
	/** The model's output cap (the manifest does not record it; the page shows it). */
	maxTokens: number;
	/** The world this run would use. */
	seed: number;
	gameDays: number | null;
	scenario: "freeform" | "prebuilt";
	memoryArm: "treatment" | "control";
}

/** Build the preview of one run from the resolved knobs + selection facts. */
export function buildNextRunPreview(
	knobs: RunKnobs,
	selection: {
		providerId: string;
		model: string;
		api: string;
		contextWindow: number;
		maxTokens: number;
		costKnown: boolean;
	},
): NextRunPreview {
	return {
		providerId: selection.providerId,
		model: selection.model,
		api: selection.api,
		contextWindow: selection.contextWindow,
		maxTokens: selection.maxTokens,
		costKnown: selection.costKnown,
		seed: knobs.seed,
		gameDays: knobs.gameDays,
		scenario: knobs.scenario,
		memoryArm: knobs.memoryArm,
		thinkingLevel: knobs.thinkingLevel,
		toolBudget: knobs.toolBudget,
		tokenLimit: knobs.tokenLimit,
		costLimit: knobs.costLimit,
		backend: knobs.backend,
		scaffoldHash: probeScaffoldHash(),
	};
}

/**
 * The manifest fields a preview promises — the ones it can know in advance.
 *
 * A test compares these field by field against the finished run's manifest.
 */
export const PREVIEW_MANIFEST_FIELDS = [
	"model",
	"api",
	"contextWindow",
	"costKnown",
	"thinkingLevel",
	"toolBudget",
	"tokenLimit",
	"costLimit",
	"backend",
	"scaffoldHash",
] as const satisfies readonly (keyof RunManifest)[];

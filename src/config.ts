/**
 * Runtime configuration from environment variables.
 *
 * 职责: 集中管理所有可调参数, 带默认值与校验。
 * 事实来源: SPEC §3/§7; 默认二进制路径为本机实测 Steam OpenTTD 15.0。
 * 禁止: 隐藏副作用; 不在本模块 spawn 进程。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { resolveScaffoldKnobs } from "./agent/scaffold-knobs.js";
import { resolveRunLimits, type RunLimits } from "./agent/run-budget.js";

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export interface Config {
	openttdBinary: string;
	dataDir: string;
	adminHost: string;
	adminPort: number;
	adminPassword: string;
	gamePort: number;
	serverName: string;
	startYear: number;
	seed: number;
	mapSizeX: number;
	mapSizeY: number;
	companyName: string;
	/** LLM provider settings (SPEC §4 — brain wiring). */
	llm: LlmConfig;
	/**
	 * 这份 `llm` 是从哪来的——由 `applyLlmSettingsFile`（唯一知道真相的地方）写入。
	 *
	 * 为什么不能让 UI 自己猜（2026-09-22 的真 bug）：生产里三个调用点都传
	 * `envLlm: cfg.llm`，而那时 `cfg` **已经合并过文件**，所以“文件里存的值”会被当成
	 * “env 提供”，Providers 页于是显示“env 覆盖了文件”——一句假话。
	 * 合并处知道每一格从哪里来，别处猜不出来；猜出来的结论就会撒谎。
	 */
	llmAppliedFrom?: "env" | "file" | "none";
	/**
	 * B1：`llm` 里**由 env/CLI 明确提供**的字段（不是默认值、不是文件值）。
	 *
	 * 为什么需要它：`applyLlmSettingsFile` 必须**每次重新读盘**，否则保存后不重启
	 * 永远看到启动快照（A1）。但"重新读盘"不能把 env 覆盖也一起丢掉——而合并之后的
	 * `llm` 已经分不出哪一格来自 env。所以在造 Config 的那一刻记下来，
	 * 由 `applyLlmSettingsFile` 原样携带（不重算、不猜）。
	 */
	llmProvided?: Partial<LlmConfig>;
}

/** LLM provider configuration (OpenAI-compatible by default). */
export interface LlmConfig {
	/** Provider id used internally (also the models registry key). */
	providerId: string;
	/** OpenAI-compatible base URL, e.g. https://api.openai.com/v1. */
	baseUrl: string;
	/** API key (bearer). */
	apiKey: string;
	/** Model id, e.g. gpt-4o-mini / deepseek-chat. */
	model: string;
	/** Which pi-ai streaming API to use (custom path; catalog derives it from the model). */
	api: string;
	/**
	 * Where the provider comes from (see docs/DASHBOARD-API.md §6.6):
	 * - "catalog": a pi-ai **built-in** provider (39 of them) — id+model only,
	 *   auth resolved from the credential store / environment by pi-ai itself.
	 * - "custom": a user-defined OpenAI-compatible endpoint (baseUrl/apiKey).
	 * Absent (legacy files) → inferred: no baseUrl + known id ⇒ catalog.
	 */
	source?: LlmSource;
	contextWindow: number;
	maxTokens: number;
	/** D4/S6: run-shape knobs (validated; see scaffold-knobs.ts). */
	scaffold?: { thinkingLevel: import("./agent/scaffold-knobs.js").ThinkingLevelName; toolBudget: number };
	/**
	 * P4: spend caps (validated; see run-budget.ts). Parsed here so the CLI
	 * overrides, the settings file and the dry-run view all see the same values.
	 */
	limits?: RunLimits;
}

/** Which provider path is in use. */
export type LlmSource = "catalog" | "custom";

/** APIs the **custom** path can speak (catalog models carry their own api id). */
export const CUSTOM_LLM_APIS = ["openai-completions", "anthropic-messages"] as const;

/** True when the LLM config has the minimum needed to make a request. */
export function isLlmConfigured(llm: LlmConfig): boolean {
	if (!llm.model.trim()) return false;
	// Catalog providers resolve their own baseUrl + auth (store/env).
	if (llm.source === "catalog") return llm.providerId.trim().length > 0;
	return llm.baseUrl.trim().length > 0;
}

/**
 * Default OpenTTD binary for the local Steam install.
 *
 * Derived from the home directory on purpose: the earlier hardcoded
 * "/Users/<name>/..." was both non-portable and a small privacy leak in a public
 * repository (it published the maintainer's username and install layout).
 */
const DEFAULT_BINARY = join(
	homedir(),
	"Library/Application Support/Steam/steamapps/common/OpenTTD/OpenTTD.app/Contents/MacOS/openttd",
);

const MAP_SIZES: Record<string, [number, number]> = {
	small: [256, 256],
	medium: [512, 512],
	large: [1024, 1024],
};

function intEnv(
	e: NodeJS.ProcessEnv,
	key: string,
	def: number,
	{ min, max }: { min: number; max: number },
	label: string,
): number {
	const raw = e[key];
	if (raw === undefined || raw === "") return def;
	const v = Number(raw);
	if (!Number.isInteger(v) || v < min || v > max) {
		throw new ConfigError(`${key}: ${label} must be integer in ${min}..${max}, got "${raw}"`);
	}
	return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const binary = env.OPENTTD_BINARY?.trim() || DEFAULT_BINARY;
	const dataDir = env.OPENTTD_DATA_DIR?.trim() || "/tmp/openttd-agent-data";
	const adminHost = env.OPENTTD_ADMIN_HOST?.trim() || "127.0.0.1";
	const adminPort = intEnv(env, "OPENTTD_ADMIN_PORT", 3977, { min: 1, max: 65535 }, "admin port");
	const gamePort = intEnv(env, "OPENTTD_GAME_PORT", 3979, { min: 1, max: 65535 }, "game port");
	if (adminPort === gamePort) {
		throw new ConfigError(`admin port (${adminPort}) and game port (${gamePort}) must differ`);
	}
	const adminPassword = env.OPENTTD_ADMIN_PASSWORD ?? "openttd-admin";
	const serverName = env.OPENTTD_SERVER_NAME?.trim() || "openttd-agent";
	const startYear = intEnv(env, "OPENTTD_START_YEAR", 1950, { min: 1900, max: 2100 }, "start year");
	const seedRaw = env.OPENTTD_SEED;
	const seed =
		seedRaw === undefined || seedRaw === ""
			? 1 + Math.floor(Math.random() * (2 ** 31 - 1))
			: intEnv(env, "OPENTTD_SEED", 1, { min: 1, max: 2 ** 31 - 1 }, "seed");
	const mapSize = env.OPENTTD_MAP_SIZE?.trim() || "small";
	const dims = MAP_SIZES[mapSize];
	if (!dims) throw new ConfigError(`OPENTTD_MAP_SIZE: unknown "${mapSize}" (small|medium|large)`);
	const companyName = env.OPENTTD_COMPANY_NAME?.trim() || "openttd-agent";
	const llm = loadLlmConfig(env);
	const llmProvided = providedLlmFields(env);

	return {
		openttdBinary: binary,
		dataDir,
		adminHost,
		adminPort,
		adminPassword,
		gamePort,
		serverName,
		startYear,
		seed,
		mapSizeX: dims[0],
		mapSizeY: dims[1],
		companyName,
		llm,
		...(Object.keys(llmProvided).length ? { llmProvided } : {}),
	};
}

/**
 * Resolve LLM provider settings from env. Accepts common aliases so an existing
 * key (OPENAI_API_KEY etc.) works without renaming. Empty base/model = not
 * configured (the agent falls back to the offline faux provider for demos).
 */
/**
 * Which `llm` fields did the environment (or CLI-as-env) actually provide?
 *
 * 只认**显式给出**的键：`LLM_CONTEXT_WINDOW` 没设时那 128000 是默认值，不是选择，
 * 让它去和文件争会把保存过的 204800 又顶回默认（A1 的同型 bug）。
 */
export function providedLlmFields(env: NodeJS.ProcessEnv): Partial<LlmConfig> {
	const out: Partial<LlmConfig> = {};
	const set = <K extends keyof LlmConfig>(k: K, v: LlmConfig[K] | undefined): void => {
		if (v !== undefined) out[k] = v;
	};
	const trim = (v: string | undefined): string | undefined => {
		const t = v?.trim();
		return t ? t : undefined;
	};
	set("providerId", trim(env.LLM_PROVIDER));
	set("baseUrl", trim(env.LLM_BASE_URL));
	set("apiKey", trim(env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? env.ANTHROPIC_API_KEY));
	set("model", trim(env.LLM_MODEL));
	set("api", trim(env.LLM_API));
	const src = trim(env.LLM_SOURCE);
	if (src === "catalog" || src === "custom") out.source = src;
	if (trim(env.LLM_CONTEXT_WINDOW) !== undefined) {
		out.contextWindow = intEnv(env, "LLM_CONTEXT_WINDOW", 128_000, { min: 1024, max: 10_000_000 }, "LLM context window");
	}
	if (trim(env.LLM_MAX_TOKENS) !== undefined) {
		out.maxTokens = intEnv(env, "LLM_MAX_TOKENS", 4096, { min: 16, max: 1_000_000 }, "LLM max tokens");
	}
	return out;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv): LlmConfig {
	const apiRaw = (env.LLM_API ?? "openai-completions").trim();
	if (!CUSTOM_LLM_APIS.includes(apiRaw as (typeof CUSTOM_LLM_APIS)[number])) {
		throw new ConfigError(
			`LLM_API: unknown "${apiRaw}" (${CUSTOM_LLM_APIS.join("|")})`,
		);
	}
	const sourceRaw = env.LLM_SOURCE?.trim();
	if (sourceRaw && sourceRaw !== "catalog" && sourceRaw !== "custom") {
		throw new ConfigError(`LLM_SOURCE: unknown "${sourceRaw}" (catalog|custom)`);
	}
	return {
		// Blank when not explicitly set: lets llm.json (dashboard) supply it and
		// applyLlmSettingsFile() apply the final default.
		providerId: env.LLM_PROVIDER?.trim() || "",
		baseUrl: (env.LLM_BASE_URL ?? "").trim(),
		apiKey: (env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? env.ANTHROPIC_API_KEY ?? "").trim(),
		model: (env.LLM_MODEL ?? "").trim(),
		api: apiRaw,
		source: sourceRaw ? (sourceRaw as LlmSource) : undefined,
		contextWindow: intEnv(env, "LLM_CONTEXT_WINDOW", 128_000, { min: 1024, max: 10_000_000 }, "LLM context window"),
		maxTokens: intEnv(env, "LLM_MAX_TOKENS", 4096, { min: 16, max: 1_000_000 }, "LLM max tokens"),
		// D4/S6: the two knobs that used to be hard-coded. Resolved (and
		// validated) in one place; unknown values throw instead of falling back.
		scaffold: resolveScaffoldKnobs(env as Record<string, string | undefined>),
		limits: resolveRunLimits(env as Record<string, string | undefined>),
	};
}

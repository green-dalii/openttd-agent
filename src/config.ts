/**
 * Runtime configuration from environment variables.
 *
 * 职责: 集中管理所有可调参数, 带默认值与校验。
 * 事实来源: SPEC §3/§7; 默认二进制路径为本机实测 Steam OpenTTD 15.0。
 * 禁止: 隐藏副作用; 不在本模块 spawn 进程。
 */

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
	/** Which pi-ai streaming API to use. */
	api: LlmApi;
	contextWindow: number;
	maxTokens: number;
}

/** Supported streaming APIs (pi-ai built-ins we may point at). */
export type LlmApi = "openai-completions" | "anthropic-messages";

/** True when the LLM config has the minimum needed to make a request. */
export function isLlmConfigured(llm: LlmConfig): boolean {
	return llm.baseUrl.trim().length > 0 && llm.model.trim().length > 0;
}

const DEFAULT_BINARY =
	"$HOME/Library/Application Support/Steam/steamapps/common/OpenTTD/OpenTTD.app/Contents/MacOS/openttd";

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
	};
}

/**
 * Resolve LLM provider settings from env. Accepts common aliases so an existing
 * key (OPENAI_API_KEY etc.) works without renaming. Empty base/model = not
 * configured (the agent falls back to the offline faux provider for demos).
 */
export function loadLlmConfig(env: NodeJS.ProcessEnv): LlmConfig {
	const apiRaw = (env.LLM_API ?? "openai-completions").trim();
	if (apiRaw !== "openai-completions" && apiRaw !== "anthropic-messages") {
		throw new ConfigError(`LLM_API: unknown "${apiRaw}" (openai-completions|anthropic-messages)`);
	}
	return {
		// Blank when not explicitly set: lets llm.json (dashboard) supply it and
		// applyLlmSettingsFile() apply the final default.
		providerId: env.LLM_PROVIDER?.trim() || "",
		baseUrl: (env.LLM_BASE_URL ?? "").trim(),
		apiKey: (env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? env.ANTHROPIC_API_KEY ?? "").trim(),
		model: (env.LLM_MODEL ?? "").trim(),
		api: apiRaw,
		contextWindow: intEnv(env, "LLM_CONTEXT_WINDOW", 128_000, { min: 1024, max: 10_000_000 }, "LLM context window"),
		maxTokens: intEnv(env, "LLM_MAX_TOKENS", 4096, { min: 16, max: 1_000_000 }, "LLM max tokens"),
	};
}

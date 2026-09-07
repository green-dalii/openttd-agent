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
	};
}

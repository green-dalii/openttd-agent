import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";
import { homedir } from "node:os";
import { join } from "node:path";

// Derived the same way the code derives it: no username in the test either.
const DEFAULT_BIN = join(
	homedir(),
	"Library/Application Support/Steam/steamapps/common/OpenTTD/OpenTTD.app/Contents/MacOS/openttd",
);

function env(over: Record<string, string> = {}): Record<string, string> {
	return {
		OPENTTD_ADMIN_PASSWORD: "testpw",
		OPENTTD_SEED: "42",
		...over,
	};
}

describe("loadConfig", () => {
	it("loads defaults with sensible values", () => {
		const cfg = loadConfig(env());
		expect(cfg.openttdBinary).toBe(DEFAULT_BIN);
		expect(cfg.adminHost).toBe("127.0.0.1");
		expect(cfg.adminPort).toBe(3977);
		expect(cfg.adminPassword).toBe("testpw");
		expect(cfg.gamePort).toBe(3979);
		expect(cfg.startYear).toBe(1950);
		expect(cfg.seed).toBe(42);
		expect(cfg.mapSizeX).toBe(256);
		expect(cfg.mapSizeY).toBe(256);
	});

	it("reads overrides from env", () => {
		const cfg = loadConfig(
			env({
				OPENTTD_ADMIN_PORT: "4000",
				OPENTTD_GAME_PORT: "4001",
				OPENTTD_START_YEAR: "2000",
				OPENTTD_MAP_SIZE: "large",
				OPENTTD_SERVER_NAME: "my-server",
			}),
		);
		expect(cfg.adminPort).toBe(4000);
		expect(cfg.gamePort).toBe(4001);
		expect(cfg.startYear).toBe(2000);
		expect(cfg.mapSizeX).toBe(1024);
		expect(cfg.serverName).toBe("my-server");
	});

	it("randomizes seed when unset", () => {
		const c1 = loadConfig({ OPENTTD_ADMIN_PASSWORD: "x" });
		const c2 = loadConfig({ OPENTTD_ADMIN_PASSWORD: "x" });
		expect(c1.seed).toBeGreaterThanOrEqual(1);
		expect(c1.seed).toBeLessThanOrEqual(2 ** 31 - 1);
		// Extremely likely distinct
		expect(c1.seed).not.toBe(c2.seed);
	});

	it("throws ConfigError on invalid port / year / map size", () => {
		expect(() => loadConfig(env({ OPENTTD_ADMIN_PORT: "0" }))).toThrow(ConfigError);
		expect(() => loadConfig(env({ OPENTTD_ADMIN_PORT: "70000" }))).toThrow(ConfigError);
		expect(() => loadConfig(env({ OPENTTD_GAME_PORT: "abc" }))).toThrow(ConfigError);
		expect(() => loadConfig(env({ OPENTTD_START_YEAR: "1800" }))).toThrow(ConfigError);
		expect(() => loadConfig(env({ OPENTTD_MAP_SIZE: "huge" }))).toThrow(ConfigError);
		expect(() => loadConfig(env({ OPENTTD_ADMIN_PORT: "3977", OPENTTD_GAME_PORT: "3977" }))).toThrow(ConfigError);
	});
});

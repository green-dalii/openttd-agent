import { describe, expect, it } from "vitest";
import { OpenTTDProcessManager } from "../../src/game/process-manager.js";
import { ConfigError } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function baseCfg(dir: string): Config {
	return {
		openttdBinary: "/nonexistent/openttd",
		dataDir: dir,
		adminHost: "127.0.0.1",
		adminPort: 3977,
		adminPassword: "s3cret",
		gamePort: 3979,
		serverName: "test",
		startYear: 1950,
		seed: 42,
		llm: {
			providerId: "test-llm",
			baseUrl: "",
			apiKey: "",
			model: "",
			api: "openai-completions",
			contextWindow: 128000,
			maxTokens: 4096,
		},
		mapSizeX: 256,
		mapSizeY: 256,
		companyName: "testco",
	};
}

describe("OpenTTDProcessManager config templates", () => {
	it("patches an OpenTTD-generated config with network settings + admin_password", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ottd-pm-"));
		try {
			// Simulate an OpenTTD-generated config (minimal + version section).
			await writeFile(
				join(dir, "openttd.cfg"),
				"[network]\nserver_port = 3979\nserver_admin_port = 3977\n\n[misc]\nx = 1\n[version]\nversion_string = 15.0\n",
			);
			await writeFile(
				join(dir, "secrets.cfg"),
				"[network]\nserver_password = \nrcon_password = \nadmin_password = \n\n[version]\nversion_string = 15.0\n",
			);

			const mgr = new OpenTTDProcessManager(baseCfg(dir));
			await mgr.ensureSandboxConfig();

			const cfg = await readFile(join(dir, "openttd.cfg"), "utf8");
			expect(cfg).toContain(`server_port = 3979`);
			expect(cfg).toContain(`server_admin_port = 3977`);
			expect(cfg).toContain(`allow_insecure_admin_login = true`);

			const secrets = await readFile(join(dir, "secrets.cfg"), "utf8");
			expect(secrets).toContain(`admin_password = s3cret`);
			expect(secrets).toContain(`[network]`);
			// version section preserved
			expect(secrets).toContain(`[version]`);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("is idempotent (does not duplicate on second call)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ottd-pm-"));
		try {
			await writeFile(
				join(dir, "openttd.cfg"),
				"[network]\nserver_port = 3979\nserver_admin_port = 3977\n\n[version]\nversion_string = 15.0\n",
			);
			await writeFile(
				join(dir, "secrets.cfg"),
				"[network]\nserver_password = \nrcon_password = \nadmin_password = \n\n[version]\nversion_string = 15.0\n",
			);
			const mgr = new OpenTTDProcessManager(baseCfg(dir));
			await mgr.ensureSandboxConfig();
			await mgr.ensureSandboxConfig();
			const cfg = await readFile(join(dir, "openttd.cfg"), "utf8");
			expect(cfg.match(/server_port = 3979/g)?.length).toBe(1);
			const secrets = await readFile(join(dir, "secrets.cfg"), "utf8");
			expect(secrets.match(/admin_password = s3cret/g)?.length).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("throws ConfigError when binary missing during generateConfigs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ottd-pm-"));
		try {
			const mgr = new OpenTTDProcessManager({
				...baseCfg(dir),
				openttdBinary: "/nonexistent/openttd",
			});
			await expect(mgr.ensureSandboxConfig()).rejects.toThrow(ConfigError);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("sandbox config: 自动驾驶必须能解除暂停（2026-09-12 真机根因）", () => {
	it("生成的 [network] 必须显式关闭 pause_on_join", async () => {
		// 真机症状：GS 在发状态（3200 ticks），但游戏日历 120 秒只走了 **1 天**。
		// 脚本 tick 在走、世界不走 = 游戏被暂停。而 OpenTTD 自己的提示写着：
		//   "Game cannot be unpaused manually; disable pause_on_join/min_active_clients."
		// 也就是说 `rcon("unpause")` 会被**静默拒绝**。
		//
		// 原 patchOpenttdCfg 在替换 [network] 块时**没有写这两项**，于是 OpenTTD
		// 回落到默认 pause_on_join = true —— 一个"有人加入就暂停"的服务器，
		// 对无人驾驶的 harness 是错的。
		const dir = await mkdtemp(join(tmpdir(), "ottd-pause-"));
		try {
			const cfgPath = join(dir, "openttd.cfg");
			await writeFile(cfgPath, "[network]\nserver_name = old\n\n[gui]\nx = 1\n", "utf8");
			const mgr = new OpenTTDProcessManager(baseCfg(dir));
			await mgr.ensureSandboxConfig();
			const out = await readFile(cfgPath, "utf8");
			expect(out).toMatch(/^pause_on_join = false$/m);
			expect(out).toMatch(/^min_active_clients = 0$/m);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("OpenTTDProcessManager lifecycle", () => {
	it("isRunning() false before start and after stop of a dead child", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ottd-pm-"));
		try {
			const mgr = new OpenTTDProcessManager(baseCfg(dir));
			expect(mgr.isRunning()).toBe(false);
			await mgr.stop(); // no-op safe
			expect(mgr.isRunning()).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("tracks child exit and exposes log tail", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ottd-pm-"));
		try {
			// Pre-seed configs so ensureSandboxConfig does not try to spawn a binary.
			await writeFile(
				join(dir, "openttd.cfg"),
				"[network]\nserver_port = 3979\nserver_admin_port = 3977\n\n[version]\nversion_string = 15.0\n",
			);
			await writeFile(
				join(dir, "secrets.cfg"),
				"[network]\nadmin_password = \n\n[version]\nversion_string = 15.0\n",
			);
			// Use a fake "binary" = a shell script that prints and exits 3.
			const fake = join(dir, "fakebin.sh");
			await writeFile(fake, "#!/bin/sh\necho hello-server\nexit 3\n", { mode: 0o755 });
			const mgr = new OpenTTDProcessManager({
				...baseCfg(dir),
				openttdBinary: fake,
			});
			let exitCode: number | null = null;
			mgr.onExit = (code) => {
				exitCode = code;
			};
			await mgr.ensureSandboxConfig();
			await mgr.start();
			expect(mgr.isRunning()).toBe(true);
			// wait for exit
			await new Promise((res) => setTimeout(res, 800));
			expect(mgr.isRunning()).toBe(false);
			expect(exitCode).toBe(3);
			expect(mgr.getLogTail().join("\n")).toContain("hello-server");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

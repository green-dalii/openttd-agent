/**
 * serve.ts 的"接线"测试 —— Start 按钮到底把什么交给了 runner。
 *
 * 职责：锁定 `--serve` 的 Start 按钮 → `runAgent` 这一段的**参数转交**。
 * 禁止：在这里测 agent 行为（那是 test/live）或 HTTP 路由（那是 web-api.test.ts）。
 *
 * 为什么需要（2026-09-12 真机事故）：
 * `serve.ts` 里的 `runOpts` 是**手写的一个对象字面量**，只放了 `web` 和 `control`，
 * 其余全丢。`offlineDemo` 正好被丢掉，而 **preflight 是直接读 `opts.offlineDemo` 的**，
 * 所以 `--serve --offline-demo` 会打印 "running the explicit offline demo"，
 * 紧接着 runner 抛 "no LLM configured"。
 *
 * 这个失败的形态值得记住：**门禁接受了某个选项，runner 却从没收到它**。
 * 比"没有这个 flag"更糟 —— 它谎报了将要发生的事。
 * 而任何"断言 preflight 看得到 offlineDemo"的测试都会通过，
 * 因为它测的正是没坏的那一半。所以这里的断言必须落在 **launcher 实际收到的 opts** 上。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runServe } from "../../src/agent/serve.js";
import { loadConfig, type Config } from "../../src/config.js";
import { resolveRunOptions } from "../../src/agent/serve.js";
import { saveLlmSettingsFile } from "../../src/agent/llm-settings.js";

const ROOT = process.cwd();

/**
 * 最小可用配置：不碰真机、不碰网络。走 loadConfig 而不是手写对象，
 * 这样 serve.ts 里 createLlmApi 依赖的每个字段都拿到真实默认值 ——
 * 手写对象会漏字段，报出来的错（reading 'model'）离真正原因很远。
 */
function cfg(): Config {
	return loadConfig({ OPENTTD_DATA_DIR: "/tmp/openttd-agent-serve-wiring-test" });
}

/** 起一个 serve，捕获 launcher 收到的 opts，然后点一次 Start。 */
async function captureStartOpts(serveOpts: Parameters<typeof runServe>[1]) {
	const captured: Record<string, unknown>[] = [];
	const launcher = vi.fn(async (_mode: string, _cfg: Config, opts: Record<string, unknown>) => {
		captured.push(opts);
		return 0;
	});
	const handle = await runServe(cfg(), {
		...serveOpts,
		// 让门禁放行，本测试只关心转交，不关心环境是否完备
		skipPreflight: true,
		launcher: launcher as unknown as NonNullable<
			NonNullable<Parameters<typeof runServe>[1]>["launcher"]
		>,
	});
	try {
		// supervisor 的 start 是异步的；拿到 hook 后直接驱动。
		await handle.supervisor.start("agent");
		// start() 内部 fire-and-forget，等 launcher 被调用。
		for (let i = 0; i < 50 && captured.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
	} finally {
		await handle.stop();
	}
	return captured;
}

describe("serve 接线: Start 按钮转交给 runner 的参数", () => {
	it("真机路径：Start 按钮走到底时 offlineDemo 确实到了 launcher", async () => {
		// 全链路（serve → preflight → supervisor → launcher），不是只测纯函数。
		// 这正是本次事故缺失的那一段：preflight 看得到、runner 看不到。
		const opts = await captureStartOpts({ offlineDemo: true, webPort: 0 });
		expect(opts.length).toBeGreaterThan(0);
		expect(opts[0]!.offlineDemo).toBe(true);
	});

	describe("resolveRunOptions: 让门禁与 runner 读同一个值", () => {
		it("top-level offlineDemo 透传", () => {
			const r = resolveRunOptions({ offlineDemo: true }, "W", "C");
			expect(r.offlineDemo).toBe(true);
			expect(r.web).toBe("W");
			expect(r.control).toBe("C");
		});

		it("runOptions.offlineDemo 优先于顶层（dashboard 可单独覆盖 CLI）", () => {
			expect(resolveRunOptions({ offlineDemo: false, runOptions: { offlineDemo: true } }, "W", "C").offlineDemo).toBe(true);
			expect(resolveRunOptions({ offlineDemo: true, runOptions: { offlineDemo: false } }, "W", "C").offlineDemo).toBe(false);
		});

		it("未指定时是 false —— 绝不凭空打开 faux（SPEC: 不做静默兜底）", () => {
			expect(resolveRunOptions({}, "W", "C").offlineDemo).toBe(false);
		});

		it("runOptions 的其余字段原样透传", () => {
			const r = resolveRunOptions({ runOptions: { seconds: 42, maxDecisions: 7 } }, "W", "C");
			expect(r.seconds).toBe(42);
			expect(r.maxDecisions).toBe(7);
		});

		it("转发新字段时不会弄丢 web / control", () => {
			const r = resolveRunOptions({ offlineDemo: true, runOptions: { seconds: 1 } }, "WEB", "CTL");
			expect(r.web).toBe("WEB");
			expect(r.control).toBe("CTL");
		});
	});
});

describe("runner 的所有回调状态必须在 AdminClient 之前声明（TDZ 守卫）", () => {
	// 这个缺陷已经出现 4 次（MEMORY A5）。每次形状都一样：某个 `let x` 写在
	// 第一次赋值处，而 `onEvent` 在 **boot 期间**就会触发 → x 处于暂时性死区
	// → 回调里每次访问都抛 → 症状千奇百怪（"GS never heartbeated"、
	// "Cannot access 'x' before initialization"），但根因只有一个。
	//
	// 与其等第 5 次，不如让门禁挡住：**回调会碰到的顶层 let，必须声明在
	// `new AdminClient` 之前**。
	it("hub / web / sessionRef 都先于 AdminClient（TDZ 守卫；REFACTOR Phase B-3 后 executorPhase/executorStage 已迁入 signal-hub）", () => {
		const src = readFileSync(join(ROOT, "src/agent/runner.ts"), "utf8");
		const adminIdx = src.indexOf("client = new AdminClient");
		expect(adminIdx, "runner.ts must still construct AdminClient").toBeGreaterThan(0);
		for (const name of ["hub", "web", "sessionRef"]) {
			const decl = new RegExp(`\\b(?:let|const)\\s+${name}\\b`).exec(src);
			expect(decl, `runner.ts should declare ${name}`).not.toBeNull();
			expect(
				decl!.index,
				`\`${name}\` must be declared ABOVE \`new AdminClient\` or it is in the ` +
					`temporal dead zone when the boot-time event callback fires (MEMORY A5)`,
			).toBeLessThan(adminIdx);
		}
	});
});

/**
 * 回归（2026-09-22 用户实测）：**在 dashboard 里保存了 Provider，点 Start 仍报
 * `llmConfigured: no provider/model configured`。**
 *
 * 根因是"同一个问题有两个事实源"：
 *   - Providers 页每次 GET/save 都 `applyLlmSettingsFile(cfg)`（llm-api.ts）→ 页面看到**最新**文件；
 *   - Start 走 `runPreflight(cfg)`，用的是 **`runServe` 启动时捕获的那份 cfg**（serve.ts）→ 门禁看到**旧的**。
 * 于是页面说"已配置"、门禁说"没配置"。
 *
 * 为什么以前没被测到：历史 E2E 验证的是"dashboard 存 → **另一个进程** `--agent` 读"
 * （跨进程，boot 时 cfg 天然是新的）。**同进程 serve** 从未被验证。
 *
 * 断言必须落在**门禁与 launcher 各看到了什么**，而不是"文件写成功了"——
 * 后者在 bug 存在时也是真的（写文件那段从来没坏）。
 */
describe("serve: Start 必须用**当前**的 llm.json（同进程保存后立刻生效）", () => {
	/** boot 时未配置、且 binary 用 node 自身（可移植）的 cfg。 */
	function bootCfg(dir: string): Config {
		return loadConfig({ OPENTTD_DATA_DIR: dir, OPENTTD_BINARY: process.execPath });
	}

	/** 模拟 Providers 页保存：写的就是它写的那份文件。 */
	function saveProvider(dir: string, baseUrl: string): void {
		saveLlmSettingsFile(dir, {
			source: "custom",
			providerId: "custom",
			model: "saved-model",
			api: "openai-completions",
			baseUrl,
			apiKey: "sk-test",
			contextWindow: 8192,
			maxTokens: 256,
		} as never);
	}

	it("保存后 Start 时**门禁**看到的是新配置（不再是 llmConfigured 失败）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "serve-llm-"));
		const launcher = vi.fn(async () => 0);
		const handle = await runServe(bootCfg(dir), {
			webPort: 0,
			// 端口检查必须跳过：本测试关心的是 LLM 那一行，而**机器上可能正跑着真机局**
			// （D5）。`skipPreflight` 只跳过 ports，binary/dataDir/LLM 三行照跑——
			// 否则这条测试会变成"环境有没有空端口"的测试。
			skipPreflight: true,
			// 不用 offlineDemo：那样 unconfigured 只是 warn，测不出这个 bug。
			// 因此走真实 reachability——baseUrl 指向**关闭的端口**，失败要快且不发外部请求。
			offlineDemo: false,
			launcher: launcher as never,
		});
		try {
			// 用户在浏览器里保存了 Provider（boot 之后）
			saveProvider(dir, "http://127.0.0.1:9/v1");
			let err = "";
			try {
				await handle.supervisor.start("agent");
			} catch (e) {
				err = e instanceof Error ? e.message : String(e);
			}
			// 关键：失败**只能**是"连不上"，不能是"没配置"。
			expect(err).not.toMatch(/llmConfigured/);
			expect(err).toMatch(/llmReachable/);
		} finally {
			await handle.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("保存后 Start 时 **launcher** 收到的是新配置（模型必须来自文件）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "serve-llm-"));
		const launched: Config[] = [];
		const launcher = vi.fn(async (_mode: string, cfg: Config) => {
			launched.push(cfg);
			return 0;
		});
		const handle = await runServe(bootCfg(dir), {
			webPort: 0,
			skipPreflight: true, // 同上：不依赖端口空闲
			// offlineDemo 让 reachability 跳过 → 门禁放行，从而能观察到 launcher 拿到的 cfg。
			offlineDemo: true,
			launcher: launcher as never,
		});
		try {
			saveProvider(dir, "http://127.0.0.1:9/v1");
			await handle.supervisor.start("agent");
			for (let i = 0; i < 50 && launched.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
			expect(launched.length, "launcher 没有收到调用").toBeGreaterThan(0);
			expect(launched[0]!.llm.model).toBe("saved-model");
			expect(launched[0]!.llm.baseUrl).toBe("http://127.0.0.1:9/v1");
		} finally {
			await handle.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

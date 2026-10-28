/**
 * B2: 页面起一局 —— 旋钮到达 runner，非法旋钮**什么都不启动**。
 *
 * 这些测试锁的是 Issue #34 的三条验收：
 *   1. 页面设的非默认旋钮真的到达 runner（config 与 options 两条路）；
 *   2. 非法旋钮 → 有可执行的原因 + **没有游戏进程被启动**；
 *   3. 花费上限配在无价目表的模型上 → 启动前就被拒（run-budget 的规则）。
 *
 * 为什么断言落在 **launcher 收到的东西**上（而不是"解析函数返回了什么"）：
 * 门禁放行、runner 却用旧值，是本仓库反复出现的失败形态（D63/A5）。
 * 只有断言"最终收到什么"才能抓住它。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runServe } from "../../src/agent/serve.js";
import { loadConfig, type Config } from "../../src/config.js";
import { saveLlmSettingsFile } from "../../src/agent/llm-settings.js";

/** boot cfg: dataDir 临时、binary 用 node 自身（可移植，不碰真机）。 */
function bootCfg(dir: string): Config {
	return loadConfig({ OPENTTD_DATA_DIR: dir, OPENTTD_BINARY: process.execPath });
}

/** 一个能通过门禁的自定义端点（离线 demo ⇒ 跳过可达性探测）。 */
function saveProvider(dir: string): void {
	saveLlmSettingsFile(dir, {
		source: "custom",
		providerId: "custom",
		model: "saved-model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "sk-test",
		contextWindow: 8192,
		maxTokens: 256,
	} as never);
}

interface Captured {
	cfg: Config;
	opts: Record<string, unknown>;
}

async function withServe(
	dir: string,
	body: (handle: Awaited<ReturnType<typeof runServe>>) => Promise<void>,
): Promise<{ captured: Captured[]; boot: Config }> {
	const captured: Captured[] = [];
	const launcher = vi.fn(async (_mode: string, cfg: Config, opts: Record<string, unknown>) => {
		captured.push({ cfg, opts });
		return 0;
	});
	// The boot config is kept: the seed is **random per process** (no OPENTTD_SEED
	// set), so the "untouched knob" test must compare against the config the
	// serve process actually booted with, not a freshly loaded one.
	const boot = bootCfg(dir);
	const handle = await runServe(boot, {
		webPort: 0,
		skipPreflight: true,
		offlineDemo: true,
		launcher: launcher as never,
	});
	try {
		await body(handle);
	} finally {
		await handle.stop();
		rmSync(dir, { recursive: true, force: true });
	}
	return { captured, boot };
}

describe("B2: 页面起一局", () => {
	it("把页面设的旋钮交到 runner（config 与 options 两条路）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "b2-knobs-"));
		saveProvider(dir);
		const { captured } = await withServe(dir, async (handle) => {
			await handle.supervisor.start("agent", {
				seed: 4242,
				gameDays: 180,
				scenario: "prebuilt",
				memoryArm: "control",
				thinkingLevel: "high",
				toolBudget: 5,
				tokenLimit: 120_000,
				backend: "agent",
			});
		});
		expect(captured.length, "launcher 没有收到调用").toBe(1);
		const { cfg, opts } = captured[0]!;
		// 世界（config）：seed 决定 OpenTTD 起哪张图。
		expect(cfg.seed).toBe(4242);
		// 脚手架（config）：thinking level 与工具预算。
		expect(cfg.llm.scaffold).toEqual({ thinkingLevel: "high", toolBudget: 5 });
		// 花费上限（config）。
		expect(cfg.llm.limits).toEqual({ tokens: 120_000, cost: null });
		// 这一局的形状（options）：游戏日/场景/记忆臂/后端。
		expect(opts.gameDays).toBe(180);
		expect(opts.scenario).toBe("prebuilt");
		// 记忆臂：control = 不注入跨局记忆。
		expect(opts.injectMemory).toBe(false);
		expect(opts.backend).toBe("agent");
	});

	it("不碰旋钮时沿用进程配置（页面没说的旋钮不改变行为）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "b2-defaults-"));
		saveProvider(dir);
		const { captured, boot } = await withServe(dir, async (handle) => {
			await handle.supervisor.start("agent");
		});
		expect(captured.length).toBe(1);
		const { cfg, opts } = captured[0]!;
		expect(cfg.seed).toBe(boot.seed);
		expect(opts.scenario).toBe("freeform");
		expect(opts.injectMemory).toBe(true);
	});

	it("非法旋钮 → 有可执行的原因，且**没有游戏进程被启动**", async () => {
		const dir = mkdtempSync(join(tmpdir(), "b2-bad-"));
		saveProvider(dir);
		const { captured } = await withServe(dir, async (handle) => {
			let problems: { code: string; message: string; hint: string }[] = [];
			try {
				await handle.supervisor.start("agent", { thinkingLevel: "turbo" });
			} catch (e) {
				problems = (e as { problems?: { code: string; message: string; hint: string }[] }).problems ?? [];
			}
			expect(problems.length, "非法旋钮必须给出结构化原因").toBeGreaterThan(0);
			expect(problems[0]!.code).toBe("invalid_knob");
			expect(problems[0]!.hint).toContain("xhigh");
		});
		// 关键断言：**没有** launcher 调用 ⇒ 没有游戏进程。
		expect(captured.length, "非法旋钮竟然启动了游戏进程").toBe(0);
	});

	it("harness 后端在进程未启用时不可选（harness 默认关的不变量）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "b2-harness-"));
		saveProvider(dir);
		const { captured } = await withServe(dir, async (handle) => {
			let problems: { code: string; hint: string }[] = [];
			try {
				await handle.supervisor.start("agent", { backend: "harness" });
			} catch (e) {
				problems = (e as { problems?: { code: string; hint: string }[] }).problems ?? [];
			}
			expect(problems.length).toBeGreaterThan(0);
			expect(problems[0]!.hint).toContain("AGENT_HARNESS=1");
		});
		expect(captured.length, "harness 不该被页面偷偷打开").toBe(0);
	});

	it("无价目表的模型上设花费上限 → 启动前被拒（run-budget 的规则）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "b2-costcap-"));
		// 自定义端点 = 无价目表（零价格）⇒ 花费上限永远不可能触发。
		saveProvider(dir);
		const { captured } = await withServe(dir, async (handle) => {
			let problems: { code: string; hint: string }[] = [];
			try {
				await handle.supervisor.start("agent", { costLimit: 2 });
			} catch (e) {
				problems = (e as { problems?: { code: string; hint: string }[] }).problems ?? [];
			}
			expect(problems.length, "无价目表的模型 + 花费上限必须被拒").toBeGreaterThan(0);
			expect(problems[0]!.code).toBe("unpriced_with_cost_cap");
		});
		expect(captured.length, "被拒的花费上限竟然启动了游戏进程").toBe(0);
	});

	it("预览与启动用同一条花费闸：不能执行的花费上限在预览里就被拒", async () => {
		const dir = mkdtempSync(join(tmpdir(), "b2-costcap-preview-"));
		saveProvider(dir);
		await withServe(dir, async (handle) => {
			// 预览必须拒绝 Start 会拒绝的东西（否则预览承诺了一局跑不起来的运行）。
			const preview = await handle.preview({ costLimit: 2 });
			expect(preview.preview, "预览不该承诺一个无法执行的花费上限").toBeNull();
			expect(preview.problems[0]!.code).toBe("unpriced_with_cost_cap");
		});
	});
});

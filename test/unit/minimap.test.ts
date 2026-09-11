/**
 * Unit tests — minimap capture.
 *
 * 职责: 锁定「请求截图 → 等待落盘 → 归档」的时序逻辑。
 *   背景（2026-09-11 实测）：dedicated server 下 `screenshot`/`big`/`giant` 都返回
 *   `Screenshot failed!`（需要 3D 视口与帧缓冲），但 **`screenshot minimap` 成功**，
 *   写出 256×256 RGB PNG —— 小地图由地图数据渲染，不需要帧缓冲。
 *   这是本架构下唯一可用的真实画面来源（SPEC §10.2 的"视觉像素"边界仅指视口）。
 * 事实来源: docs/AGENT-LOOP-AND-CONTROL.md §4。
 * 禁止: 用固定 sleep 猜测落盘时间（会偶发拿到上一张图）。
 */

import { describe, expect, it, vi } from "vitest";
import { captureMinimap, MINIMAP_COMMAND, type CaptureDeps } from "../../src/game/minimap.js";

/** Fake filesystem/sleep harness with a fake clock. */
function harness(opts: { writeAfterMs?: number | null; startMtime?: number } = {}) {
	let t = 1_000_000;
	let mtime: number | null = opts.startMtime ?? null;
	const writes: { from: string; to: string }[] = [];
	const sent: string[] = [];
	const writeAfter = opts.writeAfterMs === undefined ? 500 : opts.writeAfterMs;

	// The write lands at a future *virtual* time, and only becomes visible once
	// the clock reaches it - otherwise the very first poll would already see it.
	let writeAt: number | null = null;
	const deps: CaptureDeps = {
		send: (cmd) => {
			sent.push(cmd);
			writeAt = writeAfter === null ? null : t + writeAfter;
		},
		statMtime: () => (writeAt !== null && t >= writeAt ? writeAt : mtime),
		move: (from, to) => {
			writes.push({ from, to });
			mtime = null; // the file is consumed by the move
		},
		sleep: async (ms) => {
			t += ms;
			await new Promise((r) => setTimeout(r, 0));
		},
		now: () => t,
	};
	return { deps, sent, writes, advance: (ms: number) => (t += ms) };
}

describe("captureMinimap", () => {
	it("sends the minimap command (the only screenshot that works headless)", async () => {
		const h = harness();
		await captureMinimap(h.deps, { target: "/out/001.png", timeoutMs: 5000 });
		expect(h.sent).toEqual([MINIMAP_COMMAND]);
		expect(MINIMAP_COMMAND).toBe("screenshot minimap");
	});

	it("waits for the file to be rewritten, then archives it", async () => {
		const h = harness({ startMtime: 1, writeAfterMs: 1500 });
		const ok = await captureMinimap(h.deps, { target: "/out/001.png", timeoutMs: 8000 });
		expect(ok).toBe(true);
		expect(h.writes).toHaveLength(1);
		expect(h.writes[0]!.to).toBe("/out/001.png");
	});

	it("does not archive a stale file when nothing was written", async () => {
		// The game never rewrites (unsupported command / failure): we must report
		// false rather than copying the previous stage's image.
		const h = harness({ startMtime: 42, writeAfterMs: null });
		const ok = await captureMinimap(h.deps, { target: "/out/002.png", timeoutMs: 3000 });
		expect(ok).toBe(false);
		expect(h.writes).toHaveLength(0);
	});

	it("gives up after the timeout instead of hanging a run", async () => {
		const h = harness({ startMtime: 7, writeAfterMs: null });
		const started = h.deps.now();
		const ok = await captureMinimap(h.deps, { target: "/out/003.png", timeoutMs: 2000 });
		expect(ok).toBe(false);
		expect(h.deps.now() - started).toBeGreaterThanOrEqual(2000);
	});

	it("accepts a write that lands on the first poll", async () => {
		const h = harness({ startMtime: 5, writeAfterMs: 1 });
		expect(await captureMinimap(h.deps, { target: "/o.png", timeoutMs: 1000 })).toBe(true);
	});

	it("works when no previous screenshot exists at all", async () => {
		const h = harness({ startMtime: undefined, writeAfterMs: 300 });
		expect(await captureMinimap(h.deps, { target: "/first.png", timeoutMs: 2000 })).toBe(true);
	});

	it("never throws when the filesystem misbehaves", async () => {
		const deps: CaptureDeps = {
			send: () => {
				throw new Error("socket closed");
			},
			statMtime: () => {
				throw new Error("EACCES");
			},
			move: () => {
				throw new Error("ENOSPC");
			},
			sleep: async () => {},
			now: () => 0,
		};
		await expect(
			captureMinimap(deps, { target: "/x.png", timeoutMs: 100 }),
		).resolves.toBe(false);
	});

	it("polls rather than relying on a single fixed delay", async () => {
		const h = harness({ startMtime: 1, writeAfterMs: 2500 });
		const spySleep = vi.fn(async (ms: number) => {
			await h.deps.sleep(ms);
		});
		const ok = await captureMinimap({ ...h.deps, sleep: spySleep }, { target: "/p.png", timeoutMs: 9000 });
		expect(ok).toBe(true);
		expect(spySleep.mock.calls.length).toBeGreaterThan(1);
	});
});

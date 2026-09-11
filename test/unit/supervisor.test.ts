/**
 * Unit tests — run supervisor (dashboard start/stop/pause/resume).
 *
 * 职责: 锁定运行状态机与"同一时刻至多一个运行"的约束
 *   （docs/AGENT-LOOP-AND-CONTROL.md §3）。
 * 禁止: 在此 spawn 真游戏进程（用注入的启动函数）。
 */

import { describe, expect, it, vi } from "vitest";
import { RunSupervisor } from "../../src/agent/supervisor.js";

/** A controllable fake run. */
function fakeRun() {
	let resolveDone: (() => void) | null = null;
	const hooks: { stop?: () => void; pause?: () => void; resume?: () => void } = {};
	return {
		hooks,
		paused: 0,
		resumed: 0,
		stopped: 0,
		done: new Promise<void>((r) => (resolveDone = r)),
		finish: () => resolveDone?.(),
	};
}

function supervisor(run = fakeRun()) {
	const started: string[] = [];
	const states: string[] = [];
	const sup = new RunSupervisor({
		onStateChange: (s) => states.push(s.state),
		start: async (mode, hooks) => {
			started.push(mode);
			// Ask to stop; completion is signalled later by the run itself
			// (a real stop drains the game, closes sockets, finalizes the session).
			hooks.stop = () => {
				run.stopped++;
			};
			hooks.pause = () => run.paused++;
			hooks.resume = () => run.resumed++;
			run.hooks.stop = hooks.stop;
			run.hooks.pause = hooks.pause;
			run.hooks.resume = hooks.resume;
		},
	});
	return { sup, run, started, states };
}

describe("run supervisor", () => {
	it("starts idle with no session", () => {
		const { sup } = supervisor();
		const s = sup.state();
		expect(s.state).toBe("idle");
		expect(s.sessionId).toBeNull();
	});

	it("start() moves idle -> running and records the mode", async () => {
		const { sup, started } = supervisor();
		await sup.start("agent");
		expect(started).toEqual(["agent"]);
		const s = sup.state();
		expect(s.state).toBe("running");
		expect(s.mode).toBe("agent");
		expect(s.startedAt).toBeGreaterThan(0);
	});

	it("refuses a second start while a run is active (one run at a time)", async () => {
		const { sup, started } = supervisor();
		await sup.start("agent");
		await expect(sup.start("watch")).rejects.toThrow(/already running/i);
		// and it did not start anything new
		expect(started).toEqual(["agent"]);
	});

	it("stop() asks the run to stop and does not claim it finished immediately", async () => {
		const { sup, run } = supervisor();
		await sup.start("agent");
		await sup.stop();
		expect(run.stopped).toBe(1);
		// stopping is in-flight until the run reports completion
		expect(sup.state().state).toBe("stopping");
		sup.markFinished();
		expect(sup.state().state).toBe("idle");
	});

	it("pause/resume delegate to the running run and are reflected in state", async () => {
		const { sup, run } = supervisor();
		await sup.start("agent");
		await sup.pause();
		expect(run.paused).toBe(1);
		expect(sup.state().state).toBe("paused");
		await sup.resume();
		expect(run.resumed).toBe(1);
		expect(sup.state().state).toBe("running");
	});

	it("rejects pause/resume/stop when nothing is running", async () => {
		const { sup } = supervisor();
		await expect(sup.pause()).rejects.toThrow(/no run/i);
		await expect(sup.resume()).rejects.toThrow(/no run/i);
		await expect(sup.stop()).rejects.toThrow(/no run/i);
	});

	it("pause is a no-op when already paused (not an error)", async () => {
		const { sup, run } = supervisor();
		await sup.start("agent");
		await sup.pause();
		await expect(sup.pause()).resolves.toBeUndefined();
		expect(run.paused).toBe(1);
	});

	it("emits state changes so the dashboard can react", async () => {
		const { sup, states } = supervisor();
		await sup.start("watch");
		await sup.pause();
		await sup.resume();
		sup.markFinished();
		// 'starting' is emitted too so a slow boot is visible in the UI.
		expect(states).toEqual(["starting", "running", "paused", "running", "idle"]);
	});

	it("records an error when the run fails to start", async () => {
		const sup = new RunSupervisor({
			start: async () => {
				throw new Error("preflight refused: no LLM configured");
			},
		});
		await expect(sup.start("agent")).rejects.toThrow(/refused/);
		const s = sup.state();
		expect(s.state).toBe("idle");
		expect(s.error).toMatch(/refused/);
	});

	it("exposes the session id once the run reports it", async () => {
		const { sup } = supervisor();
		await sup.start("agent");
		sup.setSessionId("20260911-160000-seed7");
		expect(sup.state().sessionId).toBe("20260911-160000-seed7");
	});

	it("survives a run that ends on its own", async () => {
		const { sup } = supervisor();
		await sup.start("agent");
		sup.markFinished();
		expect(sup.state().state).toBe("idle");
		// and a new run can start afterwards
		await sup.start("watch");
		expect(sup.state().state).toBe("running");
	});

	it("tells the caller the current mode is the only one that can be controlled", async () => {
		const onStart = vi.fn();
		const sup = new RunSupervisor({
			start: async (mode, hooks) => {
				onStart(mode);
				void hooks;
			},
		});
		await sup.start("watch");
		expect(sup.canControl()).toBe(true);
		sup.markFinished();
		expect(sup.canControl()).toBe(false);
	});
});

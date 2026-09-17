/**
 * 冻结世界（决策期间暂停游戏）—— 已验证、可观测、可兜底（2026-09-17）。
 *
 * 职责: 在"模型思考 + 执行动作"期间暂停 OpenTTD，使动作落在模型**真正见过的**
 *   世界状态上；恢复必须无条件发生（任何异常路径 + 看门狗）。
 * 为什么现在才敢做: 原设计（SPEC §1.1 step 2）因"暂停不可恢复"在 2026-09-12 被废除，
 *   但 §10.59 实测推翻了该归因（`pause` → `getdate` 冻结，`unpause` → 日期恢复推进）。
 *   于是冻结重新可用，**但这次必须能观测自己的效果**：
 *   暂停/恢复都要 rcon 回执确认，失败要如实上报（不许假装冻住了）。
 * 禁止: 在这里做任何策略判断；禁止吞掉恢复失败（那正是 §10.26 的永久冻结 bug）。
 */

export interface FreezeLease {
	/** 幂等：重复调用只恢复一次。 */
	release(): Promise<void>;
}

export interface FreezeStats {
	/** 确认成功的冻结次数。 */
	acquisitions: number;
	/** 暂停指令没有得到回执的次数（没冻住，但流程继续）。 */
	acquireUnconfirmed: number;
	/** 恢复连续失败（重试后仍失败）的次数 —— 会永久冻结游戏的路径。 */
	unpauseFailures: number;
	/** 看门狗强制恢复的次数。 */
	watchdogTrips: number;
	/** 单次最长持有毫秒数（用来判断"冻结是否真的生效"）。 */
	maxHoldMs: number;
}

export interface FreezeController {
	acquire(reason: string): Promise<FreezeLease | null>;
	release(): Promise<void>;
	isHeld(): boolean;
	stats(): FreezeStats;
}

export interface FreezeDeps {
	/** 发送 pause 并等待回执；null = 没有回答。 */
	pause(): Promise<string | null>;
	/** 发送 unpause 并等待回执；null = 没有回答。 */
	unpause(): Promise<string | null>;
	now(): number;
	log(message: string): void;
	/** 持有上限；超过则强制恢复（默认 120s：一次卡死的决策不能永久冻住游戏）。 */
	maxHoldMs?: number;
}

const DEFAULT_MAX_HOLD_MS = 120_000;

export function makeFreezeController(deps: FreezeDeps): FreezeController {
	const maxHoldMs = deps.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
	let held = false;
	let startedAt = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const stats: FreezeStats = {
		acquisitions: 0,
		acquireUnconfirmed: 0,
		unpauseFailures: 0,
		watchdogTrips: 0,
		maxHoldMs: 0,
	};

	async function doRelease(reason: string): Promise<void> {
		if (!held) return;
		held = false;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		const heldMs = deps.now() - startedAt;
		stats.maxHoldMs = Math.max(stats.maxHoldMs, heldMs);
		// 恢复比暂停重要：重试一次再把失败算数（§10.26：恢复失败 = 永久冻结）。
		for (let attempt = 1; attempt <= 2; attempt++) {
			const reply = await deps.unpause();
			if (reply !== null) {
				deps.log(`[freeze] resumed after ${heldMs}ms (${reason})`);
				return;
			}
			if (attempt < 2) deps.log(`[freeze] unpause not acknowledged (${reason}); retrying`);
		}
		stats.unpauseFailures++;
		deps.log(
			`[freeze] CRITICAL: unpause was never acknowledged (${reason}). ` +
				"The game may still be frozen - check the console.",
		);
	}

	function makeLease(): FreezeLease {
		let done = false;
		const lease: FreezeLease = {
			release: async () => {
				if (done) return;
				done = true;
				await doRelease("lease release");
			},
		};
		return lease;
	}

	return {
		async acquire(reason) {
			if (held) return null; // 嵌套安全：外层负责恢复
			const reply = await deps.pause();
			if (reply === null) {
				// 没冻住就说没冻住：假装冻住会让"冻结 A/B"整轮结论作废。
				stats.acquireUnconfirmed++;
				deps.log(`[freeze] pause not acknowledged (${reason}) - proceeding UNFROZEN`);
				return null;
			}
			held = true;
			// Log the success path too: `pause` produces NO rcon output line, so
			// without this the log looks exactly like a run that never froze
			// (learned the hard way during this feature's own verification).
			deps.log(`[freeze] paused for "${reason}" (acknowledged)`);
			startedAt = deps.now();
			stats.acquisitions++;
			timer = setTimeout(() => {
				if (!held) return;
				stats.watchdogTrips++;
				deps.log(
					`[freeze] watchdog: held longer than ${maxHoldMs}ms during "${reason}" - releasing`,
				);
				void doRelease("watchdog");
			}, maxHoldMs);
			// setTimeout 不应阻止进程退出
			if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
			return makeLease();
		},
		async release() {
			await doRelease("explicit release");
		},
		isHeld: () => held,
		stats: () => ({ ...stats }),
	};
}

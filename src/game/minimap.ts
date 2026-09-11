/**
 * Minimap capture — a real game image, without the 3D viewport.
 *
 * 职责: 请求游戏写出小地图 PNG，等它落盘后归档到指定位置。
 * 为什么这条路可行（2026-09-11 真机实测，修正了早先的结论）:
 *   - `screenshot` / `big` / `giant` → `Screenshot failed!`（要 3D 视口 + 帧缓冲）
 *   - **`screenshot minimap` → 成功**，写出 256×256 RGB PNG（`screenshot/screenshot.png`）
 *   小地图是**由地图数据渲染**的，不需要帧缓冲，因此 headless dedicated server 也能出图。
 *   SPEC §10.2 的"视觉像素"边界仅指**视口画面**，不含小地图。
 * 事实来源: docs/AGENT-LOOP-AND-CONTROL.md §4（含实测表）。
 * 禁止:
 *   - 用固定 `sleep` 猜落盘时刻（会偶发归档到上一张图）→ 必须轮询 mtime。
 *   - 超时后把**旧文件**当作本次结果归档（会伪造"这个阶段的画面"）。
 *   - 抛异常打断运行（截图属审计产物，失败只记录）。
 */

/** The only screenshot flavour that works on a headless dedicated server. */
export const MINIMAP_COMMAND = "screenshot minimap";

/** Path (relative to the data dir) where the game writes the file. */
export const MINIMAP_REL_PATH = "screenshot/screenshot.png";

export interface CaptureDeps {
	/** Send an rcon command to the game. */
	send: (cmd: string) => void;
	/** mtime of the game's output file, or null when it does not exist. */
	statMtime: () => number | null;
	/** Move/replace the file (archive it). */
	move: (from: string, to: string) => void;
	/** Sleep helper (injected so tests need no real time). */
	sleep: (ms: number) => Promise<void>;
	/** Monotonic-ish clock for the timeout. */
	now: () => number;
}

export interface CaptureOptions {
	/** Where to archive the captured PNG. */
	target: string;
	/** Absolute path of the game's output file (defaults to the data dir layout). */
	source?: string;
	/** Give up after this long (default 12s; the write is usually <1s). */
	timeoutMs?: number;
	/** Poll interval (default 250ms). */
	pollMs?: number;
}

/**
 * Capture one minimap and archive it at `target`.
 *
 * Returns true when a *fresh* image was captured and moved. Returns false on
 * timeout or any IO error - callers treat screenshots as best-effort audit data.
 */
export async function captureMinimap(
	deps: CaptureDeps,
	opts: CaptureOptions,
): Promise<boolean> {
	const timeoutMs = opts.timeoutMs ?? 12_000;
	const pollMs = opts.pollMs ?? 250;
	const source = opts.source ?? MINIMAP_REL_PATH;

	let before: number | null;
	try {
		before = deps.statMtime();
	} catch {
		return false;
	}

	try {
		deps.send(MINIMAP_COMMAND);
	} catch {
		return false;
	}

	const started = deps.now();
	for (;;) {
		await deps.sleep(pollMs);
		const mtime = safeMtime(deps);
		// A fresh write is either a new mtime or a file appearing from nothing.
		const fresh = mtime !== null && (before === null || mtime > before);
		if (fresh) {
			try {
				deps.move(source, opts.target);
				return true;
			} catch {
				return false;
			}
		}
		if (deps.now() - started >= timeoutMs) return false;
	}
}

function safeMtime(deps: CaptureDeps): number | null {
	try {
		return deps.statMtime();
	} catch {
		return null;
	}
}

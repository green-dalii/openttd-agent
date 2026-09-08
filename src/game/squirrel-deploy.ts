/**
 * SquirrelDeploy — install our Bridge GS + Executor AI packs into a sandbox.
 *
 * 职责: 把项目内 `src/game/squirrel/{bridge-gs,executor-ai}` 源包部署到
 *   OpenTTD 扫描路径:
 *   - GS  → <dataDir>/game/<Name>/   (list_game 可见; attach 靠 openttd.cfg
 *     [game_scripts] 段写 "<Name> = ", SPEC §10.10)
 *   - AI  → <dataDir>/ai/<Name>/     (rescan_ai + start_ai, SPEC §10.10)
 * 事实来源: SPEC §10.10/§10.11; 真机验证的目录与注册规则。
 * 禁止: 触碰用户全局配置目录; 在此模块做游戏语义。
 */

import { mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SQUIRREL_SRC = path.resolve(__dirname, "squirrel");
export const BRIDGE_GS_DIR = path.join(SQUIRREL_SRC, "bridge-gs");
export const EXECUTOR_AI_DIR = path.join(SQUIRREL_SRC, "executor-ai");

export const BRIDGE_GS_NAME = "BridgeV1";
export const EXECUTOR_AI_NAME = "ExecutorV1";

/** Copy a pack dir (info.nut + main.nut) to dest/<Name>/. */
async function copyPack(srcDir: string, destDir: string): Promise<void> {
	await mkdir(destDir, { recursive: true });
	const entries = await readdir(srcDir);
	for (const f of entries) {
		const data = await readFile(path.join(srcDir, f));
		await writeFile(path.join(destDir, f), data);
	}
}

/** Deploy GS + Executor AI packs into the sandbox data dir. */
export async function deploySquirrelPacks(cfg: Config): Promise<void> {
	await copyPack(BRIDGE_GS_DIR, path.join(cfg.dataDir, "game", BRIDGE_GS_NAME));
	await copyPack(EXECUTOR_AI_DIR, path.join(cfg.dataDir, "ai", EXECUTOR_AI_NAME));
}

/**
 * Set the sandbox openttd.cfg `[game_scripts]` section to select our Bridge GS.
 * Replaces any existing entry (e.g. `none =`). Called before map generation so
 * the next -G map attaches BridgeV1 (SPEC §10.10-2).
 */
export async function selectBridgeGsInConfig(cfg: Config): Promise<void> {
	const cfgPath = path.join(cfg.dataDir, "openttd.cfg");
	let text = "";
	try {
		text = await readFile(cfgPath, "utf8");
	} catch {
		return; // no config yet; nothing to patch (caller should run ensureSandbox first)
	}
	// Rewrite the [game_scripts] section to contain only our GS entry.
	const section = `[game_scripts]\n${BRIDGE_GS_NAME} = \n`;
	const re = /^\[game_scripts\][\s\S]*?(?=^\[|\s*$)/m;
	if (re.test(text)) {
		text = text.replace(re, section);
	} else {
		text += "\n" + section;
	}
	await writeFile(cfgPath, text, "utf8");
}

/** True if the sandbox has our Bridge GS pack installed. */
export async function hasBridgeGs(cfg: Config): Promise<boolean> {
	try {
		await access(path.join(cfg.dataDir, "game", BRIDGE_GS_NAME, "info.nut"));
		return true;
	} catch {
		return false;
	}
}

export async function hasExecutorAi(cfg: Config): Promise<boolean> {
	try {
		await access(path.join(cfg.dataDir, "ai", EXECUTOR_AI_NAME, "info.nut"));
		return true;
	} catch {
		return false;
	}
}

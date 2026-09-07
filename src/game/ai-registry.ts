/**
 * AI availability registry for observed companies.
 *
 * 职责: 判断某个 AI 名是否可被 dedicated server `start_ai` 使用。
 * 事实来源 (真机):
 *   - OpenTTD 15 的 AI 以 .tar 下载包存放在 content_download/ai, 运行时按需
 *     解包到 ai/<name>/ 目录; 搜索路径跨 个人目录 + 安装目录。
 *   - 用户机器已下载 AAAHogEx/CityLifeAI/CivilAI/CPU (tar), spike 实测
 *     `rcon start_ai "CPU"` 成功建公司。
 *   - 文件系统探测不可靠 (tar 未解包时查不到), 因此以「已知内置集」为准,
 *     并允许 OPENTTD_AI_LIST 覆盖。
 * 禁止: 不解析 tar; 不做沙箱外写操作。
 */

import type { Config } from "../config.js";

/** AIs observed/known on this machine (from ~/Documents/OpenTTD/content_download/ai). */
const KNOWN_AIS = ["AAAHogEx", "CityLifeAI", "CivilAI", "CPU"];

/** Return AI names considered available. */
export function aiInstalledNames(_cfg: Config): string[] {
	const override = process.env.OPENTTD_AI_LIST?.split(",").map((s) => s.trim()).filter(Boolean);
	return override && override.length > 0 ? override : [...KNOWN_AIS];
}

export function isAiInstalled(cfg: Config, name: string): boolean {
	return aiInstalledNames(cfg).includes(name);
}

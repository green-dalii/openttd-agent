/**
 * File-backed model catalog store (pi-ai `ModelsStore`).
 *
 * 职责: 把 pi-ai 刷新到的动态模型列表落盘，使"刷新过一次"在**重启后仍然有效**，
 *   并且让运行进程（另一个 `Models` 实例）也能恢复同一份覆盖层。
 * 为什么必须落盘: 页面进程与 agent 子进程各自构造 `Models`；只放内存的话，页面刷新
 *   成功、运行时仍然"不认识这个模型"——那正是"列表是新的但用不了"的一半原因。
 * 格式: `{ "<providerId>": { models, checkedAt } }`，pi-ai 自己决定 `models` 的内容。
 * 禁止: 写 dataDir 之外；保存任何非模型数据；失败时让调用方崩溃（读失败 = 无缓存）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";

type FileShape = Record<string, ModelsStoreEntry>;

export class JsonModelsStore implements ModelsStore {
	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	private load(): FileShape {
		try {
			if (!existsSync(this.file)) return {};
			const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			return parsed && typeof parsed === "object" ? (parsed as FileShape) : {};
		} catch {
			// A corrupt cache must not stop the run: treat it as "no cache".
			return {};
		}
	}

	private save(next: FileShape): void {
		mkdirSync(path.dirname(this.file), { recursive: true });
		// Write-then-rename so a crash cannot leave a half-written catalog.
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
		renameSync(tmp, this.file);
	}

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		const entry = this.load()[providerId];
		return entry && Array.isArray(entry.models) ? entry : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		const all = this.load();
		all[providerId] = entry;
		this.save(all);
	}

	async delete(providerId: string): Promise<void> {
		const all = this.load();
		if (!(providerId in all)) return;
		delete all[providerId];
		this.save(all);
	}
}

/** Default cache path: per data dir, next to credentials.json. */
export function modelsCachePath(dataDir: string): string {
	return path.join(dataDir, "models-cache.json");
}

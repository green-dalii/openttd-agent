/**
 * File credential store — persist pi-ai provider credentials to disk.
 *
 * 职责: 实现 pi-ai 的 `CredentialStore`，把「dashboard 里填的 provider key」落到
 *   `<dataDir>/credentials.json`，使 key 在进程重启后仍然可用（pi-ai 默认的
 *   `InMemoryCredentialStore` 一重启就丢）。
 * 事实来源: pi-ai auth/types.d.ts `CredentialStore`（read/list/modify/delete，
 *   modify 是唯一写路径且需按 provider 串行）；`Credential` = ApiKeyCredential |
 *   OAuthCredential。
 * 禁止: 记录/打印明文密钥；写失败抛出（best-effort 持久化，内存视图照常服务）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";

/** On-disk shape: provider id -> credential. */
type FileShape = Record<string, Credential>;

function isCredential(v: unknown): v is Credential {
	if (!v || typeof v !== "object") return false;
	const t = (v as { type?: unknown }).type;
	return t === "api_key" || t === "oauth";
}

/**
 * Credential store backed by a single JSON file. Writes are atomic
 * (temp file + rename) and serialized per provider id.
 */
export class FileCredentialStore implements CredentialStore {
	readonly file: string;
	private cache: FileShape | null = null;
	private chains = new Map<string, Promise<unknown>>();

	constructor(file: string) {
		this.file = file;
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return this.load()[providerId];
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.load())
			.filter(([, c]) => isCredential(c))
			.map(([providerId, c]) => ({ providerId, type: c.type }));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.enqueue(providerId, async () => {
			const cur = this.load();
			const next = await fn(cur[providerId]);
			if (next === undefined) return cur[providerId];
			cur[providerId] = next;
			this.persist(cur);
			return next;
		});
	}

	async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		await this.enqueue(providerId, async () => {
			const cur = this.load();
			if (!(providerId in cur)) return;
			delete cur[providerId];
			this.persist(cur);
		});
	}

	/**
	 * Synchronous write (dashboard save path). pi-ai's async `modify()` queues the
	 * mutation on a microtask, which makes a save-then-read in the same tick
	 * observably stale; this path updates the cache and persists immediately.
	 */
	set(providerId: string, credential: Credential): void {
		const cur = this.load();
		cur[providerId] = credential;
		this.persist(cur);
	}

	/** Synchronous removal (dashboard "clear key"). */
	remove(providerId: string): void {
		const cur = this.load();
		if (!(providerId in cur)) return;
		delete cur[providerId];
		this.persist(cur);
	}

	/** Whether a credential is stored for a provider (cache-backed, sync). */
	has(providerId: string): boolean {
		return Boolean(this.load()[providerId]);
	}

	/** Serialize tasks per provider id (mirrors pi-ai's store contract). */
	private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(providerId) ?? Promise.resolve();
		const next = prev.then(task, task);
		// Keep the chain alive but never let a rejection poison later writes.
		this.chains.set(
			providerId,
			next.catch(() => undefined),
		);
		return next;
	}

	/** Load once, cache in memory; corruption degrades to an empty store. */
	private load(): FileShape {
		if (this.cache) return this.cache;
		try {
			if (!existsSync(this.file)) {
				this.cache = {};
				return this.cache;
			}
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
			const out: FileShape = {};
			for (const [k, v] of Object.entries(raw ?? {})) if (isCredential(v)) out[k] = v;
			this.cache = out;
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	/** Best-effort atomic write; failures leave the in-memory view intact. */
	private persist(data: FileShape): void {
		try {
			mkdirSync(path.dirname(this.file), { recursive: true });
			const tmp = `${this.file}.tmp`;
			writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
			renameSync(tmp, this.file);
		} catch {
			/* best-effort: dashboard still works from the in-memory cache */
		}
	}
}

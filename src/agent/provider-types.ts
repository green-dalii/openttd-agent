/**
 * Dashboard wire types — the shapes the web layer renders.
 *
 * 职责: 单独存放 dashboard REST/WS 的类型（catalog/session 元数据），避免
 *   `provider-catalog.ts` 与 `session-store.ts` 互相 import 形成环。
 * 事实来源: docs/DASHBOARD-API.md §2.5/§2.6（冻结契约）。
 * 禁止: 在此放行为逻辑；禁止依赖 web/agent 运行时模块（纯类型）。
 */

/** One entry of the built-in provider directory (§2.6). */
export interface CatalogProvider {
	id: string;
	name: string;
	baseUrl?: string;
	modelCount: number;
	apis: string[];
	authTypes: ("apiKey" | "oauth")[];
	envKeys: string[];
	/** Set when the provider cannot take a plain API-key env var (OAuth/cloud). */
	hint?: string;
	auth: {
		configured: boolean;
		source: "stored" | "env" | "none";
		/** Environment variable name that supplied the key (when source === "env"). */
		envVar?: string;
	};
}

/** One model of a built-in provider (§2.6). */
export interface CatalogModel {
	id: string;
	name: string;
	api: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	/** USD per 1M tokens (straight from pi-ai's Model.cost). */
	cost: { input: number; output: number };
}

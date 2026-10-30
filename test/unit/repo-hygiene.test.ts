/**
 * Unit tests — repository hygiene.
 *
 * 职责: 挡住"顺手提交了不该提交的东西"这类错误。它们不影响功能，但会永久留在历史里，
 *   并误导后来者以为那是产品的一部分。
 * 事实来源: AGENTS.md §3.1（临时脚本归 `.scratch/`）。
 * 禁止: 在此断言业务行为。
 *
 * 起因(2026-09-12):我在仓库根目录写 CDP 探针脚本 `probe2.mjs`，被 `git add -A`
 * 顺手提交进了 `10eb8ef`。用户指出这类临时文件应当集中存放并及时清理。
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** Top-level docs whose boundaries are defined by AGENTS.md §9. */
const TOP_DOCS = ["AGENTS.md", "SPEC.md", "ROADMAP.md", "CHANGELOG.md", "MEMORY.md", "README.md"];

function doc(name: string): string {
	return readFileSync(join(ROOT, name), "utf8");
}

/** 仓库中被 git 跟踪的文件（不含未跟踪的本地垃圾）。 */
function trackedFiles(): string[] {
	const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
	return out.split("\n").filter(Boolean);
}

/** 一次性的探针/验证/抓包脚本：不属于产品，也不进 test/。 */
const SCRATCH_PATTERNS = [
	/^probe[\w-]*\.(mjs|cjs|js|ts)$/,
	/^vfy[\w-]*\.(mjs|cjs|js|ts)$/,
	/^verify[\w-]*\.(mjs|cjs|js|ts)$/,
	/^check[\w-]*\.(mjs|cjs|js|ts)$/,
	/^scratch[\w-]*\./,
	/^tmp[\w-]*\.(mjs|cjs|js|ts)$/,
	/\.tmp$/,
];

describe("repo hygiene: 临时脚本", () => {
	it("没有被跟踪的临时/探针脚本", () => {
		const offenders = trackedFiles().filter((f) => SCRATCH_PATTERNS.some((re) => re.test(f)));
		expect(
			offenders,
			`以下临时脚本被提交进了仓库，应移到 .scratch/（已在 .gitignore 中）或删除:\n` +
				offenders.map((f) => `  - ${f}`).join("\n"),
		).toEqual([]);
	});

	it("会话/进化 hook 只有一处构造（runner 的 attach() 会替换掉 server 的）", () => {
		// The runner calls `web.attach({sessions})`, which REPLACES the server's
		// hooks with its own. Two constructions meant the causal timeline
		// vanished from the page the moment a run started — invisible in any
		// test that never starts a run. One factory (session-store.ts) makes the
		// drift impossible; this guard keeps it that way.
		const offenders: string[] = [];
		for (const file of trackedFiles().filter((f) => f.startsWith("src/agent/") && f.endsWith(".ts"))) {
			const src = readFileSync(join(ROOT, file), "utf8");
			// A hand-built sessions hook: `sessions: {` followed by its own `list:`.
			if (/sessions:\s*\{[\s\S]{0,200}?\blist\s*:/.test(src) && !src.includes("sessionHooks(")) {
				offenders.push(file);
			}
			// The same for the evolution hooks (the runner replaces those too).
			if (/evolution:\s*\{[\s\S]{0,200}?\bmetrics\s*:/.test(src) && !src.includes("evolutionHooks(")) {
				offenders.push(file);
			}
		}
		expect(
			offenders,
			`这些文件自己造了一份 hook；请改用 sessionHooks(dataDir) / evolutionHooks(dataDir)：\n` +
				offenders.map((f) => `  - ${f}`).join("\n"),
		).toEqual([]);
	});

	it("仓库根目录只有 eslint.config.mjs 这一个 .mjs 被跟踪", () => {
		const rootMjs = trackedFiles().filter((f) => !f.includes("/") && f.endsWith(".mjs"));
		expect(rootMjs).toEqual(["eslint.config.mjs"]);
	});

	it(".scratch/ 与根目录的探针模式都在 .gitignore 里", () => {
		const gi = readFileSync(join(ROOT, ".gitignore"), "utf8");
		expect(gi).toMatch(/^\/\.scratch\/$/m);
		expect(gi).toMatch(/^\/probe\*\.mjs$/m);
		expect(gi).toMatch(/^\/vfy\*\.mjs$/m);
	});

	it(".scratch/ 目录存在(约定，不靠记忆)", () => {
		expect(existsSync(join(ROOT, ".scratch"))).toBe(true);
	});
});

describe("repo hygiene: 文档正交性（AGENTS.md §9）", () => {
	// These lock in the 2026-09-12 cleanup. The failure they prevent is silent and
	// gradual: every time a finished version's detail is appended to ROADMAP
	// instead of CHANGELOG, the two copies drift and neither can be trusted.

	it("ROADMAP 不再复述已完成版本（那属于 CHANGELOG）", () => {
		const s = doc("ROADMAP.md");
		// A completed version section looks like `### v0.5.0 — ... （✅ 完成, ...）`.
		const finished = s.match(/^###+\s+v\d+\.\d+\.\d+\s+—.*(✅|完成)/gm) ?? [];
		expect(
			finished,
			"ROADMAP must only describe what is NOT done; finished versions belong to CHANGELOG.md",
		).toEqual([]);
	});

	it("ROADMAP 里没有逐版本的验收勾选历史", () => {
		const s = doc("ROADMAP.md");
		const checked = s.match(/^- \[x\] .*(gate|passed|全绿)/gim) ?? [];
		expect(checked, "acceptance history belongs to CHANGELOG.md, not the plan").toEqual([]);
	});

	it("只有 AGENTS.md 持有文档职责表（其余文档不得复制）", () => {
		// Copying the table would make the authority itself one of six copies.
		const copies = TOP_DOCS.filter((d) => d !== "AGENTS.md" && /唯一职责/.test(doc(d)) && /不应包含/.test(doc(d)));
		expect(copies, "the responsibility table must exist in exactly one place").toEqual([]);
	});

	it("每份顶层文档都声明了自己的边界并指向 AGENTS §9", () => {
		// AGENTS.md is the authority itself, so it has nothing to point at.
		const missing = TOP_DOCS.filter((d) => d !== "AGENTS.md").filter((d) => {
			const s = doc(d);
			return !/AGENTS\.md`?\s*§9/.test(s);
		});
		expect(missing, "each doc must point at the single authority for its own boundary").toEqual([]);
	});

	it("MEMORY 不复制系统事实（只留指针）", () => {
		// A lesson may reference a fact, but the fact's authority is SPEC.md/docs.
		const s = doc("MEMORY.md");
		expect(s, "MEMORY should point at SPEC instead of restating protocol facts").toMatch(/SPEC\.md/);
	});
});

describe("交接文档必须可执行（2026-09-12）", () => {
	// 教训：ROADMAP 里曾写着 `pnpm exec tsx -e '...'` 这种单行命令，但它**跑不通**
	// （eval 模式解析不了带 .js 的 ESM import）。交接文档里的命令必须是实测过的，
	// 否则 compact 之后接手的人会卡在第一步。
	it("ROADMAP 的**可执行代码块**里不出现 tsx -e 单行命令", () => {
		const s = readFileSync(join(ROOT, "ROADMAP.md"), "utf8");
		// 只看 ``` 围起来的代码块：散文里提到"这个写法不工作"是应该保留的
		// 说明，不是一条会跑失败的命令。
		const blocks = [...s.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
		expect(blocks.length).toBeGreaterThan(0);
		for (const b of blocks) expect(b).not.toMatch(/tsx\s+-e\s/);
	});

	it("ROADMAP 引用的脚本真实存在", () => {
		const s = readFileSync(join(ROOT, "ROADMAP.md"), "utf8");
		const refs = [...s.matchAll(/(scripts\/[a-z0-9-]+\.ts)/g)].map((m) => m[1]!);
		expect(refs.length).toBeGreaterThan(0);
		for (const r of refs) {
			expect(existsSync(join(ROOT, r)), `ROADMAP references missing ${r}`).toBe(true);
		}
	});

	it("ROADMAP 引用的 SPEC 小节真实存在", () => {
		const road = readFileSync(join(ROOT, "ROADMAP.md"), "utf8");
		const spec = readFileSync(join(ROOT, "SPEC.md"), "utf8");
		const secs = [...road.matchAll(/§(10\.\d+)/g)].map((m) => m[1]!);
		expect(secs.length).toBeGreaterThan(0);
		for (const sec of new Set(secs)) {
			expect(spec.includes(`## ${sec}`), `ROADMAP cites §${sec} which SPEC does not have`).toBe(true);
		}
	});
});

/**
 * D62（2026-10-07）：`tsconfig` 只含 src+test ⇒ `scripts/*.ts`（含**判据脚本**
 * `run-experiment.ts`）带 25 个真 TS 错误裸奔，而 gate 一直是绿的。
 * 门禁的覆盖面本身要有守卫。
 */
describe("typecheck 覆盖面守卫（D62）", () => {
	it("git 跟踪的每个 *.ts 都在 typecheck 命令跑的某个 tsc 项目里", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: { typecheck: string } };
		const projects = [...pkg.scripts.typecheck.matchAll(/-p\s+(\S+)/g)].map((m) => m[1]!);
		expect(projects.length).toBeGreaterThan(0);
		// glob → regex（占位符方案：先保护 `**`，转换 `*`，再还原。
		// 链式 replace 会把插入的 `*` 也换掉——第一版守卫就是这样自伤的）。
		const toRe = (g: string): RegExp => {
			const body = g
				.split("**/").join("\u0001")
				.split("**").join("\u0002")
				.split("*").join("[^/]*")
				.split("\u0001").join("(?:[^/]+/)*")
				.split("\u0002").join(".*");
			return new RegExp(`^${body.replace(/\./g, "\\.")}$`);
		};
		const globs: Array<(f: string) => boolean> = projects.map((proj) => {
			// 只剥**行**注释：块注释正则会把 `src/**` 里的 `/**` 当注释吃掉。
			const raw = readFileSync(proj, "utf8").replace(/^\s*\/\/.*$/gm, "");
			const cfg = JSON.parse(raw) as { include?: string[] };
			const include = cfg.include ?? ["**/*.ts"];
			return (f: string) => include.some((g) => toRe(g).test(f));
		});
		const files = execFileSync("git", ["ls-files", "*.ts"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
		expect(files.length).toBeGreaterThan(10);
		const uncovered = files.filter((f) => !globs.some((g) => g(f)));
		expect(uncovered, `这些 .ts 不在任何 tsc 项目里（D62）: ${uncovered.join(", ")}`).toEqual([]);
	});
});

/**
 * 文档地图守卫（2026-10-08，docs/ 合并后）。
 *
 * 漂移的机制不是"谁写错了"，而是"同一主题有两份文档、各自被引用"，
 * 于是改一处忘一处。所以守卫钉住**登记**：docs/ 下每份文档都必须在
 * `docs/README.md` 的地图里出现；地图里列的文档必须真的存在。
 */
describe("文档地图守卫（docs/README.md）", () => {
	function docFiles(): string[] {
		return execFileSync("git", ["ls-files", "docs/*.md"], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean)
			// archive/ 是历史快照，不登记在地图里（地图只列"现在的权威"）
			.filter((f) => !f.startsWith("docs/archive/"))
			.sort();
	}

	it("docs/ 下的每份文档都在文档地图里登记", () => {
		const map = readFileSync(join(ROOT, "docs/README.md"), "utf8");
		const missing = docFiles().filter((f) => {
			// 地图自己不用登记自己。
			if (f === "docs/README.md") return false;
			const name = f.slice("docs/".length);
			return !map.includes(name);
		});
		expect(
			missing,
			`这些文档没有登记在 docs/README.md 的地图里（新增文档必须登记，否则就是漂移的入口）:\n` +
				missing.map((f) => `  - ${f}`).join("\n"),
		).toEqual([]);
	});

	it("地图里列出的文档都存在", () => {
		const map = readFileSync(join(ROOT, "docs/README.md"), "utf8");
		const linked = [...map.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => `docs/${m[1]}`);
		const missing = linked.filter((f) => !existsSync(join(ROOT, f)));
		expect(missing, `地图指向了不存在的文档: ${missing.join(", ")}`).toEqual([]);
	});

	it("归档文档带冻结横幅（不得被当成现状权威）", () => {
		const archived = execFileSync("git", ["ls-files", "docs/archive/*.md"], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean);
		for (const f of archived) {
			const text = readFileSync(join(ROOT, f), "utf8");
			expect(text, `${f} 缺少归档横幅`).toMatch(/归档/);
			expect(text, `${f} 缺少"不是当前权威"的声明`).toMatch(/不是当前权威|不是现状/);
		}
	});
});

/**
 * 文档正交性守卫（AGENTS.md §9.1a）。
 *
 * 背景：SPEC 曾有 118 条 §10.x（一个阶段一条，等于把变更日志写进事实文档），
 * ROADMAP 曾有 654 行且大半是已完成叙事。膨胀的机制不是"谁写错了"，
 * 而是**默认允许只增不减**。这三个断言把默认改掉。
 */
describe("文档正交性守卫（§9.1a）", () => {
	const SPEC_MAX_ENTRIES = 120; // §10 条目数上限：新增一条就要合并/删掉一条
	const ROADMAP_MAX_LINES = 240; // ROADMAP 只留未完成
	const ROADMAP_BANNED = ["历史", "已解决", "完成史", "开发纪律"];

	it("SPEC §10 的每一条都在 §10 索引里登记（索引 = 落位面）", () => {
		const spec = doc("SPEC.md");
		const ids = [...spec.matchAll(/^### (10\.[0-9.]+) /gm)].map((m) => m[1]!);
		expect(ids.length).toBeGreaterThan(20);
		const indexStart = spec.indexOf("### 索引（按主题");
		expect(indexStart, "SPEC 缺少 §10 索引（AGENTS.md §9.1a）").toBeGreaterThan(-1);
		const indexEnd = spec.indexOf("### 10.", indexStart + 10);
		const index = spec.slice(indexStart, indexEnd === -1 ? undefined : indexEnd);
		const missing = ids.filter((id) => !index.includes(id));
		expect(missing, `这些 §10 条目没在索引里登记: ${missing.join(", ")}`).toEqual([]);
	});

	it("SPEC §10 条目数不超预算（不允许只增不减）", () => {
		const spec = doc("SPEC.md");
		const ids = [...spec.matchAll(/^### (10\.[0-9.]+) /gm)].map((m) => m[1]!);
		expect(
			ids.length,
			`SPEC §10 有 ${ids.length} 条（上限 ${SPEC_MAX_ENTRIES}）：新增一条就要合并或删掉一条旧的`,
		).toBeLessThanOrEqual(SPEC_MAX_ENTRIES);
	});

	it("每份主文档都在行数预算内（AGENTS §9.1b）", () => {
		// 膨胀的机制是"默认只增不减"：预算把默认改掉，超出时 gate 直接拦。
		const BUDGETS: Record<string, number> = {
			"AGENTS.md": 340,
			"SPEC.md": 1300,
			"ROADMAP.md": 200,
			"CHANGELOG.md": 650,
			"MEMORY.md": 750,
			"README.md": 260,
			"README.zh-CN.md": 260,
		};
		const over: string[] = [];
		for (const [file, max] of Object.entries(BUDGETS)) {
			const lines = readFileSync(join(ROOT, file), "utf8").split("\n").length;
			if (lines > max) over.push(`${file}: ${lines}/${max}`);
		}
		expect(over, `以下文档超出预算（见 AGENTS.md §9.1b）：${over.join(", ")}`).toEqual([]);
	});

	it("docs/ 单篇不超 600 行，且归档文件都有冻结横幅", () => {
		const dir = join(ROOT, "docs");
		const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
		const big = files
			.map((f) => ({ f, n: readFileSync(join(dir, f), "utf8").split("\n").length }))
			.filter((x) => x.n > 600)
			.map((x) => `${x.f}: ${x.n}`);
		expect(big, `docs/ 单篇上限 600 行：${big.join(", ")}`).toEqual([]);

		const archiveDir = join(dir, "archive");
		if (!existsSync(archiveDir)) return;
		const banners = readdirSync(archiveDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({ f, text: readFileSync(join(archiveDir, f), "utf8") }));
		const missing = banners
			.filter((b) => !/冻结|归档|Frozen|archive/i.test(b.text.slice(0, 800)))
			.map((b) => b.f);
		expect(missing, `归档文件缺冻结横幅/归档理由：${missing.join(", ")}`).toEqual([]);
	});

	it("ROADMAP 只留未完成：无历史章节，且在行数预算内", () => {
		const roadmap = doc("ROADMAP.md");
		const lines = roadmap.split("\n").length;
		expect(lines, `ROADMAP 有 ${lines} 行（上限 ${ROADMAP_MAX_LINES}）`).toBeLessThanOrEqual(ROADMAP_MAX_LINES);
		for (const word of ROADMAP_BANNED) {
			// 只查二级标题（## …），正文里提到这些词是允许的。
			const offenders = roadmap
				.split("\n")
				.filter((l) => l.startsWith("## ") && l.includes(word))
				.map((l) => l.trim());
			expect(offenders, `ROADMAP 不该有「${word}」章节（§9.2：已完成的内容进 CHANGELOG）: ${offenders.join(" | ")}`).toEqual([]);
		}
	});
});

/**
 * B5: the front end must not **guess** what an error meant.
 *
 * 背景（CoDesign F8）：服务端曾经只给 `{error: string}`，页面用正则从这句话里猜
 * "401 该做什么"（`providers-view.js` 的 `refreshHint()`）。于是同一个 401 在
 * Providers、启动失败、门禁结果里出现三种不同文案。
 *
 * 现在错误是结构化的 `{code, message, hint}`（`src/agent/problems.ts`），页面按
 * `code` 渲染。这条守卫挡住"顺手又写回一个正则"。
 */
describe("repo hygiene: 页面不猜错误的意思（B5）", () => {
	/** Regex literals that would match a status code / auth word inside a message. */
	const GUESS_PATTERNS = [
		/\\b401\\b/,
		/\\b403\\b/,
		/\\b404\\b/,
		/unauthor/i,
		/forbidden/i,
	];

	it("前端没有用正则去猜错误文案", () => {
		const dir = join(ROOT, "src", "web", "public", "assets", "js");
		const offenders: string[] = [];
		for (const f of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
			const src = readFileSync(join(dir, f), "utf8");
			for (const re of GUESS_PATTERNS) {
				if (re.test(src)) offenders.push(`${f} (${re.source})`);
			}
		}
		expect(
			offenders,
			`页面不许用正则猜错误（错误已是结构化的 code/message/hint）：${offenders.join(", ")}`,
		).toEqual([]);
	});

	it("providers-view 不再有 refreshHint（正则猜 401 的旧办法）", () => {
		const src = readFileSync(join(ROOT, "src", "web", "public", "assets", "js", "providers-view.js"), "utf8");
		// 只看**方法定义**（注释里提到旧名字不算）。
		expect(src).not.toMatch(/^\s*refreshHint\s*\(/m);
	});
});

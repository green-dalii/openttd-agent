/**
 * Extract the static visible text of a dashboard page — the same rule the
 * i18n runtime uses to decide what it may translate.
 *
 * 职责: 给守卫测试一个**与运行时一致**的「哪些文字会被翻」的口径。
 *   运行时（i18n.js）只翻：**不在 script/style/code/pre/textarea 里**、
 *   且**在父元素里没有第二个非空文本兄弟**的文本节点。
 *   这里用一个小解析器把 HTML 切成树，再按同一条规则挑出来 ——
 *   口径不同 ⇒ 守卫会误报（或漏报），那守卫就没有价值了。
 *
 * 为什么自己写解析器（不引 jsdom）：仓库规矩是前端零依赖、禁 jsdom/headless。
 *   这里的解析只需要「标签 / 属性 / 注释 / 原始文本元素」四件事，
 *   几十行足够，且**故意**比 HTML5 解析器严格（不猜隐式闭合）。
 */

const RAW_TEXT_TAGS = new Set(["script", "style"]);
const NEVER_TRANSLATE_TAGS = new Set(["script", "style", "code", "pre", "textarea"]);

/** The HTML entities the dashboard pages actually use (plus numeric refs). */
const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	middot: "·",
	times: "×",
	minus: "−",
	rsquo: "’",
	lsquo: "‘",
	ldquo: "“",
	rdquo: "”",
	bull: "•",
	deg: "°",
	plusmn: "±",
};

/** Decode the entities the runtime sees as plain characters in the DOM. */
export function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		const hit = ENTITIES[body.toLowerCase()];
		return hit ?? whole;
	});
}

export interface VisibleText {
	/** The trimmed text the runtime would try to translate. */
	text: string;
	/** 1-based line in the source file. */
	line: number;
}

interface TextNode {
	kind: "text";
	text: string;
	line: number;
}
interface ElementNode {
	kind: "element";
	tag: string;
	attrs: Record<string, string>;
	children: Node[];
}
type Node = TextNode | ElementNode;

/** Parse HTML into a tree of elements and text nodes. */
export function parseHtml(html: string): ElementNode {
	const root: ElementNode = { kind: "element", tag: "#root", attrs: {}, children: [] };
	const stack: ElementNode[] = [root];
	const lineAt = (index: number): number => html.slice(0, index).split("\n").length;

	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt < 0) {
			pushText(stack, html.slice(i), lineAt(i));
			break;
		}
		if (lt > i) pushText(stack, html.slice(i, lt), lineAt(i));
		// comment
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			i = end < 0 ? html.length : end + 3;
			continue;
		}
		// doctype / processing instruction
		if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
			const end = html.indexOf(">", lt);
			i = end < 0 ? html.length : end + 1;
			continue;
		}
		// closing tag
		if (html.startsWith("</", lt)) {
			const end = html.indexOf(">", lt);
			const name = html.slice(lt + 2, end < 0 ? html.length : end).trim().toLowerCase();
			// pop to the matching open tag (if any)
			for (let s = stack.length - 1; s > 0; s--) {
				if (stack[s]!.tag === name) {
					stack.length = s;
					break;
				}
			}
			i = end < 0 ? html.length : end + 1;
			continue;
		}
		// opening tag
		const end = findTagEnd(html, lt);
		if (end < 0) {
			pushText(stack, html.slice(lt), lineAt(lt));
			break;
		}
		const raw = html.slice(lt, end + 1);
		const selfClosing = /\/\s*>$/.test(raw);
		const nameMatch = /^<([a-zA-Z][\w-]*)/.exec(raw);
		const tag = (nameMatch?.[1] ?? "").toLowerCase();
		const el: ElementNode = { kind: "element", tag, attrs: parseAttrs(raw), children: [] };
		stack[stack.length - 1]!.children.push(el);
		i = end + 1;
		if (selfClosing) continue;
		if (RAW_TEXT_TAGS.has(tag)) {
			// raw text element: its content is text but never translated
			const close = html.toLowerCase().indexOf(`</${tag}`, i);
			const stop = close < 0 ? html.length : close;
			el.children.push({ kind: "text", text: html.slice(i, stop), line: lineAt(i) });
			i = stop;
			continue;
		}
		stack.push(el);
	}
	return root;
}

/** The attributes of an opening tag (`name="value"` pairs). */
function parseAttrs(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const body = raw.replace(/^<\s*[a-zA-Z][\w-]*/, "").replace(/\/?\s*>$/, "");
	const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body))) {
		const name = (m[1] ?? "").toLowerCase();
		if (!name) continue;
		attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
	}
	return attrs;
}

function findTagEnd(html: string, start: number): number {
	let i = start + 1;
	let quote: string | null = null;
	while (i < html.length) {
		const ch = html[i]!;
		if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === ">") {
			return i;
		}
		i += 1;
	}
	return -1;
}

function pushText(stack: ElementNode[], text: string, line: number): void {
	if (!text) return;
	stack[stack.length - 1]!.children.push({ kind: "text", text, line });
}

/**
 * The visible texts the i18n runtime would try to translate.
 * Mirrors i18n.js: skip the never-translate ancestors (`script/style/code/pre/
 * textarea` and anything marked `data-i18n-keep`), and translate every text
 * node on its own — a sentence broken up by an inline `<code>` is translated
 * fragment by fragment, so each fragment needs its own entry.
 */
export function visibleTexts(html: string): VisibleText[] {
	const out: VisibleText[] = [];
	for (const v of inspectVisibleTexts(html)) {
		out.push({ text: v.text, line: v.line });
	}
	return out;
}

export interface InspectedText extends VisibleText {
	/**
	 * True when the text is a fragment of a mixed sentence (its parent has
	 * more than one non-empty text child, e.g. prose around an inline
	 * `<code>`). Such fragments are translated one by one, so the Chinese is
	 * authored per fragment and has to read naturally when concatenated.
	 */
	mixed: boolean;
}

/** Every visible text, with the mixed-content flag. */
export function inspectVisibleTexts(html: string): InspectedText[] {
	const out: InspectedText[] = [];
	const walk = (node: ElementNode, blocked: boolean): void => {
		const nowBlocked = blocked || NEVER_TRANSLATE_TAGS.has(node.tag) || "data-i18n-keep" in node.attrs;
		const textChildren = node.children.filter((c): c is TextNode => c.kind === "text");
		const meaningful = textChildren.filter((c) => c.text.trim() !== "");
		for (const child of node.children) {
			if (child.kind === "element") {
				walk(child, nowBlocked);
				continue;
			}
			if (nowBlocked) continue;
			const trimmed = decodeEntities(child.text.replace(/\s+/g, " ").trim());
			if (!trimmed) continue;
			out.push({ text: trimmed, line: child.line, mixed: meaningful.length > 1 });
		}
	};
	walk(parseHtml(html), false);
	return out;
}

/** Does the text need a translation? (symbols and numbers do not.) */
export function needsTranslation(text: string): boolean {
	return /[A-Za-z]/.test(text);
}

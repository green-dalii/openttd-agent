/**
 * Alpine template linter (test-only).
 *
 * 职责:静态检查页面 HTML 里的 `<template x-for>` / `<template x-if>` 结构。
 * 禁止:做完整 HTML 解析——只需要标签结构，属性值里的 `>` 由引号感知扫描处理。
 *
 * 为什么需要它:Alpine 的 `x-for` 要求模板内**恰好一个根元素**。两个兄弟根
 * 不会报编译期错误,而是在浏览器里产生
 *   `Cannot read properties of undefined (reading 'children')`
 * 以及内层模板拿不到循环变量的 `ReferenceError`。这类错误单测/类型检查/eslint
 * 都看不见,只有打开页面才会发现——所以在这里静态锁住。
 */

/** HTML 空元素(无闭合标签)。 */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

export interface TagToken {
  name: string;
  attrs: string;
  isClose: boolean;
  selfClosing: boolean;
  /** 标签起始下标。 */
  start: number;
  /** 标签结束下标(闭合 `>` 之后)。 */
  end: number;
}

/**
 * 引号感知地把 HTML 切成标签 token。
 * 属性值里出现 `>`(如 `x-if="m.x1 > 0"`)不会被误判为标签结束。
 */
export function tokenizeTags(html: string): TagToken[] {
  const out: TagToken[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    // 跳过注释
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    // 跳过 <!doctype ...> 之类
    if (html[lt + 1] === "!") {
      const close = html.indexOf(">", lt);
      i = close === -1 ? html.length : close + 1;
      continue;
    }

    let j = lt + 1;
    const isClose = html[j] === "/";
    if (isClose) j++;
    const nameStart = j;
    while (j < html.length && /[A-Za-z0-9:-]/.test(html[j]!)) j++;
    const name = html.slice(nameStart, j);
    if (!name) {
      i = lt + 1;
      continue;
    }

    // 属性区:引号感知地找闭合 `>`
    const attrsStart = j;
    let quote: string | null = null;
    while (j < html.length) {
      const ch = html[j]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j++;
    }
    const attrs = html.slice(attrsStart, j);
    const selfClosing = /\/\s*$/.test(attrs);
    out.push({
      name: name.toLowerCase(),
      attrs: attrs.replace(/\/\s*$/, ""),
      isClose,
      selfClosing,
      start: lt,
      end: Math.min(j + 1, html.length),
    });
    i = j + 1;
  }
  return out;
}

/**
 * 统计一段 HTML 里**深度为 0**的元素个数,并返回它们的标签名。
 * 文本节点、注释不计入——只有元素算"根"。
 */
export function topLevelElements(inner: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (const t of tokenizeTags(inner)) {
    if (t.isClose) {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) names.push(t.name);
    if (!t.selfClosing && !VOID_ELEMENTS.has(t.name)) depth++;
  }
  return names;
}

export interface TemplateIssue {
  /** Alpine 指令,如 `x-for="m in stageMarks(v)"`。 */
  directive: string;
  tag: string;
  problem: string;
  /** 出错位置在整份 HTML 里的字符下标。 */
  at: number;
}

/**
 * 检查所有 `<template x-for>` / `<template x-if>` 的根元素数量。
 * 递归:若唯一根恰好又是 `<template>`,继续向下检查(嵌套模板同样受限)。
 */
export function lintAlpineTemplates(html: string): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const tags = tokenizeTags(html);

  for (let idx = 0; idx < tags.length; idx++) {
    const open = tags[idx]!;
    if (open.isClose || open.name !== "template") continue;
    const m = /(x-for|x-if)\s*=/.exec(open.attrs);
    if (!m) continue;

    // 找到配对的 </template>
    let depth = 1;
    let close: TagToken | null = null;
    for (let k = idx + 1; k < tags.length; k++) {
      const t = tags[k]!;
      if (t.name !== "template") continue;
      if (t.isClose) {
        depth--;
        if (depth === 0) {
          close = t;
          break;
        }
      } else if (!t.selfClosing) {
        depth++;
      }
    }
    if (!close) {
      issues.push({
        directive: open.attrs.trim(),
        tag: m[1]!,
        problem: "找不到配对的 </template>",
        at: open.start,
      });
      continue;
    }

    const inner = html.slice(open.end, close.start);
    const roots = topLevelElements(inner);
    if (roots.length !== 1) {
      issues.push({
        directive: open.attrs.trim(),
        tag: m[1]!,
        problem:
          `模板内必须恰好一个根元素,实际 ${roots.length} 个` +
          (roots.length ? ` [${roots.join(", ")}]` : "") +
          "。多个兄弟根会破坏 Alpine 的遍历(reading 'children')并丢失循环变量作用域",
        at: open.start,
      });
    }
    // 不在此递归:主循环会遍历到嵌套的每一个 <template>,各自的偏移量才是正确的。
  }
  return issues;
}

export interface XForIssue {
  directive: string;
  at: number;
}

/**
 * `<template>` 放在 `<svg>` 内部会被 HTML 解析器当作 **SVG 命名空间元素**,
 * 不是 `HTMLTemplateElement` —— 它的 `.content` 是 `undefined`,Alpine 的 `x-for`
 * 读 `.content.children` 就抛 "Cannot read properties of undefined (reading 'children')",
 * 且循环变量永不绑定(满屏 `m is not defined`)。
 *
 * 实测证据(Chrome, 2026-09-12):
 *   { expr: 'm in stageRoutes(v)', ns: 'SVG', isHTMLTemplate: false, contentDefined: false }
 *
 * 变通:把 SVG 标记拼成**字符串**用 `x-html` 注入(注入时处于 HTML 解析上下文)。
 */
export function lintTemplatesInsideSvg(html: string): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const tags = tokenizeTags(html);

  // 用标签流追踪命名空间:进入 <svg> 后到配对 </svg> 之间的 <template> 都是非法的。
  let svgDepth = 0;
  for (const t of tags) {
    if (t.name === "svg") {
      if (t.isClose) svgDepth = Math.max(0, svgDepth - 1);
      else if (!t.selfClosing) svgDepth++;
      continue;
    }
    if (svgDepth > 0 && t.name === "template" && !t.isClose) {
      issues.push({
        directive: t.attrs.trim(),
        tag: "template",
        problem:
          "<template> 位于 <svg> 内部,会被解析成 SVG 元素(无 .content)," +
          "Alpine 的 x-for/x-if 在它上面会报 reading 'children' 并丢失循环变量。" +
          "改为把 SVG 标记拼成字符串用 x-html 注入",
        at: t.start,
      });
    }
  }
  return issues;
}

/** `x-for` 应当带 `:key`——否则列表更新时 Alpine 会复用错误节点。 */
export function lintXForKeys(html: string): XForIssue[] {
  const out: XForIssue[] = [];
  for (const t of tokenizeTags(html)) {
    if (t.isClose || t.name !== "template") continue;
    if (!/x-for\s*=/.test(t.attrs)) continue;
    if (/:key\s*=/.test(t.attrs)) continue;
    out.push({ directive: t.attrs.trim(), at: t.start });
  }
  return out;
}

/**
 * `x-for` 的迭代表达式**不得穿过可空表达式**——特别是"函数调用后取属性"。
 *
 * 为什么（2026-09-19 真实事故，AGENTS §5.2 的同一类）：`actionSurface()` 在数据加载前
 * 返回 `null` 是**正确**设计（"没加载"不能渲染成"0 条"），但
 * `<template x-for="a in actionSurface().actions">` 会**独立求值**——`x-show` 的 false
 * 拦不住它——于是每次页面加载都抛
 * `Alpine Expression Error: Cannot read properties of null (reading 'actions')`。
 *
 * `x-show` / `x-text` 容忍 null（返回 undefined，Alpine 只是不渲染），
 * **`x-for` 不容忍**：它要真的迭代。所以规则收窄在 `x-for` 上：
 * 迭代表达式里出现 `ident(...)` 后面紧跟 `.`（属性访问）就是危险形态，
 * 应当改成"视图模型提供的、永不为 null 的数组"（例如 `actionRows()`）。
 */
export function lintXForNullable(html: string): XForIssue[] {
  const out: XForIssue[] = [];
  for (const t of tokenizeTags(html)) {
    if (t.isClose || t.name !== "template") continue;
    const m = /x-for\s*=\s*"([^"]+)"/.exec(t.attrs);
    if (!m) continue;
    const expr = m[1]!;
    // `foo().bar` / `foo() . bar` → 危险；`foo?.bar` 与裸字段 `steps` → 安全
    if (/[A-Za-z_$][\w$]*\(\)\s*\./.test(expr)) {
      out.push({ directive: expr, at: t.start });
    }
  }
  return out;
}

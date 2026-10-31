/**
 * i18n runtime — the dashboard's language switch (English / 中文).
 *
 * 职责: 让**整个界面**（静态标签 + 动态渲染出来的文字）随语言切换而切换，
 *   并把选择记住（浏览器存储，走 common.js 的 getPref/setPref）。
 *
 * 为什么用「源文本作键」（gettext 模型）而不是 `data-i18n="key"`：
 *   - 界面里已经有几百条文案（4 个页面 + 10 个 view），逐条改成属性 = 一次
 *     巨大的 diff，且**键与文案分成两处**（改文案时容易忘改键）；
 *   - gettext 的做法（msgid = 源文本）让**源文本只有一处**（标记里），
 *     翻译表是第二处，且可由守卫测试兜住（每条 msgid 必须还在源里）。
 *   代价：源文本改了 ⇒ 翻译失配 ⇒ 由 `test/unit/i18n.test.ts` 的守卫测出来。
 *
 * 事实/约束:
 *   - **服务端来的文案不翻**（结局词表、问题 hint）：服务端只有一份规范文案
 *     （AGENTS B5 的「每个 code 只有一个规范 hint」），前端再翻一份就是第二份。
 *     服务端词汇按 id 本地化是下一步（前端有 id，不靠猜文案）。
 *   - `<code>` / `<pre>` / `<script>` / `<style>` 里的文本**原样保留**：
 *     那是原始证据（JSON、代码），翻译它等于篡改证据。
 *   - 缺失翻译**回落到源文本**（不显示空、不显示键名）。
 *   - 带插值的句子用 `{0}` 占位，翻译里保留同样的占位。
 */

(function () {
  const DEFAULT_LOCALE = "en";
  const SUPPORTED = ["en", "zh"];
  /** 不翻译的容器：原始证据、脚本、样式。 */
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA"]);

  /** 当前语言（存储值 or 默认）。 */
  let locale = DEFAULT_LOCALE;
  /** 编译过的模式（每个语言一份）：`{re, out}`。 */
  const compiled = new Map();
  const listeners = new Set();

  function messages(lang) {
    const table = (window.I18nMessages && window.I18nMessages[lang]) || null;
    return table || {};
  }

  function readStored() {
    try {
      // 存储只有 common.js 的 getPref/setPref 一处实现（仓库规矩：前端只有一个地方
      // 碰浏览器存储），这里走它，键名仍是自己的。
      const v = window.UI && typeof window.UI.getPref === "function" ? window.UI.getPref("locale", null) : null;
      return typeof v === "string" && SUPPORTED.includes(v) ? v : null;
    } catch {
      return null; // 隐私模式 / 存储被禁：静默用默认语言。
    }
  }

  function writeStored(lang) {
    try {
      if (window.UI && typeof window.UI.setPref === "function") window.UI.setPref("locale", lang);
    } catch {
      /* 存不下不是错误：本次会话仍然生效。 */
    }
  }

  /**
   * 把 `{0}` 占位的 msgid 编译成正则。
   * `(.+?)` 尽量少吞字符：锚定整串，替换时按捕获组回填。
   */
  function compile(table) {
    const out = [];
    for (const [key, value] of Object.entries(table)) {
      if (!key.includes("{0}")) continue;
      const parts = key.split("{0}");
      const re = new RegExp("^" + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+?)") + "$");
      out.push({ re, out: String(value) });
    }
    return out;
  }

  function patternsFor(lang) {
    if (!compiled.has(lang)) compiled.set(lang, compile(messages(lang)));
    return compiled.get(lang);
  }

  /**
   * 翻译一段文本：先查精确表，再查带占位的模式，最后回落源文本。
   * @param {string} text
   * @returns {string}
   */
  function t(text) {
    if (typeof text !== "string" || text === "") return text;
    if (locale === DEFAULT_LOCALE) return text;
    const table = messages(locale);
    if (Object.prototype.hasOwnProperty.call(table, text)) return table[text];
    for (const { re, out } of patternsFor(locale)) {
      const m = re.exec(text);
      if (!m) continue;
      let i = 0;
      return out.replace(/\{0\}/g, () => m[++i] ?? "");
    }
    return text;
  }

  /** 一段文本是否需要翻译（精确命中或命中模式）。 */
  function isTranslatable(text) {
    if (typeof text !== "string" || text === "") return false;
    const table = messages(locale);
    if (Object.prototype.hasOwnProperty.call(table, text)) return true;
    return patternsFor(locale).some(({ re }) => re.test(text));
  }

  /**
   * 把一棵 DOM 里的文本节点换成译文。
   * 只动「整段就是一个文本节点」的节点：拼接出来的富文本（`textContent` 里
   * 混着多个子节点）不动，避免把结构拆坏。
   */
  function translateTree(root) {
    if (!root || !root.nodeType) return 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        for (let el = node.parentElement; el; el = el.parentElement) {
          if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          if (el.getAttribute && el.getAttribute("data-i18n-keep") !== null) return NodeFilter.FILTER_REJECT;
        }
        const text = node.nodeValue;
        if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
        // 只在整段文本就是一个节点时替换（父元素里没有别的文字兄弟）。
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const siblings = Array.from(parent.childNodes).filter((n) => n.nodeType === 3 && n.nodeValue.trim());
        if (siblings.length > 1) return NodeFilter.FILTER_REJECT;
        return isTranslatable(text.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n = 0;
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const raw = node.nodeValue;
      // 查表用去空格的文本，写回时保留首尾空白（标记里常有排版空格）。
      const trimmed = raw.trim();
      const translated = t(trimmed);
      if (translated !== trimmed) {
        const lead = raw.slice(0, raw.length - raw.trimStart().length);
        const tail = raw.slice(raw.trimEnd().length);
        node.nodeValue = lead + translated + tail;
        n += 1;
      }
    }
    return n;
  }

  /** 切语言：换表、重刷 DOM、记住选择、通知订阅者。 */
  function setLocale(lang) {
    const next = SUPPORTED.includes(lang) ? lang : DEFAULT_LOCALE;
    if (next === locale) return locale;
    locale = next;
    writeStored(next);
    document.documentElement.setAttribute("lang", next === "zh" ? "zh-CN" : "en");
    // 先把 DOM 翻回源文本再翻到目标语言：译文的键就是源文本，直接翻会失配。
    restoreSource();
    translateTree(document.body);
    for (const fn of listeners) {
      try {
        fn(locale);
      } catch (e) {
        console.warn("[i18n] listener failed", e);
      }
    }
    return locale;
  }

  /**
   * 把 DOM 还原成源文本（每个被翻过的节点记住原文）。
   * 用 `data-i18n-src` 存原文：切语言时先还原，再翻一次，译文不必再猜原文。
   */
  function restoreSource() {
    for (const node of document.querySelectorAll("[data-i18n-src]")) {
      node.textContent = node.getAttribute("data-i18n-src");
      node.removeAttribute("data-i18n-src");
    }
  }

  function init() {
    locale = readStored() || DEFAULT_LOCALE;
    document.documentElement.setAttribute("lang", locale === "zh" ? "zh-CN" : "en");
    // 先把源文本标出来（即使当前是英文），这样第一次切语言能还原。
    markSource();
    translateTree(document.body);
    observe();
  }

  /** 标记所有「整段文本」节点的原文，供切语言时还原。 */
  function markSource() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        for (let el = node.parentElement; el; el = el.parentElement) {
          if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const siblings = Array.from(parent.childNodes).filter((n) => n.nodeType === 3 && n.nodeValue.trim());
        if (siblings.length > 1) return NodeFilter.FILTER_REJECT;
        // 只标**只有一个子节点**的元素：还原时用 textContent 写回，
        // 若元素里还有别的子节点，写回会把它们抹掉（runbar 那种布局就会掉标签）。
        if (parent.childNodes.length !== 1) return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (!parent.getAttribute("data-i18n-src")) parent.setAttribute("data-i18n-src", node.nodeValue);
    }
  }

  /** DOM 变了（Alpine 渲染出新的文字）⇒ 再翻一次。 */
  function observe() {
    if (typeof MutationObserver === "undefined") return;
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      const run = () => {
        queued = false;
        markSource();
        translateTree(document.body);
      };
      if (window.requestAnimationFrame) window.requestAnimationFrame(run);
      else setTimeout(run, 0);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.I18n = {
    locale: () => locale,
    supported: SUPPORTED.slice(),
    t,
    setLocale,
    init,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** 给测试用：把一棵 DOM 树翻一遍（返回替换了几处）。 */
    translateTree,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

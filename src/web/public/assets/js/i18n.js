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

  /** 复合句的分隔符（页面上用它把几段读数拼成一行）。 */
  const PART_SEPARATOR = " · ";
  /** 当前语言（存储值 or 默认）。 */
  let locale = DEFAULT_LOCALE;
  /** 编译过的模式（每个语言一份）：`{re, out}`。 */
  const compiled = new Map();
  const listeners = new Set();
  /**
   * 每个被翻过的文本节点的原文：`{source, translated}`。
   * 用 WeakMap（不是 DOM 属性）：原文必须跟着**文本节点**走 —— 写在父元素上
   * 的话，还原时会把父元素里的 `<code>`/`<strong>` 一起抹掉。
   */
  const sources = new WeakMap();

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
   * 把带占位符的 msgid 编译成正则。
   *
   * 占位符是 `{0}`、`{1}`……（**可以多个**）：`(.+?)` 尽量少吞字符，锚定整串；
   * 替换时按**序号**回填 —— 译文里的 `{1}` 拿到源文里 `{1}` 捕到的那一段。
   * 一句里常有多个数字（"0 active / 0 total"），所以多占位符是常态。
   */
  function compile(table) {
    const out = [];
    for (const [key, value] of Object.entries(table)) {
      const parts = key.split(/(\{[0-9]+\})/);
      if (!parts.some((p) => /^\{[0-9]+\}$/.test(p))) continue;
      const order = [];
      let pattern = "";
      for (const part of parts) {
        const ph = /^\{(\d+)\}$/.exec(part);
        if (ph) {
          order.push(Number(ph[1]));
          pattern += "(.+?)";
        } else {
          pattern += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
      }
      out.push({
        re: new RegExp("^" + pattern + "$"),
        out: String(value),
        order,
        // **具体度**：字面部分越长，模式越具体。
        // 为什么需要它："{0} runs" 与 "shown across {0} comparable runs" 都能匹配
        // "shown across 6 comparable runs" ⇒ 谁先命中取决于**表里的顺序** ⇒
        // 换个顺序就把整句吃掉一半（实测："shown across 6 comparable 局"）。
        literal: key.replace(/\{[0-9]+\}/g, "").length,
      });
    }
    // 更具体的先试。
    out.sort((a, b) => b.literal - a.literal);
    return out;
  }

  function patternsFor(lang) {
    if (!compiled.has(lang)) compiled.set(lang, compile(messages(lang)));
    return compiled.get(lang);
  }

  /**
   * 查表用的键：**空白归一**后的文本。
   *
   * 为什么必须归一：HTML 源码里一个句子常常换行写，而 DOM 里的文本节点
   * **保留那些换行与缩进**（浏览器不会把元素内部的换行变成空格）。
   * 于是源码里的 "and its\n      metric row" 与表里的键
   * "and its metric row" 对不上 ⇒ 那一段**默默不翻**（2026-11 实测：
   * 七句换行写的文案全部漏掉）。
   */
  function keyOf(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  /**
   * 翻一段文本；**翻不出来就返回 null**。
   *
   * 三层规则（从整到碎）：
   *   ① 精确表（键 = 源文本）；
   *   ② 带占位的模式（`{0}` 按序号回填，回填的片段也会再翻一次）；
   *   ③ **复合句**：整句没有词条，但它是几段拼起来的（"Money -£43,995 · Income
   *      -£43,995"）⇒ 按分隔符拆开逐段翻，再拼回去。
   *
   * 为什么要③：那些摘要是**界面文案**，不是证据；没有它，它们永远是英文。
   */
  function translateOnce(text, depth) {
    const key = keyOf(text);
    const table = messages(locale);
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    for (const { re, out, order } of patternsFor(locale)) {
      const m = re.exec(key);
      if (!m) continue;
      // 按序号回填：源文的 {1} → 译文里的 {1}。
      // 回填进去的片段**本身可能还是英文**（"data now" 里的 "now" 来自
      // `Intl.RelativeTimeFormat`）⇒ 先把片段翻好（限深，免得自己吃自己）。
      const captured = new Map();
      order.forEach((idx, i) => {
        const raw = m[i + 1] ?? "";
        captured.set(idx, depth < 2 ? translateOnce(raw, depth + 1) ?? raw : raw);
      });
      let fallback = 0;
      return out.replace(/\{(\d+)\}/g, (whole, n) => {
        const idx = Number(n);
        if (captured.has(idx)) return captured.get(idx);
        const value = captured.get(order[fallback]) ?? "";
        fallback += 1;
        return value || whole;
      });
    }
    if (depth < 2 && key.includes(PART_SEPARATOR)) {
      const parts = key.split(PART_SEPARATOR);
      let changed = false;
      const translated = parts.map((p) => {
        const one = translateOnce(p, depth + 1);
        if (one !== null && one !== p) changed = true;
        return one === null ? p : one;
      });
      if (changed) return translated.join(PART_SEPARATOR);
    }
    return null;
  }

  /**
   * 翻译一段文本：先查精确表，再查带占位的模式，最后回落源文本。
   * @param {string} text
   * @returns {string}
   */
  function t(text) {
    if (typeof text !== "string" || text === "") return text;
    if (locale === DEFAULT_LOCALE) return text;
    const out = translateOnce(text, 0);
    return out === null ? text : out;
  }

  /** 一段文本是否需要翻译（精确命中、命中模式，或能拆成可翻的片段）。 */
  function isTranslatable(text) {
    if (typeof text !== "string" || text === "") return false;
    return translateOnce(text, 0) !== null;
  }

  /**
   * 把一棵 DOM 里的文本节点换成译文。
   *
   * 每个文本节点**独立**翻译：一句被内联 `<code>` 打断的句子会被切成几段，
   * 每段各翻各的（中文按片段写，读起来仍是一句）。曾经这里要求「父元素里
   * 只能有一段文字」，结果那句话**整句都不翻** —— 那是漏，不是讲究。
   *
   * 原文记在 `sources`（WeakMap，键是文本节点本身）：切语言时把节点还原成
   * 原文再翻一次。曾经把原文写在**父元素**的 `data-i18n-src` 上，还原时用
   * `textContent` 写回 —— 那会把父元素里的 `<code>`、`<strong>` 一起抹掉。
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
        return isTranslatable(text.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n = 0;
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const raw = node.nodeValue;
      const trimmed = keyOf(raw);
      const known = sources.get(node);
      // 节点上现在的文字是不是我们翻的？是 ⇒ 原文还在 `sources` 里；
      // 不是 ⇒ 这是页面新写的文字（Alpine 重渲染），它自己就是原文。
      const isOurs = Boolean(known && known.translated === raw);
      const source = isOurs ? known.source : raw;
      const translated = t(trimmed);
      if (translated === trimmed) {
        // 没有译文：把当前文字记成原文，免得以后还原时用旧原文覆盖新文字。
        sources.set(node, { source: raw, translated: raw });
        continue;
      }
      const lead = raw.slice(0, raw.length - raw.trimStart().length);
      const tail = raw.slice(raw.trimEnd().length);
      node.nodeValue = lead + translated + tail;
      sources.set(node, { source, translated: node.nodeValue });
      n += 1;
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
   * 原文存在 `sources` 里（WeakMap）：切语言时先还原，再翻一次，
   * 译文不必再猜原文。
   */
  function restoreSource() {
    for (const node of document.querySelectorAll("[data-i18n-src]")) {
      node.textContent = node.getAttribute("data-i18n-src");
      node.removeAttribute("data-i18n-src");
    }
    // 文本节点级还原：把每个被翻过的节点写回它的原文。
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return sources.has(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const known = sources.get(node);
      if (!known) continue;
      // 只有当节点上还是我们写的译文时才还原：页面重新写过这个节点的话，
      // 旧原文会把新内容盖掉。
      if (known.translated !== node.nodeValue) continue;
      node.nodeValue = known.source;
    }
  }

  function init() {
    locale = readStored() || DEFAULT_LOCALE;
    document.documentElement.setAttribute("lang", locale === "zh" ? "zh-CN" : "en");
    translateTree(document.body);
    observe();
  }

  /**
   * 初始化时机：**必须在 Alpine 渲染之前**。
   *
   * 为什么（2026-11 实测）：Alpine 的启动是 `queueMicrotask(...)` ⇒ 它在
   * 脚本跑到一半时就开始渲染 ⇒ 而 i18n 的初始化挂在 DOMContentLoaded 上 ⇒
   * **Alpine 先渲染，i18n 后初始化** ⇒ 那些**按 id 翻**的服务端词汇（结局类、
   * 旋钮取值）在渲染那一刻用的还是默认语言（英文）⇒ 界面永远停在英文，
   * 而普通文案会被 i18n 事后翻好 ⇒ **只有那部分看起来"没翻"**。
   *
   * ⇒ 监听 `alpine:init`（Alpine 启动前触发）⇒ 目标语言在它渲染前就位了。
   */
  function initOnce() {
    if (init.done) {
      // 已经初始化过（DOMContentLoaded 又来一次）⇒ 只重刷一遍界面。
      translateTree(document.body);
      return;
    }
    init.done = true;
    init();
  }
  init.done = false;

  document.addEventListener("alpine:init", initOnce);

  /**
   * DOM 变了（Alpine 渲染出新的文字）⇒ 再翻一次。
   *
   * **必须用 `setTimeout`，不能用 `requestAnimationFrame`**（2026-11 实测）：
   * rAF 只在页面**正在渲染**时才会跑 ⇒ 标签页切到后台、或者无头浏览器里
   * 页面不渲染时，它**永远不触发** ⇒ `queued` 永远为 true ⇒ 观察器**从此
   * 死掉**（后面渲染出来的文字全是英文，而控制台干干净净）。
   * `setTimeout(0)` 没有这个依赖，还能把一串突变合并成一次翻译。
   */
  function observe() {
    if (typeof MutationObserver === "undefined") return;
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        translateTree(document.body);
      }, 0);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.I18n = {
    locale: () => locale,
    supported: SUPPORTED.slice(),
    t,
    /**
     * 翻**服务端拥有的词**：按 id 查（`outcome.token_cap`、`problem.no_credential`）。
     *
     * 为什么按 id 而不是按文案：前端词表里若出现服务端的措辞，那就是**第二份**
     * 规范文案（B5 说服务端只有一份）⇒ 服务端改一个字，前端就悄悄回落到英文。
     * 按 id 时，服务端的措辞仍然只有一份；**没翻的 id 回落到服务端的原文**
     * （不是空白、不是猜的翻译）。
     */
    term(id, fallback) {
      if (locale === DEFAULT_LOCALE) return fallback;
      if (typeof id !== "string" || id === "") return fallback;
      const table = window.I18nTerms || {};
      const v = table[id];
      return typeof v === "string" && v !== "" ? v : fallback;
    },
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
    document.addEventListener("DOMContentLoaded", initOnce);
  } else {
    initOnce();
  }
})();

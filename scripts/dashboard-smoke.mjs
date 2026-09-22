/**
 * Dashboard 冒烟检查（AGENTS §5.2 的唯一**自动化**落点）。
 *
 * 为什么必须存在：本仓库的前端单测脚手架（test/unit/helpers/frontend-harness.ts）
 * **明令禁止** jsdom/headless（保持零依赖，真机画面由 @live 覆盖），
 * 所以**没有任何单测会求值 Alpine 表达式**。"0 控制台错误"这类结论在单测里
 * 永远是**空真**——2026-09-19 就是这样漏掉了一个每次页面加载都抛的
 * `Alpine Expression Error: Cannot read properties of null (reading 'actions')`。
 *
 * 这个脚本用真实 Chrome（CDP）打开一个**正在运行的** dashboard，
 * 断言①用户可见的元素真的渲染了 ②控制台**任何级别**都没有 error/warning/exception。
 *
 * 用法：
 *   OPENTTD_DATA_DIR=/tmp/dash pnpm run cli --serve --web-port 8899 &
 *   pnpm run dashboard:smoke                 # 默认 http://127.0.0.1:8899/
 *   DASHBOARD_URL=http://127.0.0.1:9000/ pnpm run dashboard:smoke
 *
 * 退出码：0 = 通过；1 = 控制台有 error/warning/exception 或面板不可见；
 *         2 = 环境问题（没有 Chrome、dashboard 没起来）——与"页面坏了"区分开，
 *         否则 CI 里会把环境失败误读成产品失败。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
const PORT = Number(process.env.CDP_PORT || 9333);
const URL = process.env.DASHBOARD_URL || "http://127.0.0.1:8899/";

if (!CHROME) {
  console.error("SKIP: no Chrome/Chromium found. Set CHROME_PATH to run this check.");
  process.exit(2);
}
try {
  const r = await fetch(URL, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`SKIP: dashboard not reachable at ${URL} (${String(e)}). Start it with: pnpm run cli --serve --web-port 8899`);
  process.exit(2);
}


const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  "--headless=new",
  "--no-first-run",
  "--user-data-dir=/tmp/cdp-probe-profile2",
  "about:blank",
], { stdio: "ignore" });

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("chrome devtools never came up");
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
const logs = [];
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.consoleAPICalled") {
    logs.push({ level: msg.params.type, text: (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ") });
  }
  if (msg.method === "Runtime.exceptionThrown") {
    logs.push({ level: "exception", text: msg.params.exceptionDetails?.exception?.description ?? "unknown" });
  }
});
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: URL });
await sleep(4000); // Alpine boots + fetch /api/capabilities resolves

const probe = await send("Runtime.evaluate", {
  expression: `(() => {
    const el = document.getElementById('action-surface');
    if (!el) return { found: false };
    const style = getComputedStyle(el);
    const rows = [...el.querySelectorAll('.act-row')];
    const names = rows.map(r => (r.querySelector('.act-name')?.textContent || '').trim());
    const badges = rows.map(r => (r.querySelector('.act-name ~ .tag, .tag')?.textContent || '').trim());
    return {
      found: true,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && el.getBoundingClientRect().height > 0,
      height: Math.round(el.getBoundingClientRect().height),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
      rowCount: rows.length,
      names,
      badges: badges.slice(0, 4),
    };
  })()`,
  returnByValue: true,
});
console.log("PANEL:", JSON.stringify(probe.result?.value, null, 2));
const mem = await send("Runtime.evaluate", {
  expression: `(() => {
    const el = document.getElementById('memory') || document.querySelector('[data-panel="memory"]');
    const lists = [...document.querySelectorAll('.now-list, .mem-list')];
    return {
      memoryPanelFound: !!el,
      listCount: lists.length,
      bodyText: (document.body.innerText || '').includes('Memory in effect'),
      snippets: lists.map(l => (l.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 90)).slice(0, 3),
    };
  })()`,
  returnByValue: true,
});
console.log("MEMORY:", JSON.stringify(mem.result?.value, null, 2));
const bad = logs.filter((l) => l.level === "error" || l.level === "warning" || l.level === "exception");
console.log("console entries:", logs.length, "| errors/warnings/exceptions:", bad.length);
for (const b of bad.slice(0, 8)) console.log("  !!", b.level, b.text.slice(0, 200));
ws.close();
chrome.kill();
const ok = bad.length === 0 && probe.result?.value?.visible === true && probe.result?.value?.rowCount > 0;
if (!ok) {
  console.error("FAIL: see PANEL / console output above.");
}
process.exit(ok ? 0 : 1);

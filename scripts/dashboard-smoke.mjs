/**
 * Dashboard 冒烟检查（AGENTS §5.2 的唯一**自动化**落点）。
 *
 * 为什么必须存在：本仓库的前端单测脚手架（test/unit/helpers/frontend-harness.ts）
 * **明令禁止** jsdom/headless（保持零依赖，真机画面由 @live 覆盖），
 * 所以**没有任何单测会求值 Alpine 表达式**。"0 控制台错误"这类结论在单测里
 * 永远是**空真**——2026-09-19 就是这样漏掉了一个每次页面加载都抛的
 * `Alpine Expression Error: Cannot read properties of null (reading 'actions')`。
 *
 * 这个脚本用真实 Chrome（CDP）打开一个**正在运行的** dashboard，断言：
 *   ①用户可见的元素真的渲染了；②控制台**任何级别**都没有 error/warning/exception；
 *   ③**图表健康**：每个图表宿主里真的有 uPlot DOM、且尺寸在合理区间。
 *
 * ③ 是 2026-09-22 加的：图表渲染失败时页面不会明显报错——
 * `.uplot` 不存在或宿主高度塌成 120px/涨到 600px，而面板看起来还在。
 * 用户当时看到的就是"闪烁 → 载入失败 → 成功但很长"反复循环。
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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 没给 `DASHBOARD_URL` 就**自己起一个** dashboard（并自己收尾）。
 *
 * 为什么（2026-09-22）：检查写得再好，如果"需要先手动起服务"它就不会被跑——
 * 而这一轮的事故恰恰是"守卫存在但我没跑"。自带服务后它就是一条命令，
 * 也就能进收尾清单/CI。
 *
 * 只起 `--serve`（**不** `POST /api/run/start`），所以不会拉起 OpenTTD、不需要游戏二进制。
 */
let spawned = null;
let spawnTmpDir = null;
async function ensureDashboard() {
  if (process.env.DASHBOARD_URL) return process.env.DASHBOARD_URL;
  const port = Number(process.env.SMOKE_PORT || 8899);
  spawnTmpDir = mkdtempSync(join(tmpdir(), "dashboard-smoke-"));
  const { spawn: spawnProc } = await import("node:child_process");
  spawned = spawnProc("pnpm", ["run", "cli", "--serve", "--web-port", String(port)], {
    env: { ...process.env, OPENTTD_DATA_DIR: spawnTmpDir },
    stdio: "ignore",
    detached: true,
  });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        console.log(`[smoke] started a dashboard for this check: ${url}`);
        return url;
      }
    } catch {
      /* still booting */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the dashboard this script started never came up on ${url}`);
}
function stopSpawned() {
  if (spawned && spawned.pid) {
    try {
      process.kill(-spawned.pid, "SIGTERM"); // 整个进程组：pnpm → tsx → node
    } catch {
      /* already gone */
    }
  }
  if (spawnTmpDir) {
    try {
      rmSync(spawnTmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
process.on("exit", stopSpawned);
process.on("SIGINT", () => {
  stopSpawned();
  process.exit(130);
});

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
const PORT = Number(process.env.CDP_PORT || 9333);
const URL = await ensureDashboard();

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
// **设备像素比必须是 2**（Retina，用户机器的真实条件）。
// 为什么（2026-09-22，四轮误报的根因）：KPI 迷你图的高度曾每帧乘一次 `devicePixelRatio`，
// dpr=1 时增益恰好为 1 → 永远稳定 → 探针每次都报"修好了"；dpr=2 时 26→52→104→…
// 几千像素。**探针不复制用户的条件，就等于没验证**（MEMORY D48/D51）。
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2, // = Retina
  mobile: false,
});
await send("Page.navigate", { url: URL });
await sleep(4000); // Alpine boots + fetch /api/capabilities resolves

// 图表健康：每个宿主里必须真的有 uPlot 的 DOM，且尺寸合理。
// 为什么单独查（2026-09-22 血泪）：图表渲染失败时**页面不报错就不明显**——
// `.uplot` 不存在、宿主高度塌成 120px（CSS min-height）或暴涨（图例挤成高列），
// 而面板本身还在。这正是用户报的"闪烁/载入失败/成功但很长"。
const charts = await send("Runtime.evaluate", {
  expression: `(() => {
    const hosts = [...document.querySelectorAll('.chart-box > div[id]')];
    return hosts.map((h) => {
      const box = h.getBoundingClientRect();
      const up = h.querySelector('.uplot');
      return {
        id: h.id,
        hasUplot: !!up,
        w: Math.round(box.width),
        h: Math.round(box.height),
        uplotH: up ? Math.round(up.getBoundingClientRect().height) : null,
      };
    });
  })()`,
  returnByValue: true,
});
// 空 dashboard（没有跑对局）本来就没有图表数据，不能算失败；
// 但**正在跑**的时候图表必须健康——那才是用户会看的时刻。
let runActive = false;
try {
  const r = await fetch(new global.URL("/api/run", URL), { signal: AbortSignal.timeout(3000) });
  if (r.ok) runActive = (await r.json())?.state === "running";
} catch {
  /* older servers may not expose /api/run; then assert nothing about charts */
}
const chartProblems = [];
const chartList = charts.result?.value ?? [];
console.log(
  "CHARTS:",
  runActive ? JSON.stringify(chartList, null, 2) : `${chartList.length} host(s) — no active run, chart health not asserted`,
);

for (const c of runActive ? chartList : []) {
  if (!c.hasUplot) chartProblems.push(`${c.id}: 没有渲染出 uPlot（图表未挂载）`);
  else if (c.h < 140 || c.h > 420) chartProblems.push(`${c.id}: 高度异常 ${c.h}px（预期 140–420）`);
  if (c.w < 120) chartProblems.push(`${c.id}: 宽度异常 ${c.w}px`);
}

/* ======================================================================
 * 稳定性采样：**尺寸随时间**是否恒定
 * ======================================================================
 * 用户报的是"规律的从很小骤然爆炸到几千像素、然后又恢复、如此往复"——
 * 那是一个**振荡**。单帧快照对它天然免疫：任何一帧看起来都可以是"正常"的。
 * 所以这里必须采**一段时间的高度轨迹**，并断言极差（max − min）足够小。
 * 这就是前面四轮"测过了、是好的"却抓不到问题的原因。
 */
const SAMPLES = 20;
const SAMPLE_MS = 500;
const stability = [];
for (let i = 0; i < SAMPLES; i++) {
  const r = await send("Runtime.evaluate", {
    expression: `(() => ({
      dpr: window.devicePixelRatio,
      sparks: [...document.querySelectorAll('canvas.kpi-spark')].map(c => Math.round(c.getBoundingClientRect().height)),
      hosts: [...document.querySelectorAll('.chart-box > div[id]')].map(h => ({ id: h.id, h: Math.round(h.getBoundingClientRect().height) })),
      tiles: [...document.querySelectorAll('.kpis .kpi')].map(t => Math.round(t.getBoundingClientRect().height)),
      docH: document.documentElement.scrollHeight,
    }))()`,
    returnByValue: true,
  });
  if (r.result?.value) stability.push(r.result.value);
  await sleep(SAMPLE_MS);
}
const dprSeen = stability[0]?.dpr ?? null;
const spread = (vals) => (vals.length ? Math.max(...vals) - Math.min(...vals) : 0);
const col = (pick) => stability.map(pick).filter((v) => v !== undefined);
// 每个迷你图槽位的轨迹（按位置对齐；元素数量可能变化，取最大槽位数）
const slotCount = Math.max(0, ...stability.map((s) => s.sparks.length));
const sparkTraj = [];
for (let k = 0; k < slotCount; k++) {
  const vals = col((s) => s.sparks[k]).filter((v) => Number.isFinite(v));
  sparkTraj.push({ slot: k, min: Math.min(...vals), max: Math.max(...vals), spread: spread(vals), samples: vals });
}
const hostTraj = {};
for (const s of stability) {
  for (const h of s.hosts) (hostTraj[h.id] ||= []).push(h.h);
}
const tileSpread = spread(col((s) => s.tiles.length ? Math.max(...s.tiles) : 0));
const docSpread = spread(col((s) => s.docH));
console.log("STABILITY:", JSON.stringify({
  dpr: dprSeen,
  samples: stability.length,
  seconds: (stability.length * SAMPLE_MS) / 1000,
  sparks: sparkTraj,
  hosts: Object.fromEntries(Object.entries(hostTraj).map(([k, v]) => [k, { min: Math.min(...v), max: Math.max(...v), spread: spread(v) }])),
  tileSpread,
  docSpread,
}, null, 2));

const stabilityProblems = [];
// 迷你图高度：必须**恒定**（设计值 26px）且远小于爆炸值
for (const t of sparkTraj) {
  if (t.spread > 1) stabilityProblems.push(`kpi-spark[${t.slot}]: 高度在 ${(SAMPLE_MS * SAMPLES) / 1000}s 内变化 ${t.spread}px（${t.min}–${t.max}）—— 高度必须恒定`);
  if (t.max > 60) stabilityProblems.push(`kpi-spark[${t.slot}]: 高度 ${t.max}px 远超设计值 26px（纵向爆炸）`);
}
for (const [id, v] of Object.entries(hostTraj)) {
  if (spread(v) > 4) stabilityProblems.push(`${id}: 宿主高度变化 ${spread(v)}px（${Math.min(...v)}–${Math.max(...v)}）`);
}
if (tileSpread > 30) stabilityProblems.push(`KPI 卡片高度极差 ${tileSpread}px（>30 说明网格在反复重排）`);
if (dprSeen !== 2) stabilityProblems.push(`devicePixelRatio = ${dprSeen}，探针**没有**复现 Retina 条件（必须为 2）`);

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
const ok =
  bad.length === 0 &&
  probe.result?.value?.visible === true &&
  probe.result?.value?.rowCount > 0 &&
  chartProblems.length === 0 &&
  stabilityProblems.length === 0;
if (chartProblems.length) {
  console.error("FAIL（图表健康）:");
  for (const p of chartProblems) console.error("  -", p);
}
if (stabilityProblems.length) {
  console.error("FAIL（尺寸稳定性 / Retina 条件）:");
  for (const p of stabilityProblems) console.error("  -", p);
}
if (!ok) {
  console.error("FAIL: see PANEL / CHARTS / console output above.");
}
process.exit(ok ? 0 : 1);

/**
 * Unit tests — dashboard formatting (Intl digits + an explicit unit ladder).
 *
 * 职责: 锁定 `common.js` 格式化函数的对外契约（含边界与非有限输入）。
 *
 * 背景（2026-09-11 重构）: 这些函数此前是手写的 k/M/B 缩写 + 手写千分位。
 *   它们已经被换成 `Intl.NumberFormat` / `Intl.RelativeTimeFormat` /
 *   `Intl.DateTimeFormat`（浏览器原生、零依赖、自带 locale 能力），
 *   因此断言的是 **Intl 的输出契约**，而不是旧实现的字符串。
 *
 * 关键设计（2026-09-11 实测踩坑）: **不要让 ICU 决定单位后缀**。
 *   实测同一次调用在 Node 与 Chrome 上给出不同结果：
 *
 *     | 值     | Node (ICU) | Chrome 149 | 本项目 charts.js |
 *     |--------|-----------|------------|------------------|
 *     | 1500   | 1.5K      | 1.5k       | 1.5k             |
 *     | 1.5e6  | 1.5M      | 1.5m       | 1.5M             |
 *     | 1.5e9  | 1.5B      | **1.5bn**  | 1.5B             |
 *
 *   `notation:"compact"` 的**后缀拼写是 CLDR 版本数据，不是契约**：
 *   同一页面会出现 KPI 写 `£1.5bn`、图表轴写 `1.5B` 的自相矛盾，
 *   且换一次运行时/浏览器就可能再变。
 *   因此: **Intl 只负责数字部分**（千分位、四舍五入、小数位），
 *   **单位阶梯是本项目的显式约定**（与 charts.js 一致：k/M/B/T）。
 *
 * 事实来源: docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.3/§4 阶段 1。
 * 禁止: 断言具体 locale 之外的实现细节；不要为了让旧字符串继续通过而放宽断言。
 *   两个例外是刻意保留手写的——`fmtDuration`（`Intl.DurationFormat` 尚未普遍可用）
 *   与 `fmtGameDate`（游戏历法，非真实日期）。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/common.js"), "utf8");

interface Ui {
	fmtInt: (v: unknown) => string;
	fmtMoney: (v: unknown) => string;
	fmtTok: (v: unknown) => string;
	fmtCost: (v: unknown) => string;
	fmtDuration: (v: unknown) => string;
	fmtAgo: (v: unknown) => string;
	fmtClock: (v: unknown) => string;
	fmtPct: (v: unknown, digits?: number) => string;
	fmtGameDate: (d: unknown) => string;
}

function ui(): Ui {
	const sandbox: Record<string, unknown> = {
		window: {},
		document: { getElementById: () => null, createElement: () => ({}), body: {} },
		Intl,
		Date,
		Number,
		String,
		Math,
		JSON,
		Object,
		Array,
		Set,
		Map,
		console,
		localStorage: { getItem: () => null, setItem: () => {} },
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	return (sandbox.window as { UI: Ui }).UI;
}

describe("formatting (Intl-backed)", () => {
	describe("fmtInt", () => {
		it("groups thousands", () => {
			const u = ui();
			expect(u.fmtInt(1234)).toBe("1,234");
			expect(u.fmtInt(1234567)).toBe("1,234,567");
			expect(u.fmtInt(-9876543)).toBe("-9,876,543");
			expect(u.fmtInt(0)).toBe("0");
		});

		it("renders a placeholder for non-finite input, never NaN", () => {
			const u = ui();
			for (const bad of [NaN, Infinity, -Infinity, undefined, null, "abc", {}]) {
				expect(u.fmtInt(bad), String(bad)).toBe("—");
			}
		});
	});

	describe("fmtMoney", () => {
		it("uses compact notation with a currency symbol", () => {
			const u = ui();
			// The ladder is OUR vocabulary (k/M/B/T), not CLDR's; Intl only renders
			// the digits. This is what keeps it identical in Node and the browser.
			expect(u.fmtMoney(1500)).toBe("£1.5k");
			expect(u.fmtMoney(2.5e6)).toBe("£2.5M");
			expect(u.fmtMoney(3.2e9)).toBe("£3.2B");
			expect(u.fmtMoney(500)).toBe("£500"); // below the ladder threshold
			expect(u.fmtMoney(0)).toBe("£0");
		});

		it("keeps the sign for negative money", () => {
			const u = ui();
			expect(u.fmtMoney(-2.5e6)).toBe("-£2.5M");
		});

		it("handles absurdly large values without breaking the ladder", () => {
			// Regression: an unsigned read once rendered £18446744073.71B. The old
			// hand-written B/M/k ladder simply ran out of units; Intl compact falls
			// back to grouped notation, which is honest rather than wrong.
			const u = ui();
			expect(u.fmtMoney(1.8446744e19)).toBe("£18,446,744T");
			expect(u.fmtMoney(1.8446744e19)).not.toContain("NaN");
		});

		it("renders a placeholder for non-finite input", () => {
			const u = ui();
			expect(u.fmtMoney(NaN)).toBe("—");
			expect(u.fmtMoney(undefined)).toBe("—");
			expect(u.fmtMoney(null)).toBe("—");
		});
	});

	describe("fmtTok", () => {
		it("compacts token counts", () => {
			const u = ui();
			expect(u.fmtTok(0)).toBe("0");
			expect(u.fmtTok(999)).toBe("999");
			expect(u.fmtTok(1500)).toBe("1.5k");
			expect(u.fmtTok(2.5e6)).toBe("2.5M");
			expect(u.fmtTok(1.5e9)).toBe("1.5B");
			expect(u.fmtTok(1.5e12)).toBe("1.5T");
		});

		it("never emits NaN", () => {
			const u = ui();
			for (const bad of [NaN, undefined, null, "x"]) {
				expect(u.fmtTok(bad), String(bad)).not.toContain("NaN");
			}
		});
	});

	describe("fmtCost", () => {
		it("keeps more precision for sub-cent amounts", () => {
			const u = ui();
			expect(u.fmtCost(0)).toBe("$0");
			expect(u.fmtCost(0.0123)).toBe("$0.0123");
			expect(u.fmtCost(0.5)).toBe("$0.500");
		});

		it("handles non-finite input", () => {
			const u = ui();
			expect(u.fmtCost(NaN)).toBe("—");
		});
	});

	describe("fmtPct", () => {
		it("formats a fraction as a percentage", () => {
			const u = ui();
			expect(u.fmtPct(0.345)).toBe("34.5%"); // default is 1 decimal
			expect(u.fmtPct(0.345, 0)).toBe("35%");
			expect(u.fmtPct(0.5, 2)).toBe("50.00%");
			expect(u.fmtPct(0)).toBe("0.0%");
		});

		it("renders a placeholder for non-finite input", () => {
			const u = ui();
			expect(u.fmtPct(NaN)).toBe("—");
			expect(u.fmtPct(undefined)).toBe("—");
		});
	});

	describe("fmtClock", () => {
		it("renders zero-padded 24h wall time", () => {
			const u = ui();
			const t = new Date(2026, 8, 11, 14, 5, 3).getTime();
			expect(u.fmtClock(t)).toBe("14:05:03");
		});

		it("renders a placeholder for non-finite input", () => {
			const u = ui();
			expect(u.fmtClock(NaN)).toBe("—");
		});
	});

	describe("fmtAgo", () => {
		it("uses relative-time wording", () => {
			const u = ui();
			const now = Date.now();
			// Intl.RelativeTimeFormat replaced the hand-written "5m ago" ladder.
			expect(u.fmtAgo(now - 5 * 60_000)).toMatch(/5 min/iu);
			expect(u.fmtAgo(now - 3 * 3_600_000)).toMatch(/3 (hr|hour)/iu);
			expect(u.fmtAgo(now - 2 * 86_400_000)).toMatch(/2 day/iu);
		});

		it("says something sensible for a just-now timestamp", () => {
			const u = ui();
			expect(u.fmtAgo(Date.now())).toMatch(/now|0 sec/iu);
		});

		it("renders a placeholder for missing or nonsensical input", () => {
			const u = ui();
			expect(u.fmtAgo(0)).toBe("—");
			expect(u.fmtAgo(NaN)).toBe("—");
			expect(u.fmtAgo(-5)).toBe("—");
		});
	});

	describe("formats kept hand-written (no platform equivalent)", () => {
		it("fmtDuration uses compact m/s/h units", () => {
			// Intl.DurationFormat is not broadly available; this stays hand-rolled.
			const u = ui();
			expect(u.fmtDuration(500)).toBe("500ms");
			expect(u.fmtDuration(1500)).toBe("1.5s");
			expect(u.fmtDuration(90_000)).toBe("1m30s");
			expect(u.fmtDuration(3_600_000 + 600_000)).toBe("1h10m");
			expect(u.fmtDuration(NaN)).toBe("—");
		});

		it("fmtGameDate is the game calendar, not a real date", () => {
			const u = ui();
			expect(u.fmtGameDate({ year: 1950, month: 2, day: 1 })).toBe("1950-02-01");
			expect(u.fmtGameDate({ year: 1950 })).toBe("1950-01-01");
			expect(u.fmtGameDate(null)).toBe("—");
		});
	});

	describe("unit suffixes are ours, not CLDR's", () => {
		it("keeps k/M/B/T spelling even when ICU would say otherwise", () => {
			// Simulate a runtime whose compact notation differs (Chrome says
			// "1.5k"/"1.5bn"). Our output must not move with it.
			const sandbox: Record<string, unknown> = {
				window: {},
				document: { getElementById: () => null, createElement: () => ({}), body: {} },
				Date,
				Number,
				String,
				Math,
				JSON,
				Object,
				Array,
				Set,
				Map,
				console,
				localStorage: { getItem: () => null, setItem: () => {} },
			};
			// A hostile Intl: compact notation returns a deliberately alien spelling.
			sandbox.Intl = {
				NumberFormat: function (locale: string, opts: Record<string, unknown> = {}) {
					if (opts.notation === "compact") {
						return {
							format: () => {
								throw new Error("compact notation must not be used for our ladder");
							},
						};
					}
					return new Intl.NumberFormat(locale, opts as Intl.NumberFormatOptions);
				},
				RelativeTimeFormat: Intl.RelativeTimeFormat,
				DateTimeFormat: Intl.DateTimeFormat,
			};
			sandbox.globalThis = sandbox;
			vm.createContext(sandbox);
			vm.runInContext(SRC, sandbox);
			const u = (sandbox.window as { UI: Ui }).UI;

			// These must work without ever calling compact notation.
			expect(u.fmtMoney(2.5e6)).toBe("£2.5M");
			expect(u.fmtTok(1.5e9)).toBe("1.5B");
		});

		it("agrees with charts.js, which shares the same vocabulary", () => {
			const u = ui();
			const chartsSrc = readFileSync(
				join(PUBLIC_DIR, "assets/js/charts.js"),
				"utf8",
			);
			const sandbox: Record<string, unknown> = { window: {}, devicePixelRatio: 1 };
			vm.createContext(sandbox);
			vm.runInContext(chartsSrc, sandbox);
			const charts = (sandbox.window as {
				Charts: { util: { fmtCompact: (v: number) => string } };
			}).Charts;

			// Same numbers must read the same on a KPI tile and on a chart axis.
			for (const v of [1500, 15_000, 1.5e6, 1.5e9, 1.5e12]) {
				expect(u.fmtTok(v), `fmtTok(${v}) vs charts.fmtCompact`).toBe(
					charts.util.fmtCompact(v),
				);
			}
		});
	});

	describe("formatter instances are cached", () => {
		it("does not rebuild an Intl formatter per call", () => {
			// `new Intl.NumberFormat()` is expensive and these run inside render
			// loops. Count constructions in a sandbox that records them.
			const sandbox: Record<string, unknown> = {
				window: {},
				document: { getElementById: () => null, createElement: () => ({}), body: {} },
				Date,
				Number,
				String,
				Math,
				JSON,
				Object,
				Array,
				Set,
				Map,
				console,
				localStorage: { getItem: () => null, setItem: () => {} },
			};
			let built = 0;
			// Wrap the real constructors rather than reimplementing Intl.
			const counting = {
				NumberFormat: function (...args: unknown[]) {
					built++;
					return new Intl.NumberFormat(
						...(args as ConstructorParameters<typeof Intl.NumberFormat>),
					);
				},
				RelativeTimeFormat: function (...args: unknown[]) {
					built++;
					return new Intl.RelativeTimeFormat(
						...(args as ConstructorParameters<typeof Intl.RelativeTimeFormat>),
					);
				},
				DateTimeFormat: function (...args: unknown[]) {
					built++;
					return new Intl.DateTimeFormat(
						...(args as ConstructorParameters<typeof Intl.DateTimeFormat>),
					);
				},
			};
			sandbox.Intl = counting;
			sandbox.globalThis = sandbox;
			vm.createContext(sandbox);
			vm.runInContext(SRC, sandbox);
			const u = (sandbox.window as { UI: Ui }).UI;

			built = 0;
			for (let i = 0; i < 50; i++) {
				u.fmtInt(1234);
				u.fmtMoney(1500);
				u.fmtTok(1500);
				u.fmtPct(0.5);
			}
			// 4 distinct formatter configurations, built once each at most.
			expect(built).toBeLessThanOrEqual(4);
		});
	});
});

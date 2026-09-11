import tseslint from "typescript-eslint";

/**
 * 前端脚本（src/web/public/assets/js/*.js）**不经过构建链**，tsc 看不到它们，
 * 所以必须由 eslint 兜住最容易犯、后果最严重的错误。
 *
 * 为什么加这一段（2026-09-11 事故）: live.js 里 `const body` 遮蔽了同名参数。
 * 语法检查通过（`node --check` 只查语法），静态符号检查通过，
 * curl 直打 API 也通过 —— 但用户点按钮时 `JSON.stringify(body)` 落进 TDZ 抛
 * ReferenceError，异常被 catch 成 toast，于是"点了没反应、控制台干净"。
 * `no-shadow` 正是能在写代码时就抓住它的规则。
 *
 * 行为层由 test/unit/live-run-controls.test.ts（真实点击路径）覆盖。
 */
const FRONTEND_GLOBALS = {
	window: "readonly",
	document: "readonly",
	console: "readonly",
	fetch: "readonly",
	localStorage: "readonly",
	sessionStorage: "readonly",
	WebSocket: "readonly",
	requestAnimationFrame: "readonly",
	cancelAnimationFrame: "readonly",
	ResizeObserver: "readonly",
	IntersectionObserver: "readonly",
	devicePixelRatio: "readonly",
	performance: "readonly",
	setTimeout: "readonly",
	clearTimeout: "readonly",
	setInterval: "readonly",
	clearInterval: "readonly",
	matchMedia: "readonly",
	getComputedStyle: "readonly",
	navigator: "readonly",
	location: "readonly",
	AbortController: "readonly",
	Event: "readonly",
	CustomEvent: "readonly",
	Image: "readonly",
};

export default tseslint.config(
	{ ignores: ["node_modules/", "dist/", "coverage/"] },
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			"no-console": "warn",
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	{
		files: ["src/web/public/**/*.js"],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "script",
			globals: FRONTEND_GLOBALS,
		},
		linterOptions: { reportUnusedDisableDirectives: true },
		rules: {
			// These are plain scripts, not TypeScript: the TS-flavoured variants
			// (which also duplicate the base rules) only add confusion here.
			"@typescript-eslint/no-unused-expressions": "off",
			"@typescript-eslint/no-unused-vars": "off",
			// Correctness only - these have all bitten us or prevented a bite.
			"no-dupe-keys": "error", // duplicate object keys silently win
			"no-dupe-args": "error",
			"no-redeclare": "error",
			"no-unreachable": "error",
			"no-cond-assign": "error",
			"no-constant-condition": "error",
			"no-self-assign": "error",
			"no-sparse-arrays": "error",
			"no-unsafe-negation": "error",
			"use-isnan": "error",
			"valid-typeof": "error",
			"no-empty": ["error", { allowEmptyCatch: true }],
			"no-func-assign": "error",
			"no-obj-calls": "error",
			"no-unexpected-multiline": "error",
			"no-fallthrough": "error",
			"no-useless-catch": "error",
			// The TDZ bug class: inner binding shadowing the parameter it is read from.
			// `a && a()` and `c ? f() : g()` are used deliberately for side effects
			// throughout these files; allow those two forms but still catch a
			// genuinely stray expression (e.g. a forgotten call).
			"no-unused-expressions": [
				"error",
				{ allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true },
			],
			"no-shadow": "warn",
			"no-undef": "error", // a typo'd global is a blank page
			"no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
		},
	},
);

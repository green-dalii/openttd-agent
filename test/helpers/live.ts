/**
 * Live-test helpers.
 *
 * 职责: `pnpm test` (unit-only) 跳过 @live 用例; `pnpm run test:live`
 *   (LIVE_TESTS=1) 才执行真机集成 (需要本机 OpenTTD 二进制)。
 */

export const IS_LIVE = process.env.LIVE_TESTS === "1";

/** Use with describe/it: describe.skipIf(!IS_LIVE)(...). */
export const live = {
	/** True when live tests should run. */
	enabled: IS_LIVE,
	/** Skip tag for vitest. */
	skip: !IS_LIVE,
};

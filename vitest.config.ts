import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// @live-tagged tests are skipped unless LIVE_TESTS=1
		testTimeout: 15_000,
		hookTimeout: 30_000,
		fileParallelism: true,
	},
});

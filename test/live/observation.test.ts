/* eslint-disable no-console */
/**
 * Live integration test — v0.1.0 observation loop against real OpenTTD.
 * Requires OPENTTD_BINARY + a writable temp data dir. Skipped unless LIVE_TESTS=1.
 *
 * Flow: spawn dedicated server (temp dir) -> AdminClient join -> rcon start_ai
 *   "CPU" -> expect company_new + company_info (isAi) + company_economy via poll.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { OpenTTDProcessManager } from "../../src/game/process-manager.js";
import { AdminClient } from "../../src/game/admin-client.js";
import { WorldState } from "../../src/game/world-state.js";
import { live } from "../helpers/live.js";

const BINARY = process.env.OPENTTD_BINARY;

describe.skipIf(live.skip)("live: observation loop (real OpenTTD)", () => {
	it("start_ai CPU -> company economy observed", async () => {
		expect(BINARY, "OPENTTD_BINARY must be set for live tests").toBeTruthy();
		const dir = await mkdtemp(join(tmpdir(), "ottd-live-"));
		try {
			const cfg = loadConfig({
				OPENTTD_BINARY: BINARY,
				OPENTTD_DATA_DIR: dir,
				OPENTTD_ADMIN_PASSWORD: "live-test-pw",
				OPENTTD_SEED: "7",
				OPENTTD_START_YEAR: "1950",
			});
			const mgr = new OpenTTDProcessManager(cfg);
			mgr.onExit = (code) => console.log(`[live] server exited ${code}`);

			await mgr.ensureSandboxConfig();
			await mgr.start();
			await mgr.waitForAdminPort(25_000);

			const world = new WorldState();
			const client = new AdminClient({
				cfg,
				callbacks: { onEvent: (ev) => world.ingest(ev) },
			});
			await client.connect(10_000);

			// Wait until authed, then start the AI.
			const deadline = Date.now() + 15_000;
			while (!client.isAuthed() && Date.now() < deadline) {
				await sleep(100);
			}
			expect(client.isAuthed(), "admin auth within 15s").toBe(true);
			client.rcon(`start_ai "CPU"`);
			console.log("[live] rcon start_ai CPU sent");

			// Wait for company_economy event.
			const ecoDeadline = Date.now() + 45_000;
			while (Date.now() < ecoDeadline) {
				const snap = world.snapshot();
				const hasEco = [...snap.companies.values()].some((c) => c.economy !== null);
				if (hasEco) break;
				// Periodic poll keeps the server honest.
				for (const [id] of snap.companies) client.pollCompanyEconomy(id);
				await sleep(500);
			}

			const snap = world.snapshot();
			const withEco = [...snap.companies.values()].filter((c) => c.economy);
			console.log(
				`[live] companies=${snap.companies.size} withEconomy=${withEco.length} date=${JSON.stringify(snap.date)}`,
			);
			expect(withEco.length).toBeGreaterThanOrEqual(1);
			const eco = withEco[0]!.economy!;
			expect(typeof eco.money).toBe("bigint");
			expect(eco.money >= 0n).toBe(true);
			expect(snap.date).not.toBeNull();

			client.close();
			await mgr.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

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
	// 90s: the internal budget below (45s for the first economy) must be able to
	// finish inside the test, or the test can only ever report "timed out" - which
	// is exactly what it did on main (global testTimeout is 15s).
	it("start_ai CPU -> company economy observed", async () => {
		expect(BINARY, "OPENTTD_BINARY must be set for live tests").toBeTruthy();
		const dir = await mkdtemp(join(tmpdir(), "ottd-live-"));
		// Declared outside the try so `finally` can always stop them.
		let mgr: OpenTTDProcessManager | null = null;
		let client: AdminClient | null = null;
		try {
			const cfg = loadConfig({
				OPENTTD_BINARY: BINARY,
				OPENTTD_DATA_DIR: dir,
				OPENTTD_ADMIN_PASSWORD: "live-test-pw",
				OPENTTD_SEED: "7",
				OPENTTD_START_YEAR: "1950",
			});
			mgr = new OpenTTDProcessManager(cfg);
			mgr.onExit = (code) => console.log(`[live] server exited ${code}`);

			await mgr!.ensureSandboxConfig();
			await mgr!.start();
			await mgr!.waitForAdminPort(25_000);

			const world = new WorldState();
			client = new AdminClient({
				cfg,
				callbacks: { onEvent: (ev) => world.ingest(ev) },
			});
			// `connect()` is a single attempt: OpenTTD keeps the admin port open while
			// the map is still generating, so the JOIN is routinely kicked in that
			// window (`'' has disconnected` / ECONNRESET). `connectAuthed()` retries
			// until Welcome - which is why it exists (see its doc comment).
			await client!.connectAuthed(45_000);
			expect(client!.isAuthed(), "admin auth after connectAuthed").toBe(true);
			client!.rcon(`start_ai "CPU"`);
			console.log("[live] rcon start_ai CPU sent");

			// Wait for company_economy event.
			const ecoDeadline = Date.now() + 45_000;
			while (Date.now() < ecoDeadline) {
				const snap = world.snapshot();
				const hasEco = [...snap.companies.values()].some((c) => c.economy !== null);
				if (hasEco) break;
				// Periodic poll keeps the server honest.
				for (const [id] of snap.companies) client!.pollCompanyEconomy(id);
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

			client!.close();
			await mgr!.stop();
		} finally {
			// Best-effort teardown: a failed assertion must not leave a dedicated
			// server holding 3977/3979 - that silently makes the next `gate` skip 13
			// preflight cases (`gameRunIsLive()`), which is worse than the failure.
			try {
				client?.close();
			} catch {
				/* already closed */
			}
			try {
				await mgr!.stop();
			} catch {
				/* never started */
			}
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);
});

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/* Spike: after start_ai ExecutorV1, poll company info repeatedly and print names. */
import { loadConfig } from "$HOME/project/openttd-agent/src/config.js";
import { OpenTTDProcessManager } from "$HOME/project/openttd-agent/src/game/process-manager.js";
import { AdminClient } from "$HOME/project/openttd-agent/src/game/admin-client.js";
import { WorldState } from "$HOME/project/openttd-agent/src/game/world-state.js";

const cfg = loadConfig({ ...process.env });
const mgr = new OpenTTDProcessManager(cfg);
mgr.onExit = () => {};
await mgr.ensureSandboxConfig();
await mgr.start();
await mgr.waitForAdminPort(20000);

const world = new WorldState();
const client = new AdminClient({
	cfg,
	callbacks: {
		onEvent: (ev) => {
			world.ingest(ev);
			if (ev.kind === "company_info" || ev.kind === "company_new") {
				console.log("[spike] " + JSON.stringify(ev.payload));
			}
			if (ev.kind === "console") {
				console.log("[spike:console]", JSON.stringify(ev.payload).slice(0, 200));
			}
		},
		onStatusChange: () => {},
	},
});
await client.connect(10000);
await sleep(2000);
client.rcon('start_ai "ExecutorV1"');
console.log("[spike] start_ai sent; polling company info 25s...");
for (let i = 0; i < 25; i++) {
	const snap = world.snapshot();
	for (const [id, cs] of snap.companies) {
		console.log(`[spike:snap] company ${id}: name="${cs.info?.name}" isAi=${cs.info?.isAi}`);
	}
	client.poll(2 as number, 0xffffffff); // CompanyInfo all
	await sleep(1000);
}
client.close();
await mgr.stop();
process.exit(0);
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * BridgeV1 GS — admin <-> in-game command relay + state heartbeat.
 *
 * 职责 (SPEC §3.2 Bridge GS): 唯一 GS。收 AdminGameScript JSON (ScriptEventAdminPort)
 *   → 处理高层动作 (ping/blueprint/status/clear) → GSSign 放 `NUTZ:` 标牌给
 *   Executor AI 消费; 周期 GSAdmin.Send 状态心跳给外部。
 * 事实来源: SPEC §10.11 (事件 API/双向通道), arena bridge_gs.py 蓝图标牌语法。
 * 禁止: 不做施工决策 (Executor AI 的活); 不碰其它公司。
 */

class BridgeV1 extends GSController {
    _last_send = 0;
    _admin_seen = 0;
    _last_cmd = "";
    _sign_count = 0;
    _route_seq = 0;

    function Start() {
        while (true) {
            this.HandleEvents();
            if (GSController.GetTick() > this._last_send + 200) {
                this._last_send = GSController.GetTick();
                local sl = GSSignList();
                local sc = 0;
                local names = [];
                foreach (s, _ in sl) {
                    sc++;
                    if (names.len() < 5) {
                        local n = GSSign.GetName(s);
                        if (n != null) names.push(n);
                    }
                }
                this._sign_count = sc;
                GSAdmin.Send({
                    cmd = "state", tick = GSController.GetTick(),
                    date = GSDate.GetCurrentDate(),
                    towns = GSTownList().Count(),
                    admin_seen = this._admin_seen,
                    last_cmd = this._last_cmd,
                    signs = sc,
                    sign_names = names,
                });
            }
            this.Sleep(20);
        }
    }

    function HandleEvents() {
        while (GSEventController.IsEventWaiting()) {
            local ev = GSEventController.GetNextEvent();
            if (ev == null) break;
            local t = ev.GetEventType();
            if (t == GSEvent.ET_ADMIN_PORT) {
                local ap = GSEventAdminPort.Convert(ev);
                local obj = ap.GetObject();
                this._admin_seen++;
                if (obj != null && obj.rawin("cmd")) {
                    this._last_cmd = "" + obj["cmd"];
                    this.Dispatch(obj);
                } else {
                    GSAdmin.Send({ kind = "err", cmd = "admin_port",
                                   reason = "no cmd key",
                                   got = (obj == null ? "null" : typeof obj) });
                }
            }
        }
    }

    /* Dispatch an admin command object. */
    function Dispatch(obj) {
        local cmd = obj["cmd"];
        if (cmd == "ping") {
            GSAdmin.Send({ kind = "pong", cmd = "ping", ok = true });
        } else if (cmd == "demo") {
            // v0.2 demo: place a job sign visible to the executor AI. Signs must
            // be built in the executor's company mode (ScriptCompanyMode), else
            // AISignList ("signs your company created") won't show them.
            local exec = GSCompany.COMPANY_INVALID;
            if (obj.rawin("company")) exec = obj["company"];
            local tl = GSTownList();
            local towns = [];
            foreach (tid, _ in tl) { towns.push(tid); if (towns.len() >= 2) break; }
            if (towns.len() < 1) {
                GSAdmin.Send({ kind = "err", cmd = "demo", reason = "no towns" });
                return;
            }
            local job = 7;
            local tA = this.FindFreeTileNear(GSTown.GetLocation(towns[0]), 10);
            local placed = 0;
            local mode = GSCompanyMode(exec);
            if (GSSign.BuildSign(tA, "NUTZ:bp:" + job + ":S:fr=0:eg=-1")) placed++;
            // recount INSIDE company mode (deity GSSignList won't see co-owned)
            local names = [];
            local sl = GSSignList();
            foreach (sid, _ in sl) {
                local nm = GSSign.GetName(sid);
                if (nm != null && names.len() < 3) names.push(nm);
            }
            GSAdmin.Send({ kind = "ack", cmd = "demo", job = job, placed = placed,
                           town = towns[0], tile = tA, company = exec,
                           company_signs = names.len(), names = names });
        } else if (cmd == "build_bus_route") {
            this.BuildBusRoute(obj);
        } else if (cmd == "blueprint") {
            this.PlaceBlueprint(obj);
        } else if (cmd == "status") {
            GSAdmin.Send({ kind = "status", ok = true,
                           signs = this._sign_count,
                           tick = GSController.GetTick() });
        } else if (cmd == "clear") {
            local removed = 0;
            local sl = GSSignList();
            foreach (s, _ in sl) {
                local n = GSSign.GetName(s);
                if (n != null && n.len() >= 5 && n.slice(0, 5) == "NUTZ:") {
                    if (GSSign.RemoveSign(s)) removed++;
                }
            }
            GSAdmin.Send({ kind = "ack", cmd = "clear", removed = removed });
        } else {
            GSAdmin.Send({ kind = "err", cmd = cmd, reason = "unknown cmd" });
        }
    }

    /* Place NUTZ blueprint signs for the Executor AI (arena grammar):
     *   NUTZ:bp:<job>:S:fr=<front>:eg=<engine>   station A
     *   NUTZ:bp:<job>:E:fr=<front>               station B
     *   NUTZ:bp:<job>:D:fr=<front>               depot
     *   NUTZ:bp:<job>:W:<i>                      waypoints (path tiles)
     * Obj shape mirrors src/types.ts Blueprint + job. */
    function PlaceBlueprint(obj) {
        if (!obj.rawin("job"))      { GSAdmin.Send({ kind = "err", cmd = "blueprint", reason = "no job" }); return; }
        if (!obj.rawin("stations")) { GSAdmin.Send({ kind = "err", cmd = "blueprint", reason = "no stations" }); return; }
        if (!obj.rawin("path"))     { GSAdmin.Send({ kind = "err", cmd = "blueprint", reason = "no path" }); return; }
        if (!obj.rawin("depot"))    { GSAdmin.Send({ kind = "err", cmd = "blueprint", reason = "no depot" }); return; }
        local job = obj["job"];
        local job_str = "" + job;
        local stations = obj["stations"];
        local path = obj["path"];
        local depot = obj["depot"];
        local engine = -1;
        if (!obj.rawin("engine")) { /* optional */ } else { engine = obj["engine"]; }
        // Build signs in the executor's company mode so its AISignList can see
        // them. Company id comes from the command (GS can't enumerate companies).
        local exec = GSCompany.COMPANY_INVALID;
        if (obj.rawin("company")) exec = obj["company"];
        local mode = null;
        if (exec != GSCompany.COMPANY_INVALID) mode = GSCompanyMode(exec);
        local placed = 0;
        local sa = stations[0]; local sb = stations[1];
        local tA = sa[0]; local fA = sa[1];
        local tB = sb[0]; local fB = sb[1];
        local tD = depot[0]; local fD = depot[1];
        // Clear any stale signs for this job first.
        local sl = GSSignList();
        foreach (s, _ in sl) {
            local n = GSSign.GetName(s);
            if (n != null && n.len() > (7 + job_str.len()) && n.slice(0, 8) == "NUTZ:bp:" + job_str + ":") {
                GSSign.RemoveSign(s);
            }
        }
        // NOTE: GSSign.BuildSign returns the new SignID (0 is valid & the first
        // sign!) — using it as a boolean miscounts. Count by checking existence
        // via GSSignList afterwards instead.
        local countBefore = this.CountSignsWithPrefix("NUTZ:bp:" + job_str + ":");
        GSSign.BuildSign(tA, "NUTZ:bp:" + job_str + ":S:fr=" + fA + ":eg=" + engine);
        GSSign.BuildSign(tB, "NUTZ:bp:" + job_str + ":E:fr=" + fB);
        GSSign.BuildSign(tD, "NUTZ:bp:" + job_str + ":D:fr=" + fD);
        for (local i = 0; i < path.len() && i < 200; i++) {
            GSSign.BuildSign(path[i], "NUTZ:bp:" + job_str + ":W:" + i);
        }
        local countAfter = this.CountSignsWithPrefix("NUTZ:bp:" + job_str + ":");
        placed = countAfter - countBefore;
        GSAdmin.Send({ kind = "ack", cmd = "blueprint", job = job, placed = placed });
    }

    /* Count signs whose name starts with `prefix`. */
    function CountSignsWithPrefix(prefix) {
        local sl = GSSignList();
        local n = 0;
        foreach (s, _ in sl) {
            local nm = GSSign.GetName(s);
            if (nm != null && nm.len() >= prefix.len() && nm.slice(0, prefix.len()) == prefix) n++;
        }
        return n;
    }

    /* Find a sign-placable free land tile near `center` within `radius` tiles.
     * Signs can only be built on valid, empty (sign-able) tiles. */
    function FindFreeTileNear(center, radius) {
        local cx = GSMap.GetTileX(center);
        local cy = GSMap.GetTileY(center);
        for (local r = 0; r <= radius; r++) {
            // scan square ring at distance r
            for (local dx = -r; dx <= r; dx++) {
                for (local dy = -r; dy <= r; dy++) {
                    if (dx != -r && dx != r && dy != -r && dy != r) continue; // ring only
                    local x = cx + dx; local y = cy + dy;
                    if (x < 0 || y < 0) continue;
                    if (x >= GSMap.GetMapSizeX() || y >= GSMap.GetMapSizeY()) continue;
                    local t = GSMap.GetTileIndex(x, y);
                    if (GSTile.IsBuildable(t)) return t;
                }
            }
        }
        return center;
    }

    /* S1: v0.2 decision-loop — plan a bus route between two towns.
     * Picks the two most-populated towns (or explicit town ids from the
     * command), finds a [station, front] build-site pair near each town
     * center, and places S/E signs in the executor's company mode. The
     * Executor AI (S2+) reads the signs, fine-scans pax production, builds
     * the stops, then roads (Pathfinder.Road), a depot, a bus and orders.
     * Sign grammar (arena): NUTZ:bp:<job>:S:fr=<front>:eg=<engine> (station
     * A, sign tile = stop tile) and NUTZ:bp:<job>:E:fr=<front> (station B).
     * NOTE: building signs requires GSCompanyMode(company) so the executor's
     * AISignList can see them (SPEC 10.12). */
    function BuildBusRoute(obj) {
        if (!obj.rawin("company")) {
            GSAdmin.Send({ kind = "err", cmd = "build_bus_route", reason = "no company" });
            return;
        }
        local exec = obj["company"];
        // Job id: explicit or auto-increment (demo used 7; keep new ids clear).
        local job = obj.rawin("job") ? obj["job"] : (100 + this._route_seq);
        this._route_seq++;
        // Towns: explicit ids win, else auto-pick a viable pair.
        local townA = obj.rawin("townA") ? obj["townA"] : -1;
        local townB = obj.rawin("townB") ? obj["townB"] : -1;
        if (townA < 0 || townB < 0) {
            local pair = this.PickTownPair();
            if (pair == null) {
                GSAdmin.Send({ kind = "err", cmd = "build_bus_route", reason = "no town pair" });
                return;
            }
            if (townA < 0) townA = pair[0];
            if (townB < 0) townB = pair[1];
        }
        local cA = GSTown.GetLocation(townA);
        local cB = GSTown.GetLocation(townB);
        // A route needs two *different* town centers.
        if (cA == cB) {
            GSAdmin.Send({ kind = "err", cmd = "build_bus_route", reason = "same town" });
            return;
        }
        local siteA = this.FindStationSite(cA, 12);
        local siteB = this.FindStationSite(cB, 12);
        if (siteA == null || siteB == null) {
            GSAdmin.Send({ kind = "err", cmd = "build_bus_route", job = job,
                           reason = "no buildable site near " +
                                     (siteA == null ? "A" : "B") });
            return;
        }
        local tA = siteA[0]; local fA = siteA[1];
        local tB = siteB[0]; local fB = siteB[1];
        local job_str = "" + job;
        // S4: find a depot site roughly midway between the two stations so the
        // bus has a short hop to either stop. Best-effort: if no site is
        // found we still place S/E (executor can build a depot itself later).
        local siteD = this.FindDepotSite(tA, tB);
        local mode = GSCompanyMode(exec);
        // Clear stale signs for this job first.
        this.ClearJobSigns(job_str);
        local countBefore = this.CountSignsWithPrefix("NUTZ:bp:" + job_str + ":");
        GSSign.BuildSign(tA, "NUTZ:bp:" + job_str + ":S:fr=" + fA + ":eg=-1");
        GSSign.BuildSign(tB, "NUTZ:bp:" + job_str + ":E:fr=" + fB);
        if (siteD != null) {
            GSSign.BuildSign(siteD[0], "NUTZ:bp:" + job_str + ":D:fr=" + siteD[1]);
        }
        // Recount INSIDE company mode (deity GSSignList hides co-owned signs).
        local names = [];
        local sl = GSSignList();
        local company_signs = 0;
        foreach (sid, _ in sl) {
            local nm = GSSign.GetName(sid);
            if (nm != null && nm.len() >= 5 && nm.slice(0, 5) == "NUTZ:") {
                company_signs++;
                if (names.len() < 4) names.push(nm);
            }
        }
        GSAdmin.Send({ kind = "ack", cmd = "build_bus_route", job = job,
                       townA = townA, townB = townB, popA = GSTown.GetPopulation(townA),
                       popB = GSTown.GetPopulation(townB),
                       tileA = tA, frontA = fA, tileB = tB, frontB = fB,
                       depot = (siteD == null ? -1 : siteD[0]),
                       company = exec, company_signs = company_signs,
                       names = names });
    }

    /* Find a depot site between station tiles `ta` and `tb`: scans around
     * the midpoint for a buildable, non-water [tile, front] pair where both
     * tiles are buildable (road depot + its approach). Returns [tile, front]
     * or null. Front chosen as the neighbour pointing back toward station A
     * so the depot connector road heads the right way. */
    function FindDepotSite(ta, tb) {
        local ax = GSMap.GetTileX(ta); local ay = GSMap.GetTileY(ta);
        local bx = GSMap.GetTileX(tb); local by = GSMap.GetTileY(tb);
        local mx = (ax + bx) / 2; local my = (ay + by) / 2;
        local dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (local r = 0; r <= 8; r++) {
            for (local dx = -r; dx <= r; dx++) {
                for (local dy = -r; dy <= r; dy++) {
                    if (dx != -r && dx != r && dy != -r && dy != r) continue;
                    local x = mx + dx; local y = my + dy;
                    if (x < 0 || y < 0) continue;
                    if (x >= GSMap.GetMapSizeX() || y >= GSMap.GetMapSizeY()) continue;
                    local tile = GSMap.GetTileIndex(x, y);
                    if (GSTile.IsWaterTile(tile)) continue;
                    if (!GSTile.IsBuildable(tile)) continue;
                    foreach (d in dirs) {
                        local fx = x + d[0]; local fy = y + d[1];
                        if (fx < 0 || fy < 0) continue;
                        if (fx >= GSMap.GetMapSizeX() || fy >= GSMap.GetMapSizeY()) continue;
                        local front = GSMap.GetTileIndex(fx, fy);
                        if (GSTile.IsWaterTile(front)) continue;
                        if (!GSTile.IsBuildable(front)) continue;
                        return [tile, front];
                    }
                }
            }
        }
        return null;
    }

    /* Remove all NUTZ signs carrying job `job_str`. */
    function ClearJobSigns(job_str) {
        local sl = GSSignList();
        foreach (s, _ in sl) {
            local n = GSSign.GetName(s);
            if (n != null && n.len() > (7 + job_str.len()) &&
                n.slice(0, 8) == "NUTZ:bp:" + job_str + ":") {
                GSSign.RemoveSign(s);
            }
        }
    }

    /* Pick a viable town pair for a first bus route. Pathfinder.Road v4 +
     * AyStar v6 (2012) dead-locks on long searches (>~60 tile manhattan in
     * real tests), so this prefers SHORT pairs. Uses all towns (not only the
     * biggest): nearest-pair stats on a 256x256 map show plenty of pairs in
     * the 15..60 band. Within [15, 60] tiles pick the pair with the largest
     * combined population; if none qualifies, widen to [15, 90].
     * Returns [townA, townB] or null. */
    function PickTownPair() {
        local all = [];
        local tl = GSTownList();
        foreach (tid, _ in tl) {
            local c = GSTown.GetLocation(tid);
            all.push([GSTown.GetPopulation(tid), tid, GSMap.GetTileX(c), GSMap.GetTileY(c)]);
        }
        local best = null;
        local bestScore = -1;
        // Segmented road building (executor S3+) lifts the old <=60-tile
        // AyStar deadlock cap, so long pairs are now allowed. Prefer
        // moderate (25..140) but accept up to 260 to let the planner reach
        // farther, more profitable towns.
        foreach (lim in [140, 260]) {
            for (local i = 0; i < all.len(); i++) {
                for (local j = i + 1; j < all.len(); j++) {
                    local ddx = all[i][2] - all[j][2]; if (ddx < 0) ddx = -ddx;
                    local ddy = all[i][3] - all[j][3]; if (ddy < 0) ddy = -ddy;
                    local d = ddx + ddy;
                    if (d < 15 || d > lim) continue;
                    local score = all[i][0] + all[j][0];
                    if (score > bestScore) {
                        bestScore = score;
                        best = [all[i][1], all[j][1]];
                    }
                }
            }
            if (best != null) return best;
        }
        return best;
    }

    /* Find [station_tile, front_tile] near `center`: a buildable, non-water
     * tile (future bus stop) plus an adjacent buildable, non-water tile
     * (future road / vehicle approach). Rings outward from the center so the
     * anchor lands near town housing. */
    function FindStationSite(center, maxR) {
        local cx = GSMap.GetTileX(center);
        local cy = GSMap.GetTileY(center);
        local dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (local r = 1; r <= maxR; r++) {
            for (local dx = -r; dx <= r; dx++) {
                for (local dy = -r; dy <= r; dy++) {
                    if (dx != -r && dx != r && dy != -r && dy != r) continue; // ring only
                    local x = cx + dx; local y = cy + dy;
                    if (x < 0 || y < 0) continue;
                    if (x >= GSMap.GetMapSizeX() || y >= GSMap.GetMapSizeY()) continue;
                    local tile = GSMap.GetTileIndex(x, y);
                    if (GSTile.IsWaterTile(tile)) continue;
                    if (!GSTile.IsBuildable(tile)) continue;
                    foreach (d in dirs) {
                        local fx = x + d[0]; local fy = y + d[1];
                        if (fx < 0 || fy < 0) continue;
                        if (fx >= GSMap.GetMapSizeX() || fy >= GSMap.GetMapSizeY()) continue;
                        local front = GSMap.GetTileIndex(fx, fy);
                        if (GSTile.IsWaterTile(front)) continue;
                        if (!GSTile.IsBuildable(front)) continue;
                        return [tile, front];
                    }
                }
            }
        }
        return null;
    }
}

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
    // Fingerprint of the last exec event we emitted. On-change emission
    // retires the heartbeat concept: "no event = no change". All semantics
    // mirror src/game/executor-status.ts decodeExecutorPhase (REFACTOR Phase A).
    _last_exec_key = "";

    /**
     * Parse an executor company-name phase string into a typed event payload.
     * Returns null when the string is not an `EX ...` phase (e.g. uninitialised).
     *
     * Scope: STAGE + JOB + HB only. Detail parsing stays on the harness side
     * (TS regex in executor-status.ts) — the GS Squirrel runtime in OpenTTD 15
     * has reliability quirks on table assignment that make populating nested
     * detail unreliable. The contract still requires raw so the harness can
     * rebuild detail deterministically (REFACTOR Phase A note).
     *
     * Mirrors src/game/executor-status.ts decodeExecutorPhase for stage mapping.
     */
    function Trim(s) {
        while (s != null && s.len() > 0 && (s[0] == " " || s[0] == "\t" || s[0] == "\n")) {
            s = s.slice(1);
        }
        while (s != null && s.len() > 0 && (s[s.len()-1] == " " || s[s.len()-1] == "\t" || s[s.len()-1] == "\n")) {
            s = s.slice(0, s.len() - 1);
        }
        return s;
    }

    function ParseExecPhase(name) {
        local s = "" + name;
        if (s.len() > 3 && s.slice(0, 3) == "EX ") s = s.slice(3);
        if (s.len() < 3 || s.slice(0, 6) == "(null ") return null;

        local stage = "unknown";
        local hb = false;
        local job = -1;

        local jPos = s.find(" j");
        if (jPos != null) {
            try { job = s.slice(jPos + 2).tointeger(); } catch (e) {}
            s = Trim(s.slice(0, jPos));
        }

        if (s == "boot") stage = "boot";
        else if (s == "work") stage = "work";
        else if (s == "done") stage = "done";
        else if (s.slice(0, 2) == "st") stage = "station";
        else if (s.slice(0, 4) == "road") stage = "road";
        else if (s.slice(0, 3) == "dpt" || s.slice(0, 5) == "depot") stage = "depot";
        else if (s.slice(0, 3) == "bus") stage = "fleet";
        else if (s.slice(0, 3) == "exc") stage = "error";
        else if (s.slice(0, 3) == "hb ") { hb = true; stage = "heartbeat"; }
        else if (s.slice(0, 2) == "rd") stage = "road";
        else if (s.len() > 0 && s[0] == "@") stage = "vehicle";
        else if (s.len() > 1) {
            local cls = s[0];
            if (cls == "R" || cls == "S" || cls == "D" || cls == "B" || cls == "X" || cls == "?") {
                stage = "vehicle";
            }
        }

        return { stage = stage, job = job, hb = hb };
    }

/** Fingerprint = stage+job+hb+detail keys; values change => new event.
     *  We include only KEYS (not values) in the key, then compare the
     *  whole event by re-emitting only when stage/job/hb differ — details
     *  like `seq` and `signs` change every tick, so we don't want to spam
     *  the harness. On-change emission already happens at the consumer
     *  side (stage gate), so we only NEED to gate on stage/job/hb.
     */
    function ExecEventKey(ev) {
        if (ev == null) return "";
        return ev.stage + "|" + ev.job + "|" + (ev.hb ? "1" : "0");
    }

    function Start() {
        while (true) {
            this.HandleEvents();
            if (GSController.GetTick() > this._last_send + 200) {
                this._last_send = GSController.GetTick();
                // Phase-1 spike. It fires HERE, not at boot, because a
                // GSAdmin.Send with no subscribed admin is silently dropped
                // (measured 2026-09-12: the boot-time probe produced nothing,
                // while this same periodic send reaches the agent every time).
                // The delay is the point: it proves the channel is live first.
                // DISARMED for verification (probe is interfering with the
                // executor's route; verify the fix first, run the probe separately).
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
                // -- Executor phase event (A2) -------------------------------------
                // Reads the executor AI company name; emits a typed event on change.
                // Heartbeat = "no event". The harness A3 will drop its regex decode.
                try {
                    local execName = "" + GSCompany.GetName(0);
                    local ev = this.ParseExecPhase(execName);
                    if (ev != null) {
                        local key = this.ExecEventKey(ev);
                        if (key != this._last_exec_key) {
                            this._last_exec_key = key;
                            GSAdmin.Send({
                                kind = "exec",
                                stage = ev.stage,
                                job = ev.job,
                                hb = ev.hb,
                                raw = execName,
                            });
                        }
                    }
                } catch (e) {
                    // Emitter failure must not break the GS tick loop; surface it.
                    GSAdmin.Send({ kind = "err", cmd = "exec_emit",
                                   reason = e.tostring() });
                }
                // Publish the candidate towns, not just how many there are.
                //
                // SPEC §10.32: the M3 experiment was saturated because the agent
                // could not see the options it was choosing between, so every run
                // ended up doing exactly the same thing. A count is not a choice;
                // population and position are. Sorted by population so the order is
                // stable and meaningful; the ORDER states a fact about the world,
                // it does not recommend one town over another.
                // Use the GSList API rather than a hand-rolled comparator:
                // Squirrel has no `<=>` operator, and using one silently stopped
                // the whole GS from loading ("BridgeV1 GS never heartbeated").
                local tlist = GSTownList();
                tlist.Valuate(GSTown.GetPopulation);
                tlist.Sort(GSList.SORT_BY_VALUE, false);   // largest population first
                local towns = [];
                foreach (tid, pop in tlist) {
                    if (towns.len() >= 10) break;
                    local loc = GSTown.GetLocation(tid);
                    towns.push({ id = tid, pop = pop,
                                 x = GSMap.GetTileX(loc), y = GSMap.GetTileY(loc) });
                }
                GSAdmin.Send({
                    cmd = "state", tick = GSController.GetTick(),
                    date = GSDate.GetCurrentDate(),
                    towns = tlist.Count(),
                    town_list = towns,
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
    /* PHASE-1b FEASIBILITY SPIKE - the full "make one working bus" sequence.

     * Phase 1 proved the GS can BUILD as the company (GSRoad.BuildRoad returned
     * true and 307 was charged to company 0). What it did NOT prove is the rest
     * of the chain: depot, engine choice, buying, orders, starting. If any of
     * those cannot be done by a GS, the GS-only plan collapses - and I would
     * rather find that out here, in a 60-line probe, than after porting 880
     * lines of executor into the GS.
     *
     * Every step records its own outcome, and each risky call is guarded, so a
     * throw reports WHERE it happened instead of losing the steps already done.
     *
     * It mirrors executor-ai PhaseBus/PickBusEngine deliberately: that code is
     * the known-good reference for this exact sequence, so any difference is my
     * mistake rather than an API difference.
     *
     * Note it does spend the company's money (a depot and a bus). It is NOT
     * auto-run - see the note in the periodic tick. */
    function ProbeCompanyMode() {
        local exec = 0;
        local out = {
            kind = "probe", cmd = "probe_cm", company = exec, stage = "init",
            cm_valid = false, road = "unset", depot = "unset", engine = "unset",
            vehicle = "unset", orders = "unset", started = "unset",
            money_before = -1, money_after = -1, note = ""
        };
        try {
            if (GSCompany.ResolveCompanyID(exec) == GSCompany.COMPANY_INVALID) {
                out.note = "company invalid";
                GSAdmin.Send(out);
                return;
            }
            out.money_before = GSCompany.GetBankBalance(exec);
            local mode = GSCompanyMode(exec);
            out.cm_valid = GSCompanyMode.IsValid();
            // A road type must be selected before any road command. The executor
            // does this too (AIRoad.SetCurrentRoadType); omitting it was my first
            // bug in this probe.
            GSRoad.SetCurrentRoadType(GSRoad.ROADTYPE_ROAD);

            local tl = GSTownList();
            if (tl.Count() == 0) {
                out.note = "no towns";
                GSAdmin.Send(out);
                return;
            }
            local c = GSTown.GetLocation(tl.Begin());

            // (1) road - already proven, kept so the sequence is self-contained
            out.stage = "road";
            local pair = this.FindAdjacentLandPair(c, 16);
            if (pair == null) {
                out.road = "no-site";
            } else {
                local built = GSRoad.BuildRoad(pair[0], pair[1]);
                if (built) { out.road = "ok"; } else {
                    local rc = -1; try { rc = GSError.GetLastError(); } catch (e1) { rc = -2; }
                    out.road = "fail:" + rc;
                }
            }

            // (2) depot - BuildRoadDepot(tile, front), needs the front to be road
            out.stage = "depot";
            local dp = this.FindAdjacentLandPair(c, 20);
            local depotTile = -1;
            if (dp != null) {
                // Make sure the front tile is road so the depot has a connection.
                GSRoad.BuildRoad(dp[0], dp[1]);
                if (GSRoad.BuildRoadDepot(dp[0], dp[1])) {
                    depotTile = dp[0];
                    out.depot = "ok";
                } else {
                    local dc = -1; try { dc = GSError.GetLastError(); } catch (e2) { dc = -2; }
                    out.depot = "fail:" + dc;
                }
            } else {
                out.depot = "no-site";
            }

            // (3) engine - GSEngineList takes a VEHICLE TYPE. Calling it with no
            // argument is what produced "wrong number of parameters".
            out.stage = "engine";
            local engine = -1;
            try {
                local el = GSEngineList(GSVehicle.VT_ROAD);
                el.Valuate(GSEngine.IsBuildable);
                el.KeepValue(1);
                el.Valuate(GSEngine.GetRoadType);
                el.KeepValue(GSRoad.ROADTYPE_ROAD);
                el.Valuate(GSEngine.GetMaxSpeed);
                el.Sort(GSList.SORT_BY_VALUE, false);
                if (!el.IsEmpty()) engine = el.Begin();
                out.engine = (engine < 0) ? "none" : ("id" + engine);
            } catch (e3) {
                out.engine = "EXC:" + ("" + e3);
            }

            // (4) buy it
            out.stage = "buy";
            local veh = -1;
            if (depotTile >= 0 && engine >= 0) {
                veh = GSVehicle.BuildVehicle(depotTile, engine);
                if (GSVehicle.IsValidVehicle(veh)) {
                    out.vehicle = "ok:" + veh;
                } else {
                    local vc = -1; try { vc = GSError.GetLastError(); } catch (e4) { vc = -2; }
                    out.vehicle = "fail:" + vc;
                    veh = -1;
                }
            } else {
                out.vehicle = "skipped";
            }

            // (5) orders - the vehicle must have somewhere to go
            out.stage = "order";
            if (veh >= 0) {
                local a = GSOrder.AppendOrder(veh, depotTile, GSOrder.OF_NON_STOP_INTERMEDIATE);
                local b = GSOrder.AppendOrder(veh, pair != null ? pair[0] : depotTile,
                                              GSOrder.OF_NON_STOP_INTERMEDIATE);
                out.orders = (a && b) ? "ok" : "fail";
            } else {
                out.orders = "skipped";
            }

            // (6) start it - an unstarted vehicle is a very expensive decoration
            out.stage = "start";
            if (veh >= 0) {
                out.started = GSVehicle.StartStopVehicle(veh) ? "ok" : "fail";
            } else {
                out.started = "skipped";
            }

            out.stage = "done";
            out.money_after = GSCompany.GetBankBalance(exec);
        } catch (e) {
            out.note = "EXC " + ("" + e);
        }
        GSAdmin.Send(out);
    }

    /* Two adjacent land tiles near `center` - a legal site for one road tile. */
    function FindAdjacentLandPair(center, radius) {
        local cx = GSMap.GetTileX(center);
        local cy = GSMap.GetTileY(center);
        for (local dx = -radius; dx <= radius; dx++) {
            for (local dy = -radius; dy <= radius; dy++) {
                local x = cx + dx;
                local y = cy + dy;
                if (x < 2 || y < 2) continue;
                if (x >= GSMap.GetMapSizeX() - 2 || y >= GSMap.GetMapSizeY() - 2) continue;
                local a = GSMap.GetTileIndex(x, y);
                local b = GSMap.GetTileIndex(x + 1, y);
                if (GSTile.IsBuildable(a) && GSTile.IsBuildable(b)) return [a, b];
            }
        }
        return null;
    }

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
        } else if (cmd == "add_vehicles") {
            this.AddVehicles(obj);
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

    /* AddVehicles: ask the Executor to scale the active route's fleet to
     * `count` vehicles. Placed as a `NUTZ:bp:<job>:V:<count>` sign in the
     * executor's company mode (same mailbox as S/E/D). job defaults to the
     * most recent route job this GS issued. */
    function AddVehicles(obj) {
        if (!obj.rawin("company")) {
            GSAdmin.Send({ kind = "err", cmd = "add_vehicles", reason = "no company" });
            return;
        }
        local exec = obj["company"];
        local count = obj.rawin("count") ? obj["count"] : 1;
        if (count < 1) count = 1;
        if (count > 20) count = 20;
        local job = obj.rawin("job") ? obj["job"] : (100 + this._route_seq - 1);
        local job_str = "" + job;
        local mode = GSCompanyMode(exec);
        // Clear any previous V sign for this job, then place the new one.
        local sl = GSSignList();
        foreach (s, _ in sl) {
            local n = GSSign.GetName(s);
            if (n != null && n.len() > (7 + job_str.len()) &&
                n.slice(0, 8) == "NUTZ:bp:" + job_str + ":V:") {
                GSSign.RemoveSign(s);
            }
        }
        // Anchor the sign on any free tile near company 0's first station area.
        local anchor = this.FindFreeTileNear(GSTown.GetLocation(GSTownList().Begin()), 10);
        local sign_placed = 0;
        if (GSSign.BuildSign(anchor, "NUTZ:bp:" + job_str + ":V:" + count)) sign_placed = 1;
        // `signPlaced` is named explicitly on purpose. It used to be `placed`, which
        // reads as "placed N vehicles" and was mistaken for exactly that in a live
        // run's logs (the agent kept asking for vehicles while the fleet stayed at
        // zero). This ack only reports that the REQUEST was delivered to the
        // executor's mailbox; whether the fleet changes is decided later, by the
        // executor, and is observable only via company stats.
        GSAdmin.Send({ kind = "ack", cmd = "add_vehicles", job = job,
                       count = count, company = exec, signPlaced = sign_placed,
                       note = "request delivered; the executor applies fleet changes, "
                            + "and only once the route has a lead vehicle" });
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

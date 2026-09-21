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
    // N2-1: routes this GS laid out (job -> tiles), so route economics can be
    // attributed exactly. Attribution is by station orders (GSVehicleList_Station
    // + GetOwner), NOT by guessing from positions.
    _routes = null;
    _last_stats = 0;
    // AB-4a 探针状态（NEXT-4：GS 能否自己建完并**运营**一条线路）。
    // null = 未启动；表 = 进行中。生命周期是有意的一等状态：
    // plan → stationA → stationB → road → depot → engine → buy → orders → run。
    _pr = null;

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
        else if (s.slice(0, 4) == "done") stage = "done"; // real: "EX done stN4 r81 bus j101"
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

    /**
     * Poll the executor company name and emit a typed event on change.
     * Called EVERY loop iteration (~20 ticks, ~0.6 s) so phase changes reach
     * the harness without the 200-tick summary latency. Heartbeat = "no event".
     */
    function EmitExecPhase() {
        // -- Executor phase event (A2/A3) -------------------------------------
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
            GSAdmin.Send({
                kind = "err", cmd = "exec_emit",
                reason = e.tostring(),
            });
        }
    }

    /**
     * Resolve the station a route's endpoint actually got (N2-1).
     *
     * The executor builds the station ON the blueprint sign tile in the normal
     * path, but it has a FindAltSite fallback that shifts the site by a few
     * tiles when the sign tile cannot be built on. Reading only the exact tile
     * would then report "no vehicles" for a route that is running fine -
     * silently, and in the direction of "nothing works". So: exact tile first,
     * then a small radius scan, and -1 when there is genuinely nothing.
     */
    function StationNear(tile, radius) {
        local sid = GSStation.GetStationID(tile);
        if (GSStation.IsValidStation(sid)) return sid;
        local cx = GSMap.GetTileX(tile);
        local cy = GSMap.GetTileY(tile);
        for (local dx = -radius; dx <= radius; dx++) {
            for (local dy = -radius; dy <= radius; dy++) {
                local x = cx + dx;
                local y = cy + dy;
                if (x < 0 || y < 0) continue;
                if (x >= GSMap.GetMapSizeX() || y >= GSMap.GetMapSizeY()) continue;
                local cand = GSMap.GetTileIndex(x, y);
                // `GSStation.IsStationTile` does NOT exist in the GS API (the
                // predicate lives on GSTile), and calling it made the whole
                // route-stats reply fail with "the index 'IsStationTile' does not
                // exist" - but only when the executor had shifted the site, i.e.
                // exactly in the runs where the route was already in trouble
                // (SPEC §10.66: every one of 17 runs hit this; one run lost 92%
                // of its route-economics replies). Same check as above the loop,
                // which is the pair actually verified against OpenTTD.
                local cs = GSStation.GetStationID(cand);
                if (GSStation.IsValidStation(cs)) return cs;
            }
        }
        return -1;
    }

    /* 乘客 cargo id（线路经济的等待量按乘客算），与 executor 的判定同源。 */
    function PaxCargoId() {
        local cl = GSCargoList();
        foreach (c, _ in cl) {
            if (GSCargo.HasCargoClass(c, GSCargo.CC_PASSENGERS)) return c;
        }
        return -1;
    }

    /**
     * Emit one flat `route-stats` event per known route (N2-1).
     *
     * Raw readings only: vehicles on the route, year-to-date profit, passengers
     * waiting. The harness derives per-day rates (route-stats.ts) - Squirrel
     * keeps the arithmetic out (SPEC §10.45 quirks).
     *
     * Deliberate: a route whose stations do not exist yet is still reported
     * (zero vehicles, zero waiting). "Planned but not built" is a fact the
     * agent should see, and silence would read as "no such route".
     */
    function EmitRouteStats() {
        if (this._routes == null) return;
        try {
            local exec = 0;
            local pax = this.PaxCargoId();
            foreach (job_str, rec in this._routes) {
                local tA = rec.rawget("tA");
                local tB = rec.rawget("tB");
                local sa = this.StationNear(tA, 6);
                local sb = this.StationNear(tB, 6);
                local vlist = [];
                if (GSStation.IsValidStation(sa)) {
                    foreach (v, _ in GSVehicleList_Station(sa)) {
                        if (GSVehicle.GetOwner(v) == exec) vlist.append(v);
                    }
                }
                if (GSStation.IsValidStation(sb)) {
                    foreach (v, _ in GSVehicleList_Station(sb)) {
                        if (GSVehicle.GetOwner(v) == exec) vlist.append(v);
                    }
                }
                local profit = 0;
                foreach (v in vlist) {
                    // GetProfitThisYear returns -1 for a NON-primary vehicle
                    // (wagons). Routes here are single road vehicles, always
                    // primary, so a genuine -1 pound loss is not confused with
                    // the sentinel.
                    profit += GSVehicle.GetProfitThisYear(v);
                }
                local waiting = 0;
                if (pax >= 0) {
                    if (GSStation.IsValidStation(sa)) waiting += GSStation.GetCargoWaiting(sa, pax);
                    if (GSStation.IsValidStation(sb)) waiting += GSStation.GetCargoWaiting(sb, pax);
                }
                GSAdmin.Send({
                    kind = "route-stats",
                    job = job_str.tointeger(),
                    vehicles = vlist.len(),
                    profit = profit,
                    waiting = waiting,
                    gameDate = GSDate.GetCurrentDate(),
                });
            }
        } catch (e) {
            GSAdmin.Send({ kind = "err", cmd = "route_stats", detail = { reason = "" + e } });
        }
    }

    /* ===================================================================
     * AB-4a 探针：**GS 自己**建完并运营一条线路（NEXT-4 的决定性验收）。
     *
     * 为什么单独写而不是搬 executor：executor 的 880 行里大半是**寻路**
     * （SegmentProbe / FindSegment / 失败回退）。本探针要回答的是**能力问题**：
     *   ① GS 能不能跨 tick 自己建完一条线路（含站点/车库/车/订单/启动）；
     *   ② 车真的会跑起来并**运走货**吗（交付量 > 0）。
     * 所以它只做**直线铺路**：线路短就够用。若因地形失败，就如实汇报
     * **引擎错误码 + 出错坐标**，而不是假装成功（D37/D40：动作执行了但报告被吞是同一族 bug）。
     *
     * 每 tick 只做一小段（在周期循环里被调用），因此它天然具备"生命周期"形态——
     * 这正是动作总线要求的一等公民（§ACTION-BUS I1）。
     * =================================================================== */
    function StartProbeRoute() {
        if (this._pr != null) {
            GSAdmin.Send({ kind = "probe_route", stage = "already-running" });
            return;
        }
        this._pr = {
            stage = "plan", mode = "?", note = "",
            a = -1, b = -1, fA = -1, fB = -1, depot = -1, engine = -1,
            cur = -1, road = 0, fails = 0, nextReport = 0, depotFront = -1,
            line = [], buses = [], lastTiles = [], settleStartTick = 0,
            settleStartTiles = [], err = "",
        };
        GSAdmin.Send({ kind = "probe_route", stage = "started", tick = GSController.GetTick() });
    }

    /* 一行一报：阶段变化与失败都必须**被说出来**（报告被吞 = 无从诊断）。 */
    function PrReport() {
        local pr = this._pr;
        local m = {
            kind = "probe_route", stage = pr.stage, mode = pr.mode,
            road = pr.road, fails = pr.fails, buses = pr.buses.len(),
            money = GSCompany.GetBankBalance(0), tick = GSController.GetTick(),
        };
        // 需求与运动的**子事实**（否则"交付 0"无法与"没需求"区分开）：
        //   候客量 = 站点是否真的覆盖了住户；veh/vehstate = 车是否在动。
        local pax = this.PaxCargoId();
        if (pax >= 0 && pr.a >= 0) {
            local sa = GSStation.GetStationID(pr.a);
            local sb = GSStation.GetStationID(pr.b);
            local w = 0;
            if (GSStation.IsValidStation(sa)) w += GSStation.GetCargoWaiting(sa, pax);
            if (GSStation.IsValidStation(sb)) w += GSStation.GetCargoWaiting(sb, pax);
            m.waiting <- w;
        }
        if (pr.buses.len() > 0) {
            local v0 = pr.buses[0];
            if (GSVehicle.IsValidVehicle(v0)) {
                m.vehState <- GSVehicle.GetState(v0);
                m.vehTile <- GSVehicle.GetLocation(v0);
                m.profit <- GSVehicle.GetProfitThisYear(v0);
                // 订单自省：订单**存在**不等于订单**是"去某站"**。
                local oc = -1; local isStation = false; local dest = -1;
                try {
                    oc = GSOrder.GetOrderCount(v0);
                    if (oc > 0) {
                        isStation = GSOrder.IsGotoStationOrder(v0, 0);
                        local o = GSOrder.GetOrderDestination(v0, 0);
                        local od = GSOrder.GetOrderFlags(v0, 0);
                        if (o != null) dest = o;
                        if (od != null) m.ord0Flags <- od;
                    }
                } catch (e) { oc = -2; }
                m.orderCount <- oc;
                m.ord0Station <- isStation;
                m.ord0Dest <- dest;
            }
            // 移动检测：与上一次报告比位置是否变化（"车没动"必须可测，不能靠感觉）
            local tiles = [];
            foreach (v in pr.buses) {
                if (GSVehicle.IsValidVehicle(v)) tiles.push(GSVehicle.GetLocation(v));
            }
            if (pr.lastTiles.len() == tiles.len() && tiles.len() > 0) {
                local same = true;
                for (local i = 0; i < tiles.len(); i++) if (tiles[i] != pr.lastTiles[i]) same = false;
                m.stillForOneReport <- same;
            }
            pr.lastTiles = tiles;
        }
        // 车库与路的连接（"车出不来"最常见的物理原因，必须可测）
        if (pr.depot >= 0 && pr.depotFront >= 0) {
            local conn = false;
            try { conn = GSRoad.AreRoadTilesConnected(pr.depot, pr.depotFront); } catch (e) { conn = false; }
            m.depotConn <- conn;
        }
        if (pr.note != "") m.note <- pr.note;
        if (pr.err != "") m.err <- pr.err;
        if (pr.a >= 0) m.stationA <- pr.a;
        if (pr.b >= 0) m.stationB <- pr.b;
        if (pr.depot >= 0) m.depot <- pr.depot;
        if (pr.engine >= 0) m.engine <- pr.engine;
        GSAdmin.Send(m);
    }

    function PrFail(why) {
        this._pr.stage = "failed";
        this._pr.err = why;
        this.PrReport();
    }

    function ProcessProbeRoute() {
        if (this._pr == null) return;
        local pr = this._pr;
        if (pr.stage == "failed" || pr.stage == "run") {
            if (pr.stage == "run" && GSController.GetTick() > pr.nextReport) {
                pr.nextReport = GSController.GetTick() + 200;
                this.PrReport();
            }
            return;
        }
        if (pr.stage == "settle") {
            // **观测到移动才进入 run**（每 tick 异步建设 → 车出来需要时间）。
            // 但也设个硬上限，免得在不可行的场景里永远卡住。
            local moved = false;
            for (local i = 0; i < pr.buses.len(); i++) {
                local v = pr.buses[i];
                if (!GSVehicle.IsValidVehicle(v)) continue;
                local t0 = (i < pr.settleStartTiles.len()) ? pr.settleStartTiles[i] : -1;
                local t1 = GSVehicle.GetLocation(v);
                if (t0 >= 0 && t1 != t0) { moved = true; break; }
                // 即使起点是 -1（车还没拿到），现在的位置若离开 depot 也算动
                if (t0 < 0 && t1 >= 0 && t1 != pr.depot) { moved = true; break; }
            }
            local elapsed = GSController.GetTick() - pr.settleStartTick;
            if (moved) {
                pr.note = "settled after " + elapsed + " ticks";
                pr.stage = "run";
                pr.nextReport = GSController.GetTick() + 200;
                this.PrReport();
                return;
            }
            if (elapsed > 2000) {
                // 2000 tick (~27 游戏日) 还不动——具名失败，不假装"在跑"。
                this.PrFail("settle: no bus moved after " + elapsed + " ticks (vehTile stayed at depot)");
                return;
            }
            // 在路上：心报 + 不退出（继续等下一 tick）。
            this.PrReport();
            return;
        }
        try {
        local mode = GSCompanyMode(0);
        if (!GSCompanyMode.IsValid()) { this.PrFail("company mode invalid"); return; }
        GSRoad.SetCurrentRoadType(GSRoad.ROADTYPE_ROAD);

        if (pr.stage == "plan") {
            // 站点选择：优先**最近**的另一座城（线路越短，直线铺路越可能成功）。
            // 找不到 60 格内的城就在**同一座城**里放两个站——乘客仍会在两点间流动，
            // 因此"交付量 > 0"这个能力问题依然被回答（模式如实记在 mode 里）。
            local tlist = GSTownList();
            if (tlist.Count() < 1) { this.PrFail("no towns"); return; }
            tlist.Valuate(GSTown.GetPopulation);
            tlist.Sort(GSList.SORT_BY_VALUE, false);
            local ids = [];
            foreach (tid, _pop in tlist) { ids.push(tid); if (ids.len() >= 10) break; }
            local la = GSTown.GetLocation(ids[0]);
            local best = -1; local bestD = 100000;
            for (local i = 1; i < ids.len(); i++) {
                local l = GSTown.GetLocation(ids[i]);
                local d = this.Manhattan(l, la);
                if (d < bestD) { bestD = d; best = i; }
            }
            local siteA = this.FindPaxStationSite(la, 12, -1, 0);
            local siteB = null;
            // 只接受**很短**的两城线路：本探针回答的是**能力**（GS 能否自己建完并运营），
            // 不是**寻路**。真机实测：47 格直线第一个瓦片就撞上地形（err 260）。
            // 长线路寻路（executor 的 880 行）仍然是独立的、未解决的工程问题，
            // 把它混进来会让"能力"这个问题永远得不出答案。
            if (best >= 0 && bestD <= 25) {
                siteB = this.FindPaxStationSite(GSTown.GetLocation(ids[best]), 12, siteA[0], 6);
                if (siteB != null) pr.mode = "two-towns d" + bestD;
            }
            if (siteB == null) {
                local cx = GSMap.GetTileX(la); local cy = GSMap.GetTileY(la);
                local ox = cx + 12;
                if (ox > GSMap.GetMapSizeX() - 3) ox = cx - 12;
                if (ox < 3) ox = cx + 6;
                siteB = this.FindPaxStationSite(GSMap.GetTileIndex(ox, cy), 10, siteA[0], 6);
                if (siteB != null) pr.mode = "same-town";
            }
            if (siteA == null || siteB == null) { this.PrFail("no station site"); return; }
            pr.a = siteA[0]; pr.fA = siteA[1];
            pr.b = siteB[0]; pr.fB = siteB[1];
            pr.note = "dist " + this.Manhattan(pr.fA, pr.fB);
            pr.stage = "stationA";
            this.PrReport();
            return;
        }

        if (pr.stage == "stationA") {
            if (!GSRoad.BuildRoadStation(pr.a, pr.fA, GSRoad.ROADVEHTYPE_BUS, GSStation.STATION_NEW)) {
                this.PrFail("stationA err=" + this.LastErr() + " [" + this.LastErrStr() + "]");
                return;
            }
            pr.stage = "stationB"; this.PrReport(); return;
        }

        if (pr.stage == "stationB") {
            if (!GSRoad.BuildRoadStation(pr.b, pr.fB, GSRoad.ROADVEHTYPE_BUS, GSStation.STATION_NEW)) {
                this.PrFail("stationB err=" + this.LastErr() + " [" + this.LastErrStr() + "]");
                return;
            }
            pr.stage = "road"; this.PrReport(); return;
        }

        if (pr.stage == "road") {
            if (pr.cur < 0) pr.cur = pr.fA;
            local tx = GSMap.GetTileX(pr.fB); local ty = GSMap.GetTileY(pr.fB);
            local steps = 0;
            while (steps < 8 && pr.cur != pr.fB) {
                local cx = GSMap.GetTileX(pr.cur); local cy = GSMap.GetTileY(pr.cur);
                local nx = cx; local ny = cy;
                if (cx != tx) { nx = (tx > cx) ? cx + 1 : cx - 1; }
                else if (cy != ty) { ny = (ty > cy) ? cy + 1 : cy - 1; }
                else break;
                // Candidates: the preferred step first, then a **bounded sidestep**.
                // 真机实测 47 格直线第一个瓦片就撞地形（err 260），所以"直线或死"
                // 不足以回答能力问题；但也不能变成无边界的绕行（那会掩盖"这里过不去"）。
                // 因此：最多尝试 3 个候选、每个最多重试 1 次（清掉目标格再试），
                // 全部失败就**具名失败**（失败次数与坐标都进报告）。
                local cands = [[nx, ny], [cx, cy + 1], [cx, cy - 1]];
                local placed = false;
                local tried = 0;
                foreach (c in cands) {
                    tried++;
                    local gx = c[0]; local gy = c[1];
                    if (gx < 2 || gy < 2) continue;
                    if (gx > GSMap.GetMapSizeX() - 3 || gy > GSMap.GetMapSizeY() - 3) continue;
                    local next = GSMap.GetTileIndex(gx, gy);
                    if (GSRoad.BuildRoad(pr.cur, next)) {
                        pr.line.push(pr.cur);
                        pr.cur = next;
                        pr.road++;
                        placed = true;
                        break;
                    }
                    // One retry after clearing the target: foliage is the common
                    // cause, and DemolishTile is what the executor does too.
                    GSTile.DemolishTile(next);
                    if (GSRoad.BuildRoad(pr.cur, next)) {
                        pr.line.push(pr.cur);
                        pr.cur = next;
                        pr.road++;
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    pr.fails++;
                    this.PrFail("road " + cx + "," + cy + " tried " + tried + " err=" + this.LastErr() + " [" + this.LastErrStr() + "]");
                    return;
                }
                steps++;
            }
            if (pr.cur == pr.fB) pr.stage = "depot";
            this.PrReport(); return;
        }

        if (pr.stage == "depot") {
            local dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            local tried = 0;
            foreach (t in pr.line) {
                if (tried > 24) break;
                local x = GSMap.GetTileX(t); local y = GSMap.GetTileY(t);
                foreach (d in dirs) {
                    local nx = x + d[0]; local ny = y + d[1];
                    if (nx < 2 || ny < 2) continue;
                    if (nx > GSMap.GetMapSizeX() - 3 || ny > GSMap.GetMapSizeY() - 3) continue;
                    local cand = GSMap.GetTileIndex(nx, ny);
                    if (cand == pr.a || cand == pr.b) continue;
                    if (!GSTile.IsBuildable(cand)) continue;
                    if (GSRoad.BuildRoadDepot(cand, t)) {
                        pr.depot = cand;
                        pr.depotFront = t;
                        pr.stage = "engine";
                        this.PrReport();
                        return;
                    }
                }
                tried++;
            }
            this.PrFail("no depot site along " + pr.line.len() + " road tiles");
            return;
        }

        if (pr.stage == "engine") {
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
            } catch (e) { engine = -1; }
            if (engine < 0) { this.PrFail("no road engine"); return; }
            pr.engine = engine;
            pr.stage = "buy"; this.PrReport(); return;
        }

        if (pr.stage == "buy") {
            while (pr.buses.len() < 2) {
                local veh = GSVehicle.BuildVehicle(pr.depot, pr.engine);
                if (!GSVehicle.IsValidVehicle(veh)) {
                    this.PrFail("buy err=" + this.LastErr() + " [" + this.LastErrStr() + "] after " + pr.buses.len());
                    return;
                }
                pr.buses.push(veh);
            }
            pr.stage = "orders"; this.PrReport(); return;
        }

        if (pr.stage == "orders") {
            local started = 0;
            foreach (v in pr.buses) {
                local o1 = GSOrder.AppendOrder(v, pr.a, GSOrder.OF_NON_STOP_INTERMEDIATE);
                local o2 = GSOrder.AppendOrder(v, pr.b, GSOrder.OF_NON_STOP_INTERMEDIATE);
                local st = GSVehicle.StartStopVehicle(v);
                if (o1 && o2 && st) started++;
            }
            if (started == 0) { this.PrFail("no bus got orders+start"); return; }
            pr.note = "started " + started + "/" + pr.buses.len();
            // **不再立刻报 run**：OpenTTD 的路/车建设是每 tick 异步完成的，`BuildRoad`
            // 只是**安排**了瓦片建设，真正的"路"要等下一两个 tick 才存在。
            // 第一版直接报 run → 车永远停在 depot tile（这是被测出来的：D44 之后修了
            // 报告路径，**测量**发现 vehTile 在 60 游戏日内没有离开 depot）。
            //
            // 现在：先进入 settle，等"车真的动了"再算成功。这正是 ACTION-BUS I1
            // （观测或具名拒绝）在探针侧的具体实现——"启动成功"不等于"在跑"。
            pr.stage = "settle";
            pr.settleStartTick = GSController.GetTick();
            pr.settleStartTiles = [];
            foreach (v in pr.buses) {
                if (GSVehicle.IsValidVehicle(v)) pr.settleStartTiles.push(GSVehicle.GetLocation(v));
                else pr.settleStartTiles.push(-1);
            }
            this.PrReport();
            return;
        }
        } catch (e) {
            this.PrFail("uncaught " + ("" + e));
            return;
        }
    }

    /* 按**乘客生产量**选站址——executor 的 BestPaxCandidate 门槛，必须照抄。
     *
     * 为什么（AB-4a 真机第一次的失败）：原先用 FindStationSite（只找空地），
     * 站点可能完全不覆盖住户 → **候客量恒为 0**，车跑 60 游戏日交付 0。
     * 这不是"GS 做不到"，而是**选址没按需求**。空地与需求是两件事。 */
    function FindPaxStationSite(center, maxR, avoid, minSep) {
        local pax = this.PaxCargoId();
        if (pax < 0) return this.FindStationSite(center, maxR);
        local cx = GSMap.GetTileX(center); local cy = GSMap.GetTileY(center);
        local dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        local best = null; local bestProd = -1;
        for (local r = 0; r <= maxR; r++) {
            for (local dx = -r; dx <= r; dx++) {
                for (local dy = -r; dy <= r; dy++) {
                    if (dx != -r && dx != r && dy != -r && dy != r) continue; // ring only
                    local x = cx + dx; local y = cy + dy;
                    if (x < 3 || y < 3) continue;
                    if (x > GSMap.GetMapSizeX() - 4 || y > GSMap.GetMapSizeY() - 4) continue;
                    local tile = GSMap.GetTileIndex(x, y);
                    if (GSTile.IsWaterTile(tile)) continue;
                    // 车站/车库都要求**平地**；斜坡的瓦片对 IsBuildable 是
                    // true、对 BuildRoadStation/BuildRoadDepot 是 false——AB-4a 真机在
                    // 站点 B 上踩到过 `ERR_FLAT_LAND_REQUIRED`（err=263）。
                    //
                    // **GS API 不暴露 `GSMap.SLOPE_FLAT`**（已实测：`the index
                    // 'SLOPE_FLAT' does not exist`）。`SLOPE_FLAT = 0` 是引擎侧的稳定
                    // 常量（`src/slope_type.h`）；这里用字面量并标 KNOWN_BAD_CALLS。
                    if (GSTile.GetSlope(tile) != 0) continue;
                    if (!GSTile.IsBuildable(tile)) continue;
                    // 必须与已选的另一站**隔开**：两次扫描都会收敛到"全镇产量最高"的那一格，
                    // 第一版因此把两个站选到同一块瓦片上（真机 `dist 0` → stationB ERR_UNKNOWN）。
                    if (avoid >= 0 && this.Manhattan(tile, avoid) < minSep) continue;
                    local prod = GSTile.GetCargoProduction(tile, pax, 1, 1, 4);
                    if (prod <= bestProd) continue;
                    foreach (d in dirs) {
                        local fx = x + d[0]; local fy = y + d[1];
                        if (fx < 3 || fy < 3) continue;
                        if (fx > GSMap.GetMapSizeX() - 4 || fy > GSMap.GetMapSizeY() - 4) continue;
                        local front = GSMap.GetTileIndex(fx, fy);
                        if (GSTile.IsWaterTile(front)) continue;
                        if (GSTile.GetSlope(front) != 0) continue;
                        if (!GSTile.IsBuildable(front)) continue;
                        bestProd = prod;
                        best = [tile, front];
                        break;
                    }
                }
            }
        }
        if (best == null) {
            // pax 找不到任何候选时，尝试 FindStationSite（也要平地）
            return this.FindStationSiteFlat(center, maxR);
        }
        return best;
    }

    /* FindStationSite 的平地对口——原 FindStationSite 不挡坡，AB-4a 站点 B 因此报
     * `ERR_FLAT_LAND_REQUIRED`。 */
    function FindStationSiteFlat(center, maxR) {
        local cx = GSMap.GetTileX(center); local cy = GSMap.GetTileY(center);
        for (local r = 0; r <= maxR; r++) {
            for (local dx = -r; dx <= r; dx++) {
                for (local dy = -r; dy <= r; dy++) {
                    if (dx != -r && dx != r && dy != -r && dy != r) continue;
                    local x = cx + dx; local y = cy + dy;
                    if (x < 2 || y < 2) continue;
                    if (x >= GSMap.GetMapSizeX() || y >= GSMap.GetMapSizeY()) continue;
                    local t = GSMap.GetTileIndex(x, y);
                    if (GSTile.IsWaterTile(t)) continue;
                    if (GSTile.GetSlope(t) != 0) continue;
                    if (!GSTile.IsBuildable(t)) continue;
                    return t;
                }
            }
        }
        return center;
    }

    /* Manhattan distance from tile coordinates (no API guesswork: GSMap has X/Y). */
    function Manhattan(a, b) {
        return this.Abs(GSMap.GetTileX(a) - GSMap.GetTileX(b)) +
               this.Abs(GSMap.GetTileY(a) - GSMap.GetTileY(b));
    }

    function Abs(v) { return (v < 0) ? -v : v; }

    /* 引擎错误的**人话**（可能是空串）。数字码不是诊断：`err=260` 需要查源码才知道
     * 是什么，而 GetLastErrorString 直接给出引擎拒绝的理由。诊断能力本身是交付物。 */
    function LastErrStr() {
        local txt = "";
        try { txt = "" + GSError.GetLastErrorString(); } catch (e) { txt = ""; }
        return txt;
    }

    /* Engine error code, or a named sentinel when even that throws. */
    function LastErr() {
        local code = -1;
        try { code = GSError.GetLastError(); } catch (e) { code = -2; }
        return code;
    }

    function Start() {
        while (true) {
            this.HandleEvents();
            this.ProcessProbeRoute();
            this.EmitExecPhase();
            if (GSController.GetTick() > this._last_stats + 200) {
                this._last_stats = GSController.GetTick();
                this.EmitRouteStats();
            }
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
            vehicle = "unset", station = "unset", orders = "unset", started = "unset",
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

            // (2b) bus station - **an order needs a station to point at**.
            // The first version of this probe pointed its orders at the depot
            // tile while passing OF_NON_STOP_INTERMEDIATE, which the API's
            // precondition (AreOrderFlagsValid) rejects: that flag is only legal
            // for stations/waypoints ("orders = fail"). Building the station
            // also answers the real architectural question - can a GS alone
            // run the whole bus loop, making the Executor AI optional?
            out.stage = "station";
            local stationTile = -1;
            local sp = this.FindAdjacentLandPair(c, 24);
            if (sp == null) {
                out.station = "no-site";
            } else {
                GSRoad.SetCurrentRoadType(GSRoad.ROADTYPE_ROAD);
                local stOk = GSRoad.BuildRoadStation(sp[0], sp[1],
                                                     GSRoad.ROADVEHTYPE_BUS,
                                                     GSStation.STATION_NEW);
                if (stOk) {
                    stationTile = sp[0];
                    out.station = "ok";
                } else {
                    local sc = -1; try { sc = GSError.GetLastError(); } catch (e5) { sc = -2; }
                    out.station = "fail:" + sc;
                }
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
            // (5) orders - report each one separately: a combined boolean hid
            // WHICH order the engine refused (the same reporting-path lesson as
            // D37/D40: "action happened, report swallowed").
            out.stage = "order";
            if (veh >= 0) {
                local o1 = false; local o2 = false;
                if (stationTile >= 0) {
                    o1 = GSOrder.AppendOrder(veh, stationTile, GSOrder.OF_NON_STOP_INTERMEDIATE);
                }
                o2 = GSOrder.AppendOrder(veh, depotTile, 0);
                out.orders = "station=" + (o1 ? "ok" : "fail") + ",depot=" + (o2 ? "ok" : "fail");
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
        } else if (cmd == "probe_route_cm") {
            // AB-4a: build AND run a route with the GS alone (NEXT-4 acceptance).
            this.StartProbeRoute();
        } else if (cmd == "probe_cm") {
            // Company-mode capability probe (NEXT-4 fact: can a GS buy a vehicle?).
            // It was implemented but never dispatched - `unknown cmd` was the
            // answer for two runs. Sixth instance of "declared but not wired"
            // (MEMORY.md D41); the fix is one dispatch entry, the cost was two
            // machine runs. It spends company money (depot + bus), so it stays
            // opt-in: only reachable when a caller explicitly asks for it.
            this.ProbeCompanyMode();
        } else if (cmd == "build_bus_route") {
            this.BuildBusRoute(obj);
        } else if (cmd == "add_vehicles") {
            this.AddVehicles(obj);
        } else if (cmd == "retire_route") {
            this.RetireRoute(obj);
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
        // N2-1: remember where this job's endpoints are. The executor builds the
        // stations on these tiles, so later reads can turn tiles -> station ids
        // -> the vehicles on them (exact attribution, no heuristics).
        if (this._routes == null) this._routes = {};
        local rec = {};
        rec.rawset("tA", tA);
        rec.rawset("tB", tB);
        this._routes.rawset(job_str, rec);
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
    /* 退役一条线路（M3-2a）：放 `X:1` 标牌，执行器卖掉该线路全部车辆。
     * 与 add_vehicles 一样，ack 只说"请求已送达信箱"，不谎报结果。 */
    function RetireRoute(obj) {
        if (!obj.rawin("company")) {
            GSAdmin.Send({ kind = "err", cmd = "retire_route", reason = "no company" });
            return;
        }
        local exec = obj["company"];
        local job = obj.rawin("job") ? obj["job"] : (100 + this._route_seq - 1);
        local job_str = "" + job;
        local mode = GSCompanyMode(exec);
        local sl = GSSignList();
        foreach (s, _ in sl) {
            local n = GSSign.GetName(s);
            if (n != null && n.len() > (7 + job_str.len()) &&
                n.slice(0, 8) == "NUTZ:bp:" + job_str + ":X:") {
                GSSign.RemoveSign(s);
            }
        }
        local anchor = this.FindFreeTileNear(GSTown.GetLocation(GSTownList().Begin()), 10);
        local sign_placed = 0;
        if (GSSign.BuildSign(anchor, "NUTZ:bp:" + job_str + ":X:1")) sign_placed = 1;
        GSAdmin.Send({ kind = "ack", cmd = "retire_route", job = job, company = exec,
                       signPlaced = sign_placed,
                       note = "retirement requested; the executor sells the route's vehicles "
                            + "once they are parked in a depot" });
    }

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

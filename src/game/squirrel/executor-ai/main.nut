/**
 * ExecutorV1 — v0.2 agent executor (sign-mailbox consumer + builder).
 *
 * 职责: agent 公司的施工替身。轮询 GS 以公司模式放的 `NUTZ:bp:<job>:*` 标牌:
 *   1. 收到 job → 借贷融资 → phase=work (骨架, v0.2 已验)
 *   2. S2+: 读 S/E 标牌 (tile=AISign.GetLocation, front=fr= 值) →
 *      DemolishTile + AIRoad.BuildRoadStation (arena 真机验证模式) → phase=stX_ok
 *   macOS dedicated 丢 AILog → 全部经 SetPhase 公司名编码 (SPEC §10.10)。
 * 事实来源: SPEC §10.10/§10.12/§10.13 (标牌可见性/字符串语义); arena nutz_executor
 *   TryBuildStation (Demolish+build on clear land, front = future road tile)。
 * 部署: sandbox ai/ExecutorV1/。
 */

class ExecutorV1 extends AIController {
    _phase = "boot";
    _job = -1;
    _stage = "boot";   // boot -> buildA -> buildB -> road -> done
    _slotA = { label = "A", bp = null, tried = 0 };
    _slotB = { label = "B", bp = null, tried = 0 };
    _lastBeat = -1;
    _reportDone = false;
    _slotD = { label = "D", bp = null, tried = 0 };
    _vehicle = -1;
    _paxCargo = -1;
    _radius = -1;
    _fleetApplied = -1;  // last applied fleet size from a V sign
    _roadCur = -1;       // segmented-road: current front reached
    _roadSeg = 0;
    _roadSegStep = 0;
    _lastLaid = -1;      // tile reached by the most recent LayPath (contiguous)
    _layErr = "";        // why the last LayPath stopped early
    _dumpSeq = 0;
    _hbSeq = 0;
    // Pathfinder.Road class (library, imported once at load). Local sandbox
    // has v4 (needs graph.aystar v6); arena used v3 — API is compatible:
    //  pf = Road(); pf.cost.*; pf.InitializePath([from],[to]); pf.FindPath(n)
    //  -> node with GetTile()/GetParent(), or false (more iterations), null (none).
    _PF = import("pathfinder.road", "Road", 4);
    _builtRoad = null;   // list of [from,to] road pairs built

    function Start() {
        AILog.Info("ExecutorV1 starting");
        AICompany.SetPresidentName("Agent Bot");
        this.SetPhase("boot");
        while (true) {
            this.Tick();
            this.Sleep(5);
        }
    }

    /* One loop iteration of the build state machine. */
    function Tick() {
        try {
            this.TickInner();
            // Periodic alive-heartbeat INSIDE the try so a reporting bug
            // cannot kill the script (earlier: GetOrderIndex crash here
            // silently stopped all phase reporting while the engine kept
            // charging the bus maintenance).
            if (AIController.GetTick() - this._lastBeat > 300) {
                this._lastBeat = AIController.GetTick();
                this._hbSeq++;
                if (this._stage == "done" && this._vehicle >= 0) {
                    this.DumpBus();
                } else {
                    this.SetPhase("hb " + this._stage + " #" + this._hbSeq);
                }
            }
        } catch (e) {
            local es = "" + e;
            if (es.len() > 16) es = es.slice(0, 16);
            this.SetPhase("exc:" + es);
        }
    }

    function TickInner() {
        if (this._job < 0) {
            // No job yet: watch for a blueprint sign.
            this.LookForBlueprint();
            return;
        }
        if (this._stage == "buildA") {
            this.TryBuildStation(this._slotA);
        } else if (this._stage == "buildB") {
            this.TryBuildStation(this._slotB);
        } else if (this._stage == "road") {
            this.PhaseRoad();
        } else if (this._stage == "depot") {
            this.PhaseDepot();
        } else if (this._stage == "bus") {
            this.PhaseBus();
        } else if (this._stage == "done" && this._vehicle >= 0) {
            this.CheckAddVehicles();
        }
        if (this._stage == "done" && !this._reportDone) {
            this._reportDone = true;
            // Count our own road stations (ground-truth that we built stops).
            local stl = AIStationList(AIStation.STATION_BUS_STOP);
            local n = 0;
            foreach (sid, _ in stl) n++;
            local segs = this._builtRoad == null ? 0 : this._builtRoad.len();
            local v = (this._vehicle >= 0 && AIVehicle.IsValidVehicle(this._vehicle)) ? "bus" : "nobus";
            this.SetPhase("done stN" + n + " r" + segs + " " + v);
        }
        // stage "done": all S4 construction finished; loop idle.
    }

    /* Short error text for the phase channel. SetPhase truncates at 31 chars, so
     * keep only the first token of the engine's error string ("Flat land
     * required" -> "Flat"). The full string is useless if it gets cut mid-word. */
    function ShortErr() {
        local e = this._layErr;
        if (e == null || e == "") e = "" + AIError.GetLastErrorString();
        if (e == null || e == "" || e == "(null)") return "unknown";
        local sp = e.find(" ");
        if (sp != null && sp > 0) e = e.slice(0, sp);
        if (e.len() > 12) e = e.slice(0, 12);
        return e;
    }

    /* SetPhase: 公司名编码汇报; ≤31 字符 (OpenTTD 公司名上限). */
    function SetPhase(p) {
        local nm = "EX " + p + " j" + this._job;
        if (nm.len() > 31) nm = nm.slice(0, 31);
        AICompany.SetName(nm);
        this._phase = p;
    }

    /* 扫描 GS 放的 NUTZ:bp:<job>: 标牌 (arena 语法); 命中后借贷 + 进施工阶段. */
    function LookForBlueprint() {
        local sl = AISignList();
        foreach (sid, _ in sl) {
            local txt = AISign.GetName(sid);
            if (txt == null) continue;
            if (txt.len() < 5) continue;
            if (txt.slice(0, 5) != "NUTZ:") continue;
            local parts = this.Split(txt.slice(5), ":");
            if (parts.len() < 2) continue;
            if (parts[0] != "bp") continue;
            local job = this.ToInt(parts[1]);
            if (job < 0) continue;
            if (job == this._job) continue; // already working on it
            this._job = job;
            // Observable action: fund the company for the upcoming build.
            local maxLoan = AICompany.GetMaxLoanAmount();
            local cur = AICompany.GetLoanAmount();
            if (maxLoan > cur) AICompany.SetLoanAmount(maxLoan);
            this._stage = "buildA";
            this.SetPhase("work");
            AILog.Info("ExecutorV1 picked bp job " + job);
            break;
        }
    }

    /* Build one bus station from its blueprint sign.
     *  slot: state table {label, bp=null, tried=0} — mutated in place.
     *  "A" uses the S sign (site at sign location), "B" the E sign;
     *  front comes from `fr=<tile>` in the sign name. Uses the arena-verified
     *  pattern: clear both tiles then AIRoad.BuildRoadStation (a normal stop
     *  needs no prebuilt road; the connecting road lands on `front` in the S3
     *  road phase). If the exact sign site is blocked (town ownership,
     *  terrain, cost), scan a small ring for an alternative pair nearby. */
    /* Build one bus station near its blueprint sign. Two attempts:
     *  1. Pax scan: walk a 7x7 grid around the sign anchor, rank candidates
     *     by passenger PRODUCTION in the stop's catchment (AITile
     *     GetCargoProduction — arena's proven profitability gate), try to
     *     build in descending order. This is what makes the route earn.
     *  2. Plain fallback: any buildable pair near the anchor (route still
     *     builds, may not carry passengers).
     * Arena's TryBuildStation also enforced MIN_PROD and aborted the pair —
     * here we keep it soft (fall back) so the skeleton still completes. */
    function TryBuildStation(slot) {
        if (slot.bp == null) {
            local found = this.FindSign(slot.label);
            if (found == null) {
                this.SetPhase("st" + slot.label + "_wait");
                return;
            }
            slot.bp = found;
        }
        local anchor = slot.bp[0];  // sign tile = original station site
        local anchorF = slot.bp[1];
        // 1. Pax-ranked scan (try up to 12 candidates per tick slice).
        if (slot.tried < 24) {
            local cand = this.BestPaxCandidate(anchor, anchorF, slot.tried);
            if (cand != null) {
                slot.bp = cand;
                if (this.TryPlaceStop(cand[0], cand[1])) {
                    this.SetPhase("st" + slot.label + "_ok");
                    if (slot.label == "A") { this._stage = "buildB"; }
                    else { this._stage = "road"; }
                    return;
                }
            }
            slot.tried++;
            this.SetPhase("st" + slot.label + "_scan");
            return;
        }
        // 2. Plain fallback: any buildable pair (bounded).
        if (slot.tried > 24) {
            this.SetPhase("st" + slot.label + "_giveup");
            return;
        }
        local alt = this.FindAltSite(anchor, anchorF, 1 + (slot.tried % 6), 4);
        slot.tried++;
        if (alt != null) slot.bp = alt;
        else this.SetPhase("st" + slot.label + "_retry");
    }

    /* Next pax-ranked candidate for a station anchored at `anchor`. Returns
     * [tile, front] or null when the (bounded) candidate list is exhausted.
     * Ring order: step outward from the anchor; within each ring prefer the
     * neighbour that points toward the town centre is unnecessary — the
     * anchor already sits near the town — so we just take the best
     * production tile in each ring slice and let the caller advance. */
    function BestPaxCandidate(anchor, anchorF, step) {
        local pax = this.GetPaxCargoId();
        if (pax < 0) return null;
        local ax = AIMap.GetTileX(anchor);
        local ay = AIMap.GetTileY(anchor);
        // Keep the GS-chosen front DIRECTION (front - tile offset). The GS
        // picked a pair on flat terrain; translating both tiles together
        // stays on compatible terrain, so the later road connect won't hit
        // ERR_LAND_SLOPED (the bug that stranded the first bus).
        local fdx = 1; local fdy = 0; // default east
        if (anchorF >= 0 && AIMap.IsValidTile(anchorF)) {
            fdx = AIMap.GetTileX(anchorF) - ax;
            fdy = AIMap.GetTileY(anchorF) - ay;
            if (fdx < -1 || fdx > 1 || fdy < -1 || fdy > 1) { fdx = 1; fdy = 0; }
        }
        local r = this.StationRadius();
        local ring = step % 5;
        local best = null;
        local bestProd = -1;
        for (local dy = -ring; dy <= ring; dy++) {
            for (local dx = -ring; dx <= ring; dx++) {
                if (ring > 0 && (dx != -ring && dx != ring && dy != -ring && dy != ring)) continue;
                local x = ax + dx; local y = ay + dy;
                if (x < 0 || y < 0) continue;
                if (x >= AIMap.GetMapSizeX() || y >= AIMap.GetMapSizeY()) continue;
                local tile = AIMap.GetTileIndex(x, y);
                if (AITile.IsWaterTile(tile)) continue;
                if (!AITile.IsBuildable(tile)) continue;
                // front must also be valid/buildable (translated direction)
                local fx = x + fdx; local fy = y + fdy;
                if (fx < 0 || fy < 0) continue;
                if (fx >= AIMap.GetMapSizeX() || fy >= AIMap.GetMapSizeY()) continue;
                local front = AIMap.GetTileIndex(fx, fy);
                if (AITile.IsWaterTile(front)) continue;
                if (!AITile.IsBuildable(front)) continue;
                // production within the catchment this stop would cover
                local prod = AITile.GetCargoProduction(tile, pax, 1, 1, r);
                if (prod > bestProd) {
                    bestProd = prod;
                    best = tile;
                }
            }
        }
        if (best == null) return null;
        local bfx = AIMap.GetTileX(best) + fdx;
        local bfy = AIMap.GetTileY(best) + fdy;
        return [best, AIMap.GetTileIndex(bfx, bfy)];
    }

    /* Station coverage radius (cached); bus stops normally cover 4 (or 3
     * with modified_catchment). Ask the game. */
    function StationRadius() {
        if (this._radius > 0) return this._radius;
        this._radius = AIStation.GetCoverageRadius(AIStation.STATION_BUS_STOP);
        if (this._radius <= 0) this._radius = 3;
        return this._radius;
    }

    /* S3: build a road between station A's front and station B's front using
     * the Pathfinder.Road library (imported as _PF). Mirrors arena PhaseRoad:
     * cost tuning + FindPath(50) loop, walk path emitting BuildRoad both
     * directions per segment, then connect both stops to their fronts.
     * Runs once per tick slice; stage advances to "done" only when the road
     * and both stop connections are in place (or abort after bounded retries).
     * Report every road action via SetPhase so the runner sees progress. */
    /* S3: build a road from station A's front to station B's front in
     * GREEDY SEGMENTS. Pathfinder.Road v4 + AyStar v6 (2012) deadlocks on
     * long single searches (>~60 manhattan; probe: FindPath(1000) never
     * returns for a 111-tile gap while a 25-tile one returns instantly).
     * So each PhaseRoad tick searches only a SHORT segment (~18 tiles)
     * toward B with a small probe-goal, lays it, and advances _roadCur.
     * The probe auto-retreats on failure so we always make progress or
     * abort cleanly. Final segment (<~25 tiles) goes straight to fB. */
    function PhaseRoad() {
        // 1. Initialize per-route state once.
        if (this._roadCur < 0) {
            if (this._slotA.bp == null || this._slotB.bp == null) {
                this.SetPhase("road_nofront");
                this._stage = "done";
                return;
            }
            this._builtRoad = [];
            AIRoad.SetCurrentRoadType(AIRoad.ROADTYPE_ROAD);
            this._roadCur = this._slotA.bp[1]; // station A front
            this._roadSeg = 0;
            this.SetPhase("road_start");
        }
        local fB = this._slotB.bp[1];
        local dist = AIMap.DistanceManhattan(this._roadCur, fB);
        if (dist <= 0) {
            // Already at B (degenerate); just connect stops.
            this.FinishRoad();
            return;
        }
        // 2. Pick this segment's probe goal (retreating on failure). When the
        //    remaining distance is short, aim straight at fB so the final
        //    segment terminates ON the destination (never past it).
        local step = this._roadSegStep;
        local segLen = (dist <= 22) ? dist : 20;
        local direct = (dist <= 22);
        while (segLen >= 4) {
            local goal = direct ? fB : this.SegmentProbe(this._roadCur, fB, segLen);
            if (!direct && goal < 0) { segLen -= 4; continue; }
            local path = this.FindSegment(this._roadCur, goal);
            if (path == null) {
                // No route to this probe: shorten and retry (rate-limited).
                if (step >= 3) {
                    segLen -= 4;
                    if (direct && segLen < dist) { direct = false; segLen = 20; }
                    step = 0;
                } else {
                    this._roadSegStep = step + 1;
                    this.SetPhase("rd retry" + (step + 1));
                    return;
                }
                continue;
            }
            if (path == false) {
                this._roadSegStep = step + 1;
                if (step > 8) { segLen -= 4; step = 0; }
                this.SetPhase("rd s" + this._roadSeg + " r" + step);
                return; // more search iterations next tick
            }
            // 3. Lay this segment's path.
            local built = this.LayPath(path);
            if (built <= 0) {
                // Lay failure (terrain/funds): retry a shorter probe next
                // tick instead of aborting the whole route.
                if (step >= 6) {
                    // Report WHY: without the reason the agent (and the operator)
                    // cannot tell terrain from funds from obstruction, so it
                    // cannot learn anything from the failure (SPEC §10.20).
                    this.SetPhase("road_stuck:" + this.ShortErr());
                    this._stage = "done";
                    return;
                }
                this._roadSegStep = step + 1;
                this.SetPhase("rd layr" + (step + 1));
                return;
            }
            // Advance to the tile we actually reached, NOT to the path's goal.
            // If only part of the path was laid, claiming the goal would skip the
            // unbuilt middle. _lastLaid is always contiguous with _roadCur now
            // that LayPath builds away from us.
            this._roadCur = this._lastLaid >= 0 ? this._lastLaid : this._roadCur;
            this._roadSeg++;
            this._roadSegStep = 0;
            local nd = AIMap.DistanceManhattan(this._roadCur, fB);
            this.SetPhase("road seg" + this._roadSeg + " d" + nd);
            // 4. Route complete when the last segment ended on fB.
            if (this._roadCur == fB) {
                this.FinishRoad();
            }
            return;
        }
        // Probe could not advance even at short range -> give up cleanly.
        this.SetPhase("road_stuck:no path from segment " + this._roadSeg);
        this._stage = "done";
    }

    /* Pick a probe tile ~`len` tiles from `cur` in the direction of `goal`,
     * preferring buildable non-water land. Returns tile or -1. */
    function SegmentProbe(cur, goal, len) {
        local cx = AIMap.GetTileX(cur); local cy = AIMap.GetTileY(cur);
        local gx = AIMap.GetTileX(goal); local gy = AIMap.GetTileY(goal);
        local dx = 0; local dy = 0;
        if (gx > cx) dx = 1; else if (gx < cx) dx = -1;
        if (gy > cy) dy = 1; else if (gy < cy) dy = -1;
        // walk outward up to len along the primary axis, then relax on failure
        local tries = [ [dx,dy], [dx,0], [0,dy], [dx,-dy] ];
        for (local t = 0; t < 4; t++) {
            local px = cx + tries[t][0] * len;
            local py = cy + tries[t][1] * len;
            // keep in bounds
            if (px < 0) px = 0; if (py < 0) py = 0;
            if (px >= AIMap.GetMapSizeX()) px = AIMap.GetMapSizeX() - 1;
            if (py >= AIMap.GetMapSizeY()) py = AIMap.GetMapSizeY() - 1;
            local tile = AIMap.GetTileIndex(px, py);
            if (AITile.IsWaterTile(tile)) continue;
            if (AIRoad.IsRoadTile(tile)) return tile; // existing road is fine
            if (!AITile.IsBuildable(tile)) continue;
            // also check we're actually closer than current
            if (AIMap.DistanceManhattan(tile, goal) >=
                AIMap.DistanceManhattan(cur, goal)) continue;
            return tile;
        }
        return -1;
    }

    /* Run Pathfinder.Road from `from` to a single probe `to`. Returns a
     * path node, false (needs more iterations) or null (no path). */
    function FindSegment(from, to) {
        local pf = this._PF();
        pf.cost.tile = 100;
        pf.cost.turn = 50;
        pf.cost.no_existing_road = 120;
        pf.cost.slope = 200;
        pf.cost.bridge_per_tile = 100;
        pf.cost.tunnel_per_tile = 100;
        pf.cost.coast = 20;
        pf.cost.max_bridge_length = 12;
        pf.cost.max_tunnel_length = 10;
        pf.InitializePath([from], [to]);
        local p = false;
        local i = 0;
        while (p == false && i < 40) {
            p = pf.FindPath(50);
            i++;
        }
        return p; // node, false (still searching), or null
    }

    /* Build road/bridge/tunnel along a path node chain. Returns count of
     * segments laid. */
    function LayPath(path) {
        // Flatten the parent chain first. FindPath returns the GOAL node and
        // GetParent() walks back toward the source, so the chain is
        // [goal, ..., source].
        local chain = [];
        local n = path;
        while (n != null) { chain.append(n.GetTile()); n = n.GetParent(); }

        // Build SOURCE -> GOAL, i.e. walk the chain backwards.
        //
        // Why the direction matters (fixed 2026-09-12): building goal->source
        // meant a partial failure left a road island near the goal that was NOT
        // connected to the tile we were standing on, while the caller still
        // advanced the front all the way to the goal. The route then had an
        // invisible hole in the middle. Building away from where we already are
        // keeps every laid segment contiguous with the road behind us, so a
        // partial failure is always a safe place to stop and retry.
        local segs = 0;
        this._lastLaid = -1;
        for (local i = chain.len() - 1; i > 0; i--) {
            local from = chain[i];
            local to = chain[i - 1];
            if (AIMap.DistanceManhattan(from, to) == 1) {
                local ok1 = AIRoad.BuildRoad(from, to);
                if (!ok1 && AIError.GetLastError() != AIError.ERR_ALREADY_BUILT) {
                    this._layErr = "" + AIError.GetLastErrorString();
                    return segs > 0 ? segs : -1;
                }
                AIRoad.BuildRoad(to, from);
                this._builtRoad.append([from, to]);
                segs++;
                this._lastLaid = to;
            } else if (!AIBridge.IsBridgeTile(from) && !AITunnel.IsTunnelTile(from)) {
                if (AIRoad.IsRoadTile(from)) AITile.DemolishTile(from);
                if (AITunnel.GetOtherTunnelEnd(from) == to) {
                    if (!AITunnel.BuildTunnel(AIVehicle.VT_ROAD, from)) {
                        this._layErr = "" + AIError.GetLastErrorString();
                        return segs > 0 ? segs : -1;
                    }
                } else {
                    local bl = AIBridgeList_Length(AIMap.DistanceManhattan(from, to) + 1);
                    bl.Valuate(AIBridge.GetMaxSpeed);
                    bl.Sort(AIList.SORT_BY_VALUE, false);
                    if (!AIBridge.BuildBridge(AIVehicle.VT_ROAD, bl.Begin(), from, to)) {
                        this._layErr = "" + AIError.GetLastErrorString();
                        return segs > 0 ? segs : -1;
                    }
                }
                this._builtRoad.append([from, to]);
                segs++;
                this._lastLaid = to;
            } else {
                this._lastLaid = to;
            }
        }
        return segs;
    }

    /* Tile at the far end of a path chain. FindPath returns the GOAL node
     * whose GetParent() chain walks back to the source; the goal tile is the
     * returned node's own tile (the head), not the tail. */
    function LastTileOf(path) {
        if (path == null) return -1;
        return path.GetTile();
    }

    /* Called when the full route is laid: connect both stops to their
     * fronts and move to the depot stage. */
    function FinishRoad() {
        local tA = this._slotA.bp[0];
        local fA = this._slotA.bp[1];
        local tB = this._slotB.bp[0];
        local fB = this._slotB.bp[1];
        this.SetPhase("road_built");
        this.ConnectStop(tA, fA);
        this.ConnectStop(tB, fB);
        this._stage = "depot";
    }


    function PhaseDepot() {
        if (this._slotD.bp == null) {
            // No D sign (GS best-effort) -> find near station A's front.
            if (this._slotA.bp != null) {
                local site = this.FindAltSite(this._slotA.bp[0], this._slotA.bp[1], 3, 6);
                if (site != null) this._slotD.bp = site;
            }
        }
        if (this._slotD.bp == null) {
            this.SetPhase("dpt_nowhere");
            this._stage = "done";
            return;
        }
        local tile = this._slotD.bp[0];
        local front = this._slotD.bp[1];
        if (!this.TryPlaceDepot(tile, front)) {
            if (this._slotD.tried > 20) {
                this.SetPhase("dpt_giveup");
                this._stage = "done";
                return;
            }
            local alt = this.FindAltSite(tile, front, 1 + (this._slotD.tried % 5), 6);
            this._slotD.tried++;
            if (alt != null) this._slotD.bp = alt;
            else this.SetPhase("dpt_retry");
            return;
        }
        // Depot built. Ensure the depot tile connects to its own front
        // (a depot whose door faces an unconnected front strands the bus
        // forever inside - seen live), then road from that front to the
        // nearer station front.
        this.SetPhase("dpt_ok");
        this.ConnectStop(tile, front);
        if (!AIRoad.AreRoadTilesConnected(front, tile)) {
            this.SetPhase("dpt_door_e");
            this._stage = "done";
            return;
        }
        this.ConnectDepotToStation(tile, front);
        this._stage = "bus";
    }

    /* One BuildRoadDepot attempt (clear land first). */
    function TryPlaceDepot(tile, front) {
        AITile.DemolishTile(tile);
        AITile.DemolishTile(front);
        if (!AITile.IsBuildable(tile)) return false;
        AIRoad.SetCurrentRoadType(AIRoad.ROADTYPE_ROAD);
        local ok = AIRoad.BuildRoadDepot(tile, front);
        if (!ok) {
            local es = AIError.GetLastErrorString();
            if (es == null) es = "" + AIError.GetLastError();
            if (es.len() > 14) es = es.slice(0, 14);
            this.SetPhase("dpt_e" + es);
        }
        return ok;
    }

    /* Road from the depot front to the nearer station front so buses can
     * actually drive out. Bidirectional BuildRoad per segment. */
    function ConnectDepotToStation(depotTile, depotFront) {
        local near = null;
        local tA = this._slotA.bp == null ? -1 : this._slotA.bp[1];
        local tB = this._slotB.bp == null ? -1 : this._slotB.bp[1];
        local dA = (tA < 0) ? 999999 : AIMap.DistanceManhattan(depotFront, tA);
        local dB = (tB < 0) ? 999999 : AIMap.DistanceManhattan(depotFront, tB);
        near = (dA <= dB) ? tA : tB;
        if (near < 0) return;
        local pf = this._PF();
        pf.cost.tile = 100;
        pf.cost.turn = 50;
        pf.cost.no_existing_road = 40;
        pf.cost.slope = 200;
        pf.InitializePath([depotFront], [near]);
        local dpath = false;
        local di = 0;
        while (dpath == false && di < 300) {
            dpath = pf.FindPath(1000);
            di++;
            if (di % 10 == 0) this.Sleep(1);
        }
        if (dpath == null || dpath == false) {
            this.SetPhase("dpt_noconn");
            return;
        }
        local okSegs = 0;
        while (dpath != null) {
            local par = dpath.GetParent();
            if (par != null) {
                local from = dpath.GetTile();
                local to = par.GetTile();
                if (AIMap.DistanceManhattan(from, to) == 1) {
                    AIRoad.BuildRoad(from, to);
                    AIRoad.BuildRoad(to, from);
                    this._builtRoad.append([from, to]);
                    okSegs++;
                }
            }
            dpath = par;
        }
        if (okSegs > 0) this.SetPhase("dpt_conn");
    }

    /* S4b: buy a passenger road vehicle at the depot, refit, give it orders
     * A -> B -> A, and start it. Mirrors arena PhaseBus (engine pick by
     * CC_PASSENGERS + ROADTYPE_ROAD, best speed). */
    function PhaseBus() {
        local cl = AICargoList();
        cl.Valuate(AICargo.HasCargoClass, AICargo.CC_PASSENGERS);
        cl.KeepValue(1);
        if (cl.IsEmpty()) {
            this.SetPhase("bus_nocargo");
            this._stage = "done";
            return;
        }
        local cargo = cl.Begin();
        local engine = this.PickBusEngine(cargo);
        if (engine < 0) {
            this.SetPhase("bus_noeng");
            this._stage = "done";
            return;
        }
        local depotTile = this._slotD.bp[0];
        local v = AIVehicle.BuildVehicle(depotTile, engine);
        if (!AIVehicle.IsValidVehicle(v)) {
            local es = AIError.GetLastErrorString();
            if (es == null) es = "" + AIError.GetLastError();
            if (es.len() > 14) es = es.slice(0, 14);
            this.SetPhase("bus_buy_e" + es);
            this._stage = "done";
            return;
        }
        this._vehicle = v;
        AIVehicle.RefitVehicle(v, cargo);
        local stA = this._slotA.bp[0];
        local stB = this._slotB.bp[0];
        AIOrder.AppendOrder(v, stA, AIOrder.OF_NON_STOP_INTERMEDIATE);
        AIOrder.AppendOrder(v, stB, AIOrder.OF_NON_STOP_INTERMEDIATE);
        if (!AIVehicle.StartStopVehicle(v)) {
            this.SetPhase("bus_start_e");
        }
        // Fleet scaling (arena-verified): one bus cannot clear the queue a
        // healthy route builds; clone to 3 sharing the same orders.
        for (local i = 1; i < 3; i++) {
            local cv = AIVehicle.CloneVehicle(this._slotD.bp[0], v, true);
            if (!AIVehicle.IsValidVehicle(cv)) break;
            AIVehicle.StartStopVehicle(cv);
        }
        this.SetPhase("bus_live");
        this._stage = "done";
    }

    /* Pick the fastest buildable passenger road vehicle available. */
    function PickBusEngine(cargo) {
        local el = AIEngineList(AIVehicle.VT_ROAD);
        el.Valuate(AIEngine.IsBuildable);          el.KeepValue(1);
        el.Valuate(AIEngine.GetRoadType);          el.KeepValue(AIRoad.ROADTYPE_ROAD);
        el.Valuate(AIEngine.CanRefitCargo, cargo); el.KeepValue(1);
        el.Valuate(AIEngine.GetMaxSpeed);
        el.Sort(AIList.SORT_BY_VALUE, false);
        if (el.IsEmpty()) return -1;
        return el.Begin();
    }

    /* Connect a bus stop tile to its front with a road stub (bidirectional),
     * unless already connected. */
    function ConnectStop(stop_tile, front_tile) {
        if (stop_tile == null || front_tile == null) return;
        if (AIRoad.AreRoadTilesConnected(front_tile, stop_tile)) return;
        AIRoad.SetCurrentRoadType(AIRoad.ROADTYPE_ROAD);
        local ok = AIRoad.BuildRoad(front_tile, stop_tile);
        if (!ok && AIError.GetLastError() == AIError.ERR_ALREADY_BUILT) ok = true;
        if (!ok) {
            ok = AIRoad.BuildRoad(stop_tile, front_tile);
            if (!ok && AIError.GetLastError() == AIError.ERR_ALREADY_BUILT) ok = true;
        }
        if (ok && this._builtRoad != null) this._builtRoad.append([front_tile, stop_tile]);
    }

    /* Run a fresh pathfinder with huge no_existing_road penalty: if it finds
     * a route it means the tiles we built form a connected road. */
    /* Locate the blueprint sign for station `label` ("A"/"B" -> sign slot
     * "S"/"E"). Returns [tile, front] or null. */
    function FindSign(label) {
        local slot = (label == "A") ? "S" : ((label == "B") ? "E" : "D");
        local sl = AISignList();
        foreach (sid, _ in sl) {
            local txt = AISign.GetName(sid);
            if (txt == null) continue;
            if (txt.len() < 5) continue;
            if (txt.slice(0, 5) != "NUTZ:") continue;
            local parts = this.Split(txt.slice(5), ":");
            if (parts.len() < 4) continue;
            if (parts[0] != "bp") continue;
            local job = this.ToInt(parts[1]);
            if (job != this._job) continue;
            if (parts[2] != slot) continue;
            local front = this.ParseKV(parts[3], "fr");
            local tile = AISign.GetLocation(sid);
            if (front < 0) continue;
            if (tile == null || !AIMap.IsValidTile(tile)) continue;
            return [tile, front];
        }
        return null;
    }

    /* One BuildRoadStation attempt on cleared land. Reports via SetPhase on
     * failure so we can see the engine error code from the admin port. */
    function TryPlaceStop(tile, front) {
        AITile.DemolishTile(tile);
        AITile.DemolishTile(front);
        AIRoad.SetCurrentRoadType(AIRoad.ROADTYPE_ROAD); // precondition (pre-15 defaults vary)
        local ok = AIRoad.BuildRoadStation(tile, front,
                                           AIRoad.ROADVEHTYPE_BUS,
                                           AIStation.STATION_NEW);
        if (ok) {
            // Best-effort immediate connection; report-only on failure. The
            // real fix for sloped pairs is keeping the GS-chosen front
            // direction during the pax scan (BestPaxCandidate), which stays
            // on the same terrain as the anchor the GS validated.
            AIRoad.SetCurrentRoadType(AIRoad.ROADTYPE_ROAD);
            if (!AIRoad.AreRoadTilesConnected(front, tile)) {
                local c1 = AIRoad.BuildRoad(front, tile);
                if (!c1 && AIError.GetLastError() == AIError.ERR_ALREADY_BUILT) c1 = true;
                if (!c1) c1 = AIRoad.BuildRoad(tile, front);
                if (!c1 && AIError.GetLastError() == AIError.ERR_ALREADY_BUILT) c1 = true;
                if (!c1) this.SetPhase("st_slope_warn");
            }
            return true;
        }
        local es = AIError.GetLastErrorString();
        if (es == null) es = "" + AIError.GetLastError();
        if (es.len() > 14) es = es.slice(0, 14);
        this.SetPhase("st_place_e" + es);
        return false;
    }

    /* Scan a square ring of radius `radius` around `center` for an alternative
     * buildable [tile, front] pair. Shifts by multiples of 3 so repeated calls
     * walk outward. */
    function FindAltSite(center, _front, ring, _maxR) {
        local cx = AIMap.GetTileX(center);
        local cy = AIMap.GetTileY(center);
        local dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        local r = ring;
        for (local dx = -r; dx <= r; dx++) {
            for (local dy = -r; dy <= r; dy++) {
                if (dx != -r && dx != r && dy != -r && dy != r) continue;
                local x = cx + dx; local y = cy + dy;
                if (x < 0 || y < 0) continue;
                if (x >= AIMap.GetMapSizeX() || y >= AIMap.GetMapSizeY()) continue;
                local tile = AIMap.GetTileIndex(x, y);
                if (AITile.IsWaterTile(tile)) continue;
                if (!AITile.IsBuildable(tile)) continue;
                foreach (d in dirs) {
                    local fx = x + d[0]; local fy = y + d[1];
                    if (fx < 0 || fy < 0) continue;
                    if (fx >= AIMap.GetMapSizeX() || fy >= AIMap.GetMapSizeY()) continue;
                    local front = AIMap.GetTileIndex(fx, fy);
                    if (AITile.IsWaterTile(front)) continue;
                    if (!AITile.IsBuildable(front)) continue;
                    return [tile, front];
                }
            }
        }
        return null;
    }

    /* Parse a `key=value` token; -1 if key mismatch or malformed. */
    function ParseKV(pair, key) {
        local pfx = key + "=";
        if (pair == null || pair.len() <= pfx.len()) return -1;
        if (pair.slice(0, pfx.len()) != pfx) return -1;
        return this.ToInt(pair.slice(pfx.len()));
    }

    /* Split via find/slice — s[i] returns an integer in OpenTTD's Squirrel,
     * single-quoted literals are integers; use double quotes + find/slice. */
    function Split(s, sep) {
        local out = [];
        for (;;) {
            local idx = s.find(sep);
            if (idx == null || idx < 0) { out.push(s); break; }
            out.push(s.slice(0, idx));
            s = s.slice(idx + sep.len());
            if (s.len() == 0) { out.push(""); break; }
        }
        return out;
    }

    /* Parse a decimal integer; -1 if malformed.
     * NOTE: "7".tointeger() == 7 (numeric), NOT ASCII 55. */
    function ToInt(s) {
        if (s == null || s.len() == 0) return -1;
        local neg = false;
        if (s.slice(0, 1) == "-") { neg = true; s = s.slice(1); }
        local v = 0;
        for (local i = 0; i < s.len(); i++) {
            local ch = s.slice(i, i + 1);
            if (ch < "0" || ch > "9") return -1; // not 0-9
            v = v * 10 + ch.tointeger();
        }
        return neg ? -v : v;
    }

    /* Find the passenger cargo id (cached). */
    function GetPaxCargoId() {
        if (this._paxCargo >= 0) return this._paxCargo;
        local cl = AICargoList();
        foreach (c, _ in cl) {
            if (AICargo.HasCargoClass(c, AICargo.CC_PASSENGERS)) {
                this._paxCargo = c;
                return c;
            }
        }
        return -1;
    }

    /* Live bus diagnostic encoded into the company name (31 chars):
     *   EX [R|S|D|@|B|X]<speed> a<waitA> b<waitB> j<job>
     * R=running, S=stopped, D=depot, @=at station, B=broken, X=crashed.
     * a/b = passengers waiting at station A/B — distinguishes a working
     * route from one where nobody boards. */
    /* S6: apply a `NUTZ:bp:<job>:V:<count>` fleet-size sign from the GS
     * (placed by the agent's add_vehicles tool). Grows by cloning the lead
     * vehicle (clones share orders); shrinks by selling the newest vehicles.
     * Acts only when the requested count differs from what we last applied. */
    function CheckAddVehicles() {
        local sl = AISignList();
        local want = -1;
        foreach (sid, _ in sl) {
            local txt = AISign.GetName(sid);
            if (txt == null || txt.len() < 5) continue;
            if (txt.slice(0, 5) != "NUTZ:") continue;
            local parts = this.Split(txt.slice(5), ":");
            if (parts.len() < 4) continue;
            if (parts[0] != "bp") continue;
            local job = this.ToInt(parts[1]);
            if (job != this._job) continue;
            if (parts[2] != "V") continue;
            want = this.ToInt(parts[3]);
            break;
        }
        if (want < 1) return;
        if (want == this._fleetApplied) return; // already satisfied
        local cur = 0;
        local vl = AIVehicleList();
        foreach (v, _ in vl) cur++;
        if (cur < want) {
            if (!AIVehicle.IsValidVehicle(this._vehicle)) {
                // Nothing to clone: this command can only SCALE an existing fleet.
                // It used to `return` silently, so a request for vehicles from a
                // route with zero vehicles looked like it had been accepted.
                this.SetPhase("fleet_noveh");
                return;
            }
            while (cur < want) {
                local cv = AIVehicle.CloneVehicle(this._slotD.bp[0], this._vehicle, true);
                if (!AIVehicle.IsValidVehicle(cv)) break;
                AIVehicle.StartStopVehicle(cv);
                cur++;
            }
            this._fleetApplied = want;
            this.SetPhase("fleet" + cur);
        } else if (cur > want) {
            // Sell vehicles that are not the lead vehicle.
            foreach (v, _ in vl) {
                if (cur <= want) break;
                if (v == this._vehicle) continue;
                if (AIVehicle.SellVehicle(v)) cur--;
            }
            this._fleetApplied = want;
            this.SetPhase("fleet" + cur);
        } else {
            this._fleetApplied = want;
        }
    }

    function DumpBus() {
        if (!AIVehicle.IsValidVehicle(this._vehicle)) return;
        local stA = this._slotA.bp == null ? -1 : this._slotA.bp[0];
        local stB = this._slotB.bp == null ? -1 : this._slotB.bp[0];
        local st = AIVehicle.GetState(this._vehicle);
        local ch = "?";
        if      (st == AIVehicle.VS_RUNNING)  ch = "R";
        else if (st == AIVehicle.VS_STOPPED)  ch = "S";
        else if (st == AIVehicle.VS_IN_DEPOT) ch = "D";
        else if (st == AIVehicle.VS_AT_STATION) ch = "@";
        else if (st == AIVehicle.VS_BROKEN)   ch = "B";
        else if (st == AIVehicle.VS_CRASHED)  ch = "X";
        local sp = AIVehicle.GetCurrentSpeed(this._vehicle);
        local loc = AIVehicle.GetLocation(this._vehicle);
        local dA = AIMap.DistanceManhattan(loc, stA);
        // On every 3rd dump, also report the bus tile coords + whether the
        // road continues from the bus tile toward station A (for stuck debug).
        if (this._dumpSeq % 3 == 0) {
            local lx = AIMap.GetTileX(loc) % 1000;
            local ly = AIMap.GetTileY(loc) % 1000;
            local rd = AIRoad.IsRoadTile(loc);
            local dep = AIRoad.IsRoadDepotTile(loc);
            local sta = AIRoad.IsRoadStationTile(loc);
            local obj = "?";
            if (dep) obj = "depot";
            else if (sta) obj = "station";
            else if (rd) obj = "road";
            else obj = "other";
            this.SetPhase("@" + lx + "," + ly + " " + obj + " d" + dA);
            this._dumpSeq++;
            return;
        }
        local pax = this.GetPaxCargoId();
        local sa = AIStation.GetStationID(stA);
        local wA = (pax >= 0 && AIStation.IsValidStation(sa))
            ? AIStation.GetCargoWaiting(sa, pax) : -1;
        this._dumpSeq++;
        // "R37 d6 a3 #4" - running 37, 6 tiles from A, 3 waiting at A.
        this.SetPhase(ch + sp + " d" + dA + " a" + wA + " #" + this._dumpSeq);
    }
}
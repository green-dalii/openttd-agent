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
    _doneJobs = [];   // jobs this executor has completed (FIFO bookkeeping)
    _stage = "boot";   // boot -> buildA -> buildB -> road -> done
    _slotA = { label = "A", bp = null, tried = 0 };
    _slotB = { label = "B", bp = null, tried = 0 };
    _lastBeat = -1;
    _loopSeq = 0;
    _phaseHoldUntil = -1; // 事件相位的粘滞截止（见 SetPhaseSticky）
    _pf = null;      // persisted pathfinder (see FindSegment)
    _pfFrom = -1;
    _pfTo = -1;
    _reportDone = false;
    _slotD = { label = "D", bp = null, tried = 0 };
    _vehicle = -1;
    _paxCargo = -1;
    _radius = -1;
    _fleetApplied = -1;  // last applied fleet size from a V sign
    _fleetOwned = [];    // vehicles cloned for the CURRENT job (per-route accounting, G3)
    _fleetWaitAnnounced = ""; // last deferred request we announced (M3-1b: one phase per request)
    _fleetSell = [];     // clones told to go to the depot, waiting to be sold (M3-1b)
    _fleetRefused = "";  // last "job:want" refused for being another job's request
    /* 按线路登记（M3-2a，SPEC §10.86）。
     * 为什么必须存在：`_fleetOwned` / `_vehicle` 在切 job 时被重置，于是执行器
     * **不记得旧线路的车队**——"关掉一条正在亏钱的旧线路"（真实场景恰恰是先建的线）
     * 就永远做不到。`_routes[job]` 是**跨 job 保留**的唯一目的地：
     *   vehicles = 该线路的车（含头车）；lead = 头车；depot = 车库瓦片；retired = 已退役
     */
    _routes = {};        // job -> { vehicles = [], lead = -1, depot = -1, retired = false }
    _retiredJobs = {};   // job -> true：已退役的线路（table 集合；array 没有 rawin/in）
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
            //
            // Keyed on a LOOP COUNTER, not AIController.GetTick() (2026-09-12).
            // GetTick() returns SCRIPT ticks, and its value differs per script
            // speed - so `GetTick() > 299` never became true in any real run and
            // the heartbeat silently never fired. That left the executor with no
            // liveness channel at all, which is precisely why "stuck at boot" was
            // undiagnosable: silence looked identical to dead.
            // With Sleep(5), 40 loops is ~200 script ticks.
            this._loopSeq++;
            if (this._loopSeq % 6 == 0) {
                this._hbSeq++;
                if (this._stage == "done" && this._vehicle >= 0) {
                    this.DumpBus();
                } else {
                    // Include how many NUTZ blueprint signs this AI can actually
                    // see. The heartbeat is the only channel that keeps reporting
                    // while the executor is stuck, so it has to carry the one fact
                    // that separates "no work was published" from "work was
                    // published but I cannot see it" (ROADMAP 4b). 31-char budget:
                    // "hb boot #12 s3" is 14.
                    this.SetPhase("hb " + this._stage + " #" + this._hbSeq + " s" + this.CountNutSigns());
                }
            }
        } catch (e) {
            local es = "" + e;
            // 24 chars: "exc:" (4) + 24 + " j<N>" (<=5) fits the 31-char budget.
            // Was 16 - the truncation cut "can't execute ..." before the
            // function name, making the error undiagnosable from the log.
            if (es.len() > 24) es = es.slice(0, 24);
            // 诊断**绕过粘滞**：否则一个长事件会把错误信息埋掉（那是更坏的沉默）。
            this.WritePhase("exc:" + es);
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
        }
        // 车队请求在**任何阶段**都被尝试（2026-09-19，M3-1b / SPEC §10.84）。
        //
        // 曾经这里只是 `} else if (this._stage == "done" && this._vehicle >= 0) {`：
        // 真机实测（§10.81）执行器发完缩编请求后再没回到过 `done`，于是请求**永不生效**，
        // 而工具只会说"请求已发出" —— 模型只能学到"请求车队没用"（D20 同源）。
        // 现在：`done` 每轮尝试（沿用原行为），其他阶段按 `_loopSeq` 节流尝试；
        // 不能应用时由 CheckAddVehicles 给出**具名**理由（fleet_noveh/fleet_nodepot/fleet_wait）。
        if (this._stage == "done" || this._loopSeq % 40 == 0) {
            this.CheckAddVehicles();
        }
        // 卖车跨 tick：车库里的车每轮检查一次（队列为空时立即返回）。
        this.ProcessFleetSells();
        // 退役请求（X:1）任何阶段都检查：它正是"关掉一条正在亏钱的线路"这个动作。
        this.CheckRetireRequests();
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
        // stage "done": this job's construction finished. Look for the NEXT
        // pending plan instead of idling forever.
        //
        // Measured (SPEC §10.38, /tmp/cal2): the model sent FOUR build commands
        // ("bootstrap cheap, then expand") and the executor ran exactly one and
        // idled through the rest. A one-shot state machine turns a sound plan
        // into one route and silently drops the remainder.
        if (this._stage == "done" && this._reportDone) {
            this._doneJobs.append(this._job);
            local next = this.FindNextJob();
            if (next >= 0) {
                // Reset EVERY per-route field to its constructor value. A missed
                // one leaks state across jobs (a stale _roadCur made job N+1
                // believe road-laying had already started).
                // 先把刚完成的线路**存进登记表**，再重置当前字段（顺序不能反）。
                // 退役与"给旧线路调车队"都依赖这份记录。
                this._routes[this._job] <- {
                    vehicles = this._fleetOwned,
                    lead = this._vehicle,
                    depot = (this._slotD.bp == null ? -1 : this._slotD.bp[0]),
                    retired = false,
                };
                this._job = next;
                this._slotA = { label = "A", bp = null, tried = 0 };
                this._slotB = { label = "B", bp = null, tried = 0 };
                this._slotD = { label = "D", bp = null, tried = 0 };
                this._pf = null;
                this._pfFrom = -1;
                this._pfTo = -1;
                this._reportDone = false;
                this._vehicle = -1;
                this._paxCargo = -1;
                this._radius = -1;
                this._fleetApplied = -1;
                this._fleetOwned = [];
                this._fleetWaitAnnounced = "";
                this._fleetSell = [];
                this._roadCur = -1;
                this._roadSeg = 0;
                this._roadSegStep = 0;
                this._lastLaid = -1;
                this._layErr = "";
                this._builtRoad = null;
                this._stage = "buildA";
                this.SetPhase("work");
                AILog.Info("ExecutorV1 queued next job " + next);
            }
        }
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

    /* How many NUTZ: signs THIS AI can see via AISignList().
     * Separate from the GS's own count: the GS reports what it PLACED, this
     * reports what the executor can READ, and the difference between the two is
     * exactly the failure we could not previously observe. */
    function CountNutSigns() {
        local n = 0;
        local sl = AISignList();
        foreach (sid, _ in sl) {
            local txt = AISign.GetName(sid);
            if (txt == null) continue;
            if (txt.len() >= 5 && txt.slice(0, 5) == "NUTZ:") n++;
        }
        return n;
    }

    /* SetPhase: 公司名编码汇报; ≤31 字符 (OpenTTD 公司名上限). */
    /* 公司名是**单值、被采样**的通道：harness 每 500ms 轮询，而执行器每轮都改写它。
     * 于是稀疏但重要的事件（退役、卖出、推迟）会被施工相位（`R45 d0 a0 #2`）**盖掉**——
     * 动作生效了，归因信号却随机丢失（SPEC §10.86，真机 /tmp/m32c）。
     *
     * 因此按**消费者**分两个入口：
     *   SetPhase(p)        —— "现在在做什么"（要新鲜）：可以覆盖任何东西。
     *   SetPhaseSticky(p,n) —— "发生过什么"（要持久）：设置后**保持 n 轮不被 SetPhase 覆盖**。
     * 诊断类（`exc:`）与心跳始终走 SetPhase，避免长事件把错误信息埋掉。
     */
    function SetPhase(p) {
        // 事件粘滞期内，普通活动相位不许覆盖（否则又回到"事件被盖掉"）。
        if (this._loopSeq < this._phaseHoldUntil && p != this._phase) return;
        this.WritePhase(p);
    }

    /* ⚠️ `hold` 必须给**默认值**：Squirrel 对调用时的参数个数强校验，
     * 单参调用会抛 `wrong number of parameters`——而且是在**动作已执行、相位未发出**的位置，
     * 症状与 §10.86 的两个缺陷完全一样（`/tmp/m32d`：三次操作全部生效、相位一条没进日志）。 */
    function SetPhaseSticky(p, hold = null) {
        this.WritePhase(p);
        this._phaseHoldUntil = this._loopSeq + (hold == null ? 15 : hold);
    }

    function WritePhase(p) {
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
            if (this.IsDoneJob(job)) continue; // completed earlier - never re-run
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

    /* True when this job id has already been completed by this executor. */
    function IsDoneJob(job) {
        foreach (j in this._doneJobs) {
            if (j == job) return true;
        }
        return false;
    }

    /* OLDEST pending blueprint not yet completed, or -1 (FIFO).
     *
     * Why FIFO and not newest-wins: the queue semantics are part of the action
     * contract the agent plans against ("commands are built in submission
     * order"). Newest-wins silently discards a submitted plan with no feedback,
     * which breaks action->outcome causality - and it was a policy the harness
     * chose FOR the agent, based on a guess about its intent. cal2 measured the
     * guess being wrong: four commands meant FOUR wanted routes, not "supersede
     * the old one". Every submitted plan is now built, in order.
     *
     * (A done-SET, not a monotonic id check: the agent may pass explicit job
     * ids, so ids are NOT guaranteed to increase - cal2 sent "job 2".) */
    function FindNextJob() {
        local sl = AISignList();
        local best = -1;
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
            if (job == this._job) continue;
            if (this.IsDoneJob(job)) continue;
            if (best < 0 || job < best) best = job;
        }
        return best;
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
        // Count probe failures so the give-up message can say WHICH half of the
        // search failed: "could not pick a goal tile" (terrain/water around us)
        // versus "picked a goal but no path reaches it" (blocked/bridge needed).
        // Without this the operator and the agent only saw the search spinning.
        local probeFails = 0;
        while (segLen >= 4) {
            local goal = direct ? fB : this.SegmentProbe(this._roadCur, fB, segLen);
            if (!direct && goal < 0) { probeFails++; segLen -= 4; continue; }
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
                // 40 chunks x 50 iterations = the same ~2000-iteration budget the
                // old single-tick loop had, but spread over 40 ticks so the AI
                // yields between them and stays observable.
                if (step > 40) { segLen -= 4; step = 0; }
                // d<dist> = tiles still to go, p<fails> = goal tiles we could not
                // find. "EX rd s0 r7 d42 p0 j100" is 25 chars, inside the 31 limit.
                this.SetPhase("rd s" + this._roadSeg + " r" + step + " d" + dist + " p" + probeFails);
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
        // Probe could not advance even at short range -> give up cleanly, and
        // SAY WHY: distance still to go + how many probe goals we could not find.
        this.SetPhase("rd_stuck " + this._roadSeg + " d" + dist + " p" + probeFails);
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
        // ONE search chunk per call, with the pathfinder PERSISTED across calls.
        //
        // Was: up to 40 x FindPath(50) in a single tick - 2000 iterations inside
        // one Tick(). This file already documents that Pathfinder.Road v4 hangs
        // on long searches ("FindPath(1000) never returns"). Because the search
        // runs INSIDE Tick(), a hang freezes the entire AI: no heartbeat, no
        // phase change, no further construction. From the outside that is
        // indistinguishable from "the executor is dead", which is exactly the
        // undiagnosable stall in ROADMAP 4b/5 (2026-09-12).
        //
        // Yielding between chunks means the AI always gets back to its loop, so
        // the heartbeat keeps reporting and a slow search is visible as slow
        // rather than as silence.
        if (this._pf == null || this._pfFrom != from || this._pfTo != to) {
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
            this._pf = pf;
            this._pfFrom = from;
            this._pfTo = to;
        }
        return this._pf.FindPath(50); // node, false (more to do), or null
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
        if (AIVehicle.IsValidVehicle(v)) {
            // 头车也是这条线路的车队成员（`V:N` 现在表示"线路应有 N 辆车"）。
            // 不把它计入会让 `cur` 永远比真实车队少 1，于是"设为 1"会克隆出 2 辆。
            this._fleetOwned.append(v);
            this.RegisterRoute(this._job);
        }
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
        // G3 (SPEC §10.67 layer 4): a request for a DIFFERENT job used to be
        // skipped without a word, so the agent re-sent the same one (measured:
        // the same `count:15, job:1` request 8 times) while the fleet stayed at 6.
        // Name the refusal instead: the harness decodes `fleet_otherjob` and the
        // agent can then target the job being built, or wait.
        local otherJob = -1;
        local partsRefusedWant = "0";
        foreach (sid, _ in sl) {
            local txt = AISign.GetName(sid);
            if (txt == null || txt.len() < 5) continue;
            if (txt.slice(0, 5) != "NUTZ:") continue;
            local parts = this.Split(txt.slice(5), ":");
            if (parts.len() < 4) continue;
            if (parts[0] != "bp") continue;
            if (parts[2] != "V") continue;
            local job = this.ToInt(parts[1]);
            if (job != this._job) {
                otherJob = job;
                partsRefusedWant = parts[3];
                continue;
            }
            want = this.ToInt(parts[3]);
            break;
        }
        if (want < 1) {
            if (otherJob >= 0) {
                // Say it ONCE per request. The phase channel is the primary progress
                // signal (`EX rd s0 r15 d115`); re-emitting this every tick would
                // bury the road progress under a standing complaint.
                local key = otherJob + ":" + this.ToInt(partsRefusedWant);
                if (key != this._fleetRefused) {
                    this._fleetRefused = key;
                    this.SetPhase("fleet_otherjob j" + otherJob);
                }
            }
            return;
        }
        this._fleetRefused = "";
        if (want == this._fleetApplied) return; // already satisfied
        // Count the vehicles THIS executor cloned for the job it is building, not
        // every vehicle the company owns: `want` is per route, so company-wide
        // accounting made one route's fleet satisfy another route's request.
        // `foreach (a, b in array)`：**a 是下标，b 才是值**（Squirrel 语法
        // `'foreach' '(' [index_id ','] value_id 'in' exp ')'`）。
        // 这里曾经写 `foreach (v, _ in this._fleetOwned)` 并把 `v` 当车辆 id 用：
        // 于是"数车队"数的是"id 等于 0..N-1 的车是否存在"，而下面的卖车调用
        // `SellVehicle(v)` 卖的是**与这条线路无关的 id**——
        // 连"永不卖头车"的守卫（`v == this._vehicle`）比较的也是下标与车辆 id，
        // 从来没有生效过。真机证据：请求 12 → 车队 3→15（克隆 12 辆，不是"设为 12"），
        // 请求 4 → 相位说 fleet4，而公司车队始终 15（SPEC §10.84）。
        // 规则：array 一律用单变量形式（与本仓库其它处一致，list/table 才用双变量）。
        local cur = 0;
        foreach (vid in this._fleetOwned) {
            if (AIVehicle.IsValidVehicle(vid)) cur++;
        }
        // 到这里为止：harness 发来一个**尚未满足**的车队请求，而执行器可能正在施工。
        // 施工期不能改车队是**环境事实**，不是失败；但如果不说，模型只会看到
        // "我请求了、什么都没变"（D20）。所以说一次：推迟到能应用的时候。
        //
        // ⚠️ 这行必须在 `local cur` **之后**：曾经它写在前面，于是每次首次车队请求都
        // 抛 `the index 'cur' does not exist` —— 动作照样在下一轮生效，但**推迟信号全丢**，
        // 日志里只剩一条 exc: 错误相位（SPEC §10.86，真机 /tmp/m32b 抓到）。
        local waitKey = "" + want;
        if (waitKey != this._fleetWaitAnnounced) {
            this._fleetWaitAnnounced = waitKey;
            // `fleet_wait4c12L12` = 请求 4、我们数到 12 辆、列表 12 条。
            this.SetPhaseSticky("fleet_wait" + want + "c" + cur + "L" + this._fleetOwned.len());
        }
        if (cur < want) {
            if (!AIVehicle.IsValidVehicle(this._vehicle)) {
                // Nothing to clone: this command can only SCALE an existing fleet.
                // It used to `return` silently, so a request for vehicles from a
                // route with zero vehicles looked like it had been accepted.
                this.SetPhaseSticky("fleet_noveh");
                return;
            }
            if (this._slotD.bp == null) {
                // 克隆需要"在哪个车库克隆"（AIVehicle.CloneVehicle 的第一个参数）。
                // 施工早期（还没建车库）请求会走到这里；具名说明，而不是抛异常。
                this.SetPhaseSticky("fleet_nodepot");
                return;
            }
            while (cur < want) {
                local cv = AIVehicle.CloneVehicle(this._slotD.bp[0], this._vehicle, true);
                if (!AIVehicle.IsValidVehicle(cv)) break;
                AIVehicle.StartStopVehicle(cv);
                this._fleetOwned.append(cv);
                cur++;
            }
            this._fleetApplied = want;
            this.SetPhaseSticky("fleetg" + cur + "L" + this._fleetOwned.len() + "C" + this.CountOwnVehicles());
        } else if (cur > want) {
            // Sell clones this job owns, newest first; never the lead vehicle.
            // **卖车必须先把车开回车库**（OpenTTD `src/vehicle_cmd.cpp:261`：
            // `if (!front->IsStoppedInDepot()) return CommandCost(STR_ERROR_*_MUST_BE_STOPPED_INSIDE_DEPOT…)`）。
            // 实测（/tmp/m31e，相位 `fleets12L12s0f11C14`）：当场 `SellVehicle` 对**正在跑**的
            // 克隆车 11 次全部被引擎拒绝 → 车队一辆都没少。所以缩编只能是
            // "送回车库 → 等它停下 → 再卖" 的多轮动作，由 ProcessFleetSells() 在每轮推进。
            local toSell = cur - want;
            local pending = [];
            // 新克隆优先（数组尾部），**绝不卖头车**（它承载本线路的订单）。
            local i = this._fleetOwned.len() - 1;
            while (i >= 0 && toSell > 0) {
                local vid = this._fleetOwned[i];
                i--;
                if (!AIVehicle.IsValidVehicle(vid)) continue;
                if (vid == this._vehicle) continue;
                if (AIVehicle.SendVehicleToDepot(vid)) { pending.append(vid); toSell--; }
            }
            foreach (vid in pending) this._fleetSell.append(vid);
            this._fleetApplied = want;
            this.SetPhaseSticky("fleetsend" + pending.len() + "C" + this.CountOwnVehicles());
        } else {
            this._fleetApplied = want;
            // 曾经这里**什么都不说**：`cur == want` 时静默"已满足"，于是
            // "请求被满足"与"请求根本没被处理"在日志里长得一模一样（D20 同源）。
            this.SetPhaseSticky("fleetok" + want + "C" + this.CountOwnVehicles());
        }
    }

    /* 公司自有车辆数（引擎真值）。
     * 为什么放进相位：harness 侧只能通过 admin 的 CompanyStats 看车队，而那个通道
     * 是**周期性推送**的——当"相位说卖到 4"与"admin 说还是 15"冲突时，无法判断
     * 是卖车没生效还是读数陈旧。把引擎自己的计数写进相位，冲突就没有了。 */
    /* 推进"送回车库 → 卖出"：每轮尝试一次，直到车库里的车被卖掉。
     * 单独成函数是因为卖车跨多个游戏 tick（车要开回车库），不能在一个循环里等。 */
    function ProcessFleetSells() {
        if (this._fleetSell.len() == 0) return;
        local waiting = [];
        local sold = 0;
        local blocked = 0;
        local gone = 0;
        foreach (vid in this._fleetSell) {
            // 车辆"不在了"必须**单独计数**：真机上 `fleetsend8` 只卖出 4 辆就 `w0`，
            // 其余 4 辆是**静默消失**的（它们没被卖，却也不存在了）。把"消失"与"卖出"
            // 分开报，才不会把一次删除读成一次成功的卖出（D20 同源）。
            if (!AIVehicle.IsValidVehicle(vid)) { gone++; continue; }
            if (!AIVehicle.IsStoppedInDepot(vid)) { waiting.append(vid); continue; }
            if (AIVehicle.SellVehicle(vid)) sold++; else { blocked++; waiting.append(vid); }
        }
        this._fleetSell = waiting;
        if (this._fleetSell.len() == 0) {
            // 清掉已卖掉的条目（失效 id 会被计数忽略，但留着会让人误解车队规模）
            local live = [];
            foreach (vid in this._fleetOwned) {
                if (AIVehicle.IsValidVehicle(vid)) live.append(vid);
            }
            this._fleetOwned = live;
        }
        if (sold > 0 || gone > 0 || (blocked > 0 && this._fleetSell.len() == 0)) {
            this.SetPhaseSticky(
                "fleetsold" + sold + "g" + gone + "w" + this._fleetSell.len() +
                    "b" + blocked + "C" + this.CountOwnVehicles()
            );
        }
    }

    /* 把当前线路的状态写进登记表（幂等）。切 job 时也会调用同一份逻辑。 */
    function RegisterRoute(job) {
        local prev = this._routes.rawin(job) ? this._routes[job] : null;
        this._routes[job] <- {
            vehicles = this._fleetOwned,
            lead = this._vehicle,
            depot = (this._slotD.bp == null ? -1 : this._slotD.bp[0]),
            retired = (prev != null && prev.retired == true),
        };
    }

    /* 该线路的车队（当前线路用活字段，旧线路用登记表）。 */
    function RouteVehicles(job) {
        if (job == this._job) return this._fleetOwned;
        if (this._routes.rawin(job)) return this._routes[job].vehicles;
        return null;
    }

    /* 退役：把一条线路的**全部**车辆（含头车）送回车库并卖掉。
     *
     * 与普通缩编的区别只有两点，但两点都关键：
     *   ① 下限 1 不适用——头车也要卖，否则线路永远留着一辆车在跑；
     *   ② 退役是**终态**：标牌要清掉、job 要记入 `_retiredJobs`，
     *      否则 FindNextJob 会把它当成待建工作再建一遍。
     * 车辆本身仍然必须"停在车库内"才能卖（引擎前置条件，见 §10.84）。
     */
    function RetireRoute(job) {
        local list = this.RouteVehicles(job);
        if (list == null) {
            // 未知线路必须具名拒绝：静默会让模型以为退役生效了（D20）。
            this.SetPhaseSticky("retire_unknown" + job);
            return;
        }
        local queued = 0;
        foreach (vid in list) {
            if (!AIVehicle.IsValidVehicle(vid)) continue;
            local already = false;
            foreach (q in this._fleetSell) if (q == vid) already = true;
            if (already) { queued++; continue; }
            if (AIVehicle.SendVehicleToDepot(vid)) {
                this._fleetSell.append(vid);
                queued++;
            }
        }
        this._routes[job] <- {
            vehicles = list,
            lead = (job == this._job ? this._vehicle : this._routes[job].lead),
            depot = (job == this._job ? (this._slotD.bp == null ? -1 : this._slotD.bp[0]) : this._routes[job].depot),
            retired = true,
        };
        // table 集合：`in` 判断存在、`<-` 新建槽位（array 没有 rawin，用错就是运行时异常）
        if (!(job in this._retiredJobs)) this._retiredJobs[job] <- true;
        this.RemoveJobSigns(job);
        this.SetPhaseSticky("retire" + queued + "C" + this.CountOwnVehicles());
    }

    /* 清掉某个 job 的 NUTZ 标牌（退役后必须清：否则会被重新捡起来重建）。 */
    function RemoveJobSigns(job) {
        local prefix = "NUTZ:bp:" + job + ":";
        local sl = AISignList();
        foreach (sid, _ in sl) {
            local txt = AISign.GetName(sid);
            if (txt == null) continue;
            if (txt.len() >= prefix.len() && txt.slice(0, prefix.len()) == prefix) {
                AISign.RemoveSign(sid);
            }
        }
    }

    /* 已登记的线路里有没有待处理的退役（X:1）请求。 */
    function CheckRetireRequests() {
        local sl = AISignList();
        foreach (sid, _ in sl) {
            local txt = AISign.GetName(sid);
            if (txt == null || txt.len() < 5) continue;
            if (txt.slice(0, 5) != "NUTZ:") continue;
            local parts = this.Split(txt.slice(5), ":");
            if (parts.len() < 4) continue;
            if (parts[0] != "bp" || parts[2] != "X") continue;
            local job = this.ToInt(parts[1]);
            if (job in this._retiredJobs) continue;
            this.RetireRoute(job);
        }
    }

    function CountOwnVehicles() {
        local n = 0;
        foreach (vid, _ in AIVehicleList()) n++;
        return n;
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
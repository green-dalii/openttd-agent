/**
 * BridgeV1 GS — admin <-> in-game command relay + state heartbeat.
 *
 * 职责 (SPEC §3.2 Bridge GS): 唯一 GS。收 AdminGameScript JSON (ScriptEventAdminPort)
 *   → 处理高层动作 (ping/blueprint/status/clear) → GSSign 放 `NUTZ:` 标牌给
 *   Executor AI 消费; 周期 GSAdmin.Send 状态心跳给外部。
 * 事实来源: SPEC §10.11 (事件 API/双向通道), arena bridge_gs.py 蓝图标牌语法。
 * 禁止: 不做施工决策 (Executor AI 的活); 不碰其它公司。
 */

/* 贪心路径节点：PathFinder.Road 节点的最小形状（GetTile/GetParent），
 * 这样 LayPath/LastTileOf 原样复用，不为回退写第二套铺路代码。 */
class GreedyNode {
    _t = -1;
    _p = null;
    constructor(t, p) { this._t = t; this._p = p; }
    function GetTile() { return this._t; }
    function GetParent() { return this._p; }
}

/* 贪心分段寻路（探针 road 阶段同款：直线优先，左右侧步，走不动即停）。
 * 返回节点链（尾是 from）或 null（一步都走不动）。部分链 = 可推进的部分进度，
 * 调用方按 _lastLaid 推进前沿。 */
function GreedyPath(from, to) {
    local head = GreedyNode(from, null);
    local cur = from;
    local steps = 0;
    local tx = GSMap.GetTileX(to);
    local ty = GSMap.GetTileY(to);
    while (cur != to && steps < 64) {
        steps++;
        local cx = GSMap.GetTileX(cur);
        local cy = GSMap.GetTileY(cur);
        local nx = cx;
        local ny = cy;
        if (cx != tx) nx = (tx > cx) ? cx + 1 : cx - 1;
        else if (cy != ty) ny = (ty > cy) ? cy + 1 : cy - 1;
        else break;
        local cands = [[nx, ny], [cx, cy + 1], [cx, cy - 1]];
        local moved = false;
        foreach (c in cands) {
            local gx = c[0];
            local gy = c[1];
            if (gx < 1 || gy < 1) continue;
            if (gx >= GSMap.GetMapSizeX() - 1 || gy >= GSMap.GetMapSizeY() - 1) continue;
            local nxt = GSMap.GetTileIndex(gx, gy);
            if (nxt == cur) continue;
            // 只走上得去的瓦片（BestPaxCandidate 同款判据）：水/建筑/不可建 = 换候选。
            if (GSTile.IsWaterTile(nxt)) continue;
            if (!GSTile.IsBuildable(nxt) && !GSRoad.IsRoadTile(nxt)) continue;
            head = GreedyNode(nxt, head);
            cur = nxt;
            moved = true;
            break;
        }
        if (!moved) break;
    }
    if (cur == from) return null;
    return head;
}

class ExecCore {
    _gs = null;
    _company = -1;
    _queue = [];        // 待建线路 FIFO: {company, job, siteA, fA, siteB, fB, fleet}
    _fleetReqs = [];    // 车队请求: {job, want}
    _retireReqs = [];   // 退役请求: job
    _lastPh = "";
    _hbSeq = 0;
    _failStreak = 0;    // 同一 job 连续异常次数（有界：超过上限放弃该 job）
    _lastFailJob = -1;

    constructor(gs, company) {
        this._gs = gs;
        this._company = company;
    }

    /* ---- 入口（BridgeV1.Dispatch 直调；标牌邮箱已废） ---- */
    /* `cargo` >= 0 = 货运线路（带货种与两个**锚点产业**：`indA` 装货侧产方、
     * `indB` 卸货侧收方）。客运线路 cargo = -1，锚点为空 ⇒ 行为与从前一致。 */
    function Enqueue(company, job, siteA, fA, siteB, fB, fleet, cargo = -1, indA = -1, indB = -1) {
        this._queue.append({ company = company, job = job, siteA = siteA, fA = fA,
                             siteB = siteB, fB = fB, fleet = (fleet == null ? -1 : fleet),
                             cargo = (cargo == null ? -1 : cargo), indA = indA, indB = indB });
        this._gs.ReportExec({ kind = "exec", job = job, stage = "queued" });
    }
    function FleetRequest(job, want) {
        this._fleetReqs.append({ job = job, want = want });
        this._gs.ReportExec({ kind = "exec", job = job, stage = "fleet_req", note = "want " + want });
    }
    function RetireRequest(job) {
        this._retireReqs.append(job);
        this._gs.ReportExec({ kind = "exec", job = job, stage = "retire_req" });
    }

    /* ---- 上报出口（唯一）：错误**全文**，31 字符分块协议就此退役 ---- */
    function Report(ev) { this._gs.ReportExec(ev); }
    function Ph(p, hold = null) {
        if (p == this._lastPh) return;   // 同相位不重发（旧通道的指纹抑制，现在一行）
        this._lastPh = p;
        this._phase = p;
        this.Report({ kind = "exec", job = this._job, stage = this._stage, note = p });
    }
    function Fail(msg) {
        // 异常兜底：**全文**上报，状态机保持存活（历史教训：catch 里的 bug 会让脚本彻底静默）。
        try {
            this._errMsg = "" + msg;
            this.Report({ kind = "exec", job = this._job, stage = this._stage,
                          error = this._errMsg });
            if (this._lastFailJob == this._job) this._failStreak++;
            else { this._lastFailJob = this._job; this._failStreak = 1; }
            // 有界：同一个 job 连续异常 50 轮还不健康 → 放弃它，别堵住 FIFO。
            if (this._failStreak >= 50) {
                this._doneJobs.append(this._job);
                this.Report({ kind = "exec", job = this._job, stage = "abandoned",
                              error = this._errMsg });
                this._failStreak = 0;
                this._job = -1;
            }
        } catch (e) {}
    }
    function ReportDone() {
        local ids = [];
        foreach (v in this._fleetOwned) { if (v != null && v >= 0) ids.append(v); }
        if (this._vehicle >= 0 && this._fleetOwned.len() == 0) ids.append(this._vehicle);
        this.Report({ kind = "exec", job = this._job, stage = "done",
                      fleet = { owned = ids.len(), ids = ids, applied = this._fleetApplied } });
    }

    /* ---- 每个 GS 主循环调用一次 ---- */
    /* GSController.Sleep 的代理（ExecCore 不继承 GSController）。 */
    function Sleep(n) { GSController.Sleep(n); }

    function Tick() {
        try {
        if (!this._pfTried) {
            this._pfTried = true;
            try { this._PF = import("pathfinder.road", "Road", 4); } catch (e) { this._PF = null; }
        }
        if (this._job < 0) {
            local next = this.FindNextJob();
            if (next == null) {
                // 队列空 ≠ 躺平：车队请求/卖车/退役是**线路级**操作，施工队列空了
                // 它们还要生效。曾经在这里直接 return —— 于是 done 后发出的
                // set_route_vehicles/retire_route 永远排队（真机 2026-10-08：
                // fleet_req/retire_req 有回执，世界纹丝不动）。
                this._loopSeq++;
                try {
                    local im = GSCompanyMode(this._company);
                    if (GSCompanyMode.IsValid()) {
                        this.CheckAddVehicles();
                        this.ProcessFleetSells();
                        this.ProcessFleetRefits();
                    }
                    this.CheckRetireRequests();
                } catch (e) { this.Fail(e); }
                return;
            }
            this._job = next.job;
            this._company = next.company;
            this._slotA = { label = "A", bp = [next.siteA, next.fA], tried = 0 };
            this._slotB = { label = "B", bp = [next.siteB, next.fB], tried = 0 };
            this._slotD = { label = "D", bp = null, tried = 0 };
            this._pf = null; this._pfFrom = -1; this._pfTo = -1;
            this._reportDone = false; this._vehicle = -1; this._paxCargo = -1;
            // 货运线路的状态（货运 F3）：货种 + 两个锚点产业瓦片。
            // 客运线路 cargo = -1 ⇒ `_freight` 为 false ⇒ 走的还是从前那条路。
            this._cargo = (next.cargo == null ? -1 : next.cargo);
            this._freight = (this._cargo >= 0);
            this._indA = (next.indA == null ? -1 : next.indA);
            this._indB = (next.indB == null ? -1 : next.indB);
            this._radius = -1; this._fleetApplied = next.fleet;
            this._fleetOwned = []; this._fleetWaitAnnounced = "";
            this._routeCargo = -1; this._routeEngine = -1;
            this._fleetSell = []; this._fleetRefused = "";
            this._roadCur = -1; this._roadSeg = 0; this._roadSegStep = 0;
            this._lastLaid = -1; this._layErr = ""; this._builtRoad = null;
            this._stage = "buildA";
            local m0 = GSCompanyMode(this._company);
            if (GSCompanyMode.IsValid()) {
                local maxLoan = GSCompany.GetMaxLoanAmount();
                local cur = GSCompany.GetLoanAmount();
                if (maxLoan > cur) GSCompany.SetLoanAmount(maxLoan);
            }
            this.Ph("work j" + this._job);
        }
        this._loopSeq++;
        local mode = GSCompanyMode(this._company);
        if (!GSCompanyMode.IsValid()) { this.Ph("cm_invalid"); return; }
        if (this._stage == "buildA") { this.TryBuildStation(this._slotA); }
        else if (this._stage == "buildB") { this.TryBuildStation(this._slotB); }
        else if (this._stage == "road") { this.PhaseRoad(); }
        else if (this._stage == "depot") { this.PhaseDepot(); }
        else if (this._stage == "bus") { this.PhaseBus(); }
        if (this._stage == "done" || this._loopSeq % 40 == 0) { this.CheckAddVehicles(); }
        this.ProcessFleetSells();
        this.ProcessFleetRefits();
        this.CheckRetireRequests();
        if (this._stage == "done" && !this._reportDone) {
            this._reportDone = true;
            this.ReportDone();
        }
        if (this._stage == "done" && this._reportDone) {
            this._doneJobs.append(this._job);
            this._routes[this._job] <- {
                vehicles = this._fleetOwned, lead = this._vehicle,
                depot = (this._slotD.bp == null ? -1 : this._slotD.bp[0]),
                retired = false, applied = this._fleetApplied,
                stA = (this._slotA.bp == null ? -1 : this._slotA.bp[0]),
                stB = (this._slotB.bp == null ? -1 : this._slotB.bp[0]),
                // 两端的**门前格**（road tile）：诊断"路通不通"与"车停在哪"要用它。
                // 少了这两个字段 ⇒ 诊断永远只能说"没测到"（Issue #113）。
                endA = (this._slotA.bp == null ? null : this._slotA.bp[1]),
                endB = (this._slotB.bp == null ? null : this._slotB.bp[1]),
                cargo = this._routeCargo, engine = this._routeEngine,
                lineCargo = (this._freight ? this._cargo : this._gs.PaxCargoId()),
            };
            this._job = -1;   // 下一轮取队列里的下一个（字段整套复位）
        }
        } catch (e) { this.Fail(e); }
    }

    /* 队列 FIFO：最旧的未完成任务（命令按提交顺序建——语义与旧 FindNextJob 相同）。 */
    function FindNextJob() {
        local best = null;
        foreach (q in this._queue) {
            if (q.job == this._job) continue;
            if (this.IsDoneJob(q.job)) continue;
            if (best == null || q.job < best.job) best = q;
        }
        return best;
    }

    _phase = "boot";
    _job = -1;
    _doneJobs = [];   // jobs this executor has completed (FIFO bookkeeping)
    _stage = "boot";   // boot -> buildA -> buildB -> road -> done
    _slotA = { label = "A", bp = null, tried = 0 };
    _slotB = { label = "B", bp = null, tried = 0 };
    _lastBeat = -1;
    _loopSeq = 0;
    _pf = null;      // persisted pathfinder (see FindSegment)
    _pfFrom = -1;
    _pfTo = -1;
    _reportDone = false;
    _slotD = { label = "D", bp = null, tried = 0 };
    _vehicle = -1;
    _paxCargo = -1;
    _cargo = -1;      // 当前 job 的货种 id（货运线路 >= 0；客运 = -1）
    _freight = false; // 当前 job 是不是货运线路
    _indA = -1;       // 装货锚点（产方产业瓦片）
    _indB = -1;       // 卸货锚点（收方产业瓦片）
    _radius = -1;
    _fleetApplied = -1;  // last applied fleet size from a V sign
    _routeCargo = -1;    // 这条线**改装**到的货物 id（set_route_cargo 生效值）
    _routeEngine = -1;   // 这条线当前**车型**（set_route_engine 生效值；-1 = 未记）
    _fleetRefit = [];    // 改装请求（送库→到库改装→重启），最新意图顶替
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
    _errMsg = null;        // 最后一次上报的错误原文（同一错误每轮重抛一次，不能重启队列）
    // Pathfinder.Road class (library, imported once at load). Local sandbox
    // has v4 (needs graph.aystar v6); arena used v3 — API is compatible:
    //  pf = Road(); pf.cost.*; pf.InitializePath([from],[to]); pf.FindPath(n)
    //  -> node with GetTile()/GetParent(), or false (more iterations), null (none).
    // pathfinder.road 在 **GS 上下文**不可用（2026-10-08 真机实测：import 报
    // "couldn't find library"，库只对 AI 上下文可见）。能装载就用，装载失败走
    // 贪心分段回退（GreedyPath，与探针同款算法）。绝不能在这里抛——抛 = 整个 GS 静默。
    _PF = null;
    _pfTried = false;
    _builtRoad = null;   // list of [from,to] road pairs built



    /* One loop iteration of the build state machine. */


    /* 错误文本 → 公司名单行文本：控制字符转空格、连续空白折叠成一个、去掉首尾空白。
     * 为什么：`"" + e` 常带换行/制表符，写进公司名后 harness 会把它们读成噪音，而且白白
     * 吃掉 31 字符的预算（分块的宽度必须可预测）。
     * 注：字符串索引在 OpenTTD 的 Squirrel 里是整数，所以一律 slice 后按字符串比较。 */


    /* 写出当前那一块。marker 由“是不是末块”与“有没有被截断”决定（见 ReportError）。
     * 每块都粘滞 5 轮：GS 约每 20 script ticks（≈每 4 轮）轮询一次，不粘滞的话末块会被
     * 下一轮的施工相位盖掉，harness 永远拼不完整。错误相位由此**抢占**普通粘滞窗口。 */


    /* 每 5 轮推进一块错误分块（Sleep(5) ⇒ 约 1.4 s），保证 GS 的轮询采样到每一块。 */




    /* Short error text for the phase channel. SetPhase truncates at 31 chars, so
     * keep only the first token of the engine's error string ("Flat land
     * required" -> "Flat"). The full string is useless if it gets cut mid-word. */


    /* How many NUTZ: signs THIS AI can see via AISignList().
     * Separate from the GS's own count: the GS reports what it PLACED, this
     * reports what the executor can READ, and the difference between the two is
     * exactly the failure we could not previously observe. */


    /* SetPhase: 公司名编码汇报; ≤31 字符 (OpenTTD 公司名上限). */
    /* 公司名是**单值、被采样**的通道：harness 每 500ms 轮询，而执行器每轮都改写它。
     * 于是稀疏但重要的事件（退役、卖出、推迟）会被施工相位（`R45 d0 a0 #2`）**盖掉**——
     * 动作生效了，归因信号却随机丢失（SPEC §10.86，真机 /tmp/m32c）。
     *
     * 因此按**消费者**分两个入口：
     *   SetPhase(p)        —— "现在在做什么"（要新鲜）：可以覆盖任何东西。
    /* ⚠️ `hold` 必须给**默认值**：Squirrel 对调用时的参数个数强校验，
     * 单参调用会抛 `wrong number of parameters`——而且是在**动作已执行、相位未发出**的位置，
     * 症状与 §10.86 的两个缺陷完全一样（`/tmp/m32d`：三次操作全部生效、相位一条没进日志）。 */




    /* 扫描 GS 放的 NUTZ:bp:<job>: 标牌 (arena 语法); 命中后借贷 + 进施工阶段. */


    /* Build one bus station from its blueprint sign.
     *  slot: state table {label, bp=null, tried=0} — mutated in place.
     *  "A" uses the S sign (site at sign location), "B" the E sign;
     *  front comes from `fr=<tile>` in the sign name. Uses the arena-verified
     *  pattern: clear both tiles then GSRoad.BuildRoadStation (a normal stop
     *  needs no prebuilt road; the connecting road lands on `front` in the S3
     *  road phase). If the exact sign site is blocked (town ownership,
     *  terrain, cost), scan a small ring for an alternative pair nearby. */
    /* Build one bus station near its blueprint sign. Two attempts:
     *  1. Pax scan: walk a 7x7 grid around the sign anchor, rank candidates
     *     by passenger PRODUCTION in the stop's catchment (GSTile
     *     GetCargoProduction — arena's proven profitability gate), try to
     *     build in descending order. This is what makes the route earn.
     *  2. Plain fallback: any buildable pair near the anchor (route still
     *     builds, may not carry passengers).
     * Arena's TryBuildStation also enforced MIN_PROD and aborted the pair —
     * here we keep it soft (fall back) so the skeleton still completes. */
    function TryBuildStation(slot) {
        // 货运线路（货运 F3）：站址**必须**按引擎规则选（装货站要收货、卸货站要
        // 罩住收方），所以不能沿用客运那套"按人流量重选"的扫描 —— 重选会把
        // 收货判定弄丢（矿场旁的站**不收煤**）。这里走引擎规则的站址扫描。
        if (this._freight) { this.TryBuildFreightStation(slot); return; }
        if (slot.bp == null) {
            // GS-only：站点由 Enqueue 预填（标牌邮箱已废）。
            this.Ph("st" + slot.label + "_noslot");
            return;
        }
        local anchor = slot.bp[0];  // sign tile = original station site
        local anchorF = slot.bp[1];
        // 1. Pax-ranked scan (try up to 12 candidates per tick slice).
        if (slot.tried < 24) {
            local cand = this.BestPaxCandidate(anchor, anchorF, slot.tried);
            if (cand != null) {
                slot.bp = cand;
                if (this.TryPlaceStop(cand[0], cand[1])) {
                    this.Ph("st" + slot.label + "_ok");
                    if (slot.label == "A") { this._stage = "buildB"; }
                    else { this._stage = "road"; }
                    return;
                }
            }
            slot.tried++;
            this.Ph("st" + slot.label + "_scan");
            return;
        }
        // 2. Plain fallback: any buildable pair (bounded).
        if (slot.tried > 24) {
            this.Ph("st" + slot.label + "_giveup");
            return;
        }
        local alt = this.FindAltSite(anchor, anchorF, 1 + (slot.tried % 6), 4);
        slot.tried++;
        if (alt != null) slot.bp = alt;
        else this.Ph("st" + slot.label + "_retry");
    }

    /* 货运站：按**引擎规则**选站址并建站（门前格接路，与客运同款）。
     *
     * 为什么不用客运的扫描：客运按"人流量"重选站址，而货运的站址必须满足
     * **收货 >= 8**（`GSTile.GetCargoAcceptance`）—— 引擎按集货区算accepts，
     * 矿场旁的站不收煤 ⇒ 重选会把唯一能装货的站址换掉。
     *
     * 选不到就换下一个候选（`slot.tried` 递增 ⇒ 扫到下一个可用站址），
     * 试完仍不行 ⇒ 明确报放弃（不假装建成）。
     */
    function TryBuildFreightStation(slot) {
        local anchor = (slot.label == "A") ? this._indA : this._indB;
        // A = 装货侧（产方）：**不要求收货**（产业按 rating 交货，见 FreightSite 注释）。
        // B = 卸货侧（收方）：**必须收货 >= 8**，否则车卸不下来（货被退回，不算交付）。
        local needAcc = (slot.label == "B");
        if (anchor < 0 || !GSMap.IsValidTile(anchor)) {
            this.Ph("st" + slot.label + "_noslot");
            this._stage = "done";
            return;
        }
        if (slot.bp != null) {
            if (this.TryPlaceStop(slot.bp[0], slot.bp[1], true)) {
                this.Ph("st" + slot.label + "_ok");
                if (slot.label == "A") { this._stage = "buildB"; }
                else { this._stage = "road"; }
                return;
            }
            slot.bp = null;   // 这个站址建不成 ⇒ 换下一个候选
        }
        local site = this._gs.FreightSite(anchor, this._cargo, needAcc, slot.tried);
        if (site != null) slot.bp = site;
        slot.tried++;
        if (slot.tried > 6) {
            this.Ph("st" + slot.label + "_giveup");
            this._stage = "done";
            return;
        }
        this.Ph("st" + slot.label + "_scan");
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
        local ax = GSMap.GetTileX(anchor);
        local ay = GSMap.GetTileY(anchor);
        // Keep the GS-chosen front DIRECTION (front - tile offset). The GS
        // picked a pair on flat terrain; translating both tiles together
        // stays on compatible terrain, so the later road connect won't hit
        // ERR_LAND_SLOPED (the bug that stranded the first bus).
        local fdx = 1; local fdy = 0; // default east
        if (anchorF >= 0 && GSMap.IsValidTile(anchorF)) {
            fdx = GSMap.GetTileX(anchorF) - ax;
            fdy = GSMap.GetTileY(anchorF) - ay;
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
                if (x >= GSMap.GetMapSizeX() || y >= GSMap.GetMapSizeY()) continue;
                local tile = GSMap.GetTileIndex(x, y);
                if (GSTile.IsWaterTile(tile)) continue;
                if (!GSTile.IsBuildable(tile)) continue;
                // front must also be valid/buildable (translated direction)
                local fx = x + fdx; local fy = y + fdy;
                if (fx < 0 || fy < 0) continue;
                if (fx >= GSMap.GetMapSizeX() || fy >= GSMap.GetMapSizeY()) continue;
                local front = GSMap.GetTileIndex(fx, fy);
                if (GSTile.IsWaterTile(front)) continue;
                if (!GSTile.IsBuildable(front)) continue;
                // production within the catchment this stop would cover
                local prod = GSTile.GetCargoProduction(tile, pax, 1, 1, r);
                if (prod > bestProd) {
                    bestProd = prod;
                    best = tile;
                }
            }
        }
        if (best == null) return null;
        local bfx = GSMap.GetTileX(best) + fdx;
        local bfy = GSMap.GetTileY(best) + fdy;
        return [best, GSMap.GetTileIndex(bfx, bfy)];
    }

    /* Station coverage radius (cached); bus stops normally cover 4 (or 3
     * with modified_catchment). Ask the game. */
    function StationRadius() {
        if (this._radius > 0) return this._radius;
        this._radius = GSStation.GetCoverageRadius(GSStation.STATION_BUS_STOP);
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
                this.Ph("road_nofront");
                this._stage = "done";
                return;
            }
            this._builtRoad = [];
            GSRoad.SetCurrentRoadType(GSRoad.ROADTYPE_ROAD);
            this._roadCur = this._slotA.bp[1]; // station A front
            this._roadSeg = 0;
            this.Ph("road_start");
        }
        local fB = this._slotB.bp[1];
        local dist = GSMap.DistanceManhattan(this._roadCur, fB);
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
                    this.Ph("rd retry" + (step + 1));
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
                this.Ph("rd s" + this._roadSeg + " r" + step + " d" + dist + " p" + probeFails);
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
                    this.Ph("road_stuck:" + this.ShortErr());
                    this._stage = "done";
                    return;
                }
                this._roadSegStep = step + 1;
                this.Ph("rd layr" + (step + 1));
                return;
            }
            // Advance to the tile we actually reached, NOT to the path's goal.
            // If only part of the path was laid, claiming the goal would skip the
            // unbuilt middle. _lastLaid is always contiguous with _roadCur now
            // that LayPath builds away from us.
            this._roadCur = this._lastLaid >= 0 ? this._lastLaid : this._roadCur;
            this._roadSeg++;
            this._roadSegStep = 0;
            local nd = GSMap.DistanceManhattan(this._roadCur, fB);
            this.Ph("road seg" + this._roadSeg + " d" + nd);
            // 4. Route complete when the last segment ended on fB.
            if (this._roadCur == fB) {
                this.FinishRoad();
            }
            return;
        }
        // Probe could not advance even at short range -> give up cleanly, and
        // SAY WHY: distance still to go + how many probe goals we could not find.
        this.Ph("rd_stuck " + this._roadSeg + " d" + dist + " p" + probeFails);
        this._stage = "done";
    }

    /* Pick a probe tile ~`len` tiles from `cur` in the direction of `goal`,
     * preferring buildable non-water land. Returns tile or -1. */
    function SegmentProbe(cur, goal, len) {
        local cx = GSMap.GetTileX(cur); local cy = GSMap.GetTileY(cur);
        local gx = GSMap.GetTileX(goal); local gy = GSMap.GetTileY(goal);
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
            if (px >= GSMap.GetMapSizeX()) px = GSMap.GetMapSizeX() - 1;
            if (py >= GSMap.GetMapSizeY()) py = GSMap.GetMapSizeY() - 1;
            local tile = GSMap.GetTileIndex(px, py);
            if (GSTile.IsWaterTile(tile)) continue;
            if (GSRoad.IsRoadTile(tile)) return tile; // existing road is fine
            if (!GSTile.IsBuildable(tile)) continue;
            // also check we're actually closer than current
            if (GSMap.DistanceManhattan(tile, goal) >=
                GSMap.DistanceManhattan(cur, goal)) continue;
            return tile;
        }
        return -1;
    }

    /* Run Pathfinder.Road from `from` to a single probe `to`. Returns a
     * path node, false (needs more iterations) or null (no path). */
    /* 短错误文本（相位 note 用；完整错误走 error 字段）。取错误串的首个词。 */
    function ShortErr() {
        local e = this._layErr;
        if (e == null || e == "") e = "" + GSError.GetLastErrorString();
        if (e == null || e == "" || e == "(null)") return "unknown";
        local sp = e.find(" ");
        return (sp == null || sp <= 0) ? e : e.slice(0, sp);
    }

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
        if (this._PF == null) {
            // 无库：贪心分段（一次性返回节点链或 null；调用方的 node/false/null
            // 契约里 false=“还要迭代”，这里永远一次做完，故不产生 false）。
            return GreedyPath(from, to);
        }
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
            if (GSMap.DistanceManhattan(from, to) == 1) {
                local ok1 = GSRoad.BuildRoad(from, to);
                // 探针同款清障重试（真机：树/岩石挡住是常态，road_stuck:ERR_AREA_NOT_CLEAR）。
                if (!ok1) {
                    GSTile.DemolishTile(to);
                    ok1 = GSRoad.BuildRoad(from, to);
                }
                if (!ok1 && GSError.GetLastError() != GSError.ERR_ALREADY_BUILT) {
                    this._layErr = "" + GSError.GetLastErrorString();
                    return segs > 0 ? segs : -1;
                }
                GSRoad.BuildRoad(to, from);
                this._builtRoad.append([from, to]);
                segs++;
                this._lastLaid = to;
            } else if (!GSBridge.IsBridgeTile(from) && !GSTunnel.IsTunnelTile(from)) {
                if (GSRoad.IsRoadTile(from)) GSTile.DemolishTile(from);
                if (GSTunnel.GetOtherTunnelEnd(from) == to) {
                    if (!GSTunnel.BuildTunnel(GSVehicle.VT_ROAD, from)) {
                        this._layErr = "" + GSError.GetLastErrorString();
                        return segs > 0 ? segs : -1;
                    }
                } else {
                    local bl = GSBridgeList_Length(GSMap.DistanceManhattan(from, to) + 1);
                    bl.Valuate(GSBridge.GetMaxSpeed);
                    bl.Sort(GSList.SORT_BY_VALUE, false);
                    if (!GSBridge.BuildBridge(GSVehicle.VT_ROAD, bl.Begin(), from, to)) {
                        this._layErr = "" + GSError.GetLastErrorString();
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
        this.Ph("road_built");
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
            this.Ph("dpt_nowhere");
            this._stage = "done";
            return;
        }
        local tile = this._slotD.bp[0];
        local front = this._slotD.bp[1];
        if (!this.TryPlaceDepot(tile, front)) {
            if (this._slotD.tried > 20) {
                this.Ph("dpt_giveup");
                this._stage = "done";
                return;
            }
            local alt = this.FindAltSite(tile, front, 1 + (this._slotD.tried % 5), 6);
            this._slotD.tried++;
            if (alt != null) this._slotD.bp = alt;
            else this.Ph("dpt_retry");
            return;
        }
        // Depot built. Ensure the depot tile connects to its own front
        // (a depot whose door faces an unconnected front strands the bus
        // forever inside - seen live), then road from that front to the
        // nearer station front.
        this.Ph("dpt_ok");
        this.ConnectStop(tile, front);
        if (!GSRoad.AreRoadTilesConnected(front, tile)) {
            this.Ph("dpt_door_e");
            this._stage = "done";
            return;
        }
        this.ConnectDepotToStation(tile, front);
        this._stage = "bus";
    }

    /* One BuildRoadDepot attempt (clear land first). */
    function TryPlaceDepot(tile, front) {
        GSTile.DemolishTile(tile);
        GSTile.DemolishTile(front);
        if (!GSTile.IsBuildable(tile)) return false;
        GSRoad.SetCurrentRoadType(GSRoad.ROADTYPE_ROAD);
        local ok = GSRoad.BuildRoadDepot(tile, front);
        if (!ok) {
            local es = GSError.GetLastErrorString();
            if (es == null) es = "" + GSError.GetLastError();
            if (es.len() > 14) es = es.slice(0, 14);
            this.Ph("dpt_e" + es);
        }
        return ok;
    }

    /* Road from the depot front to the nearer station front so buses can
     * actually drive out. Bidirectional BuildRoad per segment. */
    function ConnectDepotToStation(depotTile, depotFront) {
        local near = null;
        local tA = this._slotA.bp == null ? -1 : this._slotA.bp[1];
        local tB = this._slotB.bp == null ? -1 : this._slotB.bp[1];
        local dA = (tA < 0) ? 999999 : GSMap.DistanceManhattan(depotFront, tA);
        local dB = (tB < 0) ? 999999 : GSMap.DistanceManhattan(depotFront, tB);
        near = (dA <= dB) ? tA : tB;
        if (near < 0) return;
        local dpath = null;
        if (this._PF == null) {
            dpath = GreedyPath(depotFront, near);
        } else {
            local pf = this._PF();
            pf.cost.tile = 100;
            pf.cost.turn = 50;
            pf.cost.no_existing_road = 40;
            pf.cost.slope = 200;
            pf.InitializePath([depotFront], [near]);
            dpath = false;
            local di = 0;
            while (dpath == false && di < 300) {
                dpath = pf.FindPath(1000);
                di++;
                if (di % 10 == 0) this.Sleep(1);
            }
        }
        if (dpath == null || dpath == false) {
            this.Ph("dpt_noconn");
            return;
        }
        local okSegs = 0;
        while (dpath != null) {
            local par = dpath.GetParent();
            if (par != null) {
                local from = dpath.GetTile();
                local to = par.GetTile();
                if (GSMap.DistanceManhattan(from, to) == 1) {
                    GSRoad.BuildRoad(from, to);
                    GSRoad.BuildRoad(to, from);
                    this._builtRoad.append([from, to]);
                    okSegs++;
                }
            }
            dpath = par;
        }
        if (okSegs > 0) this.Ph("dpt_conn");
    }

    /* S4b: buy a passenger road vehicle at the depot, refit, give it orders
     * A -> B -> A, and start it. Mirrors arena PhaseBus (engine pick by
     * CC_PASSENGERS + ROADTYPE_ROAD, best speed). */
    function PhaseBus() {
        // 货运线路（货运 F3）：买**货车**并改装到该货种。
        if (this._freight) { this.PhaseTruck(); return; }
        local cl = GSCargoList();
        cl.Valuate(GSCargo.HasCargoClass, GSCargo.CC_PASSENGERS);
        cl.KeepValue(1);
        if (cl.IsEmpty()) {
            this.Ph("bus_nocargo");
            this._stage = "done";
            return;
        }
        local cargo = cl.Begin();
        local engine = this.PickRoadEngine(cargo);
        if (engine < 0) {
            this.Ph("bus_noeng");
            this._stage = "done";
            return;
        }
        local depotTile = this._slotD.bp[0];
        local v = GSVehicle.BuildVehicle(depotTile, engine);
        if (GSVehicle.IsValidVehicle(v)) {
            // 头车也是这条线路的车队成员（`V:N` 现在表示"线路应有 N 辆车"）。
            // 不把它计入会让 `cur` 永远比真实车队少 1，于是"设为 1"会克隆出 2 辆。
            this._fleetOwned.append(v);
            this.RegisterRoute(this._job);
        }
        if (!GSVehicle.IsValidVehicle(v)) {
            local es = GSError.GetLastErrorString();
            if (es == null) es = "" + GSError.GetLastError();
            if (es.len() > 14) es = es.slice(0, 14);
            this.Ph("bus_buy_e" + es);
            this._stage = "done";
            return;
        }
        this._vehicle = v;
        GSVehicle.RefitVehicle(v, cargo);
        local stA = this._slotA.bp[0];
        local stB = this._slotB.bp[0];
        GSOrder.AppendOrder(v, stA, GSOrder.OF_NON_STOP_INTERMEDIATE);
        GSOrder.AppendOrder(v, stB, GSOrder.OF_NON_STOP_INTERMEDIATE);
        if (!GSVehicle.StartStopVehicle(v)) {
            this.Ph("bus_start_e");
        }
        // Fleet scaling (arena-verified): one bus cannot clear the queue a
        // healthy route builds; clone to 3 sharing the same orders.
        for (local i = 1; i < 3; i++) {
            local cv = GSVehicle.CloneVehicle(this._slotD.bp[0], v, true);
            if (!GSVehicle.IsValidVehicle(cv)) break;
            GSVehicle.StartStopVehicle(cv);
            // 克隆车也是这条线的车队（P1-3 归因）：不登记就是"引擎有 3 辆、
            // 注册表说 1 辆"（真机 2026-10-08 实测）。
            this._fleetOwned.append(cv);
        }
        this.RegisterRoute(this._job);
        this.Ph("bus_live");
        this._stage = "done";
    }

    /* 货运车（货运 F3）：在车库买一辆**能拉这个货**的公路车，改装，给
     * A → B → A 的订单，启动。
     *
     * 与客运的差别只有三处，其余同款（同样的建站/铺路/车库/订单/启动流程）：
     *   ① 车型按 `CanRefitCargo(engine, cargo)` 选（不是按客运货）；
     *   ② 装的车是**这个货**（不是乘客）；
     *   ③ 车队 2 辆而不是 3 辆：货车一车载重比客车大得多（真机：Balogh
     *      Coal Truck 载 20 吨），三辆会闲置（要加车随时可以 `set_route_vehicles`）。
     *
     * 订单用 `OF_NON_STOP_INTERMEDIATE` 与客运同款：公路车在站上**自动装卸**
     * （引擎按车站的待运货堆与车辆的载重处理），不需要显式的装卸订单。
     */
    function PhaseTruck() {
        local cargo = this._cargo;
        local engine = this.PickRoadEngine(cargo);
        if (engine < 0) {
            this.Ph("trk_noeng");
            this._stage = "done";
            return;
        }
        local depotTile = this._slotD.bp[0];
        local v = GSVehicle.BuildVehicle(depotTile, engine);
        if (!GSVehicle.IsValidVehicle(v)) {
            local es = GSError.GetLastErrorString();
            if (es == null) es = "" + GSError.GetLastError();
            if (es.len() > 14) es = es.slice(0, 14);
            this.Ph("trk_buy_e" + es);
            this._stage = "done";
            return;
        }
        this._fleetOwned.append(v);
        this.RegisterRoute(this._job);
        this._vehicle = v;
        GSVehicle.RefitVehicle(v, cargo);
        local stA = this._slotA.bp[0];
        local stB = this._slotB.bp[0];
        GSOrder.AppendOrder(v, stA, GSOrder.OF_NON_STOP_INTERMEDIATE);
        GSOrder.AppendOrder(v, stB, GSOrder.OF_NON_STOP_INTERMEDIATE);
        if (!GSVehicle.StartStopVehicle(v)) this.Ph("trk_start_e");
        for (local i = 1; i < 2; i++) {
            local cv = GSVehicle.CloneVehicle(this._slotD.bp[0], v, true);
            if (!GSVehicle.IsValidVehicle(cv)) break;
            GSVehicle.StartStopVehicle(cv);
            this._fleetOwned.append(cv);
        }
        this.RegisterRoute(this._job);
        this.Ph("trk_live");
        this._stage = "done";
    }

    /* Pick the fastest buildable road vehicle that can carry `cargo`.
     * Passenger routes use it with the passenger cargo, freight routes with the
     * freight cargo — the filter (`CanRefitCargo`) is what makes it cargo-aware. */
    function PickRoadEngine(cargo) {
        local el = GSEngineList(GSVehicle.VT_ROAD);
        el.Valuate(GSEngine.IsBuildable);          el.KeepValue(1);
        el.Valuate(GSEngine.GetRoadType);          el.KeepValue(GSRoad.ROADTYPE_ROAD);
        el.Valuate(GSEngine.CanRefitCargo, cargo); el.KeepValue(1);
        el.Valuate(GSEngine.GetMaxSpeed);
        el.Sort(GSList.SORT_BY_VALUE, false);
        if (el.IsEmpty()) return -1;
        return el.Begin();
    }

    /* Connect a bus stop tile to its front with a road stub (bidirectional),
     * unless already connected. */
    function ConnectStop(stop_tile, front_tile) {
        if (stop_tile == null || front_tile == null) return;
        if (GSRoad.AreRoadTilesConnected(front_tile, stop_tile)) return;
        GSRoad.SetCurrentRoadType(GSRoad.ROADTYPE_ROAD);
        local ok = GSRoad.BuildRoad(front_tile, stop_tile);
        if (!ok && GSError.GetLastError() == GSError.ERR_ALREADY_BUILT) ok = true;
        if (!ok) {
            ok = GSRoad.BuildRoad(stop_tile, front_tile);
            if (!ok && GSError.GetLastError() == GSError.ERR_ALREADY_BUILT) ok = true;
        }
        if (ok && this._builtRoad != null) this._builtRoad.append([front_tile, stop_tile]);
    }

    /* Run a fresh pathfinder with huge no_existing_road penalty: if it finds
     * a route it means the tiles we built form a connected road. */
    /* Locate the blueprint sign for station `label` ("A"/"B" -> sign slot
     * "S"/"E"). Returns [tile, front] or null. */


    /* One BuildRoadStation attempt on cleared land. Reports via SetPhase on
     * failure so we can see the engine error code from the admin port. */
    function TryPlaceStop(tile, front, freight = false) {
        GSTile.DemolishTile(tile);
        GSTile.DemolishTile(front);
        GSRoad.SetCurrentRoadType(GSRoad.ROADTYPE_ROAD); // precondition (pre-15 defaults vary)
        // 站型由**车型**决定（`script_road.cpp` 的 `_BuildRoadStationInternal`）：
        // `ROADVEHTYPE_TRUCK` ⇒ 货车停靠站（truck stop）。引擎规则：**货车只能停
        // 货车站，客车只能停公交站**（`station.cpp` 的 `GetPrimaryRoadStop`），
        // 而且**客车站不收货、货车站不收客**（`station_cmd.cpp` 的
        // `CanMoveGoodsToStation`）⇒ 货运必须是货车站。
        local vtype = freight ? GSRoad.ROADVEHTYPE_TRUCK : GSRoad.ROADVEHTYPE_BUS;
        local ok = GSRoad.BuildRoadStation(tile, front, vtype, GSStation.STATION_NEW);
        if (ok) {
            // Best-effort immediate connection; report-only on failure. The
            // real fix for sloped pairs is keeping the GS-chosen front
            // direction during the pax scan (BestPaxCandidate), which stays
            // on the same terrain as the anchor the GS validated.
            GSRoad.SetCurrentRoadType(GSRoad.ROADTYPE_ROAD);
            if (!GSRoad.AreRoadTilesConnected(front, tile)) {
                local c1 = GSRoad.BuildRoad(front, tile);
                if (!c1 && GSError.GetLastError() == GSError.ERR_ALREADY_BUILT) c1 = true;
                if (!c1) c1 = GSRoad.BuildRoad(tile, front);
                if (!c1 && GSError.GetLastError() == GSError.ERR_ALREADY_BUILT) c1 = true;
                if (!c1) this.Ph("st_slope_warn");
            }
            return true;
        }
        local es = GSError.GetLastErrorString();
        if (es == null) es = "" + GSError.GetLastError();
        if (es.len() > 14) es = es.slice(0, 14);
        this.Ph("st_place_e" + es);
        return false;
    }

    /* Scan a square ring of radius `radius` around `center` for an alternative
     * buildable [tile, front] pair. Shifts by multiples of 3 so repeated calls
     * walk outward. */
    function FindAltSite(center, _front, ring, _maxR) {
        local cx = GSMap.GetTileX(center);
        local cy = GSMap.GetTileY(center);
        local dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        local r = ring;
        for (local dx = -r; dx <= r; dx++) {
            for (local dy = -r; dy <= r; dy++) {
                if (dx != -r && dx != r && dy != -r && dy != r) continue;
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
        local cl = GSCargoList();
        foreach (c, _ in cl) {
            if (GSCargo.HasCargoClass(c, GSCargo.CC_PASSENGERS)) {
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
    /* 解析所有 `V:` 请求（**任意 job**，不只当前 job）。
     *
     * G3 时代这里只找"当前 job"的标牌，其他 job 一律回 `fleet_otherjob`。
     * 后果有实测（D20）：agent 在建 job 102 时给 job 101 调车队被拒，
     * **同一个请求重发 8 次**、车队始终不变 —— 它学到的因果是"请求车队没用"。
     * M3-2a 的 `_routes` 登记表已经能提供旧线路的车队，所以现在：
     * **认识的线路就应用，不认识的才拒绝**，且拒绝必须具名（SPEC §10.88）。 */
    function FleetRequests() {
        // GS-only：车队请求由 Dispatch 直接入队（V: 标牌已废）。
        local out = this._fleetReqs;
        this._fleetReqs = [];
        return out;
    }

    /* 一个 job 的车队目标状态：当前 job 用活字段，旧 job 用登记表。 */
    function FleetTarget(job) {
        if (job == this._job) {
            return { known = true, retired = false, vehicles = this._fleetOwned,
                     lead = this._vehicle,
                     depot = (this._slotD.bp == null ? -1 : this._slotD.bp[0]),
                     applied = this._fleetApplied,
                     stA = (this._slotA.bp == null ? -1 : this._slotA.bp[0]),
                     stB = (this._slotB.bp == null ? -1 : this._slotB.bp[0]),
                     cargo = this._routeCargo, engine = this._routeEngine };
        }
        if (this._routes.rawin(job)) {
            local r = this._routes[job];
            return { known = true, retired = (r.retired == true), vehicles = r.vehicles,
                     lead = r.lead, depot = r.depot,
                     applied = (r.rawin("applied") ? r.applied : -1),
                     stA = (r.rawin("stA") ? r.stA : -1), stB = (r.rawin("stB") ? r.stB : -1),
                     cargo = (r.rawin("cargo") ? r.cargo : -1),
                     engine = (r.rawin("engine") ? r.engine : -1) };
        }
        return { known = false, retired = false, vehicles = null, lead = -1, depot = -1, applied = -1 };
    }

    /* 把目标状态写回（当前 job 或登记表），保证下次读到同一份账。 */
    function SaveFleetTarget(job, vehicles, applied) {
        if (job == this._job) {
            this._fleetOwned = vehicles;
            this._fleetApplied = applied;
            return;
        }
        local r = this._routes[job];
        this._routes[job] <- {
            vehicles = vehicles,
            lead = r.lead,
            depot = r.depot,
            retired = (r.retired == true),
            applied = applied,
        };
    }

    function CheckAddVehicles() {
        local reqs = this.FleetRequests();
        foreach (req in reqs) {
            local job = req.job;
            local want = req.want;
            if (want < 1) continue; // "无请求"，不是"清零"
            local t = this.FleetTarget(job);
            if (!t.known) {
                this.Ph("fleet_unknown" + job);
                continue;
            }
            if (t.retired) {
                this.Ph("fleet_retired" + job);
                continue;
            }
            if (want == t.applied) continue; // 已满足（真正的"无事发生"）
            local cur = 0;
            foreach (vid in t.vehicles) {
                if (GSVehicle.IsValidVehicle(vid)) cur++;
            }
            // 推迟通报（事件通道，要粘住）：说出"我看到了、现在还不能做"。
            local waitKey = job + ":" + want;
            if (waitKey != this._fleetWaitAnnounced) {
                this._fleetWaitAnnounced = waitKey;
                this.Ph("fleet_wait" + want + "j" + job + "c" + cur + "L" + t.vehicles.len());
            }
            if (cur < want) {
                if (!GSVehicle.IsValidVehicle(t.lead)) {
                    this.Ph("fleet_noveh" + job);
                    continue;
                }
                if (t.depot < 0) {
                    this.Ph("fleet_nodepot" + job);
                    continue;
                }
                while (cur < want) {
                    local cv = GSVehicle.CloneVehicle(t.depot, t.lead, true);
                    if (!GSVehicle.IsValidVehicle(cv)) break;
                    GSVehicle.StartStopVehicle(cv);
                    t.vehicles.append(cv);
                    cur++;
                }
                this.SaveFleetTarget(job, t.vehicles, want);
                this.Ph("fleetg" + cur + "j" + job + "L" + t.vehicles.len() +
                                    "C" + this.CountOwnVehicles());
            } else if (cur > want) {
                local toSell = cur - want;
                local pending = [];
                local i = t.vehicles.len() - 1;
                while (i >= 0 && toSell > 0) {
                    local vid = t.vehicles[i];
                    i--;
                    if (!GSVehicle.IsValidVehicle(vid)) continue;
                    if (vid == t.lead) continue; // 头车永不卖：缩编不是退役
                    if (GSVehicle.SendVehicleToDepot(vid)) { pending.append(vid); toSell--; }
                }
                foreach (vid in pending) this._fleetSell.append(vid);
                this.SaveFleetTarget(job, t.vehicles, want);
                this.Ph("fleetsend" + pending.len() + "j" + job + "C" + this.CountOwnVehicles());
            } else {
                this.SaveFleetTarget(job, t.vehicles, want);
                this.Ph("fleetok" + want + "j" + job + "C" + this.CountOwnVehicles());
            }
        }
    }

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
            if (!GSVehicle.IsValidVehicle(vid)) { gone++; continue; }
            if (!GSVehicle.IsStoppedInDepot(vid)) { waiting.append(vid); continue; }
            if (GSVehicle.SellVehicle(vid)) sold++; else { blocked++; waiting.append(vid); }
        }
        this._fleetSell = waiting;
        if (this._fleetSell.len() == 0) {
            // 清掉已卖掉的条目（失效 id 会被计数忽略，但留着会让人误解车队规模）。
            // M3-2c：**每条线路的列表都要清**——旧线路的车现在也会被送去车库卖掉。
            local live = [];
            foreach (vid in this._fleetOwned) {
                if (GSVehicle.IsValidVehicle(vid)) live.append(vid);
            }
            this._fleetOwned = live;
            foreach (job, r in this._routes) {
                local live2 = [];
                foreach (vid in r.vehicles) {
                    if (GSVehicle.IsValidVehicle(vid)) live2.append(vid);
                }
                this._routes[job] <- {
                    vehicles = live2,
                    lead = r.lead,
                    depot = r.depot,
                    retired = (r.retired == true),
                    applied = (r.rawin("applied") ? r.applied : -1),
                };
            }
        }
        if (sold > 0 || gone > 0 || (blocked > 0 && this._fleetSell.len() == 0)) {
            this.Ph(
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
            // 两端的**门前格**（road tile）：车站本身占两块地 —— 标牌格与
            // 路旁格。**路旁格才是车停的地方**，也才是"路通不通"能查的格。
            // 只记标牌格 ⇒ "路不连通"这个诊断永远是假的（Issue #113）。
            endA = (this._slotA.bp == null ? null : this._slotA.bp[1]),
            endB = (this._slotB.bp == null ? null : this._slotB.bp[1]),
            retired = (prev != null && prev.retired == true),
            applied = this._fleetApplied,
            // 这条线**天生运的货**（货运 F3）：货运线路建起来就改装到该货种；
            // 客运线路运乘客（货种 id 0 = PASS）。与 `cargo`（set_route_cargo
            // 的**改装生效值**）是两件事：前者是这条线的性质，后者是后来的指令。
            lineCargo = (this._freight ? this._cargo : this._gs.PaxCargoId()),
        };
    }

    /* 执行器的**原始**状态（诊断用）：当前 job、两端的站址与门前格、
     * 登记表里有没有这条线。读不到读数时，这是"为什么读不到"的底牌。 */
    function RouteRawState(job) {
        // 变量名**别用 r**：D44 的静态守卫按名字收集表键 ⇒ 同名会让别处的
        // `r.amount = ...` 被误判成"这张表没有 amount 键"（守卫本身是哑的教训）。
        local raw = {};
        raw.rawset("job", this._job);
        raw.rawset("slotA", (this._slotA.bp == null ? null : this._slotA.bp[0]));
        raw.rawset("slotFrontA", (this._slotA.bp == null ? null : this._slotA.bp[1]));
        raw.rawset("slotB", (this._slotB.bp == null ? null : this._slotB.bp[0]));
        raw.rawset("slotFrontB", (this._slotB.bp == null ? null : this._slotB.bp[1]));
        raw.rawset("depot", (this._slotD.bp == null ? null : this._slotD.bp[0]));
        raw.rawset("hasRecord", this._routes.rawin(job));
        raw.rawset("recordEndA", (this._routes.rawin(job) && this._routes[job].rawin("endA") ? this._routes[job].endA : null));
        raw.rawset("recordEndB", (this._routes.rawin(job) && this._routes[job].rawin("endB") ? this._routes[job].endB : null));
        return raw;
    }

    /* 该线路两端的**门前格**（road tile）；没登记 = null。 */
    function RouteEndRoadTiles(job) {
        if (job == this._job) {
            return { a = (this._slotA.bp == null ? null : this._slotA.bp[1]),
                     b = (this._slotB.bp == null ? null : this._slotB.bp[1]) };
        }
        if (this._routes.rawin(job)) {
            // 变量名别用 `r`（D44 的静态守卫按名字收集表键 ⇒ 同名会误判别处）。
            local rec = this._routes[job];
            return { a = (rec.rawin("endA") ? rec.endA : null),
                     b = (rec.rawin("endB") ? rec.endB : null) };
        }
        return null;
    }

    /* 该线路的目标车队规模（set_route_vehicles 的生效值；未登记 = null）。 */
    function RouteApplied(job) {
        if (job == this._job) return this._fleetApplied;
        if (this._routes.rawin(job)) return this._routes.rawget(job).rawin("applied") ? this._routes[job].applied : null;
        return null;
    }

    /* 该线路**运的货**（货运 F3）：-1 = 不知道（不是"不运货"）。
     * BridgeV1 的 route-stats 从这里取（它自己的 `_routes` 只记端点瓦片）。 */
    function RouteLineCargo(job) {
        if (job == this._job) return (this._freight ? this._cargo : this._gs.PaxCargoId());
        if (this._routes.rawin(job)) {
            local c = this._routes[job].rawin("lineCargo") ? this._routes[job].lineCargo : -1;
            return (c == null ? -1 : c);
        }
        return -1;
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
            this.Ph("retire_unknown" + job);
            return;
        }
        local queued = 0;
        foreach (vid in list) {
            if (!GSVehicle.IsValidVehicle(vid)) continue;
            local already = false;
            foreach (q in this._fleetSell) if (q == vid) already = true;
            if (already) { queued++; continue; }
            if (GSVehicle.SendVehicleToDepot(vid)) {
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
        this.Ph("retire" + queued + "C" + this.CountOwnVehicles());
    }

    /* 货物 id 解析：数字直接用；字符串按**标签**匹配（GSCargo.GetCargoLabel，实测存在）。 */
    function ResolveCargo(cargo) {
        if (typeof cargo == "integer") return cargo;
        local label = "" + cargo;
        local cl = GSCargoList();
        foreach (c, _ in cl) {
            if (GSCargo.GetCargoLabel(c) == label) return c;
        }
        return -1;
    }

    /* 选货（P1-2）：把一条线的车队**改装**到指定货物。
     * 引擎前置（真机实测）：RefitVehicle 要求**车停在库里**（ERR_PRECONDITION 系），
     * 所以流程是「送库 → 到库改装 → 重启」，跨多个 tick（与卖车机器同构）。
     * 观测 = 引擎回执（RefitVehicle 返回值逐辆计数）+ 登记表只记**生效值**。 */
    function RefitRoute(job, cargo) {
        local t = this.FleetTarget(job);
        if (!t.known) { this.Report({ kind = "exec", job = job, stage = "refit", error = "refit_unknown" + job }); return; }
        if (t.retired) { this.Report({ kind = "exec", job = job, stage = "refit", error = "refit_retired" + job }); return; }
        local cid = this.ResolveCargo(cargo);
        if (cid < 0) { this.Report({ kind = "exec", job = job, stage = "refit", error = "refit_nocargo:" + cargo }); return; }
        local queued = 0; local blocked = 0; local live = 0;
        // 公司作用域：SendVehicleToDepot/RefitVehicle 都是公司动作（真机：在
        // Dispatch 上下文裸调返回 false，三辆车全记 blocked）。
        local cm = GSCompanyMode(job == this._job ? this._company : 0);
        if (!GSCompanyMode.IsValid()) {
            this.Report({ kind = "exec", job = job, stage = "refit", error = "refit_nocompany" });
            return;
        }
        foreach (vid in t.vehicles) {
            if (!GSVehicle.IsValidVehicle(vid)) continue;
            live++;
            // 已在库的车不用"送"——直接算进改装队列（真机：刚造的车就在库里，
            // SendVehicleToDepot 对它是 false，不计就永远改装不到）。
            if (GSVehicle.IsStoppedInDepot(vid)) { queued++; continue; }
            if (GSVehicle.SendVehicleToDepot(vid)) queued++; else blocked++;
        }
        if (live == 0) {
            this.Report({ kind = "exec", job = job, stage = "refit", error = "refit_nofleet" + job });
            return;
        }
        // 同线的新请求**顶替**旧请求（最新意图为准，与 FleetRequests 同语义）
        local kept = [];
        foreach (rq in this._fleetRefit) if (rq.job != job) kept.append(rq);
        this._fleetRefit = kept;
        this._fleetRefit.append({ job = job, cid = cid, rest = queued, ok = 0, bad = blocked });
        this.Report({ kind = "exec", job = job, stage = "refit",
                      note = "refitq" + queued + "c" + cid });
    }

    /* 送库 → 到库改装 → 重启：每 tick 推进（挂 Tick 的维护段，公司作用域内）。 */
    function ProcessFleetRefits() {
        if (this._fleetRefit.len() == 0) return;
        local pending = [];
        foreach (rq in this._fleetRefit) {
            local t = this.FleetTarget(rq.job);
            if (!t.known) {
                this.Report({ kind = "exec", job = rq.job, stage = "refit", error = "refit_gone" + rq.job });
                continue;
            }
            foreach (vid in t.vehicles) {
                if (!GSVehicle.IsValidVehicle(vid)) continue;
                if (!GSVehicle.IsStoppedInDepot(vid)) continue;
                if (GSVehicle.RefitVehicle(vid, rq.cid)) rq.ok++; else rq.bad++;
                GSVehicle.StartStopVehicle(vid);
                rq.rest--;
            }
            if (rq.rest > 0) { pending.append(rq); continue; }
            // 只记**生效值**（ok=0 时登记表保持原样：失败不是事实变更）
            if (rq.ok > 0) this.SaveRouteCargo(rq.job, rq.cid);
            this.Report({ kind = "exec", job = rq.job, stage = "refit",
                          note = "refit" + rq.ok + "f" + rq.bad + "c" + rq.cid });
        }
        this._fleetRefit = pending;
    }

    /* 把一条线的「改装到的货物」写进登记表（当前 job 用活字段，旧 job 用登记表）。 */
    function SaveRouteCargo(job, cid) {
        if (job == this._job) { this._routeCargo = cid; return; }
        local r = this._routes[job];
        this._routes[job] <- {
            vehicles = r.vehicles, lead = r.lead, depot = r.depot,
            retired = (r.retired == true),
            applied = (r.rawin("applied") ? r.applied : -1),
            stA = (r.rawin("stA") ? r.stA : -1), stB = (r.rawin("stB") ? r.stB : -1),
            cargo = cid, engine = (r.rawin("engine") ? r.engine : -1),
        };
    }

    /* 换车（P1-2）：把一条线的车队换成**指定车型**。
     * 做法：先买新（同数、同订单、同货物）再送走旧车卖掉——线路运力不断档。
     * 引擎前置：IsBuildable（已验证）。观测 = 新车 id 进登记表 + 具名相位。 */
    function ReengineRoute(job, engine) {
        local t = this.FleetTarget(job);
        if (!t.known) { this.Report({ kind = "exec", job = job, stage = "reeng", error = "reeng_unknown" + job }); return; }
        if (t.retired) { this.Report({ kind = "exec", job = job, stage = "reeng", error = "reeng_retired" + job }); return; }
        if (!GSEngine.IsBuildable(engine)) { this.Report({ kind = "exec", job = job, stage = "reeng", error = "reeng_nobuild:" + engine }); return; }
        if (t.depot < 0) { this.Report({ kind = "exec", job = job, stage = "reeng", error = "reeng_nodepot" + job }); return; }
        local want = 0;
        foreach (vid in t.vehicles) if (GSVehicle.IsValidVehicle(vid)) want++;
        if (want < 1) { this.Report({ kind = "exec", job = job, stage = "reeng", error = "reeng_nofleet" + job }); return; }
        local stA = (job == this._job) ? (this._slotA.bp == null ? -1 : this._slotA.bp[0])
                                       : (t.stA != null ? t.stA : -1);
        local stB = (job == this._job) ? (this._slotB.bp == null ? -1 : this._slotB.bp[0])
                                       : (t.stB != null ? t.stB : -1);
        if (stA < 0 || stB < 0) { this.Report({ kind = "exec", job = job, stage = "reeng", error = "reeng_nostations" + job }); return; }
        local cargo = (job == this._job) ? this._routeCargo : t.cargo;
        if (cargo == null) cargo = -1;
        local made = [];
        // 公司作用域：BuildVehicle/Refit 是公司动作——在 Dispatch 里裸调会报
        // ERR_PRECONDITION_INVALID_COMPANY（真机实测 2026-10-08）。
        local cm = GSCompanyMode(job == this._job ? this._company : 0);
        if (!GSCompanyMode.IsValid()) {
            this.Report({ kind = "exec", job = job, stage = "reeng", error = "reeng_nocompany" });
            return;
        }
        for (local i = 0; i < want; i++) {
            local nv = GSVehicle.BuildVehicle(t.depot, engine);
            if (!GSVehicle.IsValidVehicle(nv)) break;
            if (cargo >= 0) GSVehicle.RefitVehicle(nv, cargo);
            GSOrder.AppendOrder(nv, stA, GSOrder.OF_NON_STOP_INTERMEDIATE);
            GSOrder.AppendOrder(nv, stB, GSOrder.OF_NON_STOP_INTERMEDIATE);
            GSVehicle.StartStopVehicle(nv);
            made.append(nv);
        }
        if (made.len() == 0) {
            this.Report({ kind = "exec", job = job, stage = "reeng", error = "reeng_buyfail:" + GSError.GetLastErrorString() });
            return;
        }
        // 旧车送库卖掉（复用退役的送库→卖车机器）
        foreach (vid in t.vehicles) {
            if (!GSVehicle.IsValidVehicle(vid)) continue;
            if (GSVehicle.SendVehicleToDepot(vid)) this._fleetSell.append(vid);
        }
        if (job == this._job) {
            this._fleetOwned = made;
            this._vehicle = made[0];
            this._routeEngine = engine;
            this.RegisterRoute(job);
        } else {
            local r = this._routes[job];
            this._routes[job] <- {
                vehicles = made, lead = made[0], depot = t.depot, retired = false,
                applied = (r.rawin("applied") ? r.applied : -1),
                stA = stA, stB = stB,
                cargo = (r.rawin("cargo") ? r.cargo : -1), engine = engine,
            };
        }
        this.Report({ kind = "exec", job = job, stage = "reeng",
                      note = "reeng" + made.len() + "e" + engine + "j" + job });
    }

    /* 清掉某个 job 的 NUTZ 标牌（退役后必须清：否则会被重新捡起来重建）。 */


    /* 已登记的线路里有没有待处理的退役（X:1）请求。 */
    function CheckRetireRequests() {
        // GS-only：退役请求由 Dispatch 直接入队（X: 标牌已废）。
        local out = this._retireReqs;
        this._retireReqs = [];
        foreach (job in out) {
            if (job in this._retiredJobs) continue;
            this.RetireRoute(job);
        }
    }

    function CountOwnVehicles() {
        local n = 0;
        foreach (vid, _ in GSVehicleList()) n++;
        return n;
    }

    function DumpBus() {
        if (!GSVehicle.IsValidVehicle(this._vehicle)) return;
        local stA = this._slotA.bp == null ? -1 : this._slotA.bp[0];
        local stB = this._slotB.bp == null ? -1 : this._slotB.bp[0];
        local st = GSVehicle.GetState(this._vehicle);
        local ch = "?";
        if      (st == GSVehicle.VS_RUNNING)  ch = "R";
        else if (st == GSVehicle.VS_STOPPED)  ch = "S";
        else if (st == GSVehicle.VS_IN_DEPOT) ch = "D";
        else if (st == GSVehicle.VS_AT_STATION) ch = "@";
        else if (st == GSVehicle.VS_BROKEN)   ch = "B";
        else if (st == GSVehicle.VS_CRASHED)  ch = "X";
        local sp = GSVehicle.GetCurrentSpeed(this._vehicle);
        local loc = GSVehicle.GetLocation(this._vehicle);
        local dA = GSMap.DistanceManhattan(loc, stA);
        // On every 3rd dump, also report the bus tile coords + whether the
        // road continues from the bus tile toward station A (for stuck debug).
        if (this._dumpSeq % 3 == 0) {
            local lx = GSMap.GetTileX(loc) % 1000;
            local ly = GSMap.GetTileY(loc) % 1000;
            local rd = GSRoad.IsRoadTile(loc);
            local dep = GSRoad.IsRoadDepotTile(loc);
            local sta = GSRoad.IsRoadStationTile(loc);
            local obj = "?";
            if (dep) obj = "depot";
            else if (sta) obj = "station";
            else if (rd) obj = "road";
            else obj = "other";
            this.Ph("@" + lx + "," + ly + " " + obj + " d" + dA);
            this._dumpSeq++;
            return;
        }
        local pax = this.GetPaxCargoId();
        local sa = GSStation.GetStationID(stA);
        local wA = (pax >= 0 && GSStation.IsValidStation(sa))
            ? GSStation.GetCargoWaiting(sa, pax) : -1;
        this._dumpSeq++;
        // "R37 d6 a3 #4" - running 37, 6 tiles from A, 3 waiting at A.
        this.Ph(ch + sp + " d" + dA + " a" + wA + " #" + this._dumpSeq);
    }
}

class BridgeV1 extends GSController {
    _last_send = 0;
    _admin_seen = 0;
    _last_cmd = "";
    _sign_count = 0;
    _route_seq = 0;
    _freight_seq = 0;   // 货运 job 的独立计数（**不能**与客运 job 撞号：
                        // job 是台账/线路统计的主键，撞号会把两条线并成一条）
    _lastJob = -1;      // 最近一条线路的 job（客运或货运）——缩编/退役的缺省目标
    // Fingerprint of the last exec event we emitted. On-change emission
    // retires the heartbeat concept: "no event = no change". All semantics
    // mirror src/game/executor-status.ts decodeExecutorPhase (REFACTOR Phase A).
    _last_exec_key = "";
    // N2-1: routes this GS laid out (job -> tiles), so route economics can be
    // attributed exactly. Attribution is by station orders (GSVehicleList_Station
    // + GetOwner), NOT by guessing from positions.
    _routes = null;
    // 诊断：每辆车**上一次的位置**与**上一次移动的 tick** ⇒ "车多久没动了"可测
    // （周期读数看不见这件事 ⇒ MEMORY D121）。**字段必须和用它的方法在同一个类里**：
    // Squirrel 的类成员是固定的 ⇒ 在别的类里写 `this._x = ...` 会抛
    // "the index 'x' does not exist"（D44）。
    _lastVehTiles = null;
    _lastVehTick = null;
    _last_stats = 0;
    // AB-4a 探针状态（NEXT-4：GS 能否自己建完并**运营**一条线路）。
    // null = 未启动；表 = 进行中。生命周期是有意的一等状态：
    // plan → stationA → stationB → road → depot → engine → buy → orders → run。
    _pr = null;
    // P1/P2（2026-09-25）：产业/货种/公司口径的**缓存**。
    // 重活（扫全图产业 + 监视所有城镇/产业）每 1000 tick 一次；心跳照旧每 200 tick。
    // 用缓存而不是"按需才算"的原因：Squirrel 里**条件创建表键**是最容易出事的写法
    //（D44：未建的键会让整个 GS 静默不加载），所以载荷永远是同一个字面量形状。
    _facts = null;
    _facts_tick = 0;
    // 货运计量（F2，2026-11-08）：`GSCargoMonitor` 是**读一次清零**的增量口径
    // （`script_cargomonitor.hpp`：每次读返回"上次读之后的增量"并把累计清零），
    // 所以累计**必须由我们做**，否则每次读到的都是 0 ⇒ 等于没测。
    // 三个状态都用**数组**（Squirrel 的表不能动态建键，D44）：
    //   _own_totals = [{label, amount}]：每个被监视货种的会话累计；
    //   _own_pairs  = [{cargo, industry, label}]：当前在监视的目的地；
    //   _own_lost：计量缺口（丢掉的增量数，见 CollectFacts 的说明）；
    //   _own_err：最后一次读失败的错误全文（失败不许静默，D95）。
    _own_totals = null;
    _own_pairs = null;
    _own_lost = 0;
    _own_err = "";
    // 货运 F4（A3）：逐 **(货种, 产业)** 的会话累计。
    //   _own_by_industry = [{label, industry, amount}]：每次 monitor 读到增量时
    //   **按目的地产业分开记**（不合并到货种）⇒ 归因时才能知道"这批货送到了哪"。
    // 为什么必须多带这一层：GS 本来就**逐对去读**（`GetIndustryDeliveryAmount`
    //   循环），合并到货种就把"送到哪"这个信息**丢掉了** ⇒ 逐线路归因缺的不是
    //   算法，是这个读数（SPEC §10.126）。
    // 用**数组**不用动态键的表（Squirrel 的表是严格的，D44/D95）。
    _own_by_industry = null;
    // 施工方（executor）的公司 id。
    //
    // 为什么不能用 `GSCompany.COMPANY_SELF`：Bridge GS 是**服务器脚本**
    // （`[game_scripts]`），它**自己没有公司**；公司是 executor AI 建的，
    // executor 通过命令把公司 id 告诉它。于是 COMPANY_SELF 解析成无效公司 ⇒
    // cargo monitor 直接返回 -1（真机实测：38 个目的地全部 failed）。
    // 默认 0：沙盒里 executor 建的**第一家公司**（与 `GetQuarterlyCargoDelivered(0, 0)`
    // 同一个假设），命令到达后以命令里的为准。
    _exec_company = 0;
    _core = null;   // ExecCore（P1-1a：施工状态机，标牌邮箱已废）


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



/** Fingerprint = stage+job+hb+detail keys; values change => new event.
     *  We include only KEYS (not values) in the key, then compare the
     *  whole event by re-emitting only when stage/job/hb differ — details
     *  like `seq` and `signs` change every tick, so we don't want to spam
     *  the harness. On-change emission already happens at the consumer
     *  side (stage gate), so we only NEED to gate on stage/job/hb.
     */


    /**
     * Poll the executor company name and emit a typed event on change.
     * Called EVERY loop iteration (~20 ticks, ~0.6 s) so phase changes reach
     * the harness without the 200-tick summary latency. Heartbeat = "no event".
     */


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
                local vehIds = [];
                local vlist = [];
                // 车辆 id 一并上报（2026-09-25）：仪表盘要把**跨线路**的车队数去重。
                // 不去重就是拿 25 辆车报出 129 —— 一个车站服务多条线路时，站在站台上的
                // 同一辆车会被每条用到该站的线路各数一次（真机：17 条线路 / 9 个站，
                // 站点平均出现在 ~3.8 条线路上，25 × 5 ≈ 129，与实测一致）。
                if (GSStation.IsValidStation(sa)) {
                    foreach (v, _ in GSVehicleList_Station(sa)) {
                        if (GSVehicle.GetOwner(v) == exec) { vlist.append(v); vehIds.append(v); }
                    }
                }
                if (GSStation.IsValidStation(sb)) {
                    foreach (v, _ in GSVehicleList_Station(sb)) {
                        if (GSVehicle.GetOwner(v) == exec) { vlist.append(v); vehIds.append(v); }
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
                // 逐站上报等待量（而不是只报两端之和）：harness 要按**站点去重**求和，
                // 共享车站的等待量被重复计入是同一个双重计数错误（2026-09-25 真机：
                // 1 951 人 vs 公司实际在等的人数）。
                // 等待量按**这条线运的货**读：货运线路等的是煤/粮，不是乘客。
                // `lineCargo` 是这条线的性质（建起来就定的货种）；客运线路没有它 ⇒ 用乘客货。
                local lineCargo = -1;
                if (this._core != null) lineCargo = this._core.RouteLineCargo(job_str.tointeger());
                if (lineCargo == null || lineCargo < 0) {
                    lineCargo = rec.rawin("lineCargo") ? rec.lineCargo : -1;
                }
                local waitCargo = (lineCargo != null && lineCargo >= 0) ? lineCargo : pax;
                local waitA = -1;
                local waitB = -1;
                if (waitCargo >= 0) {
                    if (GSStation.IsValidStation(sa)) { waitA = GSStation.GetCargoWaiting(sa, waitCargo); waiting += waitA; }
                    if (GSStation.IsValidStation(sb)) { waitB = GSStation.GetCargoWaiting(sb, waitCargo); waiting += waitB; }
                }
                // 车队真值（执行器注册表，引擎 id）：与 vehiclesIds（站点归属）是
                // 两个事实。无核心/未登记 → 不带字段（未计量 ≠ 空车队，D60）。
                local fleetIds = null;
                local fleetApplied = null;
                if (this._core != null) {
                    fleetIds = this._core.RouteVehicles(job_str.tointeger());
                    fleetApplied = this._core.RouteApplied(job_str.tointeger());
                }
                local payload = {
                    kind = "route-stats",
                    job = job_str.tointeger(),
                    vehicles = vlist.len(),
                    vehiclesIds = vehIds,
                    endsA = sa,
                    endsB = sb,
                    waitA = waitA,
                    waitB = waitB,
                    profit = profit,
                    waiting = waiting,
                    gameDate = GSDate.GetCurrentDate(),
                };
                if (fleetIds != null) payload.rawset("fleetIds", fleetIds);
                if (fleetApplied != null) payload.rawset("fleetApplied", fleetApplied);
                // **这条线运的货**（F3 的看板要用）：客运线 = PASS，货运线 = 煤/粮/…
                // 与 `cargoApplied`（后来的改装指令的生效值）是两个事实。
                if (lineCargo != null && lineCargo >= 0) {
                    payload.rawset("cargoCarried", GSCargo.GetCargoLabel(lineCargo));
                }
                // 货运 F4（A3）：货运线的**两端产业 id**（产方 / 收方）。
                // 客运线没有（它的两端是城镇）⇒ 字段缺席 = 不适用，不是 0。
                // 有了它，harness 才能把"送到产业 X 的货"归到"唯一服务 X 的线"。
                if (rec.rawin("fromIndustry") && rec.rawin("toIndustry")) {
                    payload.rawset("fromIndustry", rec.fromIndustry);
                    payload.rawset("toIndustry", rec.toIndustry);
                }
                // P1-3：登记车辆中此刻**停在库里**的 id（IsStoppedInDepot 已验证）。
                // 有了它 harness 才能分解「在途/在库」；缺失保持字段缺席。
                if (fleetIds != null) {
                    local dep = [];
                    foreach (vid in fleetIds) {
                        if (GSVehicle.IsValidVehicle(vid) && GSVehicle.IsStoppedInDepot(vid)) dep.append(vid);
                    }
                    payload.rawset("fleetDepot", dep);
                }
                // P1-2 生效值：改装到的货物（标签，人可读）/车型（引擎 id）。
                // 缺失 = 未计量/未改装，字段缺席（D60）。
                if (this._core != null) {
                    local tgt = this._core.FleetTarget(job_str.tointeger());
                    if (tgt.known) {
                        if (tgt.cargo != null && tgt.cargo >= 0) {
                            payload.rawset("cargoApplied", GSCargo.GetCargoLabel(tgt.cargo));
                        } else if (lineCargo != null && lineCargo >= 0) {
                            // 货运线路：车**建起来时**就改装到该货种了（没有
                            // set_route_cargo 指令），所以生效值就是它天生的货。
                            payload.rawset("cargoApplied", GSCargo.GetCargoLabel(lineCargo));
                        }
                        if (tgt.engine != null && tgt.engine >= 0) {
                            payload.rawset("engineApplied", tgt.engine);
                        }
                    }
                }
                GSAdmin.Send(payload);
            }
        } catch (e) {
            GSAdmin.Send({ kind = "err", cmd = "route_stats", detail = { reason = "" + e } });
        }
    }

    /* ===================================================================
     * 线路诊断（**按需**）：一条线**为什么不跑**。
     *
     * 为什么必须有（Issue #113，2026-11-11 真机）：线建成了、车改装了、
     * 货在装货站等着、整局**交付 0**。周期读数只报"几辆车在等多少"⇒
     * **看不出车卡在哪、订单对不对** ⇒ 这种线是"静默死线"，模型只能瞎猜。
     *
     * 只读、只按需（周期载荷不变，SPEC §10.126）：诊断走 answer 通道。
     * 事实自己读，**不替模型下结论**：报的是"车在哪、订单是什么、货在等"。
     * =================================================================== */
    function RouteDiag(obj) {
        local ans_id = -1;
        if (obj.rawin("id")) ans_id = obj["id"];
        local job = obj.rawin("job") ? obj["job"] : -1;
        local routes = [];
        local errors = [];
        if (this._routes != null) {
            foreach (job_str, rec in this._routes) {
                local j = job_str.tointeger();
                if (job >= 0 && j != job) continue;
                // 一条线诊断失败**不许拖垮整份答案**：写下它自己的错误，其余照常
                // （不静默，也不因为一条坏线就说"没有路线"）。
                try {
                    routes.append(this.RouteDiagOne(j, rec));
                } catch (err) {
                    errors.append("job " + j + ": " + "" + err);
                }
            }
        }
        GSAdmin.Send({ kind = "answer", id = ans_id, ok = true, data = { routes = routes, errors = errors } });
    }

    /* 一条线的诊断事实。 */
    function RouteDiagOne(job, rec) {
        local out = {};
        out.rawset("job", job);
        local cargo = -1;
        if (this._core != null) cargo = this._core.RouteLineCargo(job);
        if (cargo == null || cargo < 0) {
            if (rec.rawin("lineCargo")) cargo = rec["lineCargo"];
        }
        local label = "";
        if (cargo != null && cargo >= 0) label = GSCargo.GetCargoLabel(cargo);
        out.rawset("cargo", label);
        local tA = rec.rawget("tA");
        local tB = rec.rawget("tB");
        // 门前格（road tile）：车**停**的地方，也是"路通不通"能查的格。
        local roadA = null;
        local roadB = null;
        if (this._core != null) {
            local rt = this._core.RouteEndRoadTiles(job);
            if (rt != null) {
                roadA = rt.a;
                roadB = rt.b;
            }
        }
        local stA = (tA == null ? -1 : this.StationNear(tA, 6));
        local stB = (tB == null ? -1 : this.StationNear(tB, 6));
        local ends = [];
        ends.append(this.RouteDiagEnd("load", tA, cargo, roadA, stB));
        ends.append(this.RouteDiagEnd("unload", tB, cargo, roadB, stA));
        out.rawset("ends", ends);
        // **"路通不通"这件事本 API 答不了**：`GSRoad.AreRoadTilesConnected` 只回答
        // "这两块**相邻**的格子连着吗"（引擎实现第一句就是 `DistanceManhattan != 1 ⇒ false`）
        // ⇒ 拿它问"两站之间通不通"永远得到 false ⇒ 那是**假读数**，比没有更坏。
        // ⇒ 只有相邻时才有意义，否则写 null（没测到）。
        out.rawset("roadConnected", this.RoadConnected(roadA, roadB));
        // 执行器那边的**原始**状态（站址/门前格/当前 job）：诊断自己的读数
        // 解释不了"为什么读不到"时，这就是底牌。
        if (this._core != null) {
            local raw = this._core.RouteRawState(job);
            if (raw != null) out.rawset("core", raw);
        }
        local fleet = [];
        if (this._core != null) {
            local ids = this._core.RouteVehicles(job);
            if (ids != null) {
                foreach (vid in ids) fleet.append(this.RouteDiagVehicle(vid, cargo));
            }
        }
        out.rawset("vehicles", fleet);
        return out;
    }

    /* 一端：登记瓦片、**真的在那儿的车站**、在等的货。
     *
     * 为什么"登记瓦片"与"真车站"分开报：站址可能因为建站失败而**换过**
     * （Issue #113 的真机：第一次建站 ERR_PRECONDITION ⇒ 换候选点）⇒
     * 登记的瓦片与真的车站**可能不是同一个** ⇒ 只报一个会把"线建在哪"说错。
     */
    function RouteDiagEnd(role, tile, cargo, roadTile, viaStation) {
        local e = {};
        e.rawset("role", role);
        e.rawset("tile", (tile == null ? -1 : tile));
        e.rawset("roadTile", (roadTile == null ? -1 : roadTile));
        local st = -1;
        if (tile != null && tile >= 0) st = this.StationNear(tile, 6);
        e.rawset("station", st);
        local waiting = -1;
        if (st != null && st >= 0 && GSStation.IsValidStation(st) && cargo != null && cargo >= 0) {
            waiting = GSStation.GetCargoWaiting(st, cargo);
        }
        e.rawset("waiting", waiting);
        // **经由另一端运走的货**（引擎的流向）：车在装货站只装"下一跳是它下一站"
        // 的货（`StationCargoList::Load` 按 next hop 取包）⇒ 这两个数对不上，
        // 就说明"货在等"与"这条线能运走它"是两件事。
        local waitingVia = -1;
        if (st != null && st >= 0 && GSStation.IsValidStation(st) && cargo != null && cargo >= 0 &&
            viaStation != null && viaStation >= 0 && GSStation.IsValidStation(viaStation)) {
            waitingVia = GSStation.GetCargoWaitingVia(st, viaStation, cargo);
        }
        e.rawset("waitingVia", waitingVia);
        // 引擎的货包按**下一跳**分类：这一端在等三种货 —— 经由另一端（这条线要的）、
        // 经由自己（回到自己）、**没有下一跳**（引擎兜底：谁路过谁都能装）。
        // 三个数一起看，才知道货**卡在哪一类**。
        local viaSelf = -1;
        local viaNone = -1;
        if (st != null && st >= 0 && GSStation.IsValidStation(st) && cargo != null && cargo >= 0) {
            viaSelf = GSStation.GetCargoWaitingVia(st, st, cargo);
            viaNone = GSStation.GetCargoWaitingVia(st, -1, cargo);
        }
        e.rawset("waitingViaSelf", viaSelf);
        e.rawset("waitingViaNone", viaNone);
        return e;
    }

    /* 两端之间**路是否连通**。
     *
     * ⚠️ 这个 API 只对**相邻**的两格有意义（引擎：`DistanceManhattan != 1 ⇒ false`）
     * ⇒ 两站之间隔着几十格时它**必然**返回 false ⇒ 那是假读数。
     * ⇒ 相邻时给引擎的答案，不相邻时写 null（**没测到**，不是"不通"）。
     */
    function RoadConnected(tA, tB) {
        if (tA == null || tB == null || tA < 0 || tB < 0) return null;
        if (GSMap.DistanceManhattan(tA, tB) != 1) return null;
        try { return GSRoad.AreRoadTilesConnected(tA, tB); } catch (err) { return null; }
    }

    /* 这辆车**动过吗**（与上一次诊断比位置）。
     *
     * 为什么要有："车卡住了"必须**可测**。周期读数只报"几辆车在等多少"，
     * 看不见车在不在动（MEMORY D121）。GS 自己记上一次的位置 ⇒ 纯事实。
     */
    function VehicleIdleTicks(vid) {
        // **两张表都要先初始化**：Squirrel 里 `null.rawin(...)` 直接抛异常 ⇒
        // 诊断命令会**整条失败**（模型看到"没有路线"，而不是"诊断不了"）。
        if (this._lastVehTiles == null) this._lastVehTiles = {};
        if (this._lastVehTick == null) this._lastVehTick = {};
        local tile = GSVehicle.GetLocation(vid);
        local now = GSController.GetTick();
        local prev = this._lastVehTiles.rawin(vid) ? this._lastVehTiles[vid] : null;
        local last = this._lastVehTick.rawin(vid) ? this._lastVehTick[vid] : null;
        // **必须用表的 rawset 方法**：`t[k] = v` 在键不存在时抛"the index 'k' does not
        // exist"（D44 的老教训）⇒ 动态键（车 id）只能用 `table.rawset(k, v)` 写
        // （Squirrel 里 rawset 是**方法**，没有同名全局函数 ⇒ 写成 rawset(t,k,v) 会炸）。
        if (prev == null) {
            // 第一次见这辆车：只记位置 ⇒ 这次**没测到**它多久没动（不是"0"）。
            this._lastVehTiles.rawset(vid, tile);
            this._lastVehTick.rawset(vid, now);
            return null;
        }
        if (prev != tile) {
            this._lastVehTiles.rawset(vid, tile);
            this._lastVehTick.rawset(vid, now);
            return 0;
        }
        return (last == null ? null : now - last);
    }

    /* 一辆车：状态、位置、订单、载量。
     *
     * 订单是**逐条**报的：订单**存在**不等于订单**去的是这条线的站**
     * （"有两条订单但都不是车站"这种死线，光看订单数看不出来）。
     */
    function RouteDiagVehicle(vid, cargo) {
        local v = {};
        v.rawset("id", vid);
        if (!GSVehicle.IsValidVehicle(vid)) {
            v.rawset("valid", false);
            return v;
        }
        v.rawset("valid", true);
        v.rawset("state", GSVehicle.GetState(vid));
        v.rawset("tile", GSVehicle.GetLocation(vid));
        // 速度：0 = 停着（装货中 / 卡住）⇒ 区分"在站上装货"与"停 elsewhere"。
        v.rawset("speed", GSVehicle.GetCurrentSpeed(vid));
        // "它多久没动了"（游戏 tick）：GS 记上一次的位置 ⇒ **车不动**是能测的，
        // 不能靠感觉（周期读数看不见这件事 ⇒ MEMORY D121）。
        v.rawset("idleTicks", this.VehicleIdleTicks(vid));
        local loaded = -1;
        local capacity = -1;
        local refitCapacity = -1;
        if (cargo != null && cargo >= 0) {
            loaded = GSVehicle.GetCargoLoad(vid, cargo);
            // **两个**容量是一对：
            //   capacity       = 车**此刻**的货种是这个时的载量（货种不对 ⇒ 0）
            //   refitCapacity  = 改成这个货种**能**有多少（引擎行不行）
            // capacity=0 而 refitCapacity>0 ⇒ **车没被改成这个货**（改装没生效）。
            capacity = GSVehicle.GetCapacity(vid, cargo);
            refitCapacity = GSVehicle.GetRefitCapacity(vid, cargo);
        }
        v.rawset("loaded", loaded);
        v.rawset("capacity", capacity);
        v.rawset("refitCapacity", refitCapacity);
        local orders = [];
        local oc = -1;
        try { oc = GSOrder.GetOrderCount(vid); } catch (err) { oc = -1; }
        v.rawset("orderCount", oc);
        if (oc > 0) {
            for (local i = 0; i < oc; i++) {
                local o = {};
                o.rawset("index", i);
                local dest = -1;
                local isStation = false;
                local flags = 0;
                try {
                    dest = GSOrder.GetOrderDestination(vid, i);
                    isStation = GSOrder.IsGotoStationOrder(vid, i);
                    flags = GSOrder.GetOrderFlags(vid, i);
                } catch (err2) { dest = -2; }
                o.rawset("tile", dest);
                o.rawset("isStation", isStation);
                o.rawset("flags", flags);
                orders.append(o);
            }
        }
        v.rawset("orders", orders);
        return v;
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

    /**
     * 采集产业/货种/公司口径事实（P1+P2）。
     *
     * 只发**原始计数**：比率（"利用率"）有两种口径 —— 产业口径（所有公司）与
     * 公司口径（`GSCargoMonitor`，本公司）。在 GS 里算比率就等于把口径藏进管道，
     * 所以派生放在前端（可单测）并显式标注口径。见 SPEC §10.99。
     *
     * 事实来源（已核对 GS API）：
     *   GSIndustry.GetLastMonthProduction / GetLastMonthTransported / GetStockpiledCargo
     *   GSIndustryList_CargoProducing（按货种过滤，避免 cargo × industry 全交叉）
     *   GSCargo.GetCargoLabel（标签稳定；本地化 GetName 不作玩家可见字符串）
     *   GSCargoMonitor.Get{Town,Industry}DeliveryAmount(company, cargo, id, keep_monitoring)
     *   GSCompany.GetQuarterlyCargoDelivered(company, 0)  // 0 = 当前经济季度
     */
    /**
     * 产业与货种的**全量扫描**（一次）。
     *
     * 为什么单独一个方法：周期快照（取样）与**按需全量**查询必须用**同一份**
     * 扫描 —— 两处各写一遍，两边的数字就会漂（而漂了没人知道）。
     *
     * 返回：
     *   industries —— 全部产业（id / 货种 / 名字 / 产量 / 运量 / 库存），按产量降序；
     *   catalog —— 货种目录（标签 / 是不是货运 / 谁产 / 谁收）；
     *   totals —— **有产量**的货种的合计（观测面用的那份）；
     *   readings —— **每一个**货种的读数（含 0 产量的：没测到 ≠ 0）；
     *   monitor —— 货运货种 × 收方产业（货运 F2 的监视集合）。
     */
    function ScanCargo() {
        local industry_list = [];
        local cargo_totals = [];
        local cargo_readings = [];
        // 货种目录（2026-11-03，货运 F1）：标签 + 是不是货运 + 谁产谁收。
        // 为什么单独一份：`cargo_totals` 只报**有产量的**货种，而"能不能用卡车运"
        // 是**货种本身的属性**（`GSCargo.IsFreight`）；"谁生产它 / 谁接受它"是引擎
        // 算得出的事实（`GSIndustryList_CargoProducing` / `_CargoAccepting`）——
        // 模型看不见它，就只能从"煤"两个字上猜哪座厂要煤（真机探针：矿场旁边的
        // 车站**不接受煤**，电站旁边的才接受 ⇒ 光有"哪里有煤"是没法修一条货运线的）。
        local cargo_catalog = [];
        // 货运计量（F2）的监视集合：货运货种 × 收方产业。在货种循环里顺手收集
        // （货种的数字下标只有那里有；目录里只留标签与名字，那是模型看得懂的部分）。
        local monitor_pairs = [];
        local monitor_cargoes = 0;

        // --- 产业侧（按货种遍历）---
        for (local c = 0; c < 64; c++) {
            if (!GSCargo.IsValidCargo(c)) continue;
            local label = GSCargo.GetCargoLabel(c);
            if (label == null) continue;
            local sum_prod = 0;
            local sum_trans = 0;
            local producers = [];
            local consumers = [];
            foreach (iid, _ in GSIndustryList_CargoProducing(c)) {
                producers.append(iid);
                local prod = GSIndustry.GetLastMonthProduction(iid, c);
                local trans = GSIndustry.GetLastMonthTransported(iid, c);
                // D60（2026-09-26）：缺失/负值 = 不适用，**不是 0**。这里曾折叠成 0 ——
                // 探针实测一个采样期 **548 个负读数**被这样报成「运了 0 吨」。
                // 键保持存在、值是 null（形状恒定，D44），harness 侧映射为 —。
                if (prod == null || prod < 0) prod = null;
                if (trans == null || trans < 0) trans = null;
                if (prod != null) sum_prod += prod;
                if (trans != null) sum_trans += trans;
                // 负值 = 该产业不接受此货 → **不适用**，不能当成"库存 0"。
                local stock = GSIndustry.GetStockpiledCargo(iid, c);
                if (stock != null && stock < 0) stock = null;
                local nm = GSIndustry.GetName(iid);
                if (nm == null) nm = "";
                if (nm.len() > 24) nm = nm.slice(0, 24);
                nm = this.Trim(nm);   // 截断会留下尾空格（真机实测 "…Coal "）
                industry_list.append({ id = iid, cargo = label, name = nm,
                                       produced = prod, transported = trans, stock = stock });
            }
            // 谁**接受**这个货（`GSIndustryList_CargoAccepting`）—— 引擎自己算的
            // 事实，与车站的收货判定同一套规则（`industry_cmd.cpp` 的
            // `AddAcceptedCargo_Industry` 看的是产业自己的 accepted 表）。
            foreach (cid, _ in GSIndustryList_CargoAccepting(c)) consumers.append(cid);
            local is_freight = GSCargo.IsFreight(c);
            cargo_catalog.append({ label = label, freight = is_freight,
                                   producers = producers, consumers = consumers });
            // 货运交付发生在**收方**产业 ⇒ 监视收方（不是产方）。
            if (is_freight) {
                monitor_cargoes++;
                foreach (cid in consumers) {
                    monitor_pairs.append({ cargo = c, industry = cid, label = label });
                }
            }
            // **每一个**货种的读数（含 0 产量的）：观测面的 `cargo_totals` 只报
            // 有产量的货种 ⇒ 模型分不清"这个货种没有产量"和"这个货种没测到"
            // （D60：缺失 ≠ 0）。按需全量查询给的是完整的一份。
            cargo_readings.append({ label = label, freight = is_freight,
                                    produced = sum_prod, transported = sum_trans });
            if (sum_prod > 0 || sum_trans > 0) {
                cargo_totals.append({ label = label, produced = sum_prod, transported = sum_trans });
            }
        }
        // 产量降序：null 产量排最后（null 不做算术，先归一再比）。
        industry_list.sort(function(ia, ib) {
            local pa = (ia.produced == null) ? -1 : ia.produced;
            local pb = (ib.produced == null) ? -1 : ib.produced;
            return pb - pa;
        });
        cargo_totals.sort(function(ca, cb) { return cb.produced - ca.produced; });

        return {
            industries = industry_list,
            catalog = cargo_catalog,
            totals = cargo_totals,
            readings = cargo_readings,
            monitor = monitor_pairs,
            monitor_cargoes = monitor_cargoes,
        };
    }

    // 车型目录（**按需**，Issue #105）：载量 / 价格 / 运行成本。
    //
    // 为什么单独一份：周期载荷不许变大（观测面的规矩）⇒ 周期里只带
    // id/name/speed/cargo，**经济学字段只在模型问的时候给**。
    //
    // API 依据（OpenTTD 15.3 源码，`script_engine.hpp`）：`GetCapacity` /
    // `GetPrice` / `GetRunningCost` / `GetMaxSpeed` 都是 `@api ai game` ⇒
    // 游戏脚本可调（真机探针已实测，见 SPEC §10.126）。
    function EngineCatalog() {
        local rows = [];
        try {
            local el = GSEngineList(GSVehicle.VT_ROAD);
            el.Valuate(GSEngine.IsBuildable);
            el.KeepValue(1);
            foreach (eid, _ in el) {
                // 车型带**它能拉什么货**（`GSEngine.GetCargoType`）："哪辆车拉煤"
                // 是引擎的属性，不是从名字里猜的。
                local ecargo = null;
                try {
                    local ct = GSEngine.GetCargoType(eid);
                    if (ct != null && GSCargo.IsValidCargo(ct)) {
                        local lb = GSCargo.GetCargoLabel(ct);
                        if (lb != null) ecargo = lb;
                    }
                } catch (e) { ecargo = null; }
                // 经济学三件套。读不到就报 null（**不编一个数**）。
                local cap = null;
                local price = null;
                local run = null;
                try { cap = GSEngine.GetCapacity(eid); } catch (e) { cap = null; }
                try { price = GSEngine.GetPrice(eid); } catch (e) { price = null; }
                try { run = GSEngine.GetRunningCost(eid); } catch (e) { run = null; }
                rows.append({ id = eid, name = GSEngine.GetName(eid),
                              speed = GSEngine.GetMaxSpeed(eid), cargo = ecargo,
                              capacity = cap, price = price, running_cost = run });
            }
        } catch (e) { rows = []; }
        return rows;
    }

    // 每单位货的运价（引擎自己的函数，Issue #105）。
    //
    // `GSCargo.GetCargoIncome(cargo, distance, days_in_transit)`（`script_cargo.hpp`）：
    // 这趟货运 `distance` 格、在途 `days` 天，引擎付多少钱（**每单位**）。
    // 距离是**曼哈顿格数**，且引擎按起点/终点的曼哈顿距离**封顶**
    // （`CargoPacket::GetDistance`）⇒ 直线距离就是最多能拿到的距离。
    // 时间因子随在途变长而下降（上限 255）⇒ 用**最快在途**算出来的是上界。
    function CargoIncome(cargo_label, distance, days) {
        if (cargo_label == null || cargo_label == "") return null;
        for (local c = 0; c < 64; c++) {
            if (!GSCargo.IsValidCargo(c)) continue;
            local lb = GSCargo.GetCargoLabel(c);
            if (lb == null || lb != cargo_label) continue;
            // **客运不算**：引擎的客运付费不是 `GetTransportedGoodsIncome`
            // （源码：那个函数只用于货物）⇒ 拿它当客运收入就是编一个数。
            if (!GSCargo.IsFreight(c)) return null;
            return GSCargo.GetCargoIncome(c, distance, days);
        }
        return null;
    }

    function CollectFacts() {
        local all_industries = GSIndustryList();
        // 产业位置与名字（**全部**产业）：模型要选线路就得知道"在哪儿"。
        // 以前只有产量前 12 的产业有名字，而且**一个坐标都没有**。
        local industry_index = [];

        // 扫描（产业 / 货种 / 货运监视集合）——与按需全量查询共用 `ScanCargo()`。
        local scan = this.ScanCargo();
        local industry_list = scan.industries;
        local cargo_totals = scan.totals;
        local cargo_catalog = scan.catalog;
        local monitor_pairs = scan.monitor;
        local monitor_cargoes = scan.monitor_cargoes;

        // 产量降序**已经**在扫描里排好；这里只做**上限**：不能把全图产业塞进
        // 每个载荷（全量留给按需查询）。
        if (industry_list.len() > 12) industry_list.resize(12);

        // 货运可运链路（货运 F3）：**能装货的产方**。
        // 车站收什么货是引擎按集货区算的 ⇒ "这里有煤"不等于"这里能装煤"
        // （真机探针：矿场旁的站不收煤）。模型看不见这件事就会反复提出
        // 根本装不上货的线路 ⇒ 这条事实是引擎算出来的，必须进观测面。
        local freight_links = this.FreightLinks();

        // 产业位置与名字（全部）：货运线路要选"哪座矿 → 哪座厂"，没坐标就选不了。
        foreach (iid, _ in all_industries) {
            local loc = GSIndustry.GetLocation(iid);
            local nm = GSIndustry.GetName(iid);
            if (nm == null) nm = "";
            if (nm.len() > 24) nm = nm.slice(0, 24);
            nm = this.Trim(nm);
            industry_index.append({ id = iid, name = nm,
                                    x = GSMap.GetTileX(loc), y = GSMap.GetTileY(loc) });
        }

        // --- 公司口径（货运 F2）：`GSCargoMonitor` 的**单轴**累计 ---
        //
        // 三个决定，都写在 `docs/FREIGHT-LINE-FEASIBILITY.md` 里：
        // ① **单轴**：城镇轴与产业轴会把**同一笔交付**记两次 ⇒ 只取**产业交付**
        //    （交付发生在卸货站，计入该站集货区里的收方产业）。
        // ② **累计**：monitor 每次读会清零，所以读到的增量要**自己加起来**。
        // ③ **只监视货运**：乘客不进产业轴（乘客送到城镇），所以产业轴天生是货运口径。
        //
        // 旧注释（2026-11-01）说"脚本 API 没有 cargo monitor"——**那是错的**：
        // API 存在（`script_cargomonitor.hpp` 带 `@api game`），当初空的原因是
        // 我们自己的累加器往 Squirrel 的严格表里写动态键，抛异常把整个
        // CollectFacts 打断了（MEMORY D94 / D95）。
        local own_by_cargo = [];
        local own_by_industry = [];
        local own_monitored = { cargoes = 0, destinations = 0 };
        local own_gaps = { dropped = this._own_lost, error = this._own_err };

        // 监视集合 = 每个**货运**货种 × 它的**收方**产业（在上面的货种循环里
        // 顺手收集：那里才有货种的数字下标）。收方才是交付发生的地方 ⇒ 监视收方。
        local pairs = monitor_pairs;
        local cargo_count = monitor_cargoes;

        // 上次的监视集合里有、这次没有的目的地 ⇒ 它未结算的增量**拿不回来了**
        // （产业没了 ⇒ monitor 读不出来）⇒ 记成缺口，累计值是**下界**。
        if (this._own_pairs != null) {
            foreach (old in this._own_pairs) {
                local still = false;
                foreach (p in pairs) {
                    if (p.cargo == old.cargo && p.industry == old.industry) { still = true; break; }
                }
                if (!still) this._own_lost++;
            }
        }

        // 累计：每个被监视的货种先建一条 0 的记录（0 是**真实测量值**：监视了，
        // 没收到交付），读到的增量再加上去。
        local totals = this._own_totals;
        if (totals == null) totals = [];
        foreach (cinfo in cargo_catalog) {
            if (!cinfo.freight) continue;
            local seen = false;
            foreach (t in totals) {
                if (t.label == cinfo.label) { seen = true; break; }
            }
            if (!seen) totals.append({ label = cinfo.label, amount = 0 });
        }
        // 逐 (货种, 产业) 的累计（货运 F4 / A3）：**不合并到货种** ⇒ 归因时知道
        // "送到哪"。同样用数组（表不能动态建键，D44/D95）。
        local by_industry = this._own_by_industry;
        if (by_industry == null) by_industry = [];

        // 公司还没建出来（executor 还没开工）⇒ **监视无从谈起**：monitor 是按
        // (公司, 货种, 产业) 三元组记的，公司不存在就没有增量 ⇒ 这既不是失败，
        // 也没有丢东西 ⇒ 不许计数（真机实测：早于公司存在的那一轮读全是 -1，
        // 把它算成"缺口"会让页面说"累计是下界"，而其实什么都没丢）。
        local comp = GSCompany.ResolveCompanyID(this._exec_company);
        if (comp != GSCompany.COMPANY_INVALID) {
            foreach (p in pairs) {
                local amt = -1;
                try {
                    amt = GSCargoMonitor.GetIndustryDeliveryAmount(
                        this._exec_company, p.cargo, p.industry, true);
                } catch (e) {
                    // 不静默（D95）：记住错误全文，随缺口一起报出去。
                    amt = -1;
                    this._own_err = "" + e;
                }
                if (amt == null || amt < 0) {
                    // -1 = 这个目的地读不出来了（产业没了）⇒ 它未结算的增量**拿不回来**
                    // ⇒ 累计值是**下界**（这才是真正的缺口）。
                    this._own_lost++;
                    if (this._own_err == "") {
                        this._own_err = "GetIndustryDeliveryAmount returned -1 (destination out of bounds)";
                    }
                    continue;
                }
                if (amt == 0) continue;
                foreach (t in totals) {
                    if (t.label == p.label) { t.amount = t.amount + amt; break; }
                }
                // 逐 (货种, 产业) 累加（F4/A3）：先找同一条，找不到就**新建一条**
                // （数组，不是动态键的表）。
                local found = false;
                foreach (r in by_industry) {
                    if (r.label == p.label && r.industry == p.industry) {
                        r.amount = r.amount + amt;
                        found = true;
                        break;
                    }
                }
                if (!found) by_industry.append({ label = p.label, industry = p.industry, amount = amt });
            }
        }

        this._own_totals = totals;
        this._own_pairs = pairs;
        this._own_by_industry = by_industry;
        foreach (t in totals) own_by_cargo.append({ label = t.label, amount = t.amount });
        // 逐 (货种, 产业) 的累计：模型看得见（"运到哪"是事实），harness 拿它归因。
        local own_by_industry = [];
        foreach (r in by_industry) {
            if (r.amount == 0) continue;   // 0 是"监视了但没交付"，不占一行
            own_by_industry.append({ label = r.label, industry = r.industry, amount = r.amount });
        }
        own_monitored = { cargoes = cargo_count, destinations = pairs.len() };
        own_gaps = { dropped = this._own_lost, error = this._own_err };

        // 游戏口径的季度总量（全货种，精确）—— 用来和上面的 monitor 累计交叉核对。
        local quarter = null;
        try { quarter = GSCompany.GetQuarterlyCargoDelivered(0, 0); } catch (e) { quarter = null; }

        return {
            industries = all_industries.Count(),
            industry_list = industry_list,
            industry_index = industry_index,
            cargo_catalog = cargo_catalog,
            cargo_totals = cargo_totals,
            // 货运可运链路（货运 F3）：哪些产方真的装得上货。
            freight_links = freight_links,
            own_delivered = own_by_cargo,
            own_by_industry = own_by_industry,
            own_quarter = quarter,
            own_monitored = own_monitored,
            own_gaps = own_gaps,
        };
    }

    /* ExecCore 的唯一上报出口（类型化 exec 事件；错误全文）。 */
    function ReportExec(ev) {
        try { GSAdmin.Send(ev); } catch (e) {}
    }

    function Start() {
        if (this._core == null) this._core = ExecCore(this, 0);
        while (true) {
            this.HandleEvents();
            if (this._core != null) this._core.Tick();
            this.ProcessProbeRoute();
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
                    local loc = GSTown.GetLocation(tid);
                    // 城镇**名字**（2026-09-25 真机验证：`GSTown.GetName` 存在且返回
                    // 真实名字，如 "New Badworth"）。之前载荷只有 id/pop/x/y，于是线路
                    // 端点只能显示 `#4 → #8` —— 那是给机器看的编号，给人看不出是哪两座城。
                    //
                    // **全图都报**（2026-11-02，Issue #13）：以前只报人口前 10，于是
                    // 样本外的城镇对模型只剩一个编号（`#14 → #2`）—— 它连那座城叫什么
                    // 都不知道，怎么选？地图约 26 座城，名字一次 API 调用即可拿到
                    // （每 1000 tick 重算一次，见下）。
                    local nm = "";
                    try { nm = this.Trim("" + GSTown.GetName(tid)); } catch (e) { nm = ""; }
                    if (nm.len() > 24) nm = nm.slice(0, 24);
                    towns.push({ id = tid, pop = pop, name = nm,
                                 x = GSMap.GetTileX(loc), y = GSMap.GetTileY(loc) });
                }
                local now = GSController.GetTick();
                // 事实每 1000 tick 重算一次（心跳仍每 200 tick）：扫全图产业 +
                // 监视所有城镇/产业是重活，不能挂在每个心跳上。
                //
                // **第一次心跳就算**（2026-10-30 真机证伪）：原来等 `tick > 1000`
                // 才第一次算，于是开局的前 1000 tick 里事实是空的——而那正是
                // **模型第一轮观测**的窗口（它因此建了客运线，见 SPEC §10.124）。
                // `_facts_tick == 0` 是"还没算过"（Squirrel 没有 null 判断，用
                // 计数器当标志；首次成功后会置为 now，之后每 1000 tick 一次）。
                // 失败时 `_facts = null` 且 `_facts_tick = now` ⇒ 1000 tick 后重试，
                // 不会每次心跳都扫。
                if (this._facts_tick == 0 || this._facts_tick + 1000 < now) {
                    this._facts_tick = now;
                    try { this._facts = this.CollectFacts(); }
                    catch (e) { this._facts = null; }
                }
                local f = this._facts;
                // P1-2 动作面：可选车型目录（agent 要能看见选项才可能学选择）。
                // 只用实测存在的 API：GSEngineList(VT_ROAD)/IsBuildable/GetName/GetMaxSpeed。
                // 周期载荷**只带 id/name/speed/cargo**（经济学字段按需给，见
                // `EngineCatalog()` 与 Issue #105：载荷不许变大）。
                local engines = [];
                local catalog = this.EngineCatalog();
                // 变量名不要用 `e`（`catch (e)` 在同一个函数里也用它 ⇒ 静态守卫会判成
                // "先用后声明"；这是 Squirrel 的作用域规则，不是风格问题）。
                foreach (eng in catalog) {
                    engines.append({ id = eng.id, name = eng.name, speed = eng.speed, cargo = eng.cargo });
                }
                // **贷款上限**（2026-11-02，Issue #13）：模型看得见自己的 `loan`，却看不见
                // "还能借多少"；而**利息率脚本 API 根本没有**（引擎不暴露 ⇒ 那是"没测到"，
                // 不能猜）。上限只能在**公司模式**里读（`COMPANY_SELF` 在全局脚本里无效），
                // 所以这里短暂进入一次公司模式；读不到就报 null（不编造）。
                local loan_ceiling = null;
                local loan_interval = null;
                try { loan_interval = GSCompany.GetLoanInterval(); } catch (e) { loan_interval = null; }
                try {
                    // 公司 0 = 执行器自己的公司（`ExecCore(this, 0)` 用的是同一个 id）。
                    local mc = GSCompanyMode(0);
                    if (GSCompanyMode.IsValid()) {
                        loan_ceiling = GSCompany.GetMaxLoanAmount();
                    }
                } catch (e) { loan_ceiling = null; }
                GSAdmin.Send({
                    cmd = "state", tick = now,
                    loan_ceiling = loan_ceiling,
                    loan_interval = loan_interval,
                    // **观测策略**（2026-11-02，Issue #13）：模型看到的是世界的**哪一部分**
                    // —— 全部城镇，还是人口前 10？这不是"世界的读数"，是**观测面本身的
                    // 事实**：两次运行的策略不同 ⇒ 它们回答的不是同一个问题（哪怕结构
                    // 一模一样）。所以策略必须**由 GS 自己报**（它才知道自己取了多少），
                    // 不能由外面猜。
                    towns_policy = "all",
                    industries_policy = "top12",
                    engines = engines,
                    date = GSDate.GetCurrentDate(),
                    towns = tlist.Count(),
                    town_list = towns,
                    admin_seen = this._admin_seen,
                    last_cmd = this._last_cmd,
                    signs = sc,
                    sign_names = names,
                    // 形状恒定（不用条件建键）：没有事实时发 null/空表，
                    // harness 只在字段存在时更新世界状态。
                    industries = (f == null) ? null : f.industries,
                    industry_list = (f == null) ? [] : f.industry_list,
                    industry_index = (f == null) ? [] : f.industry_index,
                    cargo_catalog = (f == null) ? [] : f.cargo_catalog,
                    cargo_totals = (f == null) ? [] : f.cargo_totals,
                    freight_links = (f == null) ? [] : f.freight_links,
                    own_delivered = (f == null) ? [] : f.own_delivered,
                    // 逐 (货种, 产业)：归因的原料（A3）。形状恒定 ⇒ 字段一直在。
                    own_by_industry = (f == null) ? [] : f.own_by_industry,
                    own_quarter = (f == null) ? null : f.own_quarter,
                    own_monitored = (f == null) ? null : f.own_monitored,
                    own_gaps = (f == null) ? null : f.own_gaps,
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
            if (t == GSEvent.ET_VEHICLE_LOST) {
                // 推送事件（Issue #13 S7d）：车没了。引擎推给 GameScript 的事件队列
                // 原本被**整个丢掉**（只有 admin 端口事件被处理）⇒ 模型永远看不到
                // "我的车被报废了"。这里把引擎的事件类型映射到**封闭词表**。
                try {
                    local v = GSEventVehicleLost.Convert(ev);
                    this.ReportGameEvent({ event = "vehicle_lost", vehicle = v.GetVehicleID(),
                                           station = null, industry = null, town = null });
                } catch (e) {}
            } else if (t == GSEvent.ET_STATION_FIRST_VEHICLE) {
                try {
                    local s = GSEventStationFirstVehicle.Convert(ev);
                    this.ReportGameEvent({ event = "station_first_vehicle",
                                           station = s.GetStationID(), vehicle = s.GetVehicleID(),
                                           industry = null, town = null });
                } catch (e) {}
            } else if (t == GSEvent.ET_VEHICLE_WAITING_IN_DEPOT) {
                try {
                    local d = GSEventVehicleWaitingInDepot.Convert(ev);
                    this.ReportGameEvent({ event = "vehicle_waiting_in_depot",
                                           vehicle = d.GetVehicleID(), station = d.GetStationID(),
                                           industry = null, town = null });
                } catch (e) {}
            } else if (t == GSEvent.ET_VEHICLE_UNPROFITABLE) {
                try {
                    local u = GSEventVehicleUnprofitable.Convert(ev);
                    this.ReportGameEvent({ event = "vehicle_unprofitable", vehicle = u.GetVehicleID(),
                                           station = null, industry = null, town = null });
                } catch (e) {}
            } else if (t == GSEvent.ET_INDUSTRY_OPEN) {
                try {
                    local io = GSEventIndustryOpen.Convert(ev);
                    this.ReportGameEvent({ event = "industry_open", industry = io.GetIndustryID(),
                                           vehicle = null, station = null, town = null });
                } catch (e) {}
            } else if (t == GSEvent.ET_INDUSTRY_CLOSE) {
                try {
                    local ic = GSEventIndustryClose.Convert(ev);
                    this.ReportGameEvent({ event = "industry_close", industry = ic.GetIndustryID(),
                                           vehicle = null, station = null, town = null });
                } catch (e) {}
            } else if (t == GSEvent.ET_TOWN_FOUNDED) {
                try {
                    local tf = GSEventTownFounded.Convert(ev);
                    this.ReportGameEvent({ event = "town_founded", town = tf.GetTownID(),
                                           vehicle = null, station = null, industry = null });
                } catch (e) {}
            } else if (t == GSEvent.ET_ADMIN_PORT) {
                local ap = GSEventAdminPort.Convert(ev);
                local obj = ap.GetObject();
                this._admin_seen++;
                if (obj != null && obj.rawin("cmd")) {
                    this._last_cmd = "" + obj["cmd"];
                    try {
                this.Dispatch(obj);
            } catch (e) {
                // 护栏：一条命令的异常不许杀死整个 GS（否则世界事实也随之断流）。
                try { this.ReportExec({ kind = "exec", stage = "dispatch_error", error = "" + e }); } catch (e2) {}
            }
                } else {
                    GSAdmin.Send({ kind = "err", cmd = "admin_port",
                                   reason = "no cmd key",
                                   got = (obj == null ? "null" : typeof obj) });
                }
            }
        }
    }

    /* 推送事件的上报出口（Issue #13 S7d）。
     *
     * 形状恒定（D44）：键永远在，缺的就是 null —— 页面与模型看到的形状不会因为
     * 事件类型而变。异常不许杀死 GS（一条坏事件不该带走整条通道）。 */
    function ReportGameEvent(ev) {
        try {
            // **形状恒定**（D44）：四个键永远在，缺的就是 null。
            // `rawin` 是"这个键存在吗"——Squirrel 里**读不存在的键会抛**
            // （`the index 'x' does not exist`），所以先问再读。
            GSAdmin.Send({
                kind = "game_event",
                event = ev.event,
                vehicle = (ev.rawin("vehicle") && ev.vehicle != null) ? ev.vehicle : null,
                station = (ev.rawin("station") && ev.station != null) ? ev.station : null,
                industry = (ev.rawin("industry") && ev.industry != null) ? ev.industry : null,
                town = (ev.rawin("town") && ev.town != null) ? ev.town : null,
            });
        } catch (e) {
            // 不许静默：一条推事件丢了，模型就少知道一件事（走 err 通道）。
            try { GSAdmin.Send({ kind = "err", cmd = "game_event", reason = "" + e }); } catch (e2) {}
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
        // executor 的公司 id（货运计量要用：GS 是服务器脚本，没有自己的公司）。
        if (obj.rawin("company")) {
            local c = obj["company"];
            if (c != null && c >= 0) this._exec_company = c;
        }
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
        } else if (cmd == "inspect_vehicle") {
            // L2 查询（Issue #13）：**问一个具体的问题并把答案带回去**。
            // 与动作命令不同，这里必须回答案 —— 模型问的是"我这辆车在干什么"，
            // 没有答案它只能猜。
            local id = -1;
            if (obj.rawin("vehicle")) id = obj["vehicle"];
            local ans_id = -1;
            if (obj.rawin("id")) ans_id = obj["id"];
            if (!GSVehicle.IsValidVehicle(id)) {
                GSAdmin.Send({ kind = "answer", id = ans_id, ok = false,
                               reason = "no such vehicle", vehicle = id });
                return;
            }
            local data = {
                vehicle = id,
                name = GSVehicle.GetName(id),
                location = GSVehicle.GetLocation(id),
                type = GSVehicle.GetVehicleType(id),
                engine = GSVehicle.GetEngineType(id),
                age_days = GSVehicle.GetAge(id),
                speed = GSVehicle.GetCurrentSpeed(id),
                profit_this_year = GSVehicle.GetProfitThisYear(id),
                // 载客量（货种 0 = 客运；15.3 的脚本 API **没有**车辆当前站的读数 ⇒
                // 不编一个"它在哪一站"，只报它**在哪块地**）。
                cargo = GSVehicle.GetCargoLoad(id, 0),
            };
            GSAdmin.Send({ kind = "answer", id = ans_id, ok = true, data = data });
        } else if (cmd == "inspect_town") {
            local id = -1;
            if (obj.rawin("town")) id = obj["town"];
            local ans_id = -1;
            if (obj.rawin("id")) ans_id = obj["id"];
            if (!GSTown.IsValidTown(id)) {
                GSAdmin.Send({ kind = "answer", id = ans_id, ok = false,
                               reason = "no such town", town = id });
                return;
            }
            local data = {
                town = id,
                name = GSTown.GetName(id),
                population = GSTown.GetPopulation(id),
                houses = GSTown.GetHouseCount(id),
                location = GSTown.GetLocation(id),
                growth_rate = GSTown.GetGrowthRate(id),
            };
            GSAdmin.Send({ kind = "answer", id = ans_id, ok = true, data = data });
        } else if (cmd == "list_industries") {
            // 按需**全量**产业（"数据按需全量"）：观测面只带产量前 12 个
            // （载荷不能无限长），模型想要全图时**问一次**。
            // 全量与取样**同一个扫描**（`ScanCargo()`）⇒ 两边不会漂。
            local ans_id = -1;
            if (obj.rawin("id")) ans_id = obj["id"];
            local scan = this.ScanCargo();
            GSAdmin.Send({ kind = "answer", id = ans_id, ok = true,
                           data = { industries = scan.industries,
                                    total = scan.industries.len() } });
        } else if (cmd == "route_economics") {
            // 线路经济（Issue #105）：**按需**读引擎的事实 + 引擎自己的运价函数。
            //
            // 为什么不在周期载荷里：观测面的载荷不许变大（`EngineCatalog()` 的
            // 经济学字段只在这里给）⇒ 稳态流量不变（SPEC §10.126）。
            local ans_id = -1;
            if (obj.rawin("id")) ans_id = obj["id"];
            local income = null;
            local cargo_label = "";
            if (obj.rawin("cargo") && obj.rawin("distance")) {
                cargo_label = obj["cargo"];
                local dist = obj["distance"];
                // 最快在途（1 天）⇒ 引擎的**时间因子取上限** ⇒ 每单位运价是上界。
                local days = obj.rawin("days") ? obj["days"] : 1;
                try { income = this.CargoIncome(cargo_label, dist, days); }
                catch (e) { income = null; }
            }
            GSAdmin.Send({ kind = "answer", id = ans_id, ok = true,
                           data = { income_per_unit = income,
                                    cargo = cargo_label,
                                    engines = this.EngineCatalog() } });
        } else if (cmd == "list_cargo") {
            // 按需**全量**货种读数：含**没有产量**的货种（观测面的 `cargo_totals`
            // 只报有产量的 ⇒ 分不清"没有产量"与"没测到"，D60）。
            local ans_id = -1;
            if (obj.rawin("id")) ans_id = obj["id"];
            local scan = this.ScanCargo();
            GSAdmin.Send({ kind = "answer", id = ans_id, ok = true,
                           data = { readings = scan.readings,
                                    total = scan.readings.len() } });
        } else if (cmd == "route_diag") {
            // 线路诊断（Issue #113）：**按需**问一条线为什么不跑。
            // 只读、只按需 ⇒ 周期载荷不变。
            this.RouteDiag(obj);
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
        } else if (cmd == "build_freight_route") {
            this.BuildFreightRoute(obj);
        } else if (cmd == "set_route_cargo") {
            if (this._core == null) {
                GSAdmin.Send({ kind = "err", cmd = "set_route_cargo", reason = "executor core not ready" });
            } else {
                this._core.RefitRoute("job" in obj ? obj.job : -1, "cargo" in obj ? obj.cargo : -1);
            }
        } else if (cmd == "set_route_engine") {
            if (this._core == null) {
                GSAdmin.Send({ kind = "err", cmd = "set_route_engine", reason = "executor core not ready" });
            } else {
                this._core.ReengineRoute("job" in obj ? obj.job : -1, "engine" in obj ? obj.engine : -1);
            }
        } else if (cmd == "add_vehicles") {
            this.AddVehicles(obj);
        } else if (cmd == "retire_route") {
            this.RetireRoute(obj);
        } else if (cmd == "blueprint") {
            // 邮箱已废（P1-1a）：标牌中继被 ExecCore 直调取代。明确拒绝而不是假装成功。
            GSAdmin.Send({ kind = "err", cmd = "blueprint",
                           reason = "sign mailbox retired (P1-1); use build_bus_route" });
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
        this._lastJob = job;
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
        // S4: depot site midway（尽力而为；core 的 PhaseDepot 也能自建）。
        local siteD = this.FindDepotSite(tA, tB);
        // P1-1a：施工状态机在 GS 里（ExecCore）。标牌邮箱已废——直接入队。
        // N2-1：记下端点 tile（站 id -> 站上的车，精确归因用）。
        if (this._routes == null) this._routes = {};
        local rec = {};
        rec.rawset("tA", tA);
        rec.rawset("tB", tB);
        this._routes.rawset(job_str, rec);
        if (siteD != null) this._core.Enqueue(exec, job, tA, fA, tB, fB, -1);
        else this._core.Enqueue(exec, job, tA, fA, tB, fB, -1);
        GSAdmin.Send({ kind = "ack", cmd = "build_bus_route", job = job,
                       townA = townA, townB = townB, popA = GSTown.GetPopulation(townA),
                       popB = GSTown.GetPopulation(townB),
                       tileA = tA, frontA = fA, tileB = tB, frontB = fB,
                       depot = (siteD == null ? -1 : siteD[0]),
                       company = exec, queued = 1 });
    }

    /* ===================================================================
     * 货运（F3）：站址解析、可运链路、建线。
     *
     * 分工（`docs/FREIGHT-LINE-FEASIBILITY.md` §3.2）：**模型决定运什么货、运去哪**；
     * 脚手架负责**怎么落地**（找站址 ⇒ 铺路 ⇒ 建车库 ⇒ 买车改装 ⇒ 挂路线）。
     * 站址规则是**引擎规则**，不是策略：
     *   - 车站收什么货由引擎按**集货区**算（`station_cmd.cpp` 的
     *     `GetAcceptanceAroundStation`）⇒ 矿场旁的车站**不收煤**（真机探针）；
     *   - 产业把货交给**集货区覆盖到它**的车站（`industry_cmd.cpp` 的
     *     `MoveGoodsToStation`）；
     *   - 交付发生在**卸货站**，且计入该站集货区里的收方产业（`economy.cpp` 的
     *     `DeliverGoodsToIndustry`）。
     * ⇒ 装货站必须**同时罩住产方与收方**，卸货站必须罩住收方。
     * =================================================================== */

    /* 货车停靠站的集货半径（`CA_UNMODIFIED = 4`；开了 modified_catchment 才是 3）。 */
    function FreightRadius() {
        local r = GSStation.GetCoverageRadius(GSStation.STATION_TRUCK_STOP);
        if (r <= 0) r = 4;
        return r;
    }

    /* 站址扫描：返回第 `idx` 个可用站址 `[tile, front]`，没有就 null。
     *
     * 规则（引擎口径，**两边的条件不同**）：
     *   - 站址可建、不在水上，且有一个可建的**门前格**（路要接在它旁边）；
     *   - **装货站**（needAcceptance = false）：只要**罩住产方**就行。
     *     为什么收货不是装货的前提：产业把货交给车站看的是**车站的 rating**
     *     （`station_cmd.cpp` 的 `CanMoveGoodsToStation` ⇒ `rating == 0` 才拒收），
     *     而新车站的 rating 是 175（`INITIAL_STATION_RATING`）⇒ **车站收不收这个货
     *     不影响产业交货**。真机 2026-11-08 证伪了旧结论："矿场旁的站不收煤 ⇒
     *     煤运不走" —— 不成立：货会到站上等着，车装走即可。
     *   - **卸货站**（needAcceptance = true）：必须**收货 >= 8**
     *     （`GSTile.GetCargoAcceptance` 与引擎同一套算法）—— 车在**不收货**的站
     *     是卸不下来的（`economy.cpp` 的 `LoadCargo`/`UnloadCargo`："The station does
     *     not accept our goods anymore" ⇒ 货被退回而不是交付）。收方产业自己就收货
     *     ⇒ 罩住收方即可（实测 8/16/24/96）。
     *
     * 扫描半径 = 集货半径 ⇒ 站址**一定**罩住锚点产业（集货区是方形扩张，
     * `station.cpp` 的 `GetCatchment`），所以"产方/收方在不在集货区"不用猜。
     */
    function FreightSite(anchor, cargo, needAcceptance, idx) {
        if (anchor == null || !GSMap.IsValidTile(anchor)) return null;
        local r = this.FreightRadius();
        local cx = GSMap.GetTileX(anchor);
        local cy = GSMap.GetTileY(anchor);
        local dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        local found = 0;
        for (local ring = 0; ring <= r; ring++) {
            for (local dx = -ring; dx <= ring; dx++) {
                for (local dy = -ring; dy <= ring; dy++) {
                    if (ring > 0 && dx != -ring && dx != ring && dy != -ring && dy != ring) continue;
                    local x = cx + dx; local y = cy + dy;
                    if (x < 0 || y < 0) continue;
                    if (x >= GSMap.GetMapSizeX() || y >= GSMap.GetMapSizeY()) continue;
                    local tile = GSMap.GetTileIndex(x, y);
                    if (GSTile.IsWaterTile(tile)) continue;
                    if (!GSTile.IsBuildable(tile)) continue;
                    if (needAcceptance) {
                        local acc = GSTile.GetCargoAcceptance(tile, cargo, 1, 1, r);
                        if (acc == null || acc < 8) continue;
                    }
                    local front = -1;
                    foreach (d in dirs) {
                        local fx = x + d[0]; local fy = y + d[1];
                        if (fx < 0 || fy < 0) continue;
                        if (fx >= GSMap.GetMapSizeX() || fy >= GSMap.GetMapSizeY()) continue;
                        local ft = GSMap.GetTileIndex(fx, fy);
                        if (GSTile.IsWaterTile(ft)) continue;
                        if (!GSTile.IsBuildable(ft)) continue;
                        front = ft;
                        break;
                    }
                    if (front < 0) continue;
                    if (found == idx) return [tile, front];
                    found++;
                }
            }
        }
        return null;
    }

    /* 货运**可运链路**：哪些产方真的能装货（货运 F3）。
     *
     * 为什么模型需要它：车站收什么货是**引擎按集货区算**的，模型看不见这件事，
     * 就会反复提出根本装不上货的线路（真机探针：矿场旁的站不收煤 ⇒ "把煤从矿场
     * 运走"这条线在那张图上根本不存在）。这条事实是**引擎算出来的**，不是策略。
     *
     * 形状：{cargo = 货种标签, producer = 产方产业 id}。
     * 收方不在这里：收方由模型从 `cargoCatalog.consumers` 里选（引擎保证"卸货站
     * 罩住收方"就能交付），把可达性写成"只有这几个收方"会是**假限制**。
     */
    function FreightLinks() {
        local links = [];
        for (local c = 0; c < 64; c++) {
            if (!GSCargo.IsValidCargo(c)) continue;
            if (!GSCargo.IsFreight(c)) continue;
            local label = GSCargo.GetCargoLabel(c);
            if (label == null) continue;
            foreach (iid, _ in GSIndustryList_CargoProducing(c)) {
                local loc = GSIndustry.GetLocation(iid);
                if (loc == null || !GSMap.IsValidTile(loc)) continue;
                // 装货站址必须存在：产方附近要有**可建的地**（收货不是装货的前提，
                // 见 FreightSite 的注释：产业按车站 rating 交货）。
                if (this.FreightSite(loc, c, false, 0) == null) continue;
                links.append({ cargo = label, producer = iid });
            }
        }
        return links;
    }

    /* 货运建线（货运 F3）：模型给"货 + 产方 + 收方"，脚手架落地。
     *
     * 校验全是**引擎事实**（不是策略）：货种是货运、产方产这个货、收方收这个货、
     * 装货站址存在、卸货站址存在。任何一条不满足 ⇒ 明确拒绝并说清原因
     * （不静默、不假装成功）。
     */
    function BuildFreightRoute(obj) {
        if (!obj.rawin("company")) {
            GSAdmin.Send({ kind = "err", cmd = "build_freight_route", reason = "no company" });
            return;
        }
        local exec = obj["company"];
        local cargo = -1;
        // ResolveCargo 住在 ExecCore 里（它管"选货"那条命令），这里走同一个实现，
        // 不抄第二份（抄一份就会漂）。
        if (obj.rawin("cargo")) cargo = this._core.ResolveCargo(obj["cargo"]);
        if (cargo < 0) {
            GSAdmin.Send({ kind = "err", cmd = "build_freight_route", reason = "unknown cargo" });
            return;
        }
        if (!GSCargo.IsFreight(cargo)) {
            GSAdmin.Send({ kind = "err", cmd = "build_freight_route", reason = "cargo is not freight" });
            return;
        }
        local producer = -1;
        local consumer = -1;
        if (obj.rawin("from_industry")) producer = obj["from_industry"];
        if (obj.rawin("to_industry")) consumer = obj["to_industry"];
        if (!GSIndustry.IsValidIndustry(producer)) {
            GSAdmin.Send({ kind = "err", cmd = "build_freight_route", reason = "unknown producer industry" });
            return;
        }
        if (!GSIndustry.IsValidIndustry(consumer)) {
            GSAdmin.Send({ kind = "err", cmd = "build_freight_route", reason = "unknown consumer industry" });
            return;
        }
        // 产/收关系用引擎自己的清单（与货种目录同源），不用猜。
        local produces = false;
        foreach (iid, _ in GSIndustryList_CargoProducing(cargo)) {
            if (iid == producer) { produces = true; break; }
        }
        if (!produces) {
            GSAdmin.Send({ kind = "err", cmd = "build_freight_route",
                           reason = "industry " + producer + " does not produce " + GSCargo.GetCargoLabel(cargo) });
            return;
        }
        local accepts = false;
        foreach (cid, _ in GSIndustryList_CargoAccepting(cargo)) {
            if (cid == consumer) { accepts = true; break; }
        }
        if (!accepts) {
            GSAdmin.Send({ kind = "err", cmd = "build_freight_route",
                           reason = "industry " + consumer + " does not accept " + GSCargo.GetCargoLabel(cargo) });
            return;
        }
        local indA = GSIndustry.GetLocation(producer);
        local indB = GSIndustry.GetLocation(consumer);
        // 装货站址：只要**罩住产方**且有可建的地（产业按 rating 交货 ⇒ 不要求收货）。
        local siteA = this.FreightSite(indA, cargo, false, 0);
        if (siteA == null) {
            GSAdmin.Send({ kind = "err", cmd = "build_freight_route",
                           reason = "no loading site: no buildable ground near industry " + producer });
            return;
        }
        // 卸货站址：罩住收方**且收货 >= 8**（否则车卸不下来 ⇒ 不算交付）。
        local siteB = this.FreightSite(indB, cargo, true, 0);
        if (siteB == null) {
            GSAdmin.Send({ kind = "err", cmd = "build_freight_route",
                           reason = "no unloading site that accepts " + GSCargo.GetCargoLabel(cargo) +
                                    " near industry " + consumer });
            return;
        }
        local job = obj.rawin("job") ? obj["job"] : (1000 + this._freight_seq);
        this._freight_seq++;
        local job_str = "" + job;
        this._lastJob = job;
        // 站址由 ExecCore 按引擎规则扫（同一套 `FreightSite`）：GS 这里只做
        // **可行性预检**，建站时再扫一次是为了换一个建得成的站址。
        this._core.Enqueue(exec, job, -1, -1, -1, -1, -1, cargo, indA, indB);
        // 登记端点瓦片：**没有它，这条线就不会出现在 route-stats 里**（看板的线路表
        // 与决策上下文的线路事实都读那个事件）⇒ 货运线会"建成了却看不见"。
        if (this._routes == null) this._routes = {};
        local frec = {};
        frec.rawset("tA", siteA[0]);
        frec.rawset("tB", siteB[0]);
        // 货运 F4（A3）：这条线的**两端产业 id**（产方 / 收方）。
        // 为什么必须报上来：GS 的 cargo monitor 只知道"本公司往某个产业送了
        // 多少"，它**不知道是哪条线送的** ⇒ 要归因就得知道"哪些线服务这个
        // 产业" ⇒ 线路登记表必须带着它的两个产业 id（否则 harness 只能猜）。
        frec.rawset("fromIndustry", producer);
        frec.rawset("toIndustry", consumer);
        this._routes.rawset(job_str, frec);
        GSAdmin.Send({ kind = "ack", cmd = "build_freight_route", job = job,
                       cargo = GSCargo.GetCargoLabel(cargo),
                       producer = producer, consumer = consumer,
                       tileA = siteA[0], tileB = siteB[0], company = exec, queued = 1 });
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
    /* 找中心附近可放东西的空瓦片（通用 helper；demo 路径在用）。 */
    function FindFreeTileNear(center, radius) {
        local cx = GSMap.GetTileX(center);
        local cy = GSMap.GetTileY(center);
        for (local r = 0; r <= radius; r++) {
            for (local dy = -r; dy <= r; dy++) {
                for (local dx = -r; dx <= r; dx++) {
                    if (dx != r && dx != -r && dy != r && dy != -r) continue;
                    local x = cx + dx; local y = cy + dy;
                    if (x < 1 || y < 1) continue;
                    if (x >= GSMap.GetMapSizeX() - 1 || y >= GSMap.GetMapSizeY() - 1) continue;
                    local t = GSMap.GetTileIndex(x, y);
                    if (GSTile.IsBuildable(t)) return t;
                }
            }
        }
        return -1;
    }

    /* 退役一条线路（M3-2a）：放 `X:1` 标牌，执行器卖掉该线路全部车辆。
     * 与 add_vehicles 一样，ack 只说"请求已送达信箱"，不谎报结果。 */
    function RetireRoute(obj) {
        if (!obj.rawin("company")) {
            GSAdmin.Send({ kind = "err", cmd = "retire_route", reason = "no company" });
            return;
        }
        local exec = obj["company"];
        // 缺省目标 = **最近一条线路**（客运或货运）：旧代码写死客运计数，
        // 于是建完货运线再缩编会去缩编一条客运线（甚至不存在）。
        local job = obj.rawin("job") ? obj["job"] : this._lastJob;
        if (job == null || job < 0) {
            GSAdmin.Send({ kind = "err", cmd = "retire_route", reason = "no route to retire" });
            return;
        }
        // P1-1a：退役请求直入 ExecCore（X: 标牌已废）。
        this._core.RetireRequest(job);
        GSAdmin.Send({ kind = "ack", cmd = "retire_route", job = job, company = exec,
                       queued = 1,
                       note = "retirement requested; the core sells the route's vehicles "
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
        // 缺省目标 = 最近一条线路（客运或货运），见 RetireRoute 的注释。
        local job = obj.rawin("job") ? obj["job"] : this._lastJob;
        if (job == null || job < 0) {
            GSAdmin.Send({ kind = "err", cmd = "add_vehicles", reason = "no route to scale" });
            return;
        }
        // P1-1a：车队请求直入 ExecCore（V: 标牌已废）。
        this._core.FleetRequest(job, count);
        GSAdmin.Send({ kind = "ack", cmd = "add_vehicles", job = job,
                       count = count, company = exec, queued = 1,
                       note = "request queued; the core applies fleet changes, "
                            + "and only once the route has a lead vehicle" });
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

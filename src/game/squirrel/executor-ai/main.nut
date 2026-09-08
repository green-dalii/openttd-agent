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
    _stage = "boot";   // boot -> buildA -> buildB -> done (linear, S2/S3 grow here)
    _slotA = { label = "A", bp = null, tried = 0 };
    _slotB = { label = "B", bp = null, tried = 0 };
    _lastBeat = -1;
    _reportDone = false;

    function Start() {
        AILog.Info("ExecutorV1 starting");
        AICompany.SetPresidentName("Agent Bot");
        this.SetPhase("boot");
        while (true) {
            this.Tick();
            this.Sleep(30);
        }
    }

    /* One loop iteration of the build state machine. */
    function Tick() {
        try {
            this.TickInner();
        } catch (e) {
            local es = "" + e;
            if (es.len() > 16) es = es.slice(0, 16);
            this.SetPhase("exc:" + es);
        }
        // Heartbeat: prove the loop is alive every ~30 loops (~900 ticks).
        if (this._job >= 0 && AIController.GetTick() - this._lastBeat > 600) {
            this._lastBeat = AIController.GetTick();
            this.SetPhase("beat " + this._stage);
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
        } else if (this._stage == "done" && !this._reportDone) {
            this._reportDone = true;
            // Count our own road stations (ground-truth that we built stops).
            local stl = AIStationList(AIStation.STATION_BUS_STOP);
            local n = 0;
            foreach (sid, _ in stl) n++;
            this.SetPhase("done stN" + n);
        }
        // stage "done": all S2 construction finished; loop idle (S3 extends).
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
    function TryBuildStation(slot) {
        if (slot.bp == null) {
            local found = this.FindSign(slot.label);
            if (found == null) {
                this.SetPhase("st" + slot.label + "_wait");
                return;
            }
            slot.bp = found;
        }
        local tile = slot.bp[0];
        local front = slot.bp[1];
        if (this.TryPlaceStop(tile, front)) {
            this.SetPhase("st" + slot.label + "_ok");
            if (slot.label == "A") { this._stage = "buildB"; }
            else { this._stage = "done"; }
            return;
        }
        // Fallback: scan outward for another buildable pair (bounded).
        if (slot.tried > 24) {
            this.SetPhase("st" + slot.label + "_giveup");
            return;
        }
        local alt = this.FindAltSite(tile, front, 1 + (slot.tried % 6), 4);
        slot.tried++;
        if (alt != null) slot.bp = alt;
        else this.SetPhase("st" + slot.label + "_retry");
    }

    /* Locate the blueprint sign for station `label` ("A"/"B" -> sign slot
     * "S"/"E"). Returns [tile, front] or null. */
    function FindSign(label) {
        local slot = (label == "A") ? "S" : "E";
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
        if (!ok) {
            local es = AIError.GetLastErrorString();
            if (es == null) es = "" + AIError.GetLastError();
            if (es.len() > 14) es = es.slice(0, 14);
            this.SetPhase("st_place_e" + es);
        }
        return ok;
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
}

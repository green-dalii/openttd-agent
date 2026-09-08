/**
 * ExecutorV1 — v0.2 agent executor (sign-mailbox consumer).
 *
 * 职责: 作为 agent 公司的施工替身。轮询 GS 以公司模式放的 `NUTZ:bp:<job>:`
 *   标牌; 收到后借贷融资并 SetPhase 汇报 (macOS dedicated 丢 AILog → 公司名
 *   编码, SPEC §10.10)。v0.2 骨架: 接收 job + 融资 + phase=work 汇报;
 *   真实施工在后续迭代。
 * 事实来源: SPEC §10.10-4/§10.12/§10.13 (标牌可见性需 GSCompanyMode; Squirrel
 *   字符串语义: s[i]=integer, 单引号=integer, 须双引号+find/slice+tointeger)。
 * 部署: sandbox ai/ExecutorV1/。
 */

class ExecutorV1 extends AIController {
    _phase = "boot";
    _job = -1;

    function Start() {
        AILog.Info("ExecutorV1 starting");
        AICompany.SetPresidentName("Agent Bot");
        this.SetPhase("boot");

        while (true) {
            this.LookForBlueprint();
            this.Sleep(30);
        }
    }

    /* SetPhase: 公司名编码汇报; ≤31 字符 (OpenTTD 公司名上限). */
    function SetPhase(p) {
        local nm = "EX " + p + " j" + this._job;
        if (nm.len() > 31) nm = nm.slice(0, 31);
        AICompany.SetName(nm);
        this._phase = p;
    }

    /* 扫描 GS 放的 NUTZ:bp:<job>: 标牌 (arena 语法); 命中后借贷 + phase=work. */
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
            this.SetPhase("work");
            AILog.Info("ExecutorV1 picked bp job " + job);
            break;
        }
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

/**
 * ExecutorV1 —— 公司外壳（P1-1a，2026-10-08）。
 *
 * 背景：施工状态机已整体搬进 Bridge GS（`bridge-gs/main.nut` 的 `ExecCore`，
 * 设计见 docs/EXECUTOR-ARCHITECTURE.md「阶段二」）。反馈走类型化事件（错误全文），
 * 标牌邮箱与公司名 31 字符通道随之退役。
 *
 * 本脚本只剩一件事：**作为公司存在**。OpenTTD 的公司由客户端/AI 创建，
 * 没有"GS 创建公司"的 API；GS 用 `GSCompanyMode(<本公司>)` 以它的身份施工
 * （阶段一真机实测：施工花费从公司账上扣）。
 *
 * 职责: 创建公司、设定公司名、保持存活。
 * 禁止: 任何施工/订单/车队/标牌动作（那是 ExecCore 的职责）；禁止新的上报通道。
 */

class ExecutorV1 extends AIController {
    function Start() {
        AICompany.SetName("Agent Bot");
        // 必须活着：脚本退出 = 公司被 OpenTTD 回收，GS 就没有施工主体了。
        while (true) AIController.Sleep(100);
    }
}

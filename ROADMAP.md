# ROADMAP — OpenTTD LLM Agent Framework

> 渐进式开发计划。从 v0.0.1（脚手架 + MVP）开始，每版都保持「可运行 + 测试绿 + 门禁过」。
> 原则：**先打通最小闭环，再进化；任何版本不得以破坏测试/门禁为代价堆功能。**

---

## 版本规划

### v0.0.1 — 脚手架 + MVP（当前）
**目标**: 可运行的 TypeScript 工程骨架 + 首个**可验证的最小闭环**，证明「外部进程↔OpenTTD Admin Port」双向通道真实可用，并且 LLM agent 能跑起来。

**交付物**
1. **工程脚手架**（TDD 先行）
   - `package.json` / `tsconfig.json` / vitest / eslint 基线
   - 门禁脚本 `pnpm run gate`（typecheck + lint + test 一键绿）
   - AGENTS.md 开发规范落地
2. **MVP 代码**（纯 TS，零外部游戏依赖，可单测）
   - `admin-protocol.ts`: Admin Port **包编解码**（完整枚举 + frame 读写 + 解析器）
   - `admin-client.ts`: TCP 连接/认证(明文 v0.1)/订阅/poll/rcon/GS 通道 + 断线重连
   - `config.ts`: 配置 schema（二进制路径/data-dir/端口/seed/模型）
   - `process-manager.ts`: 起停 OpenTTD dedicated（隔离 data dir, `-D -G seed`）
   - `observer.ts`: admin 事件 → 规范化 `GameEvent`（date/company/economy/stats）
   - `blueprint.ts`: 高层动作 → GS 蓝图 JSON 编解码（纯函数, 复用 arena 语法）
   - `types.ts`: 共享事件/类型（单一事实源）
   - CLI: `run.ts` — `spawn` → `join` → `poll` → `rcon pause/save` → 打印状态快照 → 退出
3. **测试**
   - unit: codec 往返、frame 边界、payload 解析（用 arena 抓到的真实字节样张）
   - integration(smoke, 标记 `@live` 可选): 真机起 OpenTTD → join → rcon
4. **文档**: README（快速开始）、CHANGELOG（v0.0.1）

**验收门禁**
- [ ] `pnpm run gate` 全绿（typecheck + lint + test）
- [ ] unit 覆盖 codec/config/blueprint/event 规范化
- [ ] CLI `--dry-run`（不起真机）可用
- [ ] `@live` smoke 在用户机器可跑（含真 OpenTTD）
- [ ] README/CHANGELOG 完成

**里程碑映射**: M0（环境钉死）的部分 —— admin auth/进程/协议打通的前半段。

---

### v0.1.0 — 观测闭环（M1）
**目标**: Runner 长驻，实时接收 admin+GS 状态 → 规范事件 → Web 仪表盘可看现金/年份/公司。

- `GameEnvAdapter`（admin 原生 + GS rich state 合并）
- WebServer（HTTP + WS 扇出）
- 原生 HTML/Canvas 仪表盘 v1（现金/年份/公司价值曲线 + 事件流）
- GS `PushState` 模板 v1（bridge-gs Squirrel 骨架 + 部署脚本）
- 验收: 浏览器 live 看到曲线；`@live` integration 绿

### v0.2.0 — 最小决策闭环（M2）
**目标**: LLM 真正「玩」第一步 —— 观察→决策→施工→盈利回灌。

- Executor AI（Squirrel 施工 v0.1: bus route）
- Bridge GS 蓝图消费 → GSSign → executor
- Pi Agent Core 装配（tool: `observe/build_bus_route/add_vehicles/pause`）+ 自定义 AgentMessage
- `transformContext` 记忆注入 v1
- 验收: 一局 1950 地图跑通第一条盈利公交线；LLM 决策全量落审计

### v0.3.0 — 进化闭环（M3）
**目标**: 多局对比实验 + lessons 蒸馏注入 + 指标可视化。

- 局终结算/反思/lessons 蒸馏/注入下局
- metrics JSONL + 对比图
- 策略库 v1
- 验收: 同 seed 带/不带 lessons × 3 局出对比曲线

### v0.4.0 — 打磨与广度（M4）
- 铁路/货运 tool 扩展
- replay（事件时间线）
- 自愈（崩溃重启/续档）
- 文档完善 + SPEC 更新
- 对照模型基线（多 provider）

---

## 开发纪律（见 AGENTS.md 细则）
1. **TDD**: 先写失败测试 → 实现 → 绿；`@live` 标测试默认跳过，CI/手动 `--live` 跑
2. **门禁**: 每次提交前 `pnpm run gate` 必须绿（typecheck + lint + test）
3. **小步**: 每 PR 一个可验证目标；保持主干始终可运行
4. **零屎山**: 纯函数分离/类型单一事实源/模块职责+禁止项注释
5. **事实驱动**: 任何协议/行为假设先有源码/实测依据，写进 SPEC/ADR

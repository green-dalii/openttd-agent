# docs/ 文档地图（单一入口）

> **职责**：本文件是 `docs/` 的**索引与边界表**：每份文档只回答一个问题、谁说了算、
> 不含什么。目的是**防漂移**——同一主题只允许一份权威，其余地方只写指针。
> **规则条文在 `AGENTS.md` §9**（文档职责与正交性）；本文件只是它的执行清单。
> 最后整理：2026-10-08（前端 4→1、信号架构并入契约、历史文档归档）。

---

## 1. 文档地图

| 文档 | 只回答的问题 | 权威于 | **不含**（避免重复） |
|------|--------------|--------|---------------------|
| [`SCAFFOLD-CONTRACT.md`](SCAFFOLD-CONTRACT.md) | 模型**看到什么 / 能做什么 / 动作后得到什么**；两种模式（游玩 / 基准）如何共用同一套脚手架 | 观测面、反馈面、动作面、协议、信号从哪来、两种模式的分界、待打磨清单 | 页面与 API 形状；进化层的存储格式；进度计划 |
| [`AGENT-LOOP-AND-CONTROL.md`](AGENT-LOOP-AND-CONTROL.md) | 框架**如何驱动 LLM**（决策循环契约）与 Dashboard 运行控制 | 循环契约、触发器、快照/增量汇报、运行控制 | 脚手架对模型的承诺（→ 契约）；游戏内执行器实现（→ 执行器文档） |
| [`EXECUTOR-ARCHITECTURE.md`](EXECUTOR-ARCHITECTURE.md) | **为什么执行器必须运行在 GS 内**（决策依据） | GS-only 的论证、AI 只保留公司外壳的原因 | 当前系统事实（→ `SPEC.md` §10.107+）；计划（→ `ROADMAP.md`） |
| [`EVOLUTION.md`](EVOLUTION.md) | **跨局记忆系统**的设计与数据契约 | lesson/strategy/fact 的数据契约、三道闸、反思约束、注入路径 | 模型侧观测面（→ 契约）；实现细节与进度 |
| [`DASHBOARD-AUDIT-2026-10-31.md`](DASHBOARD-AUDIT-2026-10-31.md) | **一次呈现面审计的结论与优化方案**（审计 + 方案） | 实测证据（16 条）、第一性原理的四页视觉主角、P0/P1/P2 优化项、验收方式 | 四问 IA 的**决定**（→ `DASHBOARD-CODESIGN.md`）；视觉规范（→ `DASHBOARD-UI.md`）；接口契约（→ `DASHBOARD-API.md`） |
| [`DASHBOARD-API.md`](DASHBOARD-API.md) | 前后端**机器契约**（冻结） | 页面路由、类型、REST、WS 帧、模块契约 | UI 视觉与交互（→ UI 文档）；指标口径（→ `SPEC.md`） |
| [`DASHBOARD-UI.md`](DASHBOARD-UI.md) | dashboard **人机契约**（设计） | 设计 token、组件契约、图表 API、页面信息架构、可达性基线、更新契约 | 协议形状（→ API 文档）；库取舍（→ `FRONTEND.md`） |
| [`FRONTEND.md`](FRONTEND.md) | **前端怎么做、为什么这样取舍** | 结构改造 S1–S4、依赖取舍与教训、UnoCSS 决定与实测、D3 澄清、新页面完成定义 | 页面与 API 形状（→ dashboard 文档）；图表系统事实（→ `SPEC.md` §10.97） |
| [`STARTUP-AND-LIFECYCLE.md`](STARTUP-AND-LIFECYCLE.md) | **启动门禁**与 Session 生命周期 | preflight 检查项、LLM 可用性探测、CLI 行为、session 生命周期 | 决策循环（→ 循环文档）；协议字节（→ `SPEC.md`） |
| [`RL-HARNESS-SCOPE-AUDIT.md`](RL-HARNESS-SCOPE-AUDIT.md) | **harness 边界的判据与逐条论证**（J1–J4） | 注入通道清单、违规项与修复、遗留 | 准则条文本身（→ `AGENTS.md` §2 铁律 7）；脚手架现状（→ 契约） |
| [`ACTION-BUS-CODESIGN.md`](ACTION-BUS-CODESIGN.md) | 动作**如何被表示、分发、观测**（设计） | 动作信封三构件、与 pi-agent-core 的协同 | 模型侧动作面（→ 契约）；已执行结果（→ `SPEC.md`）；剩余计划（→ `ROADMAP.md` 阶段 D6） |
| [`DASHBOARD-CODESIGN.md`](DASHBOARD-CODESIGN.md) | **整个 Dashboard 是否还是后端的界面**（方案，待审） | 四问（配置/观察/比较/复现）、能力对照表、十条发现、目标信息架构、B1–B6 顺序 | 运行配置的专项诊断（→ `SELECTION-STATE-CODESIGN.md`）；页面视觉规范（→ `DASHBOARD-UI.md`） |
| [`SELECTION-STATE-CODESIGN.md`](SELECTION-STATE-CODESIGN.md) | **运行配置的「选择」与「真值」如何统一**（方案，待审） | 四份副本的诊断、唯一解析器方案、页面 draft/saved 分离、实施顺序 | 已实现的契约（→ `DASHBOARD-API.md`）；页面视觉规范（→ `DASHBOARD-UI.md`） |
| [`HARNESS-MIGRATION.md`](HARNESS-MIGRATION.md) | **迁到 pi-agent-core `AgentHarness` 的方案**（做哪些、不做哪些、每步验收与回滚） | 阻抗不匹配与解法、已核实的库事实（带坐标）、风险表 | 脚手架契约（→ `SCAFFOLD-CONTRACT.md`）；进度（→ `ROADMAP.md`） |
| [`archive/`](archive/) | **历史快照**（已落地或已被取代的评估/审计/开发日记） | 当时的证据与结论 | 任何现状判断——文件顶部有冻结横幅。当前：`MEMORY-DETAIL.md`（A–F 完整叙述）、`CHANGELOG-DEV-DIARY.md`（0.6.0 后的逐 PR 日记） |

## 2. 规则（执行清单）

1. **一个主题一份权威**。发现同一主题有两份文档时，**合并**而不是互相引用。
   （2026-10-08 的整理就是这条规则的执行：前端 4 份 → 1 份；信号架构 → 并入契约。）
2. **跨文档只写指针**。别处需要这条事实时，写"见 X §Y"，不复制内容。
3. **历史进 `archive/`**，并在文件顶部加冻结横幅；正文不得再把归档文件当权威引用
   （只能当证据链引用，如"当时的审计见 `docs/archive/…`"）。
4. **新增文档前先问**：能不能并进已有文档的某一节？只有当它是**新的独立问题**时才新建。
5. **进度不写进 docs/**。未完成的事在 `ROADMAP.md`，已完成的事在 `CHANGELOG.md`。
6. **守卫生效**：`test/unit/repo-hygiene.test.ts` 断言本文件列出的文档都在、
   `docs/` 下的文档都被列出（防"新增文档忘了登记"）。

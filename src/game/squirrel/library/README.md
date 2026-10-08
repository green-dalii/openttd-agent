# OpenTTD Script 库（vendored，GPL v2）

`bridge-gs` 的寻路依赖。来源：OpenTTD BaNaNaS 内容包（字节精确抽取，一处 GS 适配补丁）：

| 目录 | 内容包 | 内容 Id | 原始 MD5 | 许可 |
|------|--------|---------|----------|------|
| `Pathfinder.Road-4/` | `5046524f-Pathfinder.Road-4.tar` | `ai-library/5046524f` | `7a7e02051c0b2c177f10f2440e462de7` | GPL v2 |
| `Graph.AyStar.6/` | `4752412a-Graph.AyStar-6.tar` | `ai-library/4752412a` | `300052317e050fbd12f983c995fa4000` | GPL v2 |
| `Queue.BinaryHeap.1/` | `51554248-Queue.BinaryHeap-1.tar` | `ai-library/51554248` | `200e798ae4b3cfa6556e628eaa982e4b` | GPL v2 |

作者：OpenTTD NoAI Developers Team、Zuu、Yexo（各目录 `license.txt` 保留完整 GPL v2 文本）。

**依赖链**：`pathfinder.road` → `graph.aystar` v6 → `queue.binary_heap` v1。

**GS 适配补丁（每处 `library.nut` 顶部有声明，GPL §2(a)）**，共两类，均真机实测驱动：
1. `extends AILibrary` → `extends GSLibrary`（四选一探针：GS 虚拟机的库基类注册名是
   `GSLibrary`；`GameLibrary`/`Library`/`ScriptLibrary`/`AILibrary` 均报
   `the index '...' does not exist`）。
2. API 类改 GS 名（GS 虚拟机不注册 AI 名：`the index 'AIList' does not exist`）：
   `AITile/AIMap/AITunnel/AIBridge/AIRoad/AIVehicle/AITestMode/AIList` →
   `GSTile/GSMap/GSTunnel/GSBridge/GSRoad/GSVehicle/GSTestMode/GSList`（script_api 双名，语义同一）。

除以上两类改动外未改任何代码。

**为什么入库**：`pathfinder.road` 在 **GS 上下文**里解析的是 `game/library/` 树
（SPEC §10.107），而内容下载落在 `content_download/ai/library/`——AI 能解析、GS 不能。
本目录由 `squirrel-deploy` 部署到 `<data>/game/library/`。

**许可边界**：这三个目录是 GPL v2 的独立作品，随包分发、保留包内许可文本；与本仓库
MIT 代码之间是"聚合分发"。**不要**把包内代码复制进 `main.nut`——那会把 GPL 引进 MIT 文件。

守卫：`test/unit/squirrel-library.test.ts`（锁定文件存在性 + 补丁声明 + 原始 MD5 记录）。

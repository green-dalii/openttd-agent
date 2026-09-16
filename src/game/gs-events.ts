/**
 * GS event contract — the typed harness-facing channel (REFACTOR Phase A).
 *
 * 职责: 定义 GS→harness 全部事件的单一事实源（typebox schema），并提供
 *   company-name 相位串 → 事件的过渡转换（A2 GS 中继上线、A3 harness 消费
 *   事件后，公司名通道与 harness 侧正则退役；本转换层随之删除）。
 * 禁止: 在此做任何策略判断（触发与否是 decision-loop 的事）；禁止发明
 *   样张——golden 数据全部来自真机日志（cal6/7/8、m3c，SPEC §10.40–§10.42）。
 */

import { Type, type TSchema, type Static } from "typebox";
import { Check } from "typebox/value";

/** Executor stages — 与 executor-status.ts 的 ExecutorStage 对齐。 */
const EXEC_STAGES = [
	"boot",
	"work",
	"station",
	"road",
	"depot",
	"vehicle",
	"fleet",
	"done",
	"heartbeat",
	"error",
	"unknown",
] as const;

const StageSchema = Type.Union(
	EXEC_STAGES.map((s) => Type.Literal(s)) as unknown as [TSchema, TSchema, ...TSchema[]],
);

/**
 * 开放 detail：计数器字段随执行器演进而增长（search/road/distance/probes/
 * seq/signs/vehicleId/destTile/arrive…），契约只锁定类型，未知字段保留透传
 * ——不静默丢弃（比较不许开始撒谎）。必填：A2 的 GS 中继必须总带 detail
 * （无计数器时发空对象），序列化形状稳定。
 */
const DetailSchema = Type.Record(
	Type.String(),
	Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
);

/** 执行器状态事件（替代 31 字符公司名通道）。`hb:true` = 心跳，非新闻。 */
export const ExecEventSchema = Type.Object({
	kind: Type.Literal("exec"),
	stage: StageSchema,
	/** 蓝图 job id；真机 boot 期为 -1（"EX boot j-1"）。 */
	job: Type.Integer(),
	/** 心跳标记：决策门不得把心跳当新闻。 */
	hb: Type.Boolean(),
	/** 真机原串，审计与调试的唯一权威。 */
	raw: Type.String(),
	/** GS 侧暂不填（SPEC §10.45）；harness 侧由 decodeExecutorPhase(raw) 重建。 */
	detail: Type.Optional(DetailSchema),
});

/** 执行器完成事件（原 done 阶段；带 gameDate 即为账本回填的事实）。 */
export const DoneEventSchema = Type.Object({
	kind: Type.Literal("done"),
	job: Type.Integer(),
	gameDate: Type.Optional(Type.String()),
});

/** 路线摘要事件（GS ack 已有此信息；契约化以便 A2 直接发结构化载荷）。 */
export const RouteBriefEventSchema = Type.Object({
	kind: Type.Literal("route-brief"),
	job: Type.Integer(),
	fromTown: Type.Integer(),
	toTown: Type.Integer(),
	tiles: Type.Optional(Type.Integer()),
});

/**
 * 线路经济事件（NEXT-2 N2-1）：GS 按站点订单归属统计每条线路的原始读数。
 * 只发原始事实（当年累计利润 + 日期），每日收益由 harness 侧纯函数派生——
 * Squirrel 侧不留算术（SPEC §10.45 的 GS 怪癖教训）。
 */
export const RouteStatsEventSchema = Type.Object({
	kind: Type.Literal("route-stats"),
	job: Type.Integer(),
	vehicles: Type.Integer(),
	/** 当年累计利润；负值合法（亏钱线路必须能上报）。 */
	profit: Type.Integer(),
	waiting: Type.Integer(),
	gameDate: Type.Integer(),
});

/** GS 错误事件（"发送 ≠ 接受"的观测闭环，SPEC §10.39.1）。 */
export const GsErrEventSchema = Type.Object({
	kind: Type.Literal("err"),
	cmd: Type.Optional(Type.String()),
	detail: DetailSchema,
});

export const GsEventSchema = Type.Union([
	ExecEventSchema,
	DoneEventSchema,
	RouteBriefEventSchema,
	RouteStatsEventSchema,
	GsErrEventSchema,
]);

export type ExecEvent = Static<typeof ExecEventSchema>;
export type DoneEvent = Static<typeof DoneEventSchema>;
export type RouteBriefEvent = Static<typeof RouteBriefEventSchema>;
export type RouteStatsEvent = Static<typeof RouteStatsEventSchema>;
export type GsErrEvent = Static<typeof GsErrEventSchema>;
export type GsEvent = Static<typeof GsEventSchema>;
export type ExecStage = (typeof EXEC_STAGES)[number];
export type ExecutorStage = ExecStage;

/** ExecStage 的运行时枚举值（供 GS 侧实现对照）。 */
export const EXEC_STAGE_VALUES: readonly ExecStage[] = EXEC_STAGES;

/** Type guard：任意输入是否为合法 GsEvent（A2/A3 的边界校验点）。 */
export function isGsEvent(x: unknown): x is GsEvent {
	return Check(GsEventSchema, x);
}

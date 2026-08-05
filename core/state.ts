/**
 * The state entrypoint intentionally exposes the one v3 store.  Keep this
 * module as the stable import seam; it must never define tables of its own.
 */
export {
  DurableStore,
  FencedTransitionError,
  SchemaError,
  type CreateLaneInput,
  type DeliveryState,
  type LaneRecord,
  type LaneState,
  type LeaseRecord,
  type ManagerRecord,
  type MissionRecord,
  type OutboxRecord,
  type TerminalVerdict,
  type UsageEventInput,
  type UsageEventRecord,
  type UsageGroupBy,
  type UsageRole,
  type UsageSeriesRow,
  type UsageSource,
} from "./schema";

export { DurableStore as StateStore } from "./schema";

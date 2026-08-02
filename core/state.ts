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
  type OutboxRecord,
  type TerminalVerdict,
} from "./schema";

export { DurableStore as StateStore } from "./schema";

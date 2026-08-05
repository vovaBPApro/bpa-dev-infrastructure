import { resolve } from "node:path";

/**
 * Where the durable state database lives. One home, because the callers are no
 * longer only the mission CLI: the lane log masker (daemon/mask-stream.ts) and
 * the transcript ingester write usage rows into the SAME database the
 * orchestrator reads, and a second spelling of this path would give them a
 * private, invisible store instead.
 *
 * `repoRoot` is the caller's own repository root, so a module under core/ and a
 * module under daemon/ resolve to one file rather than to their own directory.
 */
export function stateDbPath(repoRoot: string): string {
  return process.env.INFRA_STATE_DB || resolve(repoRoot, "runtime", "state.db");
}

import { hostname } from "node:os";
import type { OwnerLiveness } from "./schema";

export const missionCliActions = [
  ["mission", "create"], ["mission", "complete"], ["manager", "create"], ["lane", "create"],
  ["lane", "claim"], ["lane", "ack"], ["lane", "progress"],
  ["lane", "complete"], ["outbox", "enqueue"], ["status", undefined],
  // Called by orchestrator/launch.sh and orchestrator/watchdog.sh on every
  // start, tick and stop. They were absent from this list and from the CLI
  // until V3-5.37, and the launcher's own call sites were the only record that
  // they were supposed to exist; core/mission-cli-actions.test.ts now holds the
  // two sides together.
  ["lease", "acquire"], ["lease", "renew"], ["lease", "release"], ["reap", undefined],
] as const;

export function isMissionCliAction(group: string, action?: string): boolean {
  return missionCliActions.some(([knownGroup, knownAction]) => group === knownGroup && action === knownAction);
}

/**
 * Is the process behind a lease owner still there?
 *
 * The owner string is the one orchestrator/launch.sh writes: `<host>:<pid>`.
 * Only a PID on THIS host can be checked, so a foreign host, a malformed owner,
 * or anything else that cannot be answered is `unverifiable` -- never `dead`.
 * `reapLeases` releases on `dead` alone, so an unanswerable question leaves the
 * lease exactly where it is.
 *
 * This is the TypeScript twin of `owner_liveness` in orchestrator/watchdog.sh
 * and agrees with it on every verdict except one, deliberately: EPERM from
 * `kill(pid, 0)` PROVES the process exists, so it is reported `live`, while
 * shell's `kill -0` reports the same case as failure. Reaping a live holder's
 * lease is the direction that breaks the singleton, so the two disagree only
 * where this side is the safe one.
 *
 * It lives in this module and not in mission-cli.ts because mission-cli.ts runs
 * its `main` at import time and therefore cannot be imported by a test.
 */
export function ownerLiveness(owner: string, host: string = hostname()): OwnerLiveness {
  const separator = owner.lastIndexOf(":");
  if (separator <= 0) return "unverifiable";
  const ownerHost = owner.slice(0, separator);
  const pid = owner.slice(separator + 1);
  if (ownerHost !== host || !/^[1-9][0-9]*$/.test(pid)) return "unverifiable";
  try {
    process.kill(Number(pid), 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return code === "EPERM" ? "live" : "unverifiable";
  }
}

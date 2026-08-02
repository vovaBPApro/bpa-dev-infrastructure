#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StateStore } from "./state";
import { currentWatchdogProvenance, installedWatchdogProvenance } from "./watchdog-provenance";

const [command, ...args] = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const required = (name: string): string => {
  const value = option(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const store = new StateStore(process.env.INFRA_STATE_DB);
try {
  if (command === "record") {
    const intervalId = required("--interval");
    const cause = required("--cause");
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const identity = currentWatchdogProvenance();
    const sourceId = createHash("sha256").update(`${bootId}\0${identity.unitName}\0${identity.invocationId}`).digest("hex");
    const observedAt = Number(option("--observed-at") ?? Date.now());
    const causeId = createHash("sha256").update(`${intervalId}\0${cause}\0${sourceId}`).digest("hex");
    store.appendTickJournal({ intervalId, causeId, kind: "missed-tick", observedAt, sourceId });
    store.appendTickJournal({ intervalId, causeId, kind: "cause", observedAt, sourceId });
    console.log(JSON.stringify({ intervalId, causeId, sourceId }));
  } else if (command === "reconcile") {
    const identity = currentWatchdogProvenance();
    const producerId = identity.producerId;
    const cadenceMs = Number(required("--cadence-ms"));
    const observedAt = Number(option("--observed-at") ?? Date.now());
    if (!Number.isSafeInteger(cadenceMs) || cadenceMs <= 0 || !Number.isSafeInteger(observedAt)) throw new Error("invalid cadence/observation");
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const invocationId = identity.invocationId;
    const current = Math.floor(observedAt / cadenceMs);
    const previous = store.db.query("SELECT interval_number, boot_id FROM tick_producer_state WHERE producer_id = ?").get(producerId) as { interval_number: number; boot_id: string } | null;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      if (previous && current > previous.interval_number + 1) {
        for (let interval = previous.interval_number + 1; interval < current; interval += 1) {
          const intervalId = `${producerId}:${interval}:${cadenceMs}`;
          const sourceId = createHash("sha256").update(`${bootId}\0${producerId}\0${invocationId}`).digest("hex");
          const classification = previous.boot_id === bootId ? "UNKNOWN" : "REBOOT";
          const digest = createHash("sha256").update(`${intervalId}\0${classification}\0${sourceId}`).digest("hex");
          const causeId = `${classification}:${digest}`;
          const append = store.db.query(`INSERT INTO tick_journal (interval_id,cause_id,kind,observed_at,created_at,source_id)
            VALUES (?,?,?,?,?,?) ON CONFLICT(interval_id,cause_id,kind,source_id) DO NOTHING`);
          append.run(intervalId, causeId, "missed-tick", observedAt, Date.now(), sourceId);
          append.run(intervalId, causeId, "cause", observedAt, Date.now(), sourceId);
        }
      }
      store.db.query(`INSERT INTO tick_producer_state (producer_id, interval_number, boot_id, updated_at, unit_name, unit_fingerprint, invocation_id) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(producer_id) DO UPDATE SET interval_number=excluded.interval_number, boot_id=excluded.boot_id, updated_at=excluded.updated_at, unit_name=excluded.unit_name, unit_fingerprint=excluded.unit_fingerprint, invocation_id=excluded.invocation_id`).run(producerId, current, bootId, observedAt, identity.unitName, identity.unitFingerprint, identity.invocationId);
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    console.log(JSON.stringify({ producerId, interval: current, replayed: previous ? Math.max(0, current - previous.interval_number - 1) : 0 }));
  } else if (command === "account") {
    const producer = store.db.query("SELECT invocation_id FROM tick_producer_state WHERE producer_id = 'bpa-orchestrator-watchdog'").get() as { invocation_id: string } | null;
    if (!producer) throw new Error("UNMEASURED: authenticated watchdog producer epoch absent");
    const identity = installedWatchdogProvenance(producer.invocation_id);
    const intervals = option("--all") !== undefined
      ? [...new Set(store.tickJournal().map((row) => row.intervalId))]
      : required("--intervals").split(",").filter(Boolean);
    const result = store.accountMissedTicks(intervals, identity);
    console.log(JSON.stringify(result));
    if (result.verdict !== "clean") process.exitCode = 3;
  } else if (command === "integrity") {
    const row = store.db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    if (row.integrity_check !== "ok") throw new Error(`state database corrupt: ${row.integrity_check}`);
    console.log("ok");
  } else {
    throw new Error("usage: tick-journal-cli.ts record|reconcile|account|integrity");
  }
} finally {
  store.close();
}

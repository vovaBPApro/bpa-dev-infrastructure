import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FencedLeaseError, LeaseHeldError, StateError, StateStore } from "./state";

const directories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bpa-state-store-"));
  directories.push(directory);
  return join(directory, "state.sqlite");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("REGRESSION W-48: journal survives restart and reboot causes dedupe on replay", async () => {
  const path = await databasePath();
  const store = new StateStore(path, { now: () => 2_000 });
  const first = store.appendTickJournal({ intervalId: "2026-08-02T06:00Z/PT1M", causeId: "timer-not-fired", kind: "missed-tick", observedAt: 1_000 });
  expect(store.appendTickJournal({ intervalId: first.intervalId, causeId: first.causeId, kind: first.kind, observedAt: 9_999 })).toEqual(first);
  store.appendTickJournal({ intervalId: first.intervalId, causeId: "host-reboot", kind: "cause", observedAt: 1_001 });
  expect(() => store.db.query("UPDATE tick_journal SET cause_id = 'rewritten'").run()).toThrow("append-only");
  expect(() => store.db.query("DELETE FROM tick_journal").run()).toThrow("append-only");
  store.close();

  const restarted = new StateStore(path, { now: () => 3_000 });
  expect(restarted.tickJournal()).toEqual([
    first,
    expect.objectContaining({ intervalId: first.intervalId, causeId: "host-reboot", kind: "cause" }),
  ]);
  restarted.close();
});

test("REGRESSION W-48: morning accounting is one-to-one and unknown intervals fail closed", async () => {
  const store = new StateStore(await databasePath());
  store.appendTickJournal({ intervalId: "i-1", causeId: "suspend", kind: "missed-tick", observedAt: 1_000 });
  store.appendTickJournal({ intervalId: "i-1", causeId: "suspend", kind: "cause", observedAt: 1_000 });
  store.appendTickJournal({ intervalId: "i-2", causeId: "timer", kind: "missed-tick", observedAt: 1_001 });
  store.appendTickJournal({ intervalId: "i-2", causeId: "timer", kind: "cause", observedAt: 1_001 });
  expect(store.accountMissedTicks(["i-1", "i-2"])).toMatchObject({ verdict: "clean", measurement: "MEASURED", unknownIntervalIds: [] });
  expect(store.accountMissedTicks(["i-1", "i-3"])).toMatchObject({
    verdict: "NO-GO", measurement: "UNMEASURED", unknownIntervalIds: ["i-2"],
    rows: [expect.objectContaining({ intervalId: "i-1", status: "MEASURED" }), expect.objectContaining({ intervalId: "i-3", status: "UNKNOWN" })],
  });
  store.appendTickJournal({ intervalId: "i-1", causeId: "second-cause", kind: "missed-tick", observedAt: 1_002 });
  expect(store.accountMissedTicks(["i-1", "i-2"])).toMatchObject({ verdict: "NO-GO", measurement: "UNMEASURED" });
  expect(() => store.accountMissedTicks(["i-1", "i-1"])).toThrow("unique");
  store.close();
});

test("REGRESSION GAP-5 r3: cause is mandatory and ambiguity/identity drift are diagnostic", async () => {
  const store = new StateStore(await databasePath());
  store.appendTickJournal({ intervalId: "missing", causeId: "c", kind: "missed-tick", observedAt: 1, sourceId: "source-a" });
  expect(store.accountMissedTicks(["missing"]).rows[0].status).toBe("UNKNOWN");
  store.appendTickJournal({ intervalId: "missing", causeId: "c", kind: "cause", observedAt: 1, sourceId: "source-b" });
  expect(store.accountMissedTicks(["missing"]).rows[0].status).toBe("IDENTITY_DRIFT");
  store.appendTickJournal({ intervalId: "missing", causeId: "c-2", kind: "cause", observedAt: 1, sourceId: "source-a" });
  expect(store.accountMissedTicks(["missing"]).rows[0].status).toBe("AMBIGUOUS");
  store.close();
});

test("REGRESSION GAP-5 r3: prior schema upgrades and corrupt database fails closed", async () => {
  const path = await databasePath();
  const legacy = new (await import("bun:sqlite")).Database(path);
  legacy.exec("CREATE TABLE tick_journal (sequence INTEGER PRIMARY KEY, interval_id TEXT NOT NULL, cause_id TEXT NOT NULL, kind TEXT NOT NULL, observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(interval_id,cause_id,kind));");
  legacy.close();
  const upgraded = new StateStore(path);
  expect((upgraded.db.query("PRAGMA table_info(tick_journal)").all() as Array<{name:string}>).some((row) => row.name === "source_id")).toBe(true);
  upgraded.db.query("INSERT INTO tick_journal(interval_id,cause_id,kind,observed_at,created_at) VALUES('legacy','legacy','cause',1,1)").run();
  expect(upgraded.db.query("SELECT source_id FROM tick_journal WHERE interval_id='legacy'").get()).toEqual({ source_id: "legacy-untrusted" });
  upgraded.close();
  await Bun.write(path, "not a sqlite database");
  expect(() => new StateStore(path)).toThrow();
});

test("REGRESSION GAP-5 r4: empty journal and absent producer are UNMEASURED", async () => {
  const store = new StateStore(await databasePath());
  expect(store.accountMissedTicks([])).toMatchObject({ verdict: "NO-GO", measurement: "UNMEASURED" });
  expect(store.accountMissedTicks([], { producerId: "watchdog", unitName: "watchdog.service", unitFingerprint: "tracked", invocationId: "missing" })).toMatchObject({ verdict: "NO-GO", measurement: "UNMEASURED" });
  store.close();
});

test("REGRESSION GAP-5 r4: migration is transactional and both writer generations remain compatible", async () => {
  const path = await databasePath();
  const { Database } = await import("bun:sqlite");
  const legacy = new Database(path);
  legacy.exec("CREATE TABLE tick_journal (sequence INTEGER PRIMARY KEY, interval_id TEXT NOT NULL, cause_id TEXT NOT NULL, kind TEXT NOT NULL, observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(interval_id,cause_id,kind)); INSERT INTO tick_journal VALUES(1,'old','old','cause',1,1)");
  legacy.close();
  const upgraded = new StateStore(path, { now: () => 2 });
  upgraded.appendTickJournal({ intervalId: "new", causeId: "new", kind: "cause", observedAt: 2, sourceId: "v2" });
  upgraded.db.query("INSERT INTO tick_journal(interval_id,cause_id,kind,observed_at,created_at) VALUES(?,?,?,?,?) ON CONFLICT(interval_id,cause_id,kind) DO NOTHING").run("rollback", "rollback", "cause", 3, 3);
  expect(upgraded.tickJournal().map((row) => row.intervalId)).toEqual(["old", "new", "rollback"]);
  upgraded.close();

  const partial = await databasePath();
  const broken = new Database(partial);
  broken.exec("CREATE TABLE tick_journal (sequence INTEGER PRIMARY KEY); PRAGMA user_version=2");
  broken.close();
  expect(() => new StateStore(partial)).toThrow("partial or corrupt");
});

test("a live lease cannot be double-acquired", async () => {
  let now = 1_000;
  const store = new StateStore(await databasePath(), { now: () => now });
  expect(store.acquireLease("worker-a", "mission-1", 100).fencingToken).toBe(1);
  expect(() => store.acquireLease("worker-b", "mission-1", 100)).toThrow(LeaseHeldError);
  expect(store.listActive()).toHaveLength(1);
  store.close();
});

test("an expired lease is reaped and receives a strictly greater fencing token on reacquire", async () => {
  let now = 1_000;
  const store = new StateStore(await databasePath(), { now: () => now });
  const first = store.acquireLease("worker-a", "mission-1", 50);
  now += 50;
  expect(store.reapExpiredLeases()).toEqual([{ key: "mission-1", owner: "worker-a", fencingToken: first.fencingToken, expiresAt: 1_050 }]);
  const second = store.acquireLease("worker-b", "mission-1", 50);
  expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
  store.close();
});

test("renew rejects a stale fencing token", async () => {
  let now = 1_000;
  const store = new StateStore(await databasePath(), { now: () => now });
  const first = store.acquireLease("worker-a", "mission-1", 10);
  now += 10;
  store.acquireLease("worker-b", "mission-1", 100);
  expect(() => store.renewLease("worker-a", "mission-1", first.fencingToken, 100)).toThrow(FencedLeaseError);
  store.close();
});

test("mission state machine rejects invalid transitions", async () => {
  const store = new StateStore(await databasePath());
  store.createMission("mission-1", "correlation-1");
  expect(() => store.transitionMission("mission-1", "succeeded")).toThrow(StateError);
  expect(store.transitionMission("mission-1", "running").state).toBe("running");
  expect(store.transitionMission("mission-1", "succeeded").state).toBe("succeeded");
  expect(() => store.transitionMission("mission-1", "running")).toThrow(StateError);
  store.close();
});

test("mission success is fenced by child lane completion", async () => {
  const store = new StateStore(await databasePath());
  store.createMission("mission-running-child", "correlation-running-child");
  store.transitionMission("mission-running-child", "running");
  store.createLane("lane-running", "mission-running-child");
  store.transitionLane("lane-running", "running");

  const eventsBeforeRejectedTransition = store.listEvents();
  expect(() => store.transitionMission("mission-running-child", "succeeded")).toThrow(StateError);
  expect(store.db.query("SELECT state FROM missions WHERE id = ?").get("mission-running-child")).toEqual({ state: "running" });
  expect(store.listEvents()).toEqual(eventsBeforeRejectedTransition);

  store.transitionLane("lane-running", "succeeded");
  expect(store.transitionMission("mission-running-child", "succeeded").state).toBe("succeeded");

  store.createMission("mission-failed-child", "correlation-failed-child");
  store.transitionMission("mission-failed-child", "running");
  store.createLane("lane-failed", "mission-failed-child");
  store.transitionLane("lane-failed", "failed");
  expect(() => store.transitionMission("mission-failed-child", "succeeded")).toThrow(StateError);
  expect(store.db.query("SELECT state FROM missions WHERE id = ?").get("mission-failed-child")).toEqual({ state: "running" });
  store.close();
});

test("terminal mission rejects late lane creation", async () => {
  const store = new StateStore(await databasePath());
  store.createMission("mission-succeeded", "correlation-succeeded");
  store.transitionMission("mission-succeeded", "running");
  store.transitionMission("mission-succeeded", "succeeded");
  store.createMission("mission-failed", "correlation-failed");
  store.transitionMission("mission-failed", "failed");

  const eventsBeforeRejectedLanes = store.listEvents();
  expect(() => store.createLane("late-succeeded", "mission-succeeded")).toThrow(StateError);
  expect(() => store.createLane("late-failed", "mission-failed")).toThrow(StateError);
  expect(store.db.query("SELECT id FROM lanes WHERE id IN (?, ?)").all("late-succeeded", "late-failed")).toEqual([]);
  expect(store.listEvents()).toEqual(eventsBeforeRejectedLanes);
  store.close();
});

test("successful mutations append audit rows", async () => {
  let now = 1_000;
  const store = new StateStore(await databasePath(), { now: () => now });
  store.createMission("mission-1", "correlation-1");
  store.transitionMission("mission-1", "running");
  const lease = store.acquireLease("worker-a", "mission-1", 100);
  store.renewLease("worker-a", "mission-1", lease.fencingToken, 100);
  store.releaseLease("worker-a", "mission-1", lease.fencingToken);
  expect(store.listEvents().map((event) => event.kind)).toEqual([
    "mission.created", "mission.transitioned", "lease.acquired", "lease.renewed", "lease.released",
  ]);
  store.close();
});

test("injected logical lease time prevents a delayed wall-clock acquirer from replacing a live holder", async () => {
  const path = await databasePath();
  const logicalNow = 1_000;
  let wallClockNow = logicalNow;
  const originalDateNow = Date.now;
  const holder = new StateStore(path, { now: () => logicalNow });
  const delayedAcquirer = new StateStore(path, { now: () => logicalNow });
  try {
    expect(holder.acquireLease("worker-a", "shared-key", 10_000).fencingToken).toBe(1);
    wallClockNow = 11_001;
    Date.now = () => wallClockNow;

    expect(() => delayedAcquirer.acquireLease("worker-b", "shared-key", 10_000)).toThrow(LeaseHeldError);
    expect(delayedAcquirer.listActive()).toEqual([
      { key: "shared-key", owner: "worker-a", fencingToken: 1, expiresAt: 11_000 },
    ]);
  } finally {
    Date.now = originalDateNow;
    delayedAcquirer.close();
    holder.close();
  }
});

test("two independent Bun processes racing to acquire one SQLite lease have exactly one winner", async () => {
  const path = await databasePath();
  const start = `${path}.start`;
  const ready = ["worker-a", "worker-b"].map((owner) => `${path}.${owner}.ready`);
  const setup = new StateStore(path);
  setup.close();
  const source = resolve(import.meta.dir, "state.ts");
  const program = `
    import { StateStore } from ${JSON.stringify(source)};
    const [path, start, ready, owner] = process.argv.slice(1);
    const store = new StateStore(path, { now: () => 1_000 });
    await Bun.write(ready, "ready");
    while (!(await Bun.file(start).exists())) await Bun.sleep(10);
    try { console.log(JSON.stringify({ result: "won", ...store.acquireLease(owner, "shared-key", 1) })); }
    catch (error) {
      if (error.constructor.name !== "LeaseHeldError") throw error;
      console.log(JSON.stringify({ result: "held" }));
    }
    finally { store.close(); }
  `;
  const first = Bun.spawn([process.execPath, "-e", program, path, start, ready[0], "worker-a"], { stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 30_000;
  while (!(await Bun.file(ready[0]).exists())) {
    if (Date.now() >= deadline) throw new Error("first lease racer did not initialize within 30 seconds");
    await Bun.sleep(10);
  }
  const second = Bun.spawn([process.execPath, "-e", program, path, start, ready[1], "worker-b"], { stdout: "pipe", stderr: "pipe" });
  while (!(await Bun.file(ready[1]).exists())) {
    if (Date.now() >= deadline) throw new Error("second lease racer did not initialize within 30 seconds");
    await Bun.sleep(10);
  }
  await Bun.write(start, "go");
  const [firstOutput, secondOutput, firstError, secondError, firstExit, secondExit] = await Promise.all([
    new Response(first.stdout).text(), new Response(second.stdout).text(), new Response(first.stderr).text(), new Response(second.stderr).text(), first.exited, second.exited,
  ]);
  expect({ exits: [firstExit, secondExit], stderr: [firstError, secondError] }).toEqual({ exits: [0, 0], stderr: ["", ""] });
  const outcomes = [firstOutput, secondOutput].map((output) => JSON.parse(output.trim()) as { result: "won" | "held"; fencingToken?: number });
  expect(outcomes).toEqual(expect.arrayContaining([{ result: "won", fencingToken: 1 }, { result: "held" }]));
  const store = new StateStore(path, { now: () => 1_000 });
  expect(store.listActive()).toEqual([expect.objectContaining({ key: "shared-key", fencingToken: 1 })]);
  store.close();
}, 35_000);

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

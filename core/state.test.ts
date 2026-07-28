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

test("two independent Bun processes racing to acquire one SQLite lease have exactly one winner", async () => {
  const path = await databasePath();
  const ready = `${path}.start`;
  const setup = new StateStore(path);
  setup.close();
  const source = resolve(import.meta.dir, "state.ts");
  const program = `
    import { StateStore } from ${JSON.stringify(source)};
    const [path, ready, owner] = process.argv.slice(1);
    while (!(await Bun.file(ready).exists())) await Bun.sleep(1);
    const store = new StateStore(path);
    try { console.log(JSON.stringify(store.acquireLease(owner, "shared-key", 10000))); }
    catch (error) { console.log(JSON.stringify({ error: error.constructor.name })); }
    finally { store.close(); }
  `;
  const first = Bun.spawn([process.execPath, "-e", program, path, ready, "worker-a"], { stdout: "pipe", stderr: "pipe" });
  const second = Bun.spawn([process.execPath, "-e", program, path, ready, "worker-b"], { stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(20);
  await Bun.write(ready, "go");
  const [firstOutput, secondOutput, firstExit, secondExit] = await Promise.all([
    new Response(first.stdout).text(), new Response(second.stdout).text(), first.exited, second.exited,
  ]);
  expect([firstExit, secondExit]).toEqual([0, 0]);
  const outcomes = [firstOutput, secondOutput].map((output) => JSON.parse(output.trim()) as { fencingToken?: number });
  expect(outcomes.filter((outcome) => outcome.fencingToken === 1)).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.fencingToken === undefined)).toHaveLength(1);
});

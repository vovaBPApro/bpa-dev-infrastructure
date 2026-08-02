import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "./state";

test("REGRESSION GAP-5 r3: producer restart/reboot replay dedupes and teardown is complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gap5-runtime-"));
  const database = join(directory, "state.db");
  const cli = join(import.meta.dir, "tick-journal-cli.ts");
  const run = async (...args: string[]) => Bun.$`INFRA_STATE_DB=${database} bun ${cli} ${args}`.quiet();
  try {
    await run("reconcile", "--producer", "watchdog", "--cadence-ms", "1000", "--observed-at", "1000", "--boot-id", "boot-a", "--invocation-id", "one");
    await run("reconcile", "--producer", "watchdog", "--cadence-ms", "1000", "--observed-at", "4000", "--boot-id", "boot-b", "--invocation-id", "two");
    await run("reconcile", "--producer", "watchdog", "--cadence-ms", "1000", "--observed-at", "4000", "--boot-id", "boot-b", "--invocation-id", "two");
    const store = new StateStore(database);
    expect(store.tickJournal()).toHaveLength(4);
    expect(store.accountMissedTicks(["watchdog:2:1000", "watchdog:3:1000"])).toMatchObject({ verdict: "clean", measurement: "MEASURED" });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  expect(await Bun.file(directory).exists()).toBe(false);
});

test("REGRESSION GAP-5 r3: abrupt writer termination leaves a replayable journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gap5-abrupt-"));
  const database = join(directory, "state.db");
  const source = join(import.meta.dir, "state.ts");
  const helper = join(directory, "writer.ts");
  await Bun.write(helper, `import { StateStore } from ${JSON.stringify(source)}; const s=new StateStore(${JSON.stringify(database)}); s.db.exec("BEGIN IMMEDIATE"); s.db.query("INSERT INTO tick_producer_state VALUES('p',1,'b',1)").run(); console.log('READY'); await Bun.sleep(30000);`);
  try {
    const child = Bun.spawn(["bun", helper], { stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(250);
    child.kill("SIGKILL");
    await child.exited;
    const restarted = new StateStore(database);
    expect(restarted.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(restarted.db.query("SELECT * FROM tick_producer_state").all()).toEqual([]);
    restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

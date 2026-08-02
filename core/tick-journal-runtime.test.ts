import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "./state";
import { Database } from "bun:sqlite";

test("REGRESSION GAP-5 r3: producer restart/reboot replay dedupes and teardown is complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gap5-runtime-"));
  const database = join(directory, "state.db");
  const cli = join(import.meta.dir, "tick-journal-cli.ts");
  const unit = join(directory, "bpa-orchestrator-watchdog.service");
  await Bun.write(unit, "[Service]\nEnvironment=ORCH_WATCHDOG_UNIT=bpa-orchestrator-watchdog.service\nExecStart=/opt/bpa/orchestrator/watchdog.sh\n");
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["bun", cli, ...args, "--unit", "bpa-orchestrator-watchdog.service", "--unit-file", unit, "--invocation-id", "abcdef0123456789abcdef0123456789"], { env: { ...process.env, INFRA_STATE_DB: database }, stdout: "pipe", stderr: "pipe" });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(stderr);
  };
  try {
    await run("reconcile", "--producer", "watchdog", "--cadence-ms", "1000", "--observed-at", "1000", "--boot-id", "boot-a");
    await run("reconcile", "--producer", "watchdog", "--cadence-ms", "1000", "--observed-at", "4000", "--boot-id", "boot-b");
    await run("reconcile", "--producer", "watchdog", "--cadence-ms", "1000", "--observed-at", "4000", "--boot-id", "boot-b");
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

test("REGRESSION GAP-5 r4: online backup restores with WAL/SHM recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gap5-backup-"));
  const database = join(directory, "state.db");
  const backup = join(directory, "backup.db");
  try {
    const store = new StateStore(database, { now: () => 2 });
    store.appendTickJournal({ intervalId: "durable", causeId: "cause", kind: "missed-tick", observedAt: 1 });
    store.appendTickJournal({ intervalId: "durable", causeId: "cause", kind: "cause", observedAt: 1 });
    store.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    store.close();
    const restored = new StateStore(backup);
    expect(restored.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(restored.accountMissedTicks(["durable"])).toMatchObject({ verdict: "clean", measurement: "MEASURED" });
    restored.close();
    const wal = new Database(database); wal.exec("PRAGMA journal_mode=WAL; INSERT INTO tick_journal(interval_id,cause_id,kind,observed_at,created_at) VALUES('wal','wal','cause',3,3)"); wal.close();
    const recovered = new StateStore(database);
    expect(recovered.tickJournal().some((row) => row.intervalId === "wal")).toBe(true);
    recovered.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

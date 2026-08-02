import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { dispatchOnce, reconcileRunning, type DispatchSnapshot } from "./dispatcher";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(retryBudget = 0) {
  const root = await mkdtemp(resolve(tmpdir(), "v3-dispatch-")); roots.push(root);
  const storePath = resolve(root, "state.json");
  const snapshot: DispatchSnapshot = { rows: [{ id: "mission-1", state: "ready", worker: [process.execPath, resolve(import.meta.dir, "../tests/fixtures/noop-worker.ts")], retryBudget, attempt: 0 }] };
  await writeFile(storePath, JSON.stringify(snapshot));
  return { root, storePath, runtimeDir: resolve(root, "runtime") };
}

const state = async (path: string) => JSON.parse(await readFile(path, "utf8")) as DispatchSnapshot;

describe("confirmed durable dispatch", () => {
  test("claims once, requires acknowledgement, and persists terminal evidence", async () => {
    const options = await fixture();
    await Promise.all([dispatchOnce(options), dispatchOnce(options)]);
    const row = (await state(options.storePath)).rows[0];
    expect(row.attempt).toBe(1);
    expect(row.acknowledgement?.attempt).toBe(1);
    expect(row.terminal?.verdict).toBe("clean");
    expect(await readFile(row.terminal!.reportPath, "utf8")).toContain("result: clean");
  });

  test("dispatcher death leaves detached worker and restart does not duplicate it", async () => {
    const options = await fixture();
    const counter = resolve(options.root, "launches");
    process.env.DISPATCH_COUNTER_PATH = counter;
    process.env.DISPATCH_WORK_MS = "150";
    try {
      await expect(dispatchOnce({ ...options, afterLaunch: () => { throw new Error("dispatcher died"); } })).rejects.toThrow("dispatcher died");
      await Bun.sleep(250);
      expect(await reconcileRunning(options)).toBe(1);
      expect(await dispatchOnce(options)).toBeUndefined();
      expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(1);
      expect((await state(options.storePath)).rows[0].state).toBe("terminal");
    } finally {
      delete process.env.DISPATCH_COUNTER_PATH; delete process.env.DISPATCH_WORK_MS;
    }
  });

  test("acknowledgement failure retries boundedly then records loud NO-GO", async () => {
    const options = await fixture(1);
    const snapshot = await state(options.storePath);
    snapshot.rows[0].worker = [process.execPath, "-e", "process.exit(0)"];
    await writeFile(options.storePath, JSON.stringify(snapshot));
    await dispatchOnce({ ...options, acknowledgementMs: 30 });
    expect((await state(options.storePath)).rows[0].state).toBe("ready");
    await dispatchOnce({ ...options, acknowledgementMs: 30 });
    const row = (await state(options.storePath)).rows[0];
    expect(row.state).toBe("terminal");
    expect(row.terminal?.verdict).toBe("NO-GO");
    expect(row.blocker).toContain("acknowledgement");
  });
});

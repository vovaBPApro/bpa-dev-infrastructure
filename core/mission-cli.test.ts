import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directories: string[] = [];
const cli = resolve(import.meta.dir, "mission-cli.ts");

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bpa-mission-cli-"));
  directories.push(directory);
  return join(directory, "nested", "state.sqlite");
}

async function invoke(database: string, ...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: { ...Bun.env, INFRA_STATE_DB: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function missionId(output: string): string {
  const match = /^MISSION id=([^ ]+) state=queued$/.exec(output);
  if (!match) throw new Error(`unexpected mission output: ${output}`);
  return match[1];
}

function token(output: string): number {
  const match = / token=(\d+)$/.exec(output);
  if (!match) throw new Error(`unexpected lease output: ${output}`);
  return Number(match[1]);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("drives a mission and lane through a terminal lifecycle across subprocesses", async () => {
  const database = await databasePath();
  const created = await invoke(database, "mission", "create", "corr-1");
  expect(created).toEqual({ exitCode: 0, stdout: expect.stringMatching(/^MISSION id=.+ state=queued$/), stderr: "" });
  const id = missionId(created.stdout);
  expect(await invoke(database, "lane", "create", id, "lane-1")).toEqual({ exitCode: 0, stdout: `LANE id=lane-1 mission=${id} state=queued`, stderr: "" });
  expect(await invoke(database, "mission", "transition", id, "running")).toEqual({ exitCode: 0, stdout: `MISSION id=${id} state=running`, stderr: "" });
  expect(await invoke(database, "lane", "transition", "lane-1", "running")).toEqual({ exitCode: 0, stdout: `LANE id=lane-1 mission=${id} state=running`, stderr: "" });
  expect(await invoke(database, "lane", "transition", "lane-1", "succeeded")).toEqual({ exitCode: 0, stdout: `LANE id=lane-1 mission=${id} state=succeeded`, stderr: "" });
  expect(await invoke(database, "mission", "transition", id, "succeeded")).toEqual({ exitCode: 0, stdout: `MISSION id=${id} state=succeeded`, stderr: "" });
});

test("reports invalid transitions as one non-zero error line", async () => {
  const database = await databasePath();
  const id = missionId((await invoke(database, "mission", "create", "corr-invalid")).stdout);
  const result = await invoke(database, "mission", "transition", id, "succeeded");
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("ERROR invalid mission transition: queued -> succeeded");
});

test("durably fences expired leases across separate CLI invocations", async () => {
  const database = await databasePath();
  const first = await invoke(database, "lease", "acquire", "owner-a", "shared", "300");
  expect(first.exitCode).toBe(0);
  const firstToken = token(first.stdout);
  const held = await invoke(database, "lease", "acquire", "owner-b", "shared", "300");
  expect(held.exitCode).not.toBe(0);
  expect(held.stderr).toBe("ERROR LEASE-HELD");
  await Bun.sleep(350);
  expect(await invoke(database, "reap")).toEqual({ exitCode: 0, stdout: `REAP key=shared owner=owner-a token=${firstToken}`, stderr: "" });
  const second = await invoke(database, "lease", "acquire", "owner-b", "shared", "1000");
  expect(second.exitCode).toBe(0);
  expect(token(second.stdout)).toBeGreaterThan(firstToken);
  expect(await invoke(database, "lease", "renew", "owner-b", "shared", String(token(second.stdout)))).toEqual({ exitCode: 0, stdout: second.stdout, stderr: "" });
  expect(await invoke(database, "lease", "release", "owner-b", "shared", String(token(second.stdout)))).toEqual({ exitCode: 0, stdout: second.stdout, stderr: "" });
});

test("status reads durable truth after a simulated orchestrator restart", async () => {
  const database = await databasePath();
  const mission = missionId((await invoke(database, "mission", "create", "corr-status")).stdout);
  await invoke(database, "mission", "transition", mission, "running");
  await invoke(database, "lane", "create", mission, "lane-status");
  await invoke(database, "lane", "transition", "lane-status", "running");
  await invoke(database, "lease", "acquire", "restart-owner", "restart-key", "1000");
  const restarted = await invoke(database, "status");
  expect(restarted).toEqual({ exitCode: 0, stdout: expect.any(String), stderr: "" });
  const state = JSON.parse(restarted.stdout) as { missions: Array<{ id: string; state: string }>; lanes: Array<{ id: string; state: string }>; leases: Array<{ key: string; owner: string }> };
  expect(state.missions).toEqual([expect.objectContaining({ id: mission, state: "running" })]);
  expect(state.lanes).toEqual([expect.objectContaining({ id: "lane-status", state: "running" })]);
  expect(state.leases).toEqual([expect.objectContaining({ key: "restart-key", owner: "restart-owner" })]);
});

test("status exposes persisted failures after restart", async () => {
  const database = await databasePath();
  const mission = missionId((await invoke(database, "mission", "create", "corr-failed")).stdout);
  expect(await invoke(database, "mission", "transition", mission, "running")).toEqual({
    exitCode: 0, stdout: `MISSION id=${mission} state=running`, stderr: "",
  });
  expect(await invoke(database, "lane", "create", mission, "lane-failed")).toEqual({
    exitCode: 0, stdout: `LANE id=lane-failed mission=${mission} state=queued`, stderr: "",
  });
  expect(await invoke(database, "lane", "transition", "lane-failed", "failed")).toEqual({
    exitCode: 0, stdout: `LANE id=lane-failed mission=${mission} state=failed`, stderr: "",
  });
  expect(await invoke(database, "mission", "transition", mission, "failed")).toEqual({
    exitCode: 0, stdout: `MISSION id=${mission} state=failed`, stderr: "",
  });

  const restarted = await invoke(database, "status");
  const state = JSON.parse(restarted.stdout) as { missions: Array<{ id: string; state: string }>; lanes: Array<{ id: string; state: string }> };
  expect(state.missions).toEqual([expect.objectContaining({ id: mission, state: "failed" })]);
  expect(state.lanes).toEqual([expect.objectContaining({ id: "lane-failed", state: "failed" })]);

  const emptyDatabase = await databasePath();
  const healthy = await invoke(emptyDatabase, "status");
  expect(restarted.stdout).not.toBe(healthy.stdout);
});

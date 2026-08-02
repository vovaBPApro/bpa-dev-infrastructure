import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type MissionVerdict = "clean" | "NO-GO";

export interface DispatchRow {
  id: string;
  state: "ready" | "claimed" | "running" | "terminal";
  worker: string[];
  retryBudget: number;
  attempt: number;
  ownerToken?: string;
  leaseDeadline?: string;
  workerPid?: number;
  acknowledgement?: { at: string; attempt: number };
  semanticProgress?: { at: string; evidencePath: string };
  terminal?: { at: string; reportPath: string; sha: string; verdict: MissionVerdict };
  blocker?: string;
}

export interface DispatchSnapshot { rows: DispatchRow[] }

export interface DispatchOptions {
  storePath: string;
  runtimeDir: string;
  leaseMs?: number;
  acknowledgementMs?: number;
  terminalMs?: number;
  now?: () => Date;
  afterLaunch?: (row: DispatchRow) => void | Promise<void>;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const attemptDir = (runtimeDir: string, row: DispatchRow) =>
  resolve(runtimeDir, row.id, `attempt-${row.attempt}`);

async function load(path: string): Promise<DispatchSnapshot> {
  return JSON.parse(await readFile(path, "utf8")) as DispatchSnapshot;
}

async function save(path: string, value: DispatchSnapshot): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function locked<T>(storePath: string, action: (state: DispatchSnapshot) => Promise<T>): Promise<T> {
  const lock = `${storePath}.lock`;
  await mkdir(dirname(storePath), { recursive: true });
  for (let index = 0; ; index++) {
    try {
      await mkdir(lock);
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST" || index >= 200) throw error;
      await sleep(5);
    }
  }
  try {
    const state = await load(storePath);
    const result = await action(state);
    await save(storePath, state);
    return result;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function claimOne(options: DispatchOptions): Promise<DispatchRow | undefined> {
  const now = options.now?.() ?? new Date();
  return locked(options.storePath, async (snapshot) => {
    const row = snapshot.rows.find((candidate) => candidate.state === "ready");
    if (!row) return undefined;
    row.attempt += 1;
    row.state = "claimed";
    row.ownerToken = crypto.randomUUID();
    row.leaseDeadline = new Date(now.getTime() + (options.leaseMs ?? 30_000)).toISOString();
    delete row.blocker;
    return structuredClone(row);
  });
}

async function updateOwned(options: DispatchOptions, claimed: DispatchRow, mutate: (row: DispatchRow) => void): Promise<boolean> {
  return locked(options.storePath, async (snapshot) => {
    const row = snapshot.rows.find((candidate) => candidate.id === claimed.id);
    if (!row || row.ownerToken !== claimed.ownerToken || row.attempt !== claimed.attempt) return false;
    mutate(row);
    return true;
  });
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await exists(path)) return true;
    await sleep(10);
  } while (Date.now() < deadline);
  return exists(path);
}

async function failOrRetry(options: DispatchOptions, claimed: DispatchRow, reason: string): Promise<void> {
  await updateOwned(options, claimed, (row) => {
    row.blocker = reason;
    delete row.ownerToken;
    delete row.leaseDeadline;
    if (row.attempt <= row.retryBudget) row.state = "ready";
    else {
      row.state = "terminal";
      row.terminal = {
        at: new Date().toISOString(), reportPath: "", sha: "", verdict: "NO-GO",
      };
    }
  });
}

/** Claims and advances at most one row. Safe to call after dispatcher restart. */
export async function dispatchOnce(options: DispatchOptions): Promise<DispatchRow | undefined> {
  const claimed = await claimOne(options);
  if (!claimed) return undefined;
  const dir = attemptDir(options.runtimeDir, claimed);
  await mkdir(dir, { recursive: true });
  const ackPath = resolve(dir, "ack.json");
  const terminalPath = resolve(dir, "terminal.json");
  const artifactPath = resolve(dir, "artifact.txt");
  const log = await open(resolve(dir, "worker.log"), "a");
  const child = Bun.spawn(claimed.worker, {
    cwd: process.cwd(), stdin: "ignore", stdout: log.fd, stderr: log.fd,
    env: { ...process.env, DISPATCH_ACK_PATH: ackPath, DISPATCH_TERMINAL_PATH: terminalPath,
      DISPATCH_ARTIFACT_PATH: artifactPath, DISPATCH_ATTEMPT: String(claimed.attempt) },
  });
  child.unref();
  await updateOwned(options, claimed, (row) => { row.state = "running"; row.workerPid = child.pid; });
  await options.afterLaunch?.(claimed);

  if (!(await waitFor(ackPath, options.acknowledgementMs ?? 2_000))) {
    await failOrRetry(options, claimed, "worker acknowledgement timed out");
    return claimed;
  }
  const acknowledgement = JSON.parse(await readFile(ackPath, "utf8"));
  if (acknowledgement.attempt !== claimed.attempt) {
    await failOrRetry(options, claimed, "worker acknowledgement attempt mismatch");
    return claimed;
  }
  await updateOwned(options, claimed, (row) => {
    row.acknowledgement = acknowledgement;
    row.semanticProgress = { at: acknowledgement.at, evidencePath: ackPath };
  });

  if (!(await waitFor(terminalPath, options.terminalMs ?? 5_000))) {
    await failOrRetry(options, claimed, "worker terminal evidence timed out");
    return claimed;
  }
  const terminal = JSON.parse(await readFile(terminalPath, "utf8"));
  if (!(await exists(terminal.reportPath)) || !terminal.sha || !["clean", "NO-GO"].includes(terminal.verdict)) {
    await failOrRetry(options, claimed, "worker terminal evidence invalid");
    return claimed;
  }
  await updateOwned(options, claimed, (row) => {
    row.state = "terminal";
    row.terminal = terminal;
    row.semanticProgress = { at: terminal.at, evidencePath: terminal.reportPath };
    delete row.ownerToken;
    delete row.leaseDeadline;
  });
  return claimed;
}

/** Reconciles evidence left by a detached worker without launching another worker. */
export async function reconcileRunning(options: DispatchOptions): Promise<number> {
  const snapshot = await load(options.storePath);
  let reconciled = 0;
  for (const row of snapshot.rows.filter((candidate) => candidate.state === "running")) {
    const terminalPath = resolve(attemptDir(options.runtimeDir, row), "terminal.json");
    if (!(await exists(terminalPath))) continue;
    const terminal = JSON.parse(await readFile(terminalPath, "utf8"));
    if (!(await exists(terminal.reportPath)) || !terminal.sha || !["clean", "NO-GO"].includes(terminal.verdict)) continue;
    if (await updateOwned(options, row, (current) => {
      current.state = "terminal"; current.terminal = terminal;
      current.semanticProgress = { at: terminal.at, evidencePath: terminal.reportPath };
      delete current.ownerToken; delete current.leaseDeadline;
    })) reconciled++;
  }
  return reconciled;
}

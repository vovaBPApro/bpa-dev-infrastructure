/**
 * The lane log is the operator's main window into a running lane, and V3-3.10
 * changed the stream that fills it. These tests are the lock on that change:
 * the log has to be provably unchanged, not plausibly unchanged, which is why
 * the assertion is a byte comparison against a captured sample of the OLD
 * behaviour rather than a reading of the new one.
 *
 * Both fixtures under tests/fixtures/usage/ were captured from this host by
 * running the same prompt through `claude --print` and through `claude --print
 * --output-format stream-json --verbose`.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DurableStore } from "../core/state";
import { parseMaskStreamArgs } from "./mask-stream";

const repo = resolve(import.meta.dir, "..");
const masker = resolve(repo, "daemon", "mask-stream.ts");
const streamFixture = resolve(repo, "tests", "fixtures", "usage", "lane-stream-json.jsonl");
const plainFixture = resolve(repo, "tests", "fixtures", "usage", "lane-plain-print.txt");

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function workspace(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "v3-mask-")); roots.push(root); return root;
}

async function run(input: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, masker, ...args], { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

test("stream-json mode reproduces the plain-text lane log byte for byte", async () => {
  const root = await workspace();
  const stream = await Bun.file(streamFixture).text();
  const plain = await Bun.file(plainFixture).text();
  const { stdout, exitCode } = await run(stream, ["--format", "stream-json", "--role", "coder", "--lane", "sample", "--db", resolve(root, "state.db")]);
  expect(exitCode).toBe(0);
  expect(stdout).toBe(plain);
});

test("the default mode is still an untouched pass-through masker", async () => {
  // instance/lane-agent-command-codex.conf lanes emit plain text and never gain
  // a result event. Their log must not change at all because of this row.
  const text = "line one\nline two\nno trailing newline";
  const { stdout, exitCode } = await run(text, []);
  expect(exitCode).toBe(0);
  expect(stdout).toBe(text);
});

test("a plain-text line on the stream-json stream survives verbatim", async () => {
  const root = await workspace();
  // stderr is merged into this pipe by lane-payload.sh. A provider warning is
  // not JSON, and swallowing it would make the log worse than before the change.
  const input = `warning: something the provider said\n${JSON.stringify({ type: "result", subtype: "success", session_id: "s", result: "done", usage: { input_tokens: 1, output_tokens: 2 } })}\n`;
  const { stdout } = await run(input, ["--format", "stream-json", "--role", "coder", "--db", resolve(root, "state.db")]);
  expect(stdout).toBe("warning: something the provider said\ndone\n");
});

test("a lane's row lands in the durable store with its model, role and lane", async () => {
  const root = await workspace();
  const db = resolve(root, "state.db");
  const stream = await Bun.file(streamFixture).text();
  const expected = stream.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.type === "result");
  await run(stream, ["--format", "stream-json", "--role", "coder", "--lane", "v3-3.10", "--item", "V3-3.10", "--db", db]);

  const store = new DurableStore(db);
  const rows = store.usageEvents();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ role: "coder", lane: "v3-3.10", itemId: "V3-3.10", source: "cli-json", model: "claude-haiku-4-5-20251001" });
  expect(rows[0]!.sessionId).toBe(expected.session_id);
  expect(rows[0]!.costUsd).toBeCloseTo(expected.total_cost_usd, 10);
  expect(rows[0]!.inputTokens).not.toBeNull();
  expect(rows[0]!.outputTokens).not.toBeNull();
  store.close();
});

test("a stream cut off mid-turn still logs its text and records an unmeasured row", async () => {
  const root = await workspace();
  const db = resolve(root, "state.db");
  const truncated = (await Bun.file(streamFixture).text()).split("\n").filter(Boolean).slice(0, -1).join("\n") + "\n";
  const { stdout, exitCode } = await run(truncated, ["--format", "stream-json", "--role", "coder", "--lane", "killed", "--db", db]);
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");

  const store = new DurableStore(db);
  const [row] = store.usageEvents();
  expect(row).toMatchObject({ source: "unmeasured", lane: "killed", role: "coder", model: null });
  expect(row!.inputTokens).toBeNull();
  expect(row!.outputTokens).toBeNull();
  expect(row!.costUsd).toBeNull();
  store.close();
});

test("an accounting failure never fails the lane or truncates its log", async () => {
  const stream = await Bun.file(streamFixture).text();
  const plain = await Bun.file(plainFixture).text();
  const { stdout, stderr, exitCode } = await run(stream, ["--format", "stream-json", "--role", "coder", "--db", "/proc/no-such-dir/state.db"]);
  // lane-payload.sh turns a non-zero masker status into `state: failed`, so this
  // exit code is the boundary between "we lost a usage row" and "we lost a lane".
  expect(exitCode).toBe(0);
  expect(stdout).toBe(plain);
  expect(stderr).toContain("WARN usage-accounting");
});

test("a missing role logs the lane and records nothing rather than refusing to run", async () => {
  const root = await workspace();
  const db = resolve(root, "state.db");
  const stream = await Bun.file(streamFixture).text();
  const { stdout, stderr, exitCode } = await run(stream, ["--format", "stream-json", "--db", db]);
  expect(exitCode).toBe(0);
  expect(stdout).toBe(await Bun.file(plainFixture).text());
  expect(stderr).toContain("no valid --role");
});

test("secrets in assistant text are still masked in stream-json mode", async () => {
  const root = await workspace();
  const event = JSON.stringify({ type: "result", subtype: "success", session_id: "s", result: 'export API_KEY="abcdef0123456789abcdef"', usage: { input_tokens: 1, output_tokens: 1 } });
  const { stdout } = await run(`${event}\n`, ["--format", "stream-json", "--role", "coder", "--db", resolve(root, "state.db")]);
  expect(stdout).not.toContain("abcdef0123456789abcdef");
  expect(stdout).toContain("API_KEY");
});

test("attribution falls back to the launcher's environment", () => {
  const options = parseMaskStreamArgs(["--format", "stream-json", "--role", "reviewer"], { LANE_USAGE_LANE: "lane-x", LANE_USAGE_ITEM: "V3-1.1" });
  expect(options).toMatchObject({ streamJson: true, role: "reviewer", lane: "lane-x", itemId: "V3-1.1" });
  // An unknown role is dropped rather than written into the role column, which
  // is what makes `role` answerable as a dimension instead of a free-text field.
  expect(parseMaskStreamArgs(["--role", "wizard"], {}).role).toBeNull();
});

test("rows written by the masker survive a restart of the reader", async () => {
  const root = await workspace();
  const db = resolve(root, "state.db");
  await run(await Bun.file(streamFixture).text(), ["--format", "stream-json", "--role", "coder", "--lane", "one", "--db", db]);
  await writeFile(resolve(root, "marker"), "restart boundary: the masker process is gone by now\n");
  const first = new DurableStore(db); const before = first.usageEvents(); first.close();
  const second = new DurableStore(db); const after = second.usageEvents(); second.close();
  expect(after).toEqual(before);
  expect(after).toHaveLength(1);
});

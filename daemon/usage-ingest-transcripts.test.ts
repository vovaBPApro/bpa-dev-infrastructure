import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, rowsFromTranscript, transcriptDirFor } from "./usage-ingest-transcripts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const options = { role: "orchestrator" as const, entrypoints: ["cli"] };
const assistant = (over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => JSON.stringify({
  type: "assistant", entrypoint: "cli", sessionId: "s1", timestamp: "2026-08-05T04:00:00.000Z",
  message: {
    model: "claude-opus-5", id: "msg_1", role: "assistant", content: [],
    usage: { input_tokens: 1, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 900, service_tier: "standard" },
    ...message,
  },
  ...over,
});

test("one API response split across several records is one row, not several", () => {
  // 335 of 633 message ids in the orchestrator's real transcript repeat like
  // this. Summing them would multiply its spend by however many content blocks
  // the response happened to carry.
  const { rows } = rowsFromTranscript([assistant(), assistant(), assistant()].join("\n"), options);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ model: "claude-opus-5", role: "orchestrator", inputTokens: 1, outputTokens: 20, cacheReadInputTokens: 900 });
});

test("the fullest report of a response wins over a partial one", () => {
  const partial = assistant({}, { usage: { input_tokens: 1, output_tokens: 4 } });
  const { rows } = rowsFromTranscript([partial, assistant()].join("\n"), options);
  expect(rows[0]!.outputTokens).toBe(20);
});

test("cost is null rather than guessed, because this source does not report it", () => {
  const { rows } = rowsFromTranscript(assistant(), options);
  expect(rows[0]!.costUsd).toBeNull();
  expect(rows[0]!.source).toBe("cli-json");
});

test("lane transcripts are excluded by default so lanes are not counted twice", () => {
  // `claude --print` records itself as sdk-cli, and the masker already measured
  // those turns at the point of use.
  const lane = assistant({ entrypoint: "sdk-cli" });
  expect(rowsFromTranscript(lane, options).rows).toHaveLength(0);
  expect(rowsFromTranscript(lane, { ...options, entrypoints: null }).rows).toHaveLength(1);
});

test("a synthetic message is not a model invocation", () => {
  const { rows, skipped } = rowsFromTranscript(assistant({}, { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } }), options);
  expect(rows).toHaveLength(0);
  expect(skipped).toBe(1);
});

test("a record with no usage block is skipped rather than recorded as zero", () => {
  const { rows, skipped } = rowsFromTranscript(assistant({}, { usage: undefined }), options);
  expect(rows).toHaveLength(0);
  expect(skipped).toBe(1);
});

test("a missing cache field is null, never zero", () => {
  const { rows } = rowsFromTranscript(assistant({}, { usage: { input_tokens: 3, output_tokens: 4 } }), options);
  expect(rows[0]).toMatchObject({ inputTokens: 3, outputTokens: 4, cacheCreationInputTokens: null, cacheReadInputTokens: null });
});

test("a malformed line is counted and skipped instead of stopping the ingest", () => {
  const { rows, skipped } = rowsFromTranscript(`not json\n${assistant()}`, options);
  expect(rows).toHaveLength(1);
  expect(skipped).toBe(1);
});

test("the window bounds which records are ingested", () => {
  const early = assistant({ timestamp: "2026-08-04T00:00:00.000Z" }, { id: "msg_early" });
  const contents = [early, assistant()].join("\n");
  expect(rowsFromTranscript(contents, { ...options, since: Date.parse("2026-08-05T00:00:00Z") }).rows.map((r) => r.eventId)).toEqual(["msg_1"]);
  expect(rowsFromTranscript(contents, { ...options, until: Date.parse("2026-08-05T00:00:00Z") }).rows.map((r) => r.eventId)).toEqual(["msg_early"]);
});

test("the transcript directory is derived from the working directory, not hard-coded", () => {
  expect(transcriptDirFor("/root/bpa-dev-infrastructure", "/p")).toBe("/p/-root-bpa-dev-infrastructure");
  // A dotted path segment becomes a hyphen too, which is why a lane worktree
  // under .cache resolves with a doubled hyphen.
  expect(transcriptDirFor("/root/.cache/infra-lanes/v3-3.10", "/p")).toBe("/p/-root--cache-infra-lanes-v3-3-10");
});

test("a role outside the closed set is refused rather than written into the column", () => {
  expect(() => parseArgs(["--cwd", "/tmp", "--role", "wizard"])).toThrow(/--role must be/);
  expect(() => parseArgs(["--role", "orchestrator"])).toThrow(/--cwd or --project-dir/);
  expect(() => parseArgs(["--cwd", "/tmp", "--since", "not-a-date"])).toThrow(/ISO-8601/);
});

test("the ingester is idempotent across runs against a real store", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "v3-ingest-")); roots.push(root);
  const { DurableStore } = await import("../core/state");
  const store = new DurableStore(resolve(root, "state.db"));
  const { rows } = rowsFromTranscript([assistant(), assistant({ sessionId: "s2" }, { id: "msg_2" })].join("\n"), options);
  expect(rows.map((row) => store.recordUsage(row))).toEqual([true, true]);
  expect(rows.map((row) => store.recordUsage(row))).toEqual([false, false]);
  expect(store.queryUsage()[0]).toMatchObject({ events: 2 });
  store.close();
});

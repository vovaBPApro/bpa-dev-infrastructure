import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DurableStore } from "../core/state";
import { LaneUsageCollector, usageFromResultEvent } from "./usage-capture";
import { recordUsageRows } from "./usage-sink";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function store(): Promise<{ path: string; open: () => DurableStore }> {
  const root = await mkdtemp(resolve(tmpdir(), "v3-usage-")); roots.push(root);
  const path = resolve(root, "state.db");
  return { path, open: () => new DurableStore(path) };
}

const fixture = resolve(import.meta.dir, "..", "tests", "fixtures", "usage", "lane-stream-json.jsonl");
async function fixtureLines(): Promise<string[]> {
  return (await Bun.file(fixture).text()).split("\n").filter(Boolean).map((line) => `${line}\n`);
}
async function resultEvent(): Promise<Record<string, unknown>> {
  return (await fixtureLines()).map((line) => JSON.parse(line)).find((event) => event.type === "result");
}

test("a real result event yields a row per reported model, with the CLI's own cost", async () => {
  const event = await resultEvent();
  const rows = usageFromResultEvent(event, { role: "coder", lane: "v3-3.10" });
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row!.model).toBe("claude-haiku-4-5-20251001");
  expect(row!.role).toBe("coder");
  expect(row!.lane).toBe("v3-3.10");
  expect(row!.source).toBe("cli-json");
  // The per-model costs are the breakdown of the CLI's own total, so the row's
  // cost must reconcile against total_cost_usd rather than merely look plausible.
  expect(rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)).toBeCloseTo(event.total_cost_usd as number, 10);
  expect(row!.inputTokens).toBeGreaterThan(0);
  expect(row!.outputTokens).toBeGreaterThan(0);
});

test("cache tokens are stored separately from input tokens", async () => {
  const [row] = usageFromResultEvent(await resultEvent(), { role: "coder" });
  // The turn that produced this fixture created 26609 cache tokens against 531
  // input tokens. Collapsing the two would misprice the caching behaviour that
  // makes long lanes affordable, which is the reason the spec separates them.
  expect(row!.cacheCreationInputTokens).toBe(26609);
  expect(row!.cacheReadInputTokens).toBe(0);
  expect(row!.inputTokens).not.toBe(row!.cacheCreationInputTokens);
});

test("an absent usage block is unmeasured with null counts, never zero", () => {
  const rows = usageFromResultEvent({ type: "result", session_id: "s1", subtype: "success" }, { role: "coder", lane: "l" });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    source: "unmeasured", model: null, inputTokens: null, outputTokens: null,
    cacheCreationInputTokens: null, cacheReadInputTokens: null, costUsd: null, serviceTier: null,
  });
});

test("a usage block reporting only some fields nulls the rest instead of defaulting them to zero", () => {
  const rows = usageFromResultEvent({
    type: "result", session_id: "s1", total_cost_usd: 0.5,
    usage: { input_tokens: 7, output_tokens: 9 },
  }, { role: "reviewer" }, "claude-opus-5");
  expect(rows[0]).toMatchObject({
    model: "claude-opus-5", source: "cli-json", inputTokens: 7, outputTokens: 9,
    cacheCreationInputTokens: null, cacheReadInputTokens: null, costUsd: 0.5,
  });
});

test("the model is the one the stream reported, not one the caller supplies", () => {
  // HR-2315 lets the configured model and the running model differ, so a row
  // that recorded the configured value would be quietly wrong exactly when the
  // question ("what does this tier cost?") is being asked.
  const [row] = usageFromResultEvent({
    type: "result", usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { "claude-sonnet-5": { inputTokens: 3, outputTokens: 4, costUSD: 0.01 } },
  }, { role: "coder" }, "claude-opus-5");
  expect(row!.model).toBe("claude-sonnet-5");
});

test("a multi-model session produces one row per model", () => {
  const rows = usageFromResultEvent({
    type: "result", session_id: "s", total_cost_usd: 0.3,
    modelUsage: {
      "claude-opus-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 6, costUSD: 0.2 },
      "claude-haiku-4-5": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1 },
    },
  }, { role: "coder" });
  expect(rows.map((r) => r.model).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
  expect(rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)).toBeCloseTo(0.3, 10);
});

test("a stream that ends with no result event records the killed turn as unmeasured", () => {
  const collector = new LaneUsageCollector({ role: "coder", lane: "killed" });
  collector.observe(`${JSON.stringify({ type: "assistant", message: { model: "claude-opus-5", content: [] } })}\n`);
  const rows = collector.finish();
  expect(rows).toHaveLength(1);
  // The side-channel design the spec rejected would have recorded nothing here.
  expect(rows[0]).toMatchObject({ source: "unmeasured", lane: "killed", model: null, inputTokens: null, costUsd: null });
});

test("the store refuses a zero filed as an unobserved value", async () => {
  const { open } = await store();
  const s = open();
  expect(() => s.recordUsage({
    model: null, role: "coder", inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, source: "unmeasured",
  })).toThrow(/never zero/);
  expect(() => s.recordUsage({
    model: null, role: "coder", inputTokens: null, outputTokens: null,
    cacheCreationInputTokens: null, cacheReadInputTokens: null, costUsd: null, source: "cli-json",
  })).toThrow(/must carry the reported model/);
  s.close();
});

test("the unmeasured rule survives a caller that bypasses the store's own validation", async () => {
  const { open } = await store();
  const s = open();
  // The TypeScript guard is the readable refusal; the table CHECK is the one
  // that holds when a future writer reaches the database another way.
  expect(() => s.db.query(`INSERT INTO usage_events
    (observed_at, model, role, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd, source)
    VALUES (1, NULL, 'coder', 0, 0, 0, 0, 0, 'unmeasured')`).run()).toThrow(/CHECK|constraint/i);
  s.close();
});

test("rows survive closing and reopening the database", async () => {
  const { path, open } = await store();
  const first = open();
  first.recordUsage({ model: "claude-opus-5", role: "orchestrator", lane: null, inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4, costUsd: 0.5, sessionId: "s", eventId: "m1", source: "cli-json", observedAt: 1_000 });
  first.close();
  const second = open();
  expect(second.usageEvents()).toHaveLength(1);
  expect(second.queryUsage({ groupBy: ["role"] })[0]).toMatchObject({ role: "orchestrator", costUsd: 0.5, measuredEvents: 1 });
  second.close();
});

test("recording the same provider record twice does not double the bill", async () => {
  const { open } = await store();
  const s = open();
  const row = { model: "claude-opus-5", role: "orchestrator" as const, inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: null, cacheReadInputTokens: null, costUsd: 0.25, sessionId: "s1", eventId: "msg_1", source: "cli-json" as const };
  expect(s.recordUsage(row)).toBe(true);
  expect(s.recordUsage(row)).toBe(false);
  expect(s.queryUsage()[0]).toMatchObject({ events: 1, costUsd: 0.25 });
  s.close();
});

test("the series groups by model and by role across a window spanning more than one lane", async () => {
  const { open } = await store();
  const s = open();
  const hour = 3_600_000;
  s.recordUsage({ model: "claude-opus-5", role: "coder", lane: "a", inputTokens: 10, outputTokens: 1, cacheCreationInputTokens: 100, cacheReadInputTokens: 5, costUsd: 1, sessionId: "a", eventId: "result", source: "cli-json", observedAt: hour });
  s.recordUsage({ model: "claude-sonnet-5", role: "coder", lane: "b", inputTokens: 20, outputTokens: 2, cacheCreationInputTokens: 200, cacheReadInputTokens: 6, costUsd: 2, sessionId: "b", eventId: "result", source: "cli-json", observedAt: hour + 60_000 });
  s.recordUsage({ model: "claude-opus-5", role: "orchestrator", lane: null, inputTokens: 30, outputTokens: 3, cacheCreationInputTokens: 300, cacheReadInputTokens: 7, costUsd: 4, sessionId: "c", eventId: "m", source: "cli-json", observedAt: hour * 2 });
  s.recordUsage({ model: null, role: "coder", lane: "c", inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, costUsd: null, source: "unmeasured", observedAt: hour * 2 });

  expect(s.queryUsage({ groupBy: ["model"] }).map((r) => [r.model, r.costUsd])).toEqual([[null, null], ["claude-opus-5", 5], ["claude-sonnet-5", 2]]);
  expect(s.queryUsage({ groupBy: ["role"] }).map((r) => [r.role, r.costUsd])).toEqual([["coder", 3], ["orchestrator", 4]]);
  expect(s.queryUsage({ groupBy: ["hour"] }).map((r) => r.hour)).toEqual(["1970-01-01T01:00Z", "1970-01-01T02:00Z"]);
  // The window excludes the first hour entirely.
  expect(s.queryUsage({ since: hour * 2, groupBy: ["role"] }).map((r) => [r.role, r.costUsd])).toEqual([["coder", null], ["orchestrator", 4]]);
  // An unmeasured turn is counted but never summed as zero.
  const unmeasuredBucket = s.queryUsage({ since: hour * 2, groupBy: ["role"] })[0]!;
  expect(unmeasuredBucket).toMatchObject({ events: 1, measuredEvents: 0, unmeasuredEvents: 1, costUsd: null });
  s.close();
});

test("the sink reports an unusable database instead of throwing into the lane", () => {
  const result = recordUsageRows([{
    model: "claude-opus-5", role: "coder", inputTokens: 1, outputTokens: 1,
    cacheCreationInputTokens: null, cacheReadInputTokens: null, costUsd: 0.1, source: "cli-json",
  }], { dbPath: "/proc/definitely-not-writable/state.db" });
  expect(result.recorded).toBe(0);
  expect(result.error).toBeTruthy();
});

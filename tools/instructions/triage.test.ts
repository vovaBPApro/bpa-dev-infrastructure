import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendVerdict, dischargeAnswer, surfaceTriage } from "./triage.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture(ts: string): string {
  const root = mkdtempSync(join(tmpdir(), "triage-action-"));
  roots.push(root);
  mkdirSync(join(root, "instance", "decisions"), { recursive: true });
  mkdirSync(join(root, "gate"));
  writeFileSync(join(root, "gate", "land-lib.sh"), readFileSync(join(import.meta.dir, "../../gate/land-lib.sh")));
  writeFileSync(join(root, "instance", "decisions", "inbox.jsonl"), `${JSON.stringify({ msg_id: 700, ts, text: "Which format should I send?" })}\n`);
  writeFileSync(join(root, "instance", "decisions", "triage.jsonl"), "");
  return root;
}

test("regression: untriaged inbound surfaces before 24h, then a verdict clears it", () => {
  const now = Date.parse("2026-07-31T12:00:00Z");
  const root = fixture(new Date(now - 21 * 3_600_000).toISOString());
  expect(surfaceTriage(root, now)).toEqual([expect.objectContaining({ msgId: "700", kind: "untriaged", text: "Which format should I send?" })]);
  appendVerdict(root, { msg_id: 700, verdict: "directive", category: "external-source", reason: "format-question", triaged_by: "orchestrator", triaged_at: "2026-07-31", answer_status: "answered" });
  expect(surfaceTriage(root, now)).toEqual([]);
});

test("an owed answer keeps surfacing until explicitly discharged", () => {
  const now = Date.parse("2026-07-31T12:00:00Z");
  const root = fixture(new Date(now - 2 * 3_600_000).toISOString());
  appendVerdict(root, { msg_id: 700, verdict: "directive", category: "external-source", reason: "format-question", triaged_by: "orchestrator", triaged_at: "2026-07-31", answer_status: "owed" });
  expect(surfaceTriage(root, now)[0]).toEqual(expect.objectContaining({ kind: "answer-owed" }));
  dischargeAnswer(root, "700");
  expect(surfaceTriage(root, now)).toEqual([]);
});

test("append uses the shared schema validator and preserves the inbox quote", () => {
  const root = fixture("2026-07-31T00:00:00Z");
  expect(() => appendVerdict(root, { msg_id: 700, verdict: "directive", category: "free text", reason: "bad", triaged_by: "orchestrator", triaged_at: "2026-07-31", answer_status: "answered" })).toThrow("category and reason must be category-only");
  expect(readFileSync(join(root, "instance", "decisions", "triage.jsonl"), "utf8")).toBe("");
});

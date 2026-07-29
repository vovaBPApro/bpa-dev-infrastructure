// Decisions-ledger aging checks (INSTRUCTIONS_CONSILIUM_FINAL.md §2.4, §2.5
// "ledger aging"). Two independent checks, both surfaced by tools/instructions/
// check.ts as `[ledger]` findings:
//
//   (a) Triage/inbox aging — a raw inbox.jsonl row (an inbound Human message
//       auto-mirrored by the daemon, daemon/inbox-mirror.ts) that has neither a
//       routed HR file (instance/decisions/HR-<msg_id>.md) nor a triage verdict
//       (triage.jsonl row) AND is older than 24h is an untriaged directive at
//       risk of B276-class loss: FAIL under --strict, WARN otherwise. Missing
//       inbox.jsonl means the daemon mirror is not live yet: SKIP.
//
//   (b) HR pending aging — an HR file left `state: pending` past a 72h SLA (by
//       its `date:` field) is a capture that never got routed: FAIL, unless the
//       frontmatter carries BOTH `parked:` and `review-by:`. A parked row whose
//       `review-by:` date is in the past re-reddens: FAIL again. No
//       green-and-lost-forever loophole.
//
// Time source is the caller's clock, injected as `nowMs` so the check is
// deterministic under test. Thresholds are the constants below.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const INBOX_TRIAGE_SLA_MS = 24 * 60 * 60 * 1000; // 24h
export const HR_PENDING_SLA_MS = 72 * 60 * 60 * 1000; // 72h

export type LedgerLevel = "FAIL" | "WARN" | "SKIP" | "PASS";
export type LedgerFinding = { level: LedgerLevel; file: string; detail: string };

type InboxRow = { msg_id: number | string; ts: string };
type TriageRow = { msg_id: number | string; verdict: string };

// Reads and JSON-parses a .jsonl file, skipping blank/garbled lines silently:
// a runtime append log can have a torn last line and must not crash the gate.
function readJsonl<T>(path: string): T[] {
  const rows: T[] = [];
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      /* torn/garbled line — skip, never crash the checker */
    }
  }
  return rows;
}

// Set of msg-ids that already have a routed HR file (HR-<msgid>.md). The daemon
// mirrors numeric Telegram msg-ids; HR files are named HR-<msgid>.md. Match on
// the numeric/string id embedded in the filename.
function routedMsgIds(decisionsDir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(decisionsDir)) return ids;
  for (const entry of readdirSync(decisionsDir)) {
    const match = entry.match(/^HR-(.+)\.md$/i);
    if (match) ids.add(match[1]);
  }
  return ids;
}

// Parses `date:` and (optionally) `state:`, `parked:`, `review-by:` from an HR
// file's frontmatter. Uses a deliberately small line scan — the same subset the
// rest of this checker relies on — rather than a YAML dependency.
export type HrFields = {
  state?: string;
  date?: string;
  parked?: string;
  reviewBy?: string;
};

export function parseHrFields(contents: string): HrFields {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields: HrFields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim().replace(/^["']|["']$/g, "");
    if (key === "state") fields.state = value;
    else if (key === "date") fields.date = value;
    else if (key === "parked") fields.parked = value;
    else if (key === "review-by") fields.reviewBy = value;
  }
  return fields;
}

// Parses a YYYY-MM-DD (or full ISO) date to epoch ms; NaN if unparseable.
function toMs(value: string | undefined): number {
  if (!value) return NaN;
  const ms = Date.parse(value);
  return ms;
}

// (a) Inbox triage aging. Returns one finding per aged, untriaged row, plus a
// single SKIP when inbox.jsonl is absent. `strict` decides FAIL vs WARN.
export function checkInboxAging(
  repo: string,
  nowMs: number,
  strict: boolean,
): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  const decisionsDir = join(repo, "instance", "decisions");
  const inboxPath = join(decisionsDir, "inbox.jsonl");
  if (!existsSync(inboxPath)) {
    return [{ level: "SKIP", file: "instance/decisions/inbox.jsonl", detail: "no inbox.jsonl (daemon mirror not live yet)" }];
  }

  const rows = readJsonl<InboxRow>(inboxPath);
  const routed = routedMsgIds(decisionsDir);

  const triagePath = join(decisionsDir, "triage.jsonl");
  const triaged = new Set<string>();
  if (existsSync(triagePath)) {
    for (const row of readJsonl<TriageRow>(triagePath)) {
      // Any recorded verdict (chatter OR directive) triages the row: it is no
      // longer an unrouted-unknown. A `directive` verdict still expects an HR
      // file, but that is the reconciliation sweep's job, not aging.
      if (row && row.msg_id !== undefined) triaged.add(String(row.msg_id));
    }
  }

  let aged = 0;
  for (const row of rows) {
    const id = String(row.msg_id);
    if (routed.has(id) || triaged.has(id)) continue;
    const ageMs = nowMs - toMs(row.ts);
    if (!Number.isFinite(ageMs)) continue; // unparseable ts — cannot age it
    if (ageMs > INBOX_TRIAGE_SLA_MS) {
      aged += 1;
      findings.push({
        level: strict ? "FAIL" : "WARN",
        file: `inbox.jsonl:msg ${id}`,
        detail: `untriaged inbound >24h with no HR-${id}.md and no triage verdict`,
      });
    }
  }
  if (aged === 0) {
    findings.push({ level: "PASS", file: "instance/decisions/inbox.jsonl", detail: `${rows.length} rows, none aged untriaged` });
  }
  return findings;
}

// (b) HR pending aging. FAIL for a `state: pending` HR older than 72h unless
// parked with a review-by; FAIL for a parked HR whose review-by is in the past.
export function checkHrAging(repo: string, nowMs: number): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  const decisionsDir = join(repo, "instance", "decisions");
  if (!existsSync(decisionsDir)) {
    return [{ level: "SKIP", file: "instance/decisions/", detail: "no decisions ledger" }];
  }

  let checked = 0;
  for (const entry of readdirSync(decisionsDir)) {
    if (!/^HR-.+\.md$/i.test(entry)) continue;
    const rel = `instance/decisions/${entry}`;
    const fields = parseHrFields(readFileSync(join(decisionsDir, entry), "utf8"));
    if (fields.state !== "pending") continue; // only pending rows carry an SLA
    checked += 1;

    const parked = fields.parked !== undefined && fields.parked !== "";
    const reviewBy = fields.reviewBy;

    if (parked) {
      if (!reviewBy) {
        findings.push({ level: "FAIL", file: rel, detail: "parked without a review-by date" });
        continue;
      }
      const reviewMs = toMs(reviewBy);
      if (!Number.isFinite(reviewMs)) {
        findings.push({ level: "FAIL", file: rel, detail: `unparseable review-by '${reviewBy}'` });
      } else if (nowMs > reviewMs) {
        findings.push({ level: "FAIL", file: rel, detail: `parked row past its review-by (${reviewBy})` });
      } else {
        findings.push({ level: "PASS", file: rel, detail: `pending but parked, review-by ${reviewBy} not yet due` });
      }
      continue;
    }

    // Not parked: enforce the 72h SLA against the `date:` field.
    const dateMs = toMs(fields.date);
    if (!Number.isFinite(dateMs)) {
      findings.push({ level: "FAIL", file: rel, detail: `pending HR with unparseable/missing date '${fields.date ?? ""}'` });
      continue;
    }
    if (nowMs - dateMs > HR_PENDING_SLA_MS) {
      findings.push({ level: "FAIL", file: rel, detail: `pending >72h (since ${fields.date}) and not parked` });
    } else {
      findings.push({ level: "PASS", file: rel, detail: `pending within 72h SLA (since ${fields.date})` });
    }
  }

  if (checked === 0) {
    findings.push({ level: "PASS", file: "instance/decisions/", detail: "no pending HR rows" });
  }
  return findings;
}

// Convenience wrapper the checker calls: runs both aging checks and returns all
// findings. `nowMs` defaults to the current clock; the LEDGER_NOW_MS env var
// overrides it for deterministic tests (test-only seam).
export function runLedgerChecks(
  repo: string,
  strict: boolean,
  nowMs: number = resolveNow(),
): LedgerFinding[] {
  return [...checkInboxAging(repo, nowMs, strict), ...checkHrAging(repo, nowMs)];
}

// Current clock, overridable by LEDGER_NOW_MS (epoch ms) for tests only.
export function resolveNow(): number {
  const override = process.env.LEDGER_NOW_MS;
  if (override && /^\d+$/.test(override)) return Number(override);
  return Date.now();
}

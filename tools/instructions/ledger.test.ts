import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HR_PENDING_SLA_MS,
  INBOX_TRIAGE_SLA_MS,
  checkHrAging,
  checkInboxAging,
  parseHrFields,
  runLedgerChecks,
} from "./ledger.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

// Fixed "now" so every age is deterministic.
const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const daysAgoDate = (d: number) =>
  new Date(NOW - d * 86_400_000).toISOString().slice(0, 10);

// Builds a repo with an instance/decisions dir and returns its path.
function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ledger-"));
  temporaryDirectories.push(root);
  const dir = join(root, "instance", "decisions");
  mkdirSync(dir, { recursive: true });
  const gateDir = join(root, "gate");
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(join(gateDir, "land-lib.sh"), readFileSync(join(import.meta.dir, "../../gate/land-lib.sh")));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return root;
}

function jsonl(rows: object[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function hr(fields: Record<string, string>, body = "Body.\n"): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

describe("parseHrFields", () => {
  test("extracts state/date/parked/review-by", () => {
    const fields = parseHrFields(
      hr({
        id: "hr-1",
        state: "pending",
        date: "2026-07-20",
        parked: "awaiting stack decision",
        "review-by": "2026-08-15",
      }),
    );
    expect(fields.state).toBe("pending");
    expect(fields.date).toBe("2026-07-20");
    expect(fields.parked).toBe("awaiting stack decision");
    expect(fields.reviewBy).toBe("2026-08-15");
  });

  test("returns empty object when no frontmatter", () => {
    expect(parseHrFields("# just prose\n")).toEqual({});
  });
});

describe("checkInboxAging", () => {
  test("missing inbox.jsonl is a single SKIP", () => {
    const findings = checkInboxAging(repo(), NOW, true);
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe("SKIP");
  });

  test("an aged, untriaged, unrouted row FAILs under strict, WARNs otherwise", () => {
    const root = repo({ "inbox.jsonl": jsonl([{ msg_id: 500, chat_id: 1, ts: hoursAgo(30), text: "do X" }]) });
    const strict = checkInboxAging(root, NOW, true);
    expect(strict.some((f) => f.level === "FAIL" && f.file.includes("500"))).toBe(true);
    const lenient = checkInboxAging(root, NOW, false);
    expect(lenient.some((f) => f.level === "WARN" && f.file.includes("500"))).toBe(true);
    expect(lenient.some((f) => f.level === "FAIL")).toBe(false);
  });

  test("a fresh row (<24h) does not fire", () => {
    const root = repo({ "inbox.jsonl": jsonl([{ msg_id: 501, chat_id: 1, ts: hoursAgo(5), text: "recent" }]) });
    const findings = checkInboxAging(root, NOW, true);
    expect(findings.some((f) => f.level === "FAIL")).toBe(false);
    expect(findings.some((f) => f.level === "PASS")).toBe(true);
  });

  test("a routed row (HR file present) is not aged", () => {
    const root = repo({
      "inbox.jsonl": jsonl([{ msg_id: 502, chat_id: 1, ts: hoursAgo(48), text: "routed already" }]),
      "HR-502.md": hr({ id: "hr-502", state: "routed", date: daysAgoDate(2) }),
    });
    expect(checkInboxAging(root, NOW, true).some((f) => f.level === "FAIL")).toBe(false);
  });

  test("a row triaged as chatter is not aged", () => {
    const root = repo({
      "inbox.jsonl": jsonl([{ msg_id: 503, chat_id: 1, ts: hoursAgo(48), text: "lol ok" }]),
      "triage.jsonl": jsonl([{ msg_id: 503, verdict: "chatter", category: "channel-check", reason: "liveness-ping", quote: "ти тут?", triaged_by: "orchestrator", triaged_at: "2026-07-29" }]),
    });
    expect(checkInboxAging(root, NOW, true).some((f) => f.level === "FAIL")).toBe(false);
  });

  test("a row triaged as directive is also cleared from aging", () => {
    const root = repo({
      "inbox.jsonl": jsonl([{ msg_id: 504, chat_id: 1, ts: hoursAgo(48), text: "please do" }]),
      "triage.jsonl": jsonl([{ msg_id: 504, verdict: "directive", category: "product-input", reason: "open-follow-up", quote: "Мені абсолютно окей, якщо мої слова потраплять в гід.", triaged_by: "orchestrator", triaged_at: "2026-07-29" }]),
    });
    expect(checkInboxAging(root, NOW, true).some((f) => f.level === "FAIL")).toBe(false);
  });

  test("a triage row with an unapproved extra field FAILs", () => {
    const root = repo({
      "triage.jsonl": jsonl([{
        msg_id: 508,
        verdict: "chatter",
        category: "channel-check",
        reason: "liveness-ping",
        triaged_by: "orchestrator",
        triaged_at: "2026-07-29",
        quote: "verbatim Human message",
        text: "verbatim Human message",
      }]),
    });
    const findings = checkInboxAging(root, NOW, true);
    expect(findings.some((f) => f.level === "FAIL" && f.detail.includes("forbidden free-text field(s): text"))).toBe(true);
  });

  test("a triage row with a secret-shaped quote FAILs", () => {
    const root = repo({
      "triage.jsonl": jsonl([{ msg_id: 509, verdict: "directive", category: "security", reason: "credential", quote: ["PRIVATE", "KEY"].join(" "), triaged_by: "orchestrator", triaged_at: "2026-07-29" }]),
    });
    const findings = checkInboxAging(root, NOW, true);
    expect(findings.some((f) => f.level === "FAIL" && f.detail.includes("secret-shaped content"))).toBe(true);
  });

  test("torn/garbled jsonl lines are skipped, not crashed on", () => {
    const root = repo({
      "inbox.jsonl":
        jsonl([{ msg_id: 505, chat_id: 1, ts: hoursAgo(2), text: "ok" }]) + '{"msg_id": 506, "ts": "trunc',
    });
    // Does not throw; the good fresh row yields no FAIL.
    expect(() => checkInboxAging(root, NOW, true)).not.toThrow();
    expect(checkInboxAging(root, NOW, true).some((f) => f.level === "FAIL")).toBe(false);
  });

  test("exactly at the 24h boundary does not fire (strictly greater)", () => {
    const at = new Date(NOW - INBOX_TRIAGE_SLA_MS).toISOString();
    const root = repo({ "inbox.jsonl": jsonl([{ msg_id: 507, chat_id: 1, ts: at, text: "edge" }]) });
    expect(checkInboxAging(root, NOW, true).some((f) => f.level === "FAIL")).toBe(false);
  });
});

describe("checkHrAging", () => {
  test("no pending rows -> single PASS", () => {
    const root = repo({ "HR-1.md": hr({ id: "hr-1", state: "routed", date: daysAgoDate(10) }) });
    const findings = checkHrAging(root, NOW);
    expect(findings.every((f) => f.level === "PASS")).toBe(true);
  });

  test("pending >72h and not parked FAILs", () => {
    const root = repo({ "HR-2.md": hr({ id: "hr-2", state: "pending", date: daysAgoDate(4) }) });
    expect(checkHrAging(root, NOW).some((f) => f.level === "FAIL" && f.file.includes("HR-2"))).toBe(true);
  });

  test("pending within 72h is PASS", () => {
    const root = repo({ "HR-3.md": hr({ id: "hr-3", state: "pending", date: daysAgoDate(1) }) });
    expect(checkHrAging(root, NOW).some((f) => f.level === "FAIL")).toBe(false);
  });

  test("parked with a future review-by is PASS even past 72h", () => {
    const root = repo({
      "HR-4.md": hr({
        id: "hr-4",
        state: "pending",
        date: daysAgoDate(10),
        parked: "waiting on VM migration",
        "review-by": "2026-09-01",
      }),
    });
    expect(checkHrAging(root, NOW).some((f) => f.level === "FAIL")).toBe(false);
  });

  test("parked without a review-by FAILs", () => {
    const root = repo({
      "HR-5.md": hr({ id: "hr-5", state: "pending", date: daysAgoDate(10), parked: "waiting" }),
    });
    const findings = checkHrAging(root, NOW);
    expect(findings.some((f) => f.level === "FAIL" && f.detail.includes("without a review-by"))).toBe(true);
  });

  test("parked past its review-by re-reddens (FAIL)", () => {
    const root = repo({
      "HR-6.md": hr({
        id: "hr-6",
        state: "pending",
        date: daysAgoDate(10),
        parked: "waiting",
        "review-by": daysAgoDate(1),
      }),
    });
    const findings = checkHrAging(root, NOW);
    expect(findings.some((f) => f.level === "FAIL" && f.detail.includes("past its review-by"))).toBe(true);
  });

  test("pending with unparseable date FAILs", () => {
    const root = repo({ "HR-7.md": hr({ id: "hr-7", state: "pending", date: "soon" }) });
    expect(checkHrAging(root, NOW).some((f) => f.level === "FAIL")).toBe(true);
  });

  test("exactly at the 72h boundary does not fire", () => {
    const at = new Date(NOW - HR_PENDING_SLA_MS).toISOString();
    const root = repo({ "HR-8.md": hr({ id: "hr-8", state: "pending", date: at }) });
    expect(checkHrAging(root, NOW).some((f) => f.level === "FAIL")).toBe(false);
  });
});

describe("runLedgerChecks", () => {
  test("combines both checks and reflects strictness on the inbox side", () => {
    const root = repo({
      "inbox.jsonl": jsonl([{ msg_id: 900, chat_id: 1, ts: hoursAgo(30), text: "aged" }]),
      "HR-901.md": hr({ id: "hr-901", state: "pending", date: daysAgoDate(5) }),
    });
    const strict = runLedgerChecks(root, true, NOW);
    // Inbox row -> FAIL under strict; pending HR -> FAIL always.
    expect(strict.filter((f) => f.level === "FAIL").length).toBeGreaterThanOrEqual(2);

    const lenient = runLedgerChecks(root, false, NOW);
    // Inbox row demotes to WARN; the pending HR FAIL is absolute.
    expect(lenient.some((f) => f.level === "WARN" && f.file.includes("900"))).toBe(true);
    expect(lenient.some((f) => f.level === "FAIL" && f.file.includes("HR-901"))).toBe(true);
  });
});

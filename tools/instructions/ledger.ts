// Decisions-ledger aging checks (INSTRUCTIONS_CONSILIUM_FINAL.md §2.4, §2.5
// "ledger aging"). Two independent checks, both surfaced by tools/instructions/
// check.ts as `[ledger]` findings:
//
//   (a) Triage/inbox aging — a raw inbox.jsonl row (an inbound Human message
//       auto-mirrored by the daemon, daemon/inbox-mirror.ts) that has neither a
//       routed HR file (instance/decisions/HR-<msg_id>.md) nor a triage verdict
//       (triage.jsonl row) AND is older than 24h is an untriaged directive at
//       risk of B276-class loss: FAIL under --strict, WARN otherwise. Missing
//       inbox.jsonl is FAIL when capture.mode=daemon; in manual mode it SKIPs.
//
//   (b) HR pending aging — an HR file left `state: pending` past a 72h SLA (by
//       its `date:` field) is a capture that never got routed: FAIL, unless the
//       frontmatter carries BOTH `parked:` and `review-by:`. A parked row whose
//       `review-by:` date is in the past re-reddens: FAIL again. No
//       green-and-lost-forever loophole.
//
// Time source is the caller's clock, injected as `nowMs` so the check is
// deterministic under test. Thresholds are the constants below.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { INDEX_FILENAME } from "./docs.ts";
import { AGENTS_FILENAME, CLAUDE_FILENAME } from "./floor.ts";

export const INBOX_TRIAGE_SLA_MS = 24 * 60 * 60 * 1000; // 24h
export const HR_PENDING_SLA_MS = 72 * 60 * 60 * 1000; // 72h

export type LedgerLevel = "FAIL" | "WARN" | "SKIP" | "PASS";
export type LedgerFinding = { level: LedgerLevel; file: string; detail: string };

export type InboxRow = { msg_id: number | string; ts: string; text?: string };
export type TriageRow = {
  msg_id: number | string;
  verdict: string;
  category: string;
  reason: string;
  triaged_by: string;
  triaged_at: string;
  quote: string;
  answer_status?: "answered" | "owed";
  closes?: string;
  [key: string]: unknown;
};

const TRIAGE_FIELDS = new Set([
  "msg_id",
  "verdict",
  "category",
  "reason",
  "triaged_by",
  "triaged_at",
  "quote",
  "answer_status",
  // Structured closure claim (V3-3.1 item 2). The ONLY way a triage row may
  // assert completion: its value is re-resolved against the workboard, the repo
  // and the doc index on every run. Free-text `reason` can no longer close
  // anything -- three rows asserted closure in prose against NI-1/NI-2/NI-3,
  // workboard ids that had not existed since the board was renumbered, and read
  // as closed in git for four days.
  "closes",
]);
const CATEGORY_VALUE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROVENANCE_VALUE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i;

export function canonicalSecretPattern(repo: string): string | undefined {
  const gate = join(repo, "gate", "land-lib.sh");
  if (!existsSync(gate)) return undefined;
  const assignment = readFileSync(gate, "utf8")
    .split(/\r?\n/)
    .find((line) => /^\s*secret_pattern=/.test(line))
    ?.replace(/^\s*secret_pattern=/, "");
  if (!assignment) return undefined;
  const result = spawnSync(
    "bash",
    ["-c", 'eval "REPLY=$1"; printf "%s" "$REPLY"', "ledger-secret-pattern", assignment],
    { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout ? result.stdout : undefined;
}

export function validateTriageRow(row: TriageRow, line: number): LedgerFinding | undefined {
  const file = `instance/decisions/triage.jsonl:${line}`;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { level: "FAIL", file, detail: "invalid triage row: an object is required" };
  }
  const forbidden = Object.keys(row).filter((field) => !TRIAGE_FIELDS.has(field));
  if (forbidden.length > 0) {
    return {
      level: "FAIL",
      file,
      detail: `triage row contains forbidden free-text field(s): ${forbidden.join(", ")}`,
    };
  }
  const validId =
    (typeof row.msg_id === "number" && Number.isFinite(row.msg_id)) ||
    (typeof row.msg_id === "string" && row.msg_id !== "");
  if (!validId || !["chatter", "directive"].includes(row.verdict)) {
    return { level: "FAIL", file, detail: "invalid triage row: msg_id and chatter/directive verdict are required" };
  }
  if (row.answer_status !== undefined && !["answered", "owed"].includes(row.answer_status)) {
    return { level: "FAIL", file, detail: "invalid triage row: answered/owed answer_status is required" };
  }
  if (typeof row.quote !== "string" || row.quote.length === 0) {
    return { level: "FAIL", file, detail: "invalid triage row: non-empty verbatim quote is required" };
  }
  if (!CATEGORY_VALUE.test(row.category) || !CATEGORY_VALUE.test(row.reason)) {
    return {
      level: "FAIL",
      file,
      detail: "invalid triage row: category and reason must be category-only kebab-case tokens",
    };
  }
  if (!PROVENANCE_VALUE.test(row.triaged_by) || !/^\d{4}-\d{2}-\d{2}$/.test(row.triaged_at)) {
    return {
      level: "FAIL",
      file,
      detail: "invalid triage row: triaged_by identifier and YYYY-MM-DD triaged_at provenance are required",
    };
  }
}

type JsonlResult<T> = { rows: Array<{ line: number; value: T }>; findings: LedgerFinding[] };

// Reads and JSON-parses a .jsonl file with line provenance. A non-newline-
// terminated final fragment may be a torn append, so it is a visible WARN.
// Every malformed complete line is durable corrupt content and fails closed.
export function readJsonl<T>(path: string, file: string): JsonlResult<T> {
  const rows: Array<{ line: number; value: T }> = [];
  const findings: LedgerFinding[] = [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      rows.push({ line: index + 1, value: JSON.parse(trimmed) as T });
    } catch (error) {
      const tornFinalAppend = index === lines.length - 1 && !raw.endsWith("\n");
      findings.push({
        level: tornFinalAppend ? "WARN" : "FAIL",
        file: `${file}:${index + 1}`,
        detail: tornFinalAppend
          ? "unterminated final JSON fragment; append may be torn and requires recovery"
          : `malformed JSON: ${(error as Error).message}`,
      });
    }
  }
  return { rows, findings };
}

// ---------------------------------------------------------------------------
// HR state model — the polarity inversion (V3-3.1, plan items 1 and 2).
//
// Before this, every list an agent reads was built by an ALLOWLIST:
// `state === "pending"`. Across the real corpus that predicate selected NOTHING
// (45 routed, 33 with no state field at all, 2 open, 1 backlog, 1 captured), so
// no HR file had ever reached a lane pack, a session load, or an SLA. Worse,
// `routedMsgIds()` marked a message handled from the FILENAME alone, so the
// existence of the capture file also suppressed the raw inbox row. Writing a
// good capture was, mechanically, the act that hid the requirement.
//
// The inversion: a requirement is VISIBLE unless a machine-checkable proof of
// closure exists. Absence of bookkeeping is a FAIL and is treated as open —
// fail-visible, never fail-hidden.
// ---------------------------------------------------------------------------

// The declared vocabulary. Mirrored in prose in instructions/instruction-layers.md;
// this constant is the enforcing copy.
export const HR_STATES = ["pending", "owed", "routed", "parked", "superseded"] as const;
export type HrState = (typeof HR_STATES)[number];

// Three dispositions, not two. `deferred` exists because a parked row is
// neither delivered nor discharged: it is deliberately set aside, and its
// `review-by:` is what stops it being quiet. Collapsing it into either of the
// other buckets is how a park becomes a permanent disappearance.
export type HrDisposition = "open" | "deferred" | "closed";

// Which structured field each state must carry for its claim to be checkable.
// A state whose claim does not resolve is NOT closed — it falls back to open,
// which is the whole point of re-verifying on every run.
const HR_CLOSURE_FIELD: Record<HrState, "routesTo" | "trackedBy" | "supersededBy" | "reviewBy" | undefined> = {
  pending: undefined,
  owed: "trackedBy",
  routed: "routesTo",
  parked: "reviewBy",
  superseded: "supersededBy",
};

// Parses the HR frontmatter subset this checker relies on. Deliberately a small
// line scan rather than a YAML dependency, matching the rest of this tooling.
export type HrFields = {
  state?: string;
  date?: string;
  parked?: string;
  reviewBy?: string;
  routesTo?: string;
  trackedBy?: string;
  supersededBy?: string;
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
    else if (key === "routes-to") fields.routesTo = value;
    else if (key === "tracked-by") fields.trackedBy = value;
    else if (key === "superseded-by") fields.supersededBy = value;
  }
  return fields;
}

export function isHrState(value: string | undefined): value is HrState {
  return value !== undefined && (HR_STATES as readonly string[]).includes(value);
}

// The single predicate every delivery path now shares. A file is open when its
// state is open-by-vocabulary, when the field is absent, or when the value is
// outside the vocabulary. Unknown is open, never silent.
export function hrDisposition(fields: HrFields): HrDisposition {
  if (!isHrState(fields.state)) return "open";
  if (fields.state === "pending" || fields.state === "owed") return "open";
  if (fields.state === "parked") return "deferred";
  return "closed";
}

// Convenience for the delivery paths (session-load.ts, compose.ts), which hold
// file contents rather than parsed fields.
export function isHrOpen(contents: string): boolean {
  return hrDisposition(parseHrFields(contents)) === "open";
}

// ---------------------------------------------------------------------------
// Closure-target resolution (plan item 2).
//
// `routes-to:` / `tracked-by:` / `superseded-by:` were pure decoration —
// `grep -rn "routes-to" tools/ gate/` returned nothing. A closure claim must
// name something that EXISTS, and it is re-verified on EVERY run rather than at
// write time. That is what makes board renumbering safe: the NI->V3 rebuild
// orphaned three closures pointing at NI-1/NI-2/NI-3, and a write-time rule
// would not have caught it. Under this rule the renumbering commit goes red.
// ---------------------------------------------------------------------------

export type Resolvables = {
  workboardRows: Set<string>;
  docIds: Set<string>;
  hrIds: Set<string>;
};

// The board file row ids are enumerated OUT of. Named once, and used by both
// collectWorkboardRows() below and isContainerTarget() further down, so the two
// cannot drift into disagreeing about what the container is.
export const WORKBOARD_PATH = "instance/workboard.md";

// Workboard row ids, read from the leading cell of each table row. The FIELD is
// generic mechanism; the id FORMAT is this installation's, so this reads the
// ids actually present rather than matching a hard-coded row-id shape.
export function collectWorkboardRows(repo: string): Set<string> {
  const rows = new Set<string>();
  const path = join(repo, WORKBOARD_PATH);
  if (!existsSync(path)) return rows;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\|\s*\*{0,2}([A-Za-z][A-Za-z0-9]*-[0-9][0-9.]*)\*{0,2}\s*\|/);
    if (match) rows.add(match[1]);
  }
  return rows;
}

function collectDocIds(repo: string): Set<string> {
  const ids = new Set<string>();
  const dir = join(repo, "instructions");
  if (!existsSync(dir)) return ids;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const match = readFileSync(join(dir, entry), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) continue;
    const idLine = match[1].split(/\r?\n/).find((line) => /^id\s*:/.test(line));
    if (idLine) ids.add(idLine.replace(/^id\s*:\s*/, "").trim().replace(/^["']|["']$/g, ""));
  }
  return ids;
}

function collectHrIds(decisionsDir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(decisionsDir)) return ids;
  for (const entry of readdirSync(decisionsDir)) {
    const match = entry.match(/^HR-(.+)\.md$/i);
    if (match) ids.add(match[1]);
  }
  return ids;
}

export function collectResolvables(repo: string): Resolvables {
  return {
    workboardRows: collectWorkboardRows(repo),
    docIds: collectDocIds(repo),
    hrIds: collectHrIds(join(repo, "instance", "decisions")),
  };
}

// A closure field names ONE target. Round 1 accepted any value in which AT
// LEAST ONE whitespace-separated token named something real, which made the
// field unfalsifiable in the shape the corpus actually uses: measured on fresh
// `state: routed` files, `handled in the roles doc` passed (`roles` is a doc
// id), `see instructions/review-policy.md for the rest` passed, and
// `not done yet, tracked in instance/workboard.md` passed -- a closure claim
// whose own words say it is not done. The generosity was aimed at SHAPE and it
// bought unfalsifiability instead.
//
// The field is now single-token: whatever remains after trimming, and after one
// optional layer of surrounding backticks or quotes, must contain no
// whitespace. Prose does not fail because it is untidy; it fails because a
// sentence has no one target, so nothing about it can be re-verified. Say what
// the claim closes and put the sentence in the body.
export function closureToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let token = value.trim();
  const wrapped = token.match(/^([`'"])([\s\S]*)\1$/);
  if (wrapped) token = wrapped[2].trim();
  if (token === "" || /\s/.test(token)) return undefined;
  return token;
}

// The files that are containers by IDENTITY rather than by shape: the workboard
// is the file row ids are enumerated out of, and the root agent contract is the
// entry point every lane already loads. Named once, here, so the rule and its
// lock cannot drift into disagreeing about what the set is.
export const CONTAINER_FILES = [WORKBOARD_PATH, CLAUDE_FILENAME, AGENTS_FILENAME];

// Resolves a repo-relative token to the file it ACTUALLY names, or undefined
// when it names nothing inside the repository.
//
// Round 2 decided the two file containers by comparing the token STRING, so one
// file had opposite verdicts depending on how it was typed: `instance/
// workboard.md` failed as a container while `./instance/workboard.md`,
// `instance/./workboard.md` and `instance//workboard.md` all resolved, silently
// discharging the obligation, dropping it out of the open count and out of the
// session load with the checker still green. The directory case never had that
// hole, because `statSync()` resolves the path before answering -- so the repair
// is to give every case the directory case's treatment and decide on identity,
// not on spelling.
//
// `realpathSync()` is what makes that general rather than a list of the
// spellings someone happened to think of: `./`, `//`, `a/./b`, `a/../b` and
// symlinks all collapse to one answer, so a new spelling is not a new bypass.
// It also subsumes the old string-level `..` refusal, and subsumes it more
// strongly -- containment is now checked on the RESOLVED path, so a symlink
// pointing out of the tree is refused too, which `!token.includes("..")` could
// not see.
function resolveRepoPath(
  repo: string,
  token: string,
): { abs: string; rel: string } | undefined {
  let root: string;
  let abs: string;
  try {
    root = realpathSync(repo);
    abs = realpathSync(join(repo, token));
  } catch {
    return undefined;
  }
  const rel = relative(root, abs);
  // `..` or an absolute remainder means the token escaped the repository.
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  // rel === "" is the repository root itself, which the container test below
  // answers as the directory it is.
  return { abs, rel };
}

// A container is a target that other targets are named out of, so naming it
// discharges nothing: it exists no matter what happened to the thing the claim
// was about. With the board path accepted, renaming the row a claim points at
// left the claim green, which is precisely the property (surviving board
// renumbering) this design calls its own. A directory is the same failure one
// level up, a README is the generated index over its directory, and the root
// agent contract is the file every session loads regardless.
//
// Every arm reads the RESOLVED path. The README arm therefore also catches a
// link whose own name is not `README.md`, and the `CONTAINER_FILES` arm catches
// `AGENTS.md` through its symlink to `CLAUDE.md` without depending on either
// name -- the set lists both so the rule still holds where they are two files.
function isContainerTarget(repo: string, resolved: { abs: string; rel: string }): boolean {
  try {
    if (statSync(resolved.abs).isDirectory()) return true;
  } catch {
    return false;
  }
  if (basename(resolved.abs) === INDEX_FILENAME) return true;
  for (const container of CONTAINER_FILES) {
    let containerAbs: string;
    try {
      containerAbs = realpathSync(join(repo, container));
    } catch {
      continue;
    }
    if (containerAbs === resolved.abs) return true;
  }
  return false;
}

export type TargetResolution = "resolved" | "empty" | "prose" | "container" | "unresolved";

// Resolves a closure claim to a SPECIFIC target: a workboard row id, an
// instructions doc id, an existing repo path that is not a container, or (for
// superseded-by) an HR id. Re-evaluated on every run, never cached, so a
// renumbering or a deletion reddens the claim the next time anything looks.
//
// Returns WHY it failed, because the three failures need different repairs:
// `prose` means write the target down, `container` means name the row inside
// it, `unresolved` means the thing being claimed does not exist.
export function resolveTarget(
  repo: string,
  resolvables: Resolvables,
  value: string | undefined,
  allowHrIds = false,
): TargetResolution {
  if (value === undefined || value.trim() === "") return "empty";
  const token = closureToken(value);
  if (token === undefined) return "prose";
  if (resolvables.workboardRows.has(token)) return "resolved";
  if (resolvables.docIds.has(token)) return "resolved";
  if (allowHrIds) {
    const hrId = token.replace(/^HR-/i, "").replace(/\.md$/i, "");
    if (resolvables.hrIds.has(hrId)) return "resolved";
  }
  // A path token must look repo-relative and name something real inside the
  // repository. What it names is decided by resolveRepoPath(), so every arm
  // below reads one file identity rather than the characters it was typed with.
  if (/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(token)) {
    const resolved = resolveRepoPath(repo, token);
    if (resolved !== undefined) {
      if (isContainerTarget(repo, resolved)) return "container";
      // A bare root filename still resolves against nothing: it names no
      // directory, so it carries none of the "which one inside it" the rule is
      // about. The test reads the RESOLVED path, so `x` and `./x` answer alike.
      if (resolved.rel.includes(sep)) return "resolved";
    }
  }
  return "unresolved";
}

// Boolean face of resolveTarget() for the callers that only need the verdict.
export function resolvesTarget(
  repo: string,
  resolvables: Resolvables,
  value: string | undefined,
  allowHrIds = false,
): boolean {
  return resolveTarget(repo, resolvables, value, allowHrIds) === "resolved";
}

// The repair a given failure calls for, in the message the author reads.
export function resolutionDetail(resolution: TargetResolution, token: string): string {
  switch (resolution) {
    case "prose":
      return `'${token}' is prose, not a target — name exactly one workboard row, doc id or repo path and put the sentence in the body`;
    case "container":
      return `'${token}' is a container that exists regardless — name the row, doc or file inside it`;
    default:
      return `'${token}' resolves to no workboard row, repo path, or doc id — the closure claim is not real`;
  }
}

// ---------------------------------------------------------------------------
// Msg-id resolution: CAPTURED and DISCHARGED are different claims.
//
// The old `routedMsgIds()` conflated them, reading "handled" off the filename.
// A file named HR-<id>.md proves the message was CAPTURED (it is no longer
// untriaged). Only a closed state with a RESOLVING target proves the obligation
// was DISCHARGED. Nothing may infer the second from the first.
// ---------------------------------------------------------------------------

// Msg-ids with an HR file of any kind. Suppresses the untriaged-inbox SLA only:
// the message did reach a human-written record.
export function capturedMsgIds(decisionsDir: string): Set<string> {
  return collectHrIds(decisionsDir);
}

// Msg-ids whose HR file is provably closed: a closed state AND a closure target
// that resolves right now. An unresolvable claim is not a discharge.
//
// STAGED, not dead (round-2 review finding 6). Nothing in production calls this
// yet; `session-load.ts` and `checkInboxAging()` both call capturedMsgIds(), and
// that split is correct — the untriaged-inbox SLA asks whether a message was
// READ, which an HR file of any state answers. The consumer this exists for is
// the deferred clause "`answer_status: answered` must be backed by a resolving
// `closes:`", which needs the discharged set to decide which `answered` rows are
// already provable and which are the ~227 that need remediation. That clause is
// its own workboard row, V3-2.20; until it lands, this function's
// only caller is hr-state.test.ts. Said out loud because an exported, tested,
// uncalled predicate is the same silhouette as the bug this row fixes, and the
// next reader should not have to reconstruct which one it is.
export function dischargedMsgIds(repo: string, resolvables?: Resolvables): Set<string> {
  const decisionsDir = join(repo, "instance", "decisions");
  const ids = new Set<string>();
  if (!existsSync(decisionsDir)) return ids;
  const targets = resolvables ?? collectResolvables(repo);
  for (const entry of readdirSync(decisionsDir)) {
    const match = entry.match(/^HR-(.+)\.md$/i);
    if (!match) continue;
    const fields = parseHrFields(readFileSync(join(decisionsDir, entry), "utf8"));
    if (hrDisposition(fields) !== "closed") continue;
    const field = HR_CLOSURE_FIELD[fields.state as HrState];
    const allowHrIds = fields.state === "superseded";
    if (field && resolvesTarget(repo, targets, fields[field], allowHrIds)) ids.add(match[1]);
  }
  return ids;
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
  const triagePath = join(decisionsDir, "triage.jsonl");
  const triaged = new Set<string>();
  const secretPattern = canonicalSecretPattern(repo);
  if (existsSync(triagePath)) {
    const triage = readJsonl<TriageRow>(triagePath, "instance/decisions/triage.jsonl");
    findings.push(...triage.findings);
    for (const { line, value: row } of triage.rows) {
      const invalid = validateTriageRow(row, line);
      if (invalid) findings.push(invalid);
      else if (!secretPattern) {
        findings.push({ level: "FAIL", file: `instance/decisions/triage.jsonl:${line}`, detail: "canonical secret scanner missing" });
      } else if (new RegExp(secretPattern).test(row.quote)) {
        findings.push({ level: "FAIL", file: `instance/decisions/triage.jsonl:${line}`, detail: "verbatim quote contains secret-shaped content" });
      }
      else triaged.add(String(row.msg_id));
    }
  }

  const inboxPath = join(decisionsDir, "inbox.jsonl");
  if (!existsSync(inboxPath)) {
    const mode = readCaptureMode(repo);
    if (mode === "daemon") {
      findings.push({ level: "FAIL", file: "instance/decisions/inbox.jsonl", detail: "capture.mode=daemon — required inbox.jsonl is missing" });
      return findings;
    }
    findings.push({ level: "SKIP", file: "instance/decisions/inbox.jsonl", detail: "capture.mode=manual — inbox not expected yet" });
    return findings;
  }

  const inbox = readJsonl<InboxRow>(inboxPath, "instance/decisions/inbox.jsonl");
  findings.push(...inbox.findings);
  // CAPTURED, not discharged. This SLA asks "was this message ever read and
  // recorded", so an HR file of any state answers it. Whether the obligation
  // inside was ever DISCHARGED is a different question, answered by
  // checkHrStates() against the file's state — never by its filename.
  const captured = capturedMsgIds(decisionsDir);

  let aged = 0;
  for (const { line, value: row } of inbox.rows) {
    if (
      !row ||
      !(
        (typeof row.msg_id === "number" && Number.isFinite(row.msg_id)) ||
        (typeof row.msg_id === "string" && row.msg_id !== "")
      )
    ) {
      findings.push({
        level: "FAIL",
        file: `instance/decisions/inbox.jsonl:${line}`,
        detail: "invalid inbox row: non-empty msg_id is required",
      });
      continue;
    }
    const id = String(row.msg_id);
    const timestampMs = typeof row.ts === "string" ? toMs(row.ts) : NaN;
    if (!Number.isFinite(timestampMs)) {
      findings.push({
        level: "FAIL",
        file: `inbox.jsonl:msg ${id}`,
        detail: `invalid or missing timestamp '${typeof row.ts === "string" ? row.ts : ""}'`,
      });
      continue;
    }
    if (captured.has(id) || triaged.has(id)) continue;
    const ageMs = nowMs - timestampMs;
    if (ageMs > INBOX_TRIAGE_SLA_MS) {
      aged += 1;
      findings.push({
        level: strict ? "FAIL" : "WARN",
        file: `inbox.jsonl:msg ${id}`,
        detail: `untriaged inbound >24h with no HR-${id}.md and no triage verdict`,
      });
    }
  }
  if (aged === 0 && findings.length === 0) {
    findings.push({ level: "PASS", file: "instance/decisions/inbox.jsonl", detail: `${inbox.rows.length} rows, none aged untriaged` });
  }
  return findings;
}

// How far ahead a park may be scheduled. `review-by:` is mandatory and bites
// when past, which is a real bound -- but round 1 put no ceiling on the horizon,
// so `review-by: 2099-01-01` was green, undelivered and uncounted: a quiet
// hiding place with the lock left open, in the row that exists to remove quiet
// hiding places. The MECHANISM (a park has a bounded horizon) is generic; the
// NUMBER is this installation's, so it lives in instance/params.yaml per the
// instruction-layers Q1 split and this constant is only the fallback for a repo
// that declares none.
export const DEFAULT_PARKED_HORIZON_DAYS = 90;

export function readParkedHorizonDays(repo: string): number {
  const path = join(repo, "instance", "params.yaml");
  if (!existsSync(path)) return DEFAULT_PARKED_HORIZON_DAYS;
  let ledger = false;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (/^ledger:\s*(?:#.*)?$/.test(raw)) {
      ledger = true;
      continue;
    }
    if (/^[A-Za-z]/.test(raw)) ledger = false;
    if (ledger) {
      const match = raw.match(/^\s+parked_horizon_days:\s*(\d+)\b/);
      if (match) return Number(match[1]);
    }
  }
  return DEFAULT_PARKED_HORIZON_DAYS;
}

export function readCaptureMode(repo: string): "manual" | "daemon" {
  const path = join(repo, "instance", "params.yaml");
  if (!existsSync(path)) return "manual";
  let capture = false;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (/^capture:\s*(?:#.*)?$/.test(raw)) {
      capture = true;
      continue;
    }
    if (/^[A-Za-z]/.test(raw)) capture = false;
    if (capture) {
      const match = raw.match(/^\s+mode:\s*(manual|daemon)\b/);
      if (match) return match[1] as "manual" | "daemon";
    }
  }
  return "manual";
}

// ---------------------------------------------------------------------------
// Exemption ledger for existing debt (instance/hr-state-exemptions.tsv).
//
// Landing the state rules over the corpus as it stands turns every landing red
// instantly. Relabeling that to WARN would violate Hard Floor 7, so the debt is
// ENUMERATED instead: each exempted violation is named exactly, owned, and
// dated. Two directions of expiry, both learned from V3-2.16 (landed precisely
// because an exemption outlived its reason by a day):
//
//   EXEMPTION-EXPIRED  the `expires` date has passed          -> FAIL
//   EXEMPTION-STALE    the violation it excused is gone       -> FAIL
//
// Keyed on the subject+rule PAIR, never the subject alone: a whole-file
// exemption would silently license every future violation added to that file
// under the original, unrelated justification.
// ---------------------------------------------------------------------------

export const EXEMPTION_LEDGER = "instance/hr-state-exemptions.tsv";

// Closed vocabulary. An entry naming a rule outside this set is a FAIL: an
// exemption for a rule that does not exist excuses nothing and hides a typo.
export const EXEMPTIBLE_RULES = new Set([
  "hr-state-missing",
  "hr-state-invalid",
  "hr-closure-unresolved",
  "triage-answer-status-missing",
]);

type Exemption = { subject: string; rule: string; expires: string; evidence: string; line: number };

export function readExemptions(repo: string): { entries: Exemption[]; findings: LedgerFinding[] } {
  const entries: Exemption[] = [];
  const findings: LedgerFinding[] = [];
  const path = join(repo, "instance", "hr-state-exemptions.tsv");
  if (!existsSync(path)) return { entries, findings };
  const seen = new Set<string>();
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const file = `${EXEMPTION_LEDGER}:${index + 1}`;
    const parts = raw.split("\t");
    if (parts.length !== 4) {
      findings.push({ level: "FAIL", file, detail: "malformed entry: expected subject<TAB>rule<TAB>expires<TAB>evidence" });
      continue;
    }
    const [subject, rule, expires, evidence] = parts.map((part) => part.trim());
    if (!EXEMPTIBLE_RULES.has(rule)) {
      findings.push({ level: "FAIL", file, detail: `unknown rule '${rule}' — an exemption for a rule that does not exist excuses nothing` });
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || !Number.isFinite(Date.parse(expires))) {
      findings.push({ level: "FAIL", file, detail: `unparseable expiry '${expires}' — an exemption with no expiry is permanent debt` });
      continue;
    }
    if (!/^owner=\S+;\s*\S/.test(evidence)) {
      findings.push({ level: "FAIL", file, detail: "evidence must start `owner=<id>; <reason>` — an unowned debt is how a row stays forever" });
      continue;
    }
    const key = `${subject}\t${rule}`;
    if (seen.has(key)) {
      findings.push({ level: "FAIL", file, detail: `duplicate exemption for ${subject} / ${rule}` });
      continue;
    }
    seen.add(key);
    entries.push({ subject, rule, expires, evidence, line: index + 1 });
  }
  return { entries, findings };
}

// Applies the ledger to one run's violations. Returns the findings that survive
// exemption, plus the ledger's own expired/stale failures.
function applyExemptions(
  exemptions: Exemption[],
  ledgerFindings: LedgerFinding[],
  violations: Array<{ subject: string; rule: string; finding: LedgerFinding }>,
  nowMs: number,
  // Scopes the stale sweep to the rules THIS pass can produce. Without it the
  // HR pass would report every triage exemption as stale and the triage pass
  // every HR one -- each check declaring the other's live debt discharged,
  // which is the exact shape of the bug being fixed here.
  ownedRules: Set<string>,
): LedgerFinding[] {
  const out: LedgerFinding[] = [...ledgerFindings];
  const used = new Set<string>();
  const byKey = new Map(
    exemptions
      .filter((entry) => ownedRules.has(entry.rule))
      .map((entry) => [`${entry.subject}\t${entry.rule}`, entry]),
  );

  for (const violation of violations) {
    const key = `${violation.subject}\t${violation.rule}`;
    const exemption = byKey.get(key);
    if (!exemption) {
      out.push(violation.finding);
      continue;
    }
    used.add(key);
    // An expired exemption fails, and the underlying violation is reported too:
    // the expiry is what makes the debt come back, not a second silence.
    if (nowMs > Date.parse(`${exemption.expires}T23:59:59Z`)) {
      out.push({
        level: "FAIL",
        file: `${EXEMPTION_LEDGER}:${exemption.line}`,
        detail: `EXEMPTION-EXPIRED ${violation.subject} / ${violation.rule} expired ${exemption.expires} — fix the row or re-justify it`,
      });
      out.push(violation.finding);
      continue;
    }
    out.push({
      level: "WARN",
      file: violation.finding.file,
      detail: `${violation.finding.detail} (exempt until ${exemption.expires}; ${exemption.evidence})`,
    });
  }

  // Discharged debt: an entry whose violation no longer exists must be deleted.
  // Without this an exemption survives its reason, which is exactly the defect
  // V3-2.16 was landed to remove.
  for (const [key, exemption] of byKey) {
    if (used.has(key)) continue;
    out.push({
      level: "FAIL",
      file: `${EXEMPTION_LEDGER}:${exemption.line}`,
      detail: `EXEMPTION-STALE ${exemption.subject} / ${exemption.rule} no longer violates — delete this line`,
    });
  }
  return out;
}

// (c) HR state validity and closure resolution (plan items 1 and 2). This is
// the check that makes absence loud: every HR file must declare a state from
// the vocabulary, and every closure claim must name a target that resolves NOW.
export function checkHrStates(repo: string, nowMs: number): LedgerFinding[] {
  const decisionsDir = join(repo, "instance", "decisions");
  if (!existsSync(decisionsDir)) {
    return [{ level: "SKIP", file: "instance/decisions/", detail: "no decisions ledger" }];
  }

  const resolvables = collectResolvables(repo);
  const violations: Array<{ subject: string; rule: string; finding: LedgerFinding }> = [];
  const passes: LedgerFinding[] = [];
  let open = 0;
  let parked = 0;

  for (const entry of readdirSync(decisionsDir).sort()) {
    if (!/^HR-.+\.md$/i.test(entry)) continue;
    const rel = `instance/decisions/${entry}`;
    const fields = parseHrFields(readFileSync(join(decisionsDir, entry), "utf8"));

    if (fields.state === undefined) {
      open += 1;
      violations.push({
        subject: rel,
        rule: "hr-state-missing",
        finding: { level: "FAIL", file: rel, detail: "no `state:` field — treated as OPEN and delivered until declared" },
      });
      continue;
    }
    if (!isHrState(fields.state)) {
      open += 1;
      violations.push({
        subject: rel,
        rule: "hr-state-invalid",
        finding: {
          level: "FAIL",
          file: rel,
          detail: `state '${fields.state}' is outside the vocabulary (${HR_STATES.join(" | ")}) — treated as OPEN`,
        },
      });
      continue;
    }

    const state = fields.state as HrState;
    const disposition = hrDisposition(fields);
    if (disposition === "open") open += 1;
    if (disposition === "deferred") parked += 1;

    const field = HR_CLOSURE_FIELD[state];
    if (field === undefined) {
      passes.push({ level: "PASS", file: rel, detail: `state: ${state}` });
      continue;
    }
    // `parked` keeps its own review-by rule in checkHrAging; here only the
    // presence of the field is a state requirement.
    const value = fields[field];
    const label = field === "routesTo" ? "routes-to" : field === "trackedBy" ? "tracked-by" : field === "supersededBy" ? "superseded-by" : "review-by";
    if (value === undefined || value.trim() === "") {
      violations.push({
        subject: rel,
        rule: "hr-closure-unresolved",
        finding: { level: "FAIL", file: rel, detail: `state '${state}' requires \`${label}:\` — a closure with no target proves nothing` },
      });
      continue;
    }
    if (field === "reviewBy") {
      passes.push({ level: "PASS", file: rel, detail: `state: ${state} (${label}: ${value})` });
      continue;
    }
    const resolution = resolveTarget(repo, resolvables, value, state === "superseded");
    if (resolution !== "resolved") {
      violations.push({
        subject: rel,
        rule: "hr-closure-unresolved",
        finding: {
          level: "FAIL",
          file: rel,
          detail: `${label} ${resolutionDetail(resolution, value)}`,
        },
      });
      continue;
    }
    passes.push({ level: "PASS", file: rel, detail: `state: ${state} (${label} resolves)` });
  }

  const ledger = readExemptions(repo);
  const findings = applyExemptions(
    ledger.entries,
    ledger.findings,
    violations,
    nowMs,
    new Set(["hr-state-missing", "hr-state-invalid", "hr-closure-unresolved"]),
  );
  findings.push(...passes);
  // The counts are stated on every run so no reader can believe the board is
  // empty — the belief that produced two months of unread requirements.
  //
  // Parked is stated NEXT TO open, never folded into it (round-2 review finding
  // 5). A parked row is deliberately not delivered, which is exactly why it must
  // be countable: undelivered and uncounted is invisible, and invisible is the
  // failure. Two numbers, because collapsing them would either re-deliver every
  // park or hide it again.
  findings.push({
    level: open === 0 ? "PASS" : "WARN",
    file: "instance/decisions/",
    detail: `${open} open HR obligation(s) — delivered to every session load and pack; ${parked} parked (deferred, not delivered, bounded by review-by)`,
  });
  return findings;
}

// (d) Triage closure claims (plan item 2). The structured `closes:` field is
// the only way a triage row may assert completion, and it is re-resolved on
// every run. Free-text `reason` cannot close anything: 89 rows currently claim
// capture/routing/completion in prose and three of those claims were provably
// false for four days without any mechanism noticing.
export function checkTriageClosures(repo: string, nowMs: number): LedgerFinding[] {
  const triagePath = join(repo, "instance", "decisions", "triage.jsonl");
  if (!existsSync(triagePath)) {
    return [{ level: "SKIP", file: "instance/decisions/triage.jsonl", detail: "no triage ledger" }];
  }
  const resolvables = collectResolvables(repo);
  const violations: Array<{ subject: string; rule: string; finding: LedgerFinding }> = [];
  const triage = readJsonl<TriageRow>(triagePath, "instance/decisions/triage.jsonl");
  const findings: LedgerFinding[] = [];
  let owed = 0;

  for (const { line, value: row } of triage.rows) {
    if (!row || typeof row !== "object") continue;
    const file = `instance/decisions/triage.jsonl:${line}`;
    const closes = typeof row.closes === "string" ? row.closes : undefined;
    if (closes !== undefined) {
      const resolution = resolveTarget(repo, resolvables, closes, true);
      if (resolution !== "resolved") {
        findings.push({
          level: "FAIL",
          file,
          detail: `closes ${resolutionDetail(resolution, closes)} — msg ${row.msg_id} reads as closed against nothing`,
        });
        continue;
      }
    }
    if (row.verdict !== "directive") continue;
    if (row.answer_status === undefined) {
      violations.push({
        subject: `msg:${row.msg_id}`,
        rule: "triage-answer-status-missing",
        finding: { level: "FAIL", file, detail: `directive msg ${row.msg_id} has no answer_status — unknown is OPEN, not silence` },
      });
      continue;
    }
    if (row.answer_status === "owed") owed += 1;
  }

  const ledger = readExemptions(repo);
  findings.push(...applyExemptions(ledger.entries, [], violations, nowMs, new Set(["triage-answer-status-missing"])));
  findings.push({
    level: owed === 0 ? "PASS" : "WARN",
    file: "instance/decisions/triage.jsonl",
    detail: `${owed} directive(s) owed`,
  });
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

  const horizonDays = readParkedHorizonDays(repo);
  const horizonMs = nowMs + horizonDays * 24 * 60 * 60 * 1000;
  let checked = 0;
  for (const entry of readdirSync(decisionsDir)) {
    if (!/^HR-.+\.md$/i.test(entry)) continue;
    const rel = `instance/decisions/${entry}`;
    const fields = parseHrFields(readFileSync(join(decisionsDir, entry), "utf8"));
    // `pending` carries the 72h SLA. `owed` deliberately carries NO invented
    // threshold -- HR-2451 leaves that number to the operator -- but it is not
    // quiet while it waits: every owed row is delivered to every session load
    // and counted on every checker run by checkHrStates().
    if (fields.state !== "pending" && fields.state !== "parked") continue;
    checked += 1;

    // Two spellings of the same intent: the declared `state: parked`, and the
    // legacy `state: pending` plus a `parked:` field that predates the
    // vocabulary. Both must satisfy review-by; neither may be silent.
    const parked = fields.state === "parked" || (fields.parked !== undefined && fields.parked !== "");
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
      } else if (reviewMs > horizonMs) {
        // A self-chosen date with no ceiling is not a bound. Parking something
        // for 70 years and parking it forever are the same act.
        findings.push({
          level: "FAIL",
          file: rel,
          detail: `review-by ${reviewBy} is beyond the ${horizonDays}-day parked horizon — a park that far out is a deletion; shorten it or close the row`,
        });
      } else {
        findings.push({ level: "PASS", file: rel, detail: `parked, review-by ${reviewBy} not yet due` });
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
    findings.push({ level: "PASS", file: "instance/decisions/", detail: "no pending or parked HR rows" });
  }
  return findings;
}

// Convenience wrapper the checker calls: runs every ledger check and returns all
// findings. `nowMs` defaults to the current clock; the LEDGER_NOW_MS env var
// overrides it for deterministic tests (test-only seam).
export function runLedgerChecks(
  repo: string,
  strict: boolean,
  nowMs: number = resolveNow(),
): LedgerFinding[] {
  return [
    ...checkInboxAging(repo, nowMs, strict),
    ...checkHrAging(repo, nowMs),
    ...checkHrStates(repo, nowMs),
    ...checkTriageClosures(repo, nowMs),
  ];
}

// Current clock, overridable by LEDGER_NOW_MS (epoch ms) for tests only.
export function resolveNow(): number {
  const override = process.env.LEDGER_NOW_MS;
  if (override && /^\d+$/.test(override)) return Number(override);
  return Date.now();
}

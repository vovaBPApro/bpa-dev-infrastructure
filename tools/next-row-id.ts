#!/usr/bin/env bun
// Workboard id allocation is a command, not a decision (workboard V3-5.24,
// `instance/plans/orchestrator-guards-2026-08-05.md` G2).
//
// Why this file exists. Assigning a row id by eye failed twice in one day.
// `V3-3.1`/`V3-3.2` were handed to a lane while Phase 3 backlog rows already
// held them, and `V3-2.17` was handed out hours after another lane had filed a
// row under that id the same morning. The second one broke `main`: the
// fleet-nudge parser treats a duplicate id as structural damage, refused the
// whole board (exit 2), and alerted the operator, who had to ask what the alert
// was. Nothing was wrong with either lane's work — the id was decided by a
// human-shaped act of memory against a 200-row file, which is the one thing an
// agent is worst at and a command is best at.
//
// The duplicate was ALREADY caught, by the parser, after the commit. This tool
// moves the same catch to before it, and answers the question the orchestrator
// actually has ("what id do I give this row?") instead of the question the
// parser answers ("is the board damaged?").
//
// ── What it reads ──────────────────────────────────────────────────────────
//
//   workboard      instance/workboard.md — the leading cell of every table row
//                  under an `id` header. Authoritative and strictly parsed.
//   review-items   instance/review-items.tsv — the item-id column. A row can be
//                  in review before it is on the board, which is exactly the
//                  V3-2.17 shape.
//   ledgers        the structured id-bearing FIELDS of the exemption and
//                  decision ledgers: `owner=` in the HR-state exemptions,
//                  `pending-<row>` in the doc-path exemptions, the id prefix of
//                  each instance/parked/ filename, the closure fields
//                  (`tracked-by:`, `routes-to:`, `superseded-by:`) of
//                  instance/decisions/HR-*.md, and the `closes` field of each
//                  instance/decisions/triage.jsonl row. `closes` is a TRIAGE-row
//                  field, not an HR-file field — `checkTriageClosures` in
//                  tools/instructions/ledger.ts reads it from the JSONL, and so
//                  does this. Declaring it and then looking for it in the HR
//                  files, as an earlier revision did, is a source listed as
//                  covered while nothing reads it.
//
// Every source is DECLARED (see SOURCES below). An absent declared source is an
// error, never an empty contribution: a source that silently reads as empty is
// how an allocator hands out an id somebody already holds. The same rule binds
// INSIDE a source: an entry of an unexpected kind in instance/parked/ — a
// `.bak`, a `.txt`, an extensionless file, a directory — is an error, not a
// skipped file. Skipping it drops a parked row's claim silently, which is the
// fail-open shape this file exists to refuse.
//
// ── The id contract is the parser's, not this file's ───────────────────────
//
// ID_SHAPE is transcribed from the awk recognizer in
// orchestrator/fleet/fleet-nudge.sh, and next-row-id.test.ts extracts that awk
// literal and asserts the two are the same string.
//
// A shared recognizer is NOT a shared verdict, because the verdict also depends
// on what text reaches the recognizer. That is where the two implementations
// drifted apart and had to be brought back:
//
//   * `.trim()` strips U+00A0 and U+FEFF; POSIX `[[:space:]]` does not. A board
//     id with a non-breaking space around it — the commonest invisible survivor
//     of a copy-paste, and these ids ARE copy-pasted — made the parser refuse
//     the whole board while this tool reported it healthy and answered.
//   * `[ \t]` at line start versus awk's `[[:space:]]` meant a row led by a
//     vertical tab, form feed or carriage return was counted by the parser and
//     invisible here. That is the collision direction: the tool then hands out
//     an id the board already holds.
//
// So cell extraction uses awk's character class, character for character
// (`LINE_SPACE` below), and the equality claim is locked by BEHAVIOUR, not only
// by text: next-row-id.test.ts feeds one board to `fleet-nudge.sh --count-open`
// and to this tool and diffs their verdicts. This file does not modify the
// parser; it agrees with it under test.
//
// ── The answer is checked like any other id ────────────────────────────────
//
// The one id this tool never used to check was the one it returned. A board row
// reading `V3-5.1000000000000000000000` is well-formed to the parser, and
// `Number()` on that digit run round-trips to `1e+21`, so the allocator answered
// `V3-5.1e+21` — a malformed id, which is precisely what makes fleet-nudge
// refuse the whole board and alert the operator. So: an ordinal that is not a
// safe integer, or whose canonical decimal form differs from the digits on the
// board, is refused rather than counted; and the returned id is asserted to
// match ID_SHAPE and to be held by no source before it is printed.
//
// ── Allocation is monotone: highest + 1, never a gap ───────────────────────
//
// The next id is one past the HIGHEST id seen in the family, not the lowest
// unused one. The case that decides this is an id that vanished from every
// tracked source — `V3-5.18` and `V3-5.20`–`V3-5.22` are absent from the board
// today while lane branches, landed reports and review artifacts all name them.
// Executed against a board holding `V3-2.1`, `.2`, `.3`, `.6`, highest+1 answers
// `V3-2.7` while lowest-free-gap answers `V3-2.4` and reissues a number history
// still holds. History is precisely what an allocator cannot see; numbers are
// cheap, and a second V3-2.17 is not.
//
// Do NOT justify this by the V3-2.17 collision itself: once review-items.tsv is
// read, `V3-2.17` is occupied rather than a gap, and BOTH designs answer
// `V3-2.18`. The registry read is what closes that incident. Monotone allocation
// closes the vanished-id one, and stating the wrong reason here is how a later
// reader "simplifies" it back.
//
// ── What it does NOT cover ─────────────────────────────────────────────────
//
//   1. A row id claimed on ANOTHER LANE'S UNLANDED BRANCH is invisible: this
//      reads the tree it is run in. That is the residual half of the V3-2.17
//      shape — the registry row usually lands with the dispatch, which is why
//      review-items.tsv is read, but a lane that files a board row and lands it
//      later can still collide. Mitigation is procedural until a row exists for
//      it: allocate from a freshly rebased tree, immediately before writing the
//      row.
//   2. A row id mentioned only in PROSE is not read. The structured field is
//      the allocation record; deciding "does this sentence claim an id" from
//      text is the judgement the structured field exists to replace.
//   3. **Monotone allocation protects a vanished id only BELOW the family
//      maximum.** This is the stated limit of the argument above, and it is not
//      hypothetical: `V3-1.13` is recorded as a spent row id in two tracked
//      instance records (`instance/branch-inventory-2026-08-05.md`,
//      `instance/hygiene-branch-dispositions.txt`) and was never a board row, so
//      the highest V3-1 id any structured source holds is `V3-1.12` and this
//      tool answers `V3-1.13` — an id already spent. Below the maximum a
//      vanished id is fenced in by a surviving larger one; at the maximum there
//      is nothing above it to fence it in.
//      The repair is a per-family high-water mark carried as a tracked source,
//      so a retired maximum keeps its slot. That is a new governance record
//      rather than a change to this tool, it must be seeded from the retired
//      ids scattered through the instance records, and it is out of scope for
//      the lane that found this. Until it exists the limit is stated here,
//      locked by test, and printed as a caveat on every allocation — because
//      the one thing this tool must never do is present that residue as
//      certainty. Reading those two prose records directly was considered and
//      rejected: they are dated one-off artifacts, and hard-coding them here
//      re-imports the prose judgement point 2 exists to keep out.
//   4. It allocates; it does not write. Nothing here edits the board, and the
//      duplicate check runs over what is already tracked, so it says nothing
//      about the row the caller is about to add beyond giving it a free id.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const WORKBOARD_FILE = join("instance", "workboard.md");
export const REVIEW_ITEMS_FILE = join("instance", "review-items.tsv");
export const HR_STATE_EXEMPTIONS_FILE = join("instance", "hr-state-exemptions.tsv");
export const DOC_PATH_EXEMPTIONS_FILE = join("instance", "doc-path-exemptions.tsv");
export const PARKED_DIR = join("instance", "parked");
export const DECISIONS_DIR = join("instance", "decisions");
export const TRIAGE_FILE = join("instance", "decisions", "triage.jsonl");
export const FLEET_NUDGE_FILE = join("orchestrator", "fleet", "fleet-nudge.sh");

// awk's `[[:space:]]` in the board parser, minus the newline the line split
// already consumed. NOT `\s`, and never `.trim()`: both strip U+00A0 and U+FEFF,
// which POSIX `[[:space:]]` does not, so a cell the parser refuses would be
// trimmed clean here and blessed. Bare `\r` stays in the class because a lone CR
// survives the `/\r?\n/` split and awk treats it as space.
const LINE_SPACE = "[ \\t\\v\\f\\r]";
const LEADING_PIPE = new RegExp(`^${LINE_SPACE}*\\|`);
const TRAILING_PIPE = new RegExp(`\\|${LINE_SPACE}*$`);
const CELL_EDGES = new RegExp(`^${LINE_SPACE}+|${LINE_SPACE}+$`, "g");

/** awk's `trim()`, character class included. */
function trimCell(cell: string): string {
  return cell.replace(CELL_EDGES, "");
}

// Transcribed from the awk recognizer in FLEET_NUDGE_FILE; locked against it by
// test. Kept as a source string rather than a literal so the test can compare
// the two texts directly instead of comparing a regex to a string.
export const ID_SHAPE = "^[A-Z][A-Z0-9]*-([0-9]+(\\.[0-9]+)?[a-z]?|GOV)$";

const ID = new RegExp(ID_SHAPE);

/**
 * The closure fields of an HR decision file, per `instructions/instruction-layers.md`.
 * `closes` is deliberately absent: it is a triage-row field (see TRIAGE_FILE).
 *
 * Leading whitespace is allowed because an INDENTED closure field was invisible
 * here while still naming a row — the unsafe direction. The field is matched
 * anywhere in the file, including inside a quotation, which over-reserves an id
 * that was only being discussed. That direction is safe by construction (it can
 * skip a free id, never hand out a held one) and is preferred to the frontmatter
 * scoping that would fix it: many tracked HR files carry no frontmatter at all,
 * so scoping to it would read nothing in them and fail OPEN.
 */
const CLOSURE_FIELDS = /^[ \t]*(?:tracked-by|routes-to|superseded-by)\s*:\s*(.*)$/;

/** Ids taken, mapped to the source names that claim them. */
export type Taken = Map<string, Set<string>>;

function claim(taken: Taken, id: string, source: string): void {
  const sources = taken.get(id) ?? new Set<string>();
  sources.add(source);
  taken.set(id, sources);
}

/** Every ID_SHAPE token in a field value. Values are polymorphic by design —
 * `routes-to: branching-policy` names a doc, `routes-to: V3-3.8` names a row —
 * so a non-id value contributes nothing rather than failing. */
function idsIn(value: string): string[] {
  return value
    .split(/[\s,;`'"()[\]]+/)
    .filter((token) => ID.test(token));
}

function read(repo: string, relative: string, errors: string[]): string | undefined {
  const path = join(repo, relative);
  if (!existsSync(path)) {
    errors.push(`${relative}: absent — a declared id source that cannot be read is not an empty one`);
    return undefined;
  }
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    errors.push(`${relative}: unreadable — ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function entries(repo: string, relative: string, errors: string[]): string[] | undefined {
  const path = join(repo, relative);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    errors.push(`${relative}: absent — a declared id source that cannot be read is not an empty one`);
    return undefined;
  }
  return readdirSync(path).sort();
}

/**
 * The board's row ids, read exactly as orchestrator/fleet/fleet-nudge.sh reads
 * them: an `id` header opens a table, any non-table line closes it, a separator
 * row is skipped, and every other leading cell must be a well-formed, unique id.
 * A board with no table or no row is structural damage, never an empty result.
 */
export function collectWorkboard(repo: string, errors: string[]): Taken {
  const taken: Taken = new Map();
  const text = read(repo, WORKBOARD_FILE, errors);
  if (text === undefined) return taken;

  const lines = text.split(/\r?\n/);
  let inTable = false;
  let tables = 0;
  let rows = 0;
  const seen = new Map<string, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const at = `${WORKBOARD_FILE}:${index + 1}`;
    if (!LEADING_PIPE.test(line)) {
      inTable = false;                                  // a stray pipe in prose is not a row
      continue;
    }
    const cells = line
      .replaceAll("\\|", "\u001c")                      // an escaped pipe is cell text
      .replace(LEADING_PIPE, "")
      .replace(TRAILING_PIPE, "")
      .split("|")
      .map((cell) => trimCell(cell).replaceAll("\u001c", "|"));

    if (cells[0]?.toLowerCase() === "id") { inTable = true; tables += 1; continue; }
    if (/^:?--+:?$/.test(cells[0] ?? "")) continue;
    if (!inTable) continue;

    rows += 1;
    const id = cells[0] ?? "";
    if (!ID.test(id)) {
      errors.push(`${at}: malformed workboard row id: ${id || "(empty)"} — the fleet-nudge parser refuses the whole board on this`);
      continue;
    }
    const first = seen.get(id);
    if (first !== undefined) {
      errors.push(`${at}: duplicate workboard id ${id}, first seen at ${WORKBOARD_FILE}:${first} — this is the V3-2.17 failure, caught before the commit`);
      continue;
    }
    seen.set(id, index + 1);
    claim(taken, id, "workboard");
  }

  if (tables === 0) errors.push(`${WORKBOARD_FILE}: no table declares an \`id\` column — the board cannot be read`);
  else if (rows === 0) errors.push(`${WORKBOARD_FILE}: no parseable rows — an unreadable board must never read as "no ids taken"`);
  return taken;
}

/** The review registry's item-id column. A comment or blank line is skipped;
 * anything else must be a well-formed id, because a row in review holds its id
 * just as hard as a row on the board. */
export function collectReviewItems(repo: string, errors: string[]): Taken {
  const taken: Taken = new Map();
  const text = read(repo, REVIEW_ITEMS_FILE, errors);
  if (text === undefined) return taken;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || line.startsWith("#")) continue;
    const id = line.split("\t")[0]!.trim();
    if (!ID.test(id)) {
      errors.push(`${REVIEW_ITEMS_FILE}:${index + 1}: malformed item-id: ${id || "(empty)"}`);
      continue;
    }
    claim(taken, id, "review-items");
  }
  return taken;
}

/** The exemption and decision ledgers' structured id-bearing fields. */
export function collectLedgers(repo: string, errors: string[]): Taken {
  const taken: Taken = new Map();

  // instance/hr-state-exemptions.tsv — `owner=<row>` in the evidence field.
  const hrState = read(repo, HR_STATE_EXEMPTIONS_FILE, errors);
  if (hrState !== undefined) {
    for (const match of hrState.matchAll(/\bowner=([^\s;]+)/g)) {
      for (const id of idsIn(match[1]!)) claim(taken, id, "hr-state-exemptions");
    }
  }

  // instance/doc-path-exemptions.tsv — the `pending-<row>` reason.
  const docPath = read(repo, DOC_PATH_EXEMPTIONS_FILE, errors);
  if (docPath !== undefined) {
    for (const match of docPath.matchAll(/\bpending-(\S+)/g)) {
      for (const id of idsIn(match[1]!)) claim(taken, id, "doc-path-exemptions");
    }
  }

  // instance/parked/ — every file is named `<row>-<slug>.md`. A file that does
  // not open with a row id is an error: the id prefix IS the ledger key here,
  // so an unparseable name is a claim this tool cannot see.
  const parked = entries(repo, PARKED_DIR, errors);
  if (parked !== undefined) {
    for (const entry of parked) {
      // A `.bak`, a `.txt`, an extensionless leftover or a nested directory is
      // an ERROR, not a skip. Every one of those names a parked row whose claim
      // would otherwise be dropped in silence, at exit 0 — a merge leaving a
      // `.orig` behind is enough. Nothing legitimate here is non-`.md`, so the
      // filter's only present effect was to lose claims.
      if (!entry.endsWith(".md")) {
        errors.push(`${join(PARKED_DIR, entry)}: not a \`.md\` parked row — a declared source's unexpected entry is an error, not a skipped file`);
        continue;
      }
      const id = entry.match(/^([^-]+-[0-9]+(?:\.[0-9]+)?[a-z]?)-/)?.[1];
      if (id === undefined || !ID.test(id)) {
        errors.push(`${join(PARKED_DIR, entry)}: does not open with a row id — a parked row's id is its filename prefix`);
        continue;
      }
      claim(taken, id, "parked");
    }
  }

  // instance/decisions/HR-*.md — the closure fields. Their values are
  // polymorphic (a doc id, a path, or a row id), so only id-shaped tokens count.
  const decisions = entries(repo, DECISIONS_DIR, errors);
  if (decisions !== undefined) {
    for (const entry of decisions) {
      // Case-insensitive, as ledger.ts matches decision files at all three of
      // its call sites. A file the ledger checker enforces and this tool cannot
      // see is a row id held by the authority and free to the allocator.
      if (!/^HR-.+\.md$/i.test(entry)) continue;
      const contents = read(repo, join(DECISIONS_DIR, entry), errors);
      if (contents === undefined) continue;
      for (const line of contents.split(/\r?\n/)) {
        const value = line.match(CLOSURE_FIELDS)?.[1];
        if (value === undefined) continue;
        for (const id of idsIn(value)) claim(taken, id, "decisions");
      }
    }
  }

  // instance/decisions/triage.jsonl — the `closes` field of a triage row, which
  // is where the decisions ledger actually carries that claim. A line that is
  // not a JSON object is an error: a ledger this tool cannot parse is not a
  // ledger holding no ids.
  const triage = read(repo, TRIAGE_FILE, errors);
  if (triage !== undefined) {
    const lines = triage.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.trim() === "") continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch (error) {
        errors.push(`${TRIAGE_FILE}:${index + 1}: not a JSON row — ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        errors.push(`${TRIAGE_FILE}:${index + 1}: not a JSON object`);
        continue;
      }
      const closes = (row as Record<string, unknown>)["closes"];
      if (closes === undefined) continue;
      for (const id of idsIn(String(closes))) claim(taken, id, "triage");
    }
  }

  return taken;
}

/** The declared sources, in report order. Adding a source is a row here. */
export const SOURCES: { name: string; collect: (repo: string, errors: string[]) => Taken }[] = [
  { name: "workboard", collect: collectWorkboard },
  { name: "review-items", collect: collectReviewItems },
  { name: "ledgers", collect: collectLedgers },
];

/** Every taken id, mapped to the sources claiming it. Errors are collected, not
 * thrown: the caller reports all of them rather than the first. */
export function collectTaken(repo: string): { taken: Taken; errors: string[] } {
  const errors: string[] = [];
  const taken: Taken = new Map();
  for (const source of SOURCES) {
    for (const [id, sources] of source.collect(repo, errors)) {
      for (const name of sources) claim(taken, id, name);
    }
  }
  return { taken, errors };
}

export type Allocation = {
  /** The next free id. */
  id: string;
  /** The highest id already held in the family, absent when the family is empty. */
  highest?: string;
  /** The sources claiming `highest` — so an unexpected jump is attributable. */
  highestFrom: string[];
  /** Ids already held in the family, in numeric order. */
  family: string[];
  /** Distinct ids held across every source and every family. */
  takenTotal: number;
  /** How many ids each source contributed overall. */
  bySource: Map<string, number>;
};

/**
 * The two properties the whole command claims, asserted about its own answer:
 * the id is well-formed to the board parser, and no source holds it. Both are
 * true by construction of the code above — which is exactly why they are worth
 * checking here. The construction is what a later edit changes, and this is the
 * only place that notices when it stops holding.
 */
export function validateAnswer(id: string, taken: Taken): string[] {
  const errors: string[] = [];
  if (!ID.test(id)) {
    errors.push(
      `allocated ${id}, which is not a well-formed id — the fleet-nudge parser refuses the WHOLE board on one of these, ` +
        `so this is the second historical failure being re-created by the guard built to prevent it.`,
    );
  }
  const holders = taken.get(id);
  if (holders) {
    errors.push(`allocated ${id}, which is already held by ${[...holders].sort().join("+")} — the allocator must never hand out a taken id.`);
  }
  return errors;
}

/**
 * The next free id under `prefix`. `prefix` must be a LEAF prefix: every taken
 * id starting with it must continue with a plain number (optionally with the
 * trailing letter the id contract permits). `V3-5.` is a leaf; `V3-` is not,
 * because `V3-5.23` extends it, and answering `V3-6` there would be a guess
 * dressed as a computation.
 */
export function allocate(repo: string, prefix: string): { errors: string[]; allocation?: Allocation } {
  const { taken, errors } = collectTaken(repo);
  if (!ID.test(`${prefix}1`)) {
    errors.push(`--prefix ${prefix}: ${prefix}1 is not a well-formed id — the prefix must be the stem of one, e.g. V3-5.`);
  }
  if (errors.length) return { errors };

  const family = new Map<number, string>();
  const extending: string[] = [];
  const uncountable: string[] = [];
  for (const id of taken.keys()) {
    if (!id.startsWith(prefix)) continue;
    const match = id.slice(prefix.length).match(/^([0-9]+)([a-z]?)$/);
    if (!match) { extending.push(id); continue; }
    const digits = match[1]!;
    const ordinal = Number(digits);
    // ID_SHAPE permits an unbounded digit run, and Number() does not. A
    // fat-fingered `V3-5.1000000000000000000000` reads back as `1e+21` and a
    // `...93` past 2^53 reads back one lower than the id already on the board —
    // so the allocator would answer, respectively, an id the parser refuses and
    // an id below one already held. Neither is a number this tool may count on.
    if (!Number.isSafeInteger(ordinal) || String(ordinal) !== digits) {
      uncountable.push(id);
      continue;
    }
    // A letter-suffixed id shares its ordinal (V3-1.9b sits in slot 9), so the
    // slot is held by both and the label kept is the plain one.
    if (!family.has(ordinal) || match[2] === "") family.set(ordinal, id);
  }
  if (uncountable.length) {
    return {
      errors: uncountable.sort().map(
        (id) =>
          `${id}: the ordinal is not a number this tool can count on — it is past 2^53 or carries leading zeros, ` +
          `so allocating from it would answer an id the fleet-nudge parser refuses, or one below an id already held.`,
      ),
    };
  }
  if (extending.length) {
    // Named, not counted — but bounded, because "V3-" lists 126 of them and a
    // refusal nobody reads to the end is a refusal that teaches nothing.
    const shown = extending.sort();
    const named = shown.length > 5 ? `${shown.slice(0, 5).join(", ")} and ${shown.length - 5} more` : shown.join(", ");
    return {
      errors: [
        `--prefix ${prefix}: not a leaf prefix — ${named} extend${extending.length === 1 ? "s" : ""} it. ` +
          `Allocating under a prefix that other ids extend would hand out an id whose family this tool did not measure.`,
      ],
    };
  }

  const ordinals = [...family.keys()].sort((left, right) => left - right);
  const next = (ordinals.at(-1) ?? 0) + 1;
  const highest = ordinals.length ? family.get(ordinals.at(-1)!) : undefined;

  const id = `${prefix}${next}`;
  const answerErrors = validateAnswer(id, taken);
  if (answerErrors.length) return { errors: answerErrors };

  const bySource = new Map<string, number>();
  for (const sources of taken.values()) {
    for (const name of sources) bySource.set(name, (bySource.get(name) ?? 0) + 1);
  }

  return {
    allocation: {
      id,
      highest,
      highestFrom: highest ? [...(taken.get(highest) ?? [])].sort() : [],
      family: ordinals.map((ordinal) => family.get(ordinal)!),
      takenTotal: taken.size,
      bySource,
    },
    errors: [],
  };
}

if (import.meta.main) {
  const argv = process.argv;
  const repoIndex = argv.indexOf("--repo");
  const repo = repoIndex >= 0 ? argv[repoIndex + 1] : process.cwd();
  const prefixIndex = argv.indexOf("--prefix");
  const prefix = prefixIndex >= 0 ? argv[prefixIndex + 1] : undefined;
  if (!repo) throw new Error("--repo requires a path");
  if (!prefix) {
    console.error("NEXT-ID --prefix is required, e.g. --prefix V3-5.");
    process.exit(2);
  }

  const { allocation, errors } = allocate(repo, prefix);
  if (!allocation) {
    console.error(errors.map((error) => `NEXT-ID ${error}`).join("\n"));
    process.exit(1);
  }

  // The id alone on stdout, so the caller can consume it directly; the evidence
  // on stderr, so a surprising answer is attributable without being parsed.
  const sources = [...allocation.bySource].map(([name, count]) => `${name}:${count}`).join(",");
  console.error(
    `NEXT-ID next=${allocation.id} prefix=${prefix} highest=${allocation.highest ?? "(none)"} ` +
      `highest_from=${allocation.highestFrom.join("+") || "(none)"} family=${allocation.family.length} ` +
      `taken=${allocation.takenTotal} sources=${sources}`,
  );
  // The stated limit, printed rather than left in a comment: highest+1 fences in
  // a vanished id only when a larger one survives, so a family maximum retired
  // from every tracked source is handed out again. V3-1.13 is that case in this
  // repository today. A limit nobody is told about at the moment of use is a
  // limit that is only ever discovered by the collision.
  console.error(
    `NEXT-ID caveat: an id retired from every tracked source AT the family maximum is reissued ` +
      `(live case: V3-1.13, spent per instance/branch-inventory-2026-08-05.md and instance/hygiene-branch-dispositions.txt). ` +
      `Monotone allocation fences in a vanished id only below the maximum.`,
  );
  console.log(allocation.id);
}

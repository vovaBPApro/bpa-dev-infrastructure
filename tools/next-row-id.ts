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
//                  each instance/parked/ filename, and the closure fields
//                  (`tracked-by:`, `routes-to:`, `superseded-by:`, `closes:`)
//                  of instance/decisions/HR-*.md.
//
// Every source is DECLARED (see SOURCES below). An absent declared source is an
// error, never an empty contribution: a source that silently reads as empty is
// how an allocator hands out an id somebody already holds.
//
// ── The id contract is the parser's, not this file's ───────────────────────
//
// ID_SHAPE is transcribed from the awk recognizer in
// orchestrator/fleet/fleet-nudge.sh, and next-row-id.test.ts extracts that awk
// literal and asserts the two are the same string. So this tool refuses exactly
// what the parser refuses — a bolded id cell, a malformed id, a duplicate — and
// cannot drift into blessing an id the board will later choke on. This file
// does not modify the parser; it agrees with it under test.
//
// ── Allocation is monotone: highest + 1, never a gap ───────────────────────
//
// The next id is one past the HIGHEST id seen in the family, not the lowest
// unused one. A gap in the numbering is not free space: `V3-5.18` and
// `V3-5.20`–`V3-5.22` are absent from the board today while lane branches,
// landed reports and review artifacts all name them. Reusing a number that
// vanished from every tracked source would collide with history that is no
// longer in the tree, and history is precisely what an allocator cannot see.
// Numbers are cheap; a second V3-2.17 is not.
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
//   3. It allocates; it does not write. Nothing here edits the board, and the
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
export const FLEET_NUDGE_FILE = join("orchestrator", "fleet", "fleet-nudge.sh");

// Transcribed from the awk recognizer in FLEET_NUDGE_FILE; locked against it by
// test. Kept as a source string rather than a literal so the test can compare
// the two texts directly instead of comparing a regex to a string.
export const ID_SHAPE = "^[A-Z][A-Z0-9]*-([0-9]+(\\.[0-9]+)?[a-z]?|GOV)$";

const ID = new RegExp(ID_SHAPE);

/** The closure fields of the decisions ledger, per `instructions/instruction-layers.md`. */
const CLOSURE_FIELDS = /^(?:tracked-by|routes-to|superseded-by|closes)\s*:\s*(.*)$/;

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
    if (!/^[ \t]*\|/.test(line)) {
      inTable = false;                                  // a stray pipe in prose is not a row
      continue;
    }
    const cells = line
      .replaceAll("\\|", "\u001c")                      // an escaped pipe is cell text
      .replace(/^[ \t]*\|/, "")
      .replace(/\|[ \t]*$/, "")
      .split("|")
      .map((cell) => cell.trim().replaceAll("\u001c", "|"));

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
      if (!entry.endsWith(".md")) continue;
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
      if (!/^HR-.+\.md$/.test(entry)) continue;
      const contents = read(repo, join(DECISIONS_DIR, entry), errors);
      if (contents === undefined) continue;
      for (const line of contents.split(/\r?\n/)) {
        const value = line.match(CLOSURE_FIELDS)?.[1];
        if (value === undefined) continue;
        for (const id of idsIn(value)) claim(taken, id, "decisions");
      }
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
  for (const id of taken.keys()) {
    if (!id.startsWith(prefix)) continue;
    const match = id.slice(prefix.length).match(/^([0-9]+)([a-z]?)$/);
    if (!match) { extending.push(id); continue; }
    const ordinal = Number(match[1]!);
    // A letter-suffixed id shares its ordinal (V3-1.9b sits in slot 9), so the
    // slot is held by both and the label kept is the plain one.
    if (!family.has(ordinal) || match[2] === "") family.set(ordinal, id);
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

  const bySource = new Map<string, number>();
  for (const sources of taken.values()) {
    for (const name of sources) bySource.set(name, (bySource.get(name) ?? 0) + 1);
  }

  return {
    allocation: {
      id: `${prefix}${next}`,
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
  console.log(allocation.id);
}

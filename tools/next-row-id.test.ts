import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ID_SHAPE, FLEET_NUDGE_FILE, allocate, collectTaken, collectWorkboard, validateAnswer } from "./next-row-id";

// A minimal repository carrying only the declared sources. Every default is
// valid and nearly empty, so each case below adds exactly one thing and the
// answer it produces is attributable to that one thing.
function fixture(options: {
  workboard?: string;
  reviewItems?: string;
  hrStateExemptions?: string;
  docPathExemptions?: string;
  parked?: string[];
  parkedDirs?: string[];
  decisions?: { name: string; body: string }[];
  triage?: string;
  omit?: ("workboard" | "review-items" | "hr-state-exemptions" | "doc-path-exemptions" | "parked" | "decisions" | "triage")[];
}): string {
  const repo = mkdtempSync(join(tmpdir(), "next-row-id-"));
  const omit = new Set(options.omit ?? []);
  mkdirSync(join(repo, "instance"), { recursive: true });
  if (!omit.has("parked")) mkdirSync(join(repo, "instance", "parked"), { recursive: true });
  if (!omit.has("decisions")) mkdirSync(join(repo, "instance", "decisions"), { recursive: true });
  if (!omit.has("workboard")) writeFileSync(join(repo, "instance", "workboard.md"), options.workboard ?? DEFAULT_BOARD);
  if (!omit.has("review-items")) {
    writeFileSync(join(repo, "instance", "review-items.tsv"), options.reviewItems ?? "# item-id\tstable-branch-root\n");
  }
  if (!omit.has("hr-state-exemptions")) {
    writeFileSync(join(repo, "instance", "hr-state-exemptions.tsv"), options.hrStateExemptions ?? "# file\tcheck\texpiry\tevidence (owner=<id>)\n");
  }
  if (!omit.has("doc-path-exemptions")) {
    writeFileSync(join(repo, "instance", "doc-path-exemptions.tsv"), options.docPathExemptions ?? "# source\tpath\treason (pending-<row>)\tnote\n");
  }
  for (const name of options.parked ?? []) writeFileSync(join(repo, "instance", "parked", name), "parked\n");
  for (const name of options.parkedDirs ?? []) mkdirSync(join(repo, "instance", "parked", name), { recursive: true });
  for (const row of options.decisions ?? []) writeFileSync(join(repo, "instance", "decisions", row.name), row.body);
  if (!omit.has("triage") && !omit.has("decisions")) {
    writeFileSync(join(repo, "instance", "decisions", "triage.jsonl"), options.triage ?? "");
  }
  return repo;
}

// One table, one row, so a case that adds an id elsewhere starts from V3-5.2.
// No trailing blank line: a case that appends a row appends it to the SAME
// table, and a blank line would close the table before it (which is the
// parser's rule, exercised by the stray-pipe case below).
const DEFAULT_BOARD = ["| id | row | state |", "|---|---|---|", "| V3-5.1 | the only row | **done** |"].join("\n");

function withFixture<T>(options: Parameters<typeof fixture>[0], body: (repo: string) => T): T {
  const repo = fixture(options);
  try {
    return body(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function nextId(options: Parameters<typeof fixture>[0], prefix = "V3-5."): { id?: string; errors: string[] } {
  return withFixture(options, (repo) => {
    const result = allocate(repo, prefix);
    return { id: result.allocation?.id, errors: result.errors };
  });
}

// ── The live repository ────────────────────────────────────────────────────

test("the repository's own sources parse, and the allocated id is past the board", () => {
  const repo = join(import.meta.dir, "..");
  const { taken, errors } = collectTaken(repo);
  expect(errors).toEqual([]);
  expect(taken.size).toBeGreaterThan(0);

  const executed = Bun.spawnSync([process.execPath, "tools/next-row-id.ts", "--repo", repo, "--prefix", "V3-5."], { cwd: repo });
  expect(executed.exitCode, executed.stderr.toString()).toBe(0);
  // The id alone on stdout, so a caller can consume it directly; the evidence
  // on stderr, so a surprising answer is attributable without being parsed.
  const id = executed.stdout.toString().trim();
  expect(id).toMatch(/^V3-5\.[0-9]+$/);
  expect(taken.has(id)).toBe(false);
  expect(executed.stderr.toString()).toContain(`NEXT-ID next=${id} prefix=V3-5.`);
});

// The two files state the same id contract in two languages. A board id this
// tool blesses and the parser refuses would be handed out and then break main —
// which is the exact incident G2 exists for — so the texts are compared, not
// the behaviours.
test("the id shape is the fleet-nudge parser's, character for character", () => {
  const nudge = readFileSync(join(import.meta.dir, "..", FLEET_NUDGE_FILE), "utf8");
  const awk = nudge.match(/if \(id !~ \/(.+)\/\) \{/)?.[1];
  expect(awk, `no id recognizer found in ${FLEET_NUDGE_FILE}`).toBeDefined();
  expect(awk).toBe(ID_SHAPE);
});

// ── A named test per source ────────────────────────────────────────────────

test("an id present only in the workboard is skipped", () => {
  const board = [DEFAULT_BOARD, "| V3-5.2 | on the board and nowhere else | **open** |", ""].join("\n");
  expect(nextId({ workboard: board })).toEqual({ id: "V3-5.3", errors: [] });
});

test("an id present only in the review-items registry is skipped", () => {
  // The registry holds an id the board has never seen — a row dispatched and in
  // review before its board row landed.
  expect(nextId({ reviewItems: "# item-id\tstable-branch-root\nV3-5.2\tag-v3-5.2\n" })).toEqual({ id: "V3-5.3", errors: [] });
});

test("an id present only in the hr-state exemption ledger is skipped", () => {
  const ledger = "instance/decisions/HR-1.md\thr-closure-unresolved\t2026-08-19\towner=V3-5.2; legacy closure target\n";
  expect(nextId({ hrStateExemptions: ledger })).toEqual({ id: "V3-5.3", errors: [] });
});

test("an id present only in the doc-path exemption ledger is skipped", () => {
  const ledger = "CLAUDE.md\tinstance/README.md\tpending-V3-5.2\tnever written on v3\n";
  expect(nextId({ docPathExemptions: ledger })).toEqual({ id: "V3-5.3", errors: [] });
});

test("an id present only as a parked file's name is skipped", () => {
  expect(nextId({ parked: ["V3-5.2-deferred-2026-08-05.md"] })).toEqual({ id: "V3-5.3", errors: [] });
});

test("an id present only in a decision's closure field is skipped", () => {
  const decisions = [{ name: "HR-9.md", body: "---\nstate: owed\ntracked-by: V3-5.2\n---\n\nbody\n" }];
  expect(nextId({ decisions })).toEqual({ id: "V3-5.3", errors: [] });
});

test("a closure field naming a doc or a path contributes no id and fails nothing", () => {
  const decisions = [
    { name: "HR-9.md", body: "---\nstate: routed\nroutes-to: branching-policy\n---\n" },
    { name: "HR-10.md", body: "---\nstate: routed\nroutes-to: instance/params.yaml\n---\n" },
  ];
  expect(nextId({ decisions })).toEqual({ id: "V3-5.2", errors: [] });
});

// ── The historical shapes ──────────────────────────────────────────────────

// V3-2.17: another lane filed a row under that id the same morning, the id was
// handed out a second time, and the duplicate made the fleet-nudge parser
// refuse the whole board. Reconstructed at the moment before the second
// assignment: the board's highest Phase 2 row is V3-2.16, and V3-2.17 exists
// only as the other lane's registry row.
test("the V3-2.17 shape: an id filed by another lane the same morning is not handed out again", () => {
  const board = [
    "| id | row | state |",
    "|---|---|---|",
    "| V3-2.15 | audit finding F1 | **done** |",
    "| V3-2.16 | the highest Phase 2 row on the board | **open** |",
    "",
  ].join("\n");
  const registry = "# item-id\tstable-branch-root\nV3-2.17\tag-v3-2.17\n";
  expect(nextId({ workboard: board, reviewItems: registry }, "V3-2.")).toEqual({ id: "V3-2.18", errors: [] });
});

// And the other half of the same incident: once the duplicate IS on the board,
// the tool refuses rather than answering, because that board is the one the
// parser rejects. The catch moves to before the commit; it does not soften.
test("a duplicate already on the board is refused, naming both lines", () => {
  const board = [
    "| id | row | state |",
    "|---|---|---|",
    "| V3-2.17 | filed by the other lane | **open** |",
    "| V3-2.17 | filed again by this one | **open** |",
    "",
  ].join("\n");
  const { id, errors } = nextId({ workboard: board }, "V3-2.");
  expect(id).toBeUndefined();
  expect(errors).toEqual([
    "instance/workboard.md:4: duplicate workboard id V3-2.17, first seen at instance/workboard.md:3 — this is the V3-2.17 failure, caught before the commit",
  ]);
});

// V3-3.1/V3-3.2: already held by Phase 3 BACKLOG rows, which sit in a later
// table further down the file than the phase being allocated from.
test("the V3-3.1 shape: ids held by a backlog table further down the board are seen", () => {
  const board = [
    "| id | row | state |",
    "|---|---|---|",
    "| V3-0.1 | phase 0 | **done** |",
    "",
    "## Phase 3 — backlog",
    "",
    "| id | row | state |",
    "|---|---|---|",
    "| V3-3.1 | held by the backlog | **open** |",
    "| V3-3.2 | held by the backlog | **open** |",
    "",
  ].join("\n");
  expect(nextId({ workboard: board }, "V3-3.")).toEqual({ id: "V3-3.3", errors: [] });
});

// ── Fail-closed: an unreadable source is an error, never an empty result ───

test("an absent workboard is an error, not an empty result", () => {
  const { id, errors } = nextId({ omit: ["workboard"] });
  expect(id).toBeUndefined();
  expect(errors).toContain("instance/workboard.md: absent — a declared id source that cannot be read is not an empty one");
});

test.each([
  ["review-items", "instance/review-items.tsv"],
  ["hr-state-exemptions", "instance/hr-state-exemptions.tsv"],
  ["doc-path-exemptions", "instance/doc-path-exemptions.tsv"],
  ["parked", "instance/parked"],
  ["decisions", "instance/decisions"],
  ["triage", "instance/decisions/triage.jsonl"],
] as const)("an absent %s source is an error, not an empty result", (source, path) => {
  const { id, errors } = nextId({ omit: [source] });
  expect(id).toBeUndefined();
  expect(errors).toContain(`${path}: absent — a declared id source that cannot be read is not an empty one`);
});

test("a board with no table declaring an id column is an error", () => {
  const board = ["| file | target layer |", "|---|---|", "| a.md | L2 |", ""].join("\n");
  const { id, errors } = nextId({ workboard: board });
  expect(id).toBeUndefined();
  expect(errors).toContain("instance/workboard.md: no table declares an `id` column — the board cannot be read");
});

test("a board whose id table carries no rows is an error", () => {
  const { id, errors } = nextId({ workboard: ["| id | row | state |", "|---|---|---|", ""].join("\n") });
  expect(id).toBeUndefined();
  expect(errors).toContain('instance/workboard.md: no parseable rows — an unreadable board must never read as "no ids taken"');
});

test("a malformed board id is refused with the same verdict the parser gives", () => {
  const board = [DEFAULT_BOARD, "| **V3-5.2** | a bolded id cell |  **open** |", ""].join("\n");
  const { id, errors } = nextId({ workboard: board });
  expect(id).toBeUndefined();
  expect(errors).toEqual([
    "instance/workboard.md:4: malformed workboard row id: **V3-5.2** — the fleet-nudge parser refuses the whole board on this",
  ]);
});

test("a malformed item-id in the registry is refused", () => {
  const { id, errors } = nextId({ reviewItems: "# item-id\tbranch\nnot an id\tag-x\n" });
  expect(id).toBeUndefined();
  expect(errors).toContain("instance/review-items.tsv:2: malformed item-id: not an id");
});

test("a parked file whose name does not open with a row id is refused", () => {
  const { id, errors } = nextId({ parked: ["README.md"] });
  expect(id).toBeUndefined();
  expect(errors).toContain("instance/parked/README.md: does not open with a row id — a parked row's id is its filename prefix");
});

// A stray pipe in prose must not be read as a row — the parser closes the table
// on any non-table line, and so does this.
test("a pipe in prose after a table does not become a row", () => {
  const board = [DEFAULT_BOARD, "prose mentioning a | pipe", "| V3-9.9 | not a row, the table closed above | **open** |", ""].join("\n");
  expect(nextId({ workboard: board })).toEqual({ id: "V3-5.2", errors: [] });
});

// ── Allocation semantics ───────────────────────────────────────────────────

test("a gap in the numbering is not reused: allocation is highest + 1", () => {
  const board = [
    "| id | row | state |",
    "|---|---|---|",
    "| V3-5.1 | present | **done** |",
    "| V3-5.4 | present, with 2 and 3 gone from every source | **open** |",
    "",
  ].join("\n");
  expect(nextId({ workboard: board })).toEqual({ id: "V3-5.5", errors: [] });
});

test("a letter-suffixed id holds its whole ordinal", () => {
  const board = [
    "| id | row | state |",
    "|---|---|---|",
    "| V3-1.9 | the row | **done** |",
    "| V3-1.9b | its split-out half | **open** |",
    "",
  ].join("\n");
  expect(nextId({ workboard: board }, "V3-1.")).toEqual({ id: "V3-1.10", errors: [] });
});

test("an empty family allocates the first id", () => {
  expect(nextId({}, "V9-1.")).toEqual({ id: "V9-1.1", errors: [] });
});

test("a prefix other ids extend is refused rather than answered", () => {
  const { id, errors } = nextId({}, "V3-");
  expect(id).toBeUndefined();
  expect(errors[0]).toContain("not a leaf prefix — V3-5.1 extends it");
});

test("a prefix that is not the stem of a well-formed id is refused", () => {
  const { id, errors } = nextId({}, "foo/");
  expect(id).toBeUndefined();
  expect(errors).toContain("--prefix foo/: foo/1 is not a well-formed id — the prefix must be the stem of one, e.g. V3-5.");
});

// F1. Monotone allocation fences in a vanished id only BELOW the family
// maximum. `V3-1.13` is that case in this repository today: two tracked
// instance records name it as a spent row id, it was never a board row, and so
// the tool hands it out. The behaviour is the stated limit rather than a bug to
// be silently carried, so what is locked is that the limit is STATED — in the
// file that makes the monotone argument, and on stderr at the moment of use.
// Strip either and this goes red.
test("the limit of monotone allocation: a vanished id AT the family maximum is reissued", () => {
  const board = [
    "| id | row | state |",
    "|---|---|---|",
    "| V3-1.11 | present | **done** |",
    "| V3-1.12 | the highest V3-1 id any structured source holds | **done** |",
    "",
  ].join("\n");
  // V3-1.13 is spent, and no structured source can say so: the tool reissues it.
  expect(nextId({ workboard: board }, "V3-1.")).toEqual({ id: "V3-1.13", errors: [] });
});

test("the reissue limit is stated where the monotone argument is made", () => {
  const source = readFileSync(join(import.meta.dir, "next-row-id.ts"), "utf8");
  expect(source).toContain("only BELOW the family");
  expect(source).toContain("V3-1.13");
  expect(source).toContain("instance/branch-inventory-2026-08-05.md");
});

test("every allocation prints the reissue limit as a caveat", () => {
  withFixture({}, (repo) => {
    const tool = join(import.meta.dir, "next-row-id.ts");
    const run = Bun.spawnSync([process.execPath, tool, "--repo", repo, "--prefix", "V3-5."]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString()).toBe("V3-5.2\n");
    expect(run.stderr.toString()).toContain("NEXT-ID caveat: an id retired from every tracked source AT the family maximum is reissued");
  });
});

// F2. ID_SHAPE permits an unbounded digit run; Number() does not. Both of these
// used to be ANSWERED: the first as `V3-5.1e+21`, which is the malformed id
// that makes fleet-nudge refuse the whole board, and the second as an id one
// BELOW the one already on the board.
test.each([
  ["a digit run past what Number() can hold", "V3-5.1000000000000000000000"],
  ["an ordinal one past 2^53", "V3-5.9007199254740993"],
  ["a leading-zero ordinal", "V3-5.007"],
])("%s is refused, not counted", (_name, id) => {
  const board = [DEFAULT_BOARD, `| ${id} | a fat-fingered ordinal | **open** |`, ""].join("\n");
  const { id: answer, errors } = nextId({ workboard: board });
  expect(answer).toBeUndefined();
  expect(errors[0]).toContain(`${id}: the ordinal is not a number this tool can count on`);
});

test("the answer is checked like any other id: malformed or taken is refused", () => {
  const taken = new Map([["V3-5.2", new Set(["workboard"])]]);
  expect(validateAnswer("V3-5.3", taken)).toEqual([]);
  expect(validateAnswer("V3-5.1e+21", taken)[0]).toContain("which is not a well-formed id");
  expect(validateAnswer("V3-5.2", taken)[0]).toContain("already held by workboard");
});

// F3. Every one of these is a parked row whose id was silently dropped, at exit
// 0, by `if (!entry.endsWith(".md")) continue` — and the id then handed out.
test.each([
  ["an editor backup", "V3-5.2-deferred.md.bak"],
  ["a renamed file", "V3-5.2-deferred.txt"],
  ["an extensionless leftover", "V3-5.2-deferred"],
])("a parked entry that is %s is an error, not a skipped file", (_name, entry) => {
  const { id, errors } = nextId({ parked: [entry] });
  expect(id).toBeUndefined();
  expect(errors).toContain(
    `instance/parked/${entry}: not a \`.md\` parked row — a declared source's unexpected entry is an error, not a skipped file`,
  );
});

test("a directory inside instance/parked/ is an error, not a skipped entry", () => {
  const { id, errors } = nextId({ parkedDirs: ["V3-5.2-deferred"] });
  expect(id).toBeUndefined();
  expect(errors).toContain(
    "instance/parked/V3-5.2-deferred: not a `.md` parked row — a declared source's unexpected entry is an error, not a skipped file",
  );
});

// F5. `closes` is a triage-row field. It was declared as a read source and
// looked for in instance/decisions/HR-*.md, where it never appears.
test("an id present only in a triage row's closes field is skipped", () => {
  const triage = `{"msg_id":1,"verdict":"directive","closes":"V3-5.2"}\n`;
  expect(nextId({ triage })).toEqual({ id: "V3-5.3", errors: [] });
});

test("a triage line that is not a JSON object is an error, not an empty ledger", () => {
  const { id, errors } = nextId({ triage: `{"msg_id":1,"closes":"V3-5.2"}\nnot json\n` });
  expect(id).toBeUndefined();
  expect(errors[0]).toContain("instance/decisions/triage.jsonl:2: not a JSON row");
});

// F6. ledger.ts matches decision files case-insensitively at all three of its
// call sites; a file it enforces and this tool cannot see holds an id the
// allocator believes is free.
test("an HR file is an HR file whatever the case of its name", () => {
  const decisions = [{ name: "hr-9.md", body: "---\nstate: owed\ntracked-by: V3-5.2\n---\n" }];
  expect(nextId({ decisions })).toEqual({ id: "V3-5.3", errors: [] });
});

// F7, the unsafe half: an INDENTED closure field still names a row.
test("an indented closure field is read, not missed", () => {
  const decisions = [{ name: "HR-9.md", body: "---\nstate: routed\nrouting:\n  routes-to: V3-5.2\n---\n" }];
  expect(nextId({ decisions })).toEqual({ id: "V3-5.3", errors: [] });
});

// ── One board, two readers ─────────────────────────────────────────────────
//
// F4. The text-equality test above locks the RECOGNIZER; it cannot see the cell
// extraction that feeds it, and that is where the two implementations diverged.
// `.trim()` strips U+00A0 and U+FEFF where POSIX `[[:space:]]` does not, so a
// board the parser refused outright was reported healthy here and an id handed
// out; `[ \t]` at line start where awk has `[[:space:]]` hid a row the parser
// counted, which is the direction that hands out an id the board already holds.
// So the claim is locked by behaviour: identical bytes to both readers, verdicts
// diffed.
const NBSP = "\u00a0";
const BOM = "\ufeff";

function boardWith(...rows: string[]): string {
  return ["| id | row | state |", "|---|---|---|", "| V3-5.1 | the first row | **open** |", ...rows, ""].join("\n");
}

/** `--count-open` on the identical bytes: exit 2 is the parser refusing the board. */
function nudge(board: string): { exit: number; open: number } {
  const dir = mkdtempSync(join(tmpdir(), "nudge-"));
  try {
    const file = join(dir, "workboard.md");
    writeFileSync(file, board);
    const run = Bun.spawnSync(["bash", join(import.meta.dir, "..", FLEET_NUDGE_FILE), "--count-open", file]);
    return { exit: run.exitCode ?? -1, open: Number(run.stdout.toString().trim() || "-1") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The same board through this tool: refused, or the ids it saw. */
function tool(board: string): { refused: boolean; ids: number } {
  return withFixture({ workboard: board }, (repo) => {
    const errors: string[] = [];
    const taken = collectWorkboard(repo, errors);
    return { refused: errors.length > 0, ids: taken.size };
  });
}

test.each([
  ["a clean board", boardWith("| V3-5.2 | a second row | **open** |")],
  ["NBSP after the id", boardWith(`| V3-5.2${NBSP} | a second row | **open** |`)],
  ["NBSP before the id", boardWith(`| ${NBSP}V3-5.2 | a second row | **open** |`)],
  ["BOM before the id", boardWith(`| ${BOM}V3-5.2 | a second row | **open** |`)],
  ["a vertical tab leading the row", boardWith("\v| V3-5.2 | a second row | **open** |")],
  ["a form feed leading the row", boardWith("\f| V3-5.2 | a second row | **open** |")],
  ["a carriage return leading the row", boardWith("\r| V3-5.2 | a second row | **open** |")],
  ["a space leading the row", boardWith("  | V3-5.2 | a second row | **open** |")],
  ["a tab leading the row", boardWith("\t| V3-5.2 | a second row | **open** |")],
  ["a duplicate id", boardWith("| V3-5.1 | the same id again | **open** |")],
  ["a bolded id cell", boardWith("| **V3-5.2** | a second row | **open** |")],
  ["a stray pipe in prose closing the table", boardWith("prose with a | pipe", "| V3-5.2 | not a row | **open** |")],
  ["an id-shaped row above the header", ["| V3-5.9 | before any header | **open** |", boardWith()].join("\n")],
])("one board, two readers: %s", (_name, board) => {
  const parser = nudge(board);
  const allocator = tool(board);
  expect(allocator.refused, `parser exit=${parser.exit}, tool refused=${allocator.refused}`).toBe(parser.exit === 2);
  // Every row above is `**open**`, so the parser's open count is its row count:
  // a row one reader counts and the other cannot see is the collision shape.
  if (!allocator.refused) expect(allocator.ids).toBe(parser.open);
});

// ── One board, two readers: the characters no fixed set settles ────────────
//
// F4, round 2. The cases above are ASCII, where awk's `[[:space:]]` is the same
// set in every locale and the two readers must agree. These are the characters
// where it is not: awk's class is `iswspace()` under the process locale, so
// U+1680 and its neighbours are space to gawk under `C.UTF-8`/`en_US.UTF-8` and
// are not under `C`. Every character here is built from its CODE POINT rather
// than typed, so the character under test is the one named and no editor,
// terminal or copy-paste can quietly substitute another.
//
// The assertion is deliberately NOT "agrees with the parser", because agreement
// is not safety. Replayed at `db4bd6a`, U+0085/U+00A0/U+2007/U+202F/U+FEFF made
// both readers count one row — perfect agreement — while the tool handed back
// `V3-5.2`, which is written on the board. So what is locked is that THIS TOOL
// REFUSES, which holds in whatever locale the suite runs under.
const AMBIGUOUS = [
  ["U+0085 next line", 0x0085],
  ["U+00A0 no-break space", 0x00a0],
  ["U+1680 ogham space mark", 0x1680],
  ["U+2000 en quad", 0x2000],
  ["U+2003 em space", 0x2003],
  ["U+2007 figure space", 0x2007],
  ["U+2028 line separator", 0x2028],
  ["U+2029 paragraph separator", 0x2029],
  ["U+202F narrow no-break space", 0x202f],
  ["U+205F medium mathematical space", 0x205f],
  ["U+3000 ideographic space", 0x3000],
  ["U+FEFF byte order mark", 0xfeff],
] as const;

test.each(AMBIGUOUS)("a row led by %s is refused by name, never made invisible", (name, codePoint) => {
  const board = boardWith(`${String.fromCodePoint(codePoint)}| V3-5.2 | a second row | **open** |`);
  const { id, errors } = nextId({ workboard: board });
  // No allocation at all: at db4bd6a every one of these answered V3-5.2, an id
  // the board in front of it holds.
  expect(id, `allocated ${id} while the board holds V3-5.2`).toBeUndefined();
  expect(errors.join("\n")).toContain(`instance/workboard.md:4: a table row reached across ${name.split(" ")[0]}`);
});

// The amplification: the line is not merely lost, it CLOSES THE TABLE, so every
// row below it is lost with it. This is what makes an unclassifiable line worth
// refusing rather than skipping — one stray character, three reissued ids.
test("a row led by an unclassifiable character does not hide every row below it", () => {
  const board = [
    "| id | row | state |",
    "|---|---|---|",
    "| V3-5.1 | the first row | **open** |",
    "| V3-5.2 | the second row | **open** |",
    `${String.fromCodePoint(0x2003)}| V3-5.3 | the third row | **open** |`,
    "| V3-5.4 | the fourth row | **open** |",
    "| V3-5.5 | the fifth row | **open** |",
    "",
  ].join("\n");

  const { id, errors } = nextId({ workboard: board });
  // At db4bd6a this allocated V3-5.3 — the board holds V3-5.3, V3-5.4 and
  // V3-5.5, and the tool could see none of them.
  expect(id, `allocated ${id} while the board holds V3-5.3, V3-5.4 and V3-5.5`).toBeUndefined();
  expect(errors.join("\n")).toContain("instance/workboard.md:5: a table row reached across U+2003");

  // And the rows below it are seen again once the character is gone, so the
  // refusal is about that one line and not about the board.
  const repaired = board.replace(String.fromCodePoint(0x2003), "");
  expect(nextId({ workboard: repaired })).toEqual({ id: "V3-5.6", errors: [] });
});

// The refusal is bounded to a leading run of SPACE. Prose before the pipe still
// merely closes the table, exactly as it does for awk in every locale — a board
// full of prose that happens to contain a pipe must not become unallocatable.
test("prose before a pipe still closes the table rather than refusing the board", () => {
  const board = boardWith(
    `${String.fromCodePoint(0x2003)}prose with a | pipe`,
    "| V3-5.2 | below a closed table | **open** |",
  );
  expect(nextId({ workboard: board })).toEqual({ id: "V3-5.2", errors: [] });
});

// ── The command surface ────────────────────────────────────────────────────

test("the command prints the id alone on stdout and refuses a missing prefix", () => {
  withFixture({}, (repo) => {
    const tool = join(import.meta.dir, "next-row-id.ts");

    const allocated = Bun.spawnSync([process.execPath, tool, "--repo", repo, "--prefix", "V3-5."]);
    expect(allocated.exitCode, allocated.stderr.toString()).toBe(0);
    expect(allocated.stdout.toString()).toBe("V3-5.2\n");
    expect(allocated.stderr.toString()).toContain("highest=V3-5.1 highest_from=workboard");

    const noPrefix = Bun.spawnSync([process.execPath, tool, "--repo", repo]);
    expect(noPrefix.exitCode).toBe(2);
    expect(noPrefix.stdout.toString()).toBe("");
    expect(noPrefix.stderr.toString()).toContain("--prefix is required");

    rmSync(join(repo, "instance", "workboard.md"));
    const broken = Bun.spawnSync([process.execPath, tool, "--repo", repo, "--prefix", "V3-5."]);
    expect(broken.exitCode).toBe(1);
    expect(broken.stdout.toString()).toBe("");
    expect(broken.stderr.toString()).toContain("NEXT-ID instance/workboard.md: absent");
  });
});

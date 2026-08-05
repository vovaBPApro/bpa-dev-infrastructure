import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ID_SHAPE, FLEET_NUDGE_FILE, allocate, collectTaken } from "./next-row-id";

// A minimal repository carrying only the declared sources. Every default is
// valid and nearly empty, so each case below adds exactly one thing and the
// answer it produces is attributable to that one thing.
function fixture(options: {
  workboard?: string;
  reviewItems?: string;
  hrStateExemptions?: string;
  docPathExemptions?: string;
  parked?: string[];
  decisions?: { name: string; body: string }[];
  omit?: ("workboard" | "review-items" | "hr-state-exemptions" | "doc-path-exemptions" | "parked" | "decisions")[];
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
  for (const row of options.decisions ?? []) writeFileSync(join(repo, "instance", "decisions", row.name), row.body);
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

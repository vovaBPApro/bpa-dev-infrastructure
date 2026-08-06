import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModelPin, citedRulings, declaredModels, readBlock, shellPin, supersededRulings } from "./check-model-pin";

// A minimal repository carrying only what the check reads. Defaults reproduce
// the CURRENT, correct state — the whole HR-709 → HR-2315 → HR-2613 chain and a
// params block that follows it — so every case below changes exactly one thing
// and the failure it produces is attributable to that one thing.
function fixture(options: {
  orchestrator?: string;
  rulings?: { id: string; body: string }[];
  launch?: string;
  registry?: string;
}): string {
  const repo = mkdtempSync(join(tmpdir(), "model-pin-"));
  mkdirSync(join(repo, "instance", "decisions"), { recursive: true });
  mkdirSync(join(repo, "orchestrator"), { recursive: true });
  mkdirSync(join(repo, "daemon"), { recursive: true });
  writeFileSync(
    join(repo, "instance", "params.yaml"),
    `operator:\n  name: Vova\n\norchestrator:\n${options.orchestrator ?? DEFAULT_ORCHESTRATOR}\n\ncapture:\n  mode: manual\n`,
  );
  for (const ruling of options.rulings ?? DEFAULT_RULINGS) {
    writeFileSync(join(repo, "instance", "decisions", `${ruling.id}.md`), ruling.body);
  }
  writeFileSync(join(repo, "orchestrator", "launch.sh"), options.launch ?? DEFAULT_LAUNCH);
  writeFileSync(join(repo, "daemon", "model-registry.ts"), options.registry ?? DEFAULT_REGISTRY);
  return repo;
}

// `top_model` lands on line 6 of that file: operator block, blank, `orchestrator:`,
// `session:`, then the key. Every error below names it, so the line is asserted.
const KEY = "instance/params.yaml:6 orchestrator.top_model";

const DEFAULT_ORCHESTRATOR = [
  "  session: bpa-orchestrator",
  "  top_model: claude-fable-5        # HUMAN RULING: instance/decisions/HR-2613.md (Vova, 2026-08-05),",
  "  # which supersedes HR-2315's Opus pin and restores the HR-709 choice.",
  "  top_model_source: runtime.env",
  "  top_model_status: pinned",
].join("\n");

const HR_709 = [
  "# HR-709 — Resting model is Fable",
  "",
  "date: 2026-08-01",
  "status: binding",
  "supersedes: HR-269 (item 1), HR-271 (items 1-2) — resting-tier posture only.",
  "",
  "## Ruling",
  "",
  "1. **Resting top-orchestrator model is `claude-fable-5`.** Not Sonnet, not Opus,",
  "   not Codex.",
  "",
].join("\n");

const HR_2315 = [
  "# HR-2315 — Pin Opus as the resting top-orchestrator model",
  "",
  "date: 2026-08-04",
  "status: binding",
  "supersedes: HR-709 item 1 (resting model Fable) — resting-tier choice only.",
  "",
  "## Ruling",
  "",
  "1. **Resting top-orchestrator model is `claude-opus-5`.** Supersedes the",
  "   HR-709 resting choice (`claude-fable-5`). Do not restore Fable (or any other",
  "   value) without a newer HR row.",
  "",
].join("\n");

const HR_2613 = [
  "---",
  "id: hr-2613",
  "status: binding",
  "supersedes: HR-2315 item 1 (resting model Opus) — resting-tier choice only",
  "---",
  "",
  "# HR-2613",
  "",
  "**Resting top-orchestrator model is `claude-fable-5`.** This supersedes HR-2315 item 1.",
  "",
].join("\n");

// The records the params citation run names, so the default fixture resolves
// every one of them and no case below inherits a citation error it did not ask for.
const CHAIN = [
  { id: "HR-269", body: "status: superseded\n" },
  { id: "HR-271", body: "status: superseded\n" },
  { id: "HR-709", body: HR_709 },
  { id: "HR-2315", body: HR_2315 },
];
const DEFAULT_RULINGS = [...CHAIN, { id: "HR-2613", body: HR_2613 }];

/** The default ledger with one record replaced or added — one variable per case. */
function withRuling(id: string, body: string): { id: string; body: string }[] {
  return [...DEFAULT_RULINGS.filter((ruling) => ruling.id !== id), { id, body }];
}

const DEFAULT_LAUNCH = 'CLAUDE_MODEL="${ORCH_CLAUDE_MODEL:-${MODEL:-claude-fable-5}}"\n';
const DEFAULT_REGISTRY = "export const MODEL_CATALOG = [{ model: 'claude-fable-5' }, { model: 'claude-opus-5' }];\n";

function errorsFor(options: Parameters<typeof fixture>[0]): string[] {
  const repo = fixture(options);
  try {
    return checkModelPin(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── The current tree ────────────────────────────────────────────────────────

test("the repository's own model pin agrees with the ruling it cites", () => {
  const repo = join(import.meta.dir, "..");
  expect(checkModelPin(repo)).toEqual([]);
  const executed = Bun.spawnSync([process.execPath, "tools/check-model-pin.ts", "--repo", repo], { cwd: repo });
  expect(executed.exitCode, executed.stderr.toString()).toBe(0);
  expect(executed.stdout.toString()).toContain("MODEL-PIN clean top_model=claude-fable-5");
  // The live ruling, not a superseded one: HR-709 pinned Fable, HR-2315 pinned
  // Opus over it, HR-2613 restored Fable. Only the last one is in force.
  expect(executed.stdout.toString()).toContain("pinned_by=HR-2613");
});

test("the reconstructed default ledger is green — the baseline every case below moves off", () => {
  expect(errorsFor({})).toEqual([]);
});

// ── The 2026-08-04/05 drift, reconstructed ──────────────────────────────────
// This is the state the repository was actually in for a day: HR-2315 binding
// and pinning Opus, HR-709 superseded by it, and params.yaml still reading
// claude-fable-5 while citing HR-709 — the ruling HR-2315 had just replaced.
// HR-2613 does not exist yet, because it had not been written.

const DRIFTED_PARAMS = [
  "  session: bpa-orchestrator",
  "  top_model: claude-fable-5        # HUMAN RULING: instance/decisions/HR-709.md (Vova, 2026-08-01),",
  "  # SUPERSEDES HR-269 item 1 and HR-271's \"Claude reserved entirely\" framing.",
  "  top_model_source: runtime.env",
  "  top_model_status: pinned",
].join("\n");

const DRIFT_LAUNCH = 'CLAUDE_MODEL="${ORCH_CLAUDE_MODEL:-${MODEL:-claude-opus-5}}"\n';

test("the 2026-08-04 drift is red: the value follows a ruling that was superseded", () => {
  const errors = errorsFor({ orchestrator: DRIFTED_PARAMS, rulings: CHAIN, launch: DRIFT_LAUNCH });
  expect(errors).toContain(
    `${KEY}: claude-fable-5 contradicts instance/decisions/HR-2315.md, which pins claude-opus-5`,
  );
  expect(errors).toContain(
    `${KEY}: cites HR-709 as the ruling it follows, but the live pin is HR-2315 ` +
      "(instance/decisions/HR-2315.md) — this is the 2026-08-04 drift, where the line still named the superseded ruling",
  );
});

test("the same ledger with the value and citation corrected is green", () => {
  const errors = errorsFor({
    orchestrator: [
      "  session: bpa-orchestrator",
      "  top_model: claude-opus-5         # HUMAN RULING: instance/decisions/HR-2315.md (Vova, 2026-08-04)",
      "  top_model_source: runtime.env",
    ].join("\n"),
    rulings: CHAIN,
    launch: DRIFT_LAUNCH,
  });
  expect(errors).toEqual([]);
});

// ── Both directions ─────────────────────────────────────────────────────────
// Requirement 4 of the row: mutate params, and mutate the ruling. A check that
// only catches one side passes the moment the drift arrives from the other.

test("a params value the live ruling does not pin is named against that ruling", () => {
  const errors = errorsFor({ orchestrator: DEFAULT_ORCHESTRATOR.replace("top_model: claude-fable-5", "top_model: claude-opus-5") });
  expect(errors).toContain(
    `${KEY}: claude-opus-5 contradicts instance/decisions/HR-2613.md, which pins claude-fable-5`,
  );
});

test("a params citation naming the wrong ruling is red even when the value is right", () => {
  const errors = errorsFor({ orchestrator: DEFAULT_ORCHESTRATOR.replace("HR-2613.md", "HR-709.md") });
  expect(errors).toContain(
    `${KEY}: cites HR-709 as the ruling it follows, but the live pin is HR-2613 ` +
      "(instance/decisions/HR-2613.md) — this is the 2026-08-04 drift, where the line still named the superseded ruling",
  );
  // The value itself is untouched and must not be reported as wrong.
  expect(errors.some((error) => error.includes("contradicts"))).toBe(false);
});

test("a newer ruling moving the pin turns the unchanged params value red", () => {
  const errors = errorsFor({
    rulings: withRuling("HR-9001", [
      "---", "id: hr-9001", "status: binding",
      "supersedes: HR-2613 item 1 (resting model Fable)", "---", "",
      "**Resting top-orchestrator model is `claude-sonnet-5`.** Cheaper resting tier.", "",
    ].join("\n")),
    registry: "export const MODEL_CATALOG = [{ model: 'claude-fable-5' }, { model: 'claude-sonnet-5' }];\n",
  });
  expect(errors).toContain(
    `${KEY}: claude-fable-5 contradicts instance/decisions/HR-9001.md, which pins claude-sonnet-5`,
  );
  expect(errors.some((error) => error.includes("cites HR-2613 as the ruling it follows, but the live pin is HR-9001"))).toBe(true);
});

// ── Fail-closed ─────────────────────────────────────────────────────────────

test("two rulings each claiming to be newest is an error, not a choice", () => {
  const errors = errorsFor({
    rulings: withRuling("HR-9001", ["---", "id: hr-9001", "status: binding", "---", "",
      "**Resting top-orchestrator model is `claude-opus-5`.**", ""].join("\n")),
  });
  expect(errors.some((error) =>
    error.includes("2 rulings each claim to be the newest resting-model pin") &&
    error.includes("instance/decisions/HR-2613.md pins claude-fable-5") &&
    error.includes("instance/decisions/HR-9001.md pins claude-opus-5"))).toBe(true);
});

test("a pin whose supersedes names a missing file is refused", () => {
  const errors = errorsFor({ rulings: DEFAULT_RULINGS.filter((ruling) => ruling.id !== "HR-2315") });
  expect(errors).toContain(
    "instance/decisions/HR-2613.md: supersedes HR-2315, which does not exist — the chain this pin claims to continue is broken",
  );
});

test("an unterminated frontmatter fence names the file rather than reading it as pinning nothing", () => {
  const errors = errorsFor({
    rulings: withRuling("HR-9001", "---\nid: hr-9001\nstatus: binding\ntop_model: claude-opus-5\n"),
  });
  expect(errors).toContain(
    "instance/decisions/HR-9001.md: frontmatter opens with `---` and is never closed — every field under it is unreadable",
  );
});

test("a ruling that contradicts itself pins nothing", () => {
  const errors = errorsFor({
    rulings: withRuling("HR-2613", HR_2613.replace("---\n\n# HR-2613", "top_model: claude-opus-5\n---\n\n# HR-2613")),
  });
  expect(errors.some((error) =>
    error.includes("instance/decisions/HR-2613.md: declares more than one resting model"))).toBe(true);
});

test("a pin declared outside a binding record does not license the parameter", () => {
  const errors = errorsFor({ rulings: withRuling("HR-2613", HR_2613.replace("status: binding", "status: parked")) });
  expect(errors).toContain(
    "instance/decisions/HR-2613.md: pins claude-fable-5 without `status: binding` — a pin nobody is bound by is not a pin",
  );
});

test("a model no ruling pins fails as loudly as a wrong one", () => {
  const errors = errorsFor({
    rulings: [
      { id: "HR-269", body: "status: superseded\n" },
      { id: "HR-271", body: "status: superseded\n" },
      { id: "HR-709", body: "status: superseded\n" },
      { id: "HR-2315", body: "status: superseded\n" },
      { id: "HR-2613", body: "---\nid: hr-2613\nstatus: binding\n---\n\n# HR-2613\n" },
    ],
  });
  expect(errors).toContain(
    "instance/decisions/: no decision record pins a resting top-orchestrator model — " +
      "instance/params.yaml states one that no ruling backs",
  );
});

test("superseding every pin leaves no model in force at all", () => {
  const errors = errorsFor({
    rulings: [
      ...CHAIN.filter((ruling) => ruling.id !== "HR-709" && ruling.id !== "HR-2315"),
      { id: "HR-709", body: "status: superseded\n" },
      { id: "HR-2315", body: "status: superseded\n" },
      { id: "HR-2613", body: HR_2613.replace("supersedes: HR-2315 item 1 (resting model Opus) — resting-tier choice only", "supersedes: HR-9001") },
      {
        id: "HR-9001",
        body: ["---", "id: hr-9001", "status: binding", "supersedes: HR-2613", "---", "",
          "**Resting top-orchestrator model is `claude-fable-5`.**", ""].join("\n"),
      },
    ],
  });
  expect(errors.some((error) => error.includes("the chain forwards to nothing, so no pin is in force"))).toBe(true);
});

// The HR-2456 shape, transposed: the operator moves the pin in prose, the ruling
// names what it supersedes, and it declares no model. Without this the checker
// reports clean with the ruling that replaced the pin sitting beside it.
test("a binding ruling that supersedes a pin without pinning a model is flagged", () => {
  const errors = errorsFor({
    rulings: withRuling("HR-9001", ["---", "id: hr-9001", "status: binding",
      "supersedes: HR-2613 — back to opus, he says", "---", "", "He wants Opus again.", ""].join("\n")),
  });
  expect(errors).toContain(
    "instance/decisions/HR-9001.md: supersedes HR-2613, which pin the resting model, but pins none itself — " +
      "state the model it leaves in force, or a ruling that moves the pin is invisible to this check",
  );
});

test("a value with no ruling cited beside it cannot be checked and is refused", () => {
  const errors = errorsFor({
    orchestrator: ["  session: bpa-orchestrator", "  top_model: claude-fable-5", "  top_model_source: runtime.env"].join("\n"),
  });
  expect(errors).toContain(
    `${KEY}: states a model with no HUMAN RULING cited — a pin with no ruling beside it cannot be checked against one`,
  );
});

test("a citation naming a record that was never written is refused", () => {
  const errors = errorsFor({ orchestrator: DEFAULT_ORCHESTRATOR.replace("HR-2613.md", "HR-275.md") });
  expect(errors).toContain(`${KEY}: cites instance/decisions/HR-275.md, which does not exist`);
});

test("a missing top_model is a failure, never a skip", () => {
  const errors = errorsFor({ orchestrator: ["  session: bpa-orchestrator", "  top_posture: thin"].join("\n") });
  expect(errors.some((error) => error.includes("orchestrator.top_model: missing or not a model id"))).toBe(true);
});

// ── The consumers ───────────────────────────────────────────────────────────
// This is the drift the check found on the live tree: launch.sh still carried
// HR-2315's Opus after HR-2613 restored Fable, so the repository alone — the
// meteorite test — rebuilt the host onto the superseded pin.

test("the launcher's own pin cannot drift away from the parameter file", () => {
  const errors = errorsFor({ launch: DRIFT_LAUNCH });
  expect(errors).toContain(
    `orchestrator/launch.sh: CLAUDE_MODEL falls back to claude-opus-5, but ${KEY} is claude-fable-5 — ` +
      "a fresh clone with no runtime.env would start on the wrong model",
  );
});

test("a launcher with no pin at all is refused — the account default is not a decision", () => {
  const errors = errorsFor({ launch: 'CLAUDE_MODEL="${ORCH_CLAUDE_MODEL:-}"\n' });
  expect(errors.some((error) => error.includes("no CLAUDE_MODEL pin default found"))).toBe(true);
});

test("a pin outside the closed catalog is refused", () => {
  const errors = errorsFor({ registry: "export const MODEL_CATALOG = [{ model: 'claude-opus-5' }];\n" });
  expect(errors.some((error) => error.includes("the catalog does not contain claude-fable-5"))).toBe(true);
});

// ── Parsing ─────────────────────────────────────────────────────────────────

test("the pin sentence is read across the line wrap the ledger writes it with", () => {
  expect(declaredModels("1. **Resting top-orchestrator model is\n   `claude-fable-5`.** Not Sonnet.\n")).toEqual(["claude-fable-5"]);
  expect(declaredModels("top_model: claude-opus-5\n")).toEqual(["claude-opus-5"]);
  expect(declaredModels("He considered `claude-opus-5` and said no.\n")).toEqual([]);
});

test("prose beginning with Supersedes is not a supersession edge", () => {
  expect(supersededRulings("status: binding\n\nSupersedes the pin named by [[HR-709]].\n")).toEqual([]);
  expect(supersededRulings("supersedes: HR-709 item 1\n  and HR-271 as well\n")).toEqual(["HR-709", "HR-271"]);
});

test("the block reader stops at the next top-level key and the citation run at the next value", () => {
  const yaml = "orchestrator:\n  top_model: claude-fable-5   # HR-2613\n  # and HR-2315 before it\n  top_posture: thin  # HR-99\n\ncapture:\n  top_model: nonsense\n";
  expect(readBlock(yaml, "orchestrator").get("top_model")).toEqual({ value: "claude-fable-5", line: 2 });
  expect(citedRulings(yaml, 2)).toEqual(["HR-2613", "HR-2315"]);
  expect(shellPin('CLAUDE_MODEL="${ORCH_CLAUDE_MODEL:-${MODEL:-claude-fable-5}}"', "CLAUDE_MODEL")).toBe("claude-fable-5");
});

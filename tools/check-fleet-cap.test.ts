import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFleetCap, fleetBlockText, readFleetBlock, shellDefault } from "./check-fleet-cap";

// A minimal repository carrying only what the check reads. Defaults are the
// current, correct values, so every case below changes exactly one thing and
// the failure it produces is attributable to that one thing.
function fixture(options: {
  fleet?: string;
  rulings?: { id: string; body: string }[];
  nudge?: string;
  keepalive?: string;
  launcher?: string;
}): string {
  const repo = mkdtempSync(join(tmpdir(), "fleet-cap-"));
  mkdirSync(join(repo, "instance", "decisions"), { recursive: true });
  mkdirSync(join(repo, "orchestrator", "fleet"), { recursive: true });
  mkdirSync(join(repo, "daemon"), { recursive: true });
  writeFileSync(
    join(repo, "instance", "params.yaml"),
    `operator:\n  name: Vova\n\nfleet:\n${options.fleet ?? DEFAULT_FLEET}\n\norchestrator:\n  session: bpa-orchestrator\n`,
  );
  for (const ruling of options.rulings ?? [{ id: "HR-2342", body: "status: binding\nlane_cap: 3\n" }]) {
    writeFileSync(join(repo, "instance", "decisions", `${ruling.id}.md`), `# ${ruling.id}\n\ndate: 2026-08-04\n${ruling.body}`);
  }
  writeFileSync(join(repo, "orchestrator", "fleet", "fleet-nudge.sh"), options.nudge ?? DEFAULTS.nudge);
  writeFileSync(join(repo, "daemon", "autonomy-keepalive.ts"), options.keepalive ?? DEFAULTS.keepalive);
  writeFileSync(join(repo, "orchestrator", "fleet", "launch-lane.sh"), options.launcher ?? DEFAULTS.launcher);
  return repo;
}

// The consuming files as they should look: the cap read rather than defaulted,
// every knob named, and the launcher reading, counting and offering the
// declared exception. Each test below replaces exactly one of them.
const DEFAULTS = {
  nudge:
    'CRITICAL=$(int_or "${FLEET_NUDGE_CRITICAL:-1}" 1)\nTARGET=$(int_or "${FLEET_NUDGE_TARGET:-0}" 0)\n' +
    'CAP=$(int_or "${FLEET_NUDGE_CAP:-$(fleet_cap "$REPO")}" \'\')',
  keepalive:
    "const cap = fleet.match(/cap:/); fleet.match(/declared_by:/); knob(fleet, 'wake_below', 1); knob(fleet, 'target', 0);",
  launcher: 'cap=$(fleet_cap "$repo")\nrunning=$(fleet_running_lanes)\ncase "$1" in --allow-over-cap) ;; esac',
} as const;

const DEFAULT_FLEET = [
  "  cap: 3",
  "  declared_by: HR-2342",
  "  wake_below: 1",
  "  notify_human_below: 1",
  "  status: active",
].join("\n");

function errorsFor(options: Parameters<typeof fixture>[0]): string[] {
  const repo = fixture(options);
  try {
    return checkFleetCap(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test("the repository's own fleet block agrees with the ruling it cites", () => {
  const repo = join(import.meta.dir, "..");
  expect(checkFleetCap(repo)).toEqual([]);
  const executed = Bun.spawnSync([process.execPath, "tools/check-fleet-cap.ts", "--repo", repo], { cwd: repo });
  expect(executed.exitCode, executed.stderr.toString()).toBe(0);
  expect(executed.stdout.toString()).toContain("FLEET-CAP clean cap=3");
  // The live ruling, not a superseded one — HR-2342/HR-2398 declare three and
  // HR-2456 declares five, both now forwarded to HR-2538 (three, five by exception).
  expect(executed.stdout.toString()).toContain("declared_by=HR-2538");
});

// The regression lock for workboard V3-2.15 / audit F1. This is the exact block
// that sat in instance/params.yaml for four days after HR-2342 capped the fleet
// at three, feeding `floor: 10` to a live daemon and to every session start.
test("the historical floor 10 / ceiling 15 block is rejected", () => {
  const errors = errorsFor({
    fleet: [
      "  floor: 10                        # HIS TARGET (2026-07-31)",
      "  ceiling: 15                      # upper bound",
      "  notify_human_below: 3",
      "  status: active",
    ].join("\n"),
  });
  expect(errors).toContain(
    "instance/params.yaml:5 fleet.floor: retired by instance/decisions/HR-2342.md — a floor is not a cap — HR-2342 permits every count from 1 to `cap`",
  );
  expect(errors.some((error) => error.includes("fleet.ceiling: retired"))).toBe(true);
  expect(errors.some((error) => error.includes("fleet.cap: missing"))).toBe(true);
});

test("a cap that disagrees with a binding ruling is named against that ruling", () => {
  const errors = errorsFor({ fleet: DEFAULT_FLEET.replace("cap: 3", "cap: 5") });
  expect(errors).toContain(
    "instance/params.yaml:5 fleet.cap: 5 contradicts instance/decisions/HR-2342.md, which declares lane_cap: 3",
  );
});

// Requirement 2 of V3-2.15-r2: the check must fail in BOTH directions. A check
// that only catches a params value below the ruling would have passed the raise
// to five silently the moment someone typed a larger number.
test("the cap is refused whether it sits above or below the ruling", () => {
  const rulings = [{ id: "HR-2456", body: "status: binding\nlane_cap: 5\n" }];
  const below = errorsFor({ fleet: DEFAULT_FLEET.replace("cap: 3", "cap: 4"), rulings });
  expect(below).toContain(
    "instance/params.yaml:5 fleet.cap: 4 contradicts instance/decisions/HR-2456.md, which declares lane_cap: 5",
  );
  const above = errorsFor({ fleet: DEFAULT_FLEET.replace("cap: 3", "cap: 6"), rulings });
  expect(above).toContain(
    "instance/params.yaml:5 fleet.cap: 6 contradicts instance/decisions/HR-2456.md, which declares lane_cap: 5",
  );
});

// ── Supersession ───────────────────────────────────────────────────────────
// HR-2456 raised the cap to five without deleting HR-2342's three, so two
// binding records now declare different numbers. "Every binding record must
// agree" is unsatisfiable in that state; the superseded number is history and
// forwards to the ruling that replaced it.
const SUPERSEDED_PAIR = [
  { id: "HR-2342", body: "status: binding\nlane_cap: 3\nlane_cap_superseded_by: HR-2456\n" },
  { id: "HR-2456", body: "status: binding\nlane_cap: 5\n" },
];

test("a superseded lane_cap is history and does not contradict the live one", () => {
  const errors = errorsFor({
    fleet: DEFAULT_FLEET.replace("cap: 3", "cap: 5").replace("declared_by: HR-2342", "declared_by: HR-2456"),
    rulings: SUPERSEDED_PAIR,
  });
  expect(errors).toEqual([]);
});

test("the live ruling still governs once an older number is superseded", () => {
  const errors = errorsFor({ fleet: DEFAULT_FLEET, rulings: SUPERSEDED_PAIR });
  expect(errors).toContain(
    "instance/params.yaml:5 fleet.cap: 3 contradicts instance/decisions/HR-2456.md, which declares lane_cap: 5",
  );
});

test("superseding every declaration leaves no live cap at all", () => {
  const errors = errorsFor({
    rulings: [
      { id: "HR-2342", body: "status: binding\nlane_cap: 3\nlane_cap_superseded_by: HR-2456\n" },
      { id: "HR-2456", body: "status: binding\n" },
    ],
  });
  expect(errors.some((error) => error.includes("no binding decision record declares a live `lane_cap:`"))).toBe(true);
});

// A pointer is how a number gets replaced, so it must not become how a number
// gets deleted: forwarding to a record that states no cap would silence a
// binding ruling with one line of frontmatter.
test("a supersession pointer that forwards to no number is refused", () => {
  const errors = errorsFor({
    rulings: [
      { id: "HR-2342", body: "status: binding\nlane_cap: 3\nlane_cap_superseded_by: HR-2456\n" },
      { id: "HR-2456", body: "status: binding\n" },
      { id: "HR-2451", body: "status: binding\nlane_cap: 3\n" },
    ],
  });
  expect(errors).toContain(
    "instance/decisions/HR-2342.md: lane_cap_superseded_by names HR-2456, which declares no lane_cap — " +
      "a pointer that forwards to no number mutes this one rather than replacing it",
  );
});

test("a supersession pointer to a record that does not exist is refused", () => {
  const errors = errorsFor({
    rulings: [
      { id: "HR-2342", body: "status: binding\nlane_cap: 3\nlane_cap_superseded_by: HR-9999\n" },
      { id: "HR-2456", body: "status: binding\nlane_cap: 3\n" },
    ],
  });
  expect(errors).toContain(
    "instance/decisions/HR-2342.md: lane_cap_superseded_by names HR-9999, which does not exist",
  );
});

// ── The HR-2456 shape (V3-2.15-r2) ─────────────────────────────────────────
// The operator raised the cap to five in prose. The ruling was binding, named
// the rulings it amended, and declared no `lane_cap:` — so this check reported
// `clean cap=3` with the ruling that replaced three in the same directory. The
// number in params.yaml was not wrong yet; what was wrong is that it could not
// become wrong. This is the fail-before for that.
test("a binding ruling that amends a cap ruling without declaring a cap is flagged", () => {
  const errors = errorsFor({
    rulings: [
      { id: "HR-2342", body: "status: binding\nlane_cap: 3\n" },
      { id: "HR-2456", body: "status: binding\namends: [[HR-2342]] (the number only — three becomes five)\n" },
    ],
  });
  expect(errors).toContain(
    "instance/decisions/HR-2456.md: amends HR-2342, which declare `lane_cap:`, but declares none itself — " +
      "state the cap it leaves in force, or a ruling that changes the cap is invisible to this check",
  );
});

test("the amendment edge is read across the continuation lines the ledger wraps", () => {
  const errors = errorsFor({
    rulings: [
      { id: "HR-2342", body: "status: binding\nlane_cap: 3\n" },
      {
        id: "HR-2456",
        body: "status: binding\namends: the cap ruling of 2026-08-04\n  namely [[HR-2342]], the number only\n",
      },
    ],
  });
  expect(errors.some((error) => error.includes("HR-2456.md: amends HR-2342"))).toBe(true);
});

test("declaring the cap it leaves in force clears the amendment check", () => {
  const errors = errorsFor({
    fleet: DEFAULT_FLEET.replace("cap: 3", "cap: 5"),
    rulings: SUPERSEDED_PAIR.map((ruling) =>
      ruling.id === "HR-2456" ? { ...ruling, body: `${ruling.body}amends: [[HR-2342]]\n` } : ruling,
    ),
  });
  expect(errors.some((error) => error.includes("but declares none itself"))).toBe(false);
});

// Prose is not frontmatter. HR-2342's body opens a paragraph with "Supersedes
// the hardcoded fleet floor for operational purposes", and reading that as an
// amendment edge would flag rulings that amend nothing.
test("a sentence beginning with Supersedes is not an amendment edge", () => {
  const errors = errorsFor({
    rulings: [
      { id: "HR-2342", body: "status: binding\nlane_cap: 3\n" },
      { id: "HR-2456", body: "status: binding\n\nSupersedes the hardcoded fleet floor named by [[HR-2342]].\n" },
    ],
  });
  expect(errors.some((error) => error.includes("HR-2456.md: amends"))).toBe(false);
});

test("a cap no ruling declares fails as loudly as a wrong one", () => {
  const errors = errorsFor({ rulings: [{ id: "HR-2342", body: "status: binding\n" }] });
  expect(errors.some((error) => error.includes("no binding decision record declares a live `lane_cap:`"))).toBe(true);
});

test("a lane_cap declared outside a binding record does not license the parameter", () => {
  const errors = errorsFor({ rulings: [{ id: "HR-2342", body: "status: superseded\nlane_cap: 3\n" }] });
  expect(errors).toContain(
    "instance/decisions/HR-2342.md: declares lane_cap: 3 without `status: binding` — a cap nobody is bound by is not a cap",
  );
});

// The operator's own «менше трьох … маєш мені писати», read literally under a
// cap of three, makes ordinary operation a permanent alarm. This is the shape
// that woke him repeatedly, so it is locked by name.
test("a wake threshold above one is rejected as the ceiling installed as a floor", () => {
  const errors = errorsFor({ fleet: DEFAULT_FLEET.replace("notify_human_below: 1", "notify_human_below: 3") });
  expect(errors).toContain(
    "instance/params.yaml:8 fleet.notify_human_below: 3 treats a lane count HR-2342 permits as a fault " +
      "(read by orchestrator/watchdog.sh); only 0 running lanes is idle, so this is 1",
  );
});

test("a zero wake threshold is rejected too — it deletes the severe tier", () => {
  const errors = errorsFor({ fleet: DEFAULT_FLEET.replace("wake_below: 1", "wake_below: 0") });
  expect(errors.some((error) => error.includes("fleet.wake_below: 0 treats a lane count"))).toBe(true);
});

test("an absent wake threshold is a failure, never a skip", () => {
  const errors = errorsFor({ fleet: ["  cap: 3", "  notify_human_below: 1"].join("\n") });
  expect(errors.some((error) => error.includes("fleet.wake_below: missing or not an integer"))).toBe(true);
});

test("a non-zero target without a source is refused as another underived constant", () => {
  const errors = errorsFor({ fleet: `${DEFAULT_FLEET}\n  target: 2` });
  expect(errors.some((error) => error.includes("is an underived constant"))).toBe(true);
});

test("a target derived by a file that exists is allowed", () => {
  const repo = fixture({
    fleet: `${DEFAULT_FLEET}\n  target: 2\n  target_source: instance/params.yaml`,
    nudge: 'CRITICAL=$(int_or "${FLEET_NUDGE_CRITICAL:-1}" 1)\nTARGET=$(int_or "${FLEET_NUDGE_TARGET:-2}" 2)\nCAP=$(int_or "${FLEET_NUDGE_CAP:-$(fleet_cap "$REPO")}" \'\')\n',
  });
  try {
    expect(checkFleetCap(repo)).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a target above the cap is refused even with a source", () => {
  const errors = errorsFor({ fleet: `${DEFAULT_FLEET}\n  target: 4\n  target_source: instance/params.yaml` });
  expect(errors.some((error) => error.includes("exceeds the cap of 3"))).toBe(true);
});

// V3-5.10. The watchdog's cap default used to be a literal held EQUAL to
// params.yaml by this check. That is one edit away from drift in both files at
// once, and it is what happened: `${FLEET_NUDGE_CAP:-5}` and the ruling id
// beside it were hand-retyped together at the last cap change, correct only
// because one person remembered both. The literal is now refused outright — the
// number is read, and there is no fallback to disagree with.
test("a retyped cap default in the watchdog is refused, whatever number it carries", () => {
  for (const literal of [10, 3]) {
    const errors = errorsFor({
      nudge: `CRITICAL=$(int_or "\${FLEET_NUDGE_CRITICAL:-1}" 1)\nCAP=$(int_or "\${FLEET_NUDGE_CAP:-${literal}}" ${literal})\n`,
    });
    expect(errors).toContain(
      `orchestrator/fleet/fleet-nudge.sh: FLEET_NUDGE_CAP defaults to the literal ${literal} — ` +
        "the cap is read from instance/params.yaml, and a retyped default is the drift this check exists for",
    );
  }
});

// The drift that stayed silent, in its own shape: the ruling that declares the
// cap is superseded by one declaring the SAME number, so nothing about the cap
// itself changes — and before this check, every operator-facing message went on
// quoting the superseded id with nothing failing.
test("a superseding ruling that keeps the number still turns declared_by red", () => {
  const errors = errorsFor({
    rulings: [
      { id: "HR-2342", body: "status: binding\nlane_cap: 3\nlane_cap_superseded_by: HR-2538\n" },
      { id: "HR-2538", body: "status: binding\nlane_cap: 3\n" },
    ],
  });
  expect(errors).toContain(
    "instance/params.yaml:6 fleet.declared_by: HR-2342 is not the set of rulings declaring the live cap (HR-2538) — " +
      "the operator would be quoted a ruling that does not declare this number",
  );
  // ...and the cap itself is untouched, which is exactly why nothing caught it.
  expect(errors.some((error) => error.includes("fleet.cap: 3 contradicts"))).toBe(false);
});

test("an absent declared_by is a failure — the consumers would go back to retyping it", () => {
  const errors = errorsFor({ fleet: DEFAULT_FLEET.replace("  declared_by: HR-2342\n", "") });
  expect(errors.some((error) => error.includes("fleet.declared_by: missing"))).toBe(true);
});

// The sentence the operator actually reads. Every consumer must assemble it
// from `declared_by`; a literal id on that line is the defect, in code or in a
// comment beside it, since the comment is what said "five" against a cap of
// three while nothing failed.
test("a ruling id retyped into the cap sentence is refused in every consumer", () => {
  const sentence = 'HR-2456 caps parallel lanes at $CAP — a ceiling, not a target.';
  for (const [key, file] of [
    ["nudge", "orchestrator/fleet/fleet-nudge.sh"],
    ["keepalive", "daemon/autonomy-keepalive.ts"],
    ["launcher", "orchestrator/fleet/launch-lane.sh"],
  ] as const) {
    const base = errorsFor({});
    const errors = errorsFor({ [key]: `${DEFAULTS[key]}\nmsg="${sentence}"\n` });
    expect(base.some((error) => error.includes("caps parallel lanes"))).toBe(false);
    expect(
      errors.some(
        (error) => error.startsWith(`${file}:`) && error.includes("retypes HR-2456 into the cap sentence"),
      ),
    ).toBe(true);
  }
});

// The launcher is where the cap became a refusal. A shape assertion only —
// orchestrator/fleet/launch-lane-cap.test.sh executes the ceiling at cap+1 —
// but it names each part, so a launcher that quietly stops reading the
// parameter or drops the declared exception is a failure here as well.
test("a launcher that enforces nothing is refused, part by part", () => {
  expect(errorsFor({ launcher: 'running=$(fleet_running_lanes)\ncase "$1" in --allow-over-cap) ;; esac\n' })).toContain(
    "orchestrator/fleet/launch-lane.sh: does not call fleet_cap — the cap would be quoted elsewhere and enforced nowhere",
  );
  expect(errorsFor({ launcher: 'cap=$(fleet_cap "$repo")\ncase "$1" in --allow-over-cap) ;; esac\n' })).toContain(
    "orchestrator/fleet/launch-lane.sh: does not call fleet_running_lanes — a cap with no census cannot refuse anything",
  );
  expect(errorsFor({ launcher: 'cap=$(fleet_cap "$repo")\nrunning=$(fleet_running_lanes)\n' })).toContain(
    "orchestrator/fleet/launch-lane.sh: no --allow-over-cap path — refusal must be the default, not the only possibility",
  );
});

// The shell reader and this checker must see the same repository the same way.
// They are two implementations of one lookup, and the launcher trusts the first
// while the gate trusts the second.
test("the shell reader and this checker agree on the cap and the ruling", () => {
  const repo = join(import.meta.dir, "..");
  const read = (fn: string) =>
    Bun.spawnSync(["bash", "-c", `. orchestrator/fleet/fleet-params.sh; ${fn} "$PWD"`], { cwd: repo });
  const fleet = readFleetBlock(readFileSync(join(repo, "instance", "params.yaml"), "utf8"));
  const cap = read("fleet_cap");
  expect(cap.exitCode, cap.stderr.toString()).toBe(0);
  expect(cap.stdout.toString()).toBe(fleet.get("cap")!.value);
  const declared = read("fleet_declared_by");
  expect(declared.exitCode, declared.stderr.toString()).toBe(0);
  expect(declared.stdout.toString()).toBe(fleet.get("declared_by")!.value);
});

test("a knob the daemon stops reading is reported as inert, not as clean", () => {
  const errors = errorsFor({ keepalive: "// the parser was rewritten and forgot the fleet block\n" });
  expect(errors).toContain("daemon/autonomy-keepalive.ts: does not read fleet.cap — the parameter would be inert");
});

// The block used to cite HR-275, a record that has never existed; the comment
// itself admitted it. Comments are in scope because session-load.ts pushes them
// into the orchestrator's standing context verbatim.
test("a decision record cited only in a comment must still exist", () => {
  const errors = errorsFor({ fleet: `  # sourced from HR-275\n${DEFAULT_FLEET}` });
  expect(errors).toContain("instance/params.yaml: the fleet block cites instance/decisions/HR-275.md, which does not exist");
});

test("the block reader stops at the next top-level key", () => {
  const yaml = "fleet:\n  cap: 3   # comment\n\norchestrator:\n  cap: 99\n";
  expect(readFleetBlock(yaml).get("cap")).toEqual({ value: "3", line: 2 });
  expect(fleetBlockText(yaml)).toBe("fleet:\n  cap: 3   # comment\n");
  expect(shellDefault('CAP=$(int_or "${FLEET_NUDGE_CAP:-3}" 3)', "FLEET_NUDGE_CAP")).toBe(3);
});

// ── The V3-5.10 review's reader findings, on this side of the pair ──────────

// F1/F2 here. `/^\d+$/` accepted `09` and Number() answered 9, while bash
// arithmetic on the launch path errored on the same characters and fell through
// to a LAUNCH. Two readers of one number must not disagree about whether it is a
// number at all, so both refuse it.
test("a leading-zero cap is not a number to this checker either", () => {
  for (const written of ["09", "010", "03"]) {
    const errors = errorsFor({ fleet: DEFAULT_FLEET.replace("cap: 3", `cap: ${written}`) });
    expect(errors, `cap: ${written}`).toContain(
      "instance/params.yaml:5 fleet.cap: missing or not a positive integer — the operator's cap must be stated as a number",
    );
  }
});

// F4 here. The shell reader's `#`-in-column-1 truncation stopped every dispatch;
// this reader's identical truncation would instead report `fleet.cap: missing`
// on a file that plainly states one — the gate refusing a landing over a comment
// reflow. Both halves are the same one-character bug.
test("a comment in column 1 does not end the block for this reader", () => {
  const yaml = "fleet:\n# a comment reflowed to column 1\n  cap: 3\n  declared_by: HR-2342\n\norchestrator:\n  cap: 99\n";
  expect(readFleetBlock(yaml).get("cap")).toEqual({ value: "3", line: 3 });
  expect(fleetBlockText(yaml)).toContain("# a comment reflowed to column 1");
  expect(fleetBlockText(yaml)).not.toContain("cap: 99");
  const errors = errorsFor({ fleet: "# a comment reflowed to column 1\n" + DEFAULT_FLEET });
  expect(errors.some((error) => error.includes("fleet.cap: missing"))).toBe(false);
});

// F5 here: depth, and quoted scalars.
test("only keys at the block's own indentation are the block's keys", () => {
  const nested = "fleet:\n  budget:\n    cap: 99\n  status: active\n";
  expect(readFleetBlock(nested).get("cap")).toBeUndefined();
  const both = "fleet:\n  budget:\n    cap: 99\n  cap: 3\n";
  expect(readFleetBlock(both).get("cap")).toEqual({ value: "3", line: 4 });
});

test("a quoted scalar is the same value as a bare one", () => {
  expect(readFleetBlock('fleet:\n  cap: "3"\n').get("cap")!.value).toBe("3");
  expect(readFleetBlock("fleet:\n  cap: '3'\n").get("cap")!.value).toBe("3");
  expect(readFleetBlock('fleet:\n  declared_by: "HR-2342"\n').get("declared_by")!.value).toBe("HR-2342");
  const errors = errorsFor({ fleet: DEFAULT_FLEET.replace("cap: 3", 'cap: "3"').replace("declared_by: HR-2342", 'declared_by: "HR-2342"') });
  expect(errors).toEqual([]);
});

// The pair, held against each other on the grammar itself rather than only on
// today's file. The existing agreement test above compares one repository, which
// both readers happen to parse the same way; every finding in the review's F4/F5
// was a disagreement this shape of test would have caught and that one could not.
test("the two readers accept and refuse the same grammar", () => {
  const repo = join(import.meta.dir, "..");
  const cases = [
    { label: "column-1 comment inside the block", yaml: "fleet:\n# reflowed\n  cap: 4\n  status: active\n", want: "4" },
    { label: "cap nested under a fleet subkey", yaml: "fleet:\n  budget:\n    cap: 99\n  status: active\n", want: null },
    { label: "the block's own cap past a nested one", yaml: "fleet:\n  budget:\n    cap: 99\n  cap: 4\n", want: "4" },
    { label: "double-quoted scalar", yaml: 'fleet:\n  cap: "4"\n  status: active\n', want: "4" },
    { label: "single-quoted scalar", yaml: "fleet:\n  cap: '4'\n  status: active\n", want: "4" },
    { label: "trailing comment", yaml: "fleet:\n  cap: 4   # the cap\n  status: active\n", want: "4" },
    { label: "a same-named key outside the block", yaml: "other:\n  cap: 9\n\nfleet:\n  status: active\n", want: null },
    { label: "a comment between blocks still ends it", yaml: "fleet:\n  status: active\n\n# between\nother:\n  cap: 9\n", want: null },
  ];
  for (const row of cases) {
    const dir = mkdtempSync(join(tmpdir(), "fleet-grammar-"));
    try {
      mkdirSync(join(dir, "instance"), { recursive: true });
      writeFileSync(join(dir, "instance", "params.yaml"), row.yaml);
      const shell = Bun.spawnSync(["bash", "-c", '. orchestrator/fleet/fleet-params.sh; fleet_cap "$1"', "--", dir], { cwd: repo });
      const fromShell = shell.exitCode === 0 ? shell.stdout.toString() : null;
      const fromChecker = readFleetBlock(row.yaml).get("cap")?.value ?? null;
      expect(fromShell, `${row.label}: orchestrator/fleet/fleet-params.sh`).toBe(row.want);
      expect(fromChecker, `${row.label}: tools/check-fleet-cap.ts`).toBe(row.want);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// F6. `declared_by` was already HR-2538 while the paragraph above it introduced
// HR-2456's five as the operator's cap, and session-load.ts delivers that
// paragraph to every new session verbatim. A correct field beside a superseded
// sentence is how a machine reads clean and an agent reads wrong.
test("the fleet block may not OPEN on a superseded ruling", () => {
  const rulings = [
    { id: "HR-2342", body: "status: binding\nlane_cap: 5\nlane_cap_superseded_by: HR-2538\n" },
    { id: "HR-2538", body: "status: binding\nlane_cap: 3\n" },
  ];
  const fleet = DEFAULT_FLEET.replace("declared_by: HR-2342", "declared_by: HR-2538");
  const stale = errorsFor({ rulings, fleet: "  # the operator's cap: HR-2342 — «до 5»\n" + fleet });
  expect(stale).toContain(
    "instance/params.yaml: the fleet block opens by citing HR-2342, which does not declare the live cap (HR-2538) — " +
      "session-load.ts delivers this prose to every new session as the standing ruling, so a superseded one here is read " +
      "as current; cite the live ruling first and keep the superseded one as history below it",
  );
  // The live ruling first, the superseded one kept below it as history: clean.
  const fixed = errorsFor({ rulings, fleet: "  # the operator's cap: HR-2538. It replaced HR-2342's five.\n" + fleet });
  expect(fixed).toEqual([]);
});

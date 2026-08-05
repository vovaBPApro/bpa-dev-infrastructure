import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(
    join(repo, "orchestrator", "fleet", "fleet-nudge.sh"),
    options.nudge ??
      'CRITICAL=$(int_or "${FLEET_NUDGE_CRITICAL:-1}" 1)\nTARGET=$(int_or "${FLEET_NUDGE_TARGET:-0}" 0)\nCAP=$(int_or "${FLEET_NUDGE_CAP:-3}" 3)\n',
  );
  writeFileSync(
    join(repo, "daemon", "autonomy-keepalive.ts"),
    options.keepalive ?? "const cap = fleet.match(/cap:/); knob(fleet, 'wake_below', 1); knob(fleet, 'target', 0);\n",
  );
  return repo;
}

const DEFAULT_FLEET = ["  cap: 3", "  wake_below: 1", "  notify_human_below: 1", "  status: active"].join("\n");

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
  expect(executed.stdout.toString()).toContain("FLEET-CAP clean cap=5");
  // The live ruling, not a superseded one — HR-2342/HR-2398 still declare three.
  expect(executed.stdout.toString()).toContain("declared_by=HR-2456");
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
    fleet: DEFAULT_FLEET.replace("cap: 3", "cap: 5"),
    rulings: SUPERSEDED_PAIR,
    nudge: 'CRITICAL=$(int_or "${FLEET_NUDGE_CRITICAL:-1}" 1)\nTARGET=$(int_or "${FLEET_NUDGE_TARGET:-0}" 0)\nCAP=$(int_or "${FLEET_NUDGE_CAP:-5}" 5)\n',
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
    "instance/params.yaml:7 fleet.notify_human_below: 3 treats a lane count HR-2342 permits as a fault " +
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
    nudge: 'CRITICAL=$(int_or "${FLEET_NUDGE_CRITICAL:-1}" 1)\nTARGET=$(int_or "${FLEET_NUDGE_TARGET:-2}" 2)\nCAP=$(int_or "${FLEET_NUDGE_CAP:-3}" 3)\n',
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

test("the watchdog's own default cannot drift away from the parameter file", () => {
  const errors = errorsFor({
    nudge: 'CRITICAL=$(int_or "${FLEET_NUDGE_CRITICAL:-1}" 1)\nTARGET=$(int_or "${FLEET_NUDGE_TARGET:-0}" 0)\nCAP=$(int_or "${FLEET_NUDGE_CAP:-10}" 10)\n',
  });
  expect(errors).toContain(
    "orchestrator/fleet/fleet-nudge.sh: FLEET_NUDGE_CAP defaults to 10, but instance/params.yaml:5 fleet.cap is 3 — two mechanisms, two numbers",
  );
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

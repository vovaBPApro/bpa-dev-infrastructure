import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// This test IS the executor for bootstrap/check-unit-drift.sh.
//
// On 2026-08-03 the host was found missing 8 canonical systemd units,
// including bpa-deploy-drift-guard itself -- the guard whose job was to
// detect exactly this gap was part of the gap (instance/decisions/HR-1720.md).
// check-unit-drift.sh existed on the donor line and nothing ran it. Placing
// this test here means the landing gate's declared checks run it on every
// candidate (gate/land-lib.sh globs every tracked *.test.ts), the same wiring
// tools/check-decision-ledger-drift.test.ts uses for the ledger-drift check.
// A checker nobody runs is the same defect class as the unarmed watchdog.
//
// Round-2 review (967b846) returned REJECT with three defects, fixed here:
//   1. DISQUALIFYING: a loop over *.in can only validate templates that
//      exist -- deleting bpa-orchestrator-watchdog.service.in from the tree
//      produced exit=0 with no mention of the watchdog anywhere. Fixed with
//      an independent manifest, instance/expected-units.tsv.
//   2. Referenced-path exemptions were keyed on unit name alone, so
//      appending an unrelated ExecStartPost path to an already-exempted unit
//      rode in silently under the old, unrelated evidence. Fixed by keying
//      exemptions on unit+path together.
//   3. agentic-bpa-* units hard-coded a product name into generic
//      bootstrap/units/ -- a Mission/HR-309 violation. Moved to
//      instance/units/; the manifest and both checker passes follow them.

const repoRoot = join(import.meta.dir, "..");
const script = join(repoRoot, "bootstrap", "check-unit-drift.sh");
const genericTemplateDir = join(repoRoot, "bootstrap", "units");
const instanceTemplateDir = join(repoRoot, "instance", "units");

const incidentRequiredUnits = [
  "bpa-orchestrator.service",
  "bpa-orchestrator-watchdog.service",
  "bpa-orchestrator-watchdog.timer",
  "bpa-telegram-daemon.service",
] as const;

test("the 2026-08-01 incident units are independently pinned in the manifest and template tree", () => {
  const manifest = readFileSync(join(repoRoot, "instance", "expected-units.tsv"), "utf8");
  const manifestUnits = new Set(
    manifest
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("\t", 1)[0]),
  );

  // This named list is deliberately independent of both the manifest and
  // directory enumeration. A coupled deletion from those two places must
  // still fail here.
  for (const unit of incidentRequiredUnits) {
    expect(manifestUnits.has(unit), `${unit} must remain in expected-units.tsv`).toBe(true);
    expect(existsSync(join(genericTemplateDir, `${unit}.in`)), `${unit}.in must remain in bootstrap/units`).toBe(true);
  }
});

// Read from bootstrap/unit-render-lib.sh, never restated. A literal copy of
// this map here was a FOURTH list of render variables (install.sh had four
// names, check-unit-drift.sh had six, this file had six) and it is precisely
// why the test below could not see V3-2.12: it rendered with the complete set
// while the installer shipped with a shorter one.
const renderLib = join(repoRoot, "bootstrap", "unit-render-lib.sh");
const RENDER_ENV: Record<string, string> = Object.fromEntries(
  spawnSync("bash", [renderLib, "--print-env"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

function runCheck(env: Record<string, string> = {}) {
  return spawnSync("bash", [script], {
    cwd: repoRoot,
    encoding: "utf8",
    // BUN_BIN is deliberately unset: gate/land-lib.sh exports it for its own
    // run, and this script must not depend on that caller-controlled value.
    env: { ...process.env, BUN_BIN: "", ...env },
  });
}

function renderDir(srcDir: string, destDir: string) {
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith(".in")) continue;
    const unit = entry.slice(0, -3);
    const result = spawnSync("bash", ["-c", `envsubst < "$1" > "$2"`, "_", join(srcDir, entry), join(destDir, unit)], {
      env: { ...process.env, ...RENDER_ENV },
    });
    if (result.status !== 0) {
      throw new Error(`failed to render ${entry}: ${result.stderr}`);
    }
  }
}

// Render every real tracked template (generic + instance-scoped) into a
// scratch "deployed" directory using the same envsubst variables
// bootstrap/install.sh would use, so a standalone test can assert both a
// genuinely clean deployment and a genuinely broken one without ever
// touching the real host's /etc/systemd/system or requiring a container.
function renderAllTemplates(destDir: string) {
  renderDir(genericTemplateDir, destDir);
  renderDir(instanceTemplateDir, destDir);
}

function copyTemplateTree(destDir: string, skip: string[] = []) {
  for (const [srcDir, sub] of [
    [genericTemplateDir, "units"],
    [instanceTemplateDir, "instance-units"],
  ] as const) {
    const out = join(destDir, sub);
    mkdirSync(out, { recursive: true });
    for (const entry of readdirSync(srcDir)) {
      if (!entry.endsWith(".in") || skip.includes(entry)) continue;
      writeFileSync(join(out, entry), spawnSync("cat", [join(srcDir, entry)], { encoding: "utf8" }).stdout);
    }
  }
}

test("a fully and correctly deployed fleet matches every template and exits 0", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-full-"));
  try {
    renderAllTemplates(deployedDir);
    const result = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(`${result.stdout}${result.stderr}`).not.toContain("DRIFT");
    expect(`${result.stdout}${result.stderr}`).not.toContain("MANIFEST-MISSING");
    expect(result.status).toBe(0);
    // The three units the incident named -- orchestrator, its watchdog, and
    // the telegram daemon that must be up before either -- are proven to
    // MATCH by name, not only by aggregate exit code.
    expect(result.stdout).toContain("MATCH bpa-orchestrator.service");
    expect(result.stdout).toContain("MATCH bpa-orchestrator-watchdog.service");
    expect(result.stdout).toContain("MATCH bpa-telegram-daemon.service");
    // The instance-scoped units are checked too, from their new home.
    expect(result.stdout).toContain("MATCH agentic-bpa-db-grants.service");
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
  }
});

test("BEFORE/AFTER: a missing deployed unit is reported and the checker exits non-zero", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-missing-"));
  try {
    renderAllTemplates(deployedDir);
    const before = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(before.status).toBe(0);
    // AFTER: delete exactly the unit the 2026-08-03 incident named as the
    // proximate cause -- nothing restarted the orchestrator watchdog.
    rmSync(join(deployedDir, "bpa-orchestrator-watchdog.service"));
    const after = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(after.stderr).toContain("DRIFT bpa-orchestrator-watchdog.service: deployed unit missing");
    expect(after.status).not.toBe(0);
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
  }
});

test("BEFORE/AFTER: a deployed unit that no longer matches its template is reported and exits non-zero", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-changed-"));
  try {
    renderAllTemplates(deployedDir);
    const before = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(before.status).toBe(0);
    writeFileSync(join(deployedDir, "bpa-telegram-daemon.service"), "[Unit]\nDescription=hand-edited on the host, diverged from git\n");
    const after = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(after.stderr).toContain("DRIFT bpa-telegram-daemon.service: deployed unit differs from rendered template");
    expect(after.status).not.toBe(0);
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
  }
});

test("DISQUALIFYING DEFECT (round 2, fixed): a template deleted from the tree is caught even though the directory listing alone would say nothing", () => {
  // This is the exact reproduction the reviewer ran against 967b846: delete
  // bpa-orchestrator-watchdog.service.in and .timer.in from the tree, leave
  // an otherwise fully matching deployment, and check whether the absence is
  // reported. On 967b846 this returned exit=0 with zero mention of the
  // watchdog anywhere -- a loop over *.in cannot see what used to be there.
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-vanished-template-deploy-"));
  const scratchTemplates = mkdtempSync(join(tmpdir(), "bpa-unit-drift-vanished-template-tree-"));
  try {
    renderAllTemplates(deployedDir); // fully healthy deployment, watchdog included
    copyTemplateTree(scratchTemplates, ["bpa-orchestrator-watchdog.service.in", "bpa-orchestrator-watchdog.timer.in"]);
    const result = runCheck({
      TEMPLATE_DIR: join(scratchTemplates, "units"),
      INSTANCE_TEMPLATE_DIR: join(scratchTemplates, "instance-units"),
      SYSTEMD_SYSTEM_DIR: deployedDir,
      ...RENDER_ENV,
    });
    expect(result.stderr).toContain("MANIFEST-MISSING bpa-orchestrator-watchdog.service");
    expect(result.stderr).toContain("MANIFEST-MISSING bpa-orchestrator-watchdog.timer");
    expect(result.status).not.toBe(0);
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
    rmSync(scratchTemplates, { recursive: true, force: true });
  }
});

test("BEFORE/AFTER: an absent expected-units manifest fails closed (exit 2) instead of reporting clean", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-manifest-absent-"));
  try {
    renderAllTemplates(deployedDir);
    const before = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(before.status).toBe(0);
    const after = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, MANIFEST_FILE: join(deployedDir, "no-such-manifest.tsv"), ...RENDER_ENV });
    expect(after.status).toBe(2);
    expect(after.status).not.toBe(0);
    expect(after.stderr).toContain("expected-units manifest missing");
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
  }
});

test("BEFORE/AFTER: an unreadable (directory) expected-units manifest fails closed instead of reporting no requirements", () => {
  // A directory in place of the manifest reproduces the exact defect class
  // an independent reviewer found elsewhere in this repository on
  // 2026-08-03: a check that reported clean because it could not read its
  // own input file. `-r` alone would not catch this (root can list a
  // directory), so the guard also requires `-f`.
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-manifest-dir-"));
  const manifestAsDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-manifest-is-dir-"));
  try {
    renderAllTemplates(deployedDir);
    const before = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(before.status).toBe(0);
    const after = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, MANIFEST_FILE: manifestAsDir, ...RENDER_ENV });
    expect(after.status).toBe(2);
    expect(after.stderr).toContain("expected-units manifest unreadable");
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
    rmSync(manifestAsDir, { recursive: true, force: true });
  }
});

test("an empty expected-units manifest fails closed rather than trivially passing", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-manifest-empty-"));
  try {
    renderAllTemplates(deployedDir);
    const emptyManifest = join(deployedDir, "empty-manifest.tsv");
    writeFileSync(emptyManifest, "# nothing but comments\n");
    const result = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, MANIFEST_FILE: emptyManifest, ...RENDER_ENV });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("expected-units manifest empty");
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
  }
});

test("a malformed expected-units entry (bad source) fails closed rather than being silently skipped", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-manifest-malformed-"));
  try {
    renderAllTemplates(deployedDir);
    const badManifest = join(deployedDir, "bad-manifest.tsv");
    writeFileSync(badManifest, "bpa-orchestrator.service\tsomewhere-else\n");
    const result = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, MANIFEST_FILE: badManifest, ...RENDER_ENV });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid expected-units entry");
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
  }
});

test("BEFORE/AFTER: a template referencing a path this repo does not have is caught, not silently deployed", () => {
  const badTemplates = mkdtempSync(join(tmpdir(), "bpa-unit-drift-bad-template-"));
  const emptyDeployed = mkdtempSync(join(tmpdir(), "bpa-unit-drift-bad-deploy-"));
  try {
    // BEFORE: the real, tracked templates plus their tracked exemptions
    // report no PATH-MISSING at all -- proving the check is not just always
    // failing.
    const before = runCheck({ SYSTEMD_SYSTEM_DIR: emptyDeployed, ...RENDER_ENV });
    expect(before.stderr).not.toContain("PATH-MISSING");
    // AFTER: a synthetic template shaped exactly like the donor's dangling
    // references (e.g. bpa-meteorite.service.in pointing at meteorite/run.sh,
    // which does not exist on v3) -- ExecStart names a repository file that
    // is not tracked here.
    const manifest = join(badTemplates, "manifest.tsv");
    writeFileSync(manifest, "fake-unit.service\tgeneric\n");
    writeFileSync(
      join(badTemplates, "fake-unit.service.in"),
      "[Unit]\nDescription=synthetic drift fixture\n\n[Service]\nType=oneshot\nExecStart=${INSTALL_ROOT}/definitely/not/a/real/path.sh\n",
    );
    const after = runCheck({
      TEMPLATE_DIR: badTemplates,
      INSTANCE_TEMPLATE_DIR: join(badTemplates, "empty-instance"),
      SYSTEMD_SYSTEM_DIR: emptyDeployed,
      MANIFEST_FILE: manifest,
      ...RENDER_ENV,
    });
    expect(after.stderr).toContain("PATH-MISSING fake-unit.service: /definitely/not/a/real/path.sh does not exist");
    expect(after.status).not.toBe(0);
  } finally {
    rmSync(badTemplates, { recursive: true, force: true });
    rmSync(emptyDeployed, { recursive: true, force: true });
  }
});

test("DEFECT 2 (round 2, fixed): a whole-unit exemption must not cover a NEW, unrelated dangling path added later", () => {
  // The reviewer's exact attack against 967b846: append
  // ExecStartPost=${INSTALL_ROOT}/totally/unrelated/malicious-or-typo/path.sh
  // to agentic-bpa-db-grants.service.in, already exempted (at the time) for
  // its database/ references, and watch the new path get PATH-EXEMPT for
  // free under the old, unrelated evidence.
  const templates = mkdtempSync(join(tmpdir(), "bpa-unit-drift-keyed-exempt-"));
  const emptyDeployed = mkdtempSync(join(tmpdir(), "bpa-unit-drift-keyed-deploy-"));
  try {
    const manifest = join(templates, "manifest.tsv");
    writeFileSync(manifest, "fake-unit.service\tgeneric\n");
    writeFileSync(
      join(templates, "fake-unit.service.in"),
      [
        "[Unit]",
        "Description=synthetic exemption fixture",
        "",
        "[Service]",
        "Type=oneshot",
        "ExecStart=${INSTALL_ROOT}/known/pending/path.sh",
        "ExecStartPost=${INSTALL_ROOT}/totally/unrelated/malicious-or-typo/path.sh",
        "",
      ].join("\n"),
    );
    const exemptions = join(templates, "path-exemptions.tsv");
    // Only the KNOWN, pre-existing path is exempted -- unit+path, not unit alone.
    // V3-2.16: every entry carries an owner field. `none` is a legitimate
    // owner for a synthetic fixture -- there is no row behind a path invented
    // for this test -- and the prose after it is the statement of why.
    writeFileSync(
      exemptions,
      "fake-unit.service\t/known/pending/path.sh\towner=none; a fixture path, pre-existing, deliberately not yet built\n",
    );
    const result = runCheck({
      TEMPLATE_DIR: templates,
      INSTANCE_TEMPLATE_DIR: join(templates, "empty-instance"),
      SYSTEMD_SYSTEM_DIR: emptyDeployed,
      MANIFEST_FILE: manifest,
      PATH_EXEMPTIONS_FILE: exemptions,
      ...RENDER_ENV,
    });
    expect(result.stdout).toContain(
      "PATH-EXEMPT fake-unit.service: /known/pending/path.sh not in repo (owner=none; a fixture path, pre-existing, deliberately not yet built)",
    );
    // The new, unrelated path must NOT inherit that exemption.
    expect(result.stderr).toContain("PATH-MISSING fake-unit.service: /totally/unrelated/malicious-or-typo/path.sh does not exist");
    expect(result.status).not.toBe(0);
  } finally {
    rmSync(templates, { recursive: true, force: true });
    rmSync(emptyDeployed, { recursive: true, force: true });
  }
});

// ── V3-2.16: an exemption cannot outlive the reason it was granted for ──────
//
// The ledger could name a debt but never re-test it. `bpa-meteorite.service`
// was exempted for `/meteorite/run.sh` "not yet built on v3"; V3-1.5 landed it
// at 133541c and the exemption stayed, suppressing a check that would now
// pass. Nothing in the checker could tell a live debt from a discharged one.
//
// The rule added here is the one V3-2.13 already settled for the sibling
// ledger instance/doc-path-exemptions.tsv (tools/instructions/paths.ts): a row
// whose path now EXISTS is itself a failure. Two ledgers disagreeing about one
// discipline was the defect; this is deliberately not a second design.

const trackedPathExemptions = join(repoRoot, "instance", "unit-path-exemptions.tsv");

test("BEFORE/AFTER (V3-2.16): a discharged exemption turns the checker red, and the tracked ledger is green without it", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-stale-deploy-"));
  const scratch = mkdtempSync(join(tmpdir(), "bpa-unit-drift-stale-ledger-"));
  try {
    renderAllTemplates(deployedDir);
    // AFTER (the tracked state this change produces): no row in the real
    // ledger names a path this repository now carries. Asserted against the
    // real templates and a genuinely complete deployment, so exit 0 means the
    // whole checker is clean and not merely that this one pass said nothing.
    const tracked = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(`${tracked.stdout}${tracked.stderr}`).not.toContain("PATH-EXEMPT-STALE");
    expect(tracked.status).toBe(0);

    // BEFORE: the row this repository actually carried until V3-2.16, restored
    // verbatim except for the owner field the same change makes mandatory
    // (without it the row no longer parses, which would prove a different
    // rule). `meteorite/run.sh` is tracked, so the reason is discharged.
    const staleLedger = join(scratch, "with-discharged-row.tsv");
    writeFileSync(
      staleLedger,
      readFileSync(trackedPathExemptions, "utf8") +
        "bpa-meteorite.service\t/meteorite/run.sh\towner=V3-1.5; meteorite/run.sh not yet built on v3; tracked at instance/workboard.md row V3-1.5\n",
    );
    const before = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, PATH_EXEMPTIONS_FILE: staleLedger, ...RENDER_ENV });
    // Named by entry, and stating that the reason is discharged -- so the fix
    // is the message, not an investigation.
    expect(before.stderr).toContain("PATH-EXEMPT-STALE bpa-meteorite.service: /meteorite/run.sh now exists");
    expect(before.stderr).toContain("the reason for this exemption is discharged");
    expect(before.status).not.toBe(0);
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("V3-2.16: an exemption ADDED for a path that already exists is rejected, even when no template names it", () => {
  // The other direction of the lock, and a stronger property than re-testing
  // the rows a template happens to reference: the ledger is checked on its own
  // terms, so a row that has quietly stopped applying cannot hide behind the
  // fact that nothing consults it any more.
  const templates = mkdtempSync(join(tmpdir(), "bpa-unit-drift-added-existing-"));
  const emptyDeployed = mkdtempSync(join(tmpdir(), "bpa-unit-drift-added-existing-deploy-"));
  try {
    const manifest = join(templates, "manifest.tsv");
    writeFileSync(manifest, "fake-unit.service\tgeneric\n");
    writeFileSync(
      join(templates, "fake-unit.service.in"),
      "[Unit]\nDescription=synthetic fixture\n\n[Service]\nType=oneshot\nExecStart=${INSTALL_ROOT}/known/pending/path.sh\n",
    );
    const exemptions = join(templates, "path-exemptions.tsv");
    // gate/land.sh is tracked and present -- an exemption for it is a claim
    // this repository can immediately falsify.
    writeFileSync(
      exemptions,
      [
        "fake-unit.service\t/known/pending/path.sh\towner=none; a fixture path, deliberately not built",
        "fake-unit.service\t/gate/land.sh\towner=none; a path that exists, which is exactly what must be refused",
        "",
      ].join("\n"),
    );
    const result = runCheck({
      TEMPLATE_DIR: templates,
      INSTANCE_TEMPLATE_DIR: join(templates, "empty-instance"),
      SYSTEMD_SYSTEM_DIR: emptyDeployed,
      MANIFEST_FILE: manifest,
      PATH_EXEMPTIONS_FILE: exemptions,
      ...RENDER_ENV,
    });
    expect(result.stderr).toContain("PATH-EXEMPT-STALE fake-unit.service: /gate/land.sh now exists");
    // The genuinely absent path keeps its exemption: this rule expires
    // discharged debt, it does not delete live debt.
    expect(result.stdout).toContain("PATH-EXEMPT fake-unit.service: /known/pending/path.sh not in repo");
    expect(result.status).not.toBe(0);
  } finally {
    rmSync(templates, { recursive: true, force: true });
    rmSync(emptyDeployed, { recursive: true, force: true });
  }
});

test("BEFORE/AFTER (V3-2.16): an exemption with no owner fails closed rather than becoming a debt nobody owns", () => {
  // Two rows in this repository's own ledger recorded "no workboard row yet"
  // and stayed that way. An unowned debt is the one nobody closes, so the
  // owner field is required by the parser rather than by convention. What an
  // owner id LOOKS like is this installation's business (CLAUDE.md Mission,
  // HR-309), so the mechanism matches the field, never a row-id shape.
  const templates = mkdtempSync(join(tmpdir(), "bpa-unit-drift-owner-"));
  const emptyDeployed = mkdtempSync(join(tmpdir(), "bpa-unit-drift-owner-deploy-"));
  try {
    const manifest = join(templates, "manifest.tsv");
    writeFileSync(manifest, "fake-unit.service\tgeneric\n");
    writeFileSync(
      join(templates, "fake-unit.service.in"),
      "[Unit]\nDescription=synthetic fixture\n\n[Service]\nType=oneshot\nExecStart=${INSTALL_ROOT}/known/pending/path.sh\n",
    );
    const owned = join(templates, "owned.tsv");
    writeFileSync(owned, "fake-unit.service\t/known/pending/path.sh\towner=V3-0.0; a fixture debt with a row behind it\n");
    const before = runCheck({
      TEMPLATE_DIR: templates,
      INSTANCE_TEMPLATE_DIR: join(templates, "empty-instance"),
      SYSTEMD_SYSTEM_DIR: emptyDeployed,
      MANIFEST_FILE: manifest,
      PATH_EXEMPTIONS_FILE: owned,
      ...RENDER_ENV,
    });
    expect(before.stdout).toContain("PATH-EXEMPT fake-unit.service: /known/pending/path.sh not in repo");
    expect(before.stderr).not.toContain("without an owner");
    // (exit 1 here is the unrelated DRIFT for the undeployed fixture unit; the
    // contrast that matters is the fail-closed exit 2 below.)
    expect(before.status).not.toBe(2);

    // The same row, in the shape the ledger used before this change: prose
    // with nobody's name on it.
    const unowned = join(templates, "unowned.tsv");
    writeFileSync(unowned, "fake-unit.service\t/known/pending/path.sh\tnot yet built on v3; no workboard row yet\n");
    const after = runCheck({
      TEMPLATE_DIR: templates,
      INSTANCE_TEMPLATE_DIR: join(templates, "empty-instance"),
      SYSTEMD_SYSTEM_DIR: emptyDeployed,
      MANIFEST_FILE: manifest,
      PATH_EXEMPTIONS_FILE: unowned,
      ...RENDER_ENV,
    });
    expect(after.status).toBe(2);
    expect(after.stderr).toContain("unit-path exemption without an owner");
  } finally {
    rmSync(templates, { recursive: true, force: true });
    rmSync(emptyDeployed, { recursive: true, force: true });
  }
});

test("BEFORE/AFTER: an unreadable deployed-unit exemptions file fails closed instead of reporting no exemptions", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-exempt-file-"));
  const brokenExemptions = mkdtempSync(join(tmpdir(), "bpa-unit-drift-broken-exemptions-"));
  try {
    renderAllTemplates(deployedDir);
    const before = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, EXEMPTIONS_FILE: join(brokenExemptions, "missing.tsv"), ...RENDER_ENV });
    expect(before.status).toBe(0);
    const after = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, EXEMPTIONS_FILE: brokenExemptions, ...RENDER_ENV });
    expect(after.status).toBe(2);
    expect(after.stderr).toContain("unit-drift-exemptions unreadable");
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
    rmSync(brokenExemptions, { recursive: true, force: true });
  }
});

test("BEFORE/AFTER: an unreadable path exemptions file fails closed instead of reporting no exemptions", () => {
  const badTemplates = mkdtempSync(join(tmpdir(), "bpa-unit-drift-path-exempt-file-"));
  const emptyDeployed = mkdtempSync(join(tmpdir(), "bpa-unit-drift-path-exempt-deploy-"));
  const brokenExemptions = mkdtempSync(join(tmpdir(), "bpa-unit-drift-path-broken-exemptions-"));
  try {
    const manifest = join(badTemplates, "manifest.tsv");
    writeFileSync(manifest, "fake-unit.service\tgeneric\n");
    writeFileSync(
      join(badTemplates, "fake-unit.service.in"),
      "[Unit]\nDescription=synthetic drift fixture\n\n[Service]\nType=oneshot\nExecStart=${INSTALL_ROOT}/definitely/not/a/real/path.sh\n",
    );
    const before = runCheck({
      TEMPLATE_DIR: badTemplates,
      INSTANCE_TEMPLATE_DIR: join(badTemplates, "empty-instance"),
      SYSTEMD_SYSTEM_DIR: emptyDeployed,
      MANIFEST_FILE: manifest,
      PATH_EXEMPTIONS_FILE: join(brokenExemptions, "missing.tsv"),
      ...RENDER_ENV,
    });
    expect(before.status).not.toBe(0);
    expect(before.stderr).not.toContain("path-exemptions unreadable");
    const after = runCheck({
      TEMPLATE_DIR: badTemplates,
      INSTANCE_TEMPLATE_DIR: join(badTemplates, "empty-instance"),
      SYSTEMD_SYSTEM_DIR: emptyDeployed,
      MANIFEST_FILE: manifest,
      PATH_EXEMPTIONS_FILE: brokenExemptions,
      ...RENDER_ENV,
    });
    expect(after.status).toBe(2);
    expect(after.stderr).toContain("unit-path-exemptions unreadable");
  } finally {
    rmSync(badTemplates, { recursive: true, force: true });
    rmSync(emptyDeployed, { recursive: true, force: true });
    rmSync(brokenExemptions, { recursive: true, force: true });
  }
});

test("a malformed exemption entry (missing evidence) fails closed rather than being silently accepted", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-malformed-"));
  try {
    renderAllTemplates(deployedDir);
    const exemptionsFile = join(deployedDir, "malformed.tsv");
    writeFileSync(exemptionsFile, "bpa-orchestrator.service\tdeliberately-absent\t\n");
    const result = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, EXEMPTIONS_FILE: exemptionsFile, ...RENDER_ENV });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid unit-drift exemption");
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
  }
});

test("a TSV whose final line lacks a trailing newline is still honored, not dropped", () => {
  // `while read` alone silently drops a final line with no trailing
  // newline -- fails closed today only by accident (a dropped exemption is
  // MORE strict), but is one edit away from being a hole in the other
  // direction (a dropped manifest requirement). All three TSV readers in
  // the script use `read ... || [[ -n "$var" ]]` specifically to avoid this.
  const templates = mkdtempSync(join(tmpdir(), "bpa-unit-drift-no-trailing-nl-"));
  const emptyDeployed = mkdtempSync(join(tmpdir(), "bpa-unit-drift-no-trailing-nl-deploy-"));
  try {
    const manifest = join(templates, "manifest.tsv");
    // No trailing newline after the last (only) entry.
    writeFileSync(manifest, "fake-unit.service\tgeneric");
    writeFileSync(
      join(templates, "fake-unit.service.in"),
      "[Unit]\nDescription=synthetic fixture\n\n[Service]\nType=oneshot\nExecStart=${INSTALL_ROOT}/known/pending/path.sh\n",
    );
    const exemptions = join(templates, "path-exemptions.tsv");
    // No trailing newline here either.
    writeFileSync(
      exemptions,
      "fake-unit.service\t/known/pending/path.sh\towner=none; deliberately pending, no trailing newline in this file",
    );
    const result = runCheck({
      TEMPLATE_DIR: templates,
      INSTANCE_TEMPLATE_DIR: join(templates, "empty-instance"),
      SYSTEMD_SYSTEM_DIR: emptyDeployed,
      MANIFEST_FILE: manifest,
      PATH_EXEMPTIONS_FILE: exemptions,
      ...RENDER_ENV,
    });
    // If the last line had been dropped: the manifest would fail to find any
    // requirement for fake-unit.service (MANIFEST-MISSING would be absent
    // entirely because the loop body never ran), and separately the path
    // exemption would not apply (PATH-MISSING instead of PATH-EXEMPT).
    expect(result.stderr).not.toContain("MANIFEST-MISSING");
    expect(result.stdout).toContain(
      "PATH-EXEMPT fake-unit.service: /known/pending/path.sh not in repo (owner=none; deliberately pending, no trailing newline in this file)",
    );
  } finally {
    rmSync(templates, { recursive: true, force: true });
    rmSync(emptyDeployed, { recursive: true, force: true });
  }
});

test("every tracked template renders cleanly through the production renderer", () => {
  // V3-2.12: this test used to be a false green. It asserted only that no raw
  // `${VAR}` token survived -- but unrestricted envsubst can never leave one;
  // it replaces an unknown name with the EMPTY STRING and exits 0. The
  // assertion was therefore unfalsifiable by the very defect it was shaped
  // like, and `OnCalendar=` shipped past it to a nightly timer. It now asserts
  // on the rendered VALUE, which is what a deployed unit actually depends on.
  //
  // Round-2 review (lens one, F3): the residual-`$` half was STILL
  // unfalsifiable after that fix, for the same reason one layer down. It kept
  // using renderDir, whose harness shells out to unrestricted envsubst -- so a
  // template naming a variable no renderer supplies came out silently
  // truncated (`ExecStart=/bin/true`), non-empty, and clean, while the shipped
  // renderer refuses it outright. A test harness that does not mirror the
  // renderer it claims to check cannot check it.
  //
  // So render through bootstrap/unit-render-lib.sh here -- the same code path
  // install.sh and check-unit-drift.sh both use. Its non-zero exit IS the
  // assertion for the unsupplied-variable case; the per-line checks below stay
  // as an independent restatement, so a bug inside the library cannot hide
  // behind itself.
  const renderLibPath = join(repoRoot, "bootstrap", "unit-render-lib.sh");
  const scratch = mkdtempSync(join(tmpdir(), "bpa-unit-drift-render-check-"));
  try {
    for (const dir of [genericTemplateDir, instanceTemplateDir]) {
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".in")) continue;
        const unit = entry.slice(0, -3);
        const rendering = spawnSync(
          "bash",
          [renderLibPath, "--render", join(dir, entry), join(scratch, unit), unit],
          { encoding: "utf8", env: { ...process.env, ...RENDER_ENV } },
        );
        expect(
          rendering.status,
          `${entry}: the production renderer refused this template:\n${rendering.stderr}`,
        ).toBe(0);
        const template = readFileSync(join(dir, entry), "utf8").split("\n");
        const rendered = readFileSync(join(scratch, unit), "utf8").split("\n");
        expect(rendered.length, `${entry}: rendering changed the line count`).toBe(template.length);
        for (let i = 0; i < template.length; i++) {
          expect(rendered[i], `${entry}:${i + 1}: unsubstituted variable survived`).not.toMatch(/\$/);
          const key = template[i].match(/^([A-Za-z][A-Za-z0-9_-]*)=(.*)$/);
          if (!key || key[2].trim() === "") continue;
          // A key that carried a value in the template must still carry one:
          // `OnCalendar=` with an empty value is systemd's documented way to
          // CLEAR a schedule, so an emptied value is a disarmed unit, not a
          // cosmetic difference.
          expect(
            rendered[i].slice(key[1].length + 1).trim(),
            `${entry}:${i + 1}: ${key[1]}= rendered empty from "${key[2]}"`,
          ).not.toBe("");
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the generic template directory carries no product-hardcoded unit (HR-309)", () => {
  // Round-2 review defect 3: agentic-bpa-* units hard-coded a product name
  // into the generic bootstrap/units/ mechanism directory. CLAUDE.md's
  // Mission and HR-309 rule that a defect; they now live under
  // instance/units/ instead. This test pins the boundary so it cannot
  // silently regress.
  const genericEntries = readdirSync(genericTemplateDir);
  for (const entry of genericEntries) {
    expect(entry.startsWith("agentic-bpa-")).toBe(false);
  }
  const instanceEntries = readdirSync(instanceTemplateDir);
  expect(instanceEntries.filter((e) => e.startsWith("agentic-bpa-")).length).toBe(5);
});

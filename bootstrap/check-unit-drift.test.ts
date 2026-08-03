import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readdirSync } from "fs";
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

const repoRoot = join(import.meta.dir, "..");
const script = join(repoRoot, "bootstrap", "check-unit-drift.sh");
const realTemplateDir = join(repoRoot, "bootstrap", "units");

const RENDER_ENV = {
  INSTALL_ROOT: "/root/bpa-dev-infrastructure",
  ENV_FILE: "/root/.config/bpa/orchestrator.env",
  BUN_BIN: "/usr/local/bin/bun",
  BASH_BIN: "/usr/bin/bash",
  FULL_SUITE_ON_CALENDAR: "*-*-* 03:30:00",
  ORCH_WATCHDOG_INTERVAL: "60",
};

function runCheck(env: Record<string, string> = {}) {
  return spawnSync("bash", [script], {
    cwd: repoRoot,
    encoding: "utf8",
    // BUN_BIN is deliberately unset: gate/land-lib.sh exports it for its own
    // run, and this script must not depend on that caller-controlled value.
    env: { ...process.env, BUN_BIN: "", ...env },
  });
}

// Render every real tracked template into a scratch "deployed" directory
// using the same envsubst variables bootstrap/install.sh would use, so a
// standalone test can assert both a genuinely clean deployment and a
// genuinely broken one without ever touching the real host's
// /etc/systemd/system or requiring a container.
function renderAllTemplates(destDir: string) {
  for (const entry of readdirSync(realTemplateDir)) {
    if (!entry.endsWith(".in")) continue;
    const unit = entry.slice(0, -3);
    const result = spawnSync("bash", ["-c", `envsubst < "$1" > "$2"`, "_", join(realTemplateDir, entry), join(destDir, unit)], {
      env: { ...process.env, ...RENDER_ENV },
    });
    if (result.status !== 0) {
      throw new Error(`failed to render ${entry}: ${result.stderr}`);
    }
  }
}

test("a fully and correctly deployed fleet matches every template and exits 0", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-full-"));
  try {
    renderAllTemplates(deployedDir);
    const result = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(`${result.stdout}${result.stderr}`).not.toContain("DRIFT");
    expect(result.status).toBe(0);
    // The three units the incident named -- orchestrator, its watchdog, and
    // the telegram daemon that must be up before either -- are proven to
    // MATCH by name, not only by aggregate exit code.
    expect(result.stdout).toContain("MATCH bpa-orchestrator.service");
    expect(result.stdout).toContain("MATCH bpa-orchestrator-watchdog.service");
    expect(result.stdout).toContain("MATCH bpa-telegram-daemon.service");
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
  }
});

test("BEFORE/AFTER: a missing deployed unit is reported and the checker exits non-zero", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-missing-"));
  try {
    renderAllTemplates(deployedDir);
    // BEFORE: fully deployed, must be clean.
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
    // Simulate hand-edited drift: someone changed the deployed unit file
    // directly on the host instead of through the tracked template.
    writeFileSync(join(deployedDir, "bpa-telegram-daemon.service"), "[Unit]\nDescription=hand-edited on the host, diverged from git\n");
    const after = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(after.stderr).toContain("DRIFT bpa-telegram-daemon.service: deployed unit differs from rendered template");
    expect(after.status).not.toBe(0);
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
  }
});

test("BEFORE/AFTER: an absent template directory fails closed (exit 2) instead of reporting clean", () => {
  const deployedDir = mkdtempSync(join(tmpdir(), "bpa-unit-drift-anydeploy-"));
  const emptyTemplates = mkdtempSync(join(tmpdir(), "bpa-unit-drift-empty-templates-"));
  try {
    renderAllTemplates(deployedDir);
    // BEFORE: the real template set against this same deployment is clean.
    const before = runCheck({ SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(before.status).toBe(0);
    // AFTER: point at a template directory with nothing in it -- the
    // manifest of what SHOULD be deployed is unreadable/absent. Hard Floor 7:
    // an unmeasured subject must never look like a pass.
    const after = runCheck({ TEMPLATE_DIR: emptyTemplates, SYSTEMD_SYSTEM_DIR: deployedDir, ...RENDER_ENV });
    expect(after.status).toBe(2);
    expect(after.status).not.toBe(0);
    expect(after.stderr).toContain("no unit templates found");
  } finally {
    rmSync(deployedDir, { recursive: true, force: true });
    rmSync(emptyTemplates, { recursive: true, force: true });
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
    writeFileSync(
      join(badTemplates, "fake-unit.service.in"),
      "[Unit]\nDescription=synthetic drift fixture\n\n[Service]\nType=oneshot\nExecStart=${INSTALL_ROOT}/definitely/not/a/real/path.sh\n",
    );
    const after = runCheck({ TEMPLATE_DIR: badTemplates, SYSTEMD_SYSTEM_DIR: emptyDeployed, ...RENDER_ENV });
    expect(after.stderr).toContain("PATH-MISSING fake-unit.service: /definitely/not/a/real/path.sh does not exist");
    expect(after.status).not.toBe(0);
  } finally {
    rmSync(badTemplates, { recursive: true, force: true });
    rmSync(emptyDeployed, { recursive: true, force: true });
  }
});

test("a referenced path can be exempted, and the exemption's evidence is echoed for audit", () => {
  const badTemplates = mkdtempSync(join(tmpdir(), "bpa-unit-drift-exempt-template-"));
  const emptyDeployed = mkdtempSync(join(tmpdir(), "bpa-unit-drift-exempt-deploy-"));
  const exemptionsFile = join(badTemplates, "path-exemptions.tsv");
  try {
    writeFileSync(
      join(badTemplates, "fake-unit.service.in"),
      "[Unit]\nDescription=synthetic drift fixture\n\n[Service]\nType=oneshot\nExecStart=${INSTALL_ROOT}/definitely/not/a/real/path.sh\n",
    );
    // No exemption: fails.
    const unexempted = runCheck({ TEMPLATE_DIR: badTemplates, SYSTEMD_SYSTEM_DIR: emptyDeployed, PATH_EXEMPTIONS_FILE: exemptionsFile, ...RENDER_ENV });
    expect(unexempted.stderr).toContain("PATH-MISSING");
    // With a disposition and evidence, the same gap is visible but no longer fatal to the path check.
    writeFileSync(exemptionsFile, "fake-unit.service\ttest fixture, deliberately never built\n");
    const exempted = runCheck({ TEMPLATE_DIR: badTemplates, SYSTEMD_SYSTEM_DIR: emptyDeployed, PATH_EXEMPTIONS_FILE: exemptionsFile, ...RENDER_ENV });
    expect(exempted.stdout).toContain("PATH-EXEMPT fake-unit.service: /definitely/not/a/real/path.sh not in repo (test fixture, deliberately never built)");
  } finally {
    rmSync(badTemplates, { recursive: true, force: true });
    rmSync(emptyDeployed, { recursive: true, force: true });
  }
});

test("BEFORE/AFTER: an unreadable deployed-unit exemptions file fails closed instead of reporting no exemptions", () => {
  // A directory in place of the exemptions file reproduces the exact defect
  // class an independent reviewer found elsewhere in this repository on
  // 2026-08-03: a check that reported clean because it could not read its
  // own input file. `-r` alone would not catch this (root can list a
  // directory), so the guard also requires `-f`.
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
    writeFileSync(
      join(badTemplates, "fake-unit.service.in"),
      "[Unit]\nDescription=synthetic drift fixture\n\n[Service]\nType=oneshot\nExecStart=${INSTALL_ROOT}/definitely/not/a/real/path.sh\n",
    );
    const before = runCheck({
      TEMPLATE_DIR: badTemplates,
      SYSTEMD_SYSTEM_DIR: emptyDeployed,
      PATH_EXEMPTIONS_FILE: join(brokenExemptions, "missing.tsv"),
      ...RENDER_ENV,
    });
    expect(before.status).not.toBe(0);
    expect(before.stderr).not.toContain("path-exemptions unreadable");
    const after = runCheck({
      TEMPLATE_DIR: badTemplates,
      SYSTEMD_SYSTEM_DIR: emptyDeployed,
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

test("every tracked template renders cleanly with envsubst (no undefined-variable garbage)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bpa-unit-drift-render-check-"));
  try {
    renderAllTemplates(scratch);
    for (const entry of readdirSync(realTemplateDir)) {
      if (!entry.endsWith(".in")) continue;
      const rendered = spawnSync("cat", [join(scratch, entry.slice(0, -3))], { encoding: "utf8" }).stdout;
      // A template referencing a variable envsubst was not told about would
      // still "succeed" but leave the raw ${VAR} token in the output --
      // that is itself a form of drift the deployed unit would carry.
      expect(rendered).not.toMatch(/\$\{[A-Z_]+\}/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

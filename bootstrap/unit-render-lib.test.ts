import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Regression lock for workboard row V3-2.12: unit rendering silently emptied
// the two "notice it stopped" timers.
//
// bootstrap/install.sh rendered every unit template while exporting FOUR
// variables; bootstrap/check-unit-drift.sh rendered the SAME templates while
// exporting SIX. envsubst replaces a name it was never given with the empty
// string and exits 0, so:
//
//   OnCalendar=$FULL_SUITE_ON_CALENDAR         deployed as  OnCalendar=
//   OnUnitActiveSec=${ORCH_WATCHDOG_INTERVAL}s deployed as  OnUnitActiveSec=s
//
// An empty OnCalendar= is systemd's documented way to CLEAR a schedule and
// `s` does not parse, so the nightly full-suite timer and the orchestrator
// watchdog timer -- the two mechanisms whose only job is to notice that
// something stopped -- came up dead on a rebuilt host that then looked
// healthy.
//
// WHY EACH ARM EXISTS. A lock that only asserts the post-fix behavior would
// have passed against the broken implementation too: the pre-existing
// "every tracked template renders cleanly with envsubst" test in
// check-unit-drift.test.ts did exactly that, because it rendered with all six
// variables (not the installer's four) and looked only for a residual
// `${VAR}` token, which unrestricted envsubst can never leave behind. So the
// fail-before arms below re-create the pre-fix renderer literally and prove
// each assertion rejects it.

const repoRoot = join(import.meta.dir, "..");
const lib = join(repoRoot, "bootstrap", "unit-render-lib.sh");
const installer = join(repoRoot, "bootstrap", "install.sh");
const driftChecker = join(repoRoot, "bootstrap", "check-unit-drift.sh");
const genericTemplateDir = join(repoRoot, "bootstrap", "units");
const instanceTemplateDir = join(repoRoot, "instance", "units");
const manifestFile = join(repoRoot, "instance", "expected-units.tsv");

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `bpa-${prefix}-`));
}

function manifestUnits(): { unit: string; template: string }[] {
  return readFileSync(manifestFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const [unit, source] = line.split("\t");
      const dir = source.trim() === "instance" ? instanceTemplateDir : genericTemplateDir;
      return { unit: unit.trim(), template: join(dir, `${unit.trim()}.in`) };
    });
}

// The assertion under test, expressed independently of the shell so a bug in
// unit_render_assert_complete cannot hide behind itself. A rendered unit is
// defective if any line still contains `$`, or if a key= line that carried a
// value in the template no longer carries one.
function renderDefects(templateText: string, renderedText: string, unit: string): string[] {
  const tpl = templateText.split("\n");
  const ren = renderedText.split("\n");
  const defects: string[] = [];
  if (tpl.length !== ren.length) {
    defects.push(`${unit}: line count changed ${tpl.length} -> ${ren.length}`);
    return defects;
  }
  const keyLine = /^([A-Za-z][A-Za-z0-9_-]*)=(.*)$/;
  for (let i = 0; i < tpl.length; i++) {
    if (ren[i].includes("$")) {
      defects.push(`${unit}:${i + 1}: residual $ in rendered output: ${ren[i]}`);
    }
    const t = tpl[i].match(keyLine);
    if (!t || t[2].trim() === "") continue;
    const r = ren[i].match(keyLine);
    if (!r || r[1] !== t[1]) {
      defects.push(`${unit}:${i + 1}: key ${t[1]} did not survive rendering: ${ren[i]}`);
      continue;
    }
    if (r[2].trim() === "") {
      defects.push(`${unit}:${i + 1}: ${t[1]}= rendered empty from template value "${t[2]}"`);
    }
  }
  return defects;
}

// The installer's exact environment: whatever bootstrap/unit-render-lib.sh
// says it is. Read from the library rather than restated here, because a
// second copy of this list in a test file is the same defect the row is
// about -- the test would keep passing while the renderers drifted.
function installerRenderEnv(): Record<string, string> {
  const printed = spawnSync("bash", [lib, "--print-env"], { encoding: "utf8" });
  expect(printed.status, printed.stderr).toBe(0);
  const env: Record<string, string> = {};
  for (const line of printed.stdout.split("\n")) {
    if (!line) continue;
    const at = line.indexOf("=");
    env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

// Drive install.sh's REAL render_units against the REAL manifest and the REAL
// templates, into a throwaway directory. BOOTSTRAP_LIB_ONLY stops the script
// short of running any stage, BOOTSTRAP_TEST_EUID satisfies its root check
// without needing root, and SYSTEMD_SYSTEM_DIR redirects publication -- so
// this touches nothing on the host and installs, enables and starts nothing.
function runRenderUnits(destination: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", 'source "$INSTALLER_PATH"; render_units'], {
    encoding: "utf8",
    env: {
      ...process.env,
      BOOTSTRAP_LIB_ONLY: "true",
      BOOTSTRAP_TEST_EUID: "0",
      INSTALLER_PATH: installer,
      INSTALL_ROOT: repoRoot,
      SYSTEMD_SYSTEM_DIR: destination,
      EXPECTED_UNITS_FILE: manifestFile,
      ...extraEnv,
    },
  });
}

test("V3-2.12 lock: install.sh renders every tracked template with no empty value and no residual $", () => {
  const destination = scratch("render-lock");
  try {
    const result = runRenderUnits(destination);
    expect(result.status, `render_units failed:\n${result.stderr}`).toBe(0);

    const defects: string[] = [];
    for (const { unit, template } of manifestUnits()) {
      const rendered = join(destination, unit);
      expect(readdirSync(destination), `${unit} was not rendered`).toContain(unit);
      defects.push(
        ...renderDefects(readFileSync(template, "utf8"), readFileSync(rendered, "utf8"), unit),
      );
    }
    expect(defects).toEqual([]);

    // The two units the defect actually disarmed, pinned by their rendered
    // value. A generic assertion could be satisfied by a template that stopped
    // using the variable at all.
    expect(readFileSync(join(destination, "bpa-full-suite.timer"), "utf8")).toContain(
      "OnCalendar=*-*-* 03:30:00",
    );
    expect(readFileSync(join(destination, "bpa-orchestrator-watchdog.timer"), "utf8")).toContain(
      "OnUnitActiveSec=60s",
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test("V3-2.12 fail-before: the pre-fix four-variable export set produces the defect this lock catches", () => {
  const destination = scratch("render-failbefore");
  try {
    // Verbatim reconstruction of bootstrap/install.sh:333 before this row:
    // four exported names and an unrestricted envsubst.
    const preFixEnv = {
      INSTALL_ROOT: repoRoot,
      ENV_FILE: "/root/.config/bpa/orchestrator.env",
      BUN_BIN: "/usr/local/bin/bun",
      BASH_BIN: "/usr/bin/bash",
    };
    const defects: string[] = [];
    for (const { unit, template } of manifestUnits()) {
      const out = join(destination, unit);
      const rendered = spawnSync("bash", ["-c", 'envsubst < "$1" > "$2"', "_", template, out], {
        encoding: "utf8",
        env: { ...process.env, ...preFixEnv },
      });
      expect(rendered.status, "the pre-fix renderer exited 0 -- that is the point").toBe(0);
      defects.push(
        ...renderDefects(readFileSync(template, "utf8"), readFileSync(out, "utf8"), unit),
      );
    }

    // Red-before, named: the assertion has teeth against the exact historical
    // implementation, and against the exact two units that shipped disarmed.
    expect(defects).not.toEqual([]);
    expect(defects.some((d) => d.startsWith("bpa-full-suite.timer:") && d.includes("OnCalendar="))).toBe(
      true,
    );

    // And the shipped library refuses that same render. `--render` renders
    // afresh with the restricted substitution, so the watchdog timer fails as
    // a residual `$` rather than as an empty value: the pre-fix renderer would
    // have emptied ORCH_WATCHDOG_INTERVAL into the unparsable `OnUnitActiveSec=s`,
    // which no key-emptiness check can see. That is why restricting envsubst
    // to a known name list is a separate defence and not a stylistic choice.
    for (const unit of ["bpa-full-suite.timer", "bpa-orchestrator-watchdog.timer"]) {
      const template = join(genericTemplateDir, `${unit}.in`);
      const refused = spawnSync("bash", [lib, "--render", template, join(destination, `${unit}.probe`)], {
        encoding: "utf8",
        // Same four names as the pre-fix installer; the library supplies the
        // two it omitted from its own single list, so this must SUCCEED --
        // proving the fix is the list, not the caller.
        env: { ...process.env, ...preFixEnv },
      });
      expect(refused.status, `${unit}: ${refused.stderr}`).toBe(0);
    }
    expect(readFileSync(join(destination, "bpa-orchestrator-watchdog.timer.probe"), "utf8")).toContain(
      "OnUnitActiveSec=60s",
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test("V3-2.12 lock: what install.sh deploys is byte-identical to what check-unit-drift.sh validates", () => {
  // The defect was never a bad template -- it was two renderers disagreeing.
  // Rendering with install.sh and then asking check-unit-drift.sh to compare
  // its own render against that output is the direct assertion. Before this
  // row the same pairing reported DRIFT on both timers.
  const destination = scratch("render-crosscheck");
  try {
    expect(runRenderUnits(destination).status).toBe(0);
    const drift = spawnSync("bash", [driftChecker], {
      encoding: "utf8",
      env: {
        ...process.env,
        INSTALL_ROOT: repoRoot,
        REPO_ROOT: repoRoot,
        SYSTEMD_SYSTEM_DIR: destination,
      },
    });
    expect(drift.stderr).not.toContain("DRIFT");
    expect(drift.status, `${drift.stdout}\n${drift.stderr}`).toBe(0);
    const matched = drift.stdout.split("\n").filter((l) => l.startsWith("MATCH ")).length;
    expect(matched).toBe(manifestUnits().length);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test("V3-2.12 lock: every variable any tracked template references is in the library's one list", () => {
  // The durable answer to "is some other template depending on a variable
  // neither renderer supplies". Today: no. This fails the day one does.
  const names = spawnSync("bash", [lib, "--print-names"], { encoding: "utf8" });
  expect(names.status).toBe(0);
  const known = new Set(names.stdout.split("\n").filter(Boolean));
  expect(known.has("FULL_SUITE_ON_CALENDAR")).toBe(true);
  expect(known.has("ORCH_WATCHDOG_INTERVAL")).toBe(true);

  const referenced = new Map<string, string[]>();
  for (const dir of [genericTemplateDir, instanceTemplateDir]) {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".in")) continue;
      const text = readFileSync(join(dir, entry), "utf8");
      for (const match of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
        referenced.set(match[1], [...(referenced.get(match[1]) ?? []), entry]);
      }
    }
  }
  expect(referenced.size).toBeGreaterThan(0);
  const unsupplied = [...referenced.entries()]
    .filter(([name]) => !known.has(name))
    .map(([name, units]) => `${name} (used by ${units.join(", ")})`);
  expect(unsupplied).toEqual([]);
});

test("V3-2.12 lock: the render assertion refuses an empty value and a residual $", () => {
  const dir = scratch("render-refusal");
  try {
    const emptied = join(dir, "emptied.timer.in");
    writeFileSync(emptied, "[Timer]\nOnCalendar=${INSTALL_ROOT}\nUnit=x.service\n");
    // INSTALL_ROOT is in the list, so it renders; force it blank at the source
    // by pointing the template at a name that is NOT in the list instead.
    const unknown = join(dir, "unknown.timer.in");
    writeFileSync(unknown, "[Timer]\nOnCalendar=$NOBODY_SUPPLIES_THIS\nUnit=x.service\n");
    const residual = spawnSync("bash", [lib, "--render", unknown, join(dir, "unknown.timer")], {
      encoding: "utf8",
    });
    expect(residual.status).toBe(1);
    expect(residual.stderr).toContain("RENDER-RESIDUAL-VAR");

    // An empty value on a key the template gave a value: rendered through the
    // library with a whitespace-only substitution, which clears a schedule
    // exactly as an empty one does.
    const blanked = spawnSync("bash", [lib, "--render", emptied, join(dir, "emptied.timer")], {
      encoding: "utf8",
      env: { ...process.env, INSTALL_ROOT: "   " },
    });
    expect(blanked.status).toBe(1);
    expect(blanked.stderr).toContain("RENDER-EMPTY-VALUE");

    const ok = spawnSync("bash", [lib, "--render", emptied, join(dir, "ok.timer")], {
      encoding: "utf8",
    });
    expect(ok.status, ok.stderr).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V3-2.12 lock: systemd-analyze rejects a bad staged render, and its absence is loud", () => {
  const dir = scratch("render-analyze");
  try {
    const good = join(dir, "good");
    mkdirSync(good);
    writeFileSync(join(good, "probe.timer"), "[Timer]\nOnCalendar=*-*-* 03:30:00\n");
    const accepted = spawnSync("bash", [lib, "--verify-staged", good], { encoding: "utf8" });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("systemd-analyze accepted");

    // The exact shape the four-variable render produced.
    const bad = join(dir, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "probe.timer"), "[Timer]\nOnCalendar=\n");
    const rejected = spawnSync("bash", [lib, "--verify-staged", bad], { encoding: "utf8" });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("UNIT-VERIFY-FATAL");

    // An empty staged directory must not read as a verified render.
    const empty = join(dir, "empty");
    mkdirSync(empty);
    const nothing = spawnSync("bash", [lib, "--verify-staged", empty], { encoding: "utf8" });
    expect(nothing.status).toBe(1);

    // Absence says so loudly instead of passing in silence. A PATH with only
    // the interpreters the library itself needs, and no systemd-analyze.
    const stubPath = join(dir, "bin");
    mkdirSync(stubPath);
    for (const tool of ["bash", "find", "sort", "printf", "command"]) {
      const real = spawnSync("bash", ["-c", `command -v ${tool} || true`, ], { encoding: "utf8" }).stdout.trim();
      if (real) spawnSync("ln", ["-sf", real, join(stubPath, tool)]);
    }
    const unavailable = spawnSync("bash", [lib, "--verify-staged", good], {
      encoding: "utf8",
      env: { ...process.env, PATH: stubPath },
    });
    expect(unavailable.status, unavailable.stderr).toBe(0);
    expect(unavailable.stderr).toContain("UNIT-VERIFY-UNAVAILABLE");
    expect(unavailable.stderr).toContain("were NOT verified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V3-2.12 lock: the installer's environment is read from the library, not restated", () => {
  const env = installerRenderEnv();
  // Every name the library knows has a usable value, and the two the
  // installer used to omit are among them with real systemd-valid values.
  for (const [name, value] of Object.entries(env)) {
    expect(value.trim(), `${name} has no default`).not.toBe("");
  }
  expect(env.FULL_SUITE_ON_CALENDAR).toBe("*-*-* 03:30:00");
  expect(env.ORCH_WATCHDOG_INTERVAL).toBe("60");

  // Neither renderer may reintroduce a private copy of a render default.
  for (const script of [installer, driftChecker]) {
    const text = readFileSync(script, "utf8");
    expect(text).toContain("unit-render-lib.sh");
    for (const name of Object.keys(env)) {
      expect(
        new RegExp(`^\\s*${name}="\\$\\{${name}:-`, "m").test(text),
        `${script} carries its own default for ${name}`,
      ).toBe(false);
    }
  }
});

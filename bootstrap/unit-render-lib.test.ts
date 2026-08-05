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
    // FOUR names means four, whatever the caller's environment holds. This arm
    // reproduces the historical defect by OMITTING two names, so an ambient
    // FULL_SUITE_ON_CALENDAR repairs the very render it is trying to break:
    // no defect appears, `defects` is empty, and the arm can no longer show
    // red-before. That is exactly what happened inside bootstrap/install.sh,
    // whose test-gate strip list forgot those two names while the meteorite
    // exported them (round 4) -- the arm failed there and nowhere else, which
    // is why this host never saw it. The strip list is fixed and locked in
    // bootstrap/bootstrap.test.sh; this arm additionally stops depending on
    // any caller getting it right. The deleted set is derived from the
    // library, so a seventh render variable cannot reopen the hole.
    const preFixBase: Record<string, string | undefined> = { ...process.env };
    for (const name of Object.keys(installerRenderEnv())) delete preFixBase[name];
    const preFixOnly = { ...preFixBase, ...preFixEnv };
    const defects: string[] = [];
    for (const { unit, template } of manifestUnits()) {
      const out = join(destination, unit);
      const rendered = spawnSync("bash", ["-c", 'envsubst < "$1" > "$2"', "_", template, out], {
        encoding: "utf8",
        env: preFixOnly,
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
        env: preFixOnly,
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

test("V3-2.12 lock: --verify-source forwards the library's whole list to check-unit-drift.sh", () => {
  // The "third list" half of this row: install.sh's rendered_units_status
  // named four of the six render variables when it called
  // check-unit-drift.sh, so the checker fell back to its OWN defaults for the
  // other two and validated a render the installer had never written. The fix
  // forwards unit_render_env_assignments as one array. Round-2 review (lens
  // one, F2) found the fix correct and unlocked -- deleting the forwarded
  // array left the whole suite green.
  //
  // WHY THIS ARM IS SHAPED THIS WAY, because the obvious shape does not work:
  // `env NAME=v ... script` passes the PARENT environment through as well, so
  // an exported override reaches check-unit-drift.sh whether or not it is
  // forwarded, and the assertion passes for the wrong reason. That is exactly
  // how the deleted-array mutation stayed green.
  //
  // The render variables are deliberately not exported (see
  // unit-render-lib.sh, "Environment plumbing"), so production's real
  // condition is a NON-EXPORTED shell value -- set below inside the same bash
  // process that sources install.sh. Forwarding is then the only route from
  // the installer's value to the checker's render.
  const destination = scratch("verify-source-forward");
  const nonDefault = "*-*-* 04:44:00";
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          // `unset -v` first: assigning to a name that is already exported
          // KEEPS the export attribute, which would hand the value to the
          // child directly and disarm this lock. Unsetting drops the
          // attribute, so the assignment below is unambiguously local.
          "unset -v FULL_SUITE_ON_CALENDAR",
          `FULL_SUITE_ON_CALENDAR='${nonDefault}'`,
          'source "$INSTALLER_PATH"',
          "render_units >/dev/null 2>&1 || { echo RENDER-FAILED >&2; exit 9; }",
          "rendered_units_status",
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BOOTSTRAP_LIB_ONLY: "true",
          BOOTSTRAP_TEST_EUID: "0",
          INSTALLER_PATH: installer,
          INSTALL_ROOT: repoRoot,
          REPO_ROOT: repoRoot,
          SYSTEMD_SYSTEM_DIR: destination,
          EXPECTED_UNITS_FILE: manifestFile,
        },
      },
    );

    // Guard the fixture before the assertion that matters: if render_units
    // ignored the override, the checker agreeing with it would prove nothing.
    expect(readFileSync(join(destination, "bpa-full-suite.timer"), "utf8")).toContain(
      `OnCalendar=${nonDefault}`,
    );
    expect(result.stderr).not.toContain("RENDER-FAILED");
    expect(result.stderr).not.toContain("DRIFT");
    expect(
      result.status,
      `check-unit-drift.sh rendered with its own defaults, not the installer's values:\n${result.stderr}`,
    ).toBe(0);
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

test("V3-2.12 lock: systemd-analyze rejects a bad staged render, and its absence is FATAL", () => {
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

    // Absence is FATAL, not loud. Tier-A review round 2 (lens two) overruled
    // the previous reading, and this arm is the inverse of the one that
    // asserted it: the earlier version required exit 0 here, so the behaviour
    // being removed was the behaviour under lock.
    //
    // The reasoning, because a future reader will be tempted to relax it
    // again: the render assertions see a residual `$`, a `key=` that lost its
    // value, and a changed line count. They cannot see a value that is
    // present but WRONG -- `OnUnitActiveSec=s`, which is half of this row's
    // own defect. For value validity systemd-analyze is not a fourth opinion,
    // it is the ONLY one, so returning 0 without it installs value-unvalidated
    // units under "Bootstrap stage 2 completed". systemd-analyze ships in the
    // same package as systemctl, so a host that can arm these timers has it.
    //
    // A PATH with only the interpreters the library itself needs, and no
    // systemd-analyze.
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
    expect(
      unavailable.status,
      `absence of systemd-analyze must fail the render, not warn:\n${unavailable.stderr}`,
    ).toBe(1);
    // Guard the stub itself: a PATH that broke `find` or `bash` would also
    // produce a non-zero exit and would satisfy the assertion above for the
    // wrong reason. The marker proves this is the absence branch.
    expect(unavailable.stderr).toContain("UNIT-VERIFY-UNAVAILABLE");
    expect(unavailable.stderr).toContain("were NOT verified");
    expect(unavailable.stderr).toContain("HARD PREREQUISITE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V3-2.12 lock: a directive value carrying the benign phrase cannot launder itself into a pass", () => {
  // Tier-A review round 2 (lens two), blocking finding. The benign predicate
  // was the unanchored substring `*"is not executable: No such file or
  // directory"*`. systemd echoes DIRECTIVE VALUES into its other diagnostics,
  // so a value containing that phrase dragged its own fatal line into the
  // benign class -- and lens two reached it through the installer's own
  // documented ORCH_WATCHDOG_INTERVAL override, producing a permanently
  // disarmed watchdog timer while render_units exited 0 and printed
  // "systemd-analyze accepted the staged units".
  //
  // The reachability demo is the proof, not the risk. The property under lock
  // is that the predicate describes the message it accepts.
  const dir = scratch("render-launder");
  const destination = scratch("render-launder-dest");
  const phrase = "is not executable: No such file or directory";
  try {
    // 1. The classifier itself, on a staged unit that is otherwise valid --
    //    OnBootSec keeps systemd from emitting any second complaint, so this
    //    one line is all the classifier has to go on.
    const staged = join(dir, "staged");
    mkdirSync(staged);
    writeFileSync(
      join(staged, "probe.timer"),
      `[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${phrase}s\n`,
    );
    const laundered = spawnSync("bash", [lib, "--verify-staged", staged], { encoding: "utf8" });
    expect(laundered.status, `laundered timer was accepted:\n${laundered.stdout}`).toBe(1);
    expect(laundered.stderr).toContain("UNIT-VERIFY-FATAL");
    expect(laundered.stdout).not.toContain("systemd-analyze accepted");

    // 2. A value that embeds the WHOLE benign message shape -- `: Command `,
    //    a path, and the phrase as the last thing on the line. Review round 2
    //    proposed the substring pair `*": Command "*" is not executable: No
    //    such file or directory"`, which still classifies this line as benign
    //    and ships the disarmed timer. Verified against systemd 255: the
    //    proposed pair says NOTE here, the shipped full-line anchor says
    //    FATAL. OnCalendar rather than OnUnitActiveSec because the timer
    //    template appends `s` to the interval, and that stray trailing
    //    character is what makes the weaker pattern look sufficient.
    const crafted = join(dir, "crafted");
    mkdirSync(crafted);
    writeFileSync(
      join(crafted, "probe.timer"),
      `[Timer]\nOnBootSec=2min\nOnCalendar=x.service: Command /x ${phrase}\n`,
    );
    const craftedResult = spawnSync("bash", [lib, "--verify-staged", crafted], { encoding: "utf8" });
    expect(craftedResult.status, `crafted timer was accepted:\n${craftedResult.stdout}`).toBe(1);
    expect(craftedResult.stdout).not.toContain("systemd-analyze accepted");

    // 3. No regression on the real benign class: every genuine
    //    "Command … is not executable" line the tracked set produces must
    //    still be a NOTE, or this fix would simply have made the installer
    //    refuse to run on a clean host.
    const clean = runRenderUnits(destination);
    expect(clean.status, `the tracked set no longer verifies:\n${clean.stderr}`).toBe(0);
    expect(clean.stderr).toContain("UNIT-VERIFY-NOTE");
    expect(clean.stderr).not.toContain("UNIT-VERIFY-FATAL");

    // 4. End to end, lens two's exact reproduction through the installer's
    //    own render path: it must now fail and publish nothing.
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination);
    const reached = runRenderUnits(destination, { ORCH_WATCHDOG_INTERVAL: phrase });
    expect(reached.status, "the documented override still launders a disarmed timer").not.toBe(0);
    expect(reached.stderr).toContain("UNIT-VERIFY-FATAL");
    expect(readdirSync(destination), "a rejected render published units anyway").toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test("V3-2.12 lock: an unresolvable dependency is a ledgered machine fact, and the ledger is visible debt", () => {
  // Round 4. `Requires=postgresql.service` in a tracked template makes
  // systemd-analyze say, on a machine without that unit:
  //
  //   <unit>: Failed to create <unit>/start: Unit postgresql.service not found.
  //
  // Every non-benign line was fatal, so on a CLEAN machine -- the only kind
  // this row's rebuild proof runs on -- render_units published nothing and
  // four locks failed. This host passed only because postgresql.service
  // happens to be installed here. That line is a claim about the checking
  // machine, exactly like `Command <path> is not executable`, and it now has
  // the ledger that class already had.
  //
  // The fixture is synthetic on purpose: the real tracked set produces this
  // line only where postgresql.service is absent, so a test keyed to it would
  // assert nothing here and everything in a container. Arm 8 covers the real
  // ledger, which IS machine-independent.
  const dir = scratch("verify-dependency");
  try {
    const staged = join(dir, "staged");
    mkdirSync(staged);
    writeFileSync(
      join(staged, "fixture-dep.service"),
      "[Unit]\nDescription=fixture\nRequires=fixture-missing.service\n\n[Service]\nType=oneshot\nExecStart=/bin/true\n",
    );
    const manifest = join(dir, "manifest.tsv");
    writeFileSync(manifest, "# fixture\nfixture-dep.service\tinstance\nbpa-orchestrator.service\tgeneric\n");
    const ledger = join(dir, "ledger.tsv");
    const verify = (extra: Record<string, string> = {}) =>
      spawnSync("bash", [lib, "--verify-staged", staged], {
        encoding: "utf8",
        env: { ...process.env, UNIT_RENDER_MANIFEST_FILE: manifest, ...extra },
      });

    // 1. RED: with no entry, an unresolvable dependency stays fatal -- and the
    //    message names the ledger, so the operator's next move is decidable.
    const unledgered = verify({ UNIT_DEPENDENCY_EXEMPTIONS_FILE: join(dir, "absent.tsv") });
    expect(unledgered.status, `an unledgered dependency was accepted:\n${unledgered.stdout}`).toBe(1);
    expect(unledgered.stderr).toContain("UNIT-VERIFY-FATAL");
    expect(unledgered.stderr).toContain("fixture-missing.service");
    expect(unledgered.stderr).toContain("absent.tsv");
    expect(unledgered.stdout).not.toContain("systemd-analyze accepted");

    // 2. GREEN: the declared pair is a NOTE, the evidence is echoed, and the
    //    render is verified rather than merely un-refused.
    writeFileSync(ledger, "fixture-dep.service\tfixture-missing.service\tfixture debt, named\n");
    const ledgered = verify({ UNIT_DEPENDENCY_EXEMPTIONS_FILE: ledger });
    expect(ledgered.status, ledgered.stderr).toBe(0);
    expect(ledgered.stderr).toContain("UNIT-VERIFY-NOTE");
    expect(ledgered.stderr).toContain("fixture debt, named");
    expect(ledgered.stderr).not.toContain("UNIT-VERIFY-FATAL");
    expect(ledgered.stdout).toContain("systemd-analyze accepted");

    // 3. Keyed on unit+required-unit, never on the unit alone: a DIFFERENT
    //    unresolvable dependency in an already-exempted template must not ride
    //    in on the first entry's justification. This is the round-2 defect of
    //    instance/unit-path-exemptions.tsv, not repeated. (One unit at a time:
    //    job creation stops at the first unresolvable requirement, so two
    //    missing dependencies in one unit produce one line, not two.)
    writeFileSync(
      join(staged, "fixture-dep.service"),
      "[Unit]\nDescription=fixture\nRequires=fixture-second.service\n\n[Service]\nType=oneshot\nExecStart=/bin/true\n",
    );
    const second = verify({ UNIT_DEPENDENCY_EXEMPTIONS_FILE: ledger });
    expect(second.status, "a new dangling dependency rode in on an existing entry").toBe(1);
    expect(second.stderr).toContain("fixture-second.service");
    expect(second.stderr).toContain("UNIT-VERIFY-FATAL");
    writeFileSync(
      join(staged, "fixture-dep.service"),
      "[Unit]\nDescription=fixture\nRequires=fixture-missing.service\n\n[Service]\nType=oneshot\nExecStart=/bin/true\n",
    );

    // 4. VISIBLE DEBT, the property that keeps this from being a mute button:
    //    an entry naming a unit this repository RENDERS is rejected, because
    //    that unit does resolve and a not-found for it is a real defect.
    writeFileSync(ledger, "fixture-dep.service\tbpa-orchestrator.service\tfixture\n");
    const stale = verify({ UNIT_DEPENDENCY_EXEMPTIONS_FILE: ledger });
    expect(stale.status, "an entry for a unit we render was accepted").toBe(1);
    expect(stale.stderr).toContain("UNIT-VERIFY-LEDGER-STALE");

    // 5. And the same test in the other direction: a row cannot outlive the
    //    template that justified it.
    writeFileSync(ledger, "departed.service\tfixture-missing.service\tfixture\n");
    const orphan = verify({ UNIT_DEPENDENCY_EXEMPTIONS_FILE: ledger });
    expect(orphan.status, "an entry for a unit we no longer render was accepted").toBe(1);
    expect(orphan.stderr).toContain("UNIT-VERIFY-LEDGER-STALE");

    // 6. Every other doubt fails closed, like check-unit-drift.sh's ledgers:
    //    a row without evidence, a file that exists but cannot be read, and a
    //    file that declares nothing at all.
    writeFileSync(ledger, "fixture-dep.service\tfixture-missing.service\t\n");
    expect(verify({ UNIT_DEPENDENCY_EXEMPTIONS_FILE: ledger }).stderr).toContain(
      "UNIT-VERIFY-LEDGER-INVALID",
    );
    const notAFile = join(dir, "ledger-dir");
    mkdirSync(notAFile);
    const unreadable = verify({ UNIT_DEPENDENCY_EXEMPTIONS_FILE: notAFile });
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toContain("UNIT-VERIFY-LEDGER-UNREADABLE");
    writeFileSync(ledger, "# nothing but a comment\n");
    expect(verify({ UNIT_DEPENDENCY_EXEMPTIONS_FILE: ledger }).stderr).toContain(
      "UNIT-VERIFY-LEDGER-EMPTY",
    );
    // A missing manifest cannot decide "does it resolve", so it refuses.
    writeFileSync(ledger, "fixture-dep.service\tfixture-missing.service\tfixture debt, named\n");
    const noManifest = verify({
      UNIT_DEPENDENCY_EXEMPTIONS_FILE: ledger,
      UNIT_RENDER_MANIFEST_FILE: join(dir, "no-manifest.tsv"),
    });
    expect(noManifest.status).toBe(1);
    expect(noManifest.stderr).toContain("UNIT-VERIFY-LEDGER-NO-MANIFEST");

    // 7. ANCHORING, the constraint B2 just closed one class over: a directive
    //    VALUE carrying the whole message shape -- with that exact pair
    //    ledgered -- must still be FATAL. systemd prefixes a directive
    //    complaint with its own `<file>:<line>:`, so laundered text can never
    //    reach the start of the line; the predicate is anchored at both ends
    //    and additionally requires the prefixed unit to be the unit whose job
    //    failed AND to be one of the staged files.
    const crafted = join(dir, "crafted");
    mkdirSync(crafted);
    writeFileSync(
      join(crafted, "fixture-dep.timer"),
      "[Timer]\nOnBootSec=2min\nOnCalendar=fixture-dep.service: Failed to create fixture-dep.service/start: Unit fixture-missing.service not found.\n",
    );
    const laundered = spawnSync("bash", [lib, "--verify-staged", crafted], {
      encoding: "utf8",
      env: {
        ...process.env,
        UNIT_RENDER_MANIFEST_FILE: manifest,
        UNIT_DEPENDENCY_EXEMPTIONS_FILE: ledger,
      },
    });
    expect(laundered.status, `a laundered value was accepted:\n${laundered.stdout}`).toBe(1);
    expect(laundered.stderr).toContain("UNIT-VERIFY-FATAL");
    expect(laundered.stdout).not.toContain("systemd-analyze accepted");

    // 8. B1 is untouched: a value that is PRESENT BUT INVALID is still fatal
    //    with a valid ledger in force. The ledger widens exactly one line
    //    class and nothing else.
    const empty = join(dir, "b1");
    mkdirSync(empty);
    writeFileSync(join(empty, "fixture-dep.timer"), "[Timer]\nOnCalendar=\n");
    const b1 = spawnSync("bash", [lib, "--verify-staged", empty], {
      encoding: "utf8",
      env: {
        ...process.env,
        UNIT_RENDER_MANIFEST_FILE: manifest,
        UNIT_DEPENDENCY_EXEMPTIONS_FILE: ledger,
      },
    });
    expect(b1.status, "an emptied OnCalendar stopped being fatal").toBe(1);
    expect(b1.stderr).toContain("UNIT-VERIFY-FATAL");

    // 9. The TRACKED ledger, against the TRACKED manifest, on whatever machine
    //    runs this. Validation happens on every verify -- not only where an
    //    entry would have been consulted -- so a stale row in the real file is
    //    caught here, on a host where postgresql.service exists and the line
    //    it exempts is never emitted.
    const good = join(dir, "good");
    mkdirSync(good);
    writeFileSync(join(good, "probe.timer"), "[Timer]\nOnCalendar=*-*-* 03:30:00\n");
    const tracked = spawnSync("bash", [lib, "--verify-staged", good], { encoding: "utf8" });
    expect(tracked.status, `the tracked dependency ledger is not valid:\n${tracked.stderr}`).toBe(0);
    expect(tracked.stderr).not.toContain("UNIT-VERIFY-LEDGER");
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
  //
  // The pattern must cover every form a real assignment takes. Round-2 review
  // (lens one, F1) found this guard and the equivalent one in
  // bootstrap.test.sh were accidental complements -- this one matched only
  // `NAME="${NAME:-`, that one only `NAME=${NAME:-`. Nothing escaped the pair,
  // but nobody designed the pair, and a guard whose coverage is a coincidence
  // is one edit away from covering nothing. Both now match both forms.
  const privateDefault = (name: string) =>
    new RegExp(`^\\s*(export\\s+)?${name}=["']?\\$\\{${name}:-`, "m");

  // Prove the pattern matches a real assignment before trusting it to find
  // none. A negative assertion and a broken regex look identical from here;
  // this is the exact historical install.sh line the guard exists to catch.
  expect(
    privateDefault("INSTALL_ROOT").test(
      'INSTALL_ROOT="${INSTALL_ROOT:-/root/bpa-dev-infrastructure}"',
    ),
    "the private-default pattern no longer matches a real assignment",
  ).toBe(true);
  expect(privateDefault("INSTALL_ROOT").test("INSTALL_ROOT=${INSTALL_ROOT:-/root/bpa}")).toBe(true);

  for (const script of [installer, driftChecker]) {
    const text = readFileSync(script, "utf8");
    expect(text).toContain("unit-render-lib.sh");
    for (const name of Object.keys(env)) {
      expect(
        privateDefault(name).test(text),
        `${script} carries its own default for ${name}`,
      ).toBe(false);
    }
  }
});

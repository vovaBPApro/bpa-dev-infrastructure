import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  check, manifest, normalize, probe, resolvePath, scanFile, snapshot, sweep,
  coveragePattern, selfExemption, SELF_WRITE_APIS,
  execTarget, observeUnits, scanUnits, unitManifest, deployedUnits,
} from "./check-host-state.ts";

const REPO = join(import.meta.dir, "..");
const temporaries: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bpa-host-state-${prefix}-`));
  temporaries.push(dir);
  return dir;
}
afterAll(() => { for (const dir of temporaries) rmSync(dir, { recursive: true, force: true }); });

// A miniature repository so the drift scan can be mutated without touching the
// real manifest. Same shape, four rows, one tracked writer.
function fixtureRepo(): string {
  const dir = scratch("repo");
  mkdirSync(join(dir, "instance"), { recursive: true });
  mkdirSync(join(dir, "daemon"), { recursive: true });
  writeFileSync(join(dir, "daemon/thing.ts"),
    "import { join } from 'node:path';\nconst DIR = join(homedir(), '.widget', 'state');\nconst LOG = '/var/log/widget';\n");
  writeFileSync(join(dir, "instance/host-state.tsv"), [
    "# id\tpath\twriter\tdisposition\tverify\tnote",
    "widget\t$HOME/.widget/state\tdaemon/thing.ts\tmust-survive\tbun tools/check-host-state.ts probe dir '$HOME/.widget/state'\tw",
    "widget-log\t/var/log/widget\tdaemon/thing.ts\trebuildable\tbun tools/check-host-state.ts probe dir /var/log/widget\tl",
  ].join("\n") + "\n");
  writeFileSync(join(dir, "instance/host-state-exclusions.tsv"), "# prefix\tscope\treason\n");
  for (const args of [["init", "-q"], ["add", "-A"]]) Bun.spawnSync(["git", "-C", dir, ...args]);
  return dir;
}

// A repository whose manifest describes a scratch directory, so the sweep can be
// pointed at a filesystem the test owns. Pointing it at the real /home or
// /var/lib would make the assertion depend on what happens to be installed,
// which is not a lock.
function sweepFixture(rows: string[], exclusions = ""): { repo: string; host: string; env: Record<string, string> } {
  const repo = scratch("sweep-repo");
  const host = scratch("sweep-host");
  mkdirSync(join(repo, "instance"), { recursive: true });
  writeFileSync(join(repo, "instance/host-state.tsv"),
    ["# id\tpath\twriter\tdisposition\tverify\tnote", ...rows].join("\n") + "\n");
  writeFileSync(join(repo, "instance/host-state-exclusions.tsv"), `# prefix\tscope\treason\n${exclusions}`);
  return { repo, host, env: { HOME: host } };
}

describe("path templates", () => {
  test("collapses a nested shell default to its variable", () => {
    // The exact spelling in meteorite/run.sh, whose inner `${HOME:?...}` used to
    // terminate the match in the wrong place and lose the path entirely.
    expect(normalize("${XDG_STATE_HOME:-${HOME:?HOME must be set}/.local/state}")).toBe("$XDG_STATE_HOME");
    expect(normalize("${XDG_CACHE_HOME:-$HOME/.cache}/infra-lanes")).toBe("$XDG_CACHE_HOME/infra-lanes");
  });

  test("refuses a template it cannot resolve rather than probing the wrong path", () => {
    expect(() => resolvePath("$NOT_A_KNOWN_VAR/x")).toThrow(/unresolvable/);
    expect(resolvePath("$HOME/.bun", { HOME: "/h" })).toBe("/h/.bun");
    expect(resolvePath("$XDG_CACHE_HOME/lanes", { HOME: "/h" })).toBe("/h/.cache/lanes");
  });
});

describe("drift scan", () => {
  test("reads join(homedir(), ...) as the path it builds", () => {
    expect(scanFile("d.ts", "const D = join(homedir(), '.claude', 'channels', 'telegram');"))
      .toContain("$HOME/.claude/channels/telegram");
  });

  // V3-0.28 was reopened because the reachability checker accepted a code
  // comment as an executor. A scan that reads prose reports state nobody writes.
  test("does not read a path out of a comment", () => {
    expect(scanFile("d.ts", "// state used to live in /var/lib/gone\nconst x = 1;")).toEqual([]);
    expect(scanFile("d.sh", "# see /var/lib/gone\nx=1\n")).toEqual([]);
  });

  test("ignores a bare home root, which is not a state location", () => {
    expect(scanFile("d.sh", 'env -i HOME="${HOME:-/nonexistent}" run\n')).toEqual([]);
  });

  test("the tracked manifest is currently clean", () => {
    expect(check(REPO)).toEqual([]);
  });

  // Red-before: the failure this checker exists to prevent, reproduced.
  test("a host path no row covers is rejected", () => {
    const dir = fixtureRepo();
    writeFileSync(join(dir, "daemon/thing.ts"),
      readFileSync(join(dir, "daemon/thing.ts"), "utf8") + "const NEW = '/var/lib/unenumerated-thing';\n");
    Bun.spawnSync(["git", "-C", dir, "add", "-A"]);
    expect(check(dir).join("\n")).toContain("unenumerated host state: /var/lib/unenumerated-thing");
  });

  test("deleting a row turns the path it covered into unenumerated state", () => {
    const dir = fixtureRepo();
    const rows = readFileSync(join(dir, "instance/host-state.tsv"), "utf8")
      .split("\n").filter((line) => !line.startsWith("widget-log")).join("\n");
    writeFileSync(join(dir, "instance/host-state.tsv"), rows);
    expect(check(dir).join("\n")).toContain("unenumerated host state: /var/log/widget");
  });

  // The reverse direction. Without it the manifest outlives the code it
  // describes, which is exactly how the mechanism inventory went stale.
  test("a row whose writer no longer names the path is rejected", () => {
    const dir = fixtureRepo();
    writeFileSync(join(dir, "daemon/thing.ts"), "const LOG = '/var/log/widget';\n");
    Bun.spawnSync(["git", "-C", dir, "add", "-A"]);
    expect(check(dir).join("\n")).toContain("writer no longer names this path: widget daemon/thing.ts");
  });

  test("an exclusion nothing names any more is rejected", () => {
    const dir = fixtureRepo();
    writeFileSync(join(dir, "instance/host-state-exclusions.tsv"), "/var/lib/long-gone\tsource\tstale excuse\n");
    expect(check(dir).join("\n")).toContain("orphan exclusion: /var/lib/long-gone");
  });

  test("an exclusion with an unknown scope is rejected", () => {
    const dir = fixtureRepo();
    writeFileSync(join(dir, "instance/host-state-exclusions.tsv"), "/var/log/widget\teverywhere\tvague\n");
    expect(check(dir).join("\n")).toContain("unknown exclusion scope: /var/log/widget everywhere");
  });

  test("a secret row may not use a probe that opens the file", () => {
    const dir = fixtureRepo();
    const rows = readFileSync(join(dir, "instance/host-state.tsv"), "utf8")
      .replace("must-survive\tbun tools/check-host-state.ts probe dir", "secret\tbun tools/check-host-state.ts probe dir");
    writeFileSync(join(dir, "instance/host-state.tsv"), rows);
    expect(check(dir).join("\n")).toContain("secret row must use a secret-file/secret-dir probe");
  });
});

// The direction round 1 did not have. Its forward scan read tracked sources
// only, so an unlisted file appearing on the host left the checker printing
// `HOST-STATE clean` -- the reviewer demonstrated it with a fixture under
// ~/.local/state and got exit 0. These are the locks for that.
describe("host sweep", () => {
  const ROW = "widget\t$HOME/widget\texternal:x\tmust-survive\tbun tools/check-host-state.ts probe dir '$HOME/widget'\tw";

  function run(fixture: ReturnType<typeof sweepFixture>) {
    return sweep(fixture.repo, fixture.env, [{ path: fixture.host, shared: false }]);
  }

  // The reviewer's own fixture, reproduced: an unlisted file appears under a
  // declared scan root and the checker must name it. This is the assertion that
  // would have failed against round 1.
  test("an unlisted path under a scan root is named and turns the sweep red", () => {
    const fixture = sweepFixture([ROW]);
    mkdirSync(join(fixture.host, "widget"), { recursive: true });
    expect(run(fixture).uncovered).toEqual([]);

    mkdirSync(join(fixture.host, "bpa-review-probe-fixture"), { recursive: true });
    writeFileSync(join(fixture.host, "bpa-review-probe-fixture/unlisted.db"), "x");
    const swept = run(fixture);
    expect(swept.uncovered).toEqual([join(fixture.host, "bpa-review-probe-fixture")]);
  });

  // Depth is bounded by the manifest, not by the filesystem: the finding is the
  // shallowest uncovered path, and an enumerated directory is not walked at all.
  test("names the shallowest uncovered path and does not descend into a covered one", () => {
    const fixture = sweepFixture([ROW]);
    mkdirSync(join(fixture.host, "widget/deep/deeper"), { recursive: true });
    writeFileSync(join(fixture.host, "widget/deep/deeper/inside"), "x");
    mkdirSync(join(fixture.host, "stray/a/b"), { recursive: true });
    expect(run(fixture).uncovered).toEqual([join(fixture.host, "stray")]);
  });

  // The trap this scope column exists for. `$XDG_STATE_HOME` is excused as a
  // SOURCE literal because meteorite/run.sh names the bare root; letting that
  // excuse reach the host would have hidden the reviewer's fixture, which sat
  // in exactly that directory.
  test("a source-scope exclusion does not excuse anything on the host", () => {
    const source = sweepFixture([ROW], "$HOME/stray\tsource\tnamed by a variable, not a location\n");
    mkdirSync(join(source.host, "widget"), { recursive: true });
    mkdirSync(join(source.host, "stray"), { recursive: true });
    expect(run(source).uncovered).toEqual([join(source.host, "stray")]);

    const host = sweepFixture([ROW], "$HOME/stray\thost\tthe distribution's, not ours\n");
    mkdirSync(join(host.host, "widget"), { recursive: true });
    mkdirSync(join(host.host, "stray"), { recursive: true });
    expect(run(host).uncovered).toEqual([]);
  });

  test("a host exclusion may use a glob, so per-run scratch needs no edit per run", () => {
    const fixture = sweepFixture([ROW], "$HOME/review-dispatch.*\thost\tper-run scratch\n");
    mkdirSync(join(fixture.host, "widget"), { recursive: true });
    for (const suffix of ["Y2ZaOL", "YWhfXn"]) mkdirSync(join(fixture.host, `review-dispatch.${suffix}`));
    mkdirSync(join(fixture.host, "review-dispatch-not-scratch"));
    expect(run(fixture).uncovered).toEqual([join(fixture.host, "review-dispatch-not-scratch")]);
  });

  // A host getting CLEANER must never turn the sweep red, or the operator
  // learns to ignore it. Stale excuses are reported so they can be pruned.
  test("a host exclusion that matches nothing is reported but does not fail", () => {
    const fixture = sweepFixture([ROW], "$HOME/never-existed\thost\tan excuse for nothing\n");
    mkdirSync(join(fixture.host, "widget"), { recursive: true });
    const swept = run(fixture);
    expect(swept.uncovered).toEqual([]);
    expect(swept.stale).toEqual(["$HOME/never-existed"]);
  });

  // The -wal and -shm are not files beside the database, they ARE the database.
  test("a sqlite row covers its own write-ahead sidecars", () => {
    const fixture = sweepFixture([
      "db\t$HOME/state.db\texternal:x\tmust-survive\tbun tools/check-host-state.ts probe sqlite '$HOME/state.db'\td",
    ]);
    for (const suffix of ["", "-wal", "-shm"]) writeFileSync(join(fixture.host, `state.db${suffix}`), "x");
    writeFileSync(join(fixture.host, "state.db.backup"), "x");
    expect(run(fixture).uncovered).toEqual([join(fixture.host, "state.db.backup")]);
  });

  test("under a shared root only this installation's own names are its business", () => {
    const fixture = sweepFixture([ROW]);
    for (const entry of ["dpkg", "apt", "bpa-authority", "agentic-bpa"]) mkdirSync(join(fixture.host, entry));
    const swept = sweep(fixture.repo, fixture.env, [{ path: fixture.host, shared: true }]);
    expect(swept.uncovered).toEqual([join(fixture.host, "agentic-bpa"), join(fixture.host, "bpa-authority")]);
  });

  test("segment anchoring: a pattern for bpa does not swallow bpa-authority", () => {
    expect(coveragePattern("/var/lib/bpa").test("/var/lib/bpa/x")).toBe(true);
    expect(coveragePattern("/var/lib/bpa").test("/var/lib/bpa-authority")).toBe(false);
    // An instance variable with no value here is one segment, not a failure:
    // the excuse is about whichever chat id this installation bound.
    const lock = coveragePattern("$HOME/.claude/orchestrator-chat-$BOUND_CHAT_ID.lock", { HOME: "/h" });
    expect(lock.test("/h/.claude/orchestrator-chat-83769716.lock")).toBe(true);
    expect(lock.test("/h/.claude/other.lock")).toBe(false);
  });

  // There is deliberately NO test asserting that this host's own sweep is
  // clean. The suite runs inside the landing gate, so such a test would put the
  // sweep back into the gate by the back door: any lane that dropped a file in
  // /root would redden an unrelated landing. The gate step is host-independent
  // on purpose. The live result belongs in the lane report as evidence.
});

// F-C. Round 1 used a raw NUL byte as the unresolved-variable sentinel, which
// made both sources binary to git: `git diff` emitted 173 bytes for a 20 KB
// file, so the canonical secret-scan command in verification-and-locks.md --
// a `git diff | grep` pipeline -- covered about 1% of the largest new file, and
// plain `grep` over the source silently returned nothing. NUL is the same byte
// that defeated V3-0.29's guard the same day.
describe("the sources stay text to git", () => {
  for (const file of ["tools/check-host-state.ts", "tools/check-host-state.test.ts"]) {
    test(`${file} contains no NUL or control bytes`, () => {
      const bytes = readFileSync(join(REPO, file));
      expect(bytes.includes(0)).toBe(false);
      // Anything else below space except tab/newline/carriage return would make
      // git call it binary too.
      expect([...bytes].filter((b) => b < 0x20 && b !== 9 && b !== 10 && b !== 13)).toEqual([]);
    });
  }

  test("git agrees both files are text", () => {
    for (const file of ["tools/check-host-state.ts", "tools/check-host-state.test.ts"]) {
      const result = Bun.spawnSync(["git", "-C", REPO, "diff", "--no-index", "--numstat", "/dev/null", file]);
      // A binary file reports "-\t-"; a text file reports a line count.
      expect(result.stdout.toString().startsWith("-\t-")).toBe(false);
    }
  });

  test("the sentinel still refuses a template it cannot resolve", () => {
    expect(() => resolvePath("$NOT_A_KNOWN_VAR/x")).toThrow(/unresolvable/);
  });
});

describe("probes fail on damaged state", () => {
  test("file: absent, empty, and wrong type all exit non-zero", () => {
    const dir = scratch("file");
    expect(probe("file", [join(dir, "missing")]).ok).toBe(false);
    writeFileSync(join(dir, "empty"), "");
    expect(probe("file", [join(dir, "empty")]).ok).toBe(false);
    expect(probe("file", [dir]).ok).toBe(false);
    writeFileSync(join(dir, "real"), "x");
    expect(probe("file", [join(dir, "real")]).ok).toBe(true);
  });

  test("dir: an empty directory is damage, not presence", () => {
    const dir = scratch("dir");
    mkdirSync(join(dir, "hollow"));
    expect(probe("dir", [join(dir, "hollow")]).ok).toBe(false);
    writeFileSync(join(dir, "hollow/x"), "x");
    expect(probe("dir", [join(dir, "hollow")]).ok).toBe(true);
  });

  test("secret-file: reports mode, never content, and rejects a readable mode", () => {
    const dir = scratch("secret");
    const file = join(dir, "cred");
    writeFileSync(file, "unique-marker-value");
    chmodSync(file, 0o644);
    const loose = probe("secret-file", [file]);
    expect(loose.ok).toBe(false);
    chmodSync(file, 0o600);
    const tight = probe("secret-file", [file]);
    expect(tight.ok).toBe(true);
    // The whole point of a secret-* probe: its output cannot leak the value.
    expect(`${loose.detail}${tight.detail}`).not.toContain("unique-marker-value");
  });

  test("ephemeral: absent is correct, an unreadable owner record is not", () => {
    const dir = scratch("lock");
    const lock = join(dir, "x.lock");
    expect(probe("ephemeral", [lock]).ok).toBe(true);
    writeFileSync(lock, "");
    writeFileSync(`${lock}.owner`, "provider_pid=17\n");
    expect(probe("ephemeral", [lock]).ok).toBe(true);
    writeFileSync(`${lock}.owner`, "\x00\x01 not a record");
    expect(probe("ephemeral", [lock]).ok).toBe(false);
  });

  // The probe for a live Hard Floor 5 breach. It fails while the path exists,
  // because the path existing IS the finding; a row that could only pass would
  // reduce three untracked fleet-recovery scripts to a footnote.
  test("exposure: fails while the path is there and clears itself when it is gone", () => {
    const dir = scratch("exposure");
    const script = join(dir, "orch-recover.sh");
    expect(probe("exposure", [script]).ok).toBe(true);
    writeFileSync(script, "#!/bin/sh\n");
    const live = probe("exposure", [script]);
    expect(live.ok).toBe(false);
    expect(live.detail).toContain(script);
    rmSync(script);
    expect(probe("exposure", [script]).ok).toBe(true);
  });

  // Damage a COPY, never the live database.
  test("sqlite: a truncated copy of the live state database is rejected", () => {
    const dir = scratch("db");
    const { Database } = require("bun:sqlite");
    const good = join(dir, "good.db");
    const db = new Database(good, { create: true });
    db.query("create table t (a int)").run();
    db.query("insert into t values (1)").run();
    db.close();
    expect(probe("sqlite", [good]).ok).toBe(true);

    const damaged = join(dir, "damaged.db");
    const bytes = readFileSync(good);
    writeFileSync(damaged, bytes.subarray(0, Math.floor(bytes.length / 2)));
    expect(probe("sqlite", [damaged]).ok).toBe(false);
    expect(probe("sqlite", [join(dir, "absent.db")]).ok).toBe(false);
  });
});

// The row this proves matters: the enumeration says the -wal is part of the
// database. If copying state.db alone were sufficient, that note would be noise.
describe("write-ahead log", () => {
  test("copying the .db alone loses committed rows that VACUUM INTO keeps", () => {
    const dir = scratch("wal");
    const { Database } = require("bun:sqlite");
    const source = join(dir, "state.db");
    const db = new Database(source, { create: true });
    db.query("pragma journal_mode = wal").get();
    db.query("create table lanes (id text)").run();
    db.query("insert into lanes values ('committed-before-checkpoint')").run();
    expect(existsSync(`${source}-wal`)).toBe(true);

    const naive = join(dir, "naive.db");
    copyFileSync(source, naive);          // the obvious, wrong backup
    const wal = join(dir, "snapshot.db");
    snapshot(source, wal);                // the correct one, taken while writes are live
    db.close();

    const rowsIn = (path: string) => {
      const copy = new Database(path, { readonly: true });
      try { return (copy.query("select count(*) c from lanes").get() as any).c; }
      catch { return "no such table"; }   // the schema itself was still in the -wal
      finally { copy.close(); }
    };
    // Worse than losing rows: the naive copy does not even have the table, so a
    // restore from it looks like a fresh install rather than a damaged one.
    expect(rowsIn(naive)).toBe("no such table");
    expect(rowsIn(wal)).toBe(1);
  });

  test("snapshot refuses to overwrite an existing destination", () => {
    const dir = scratch("wal-guard");
    const { Database } = require("bun:sqlite");
    const source = join(dir, "s.db");
    new Database(source, { create: true }).close();
    writeFileSync(join(dir, "taken.db"), "x");
    expect(() => snapshot(source, join(dir, "taken.db"))).toThrow(/destination exists/);
  });
});

describe("the manifest is the documentation", () => {
  test("every row's verify command is the command a reader would run", () => {
    for (const row of manifest(REPO)) {
      expect(row.verify.startsWith("bun tools/check-host-state.ts probe ")).toBe(true);
    }
  });

  // The checker exempts its own source from the drift scan because it declares
  // the scan roots. That exemption is only safe while every destination it can
  // write to arrives as an argument.
  test("the checker itself never becomes a writer of host state", () => {
    const source = readFileSync(join(REPO, "tools/check-host-state.ts"), "utf8");
    for (const api of SELF_WRITE_APIS) expect(source).not.toContain(`${api}(`);
    expect(selfExemption(source)).toEqual([]);
  });

  // F-D. Round 1 justified the exemption with the API list alone, but
  // `snapshot()` writes through sqlite, which no node API list can see -- so
  // "it cannot quietly become a writer" was already not quite true.
  test("the self-exemption catches a sqlite write that the API list cannot see", () => {
    expect(selfExemption('db.query("VACUUM INTO /var/lib/fixed.db").run();').join("\n"))
      .toContain("destination is not an argument");
    expect(selfExemption('db.query("VACUUM INTO ?").run(destination);')).toEqual([]);
    expect(selfExemption('writeFileSync(target, "x");').join("\n")).toContain("calls writeFileSync");
    // Prose about it is not it, for the same reason the drift scan strips
    // comments before looking for executors.
    expect(selfExemption("// VACUUM INTO takes a read transaction\n")).toEqual([]);
  });

  test("a row claiming an unresolved exposure must use the probe that reports one", () => {
    const dir = fixtureRepo();
    const rows = readFileSync(join(dir, "instance/host-state.tsv"), "utf8")
      .replace("must-survive\tbun tools/check-host-state.ts probe dir", "unresolved\tbun tools/check-host-state.ts probe dir");
    writeFileSync(join(dir, "instance/host-state.tsv"), rows);
    expect(check(dir).join("\n")).toContain("unresolved row must use an exposure probe");
  });

  test("no row carries a credential value, only a location", () => {
    const text = readFileSync(join(REPO, "instance/host-state.tsv"), "utf8");
    for (const row of manifest(REPO)) expect(row.verify).not.toContain("=");
    // Long unbroken high-entropy-looking runs are what a pasted credential looks
    // like in a manifest of paths and prose.
    expect(text).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
  });
});

// ── Deployed systemd units ────────────────────────────────────────────────────
//
// The blind spot round 2 shipped with. Every scan it had read either tracked
// sources or the filesystem, and an armed root timer firing every ten minutes is
// visible to neither: the unit file is a config file like any other and the fact
// that makes it matter -- that systemd will run it again after a reboot -- lives
// in the unit graph. These lock the direction, not the specific finding.

// A scratch unit directory, so an assertion never depends on what this host
// happens to have deployed.
function unitDir(units: Record<string, string>, wants: Record<string, string[]> = {}): string {
  const dir = scratch("units");
  for (const [name, body] of Object.entries(units)) writeFileSync(join(dir, name), body);
  for (const [target, links] of Object.entries(wants)) {
    mkdirSync(join(dir, target), { recursive: true });
    for (const link of links) symlinkSync(join(dir, link), join(dir, target, link));
  }
  return dir;
}

function unitRepo(rows: string[], templates: string[] = []): string {
  const dir = scratch("unit-repo");
  mkdirSync(join(dir, "instance"), { recursive: true });
  mkdirSync(join(dir, "bootstrap/units"), { recursive: true });
  for (const template of templates) writeFileSync(join(dir, `bootstrap/units/${template}.in`), "rendered\n");
  writeFileSync(join(dir, "instance/host-units.tsv"),
    ["# unit\tmanager\tstate\texec\tdisposition\tnote", ...rows].join("\n") + "\n");
  return dir;
}

const NUDGE_TIMER = "[Timer]\nOnCalendar=*:0/10\n\n[Install]\nWantedBy=timers.target\n";
const NUDGE_SERVICE = "[Service]\nType=oneshot\nExecStart=/root/.local/bin/orch-fleet-nudge.sh\n";

describe("ExecStart targets", () => {
  test("an interpreter wrapper resolves through to the script it runs", () => {
    // Recording /usr/bin/bash would enumerate the distribution's shell instead
    // of the untracked script that is the actual finding.
    expect(execTarget("[Service]\nExecStart=/usr/bin/bash /root/orch-fleet-nudge.sh apply\n"))
      .toBe("/root/orch-fleet-nudge.sh");
  });

  test("a bare program is its own target", () => {
    expect(execTarget(NUDGE_SERVICE)).toBe("/root/.local/bin/orch-fleet-nudge.sh");
  });

  test("systemd's prefix characters are syntax, not part of the path", () => {
    expect(execTarget("[Service]\nExecStart=-+/opt/thing.sh\n")).toBe("/opt/thing.sh");
  });

  test("an interpreter with nothing after it IS the target", () => {
    expect(execTarget("[Service]\nExecStart=/usr/local/bin/bun\n")).toBe("/usr/local/bin/bun");
  });

  test("ExecStartPre is not ExecStart", () => {
    expect(execTarget("[Service]\nExecStartPre=/opt/pre.sh\nExecStart=/opt/main.sh\n")).toBe("/opt/main.sh");
  });

  test("a unit with no ExecStart reports none", () => {
    expect(execTarget(NUDGE_TIMER)).toBe("-");
  });
});

describe("armed is derived from the unit graph, not from is-active", () => {
  test("a wants symlink arms a unit and its absence does not", () => {
    const dir = unitDir(
      { "armed.service": "[Service]\nExecStart=/bin/true\n", "idle.service": "[Service]\nExecStart=/bin/true\n" },
      { "multi-user.target.wants": ["armed.service"] },
    );
    const observed = observeUnits(dir);
    expect(observed.get("armed.service")?.state).toBe("armed");
    expect(observed.get("idle.service")?.state).toBe("installed");
  });

  test("an armed timer arms the static service it activates", () => {
    // orch-fleet-nudge.service exactly: `static`, so is-enabled calls it neither
    // enabled nor disabled, and it runs every ten minutes regardless. A checker
    // that read is-enabled would have called this one installed.
    const dir = unitDir(
      { "orch-fleet-nudge.timer": NUDGE_TIMER, "orch-fleet-nudge.service": NUDGE_SERVICE },
      { "timers.target.wants": ["orch-fleet-nudge.timer"] },
    );
    expect(observeUnits(dir).get("orch-fleet-nudge.service")?.state).toBe("armed");
  });

  test("an explicit Unit= is followed instead of the basename default", () => {
    const dir = unitDir(
      { "a.timer": "[Timer]\nUnit=b.service\n", "b.service": "[Service]\nExecStart=/bin/true\n" },
      { "timers.target.wants": ["a.timer"] },
    );
    expect(observeUnits(dir).get("b.service")?.state).toBe("armed");
  });

  test("a disabled timer does not arm its service", () => {
    const dir = unitDir({ "orch-fleet-nudge.timer": NUDGE_TIMER, "orch-fleet-nudge.service": NUDGE_SERVICE });
    expect(observeUnits(dir).get("orch-fleet-nudge.service")?.state).toBe("installed");
  });

  test("a symlink into the distribution is not a unit deployed here", () => {
    // /etc/systemd/system is full of them -- that is systemd's enable
    // mechanism. Following them would drag ~200 distro units into an
    // enumeration that is about this installation.
    const dir = unitDir({ "real.service": "[Service]\nExecStart=/bin/true\n" });
    const distro = join(scratch("distro"), "far.service");
    writeFileSync(distro, "[Service]\nExecStart=/bin/true\n");
    symlinkSync(distro, join(dir, "far.service"));
    expect(deployedUnits(dir).map((u) => u.unit)).toEqual(["real.service"]);
  });
});

describe("the units scan", () => {
  const armedNudge = () => unitDir(
    { "orch-fleet-nudge.timer": NUDGE_TIMER, "orch-fleet-nudge.service": NUDGE_SERVICE },
    { "timers.target.wants": ["orch-fleet-nudge.timer"] },
  );
  const at = (dir: string) => [{ path: dir, manager: "system" }];

  test("an armed unit with no row is UNLISTED -- the round-2 blind spot", () => {
    const repo = unitRepo(["other.service\tsystem\tinstalled\t/bin/true\torphan\tn"]);
    const result = scanUnits(repo, process.env, at(armedNudge()));
    expect(result.unlisted).toEqual(expect.arrayContaining([
      expect.stringContaining("system/orch-fleet-nudge.timer"),
      expect.stringContaining("system/orch-fleet-nudge.service"),
    ]));
  });

  test("a row calling an armed unit installed is DRIFT", () => {
    // The V3-0.28 failure: an enumeration asserting a distinction it does not
    // hold is worse than no enumeration, because it reads as checked.
    const repo = unitRepo([
      "orch-fleet-nudge.timer\tsystem\tinstalled\t-\tunresolved\tn",
      "orch-fleet-nudge.service\tsystem\tarmed\t/root/.local/bin/orch-fleet-nudge.sh\tunresolved\tn",
    ]);
    const result = scanUnits(repo, process.env, at(armedNudge()));
    expect(result.drift).toEqual([expect.stringContaining("state: manifest says installed, host says armed")]);
  });

  test("a changed ExecStart is DRIFT", () => {
    const repo = unitRepo([
      "orch-fleet-nudge.timer\tsystem\tarmed\t-\tunresolved\tn",
      "orch-fleet-nudge.service\tsystem\tarmed\t/root/.local/bin/moved.sh\tunresolved\tn",
    ]);
    expect(scanUnits(repo, process.env, at(armedNudge())).drift)
      .toEqual([expect.stringContaining("exec: manifest says /root/.local/bin/moved.sh")]);
  });

  test("`rebuildable` without a tracked template is DRIFT", () => {
    // The delegation bootstrap/check-unit-drift.sh never made. `rebuildable` is
    // an affirmative claim that a rebuild reproduces the unit; the claim is only
    // true if something tracked renders it.
    const repo = unitRepo([
      "orch-fleet-nudge.timer\tsystem\tarmed\t-\trebuildable\tn",
      "orch-fleet-nudge.service\tsystem\tarmed\t/root/.local/bin/orch-fleet-nudge.sh\trebuildable\tn",
    ]);
    const result = scanUnits(repo, process.env, at(armedNudge()));
    expect(result.drift).toEqual(expect.arrayContaining([
      expect.stringContaining("rebuildable but no tracked template"),
    ]));
  });

  test("a template makes `rebuildable` true and `unresolved` stale", () => {
    const rows = [
      "orch-fleet-nudge.timer\tsystem\tarmed\t-\trebuildable\tn",
      "orch-fleet-nudge.service\tsystem\tarmed\t/root/.local/bin/orch-fleet-nudge.sh\trebuildable\tn",
    ];
    const templates = ["orch-fleet-nudge.timer", "orch-fleet-nudge.service"];
    expect(scanUnits(unitRepo(rows, templates), process.env, at(armedNudge())).drift).toEqual([]);
    // And the reverse: a row still claiming `unresolved` once a template exists
    // is a row nobody retired.
    const resolved = rows.map((row) => row.replace("rebuildable", "unresolved"));
    expect(scanUnits(unitRepo(resolved, templates), process.env, at(armedNudge())).drift)
      .toEqual(expect.arrayContaining([expect.stringContaining("the row is stale, resolve it")]));
  });

  test("an armed unit whose ExecStart target is gone is reported", () => {
    // bpa-db-network-boundary.service on this host: enabled, RemainAfterExit so
    // it still reads `active`, and its script went away with a reaped lane
    // worktree. It cannot run again, and a reboot would not reapply the boundary.
    const dir = unitDir(
      { "boundary.service": "[Service]\nExecStart=/usr/bin/bash /gone/db-network-boundary.sh apply\n" },
      { "multi-user.target.wants": ["boundary.service"] },
    );
    const repo = unitRepo(["boundary.service\tsystem\tarmed\t/gone/db-network-boundary.sh\torphan\tn"]);
    expect(scanUnits(repo, process.env, at(dir)).drift)
      .toEqual([expect.stringContaining("is armed but its ExecStart target does not exist")]);
  });

  test("a known-unresolved breach stays out of DRIFT", () => {
    // DRIFT means the manifest is wrong and someone must fix it; UNRESOLVED
    // means the manifest is right and the host has a breach awaiting a decision.
    // Folding the second into the first is how a permanently-red check stops
    // being read, and then real drift arrives into noise nobody looks at.
    const dir = unitDir(
      { "boundary.service": "[Service]\nExecStart=/gone/db-network-boundary.sh\n" },
      { "multi-user.target.wants": ["boundary.service"] },
    );
    const repo = unitRepo(["boundary.service\tsystem\tarmed\t/gone/db-network-boundary.sh\tunresolved\tundecided"]);
    const result = scanUnits(repo, process.env, at(dir));
    expect(result.drift).toEqual([]);
    expect(result.unresolved).toEqual([expect.stringContaining("exec-target-absent=/gone/db-network-boundary.sh")]);
  });

  test("a row for a unit that is gone is reported, never failed", () => {
    // Same contract as the sweep's stale exclusions: a host getting CLEANER must
    // never turn a check red, or the operator learns to ignore it.
    const repo = unitRepo(["retired.service\tsystem\tarmed\t/bin/true\torphan\tn"]);
    const result = scanUnits(repo, process.env, at(unitDir({})));
    expect(result.stale).toEqual(["system/retired.service"]);
    expect(result.unlisted).toEqual([]);
    expect(result.drift).toEqual([]);
  });
});

describe("this installation's own unit enumeration", () => {
  test("the manifest lints and every row is decidable", () => {
    expect(check(REPO)).toEqual([]);
    for (const row of unitManifest(REPO)) {
      expect(["armed", "installed"]).toContain(row.state);
      expect(["rebuildable", "unresolved", "orphan", "off-scope"]).toContain(row.disposition);
      expect(row.note.trim().length).toBeGreaterThan(0);
    }
  });

  test("the armed root timer that operates this fleet is named", () => {
    // The round-2 finding, locked. This row existing is what makes the
    // difference between an enumeration and a claim of one.
    const rows = unitManifest(REPO);
    const timer = rows.find((row) => row.unit === "orch-fleet-nudge.timer" && row.manager === "system");
    expect(timer).toBeDefined();
    expect(timer!.state).toBe("armed");
    expect(timer!.disposition).toBe("unresolved");
    const service = rows.find((row) => row.unit === "orch-fleet-nudge.service" && row.manager === "system");
    expect(service!.exec).toBe("/root/.local/bin/orch-fleet-nudge.sh");
    expect(service!.state).toBe("armed");
  });

  test("no `rebuildable` row claims a template this repository does not carry", () => {
    for (const row of unitManifest(REPO).filter((r) => r.disposition === "rebuildable")) {
      const templates = [`bootstrap/units/${row.unit}.in`, `instance/units/${row.unit}.in`];
      expect(templates.some((path) => existsSync(join(REPO, path)))).toBe(true);
    }
  });
});

#!/usr/bin/env bun
// Hard Floor 5 says host state that must NOT be in git is enumerated instead --
// "not in git is never allowed to mean not written down". This is the mechanism
// that keeps that enumeration true. It does three separable jobs:
//
//   (default)  manifest lint + drift scan   -- repository-level, runs in the gate
//   --sweep    walk the real filesystem     -- host-level, needs the real machine
//   --verify   run every row's own command  -- host-level, needs the real machine
//   probe ...  the primitive those commands call
//
// The two scans answer two DIFFERENT questions and neither substitutes for the
// other. Round 1 of this row shipped only the first and described it as though
// it were the second, which is the failure this file is now built around:
//
//   drift scan  "does the tracked code write anywhere the manifest does not
//               name?"  Reads sources only. Deterministic, host-independent,
//               and therefore the one the landing gate runs.
//   sweep       "does anything exist on this host that the manifest does not
//               name?"  Reads the filesystem only. It is the only one that can
//               see state written by something untracked -- an improvised
//               script, the agent harness, a person -- and that is exactly the
//               state Hard Floor 5 warns gets left behind.
//
// A checker that answers "is anything here unaccounted for?" by reading only
// the repository cannot answer it. The drift scan is the part that fails closed
// in the gate; the sweep is the part that fails closed on the host.
//
// The drift scan strips comments first: V3-0.28 was reopened because the
// reachability checker accepted a code comment as an executor, and a detector
// that reads prose is not a detector.
import { existsSync, readFileSync, statSync, readdirSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

const NAME = "HOST-STATE";

export type Row = {
  id: string; path: string; writer: string; disposition: string; verify: string; note: string;
};

const DISPOSITIONS = new Set([
  "must-survive", // a rebuild without it loses information that exists nowhere else
  "rebuildable",  // bootstrap/install.sh regenerates it from tracked sources
  "ephemeral",    // must NOT be restored; restoring it resurrects a dead owner
  "secret",       // location and permissions are enumerated, content never is
  "off-host",     // durable somewhere other than this machine
  "orphan",       // present or expected, but nothing active depends on it here
  // Present on this host, operates or records the fleet, and is in neither git
  // nor a decision. Hard Floor 5 forbids the state, so the row's job is to make
  // the decision visible rather than absent: `probe exposure` FAILS while the
  // path exists and passes once it is gone. A row that can only pass would
  // reduce a floor breach to a footnote.
  "unresolved",
]);

// Scan scope. A path outside these roots is not host state this repository is
// responsible for: /usr and /bin belong to the distribution, and /tmp does not
// survive a reboot, so by construction it cannot hold state a rebuild restores.
// That boundary is deliberate and is the honest limit of both scans.
const SCAN_ROOTS = [
  "$HOME", "$XDG_STATE_HOME", "$XDG_CACHE_HOME", "$XDG_DATA_HOME",
  "/root", "/home", "/var/lib", "/var/log", "/var/spool/cron", "/etc/systemd",
];

// Sweep scope, which is NOT the same shape as the drift scan's scope even
// though it walks the same roots.
//
//   owned   this installation is the only thing that puts state here, so
//           anything uncovered is a finding.
//   shared  the distribution also lives here. Listing every distro directory
//           would be ~95 lines that go stale on the next `apt upgrade` and
//           teach the operator to ignore red, so the boundary is declared once
//           as a name claim instead: under a shared root, state belonging to
//           this installation is identifiable by name.
//
// The cost of the claim is stated in instance/host-state.md: a future BPA
// directory under a shared root that is NOT named for it stays invisible.
const OWNED_SWEEP_ROOTS = ["$HOME", "/home"];
const SHARED_SWEEP_ROOTS = ["/var/lib", "/var/log", "/var/spool/cron", "/etc/systemd"];
const INSTALLATION_CLAIM = /(?:^|[-_.])bpa(?:$|[-_.])/;

// A bare root is a home directory being passed around, not a state location.
// Enumerating one would make every path beneath it covered, which is the
// opposite of what this scan is for. The XDG roots are exempt: naming
// `$XDG_STATE_HOME` IS a declaration that state lives there.
const BARE_ROOTS = new Set(["$HOME", "/root", "/home", "/var/lib", "/var/log", "/var/spool/cron", "/etc/systemd"]);

// The filesystem-write APIs this file must never acquire. Its own source is
// exempt from the drift scan, and this list is half of what keeps that
// exemption true; `selfExemption()` is where both halves are enforced.
export const SELF_WRITE_APIS = ["writeFileSync", "appendFileSync", "mkdirSync", "Bun.write", "createWriteStream"];

// The sentinel `resolvePath` leaves behind for a variable it has no value for.
// Deliberately NOT a NUL byte: round 1 used one, which made this file binary to
// git -- so `git diff` emitted 173 bytes for 20 KB and the canonical
// secret-scan command in verification-and-locks.md, which is a `git diff | grep`
// pipeline, covered ~1% of it. Plain `grep` over the source silently returned
// nothing too. NUL is the same byte that defeated V3-0.29's guard the same day;
// it is treated here as a known adversary rather than a convenient marker.
const UNRESOLVED = "<unresolved:";

// The token a coverage pattern uses for a segment it cannot resolve, so a
// template like `.../orchestrator-chat-$BOUND_CHAT_ID.lock` still matches the
// one file this host actually bound. Plain text on purpose, per UNRESOLVED.
const WILDCARD = "<any-one-segment>";

function fail(message: string): never {
  throw new Error(`${NAME} ${message}`);
}

function read(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { fail(`unreadable file: ${path}`); }
}

function rows(path: string, columns: number, allowEmpty = false): string[][] {
  const parsed = read(path).split("\n").filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("\t"));
  // An empty exclusions file is the good state: nothing has needed an excuse.
  if (parsed.length === 0 && !allowEmpty) fail(`empty manifest: ${path}`);
  for (const row of parsed) {
    if (row.length !== columns || row.some((v) => !v.trim())) fail(`malformed row: ${row.join("\\t")}`);
  }
  return parsed;
}

export function manifest(repo: string): Row[] {
  return rows(join(repo, "instance/host-state.tsv"), 6)
    .map(([id, path, writer, disposition, verify, note]) => ({ id, path, writer, disposition, verify, note }));
}

// ── Path templates ────────────────────────────────────────────────────────────

// `${XDG_CACHE_HOME:-$HOME/.cache}/infra-lanes` and `$XDG_CACHE_HOME/infra-lanes`
// are the same location written two ways. Reduce both to the second form so the
// manifest states each location once.
export function normalize(raw: string): string {
  // The default may itself contain a `${...}`, as in
  // `${XDG_STATE_HOME:-${HOME:?...}/.local/state}`, so one level of nesting has
  // to be consumed or the inner brace ends the match in the wrong place.
  let path = raw.replace(/\$\{([A-Z_]+)(?::[-?](?:\$\{[^{}]*\}|[^{}])*)?\}/g, "$$$1");
  path = path.replace(/[}:,'")\]]+$/, "").replace(/\/+$/, "");
  return path;
}

// `unknown` decides what happens to a `$VAR` this host has no value for.
// Probing must refuse it -- probing the wrong path is worse than not probing.
// Coverage matching substitutes a wildcard instead, because an exclusion for
// `orchestrator-chat-$BOUND_CHAT_ID.lock` is a statement about whichever chat
// id this installation bound, not about a literal that has to exist.
export function resolvePath(
  path: string,
  env: Record<string, string | undefined> = process.env,
  unknown: "fail" | "wildcard" = "fail",
): string {
  const home = env.HOME || homedir();
  const defaults: Record<string, string> = {
    HOME: home,
    XDG_STATE_HOME: env.XDG_STATE_HOME || join(home, ".local/state"),
    XDG_CACHE_HOME: env.XDG_CACHE_HOME || join(home, ".cache"),
    XDG_DATA_HOME: env.XDG_DATA_HOME || join(home, ".local/share"),
    INSTALL_ROOT: env.ORCH_INSTALL_ROOT || env.INSTALL_ROOT || join(home, "bpa-dev-infrastructure"),
    SYSTEMD_SYSTEM_DIR: env.SYSTEMD_SYSTEM_DIR || "/etc/systemd/system",
  };
  const resolved = path.replace(/\$([A-Z_]+)/g,
    (_, name) => defaults[name] ?? (unknown === "wildcard" ? WILDCARD : `${UNRESOLVED}${name}`));
  if (resolved.includes(UNRESOLVED)) fail(`unresolvable path template: ${path}`);
  if (!isAbsolute(resolved)) fail(`path template did not resolve to an absolute path: ${path}`);
  return resolved;
}

// Prefix match on whole path segments, so `/var/lib/bpa` never swallows
// `/var/lib/bpa-authority`.
function covers(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

// ── Sweep coverage ────────────────────────────────────────────────────────────

// A resolved template turned into a segment-anchored matcher. `*` in an
// exclusion prefix and any unresolvable `$VAR` both become "one path segment",
// which is what lets a single line cover `review-dispatch.Y2ZaOL` and its
// successors without the file needing an edit every time a lane runs.
export function coveragePattern(template: string, env: Record<string, string | undefined> = process.env): RegExp {
  const resolved = resolvePath(normalize(template), env, "wildcard");
  const body = resolved.split(WILDCARD).map((part) =>
    part.split("*").map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"),
  ).join("[^/]*");
  // Anchored at a segment boundary for the same reason `covers` is: a pattern
  // for `/var/lib/bpa` must not swallow `/var/lib/bpa-authority`.
  return new RegExp(`^${body}(?:/|$)`);
}

// A sqlite row covers its own sidecars. The -wal and -shm are not files beside
// the database, they ARE the database -- the same reasoning that makes `cp` the
// wrong backup makes them the wrong sweep finding.
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"];

// ── Drift scan ────────────────────────────────────────────────────────────────

function stripComments(file: string, text: string): string {
  if (file.endsWith(".ts")) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((line) => !/^\s*(\/\/|\*)/.test(line)).join("\n");
  }
  return text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
}

const LITERAL = /(?:\$\{?HOME\}?|\$\{?XDG_[A-Z_]+(?::[-?](?:\$\{[^{}]*\}|[^{}])*)?\}?|\/root|\/home|\/var\/lib|\/var\/log|\/var\/spool\/cron|\/etc\/systemd)(?:\/[A-Za-z0-9._$\-]+)*/g;
// `join(homedir(), '.claude', 'channels', 'telegram')` is the same statement as
// the literal `$HOME/.claude/channels/telegram`; a scan that reads only literals
// would miss every path the daemon builds, which is most of them.
const HOMEDIR_JOIN = /join\(\s*homedir\(\)\s*,\s*((?:'[^']*'|"[^"]*")(?:\s*,\s*(?:'[^']*'|"[^"]*"))*)/g;

export function scanFile(file: string, text: string): string[] {
  const stripped = stripComments(file, text);
  const found = new Set<string>();
  for (const match of stripped.matchAll(LITERAL)) {
    const path = normalize(match[0]);
    if (!BARE_ROOTS.has(path) && SCAN_ROOTS.some((root) => covers(root, path))) found.add(path);
  }
  for (const match of stripped.matchAll(HOMEDIR_JOIN)) {
    const parts = [...match[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
    found.add(normalize(["$HOME", ...parts].join("/")));
  }
  return [...found].sort();
}

function scannedFiles(repo: string): string[] {
  const tracked = Bun.spawnSync(["git", "-C", repo, "ls-files", "-z", "*.ts", "*.sh", "*.in"])
    .stdout.toString().split("\0").filter(Boolean);
  return tracked.filter((file) =>
    !file.includes(".test.") && !file.includes("/testdata/") &&
    !file.startsWith("tests/") && !file.startsWith("vendor/") && !file.startsWith("instance/parked/") &&
    // This file DECLARES the scan roots; it does not write to them. Scanning it
    // would demand an enumeration row for the vocabulary of the enumeration.
    // The exemption is not taken on trust -- `selfExemption()` re-derives it.
    file !== SELF);
}

const SELF = "tools/check-host-state.ts";

// The exemption above, enforced rather than asserted, and stated at the width
// that is actually true (F-D).
//
// Round 1 said the exemption was safe because this file "cannot quietly become
// a writer", backed by SELF_WRITE_APIS alone. That was already false when it
// was written: `snapshot()` writes a file through `VACUUM INTO ?`, a filesystem
// write that no node API list can see. The guarantee that does hold is
// narrower -- every destination this file can write to arrives as an argument
// -- so the second clause below is the one that carries it: a `VACUUM INTO`
// whose destination is anything other than the bound `?` breaks the exemption.
//
// Comments are stripped first for the same reason the drift scan strips them:
// prose about VACUUM INTO is not a VACUUM INTO.
export function selfExemption(source: string): string[] {
  const errors: string[] = [];
  const body = stripComments(SELF, source);
  for (const api of SELF_WRITE_APIS) {
    if (body.includes(`${api}(`)) errors.push(`self-exemption broken: ${SELF} calls ${api}`);
  }
  if (/VACUUM INTO\s+(?!\?)/.test(body)) {
    // Worded without the literal on purpose: this string is part of the body
    // the check above reads, so spelling the forbidden form here would make the
    // checker report itself forever.
    errors.push(`self-exemption broken: ${SELF} has a sqlite vacuum whose destination is not an argument`);
  }
  return errors;
}

export type Exclusion = { prefix: string; scope: string; reason: string };

// `source` and `host` exclusions excuse two different things and confusing them
// is how round 1's blind spot would come back. `$XDG_STATE_HOME` is excused as a
// SOURCE literal -- meteorite/run.sh names the bare root and composes the real
// path from a variable. Letting that excuse reach the host sweep would make the
// whole of ~/.local/state invisible, which is precisely where the reviewer's
// unlisted fixture sat.
const SCOPES = new Set(["source", "host", "both"]);

export function exclusions(repo: string): Exclusion[] {
  return rows(join(repo, "instance/host-state-exclusions.tsv"), 3, true)
    .map(([prefix, scope, reason]) => ({ prefix: normalize(prefix), scope, reason }));
}

export function check(repo: string): string[] {
  const errors: string[] = [];
  const manifestRows = manifest(repo);
  const exclusionRows = exclusions(repo);
  for (const row of exclusionRows) {
    if (!SCOPES.has(row.scope)) errors.push(`unknown exclusion scope: ${row.prefix} ${row.scope}`);
  }
  const sourceExclusions = new Map(exclusionRows
    .filter((row) => row.scope !== "host").map((row) => [row.prefix, row.reason]));
  // Fixture repositories in the tests have no copy of this file; the real one
  // always does, and `instance/required-mechanisms.tsv` is what keeps it there.
  if (existsSync(join(repo, SELF))) errors.push(...selfExemption(read(join(repo, SELF))));

  const ids = new Set<string>();
  const paths: string[] = [];
  for (const row of manifestRows) {
    if (ids.has(row.id)) errors.push(`duplicate id: ${row.id}`);
    ids.add(row.id);
    if (!DISPOSITIONS.has(row.disposition)) errors.push(`unknown disposition: ${row.id} ${row.disposition}`);
    const path = normalize(row.path);
    if (path !== row.path) errors.push(`path is not in normal form: ${row.id} (use ${path})`);
    if (!SCAN_ROOTS.some((root) => covers(root, path)) && row.disposition !== "off-host") {
      errors.push(`path outside the declared scan roots: ${row.id} ${row.path}`);
    }
    paths.push(path);
    // A row without a runnable command has not discharged the obligation: the
    // whole point of the enumeration is that each entry can be checked.
    if (!row.verify.includes("check-host-state.ts")) {
      errors.push(`verify command does not call this checker: ${row.id}`);
    }
    if (row.disposition === "secret" && !/\bprobe\s+secret-(file|dir)\b/.test(row.verify)) {
      // A `file` probe on a credential would report its size and mode through a
      // path that has no rule against reading it. secret-* probes never open.
      errors.push(`secret row must use a secret-file/secret-dir probe: ${row.id}`);
    }
    // Same shape as the secret rule, for the same reason: the disposition is a
    // claim about the row, and only one probe makes that claim decidable. An
    // `unresolved` row wired to `probe optional` would report a floor breach as
    // "absent (acceptable for this row)".
    if (row.disposition === "unresolved" && !/\bprobe\s+exposure\b/.test(row.verify)) {
      errors.push(`unresolved row must use an exposure probe: ${row.id}`);
    }
  }

  // The unit manifest is linted here, at repository level, so the landing gate
  // validates its shape. WHICH units are deployed is a host question and stays in
  // `--units`, for the same reason the sweep is not in the gate: the gate also
  // lands synthetic fixture repositories that have no installation.
  if (existsSync(join(repo, "instance/host-units.tsv"))) {
    const units = new Set<string>();
    for (const row of unitManifest(repo)) {
      const key = `${row.manager}/${row.unit}`;
      if (units.has(key)) errors.push(`duplicate unit row: ${key}`);
      units.add(key);
      if (!UNIT_SUFFIX.test(row.unit)) errors.push(`not a unit name: ${key}`);
      if (!["system", "user"].includes(row.manager)) errors.push(`unknown unit manager: ${key}`);
      if (!UNIT_STATES.has(row.state)) errors.push(`unknown unit state: ${key} ${row.state}`);
      if (!UNIT_DISPOSITIONS.has(row.disposition)) {
        errors.push(`unknown unit disposition: ${key} ${row.disposition}`);
      }
      if (row.exec !== NO_EXEC && !isAbsolute(resolvePath(normalize(row.exec), process.env, "wildcard"))) {
        errors.push(`unit exec is not an absolute path: ${key} ${row.exec}`);
      }
    }
  }

  // Forward direction: every host path tracked code writes must be enumerated.
  const observed = new Map<string, string[]>();
  for (const file of scannedFiles(repo)) {
    for (const path of scanFile(file, read(join(repo, file)))) {
      if (!observed.has(path)) observed.set(path, []);
      observed.get(path)!.push(file);
    }
  }
  for (const [path, files] of [...observed].sort()) {
    const enumerated = paths.some((prefix) => covers(prefix, path));
    const excluded = [...sourceExclusions.keys()].some((prefix) => covers(prefix, path));
    if (!enumerated && !excluded) {
      errors.push(`unenumerated host state: ${path} written by ${files.join(",")}`);
    }
  }

  // Reverse direction: a row naming tracked writers must still be reachable from
  // them. Without this the manifest survives the deletion of the code it
  // describes, which is exactly how the mechanism inventory went stale (V3-0.42).
  for (const row of manifestRows) {
    if (row.writer.startsWith("external:")) continue;
    const path = normalize(row.path);
    for (const writer of row.writer.split(",").map((w) => w.trim())) {
      if (!existsSync(join(repo, writer))) { errors.push(`row names a missing writer: ${row.id} ${writer}`); continue; }
      const scanned = scanFile(writer, read(join(repo, writer)));
      if (!scanned.some((found) => covers(path, found) || covers(found, path))) {
        errors.push(`writer no longer names this path: ${row.id} ${writer}`);
      }
    }
  }

  // A source-scope excuse may not outlive the code that justified it. Host-scope
  // excuses are checked by the sweep instead, against the filesystem, because
  // that is the thing they make a claim about.
  for (const prefix of sourceExclusions.keys()) {
    if (![...observed.keys()].some((path) => covers(prefix, path))) {
      errors.push(`orphan exclusion: ${prefix}`);
    }
  }
  return errors;
}

// ── Host sweep ────────────────────────────────────────────────────────────────

// The direction round 1 did not have: start at the filesystem and ask what is
// not accounted for. Everything above reads tracked sources, so state written by
// an improvised script, the agent harness or a person was invisible BY
// CONSTRUCTION and no mode of this tool reported it.
//
// The walk is bounded by the manifest's own shape rather than by depth or size,
// which is what keeps it cheap over a 1.6G lane root:
//
//   covered by a row/exclusion  -> stop, do not descend (that is the answer)
//   a row lives beneath it      -> descend (the answer is further down)
//   otherwise                   -> report it, do not descend
//
// So a finding is named at the shallowest path that is uncovered: `/root/.ssh`
// is one line, not four hundred.

export type Sweep = { uncovered: string[]; stale: string[]; roots: string[] };

function sweepRoots(env: Record<string, string | undefined>): { path: string; shared: boolean }[] {
  const seen = new Set<string>();
  const roots: { path: string; shared: boolean }[] = [];
  for (const [group, shared] of [[OWNED_SWEEP_ROOTS, false], [SHARED_SWEEP_ROOTS, true]] as const) {
    for (const template of group) {
      // $HOME and /root are the same directory here; walking it twice would
      // report every finding twice.
      const path = resolvePath(template, env);
      if (seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      roots.push({ path, shared });
    }
  }
  return roots;
}

export function sweep(
  repo: string,
  env: Record<string, string | undefined> = process.env,
  // Tests pass a scratch root here. Without it a test would walk this machine's
  // real /home and /var/lib and pass or fail on what happens to be installed,
  // which is the opposite of a lock.
  rootOverride?: { path: string; shared: boolean }[],
): Sweep {
  const manifestRows = manifest(repo);
  const covering: RegExp[] = [];
  const rowPaths: string[] = [];
  for (const row of manifestRows) {
    if (row.disposition === "off-host") continue;   // not on this filesystem to find
    const resolved = resolvePath(normalize(row.path), env, "wildcard");
    rowPaths.push(resolved);
    covering.push(coveragePattern(row.path, env));
    if (/\bprobe\s+sqlite\b/.test(row.verify) || /\.(db|sqlite3?)$/.test(resolved)) {
      for (const suffix of SQLITE_SIDECARS) covering.push(coveragePattern(`${row.path}${suffix}`, env));
    }
  }

  const hostExclusions = exclusions(repo).filter((row) => row.scope !== "source");
  const excluding = hostExclusions.map((row) => ({ row, pattern: coveragePattern(row.prefix, env) }));
  const matched = new Set<string>();

  const covered = (path: string) => {
    if (covering.some((pattern) => pattern.test(path))) return true;
    for (const { row, pattern } of excluding) {
      if (pattern.test(path)) { matched.add(row.prefix); return true; }
    }
    return false;
  };
  // Descend only where an enumerated location actually lives, so depth is
  // bounded by the manifest rather than by the filesystem.
  const leadsToRow = (path: string) => rowPaths.some((row) => row.startsWith(`${path}/`));

  const uncovered: string[] = [];
  const roots = rootOverride ?? sweepRoots(env);
  const walk = (dir: string, shared: boolean): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }   // unreadable is not a finding about state
    for (const entry of entries.sort()) {
      const path = join(dir, entry);
      if (covered(path)) continue;
      if (leadsToRow(path)) { walk(path, shared); continue; }
      // Under a shared root the distribution's own directories are not this
      // installation's business; the claim is the declared boundary.
      if (shared && !INSTALLATION_CLAIM.test(entry)) continue;
      uncovered.push(path);
    }
  };
  for (const root of roots) walk(root.path, root.shared);

  // A host excuse that matches nothing is reported, not failed. The fail-closed
  // direction is uncovered state; a host getting CLEANER must never turn the
  // sweep red, or the operator learns to ignore it -- and these prefixes name
  // per-run scratch that legitimately comes and goes.
  const stale = hostExclusions.filter((row) => !matched.has(row.prefix)).map((row) => row.prefix);
  return { uncovered: uncovered.sort(), stale, roots: roots.map((root) => root.path) };
}

// ── Deployed systemd units ────────────────────────────────────────────────────

// The direction NOTHING tracked answered before this. bootstrap/check-unit-drift.sh
// loops `for template in "$dir"/*.in` -- it asks "is every TRACKED unit deployed
// and identical?" and never enumerates what is deployed. So a unit that exists on
// this host and has no template is invisible to it, and the host-state.tsv
// `systemd-dir` row used to delegate the question to it anyway.
//
// It is invisible no longer, and the counter-example is why this mode exists:
// orch-fleet-nudge.timer is enabled, fires every ten minutes as root, and its
// ExecStart is /root/.local/bin/orch-fleet-nudge.sh, which is in no template, no
// tracked file, and no decision. The fleet's own stall detector is one meteorite
// from gone. A filesystem walk could not see it either -- finding it needs the
// unit graph, not a directory listing.
//
// ARMED vs INSTALLED is the distinction the workboard claimed elsewhere and could
// not back (V3-0.28). It is derived from the filesystem, not from `systemctl`, so
// it is testable against a scratch tree and means the thing Hard Floor 5 asks
// about: `armed` = a .wants/.requires symlink survives a reboot and runs this.
// `is-active` is deliberately NOT the definition -- a unit active now but not
// enabled does not come back, and one enabled but inactive does.

export type Unit = {
  unit: string; manager: string; state: string; exec: string; disposition: string; note: string;
};

const UNIT_STATES = new Set(["armed", "installed"]);
const UNIT_DISPOSITIONS = new Set([
  "rebuildable", // rendered from a tracked template; the template must exist
  "unresolved",  // deployed here, operates the fleet, in neither git nor a decision
  "orphan",      // deployed, nothing here depends on it
  "off-scope",   // belongs to the v2 PRODUCT, not to this control plane
]);

// `-` is the recorded exec for a unit that has no ExecStart of its own, which is
// every timer: what a timer runs is its Unit=, and that service has its own row.
const NO_EXEC = "-";

// A wrapper is not the target. `ExecStart=/usr/bin/bash /root/.local/bin/foo.sh`
// is a statement about foo.sh, and recording /usr/bin/bash would enumerate the
// distribution's shell instead of the untracked script that is the finding.
const INTERPRETERS = new Set(["bash", "sh", "dash", "env", "bun", "node", "python", "python3"]);

export function unitManifest(repo: string): Unit[] {
  return rows(join(repo, "instance/host-units.tsv"), 6)
    .map(([unit, manager, state, exec, disposition, note]) => ({ unit, manager, state, exec, disposition, note }));
}

// systemd's prefix characters (`-` ignore-failure, `@` argv0, `+`/`!`/`!!`
// privilege) are syntax, not part of the path.
function stripExecPrefix(token: string): string {
  return token.replace(/^[-+!@:]+/, "");
}

export function execTarget(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("ExecStart="));
  if (!line) return NO_EXEC;
  const tokens = line.slice("ExecStart=".length).trim().split(/\s+/).filter(Boolean);
  let fallback = NO_EXEC;
  for (const [index, token] of tokens.entries()) {
    const bare = stripExecPrefix(token);
    if (!bare.startsWith("/")) continue;
    if (fallback === NO_EXEC) fallback = bare;
    // An interpreter followed by something is a wrapper; keep looking for what
    // it runs. An interpreter with nothing after it IS the target.
    if (INTERPRETERS.has(bare.split("/").pop() ?? "") && index + 1 < tokens.length) continue;
    return bare;
  }
  return fallback;
}

// What a .timer/.socket/.path activates: its explicit Unit=, else the same
// basename as a .service. orch-fleet-nudge.timer takes the default, which is
// exactly how a `static` service ends up running every ten minutes.
function activatedUnit(text: string, unit: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("Unit="));
  if (line) return line.slice("Unit=".length).trim();
  return unit.replace(/\.(timer|socket|path)$/, ".service");
}

const UNIT_SUFFIX = /\.(service|timer|socket|path|mount)$/;

// Real files only. A symlink in /etc/systemd/system points into the
// distribution's own unit directory -- that is systemd's enable mechanism, not a
// unit deployed here, and following it would drag ~200 distro units into an
// enumeration that is about this installation.
export function deployedUnits(dir: string): { unit: string; text: string }[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const found: { unit: string; text: string }[] = [];
  for (const entry of entries.sort()) {
    if (!UNIT_SUFFIX.test(entry)) continue;
    const path = join(dir, entry);
    try { if (!lstatSync(path).isFile()) continue; } catch { continue; }
    found.push({ unit: entry, text: read(path) });
  }
  return found;
}

// Enabled = systemd's own record of it, which is a symlink under a
// <target>.wants/ or <target>.requires/ directory. Reading the graph rather than
// asking systemctl is what lets a test build one in a scratch directory.
function enabledUnits(dir: string): Set<string> {
  const enabled = new Set<string>();
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return enabled; }
  for (const entry of entries) {
    if (!/\.(wants|requires)$/.test(entry)) continue;
    try { for (const link of readdirSync(join(dir, entry))) enabled.add(link); } catch { /* unreadable */ }
  }
  return enabled;
}

export type Observed = { state: string; exec: string };

export function observeUnits(dir: string): Map<string, Observed> {
  const files = deployedUnits(dir);
  const enabled = enabledUnits(dir);
  const armed = new Set(files.map((f) => f.unit).filter((unit) => enabled.has(unit)));
  // Propagate through activation: a `static` service with no [Install] section
  // is armed exactly when something armed activates it.
  for (const { unit, text } of files) {
    if (!armed.has(unit) || !/\.(timer|socket|path)$/.test(unit)) continue;
    armed.add(activatedUnit(text, unit));
  }
  const observed = new Map<string, Observed>();
  for (const { unit, text } of files) {
    observed.set(unit, { state: armed.has(unit) ? "armed" : "installed", exec: execTarget(text) });
  }
  return observed;
}

// The unit directories this installation is responsible for. /lib/systemd/system
// is the distribution's and is deliberately out of scope, exactly as /usr is for
// the sweep. The user manager's directory is IN scope because on this host it
// holds this installation's own units.
export function unitDirs(env: Record<string, string | undefined> = process.env): { path: string; manager: string }[] {
  const home = env.HOME || homedir();
  return [
    { path: env.SYSTEMD_SYSTEM_DIR || "/etc/systemd/system", manager: "system" },
    { path: join(home, ".config/systemd/user"), manager: "user" },
  ];
}

// A `rebuildable` unit's template, which is the claim that row makes.
function trackedTemplate(repo: string, unit: string): string | null {
  for (const dir of ["bootstrap/units", "instance/units"]) {
    const path = join(dir, `${unit}.in`);
    if (existsSync(join(repo, path))) return path;
  }
  return null;
}

export type UnitScan = {
  unlisted: string[]; drift: string[]; unresolved: string[]; stale: string[]; dirs: string[];
};

export function scanUnits(
  repo: string,
  env: Record<string, string | undefined> = process.env,
  dirOverride?: { path: string; manager: string }[],
): UnitScan {
  const manifestRows = unitManifest(repo);
  const dirs = (dirOverride ?? unitDirs(env)).filter((dir) => existsSync(dir.path));
  const byKey = new Map(manifestRows.map((row) => [`${row.manager}/${row.unit}`, row]));
  const seen = new Set<string>();
  const unlisted: string[] = [];
  const drift: string[] = [];
  const unresolved: string[] = [];

  for (const dir of dirs) {
    for (const [unit, observation] of observeUnits(dir.path)) {
      const key = `${dir.manager}/${unit}`;
      seen.add(key);
      const row = byKey.get(key);
      if (!row) { unlisted.push(`${key} state=${observation.state} exec=${observation.exec}`); continue; }
      // A row that records the wrong state is worse than no row: it is the
      // V3-0.28 failure, an enumeration asserting a distinction it does not hold.
      if (row.state !== observation.state) {
        drift.push(`${key} state: manifest says ${row.state}, host says ${observation.state}`);
      }
      if (row.exec === NO_EXEC) {
        if (observation.exec !== NO_EXEC) {
          drift.push(`${key} exec: manifest says none, host says ${observation.exec}`);
        }
      } else if (!coveragePattern(row.exec, env).test(observation.exec)) {
        drift.push(`${key} exec: manifest says ${resolvePath(normalize(row.exec), env, "wildcard")}`
          + `, host says ${observation.exec}`);
      }
      // The delegation bootstrap/check-unit-drift.sh never made: a `rebuildable`
      // unit must actually have a template, or "rendered from tracked sources" is
      // an assertion about a rebuild that would not reproduce it.
      const template = trackedTemplate(repo, unit);
      if (row.disposition === "rebuildable" && !template) {
        drift.push(`${key} rebuildable but no tracked template under bootstrap/units or instance/units`);
      }
      if (row.disposition === "unresolved" && template) {
        drift.push(`${key} unresolved but ${template} exists -- the row is stale, resolve it`);
      }
      // An armed unit whose ExecStart is not on this filesystem cannot run.
      //
      // For an `unresolved` row that is part of the standing finding, so it rides
      // on the UNRESOLVED line rather than DRIFT. The split matters: DRIFT means
      // the manifest is WRONG and someone must fix it, UNRESOLVED means the
      // manifest is right and the host has a breach awaiting a decision. Folding
      // the second into the first is how a permanently-red check stops being read
      // -- and then a genuinely new drift arrives into noise nobody looks at.
      const broken = observation.state === "armed" && observation.exec !== NO_EXEC
        && !existsSync(observation.exec);
      if (broken && row.disposition !== "unresolved") {
        drift.push(`${key} is armed but its ExecStart target does not exist: ${observation.exec}`);
      }
      if (row.disposition === "unresolved") {
        unresolved.push(`${key} state=${observation.state}`
          + `${broken ? ` exec-target-absent=${observation.exec}` : ""} -- ${row.note.split(".")[0]}`);
      }
    }
  }
  // Same contract as the sweep's stale exclusions: a host getting cleaner is
  // reported, never failed.
  const stale = manifestRows.filter((row) => !seen.has(`${row.manager}/${row.unit}`))
    .map((row) => `${row.manager}/${row.unit}`);
  return { unlisted, drift, unresolved, stale, dirs: dirs.map((d) => d.path) };
}

// ── Probes ────────────────────────────────────────────────────────────────────

// Every probe exits non-zero when the state is absent or damaged. That is the
// whole contract; a probe that can only pass is decoration.
type ProbeResult = { ok: boolean; detail: string };

function ownerOnly(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function probeSqlite(path: string): ProbeResult {
  if (!existsSync(path)) return { ok: false, detail: "absent" };
  const { Database } = require("bun:sqlite");
  let db: any;
  try { db = new Database(path, { readonly: true }); }
  catch (error) { return { ok: false, detail: `unopenable: ${String(error).slice(0, 80)}` }; }
  try {
    const integrity = db.query("pragma integrity_check").get()?.integrity_check;
    if (integrity !== "ok") return { ok: false, detail: `integrity_check=${integrity}` };
    const tables = db.query("select count(*) c from sqlite_master where type='table'").get()?.c ?? 0;
    if (tables === 0) return { ok: false, detail: "no tables" };
    // The write-ahead log is part of the database, not a stray file beside it.
    // A backup that copies state.db alone loses every committed transaction
    // still in the -wal; `snapshot` below is the correct primitive.
    const wal = existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
    return { ok: true, detail: `tables=${tables} wal-bytes=${wal}` };
  } catch (error) {
    return { ok: false, detail: `unreadable: ${String(error).slice(0, 80)}` };
  } finally { try { db?.close(); } catch {} }
}

export function probe(kind: string, args: string[]): ProbeResult {
  // `cron-block` and `git-refs` take a marker and a remote pattern, not a path,
  // so resolution is per-kind rather than up front.
  const path = ["cron-block", "git-refs"].includes(kind) ? "" : resolvePath(args[0] ?? "");
  switch (kind) {
    case "file": {
      if (!existsSync(path)) return { ok: false, detail: "absent" };
      const stat = statSync(path);
      if (!stat.isFile()) return { ok: false, detail: "not a regular file" };
      if (stat.size === 0) return { ok: false, detail: "empty" };
      return { ok: true, detail: `bytes=${stat.size}` };
    }
    case "dir": {
      if (!existsSync(path)) return { ok: false, detail: "absent" };
      if (!statSync(path).isDirectory()) return { ok: false, detail: "not a directory" };
      const entries = readdirSync(path).length;
      if (entries === 0) return { ok: false, detail: "empty" };
      return { ok: true, detail: `entries=${entries}` };
    }
    // secret-* never open the file. They prove it is present and that nobody
    // else can read it, which is all a credential's enumeration row may claim.
    case "secret-file": {
      if (!existsSync(path)) return { ok: false, detail: "absent" };
      const stat = statSync(path);
      if (!stat.isFile()) return { ok: false, detail: "not a regular file" };
      if (stat.size === 0) return { ok: false, detail: "empty" };
      if (!ownerOnly(stat.mode)) return { ok: false, detail: `mode ${(stat.mode & 0o777).toString(8)} is group/world readable` };
      return { ok: true, detail: `mode=${(stat.mode & 0o777).toString(8)}` };
    }
    case "secret-dir": {
      if (!existsSync(path)) return { ok: false, detail: "absent" };
      const stat = statSync(path);
      if (!stat.isDirectory()) return { ok: false, detail: "not a directory" };
      if (!ownerOnly(stat.mode)) return { ok: false, detail: `mode ${(stat.mode & 0o777).toString(8)} is group/world readable` };
      if (readdirSync(path).length === 0) return { ok: false, detail: "empty" };
      return { ok: true, detail: `mode=${(stat.mode & 0o777).toString(8)}` };
    }
    case "sqlite": return probeSqlite(path);
    // An ephemeral lock is correct when absent. It is damaged when it is present
    // and unreadable, which is the state that wedges a restart.
    case "ephemeral": {
      if (!existsSync(path)) return { ok: true, detail: "absent (correct for ephemeral state)" };
      // Two owner-record formats are in use: daemon/file-lock.ts writes JSON,
      // orchestrator/launch.sh writes key=value lines. Either is readable; an
      // owner record that is neither is the wedged state worth reporting.
      const owner = `${path}.owner`;
      if (existsSync(owner) && statSync(owner).size > 0) {
        const text = readFileSync(owner, "utf8");
        const parseable = (() => { try { JSON.parse(text); return true; } catch { return false; } })()
          || text.split("\n").some((line) => /^[A-Za-z_][A-Za-z0-9_]*=.+$/.test(line));
        if (!parseable) return { ok: false, detail: `owner record is not parseable: ${owner}` };
      }
      return { ok: true, detail: "present and parseable" };
    }
    // For `orphan` rows absence is the expected reading, so absence cannot be
    // the failure. Damage still is: something present and empty or unreadable is
    // worse than something missing, because a restore would silently accept it.
    case "optional": {
      if (!existsSync(path)) return { ok: true, detail: "absent (acceptable for this row)" };
      const stat = statSync(path);
      if (stat.isDirectory()) {
        return readdirSync(path).length > 0
          ? { ok: true, detail: `present entries=${readdirSync(path).length}` }
          : { ok: false, detail: "present but empty" };
      }
      return stat.size > 0 ? { ok: true, detail: `present bytes=${stat.size}` } : { ok: false, detail: "present but empty" };
    }
    // The probe for a `unresolved` row. It fails while the path exists, because
    // the path existing IS the finding: a fleet script or a secret backup that
    // is in neither git nor a decision is a live Hard Floor 5 breach, and the
    // enumeration's job is to keep saying so until someone decides. It clears
    // itself when the path is gone, so resolving the row needs no edit here.
    case "exposure": {
      if (!existsSync(path)) return { ok: true, detail: "resolved (no longer on this host)" };
      return { ok: false, detail: `unresolved Hard Floor 5 exposure, decision pending: ${path}` };
    }
    case "cron-block": {
      const marker = args[0] ?? "";
      const cron = Bun.spawnSync([process.env.CRONTAB_CMD || "crontab", "-l"]);
      const text = cron.stdout.toString();
      return text.includes(marker)
        ? { ok: true, detail: "managed block present" }
        : { ok: false, detail: `managed block "${marker}" absent from crontab` };
    }
    case "git-refs": {
      const [repo, pattern] = args;
      const result = Bun.spawnSync(["git", "-C", repo, "ls-remote", "origin", pattern]);
      const count = result.stdout.toString().split("\n").filter(Boolean).length;
      return count > 0 ? { ok: true, detail: `refs=${count}` } : { ok: false, detail: `no refs match ${pattern}` };
    }
    default: fail(`unknown probe kind: ${kind}`);
  }
}

// ── WAL-correct sqlite snapshot ───────────────────────────────────────────────

// Backup and restore are V3-2.10's row. This is only the primitive that row
// needs and the proof that the obvious alternative is wrong: `VACUUM INTO`
// takes a read transaction, so the destination contains every committed
// transaction including the ones still living in the -wal. `cp state.db` does
// not, and tools/check-host-state.test.ts demonstrates the loss.
export function snapshot(source: string, destination: string): void {
  const { Database } = require("bun:sqlite");
  if (existsSync(destination)) fail(`snapshot destination exists: ${destination}`);
  const db = new Database(source, { readonly: true });
  try { db.query("VACUUM INTO ?").run(destination); }
  finally { db.close(); }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function verifyAll(repo: string, only: string | null): number {
  const manifestRows = manifest(repo).filter((row) => !only || row.id === only);
  if (only && manifestRows.length === 0) fail(`no such row: ${only}`);
  let failed = 0;
  for (const row of manifestRows) {
    const result = Bun.spawnSync(["bash", "-c", row.verify], { cwd: repo });
    const ok = result.exitCode === 0;
    if (!ok) failed += 1;
    const detail = (result.stdout.toString() + result.stderr.toString()).trim().split("\n").at(-1) ?? "";
    console.log(`${NAME} ${ok ? "ok  " : "FAIL"} ${row.id} disposition=${row.disposition} ${detail}`);
  }
  console.log(`${NAME} verify rows=${manifestRows.length} failed=${failed}`);
  return failed;
}

function sweepAll(repo: string): number {
  const result = sweep(repo);
  for (const prefix of result.stale) console.log(`${NAME} sweep stale-exclusion ${prefix}`);
  for (const path of result.uncovered) console.log(`${NAME} sweep UNLISTED ${path}`);
  // `unresolved` rows are counted on the summary line on purpose. `unlisted=0`
  // alone reads as "this host is fine", and on a host where an enumerated but
  // undecided Hard Floor 5 breach is standing, that reading is false. The
  // headline number may never again be silent about it.
  const open = manifest(repo).filter((row) => row.disposition === "unresolved").length;
  console.log(`${NAME} sweep roots=${result.roots.length} unlisted=${result.uncovered.length} stale=${result.stale.length} unresolved=${open}`);
  return result.uncovered.length;
}

function unitsAll(repo: string): number {
  const result = scanUnits(repo);
  for (const unit of result.stale) console.log(`${NAME} units stale-row ${unit}`);
  for (const line of result.unresolved) console.log(`${NAME} units UNRESOLVED ${line}`);
  for (const line of result.drift) console.log(`${NAME} units DRIFT ${line}`);
  for (const line of result.unlisted) console.log(`${NAME} units UNLISTED ${line}`);
  const failed = result.unlisted.length + result.drift.length + result.unresolved.length;
  console.log(`${NAME} units dirs=${result.dirs.length} unlisted=${result.unlisted.length} drift=${result.drift.length} unresolved=${result.unresolved.length} stale=${result.stale.length}`);
  return failed;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = flag("--repo") ?? process.cwd();
  try {
    if (argv[0] === "probe") {
      const result = probe(argv[1], argv.slice(2));
      console.log(`${NAME} probe ${argv[1]} ${result.ok ? "ok" : "FAIL"} ${result.detail}`);
      process.exit(result.ok ? 0 : 1);
    }
    if (argv[0] === "snapshot") {
      snapshot(argv[1], argv[2]);
      console.log(`${NAME} snapshot ok ${argv[2]}`);
      process.exit(0);
    }
    if (argv.includes("--sweep")) process.exit(sweepAll(repo) === 0 ? 0 : 1);
    if (argv.includes("--units")) process.exit(unitsAll(repo) === 0 ? 0 : 1);
    if (argv.includes("--verify")) {
      const only = flag("--only") ?? null;
      let failed = verifyAll(repo, only);
      // `--verify` is the host-level mode, so it owes the host-level question
      // too: rows that are false AND state that has no row AND units that no
      // filesystem walk can see. `--only` narrows to one row deliberately, so it
      // does not drag the whole host scan along.
      if (!only) failed += sweepAll(repo) + unitsAll(repo);
      process.exit(failed === 0 ? 0 : 1);
    }
    const errors = check(repo);
    if (errors.length) fail(errors.join(`\n${NAME} `));
    console.log(`${NAME} clean`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

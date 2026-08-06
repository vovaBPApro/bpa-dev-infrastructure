#!/usr/bin/env bun

// The bare-world verify: re-run a lane's OWN declared `verify:` once more, in a
// deliberately hostile-but-honest environment, at lane-exit time instead of at
// landing time (instance/workboard.md V3-5.42).
//
// Why this exists, measured on 2026-08-06 -- three lanes in one day whose tests
// were green in the lane and red the moment something else ran them:
//
//   1. V3-5.34: a test needing `permission-denied` passed at the lane's umask
//      0022 and failed under the orchestrator's `umask 077`, because at 077
//      `git worktree add` creates a 0700 worktree the sweeping uid cannot
//      traverse (/root/.cache/infra-lanes/v3-5.34-r2.report.md names it).
//   2. V3-5.39: a test asserted THIS host's configured passphrase file,
//      `/root/.config/bpa/backup-passphrase`. The rebuilt container has no
//      `/root/.config/bpa` at all, so it failed instantly.
//   3. V3-5.25: new tests green locally, red in the meteorite's clean clone.
//
// Each cost a full landing attempt -- roughly ten minutes of gate plus a
// meteorite rebuild -- to learn something a second verify run could have said
// in one verify's worth of time. So this runs the same command twice: once the
// way gate/completion-guard.ts already does, and once with the ambient host
// state subtracted.
//
// WHAT IS SUBTRACTED (and nothing else -- the world must stay honest, or every
// hermetic lane pays for a harness that is merely hostile):
//
//   - the working tree           -> a fresh `git clone` at the report's SHA, so
//                                   only TRACKED content exists (case 3);
//   - the ambient environment    -> `env -i` with PATH/HOME/XDG/TMPDIR only, so
//                                   no lane, orchestrator or shell variable
//                                   survives into the child;
//   - $HOME and the XDG dirs     -> empty directories inside the throwaway
//                                   world, plus an empty tmpfs mounted over the
//                                   REAL ones inside a mount namespace, so an
//                                   absolute path into the operator's config
//                                   dirs is absent rather than merely unnamed
//                                   (case 2);
//   - a permissive umask         -> `umask 077` (case 1).
//
// WHAT IS PROVIDED, because a clean clone on a clean host has it: the checkout,
// a PATH holding the same trusted verifiers the landing gate resolves
// (gate/land-lib.sh land_resolve_bun -> LAND_CHECK_PATH), git, and a writable
// empty HOME and TMPDIR. This is a subtractive harness, never an additive one:
// it adds no variable of its own (not even CI=1) so that a failure here can
// only ever mean "the verify read host state", never "the harness changed the
// rules".
//
// NO CLEARANCE WITHOUT THE SUBTRACTION. The mask is the only one of the four
// subtractions that catches an absolute path into the operator's config dirs --
// case 2 above, and the lock at gate/bare-world.test.sh proves it is the mask
// and not some other subtraction that catches it. So a run that did not mask
// cannot clear the step: it exits 2 naming the missing capability, exactly as a
// failed verify does. It does NOT print `fidelity=reduced` and pass, which is
// what the first round of this row did and what its review rejected -- a
// harness built to end silent environmental passes must not contain one. The
// only way past it is a DECLARATION in the terminal report, per
// instructions/lane-capabilities.md, which is durable and reviewable:
//
//     bare-world: capability=mount-namespace reason=<why>   (no usable namespace)
//     bare-world: capability=maskable-home  reason=<why>    (nothing to mask)
//
// A test affordance may not mint that clearance either: when this host DOES
// have a usable namespace and INFRA_TEST_FORCE_MISSING_CAPABILITIES asks the
// harness to pretend otherwise, no declaration is honoured -- the refusal is
// unconditional (see maskingDecision).
//
// The residual boundary, stated rather than hidden: the verify runs as the same
// uid, so a uid-specific behaviour is NOT reproduced, and the bare run carries
// no timeout of its own, so a verify that hangs only here hangs the lane exit
// (parity with gate/completion-guard.ts's own unbounded run).
//
// Exit codes:
//   0  the verify survived the bare world, or the run does not apply, or the
//      lane DECLARED the host capability its verify needs
//   2  refused: the verify needs ambient host state it did not declare, or the
//      world could not perform the host-state subtraction at all, with the
//      environmental delta or the missing capability named

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fieldValues, lineValue } from "./report-contract";

// Same literal fallback as gate/land-lib.sh's trusted baseline, used ONLY when
// the gate has not already resolved one. gate/lane-exit.sh calls
// land_resolve_bun before invoking this harness, so in the wiring that matters
// the value below is never reached -- LAND_CHECK_PATH is.
const FALLBACK_TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin";

// Variables gate/land-lib.sh EXPORTS into whatever invoked the gate. Removed
// from the control run for the same reason gate/completion-guard.ts removes
// them: a verify that re-enters a gate entry point dies on
// `caller-bun-override-refused` and the refusal is refusing its own parent. The
// bare run never sees them at all -- `env -i` is stricter than this list.
const GATE_RESOLUTION_EXPORTS = ["BUN_BIN", "LAND_CHECK_PATH"] as const;

// Masking a system directory would not make a world bare, it would make it
// broken; refusing by name keeps a mis-set HOME from taking /usr with it.
const UNMASKABLE = new Set([
  "/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/opt", "/proc",
  "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var",
]);

// The capabilities a report may declare, and what each declaration BUYS. Its
// contract lives in instructions/lane-capabilities.md; this is the executable
// half. The two kinds are not interchangeable and one may never stand in for
// the other:
//
//   failure   the verify legitimately needs host state a clean clone on a clean
//             host does not have, so a bare-world FAILURE is accepted (and
//             still named).
//   fidelity  the environment cannot perform one of the subtractions, so a run
//             at reduced fidelity may CLEAR. It accepts no failure whatsoever.
const DECLARABLE_CAPABILITIES = new Map<string, "failure" | "fidelity">([
  ["host-state", "failure"],
  ["network", "failure"],
  ["docker", "failure"],
  ["service-ops", "failure"],
  ["mount-namespace", "fidelity"],
  ["maskable-home", "fidelity"],
]);

type Options = { report: string; repo: string };

function usage(exitCode = 2): never {
  const output = exitCode === 0 ? process.stdout : process.stderr;
  output.write(
    [
      "Usage: bun gate/bare-world.ts --report <file> --repo <path>",
      "",
      "Re-runs the report's declared `verify:` in a scrubbed, cloned, umask-077",
      "world with the host's HOME and XDG dirs masked.",
      "",
      "Exit codes:",
      "  0 survived the bare world / not applicable / declared capability",
      "  2 refused, with the environmental delta named",
    ].join("\n") + "\n",
  );
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Options {
  let report: string | undefined;
  let repo: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--report" || arg === "--repo") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage();
      if (arg === "--report") report = value;
      else repo = value;
      index += 1;
      continue;
    }
    usage();
  }
  if (!report || !repo) usage();
  return { report: resolve(report), repo: resolve(repo) };
}

function say(line: string): void {
  console.log(`BARE-WORLD ${line}`);
}

function refuse(lines: string[]): never {
  for (const line of lines) console.log(`BARE-WORLD ${line}`);
  process.exit(2);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

// The repo's own idiom for "this capability is absent" (see
// tools/shell-test-tier.test.ts and instance/expected-shell-capability-exclusions.tsv):
// a test may force one missing so the degraded path is exercised on a host that
// happens to have it.
//
// It is read here, in a non-test file, for exactly one purpose: to stop the
// harness USING a capability. It can never grant one, and maskingDecision below
// refuses unconditionally when it is in play on a host whose real probe
// succeeds -- so the affordance can only ever make this gate stricter. That is
// the property the round-1 review asked for; "a test affordance cannot mint a
// pass" has its own lock.
function capabilityForcedMissing(name: string): boolean {
  const forced = process.env.INFRA_TEST_FORCE_MISSING_CAPABILITIES ?? "";
  return `,${forced},`.includes(`,${name},`);
}

/** The REAL capability of this host, never the test affordance. */
export function probeMountNamespace(): { available: boolean; detail: string } {
  const probe = spawnSync("unshare", ["--mount", "--propagation", "private", "--", "true"], { encoding: "utf8" });
  if (probe.error) return { available: false, detail: "unshare-unavailable" };
  if (probe.status !== 0) return { available: false, detail: `unshare-exit=${probe.status ?? "signal"}` };
  return { available: true, detail: "ok" };
}

export type MaskingDecision = {
  /** Whether the host's home and XDG directories are actually masked. */
  masking: boolean;
  /** `full` and `declared-reduced` may clear the step; `refused` may not. */
  clearance: "full" | "declared-reduced" | "refused";
  /** The capability that is missing, named for the lane. Empty when `full`. */
  capability: string;
  detail: string;
  remedy: string;
};

/**
 * Whether this run is entitled to clear the bare-world step at all.
 *
 * The subtraction either happened or it did not, and only the first case earns
 * a green on its own. Both ways of not happening -- no usable mount namespace,
 * or nothing identified to mask -- leave an absolute path into the operator's
 * config dirs readable, which is the V3-5.39 class this row exists to catch.
 * Each names its own capability so the lane is told which thing was missing,
 * and each is declarable in the terminal report EXCEPT the test affordance,
 * which is not a property of the environment and buys nothing.
 */
export function maskingDecision(options: {
  probe: { available: boolean; detail: string };
  forcedMissing: boolean;
  candidateTargets: string[];
  declaredFidelity: string[];
}): MaskingDecision {
  const { probe, forcedMissing, candidateTargets, declaredFidelity } = options;

  if (probe.available && !forcedMissing && candidateTargets.length > 0) {
    return { masking: true, clearance: "full", capability: "", detail: "ok", remedy: "" };
  }
  if (forcedMissing && probe.available) {
    return {
      masking: false,
      clearance: "refused",
      capability: "mount-namespace",
      detail: "forced-missing real-probe=available",
      remedy: "unset-INFRA_TEST_FORCE_MISSING_CAPABILITIES=mount-namespace a-test-affordance-may-not-mint-a-clearance",
    };
  }
  const [capability, detail, remedy] = probe.available
    ? [
        "maskable-home",
        "no-maskable-home-or-xdg-directory-was-identified",
        "run-with-a-maskable-HOME-or-declare 'bare-world: capability=maskable-home reason=<why>'",
      ]
    : [
        "mount-namespace",
        probe.detail,
        "run-where-an-unprivileged-mount-namespace-works-or-declare 'bare-world: capability=mount-namespace reason=<why>'",
      ];
  return {
    masking: false,
    clearance: declaredFidelity.includes(capability) ? "declared-reduced" : "refused",
    capability,
    detail,
    remedy,
  };
}

/**
 * The directories whose CONTENT must not be reachable from inside the bare
 * world. Only the operator's home and XDG dirs: the point is to remove the
 * running installation's state, not to build a jail.
 */
function maskTargets(worldRoot: string, pathDirectories: string[]): { targets: string[]; skipped: string[] } {
  const candidates = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]
    .map((name) => process.env[name])
    .filter((value): value is string => Boolean(value) && value!.startsWith("/"))
    .map((value) => resolve(value));

  const targets: string[] = [];
  const skipped: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    if (UNMASKABLE.has(candidate) || !isDirectory(candidate)) {
      skipped.push(`${candidate} reason=${UNMASKABLE.has(candidate) ? "system-directory" : "not-a-directory"}`);
      continue;
    }
    // Masking the world itself, or a directory holding a verifier binary, would
    // remove something a clean host HAS. That is not hostility, it is sabotage.
    if (inside(worldRoot, candidate)) {
      skipped.push(`${candidate} reason=contains-the-bare-world`);
      continue;
    }
    const verifierPath = pathDirectories.find((directory) => inside(directory, candidate));
    if (verifierPath) {
      skipped.push(`${candidate} reason=contains-verifier-path path=${verifierPath}`);
      continue;
    }
    targets.push(candidate);
  }
  // Masking a parent makes a nested target unmountable, so keep outermost only.
  return {
    targets: targets.filter((target) => !targets.some((other) => other !== target && inside(target, other))),
    skipped,
  };
}

function cloneAt(repo: string, sha: string, destination: string): string | undefined {
  // --no-hardlinks: a clone that shares object files with the source would be
  // reading the very host state this harness exists to subtract.
  const cloned = spawnSync("git", ["clone", "--no-hardlinks", "--quiet", "--no-checkout", repo, destination], { encoding: "utf8" });
  if (cloned.status !== 0) return `clone-failed ${(cloned.stderr ?? "").trim().split("\n").at(-1) ?? ""}`.trim();
  const checkedOut = spawnSync("git", ["-C", destination, "checkout", "--quiet", "--detach", sha], { encoding: "utf8" });
  if (checkedOut.status !== 0) return `checkout-failed ${(checkedOut.stderr ?? "").trim().split("\n").at(-1) ?? ""}`.trim();
  return undefined;
}

const INTERNAL_MARKER = "BARE-WORLD-INTERNAL";

/**
 * What the bare world PROVIDES, as opposed to what `env -i` removes: each of
 * these variables is repointed into the throwaway world, not scrubbed. One
 * list, used both to build the environment and to keep nameDeltas from telling
 * a refused lane that a facility it still has was taken away. A second list
 * would drift, and the drift would be a false diagnosis.
 */
function providedEnvironment(world: string, trustedPath: string): Record<string, string> {
  return {
    PATH: trustedPath,
    HOME: join(world, "home"),
    XDG_CONFIG_HOME: join(world, "config"),
    XDG_CACHE_HOME: join(world, "cache"),
    XDG_DATA_HOME: join(world, "data"),
    TMPDIR: join(world, "tmp"),
  };
}

export const PROVIDED_ENV_NAMES: readonly string[] = Object.keys(providedEnvironment("", ""));

type Run = { status: number | null; output: string; seconds: number };

function runBare(options: {
  world: string;
  checkout: string;
  verifyScript: string;
  masks: string[];
  useNamespace: boolean;
  trustedPath: string;
}): Run {
  const { world, checkout, verifyScript, masks, useNamespace, trustedPath } = options;
  const environment = Object.entries(providedEnvironment(world, trustedPath))
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");

  const script = [
    "set -u",
    ...(useNamespace
      ? [
          "mount --make-rprivate / 2>/dev/null || true",
          ...masks.map(
            (target) =>
              `mount -t tmpfs -o mode=0700 bare-world-mask ${shellQuote(target)} || { echo "${INTERNAL_MARKER} mask-failed target=${target}" >&2; exit 90; }`,
          ),
        ]
      : []),
    `cd ${shellQuote(checkout)} || { echo "${INTERNAL_MARKER} cd-failed" >&2; exit 90; }`,
    "umask 077",
    `exec env -i ${environment} /bin/sh ${shellQuote(verifyScript)}`,
  ].join("\n");

  const enterScript = join(world, "enter.sh");
  writeFileSync(enterScript, `${script}\n`, { mode: 0o700 });

  const executable = useNamespace ? "unshare" : "/bin/bash";
  const argv = useNamespace ? ["--mount", "--propagation", "private", "--", "/bin/bash", enterScript] : [enterScript];
  const started = performance.now();
  const result = spawnSync(executable, argv, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = (performance.now() - started) / 1000;
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, seconds };
}

/** The control: the same command, the same clean clone, the ambient host world. */
function runControl(checkout: string, verifyScript: string): Run {
  const environment: Record<string, string | undefined> = { ...process.env };
  for (const name of GATE_RESOLUTION_EXPORTS) delete environment[name];
  const started = performance.now();
  const result = spawnSync("/bin/sh", [verifyScript], {
    cwd: checkout,
    encoding: "utf8",
    env: environment as NodeJS.ProcessEnv,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, seconds: (performance.now() - started) / 1000 };
}

/**
 * Two runs of the same suite never print the same bytes -- durations differ,
 * temp directories differ -- so the comparison is on normalized lines. Without
 * this every line reads as new and the diff names nothing.
 */
export function normalize(line: string, worlds: string[]): string {
  let normalized = line.trim();
  for (const world of worlds) normalized = normalized.replaceAll(world, "<world>");
  return normalized
    .replace(/\[[0-9]+(?:\.[0-9]+)?\s*(?:ms|s|m)\]/g, "[t]")
    .replace(/[0-9]+(?:\.[0-9]+)?\s*(?:ms|s)\b/g, "<t>")
    .replace(/\/tmp\/[A-Za-z0-9._-]+/g, "<tmp>");
}

export function newLinesIn(bare: string, control: string, worlds: string[]): string[] {
  const controlLines = new Set(control.split(/\r?\n/).map((line) => normalize(line, worlds)));
  const seen = new Set<string>();
  const fresh: string[] = [];
  for (const raw of bare.split(/\r?\n/)) {
    const normalized = normalize(raw, worlds);
    if (!normalized || controlLines.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    fresh.push(raw.trim());
  }
  return fresh;
}

// The control run inherits the ambient PATH while the bare run uses the gate's
// trusted baseline, so the two can legitimately be different builds of the same
// tool -- measured on this host: /root/.bun/bin/bun 1.3.14 against
// /usr/local/bin/bun 1.2.22. That is a real subtraction and stays in the diff,
// but it means the raw new-line set opens with banner noise. The lane is shown
// the failure-bearing lines first, and the whole set only when none of them
// look like a failure at all.
const FAILURE_SHAPED = /\bfail\b|error|expect|assert|not found|denied|refus|Expected|Received|panic|throw|ENOENT|EACCES|NO-GO/i;

export function interestingLines(fresh: string[]): string[] {
  const shaped = fresh.filter((line) => FAILURE_SHAPED.test(line));
  return shaped.length > 0 ? shaped : fresh;
}

const ABSOLUTE_PATH = /\/(?:[A-Za-z0-9._+~-]+\/)*[A-Za-z0-9._+~-]+/g;
const PERMISSION_SIGNAL = /permission denied|EACCES|EPERM|not permitted|\b0o?[0-7]{3,4}\b|\b(?:384|416|420|448|493|509|511)\b/i;

/**
 * Name what the bare world lacked, as far as it is diagnosable. "As far as" is
 * the honest bound: a test that reads host state and then reports its own
 * message can be shown WHICH lines are new and WHAT was subtracted, and no
 * more.
 */
export function nameDeltas(options: {
  fresh: string[];
  masks: string[];
  repo: string;
  checkouts: string[];
  /** The trusted verifier directories, which EXIST inside the bare world. */
  pathDirectories: string[];
}): string[] {
  const { fresh, masks, repo, checkouts, pathDirectories } = options;
  const deltas: string[] = [];
  const text = fresh.join("\n");

  const paths = new Set<string>();
  for (const match of text.matchAll(ABSOLUTE_PATH)) paths.add(match[0]);
  for (const path of paths) {
    if (checkouts.some((checkout) => inside(path, checkout))) continue;
    // Provided, not subtracted: the verifier directories and the system
    // directories the world is forbidden to mask are all reachable inside it.
    // Naming one of them sends the refused lane after a delta that is not one.
    if (pathDirectories.some((directory) => inside(path, directory)) || UNMASKABLE.has(path)) continue;
    const mask = masks.find((target) => inside(path, target));
    if (mask) {
      deltas.push(`delta=masked-host-path path=${path} mask=${mask} host-exists=${existsSync(path) ? "yes" : "no"}`);
      continue;
    }
    if (inside(path, repo)) {
      const relative = path.slice(repo.length + 1);
      if (relative && spawnSync("git", ["-C", repo, "ls-files", "--error-unmatch", "--", relative], { encoding: "utf8" }).status !== 0) {
        deltas.push(`delta=untracked-path path=${path} detail=absent-from-a-clean-clone`);
      }
      continue;
    }
    if (existsSync(path) && !path.startsWith("/tmp/") && !path.startsWith("/proc/") && !path.startsWith("/dev/")) {
      deltas.push(`delta=host-path path=${path} detail=exists-on-this-host-only`);
    }
  }

  for (const name of Object.keys(process.env)) {
    if (name.length < 3 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (!new RegExp(`\\b${name}\\b`).test(text)) continue;
    // A provided variable still HAS a value in the bare world -- an empty one
    // inside the throwaway world, or the gate's trusted PATH. That can well be
    // the delta, but it is not the delta `env -i` made, and saying so sent the
    // lane looking for a variable that was never removed.
    deltas.push(
      PROVIDED_ENV_NAMES.includes(name)
        ? `delta=env name=${name} detail=repointed-into-the-bare-world`
        : `delta=env name=${name} detail=scrubbed-by-env-i`,
    );
  }

  if (PERMISSION_SIGNAL.test(text)) deltas.push("delta=permission-or-mode detail=the-bare-world-runs-at-umask-077");

  return [...new Set(deltas)];
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.report)) refuse([`verdict=refused reason=report-missing report=${options.report}`]);
  const contents = readFileSync(options.report, "utf8");

  const result = lineValue(contents, "result");
  const verify = lineValue(contents, "verify");
  const commit = lineValue(contents, "commit");
  // Fence-aware, because this field GRANTS a clearance: a report documenting the
  // declaration syntax in a fenced code block must not thereby make one. Found
  // on this row's own terminal report, which did exactly that.
  const declarations = fieldValues(contents, "bare-world");
  if (declarations.unterminatedFence) {
    refuse(["verdict=refused reason=report-malformed detail=unterminated-fenced-block"]);
  }
  if (declarations.values.length > 1) {
    refuse([`verdict=refused reason=declaration-duplicated NO-GO capability=host-state count=${declarations.values.length}`]);
  }
  const declaration = declarations.values[0];

  if (result !== "clean") {
    // A NO-GO report's verify was never run normally either
    // (gate/completion-guard.ts runs it only for `result: clean`), so there is no
    // passing baseline to compare a bare run against.
    say(`status=not-applicable reason=result-not-clean result=${result ?? "missing"}`);
    process.exit(0);
  }
  if (!verify) refuse(["verdict=refused reason=verify-missing-or-duplicated"]);

  const sha = (commit ?? "").split(/\s+/, 1)[0];
  if (!/^[0-9a-f]{40}$/i.test(sha)) refuse(["verdict=refused reason=commit-sha-unreadable"]);

  // One line, one or more comma-separated capabilities: a lane on a host with no
  // usable namespace whose verify also legitimately reads host state has two
  // things to declare, and the report contract allows the field only once.
  const declaredFailure: string[] = [];
  const declaredFidelity: string[] = [];
  if (declaration !== undefined) {
    const names = (declaration.match(/(?:^|\s)capability=(\S+)/)?.[1] ?? "").split(",").filter(Boolean);
    const reason = declaration.match(/(?:^|\s)reason=(.+)$/)?.[1]?.trim();
    const unknown = names.filter((name) => !DECLARABLE_CAPABILITIES.has(name));
    if (names.length === 0 || unknown.length > 0) {
      // lane-capabilities.md: an unknown capability is a named refusal that stops
      // cleanly, never a silent pass.
      refuse([
        `verdict=refused reason=undeclarable-capability NO-GO capability=${unknown.join(",") || "missing"}`,
        `detail=declare-one-of=${[...DECLARABLE_CAPABILITIES.keys()].join("|")} field='bare-world: capability=<name>[,<name>] reason=<why>'`,
      ]);
    }
    if (!reason) refuse([`verdict=refused reason=declaration-without-reason NO-GO capability=${names.join(",")}`]);
    for (const name of names) {
      (DECLARABLE_CAPABILITIES.get(name) === "fidelity" ? declaredFidelity : declaredFailure).push(name);
    }
  }

  const namespace = probeMountNamespace();
  const namespaceForcedMissing = capabilityForcedMissing("mount-namespace");
  const trustedPath = process.env.LAND_CHECK_PATH || FALLBACK_TRUSTED_PATH;
  const pathDirectories = trustedPath.split(":").filter(Boolean).map((directory) => resolve(directory));

  // The world lives outside every directory it is about to mask, or it would mask
  // itself.
  const temporaryBase = ((): string => {
    const preferred = process.env.TMPDIR ? resolve(process.env.TMPDIR) : "/tmp";
    const home = process.env.HOME ? resolve(process.env.HOME) : undefined;
    return home && inside(preferred, home) ? "/tmp" : preferred;
  })();
  const world = mkdtempSync(join(temporaryBase, "bare-world-"));
  // Registered on `exit`, not written as a `finally`: every refusal path below
  // ends in process.exit(), which does NOT unwind a finally block, and a harness
  // that leaks a clone per refused lane would become its own hygiene defect. The
  // namespace's mounts die with the process that held them.
  process.on("exit", () => rmSync(world, { recursive: true, force: true }));
  for (const directory of ["home", "config", "cache", "data", "tmp"]) mkdirSync(join(world, directory), { recursive: true });

  const { targets: candidateMasks, skipped } = maskTargets(world, pathDirectories);
  for (const entry of skipped) say(`mask=skipped target=${entry}`);
  const decision = maskingDecision({
    probe: namespace,
    forcedMissing: namespaceForcedMissing,
    candidateTargets: candidateMasks,
    declaredFidelity,
  });
  // Nothing is masked unless the mask actually ran, so nothing may be REPORTED as
  // masked either: a diagnosis that names a mask the run never applied would send
  // the next lane looking for the wrong delta.
  const masks = decision.masking ? candidateMasks : [];

  /**
   * The clearance check, called at every exit-0 site. A run that did not
   * subtract the host's home and XDG directories cannot say the verify survived
   * their absence -- it never tested that -- so it refuses with the missing
   * capability named, and gate/lane-exit.sh blocks it exactly as it blocks a
   * failed verify.
   */
  const refuseUnlessCleared = (context: string[]): void => {
    if (decision.clearance !== "refused") return;
    refuse([
      `verdict=refused reason=host-state-mask-not-applied NO-GO capability=${decision.capability}`,
      `detail=${decision.detail} hermeticity=undetermined fidelity=reduced`,
      "note=the-mask-is-the-only-subtraction-that-catches-an-absolute-host-path-read",
      ...context,
      `remedy=${decision.remedy}`,
    ]);
  };

  const sayUnusedDeclarations = (names: string[]): void => {
    for (const name of names) say(`declaration=unused capability=${name} detail=the-run-did-not-need-it`);
  };

  {
    const verifyScript = join(world, "verify.sh");
    writeFileSync(verifyScript, `${verify}\n`, { mode: 0o600 });

    const bareCheckout = join(world, "bare");
    const cloneError = cloneAt(options.repo, sha, bareCheckout);
    if (cloneError) refuse([`verdict=refused reason=preflight detail=${cloneError}`]);

    if (decision.masking) {
      say(`masking=on targets=${masks.join(",")}`);
    } else {
      // Named, never silent, and never a pass on its own: the world is still
      // scrubbed, cloned and umask-077, but an absolute path into the host's
      // config dirs is reachable, so this run may not clear the step unless the
      // report declared the missing capability.
      say(
        `masking=unavailable capability=${decision.capability} detail=${decision.detail} fidelity=reduced note=absolute-host-paths-remain-reachable`,
      );
      if (decision.clearance === "declared-reduced") {
        say(`declaration=accepted capability=${decision.capability} detail=this-run-may-clear-at-reduced-fidelity`);
      }
    }

    const bare = runBare({
      world,
      checkout: bareCheckout,
      verifyScript,
      masks,
      useNamespace: decision.masking,
      trustedPath,
    });

    if (bare.output.includes(INTERNAL_MARKER)) {
      refuse([`verdict=refused reason=harness-preflight detail=${bare.output.split(INTERNAL_MARKER)[1]?.trim().split("\n")[0] ?? "unknown"}`]);
    }

    const cost = `bare-seconds=${bare.seconds.toFixed(2)}`;
    if (bare.status === 0) {
      // A green from a world that did not perform the subtraction is exactly the
      // silent environmental pass this harness exists to end.
      refuseUnlessCleared([`bare-verdict=would-have-passed-unmasked ${cost}`]);
      sayUnusedDeclarations([...declaredFailure, ...(decision.masking ? declaredFidelity : [])]);
      say(`verdict=pass ${cost}${decision.masking ? "" : " fidelity=reduced"} note=this-doubles-the-verify-step`);
      process.exit(0);
    }

    // It failed. Whether that is the lane's defect or the harness's hostility is
    // decided by running the same command in the ambient world, not asserted.
    const controlCheckout = join(world, "control");
    const controlError = cloneAt(options.repo, sha, controlCheckout);
    if (controlError) refuse([`verdict=refused reason=preflight detail=control-${controlError}`]);
    const control = runControl(controlCheckout, verifyScript);

    const fresh = newLinesIn(bare.output, control.output, [bareCheckout, controlCheckout, world]);

    // Both worlds red at a SHA gate/completion-guard.ts just verified green is a
    // DIFFERENT defect: the verify is unstable, and no capability declaration
    // excuses it, because none of them can make an unstable command stable.
    if (control.status !== 0) {
      refuse([
        `verdict=refused reason=verify-unstable detail=failed-in-both-worlds bare-exit=${bare.status ?? "signal"} control-exit=${control.status ?? "signal"} ${cost}`,
        ...interestingLines(fresh).slice(0, 8).map((line) => `detail=${JSON.stringify(line.slice(0, 220))}`),
      ]);
    }

    const deltas = nameDeltas({
      fresh,
      masks,
      repo: options.repo,
      checkouts: [bareCheckout, controlCheckout],
      pathDirectories,
    });
    const lines = [
      `reason=verify-needs-ambient-host-state exit=${bare.status ?? "signal"} ${cost} control-seconds=${control.seconds.toFixed(2)}`,
      ...(deltas.length === 0 ? ["delta=undiagnosed detail=the-new-failure-names-no-host-path-env-or-permission"] : deltas),
      `subtracted=env-i(PATH-to-the-trusted-baseline),clean-clone,umask-077${masks.length ? `,masked:${masks.join("+")}` : ""}`,
      ...interestingLines(fresh).slice(0, 8).map((line) => `detail=${JSON.stringify(line.slice(0, 220))}`),
    ];

    if (declaredFailure.length > 0) {
      for (const line of lines) say(line);
      // A failure declaration accepts a failure; it does not entitle an unmasked
      // world to clear. One kind of declaration never stands in for the other.
      refuseUnlessCleared([`bare-verdict=failed-and-declared capability=${declaredFailure.join(",")}`]);
      sayUnusedDeclarations(decision.masking ? declaredFidelity : []);
      say(`verdict=declared capability=${declaredFailure.join(",")} detail=failure-accepted-against-the-declaration`);
      process.exit(0);
    }
    refuse([
      `verdict=refused ${lines[0]}`,
      ...lines.slice(1),
      "NO-GO capability=host-state",
      "remedy=make-the-verify-hermetic-or-declare 'bare-world: capability=host-state reason=<why>'",
    ]);
  }
}

if (import.meta.main) main();

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { isMissionCliAction, missionCliActions, ownerLiveness } from "./mission-cli-actions";

const repo = resolve(import.meta.dir, "..");

// ── The caller/callee lock (instance/workboard.md V3-5.37) ──────────────────
//
// This is the test the incident record asked for by name:
//
//   "A test that locks *the caller and the callee agreeing* is the one that
//    would have caught this; neither side alone is wrong-looking."
//   -- instance/incidents/2026-08-04-orchestrator-launcher-unstartable-from-git.md
//
// orchestrator/launch.sh called `reap` and three `lease` verbs that
// core/mission-cli.ts never implemented. Both files read perfectly well on
// their own. The divergence was invisible until a state database existed on the
// host, at which point EVERY orchestrator start died on `unknown action`, and
// the only thing standing between the operator and a dead control plane was two
// lines in a gitignored file.
//
// tools/check-documented-mission-cli.ts already locked this for the CLI
// invocations written in `instructions/` and `instance/` markdown. It could not
// have caught this one: it scans documentation, and the launcher is code. Worse,
// launch.sh does not spell out a `bun .../mission-cli.ts` command at all -- it
// calls through a one-line `mission_cli()` shell function -- so no scan looking
// for the documented form would ever have seen it.

type Invocation = { file: string; line: number; group: string; action?: string };

// Two shapes reach the CLI from shell: through a local `mission_cli` wrapper
// function (launch.sh, watchdog.sh), and spelled out as a `bun .../mission-cli.ts`
// command (bootstrap/install.sh). Both are matched, because an unimplemented
// verb is equally fatal either way.
const WRAPPER = /(?:^|[^A-Za-z0-9_-])mission_cli[ \t]+([a-z][a-z-]*)(?:[ \t]+([a-z][a-z-]*))?/;
const DIRECT = /mission-cli\.ts["']?[ \t]+([a-z][a-z-]*)(?:[ \t]+([a-z][a-z-]*))?/;

function trackedRuntimeShell(): string[] {
  const listed = Bun.spawnSync(["git", "-C", repo, "ls-files", "*.sh"]);
  expect(listed.exitCode, "cannot enumerate tracked shell files").toBe(0);
  return listed.stdout.toString().split("\n")
    .filter((file) => file.length > 0 && !file.endsWith(".test.sh"));
}

function shellInvocations(): Invocation[] {
  const found: Invocation[] = [];
  for (const file of trackedRuntimeShell()) {
    const lines = readFileSync(join(repo, file), "utf8").split("\n");
    for (let index = 0; index < lines.length; index++) {
      const text = lines[index]!;
      // The wrapper's own definition (`mission_cli() { ... }`) is not a call.
      if (/^\s*mission_cli\(\)/.test(text)) continue;
      for (const pattern of [WRAPPER, DIRECT]) {
        const match = text.match(pattern);
        if (match) found.push({ file, line: index + 1, group: match[1]!, action: match[2] });
      }
    }
  }
  return found;
}

test("every mission-cli verb the tracked runtime shell calls is a verb the CLI implements", () => {
  const invocations = shellInvocations();
  const undocumented = invocations
    .filter(({ group, action }) => !isMissionCliAction(group, action))
    .map(({ file, line, group, action }) => `${file}:${line}: calls undocumented CLI action \`${group}${action ? ` ${action}` : ""}\``);
  expect(undocumented).toEqual([]);
});

test("the caller scan actually reads the launcher and the watchdog, so agreement is not vacuous", () => {
  // A scan that silently matches nothing agrees with everything. These are the
  // exact call sites that were broken, named individually: a regex that stops
  // seeing them must fail here rather than go quietly green.
  const seen = new Set(shellInvocations().map(({ file, group, action }) => `${file} ${group}${action ? ` ${action}` : ""}`));
  for (const required of [
    "orchestrator/launch.sh reap",
    "orchestrator/launch.sh status",
    "orchestrator/launch.sh lease acquire",
    "orchestrator/launch.sh lease renew",
    "orchestrator/launch.sh lease release",
    "orchestrator/watchdog.sh status",
    "orchestrator/watchdog.sh lease acquire",
    "orchestrator/watchdog.sh lease renew",
    "bootstrap/install.sh status",
  ]) {
    expect(seen.has(required), `the caller scan no longer sees \`${required}\``).toBe(true);
  }
});

test("the CLI vocabulary is a set, and every entry is a plain group[/action] pair", () => {
  const spelled = missionCliActions.map(([group, action]) => `${group}${action ? ` ${action}` : ""}`);
  expect(new Set(spelled).size, "the vocabulary names an action twice").toBe(spelled.length);
  for (const [group, action] of missionCliActions) {
    expect(group).toMatch(/^[a-z][a-z-]*$/);
    if (action !== undefined) expect(action).toMatch(/^[a-z][a-z-]*$/);
  }
  expect(isMissionCliAction("lease", "steal")).toBe(false);
  expect(isMissionCliAction("reap", "everything")).toBe(false);
  expect(isMissionCliAction("reap")).toBe(true);
});

// ── The reaper's liveness probe ─────────────────────────────────────────────
// Held against REAL processes rather than a stubbed probe: the whole value of
// this predicate is that it answers a question about the operating system, and
// a fake would only prove the branches are reachable.

test("a running process is live, and a process that has exited is dead", async () => {
  expect(ownerLiveness(`${hostname()}:${process.pid}`)).toBe("live");
  const spawned = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  const pid = spawned.pid;
  await spawned.exited;
  expect(ownerLiveness(`${hostname()}:${pid}`)).toBe("dead");
});

test("everything the probe cannot answer is unverifiable, never dead", () => {
  // `dead` is the ONLY verdict that releases a lease (DurableStore.reapLeases),
  // so each of these being anything other than `unverifiable` would let the
  // reaper take a lease away from a holder it never checked.
  for (const owner of [
    "some-other-host:1234",   // a PID on a host whose processes we cannot see
    "no-pid-here",            // no separator at all
    ":1234",                  // empty host
    `${hostname()}:`,         // empty pid
    `${hostname()}:0`,        // 0 is not a PID; kill(0) means "the process group"
    `${hostname()}:-1`,       // negative is a process group, not a process
    `${hostname()}:abc`,      // not a number
  ]) {
    expect(ownerLiveness(owner), `${owner} must be unverifiable`).toBe("unverifiable");
  }
  // Explicit host argument, so the foreign-host branch is proven without
  // depending on what this particular machine happens to be called.
  expect(ownerLiveness(`${hostname()}:${process.pid}`, "a-different-host")).toBe("unverifiable");
});

test("an owner carrying colons in its host half is still resolved on the LAST colon", () => {
  // The shell twin splits with ${owner%:*} / ${owner##*:}, i.e. the last colon.
  // An IPv6-ish or otherwise colon-bearing host name must not silently become a
  // different (possibly live) PID here than it is over there.
  expect(ownerLiveness(`fd00::1:${process.pid}`, "fd00::1")).toBe("live");
});

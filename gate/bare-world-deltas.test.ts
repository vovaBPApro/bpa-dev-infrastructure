import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDED_ENV_NAMES, interestingLines, maskingDecision, nameDeltas, newLinesIn, normalize } from "./bare-world";

// The delta namer is the half of gate/bare-world.ts that decides what a refused
// lane is TOLD, and gate/bare-world.test.sh can only reach it through a whole
// clone-and-unshare run. These cases drive it directly, so each classifier --
// and each way of naming nothing -- has a lock of its own.

const roots: string[] = [];
afterAll(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function repoFixture(): { repo: string; tracked: string; untracked: string } {
  const root = mkdtempSync(join(tmpdir(), "bare-deltas-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  spawnSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
  spawnSync("git", ["-C", repo, "config", "user.email", "deltas@example.test"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "Deltas"]);
  writeFileSync(join(repo, "tracked.json"), "{}\n");
  spawnSync("git", ["-C", repo, "add", "-A"]);
  spawnSync("git", ["-C", repo, "commit", "--quiet", "-m", "fixture"]);
  writeFileSync(join(repo, "uncommitted.json"), "{}\n");
  return { repo, tracked: join(repo, "tracked.json"), untracked: join(repo, "uncommitted.json") };
}

test("two runs of the same suite differ only in noise once normalized", () => {
  const worlds = ["/tmp/bare-world-abc"];
  expect(normalize("(pass) reaps a terminal worktree [12.34ms]", worlds)).toBe(
    normalize("(pass) reaps a terminal worktree [7.00ms]", worlds),
  );
  expect(normalize("Ran 54 tests across 1 file. [2.62s]", worlds)).toBe(
    normalize("Ran 54 tests across 1 file. [3.90s]", worlds),
  );
  expect(normalize("wrote /tmp/bare-world-abc/bare/x", worlds)).toBe("wrote <world>/bare/x");
});

test("only lines the bare run added are read as new", () => {
  const bare = ["bun test v1.2.22", "(fail) reads the host [3.00ms]", "error: ENOENT"].join("\n");
  const control = ["bun test v1.2.22", "(pass) reads the host [9.00ms]"].join("\n");
  expect(newLinesIn(bare, control, [])).toEqual(["(fail) reads the host [3.00ms]", "error: ENOENT"]);
});

test("a duplicated new line is named once, not once per occurrence", () => {
  const bare = "error: ENOENT\nerror: ENOENT\nerror: ENOENT";
  expect(newLinesIn(bare, "quiet", [])).toEqual(["error: ENOENT"]);
});

test("the failure-bearing lines are shown ahead of banner noise", () => {
  // The two runs can use different builds of the same tool -- measured here:
  // /root/.bun/bin/bun 1.3.14 on the ambient PATH against /usr/local/bin/bun
  // 1.2.22 on the gate's trusted one -- so version banners arrive in the diff.
  const fresh = ["bun test v1.2.22 (6bafe260)", "hygiene/reap.test.ts:", "error: expect(received).toBe(expected)"];
  expect(interestingLines(fresh)).toEqual(["error: expect(received).toBe(expected)"]);
});

test("when nothing looks like a failure, everything is shown rather than nothing", () => {
  const fresh = ["bun test v1.2.22 (6bafe260)", "hygiene/reap.test.ts:"];
  expect(interestingLines(fresh)).toEqual(fresh);
});

test("V3-5.39's shape: a path under a masked directory is named with its mask", () => {
  const { repo } = repoFixture();
  // Deliberately a path this host does NOT have: the real V3-5.39 path
  // /root/.config/bpa/backup-passphrase exists on this installation, and a lock
  // asserting host-exists against it would be the very defect this row is about.
  const deltas = nameDeltas({
    fresh: ["error: passphrase file not found: /root/.config/bpa-absent-fixture/backup-passphrase"],
    masks: ["/root"],
    repo,
    checkouts: [],
    pathDirectories: [],
  });
  expect(deltas).toContain(
    "delta=masked-host-path path=/root/.config/bpa-absent-fixture/backup-passphrase mask=/root host-exists=no",
  );
});

test("whether the masked path exists on THIS host is reported, not assumed", () => {
  const { repo, tracked } = repoFixture();
  const [delta] = nameDeltas({ fresh: [`open ${tracked}`], masks: [repo], repo: "/nowhere", checkouts: [], pathDirectories: [] });
  expect(delta).toBe(`delta=masked-host-path path=${tracked} mask=${repo} host-exists=yes`);
});

test("V3-5.25's shape: a path inside the repo that no clone would carry is named", () => {
  const { repo, tracked, untracked } = repoFixture();
  const deltas = nameDeltas({ fresh: [`fixture missing: ${untracked}`], masks: [], repo, checkouts: [], pathDirectories: [] });
  expect(deltas).toEqual([`delta=untracked-path path=${untracked} detail=absent-from-a-clean-clone`]);
  // A tracked file is in every clone, so it is never the delta.
  expect(nameDeltas({ fresh: [`read ${tracked}`], masks: [], repo, checkouts: [], pathDirectories: [] })).toEqual([]);
});

test("a path inside the throwaway checkouts is the harness's own and is never a delta", () => {
  const { repo } = repoFixture();
  const checkout = "/tmp/bare-world-x/bare";
  expect(nameDeltas({ fresh: [`${checkout}/hygiene/reap.test.ts:12`], masks: [], repo, checkouts: [checkout], pathDirectories: [] })).toEqual([]);
});

test("V3-5.34's shape: a permission or mode signal names the umask", () => {
  const { repo } = repoFixture();
  for (const line of ["EACCES: permission denied, open 'x'", "Expected: 0755", "Received: 448"]) {
    expect(nameDeltas({ fresh: [line], masks: [], repo, checkouts: [], pathDirectories: [] })).toEqual([
      "delta=permission-or-mode detail=the-bare-world-runs-at-umask-077",
    ]);
  }
});

test("a scrubbed environment variable named in the failure is named back", () => {
  const { repo } = repoFixture();
  process.env.BARE_WORLD_FIXTURE_VARIABLE = "set";
  try {
    const deltas = nameDeltas({
      fresh: ["error: BARE_WORLD_FIXTURE_VARIABLE is not set"],
      masks: [],
      repo,
      checkouts: [],
      pathDirectories: [],
    });
    expect(deltas).toContain("delta=env name=BARE_WORLD_FIXTURE_VARIABLE detail=scrubbed-by-env-i");
  } finally {
    delete process.env.BARE_WORLD_FIXTURE_VARIABLE;
  }
});

// The bare world PROVIDES six variables and the trusted verifier directories.
// Round 1 named all of them as subtractions -- "HOME is not set" was answered
// with `delta=env name=HOME detail=scrubbed-by-env-i` for a variable the world
// sets, and `/usr/bin` with `detail=exists-on-this-host-only` for a directory
// that exists inside it. Each such line points a refused lane at a delta that
// is not one, which is below what lane-capabilities.md promises it.

test("a variable the bare world PROVIDES is never reported as scrubbed", () => {
  const { repo } = repoFixture();
  // Only a variable set in THIS process is ever named, so the ones this host
  // happens not to export are set for the duration of the case.
  const restore = PROVIDED_ENV_NAMES.filter((name) => process.env[name] === undefined);
  for (const name of restore) process.env[name] = "fixture";
  try {
    for (const name of PROVIDED_ENV_NAMES) {
      const deltas = nameDeltas({
        fresh: [`error: ${name} is not set`],
        masks: [],
        repo,
        checkouts: [],
        pathDirectories: [],
      });
      expect(deltas).toContain(`delta=env name=${name} detail=repointed-into-the-bare-world`);
      expect(deltas).not.toContain(`delta=env name=${name} detail=scrubbed-by-env-i`);
    }
  } finally {
    for (const name of restore) delete process.env[name];
  }
});

test("a trusted verifier directory exists inside the bare world and is not a delta", () => {
  const { repo } = repoFixture();
  const deltas = nameDeltas({
    fresh: ["sh: 1: cannot execute: PATH=/usr/bin", "spawn /usr/bin/git ENOENT"],
    masks: [],
    repo,
    checkouts: [],
    pathDirectories: ["/usr/local/bin", "/usr/bin", "/bin"],
  });
  expect(deltas.filter((delta) => delta.startsWith("delta=host-path"))).toEqual([]);
});

test("a system directory the world is forbidden to mask is not a delta either", () => {
  const { repo } = repoFixture();
  const deltas = nameDeltas({ fresh: ["cannot stat /etc"], masks: [], repo, checkouts: [], pathDirectories: [] });
  expect(deltas.filter((delta) => delta.startsWith("delta=host-path"))).toEqual([]);
  // ...but a path INSIDE one still is. /etc is on every host; what someone put
  // in it is exactly the installation state this harness is about.
  expect(
    nameDeltas({ fresh: ["cannot open /etc/hostname"], masks: [], repo: "/nowhere", checkouts: [], pathDirectories: [] }),
  ).toEqual(["delta=host-path path=/etc/hostname detail=exists-on-this-host-only"]);
});

// The clearance rule, every combination. The round-1 defect was one row of this
// table: no namespace, no declaration, run passes -- which reported
// `verdict=pass` and let gate/lane-exit.sh report `verdict=clear exit=0` for a
// world that had not performed the subtraction that catches a host-path read.

const PROBE_OK = { available: true, detail: "ok" };
const PROBE_GONE = { available: false, detail: "unshare-unavailable" };

test("a usable namespace with something to mask is the only self-standing clearance", () => {
  const decision = maskingDecision({
    probe: PROBE_OK,
    forcedMissing: false,
    candidateTargets: ["/root"],
    declaredFidelity: [],
  });
  expect(decision.masking).toBe(true);
  expect(decision.clearance).toBe("full");
});

test("no usable namespace and no declaration is REFUSED, never a reduced-fidelity pass", () => {
  const decision = maskingDecision({
    probe: PROBE_GONE,
    forcedMissing: false,
    candidateTargets: ["/root"],
    declaredFidelity: [],
  });
  expect(decision.masking).toBe(false);
  expect(decision.clearance).toBe("refused");
  expect(decision.capability).toBe("mount-namespace");
  expect(decision.detail).toBe("unshare-unavailable");
  expect(decision.remedy).toContain("bare-world: capability=mount-namespace reason=<why>");
});

test("the declaration for the missing capability, and only that one, clears it", () => {
  const base = { probe: PROBE_GONE, forcedMissing: false, candidateTargets: ["/root"] } as const;
  expect(maskingDecision({ ...base, declaredFidelity: ["mount-namespace"] }).clearance).toBe("declared-reduced");
  // A host-state declaration is a FAILURE declaration and never reaches here;
  // a fidelity declaration for the other cause does not stand in for this one.
  expect(maskingDecision({ ...base, declaredFidelity: ["maskable-home"] }).clearance).toBe("refused");
});

test("a usable namespace with nothing to mask is its own named refusal", () => {
  const base = { probe: PROBE_OK, forcedMissing: false, candidateTargets: [] } as const;
  const decision = maskingDecision({ ...base, declaredFidelity: [] });
  expect(decision.masking).toBe(false);
  expect(decision.clearance).toBe("refused");
  expect(decision.capability).toBe("maskable-home");
  expect(maskingDecision({ ...base, declaredFidelity: ["maskable-home"] }).clearance).toBe("declared-reduced");
  expect(maskingDecision({ ...base, declaredFidelity: ["mount-namespace"] }).clearance).toBe("refused");
});

test("the test affordance can only ever refuse -- no declaration buys it a clearance", () => {
  for (const declaredFidelity of [[], ["mount-namespace"], ["mount-namespace", "maskable-home"]]) {
    const decision = maskingDecision({
      probe: PROBE_OK,
      forcedMissing: true,
      candidateTargets: ["/root"],
      declaredFidelity,
    });
    expect(decision.masking).toBe(false);
    expect(decision.clearance).toBe("refused");
    expect(decision.detail).toContain("real-probe=available");
    expect(decision.remedy).not.toContain("declare");
  }
  // On a host that genuinely lacks the capability the affordance changes
  // nothing: the environment, not the variable, is what is being declared.
  expect(
    maskingDecision({
      probe: PROBE_GONE,
      forcedMissing: true,
      candidateTargets: ["/root"],
      declaredFidelity: ["mount-namespace"],
    }).clearance,
  ).toBe("declared-reduced");
});

test("a failure naming nothing diagnosable produces no delta, never a guess", () => {
  const { repo } = repoFixture();
  expect(nameDeltas({ fresh: ["(fail) it did not work"], masks: [], repo, checkouts: [], pathDirectories: [] })).toEqual([]);
});

test("a host path that does not exist here is not reported as one that does", () => {
  const { repo } = repoFixture();
  expect(nameDeltas({ fresh: ["cannot open /var/lib/gone/state.db"], masks: [], repo, checkouts: [], pathDirectories: [] })).toEqual([]);
});

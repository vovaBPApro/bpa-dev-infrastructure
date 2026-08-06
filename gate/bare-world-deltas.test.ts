import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interestingLines, nameDeltas, newLinesIn, normalize } from "./bare-world";

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
  });
  expect(deltas).toContain(
    "delta=masked-host-path path=/root/.config/bpa-absent-fixture/backup-passphrase mask=/root host-exists=no",
  );
});

test("whether the masked path exists on THIS host is reported, not assumed", () => {
  const { repo, tracked } = repoFixture();
  const [delta] = nameDeltas({ fresh: [`open ${tracked}`], masks: [repo], repo: "/nowhere", checkouts: [] });
  expect(delta).toBe(`delta=masked-host-path path=${tracked} mask=${repo} host-exists=yes`);
});

test("V3-5.25's shape: a path inside the repo that no clone would carry is named", () => {
  const { repo, tracked, untracked } = repoFixture();
  const deltas = nameDeltas({ fresh: [`fixture missing: ${untracked}`], masks: [], repo, checkouts: [] });
  expect(deltas).toEqual([`delta=untracked-path path=${untracked} detail=absent-from-a-clean-clone`]);
  // A tracked file is in every clone, so it is never the delta.
  expect(nameDeltas({ fresh: [`read ${tracked}`], masks: [], repo, checkouts: [] })).toEqual([]);
});

test("a path inside the throwaway checkouts is the harness's own and is never a delta", () => {
  const { repo } = repoFixture();
  const checkout = "/tmp/bare-world-x/bare";
  expect(nameDeltas({ fresh: [`${checkout}/hygiene/reap.test.ts:12`], masks: [], repo, checkouts: [checkout] })).toEqual([]);
});

test("V3-5.34's shape: a permission or mode signal names the umask", () => {
  const { repo } = repoFixture();
  for (const line of ["EACCES: permission denied, open 'x'", "Expected: 0755", "Received: 448"]) {
    expect(nameDeltas({ fresh: [line], masks: [], repo, checkouts: [] })).toEqual([
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
    });
    expect(deltas).toContain("delta=env name=BARE_WORLD_FIXTURE_VARIABLE detail=scrubbed-by-env-i");
  } finally {
    delete process.env.BARE_WORLD_FIXTURE_VARIABLE;
  }
});

test("a failure naming nothing diagnosable produces no delta, never a guess", () => {
  const { repo } = repoFixture();
  expect(nameDeltas({ fresh: ["(fail) it did not work"], masks: [], repo, checkouts: [] })).toEqual([]);
});

test("a host path that does not exist here is not reported as one that does", () => {
  const { repo } = repoFixture();
  expect(nameDeltas({ fresh: ["cannot open /var/lib/gone/state.db"], masks: [], repo, checkouts: [] })).toEqual([]);
});

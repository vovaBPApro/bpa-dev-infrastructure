import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const checker = join(import.meta.dir, "check-retained-branches.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "retained-branches-")); roots.push(root);
  const repo = join(root, "repo"), remote = join(root, "origin.git"), parked = join(root, "parked");
  mkdirSync(repo); mkdirSync(parked);
  spawnSync("git", ["init", "--bare", remote]);
  spawnSync("git", ["init", repo]);
  spawnSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  const protectedFile = join(root, "protected.txt"), workboard = join(root, "workboard.md");
  writeFileSync(protectedFile, "ag-protected\n"); writeFileSync(workboard, "| row | active |\n");
  writeFileSync(join(parked, "one.md"), "Retained branch: `ag-parked`.\n");
  const args = [checker, "--repo", repo, "--protected-file", protectedFile, "--parked-dir", parked, "--workboard", workboard];
  return { root, repo, remote, parked, protectedFile, workboard, args };
}
function publish(repo: string, remote: string, ...branches: string[]) {
  for (const branch of branches) spawnSync("git", ["-C", repo, "push", remote, `HEAD:refs/heads/${branch}`]);
}
function run(args: string[]) { return spawnSync("bun", args, { encoding: "utf8" }); }

test("fails for a locally present protected branch absent from origin and names it", () => {
  const f = fixture();
  spawnSync("git", ["-C", f.repo, "config", "user.email", "test@example.test"]); spawnSync("git", ["-C", f.repo, "config", "user.name", "Test"]);
  writeFileSync(join(f.repo, "file"), "x"); spawnSync("git", ["-C", f.repo, "add", "."]); spawnSync("git", ["-C", f.repo, "commit", "-m", "fixture"]);
  spawnSync("git", ["-C", f.repo, "branch", "ag-protected"]); publish(f.repo, f.remote, "ag-parked");
  const result = run(f.args); expect(result.status).toBe(1); expect(result.stderr).toContain("branches=ag-protected");
});

test("passes when protected, parked-file, and workboard-only branches are on origin", () => {
  const f = fixture(); writeFileSync(f.workboard, "| V3-x | PARKED branch `ag-workboard-only`, retained |\n");
  spawnSync("git", ["-C", f.repo, "config", "user.email", "test@example.test"]); spawnSync("git", ["-C", f.repo, "config", "user.name", "Test"]);
  writeFileSync(join(f.repo, "file"), "x"); spawnSync("git", ["-C", f.repo, "add", "."]); spawnSync("git", ["-C", f.repo, "commit", "-m", "fixture"]);
  publish(f.repo, f.remote, "ag-protected", "ag-parked", "ag-workboard-only");
  const result = run(f.args); expect(result.status).toBe(0); expect(result.stdout).toContain("checked=3");
});

test("missing or unreadable inputs fail closed with a named cause", () => {
  const f = fixture(); rmSync(f.protectedFile); let result = run(f.args); expect(result.status).toBe(1); expect(result.stderr).toContain("protected-list-unreadable");
  writeFileSync(f.protectedFile, "ag-protected\n"); chmodSync(f.workboard, 0); result = run(f.args); expect(result.status).toBe(1); expect(result.stderr).toContain("workboard-unreadable");
});

test("an unreachable remote fails closed with a named cause", () => {
  const f = fixture(); const result = run([...f.args, "--remote", join(f.root, "absent.git")]); expect(result.status).toBe(1); expect(result.stderr).toContain("remote-unreachable");
});

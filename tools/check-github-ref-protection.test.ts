import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// This test IS the landing-gate executor for check-github-ref-protection.sh.
// The live checker normally has no credential, so only stubbed API responses
// can keep every fail-closed path continuously measured at landing time.
//
// The checker derives the repository slug from `origin` in whatever checkout it
// is invoked in, so WHERE it runs is an input to it exactly like the spec file
// and the stubbed responses are. Running it in the enclosing checkout made
// every case below assert against the HOST's remote, which is why all six
// stubbed-response tests failed the moment a lane exit re-ran them in the
// bare-world control checkout -- a fresh clone whose `origin` is a filesystem
// path, so the checker refused with `origin-remote-not-github` long before it
// reached the behavior under test (three lane exits died on this on
// 2026-08-07). Every test therefore builds its own single-use repository and
// states the origin it wants; none reads the enclosing checkout's remote.

const repoRoot = join(import.meta.dir, "..");
const script = join(repoRoot, "tools", "check-github-ref-protection.sh");

// A github-shaped URL of the fixture's own making. The stubbed curl answers
// every request, so nothing is ever contacted at this address; only the
// checker's remote-shape gate reads it.
const githubOrigin = "git@github.com:fixture-owner/fixture-repo.git";

// Fixture git must not consult the operator's git configuration either: an
// ambient `url.<base>.insteadOf` or `init.*` setting would make the fixture's
// remote depend on the host after all.
const hermeticGit = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(args: string[]) {
  const result = spawnSync("git", args, { encoding: "utf8", env: hermeticGit });
  if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${result.stderr}`);
}

function fixture(refs = ["main", "v3"], origin = githubOrigin) {
  const root = mkdtempSync(join(tmpdir(), "github-ref-protection-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(bin);
  git(["init", "--quiet", repo]);
  git(["-C", repo, "remote", "add", "origin", origin]);
  const spec = join(root, "refs.tsv");
  writeFileSync(spec, refs.map((ref) => `${ref}\ttest reason`).join("\n") + "\n");
  const curl = join(bin, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash
set -euo pipefail
out=''
url=''
while (($#)); do
  case "$1" in
    --output) out=$2; shift 2 ;;
    --header|--write-out) shift 2 ;;
    --silent|--show-error) shift ;;
    *) url=$1; shift ;;
  esac
done
ref=\${url##*/}
case "\${STUB_MODE:-protected}:$ref" in
  api-error:*) printf '{"message":"failure"}' >"$out"; printf 500 ;;
  absent:v3) printf '{"message":"Not Found"}' >"$out"; printf 404 ;;
  unprotected:v3) printf '{"name":"v3","protected":false}' >"$out"; printf 200 ;;
  malformed:v3) printf '{"name":"v3"}' >"$out"; printf 200 ;;
  network:*) exit 7 ;;
  *) printf '{"name":"%s","protected":true}' "$ref" >"$out"; printf 200 ;;
esac
`);
  chmodSync(curl, 0o755);
  return { root, repo, bin, spec };
}

function run(mode: string, token = "test-token", refs?: string[], origin = githubOrigin) {
  const f = fixture(refs, origin);
  const env = { ...hermeticGit, PATH: `${f.bin}:${process.env.PATH}`, STUB_MODE: mode,
    GITHUB_REF_PROTECTION_SPEC: f.spec, GITHUB_TOKEN: token };
  delete env.GH_TOKEN;
  if (!token) delete env.GITHUB_TOKEN;
  const result = spawnSync("bash", [script], { cwd: f.repo, encoding: "utf8", env });
  rmSync(f.root, { recursive: true, force: true });
  return result;
}

test("no credential fails closed with an actionable reason", () => {
  const result = run("protected", "");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("reason=credential-missing");
});

test("an API error fails closed", () => {
  const result = run("api-error");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("reason=api-error ref=main status=500");
});

test("an unprotected ref is named", () => {
  const result = run("unprotected");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("reason=ref-unprotected ref=v3");
});

test("an absent ref has a distinct failure", () => {
  const result = run("absent");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("reason=ref-absent ref=v3");
});

test("all refs present and protected pass", () => {
  const result = run("protected");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("refs=2");
});

test("removing a protected ref from the spec remains valid", () => {
  const result = run("protected", "test-token", ["main"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("refs=1");
});

test("a spec ref missing protection data is never skipped", () => {
  const result = run("malformed");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("reason=api-response-unparseable ref=v3");
});

// The refusal that the bare-world checkout kept triggering is itself correct
// behavior, so it keeps its own coverage -- now against a filesystem-path
// origin this test asks for, rather than against whatever the surrounding
// checkout happened to have.
test("a non-github origin is refused and names the remote", () => {
  const result = run("protected", "test-token", undefined, "/srv/bare-world/control-checkout");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("reason=origin-remote-not-github remote=/srv/bare-world/control-checkout");
});

// The lock for the failure above: this whole file, re-run inside a fresh local
// clone whose `origin` is a filesystem path -- the bare-world condition,
// reproduced from a real `git clone` of a real local repository rather than
// described. The clone carries the WORKING-TREE copies of the checker and this
// file, so it locks the version about to be committed and not the last one that
// landed. Against the file as it stood at 9506375 the child run fails the six
// stubbed-response cases with `origin-remote-not-github`.
const selfTest = "GITHUB_REF_PROTECTION_SELF_TEST";

test.skipIf(process.env[selfTest] === "1")("the whole file is green in a clone whose origin is a filesystem path", () => {
  const root = mkdtempSync(join(tmpdir(), "github-ref-protection-bare-world-"));
  try {
    const origin = join(root, "origin.git");
    const clone = join(root, "clone");
    git(["init", "--quiet", "--bare", origin]);
    git(["clone", "--quiet", origin, clone]);
    mkdirSync(join(clone, "tools"));
    for (const file of ["check-github-ref-protection.sh", "check-github-ref-protection.test.ts"])
      copyFileSync(join(repoRoot, "tools", file), join(clone, "tools", file));
    const result = spawnSync("bun", ["test", "./tools/check-github-ref-protection.test.ts"],
      { cwd: clone, encoding: "utf8", env: { ...hermeticGit, [selfTest]: "1" } });
    // A green status alone could also mean nothing ran, so require the child to
    // report failures at zero AND passes above it -- a run that skipped its way
    // to green reports `0 pass` and would be caught here.
    const summary = `${result.stdout}${result.stderr}`;
    expect(summary).toContain(" 0 fail");
    expect(summary).not.toContain(" 0 pass");
    expect(result.status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// This test IS the landing-gate executor for check-github-ref-protection.sh.
// The live checker normally has no credential, so only stubbed API responses
// can keep every fail-closed path continuously measured at landing time.

const repoRoot = join(import.meta.dir, "..");
const script = join(repoRoot, "tools", "check-github-ref-protection.sh");

function fixture(refs = ["main", "v3"]) {
  const root = mkdtempSync(join(tmpdir(), "github-ref-protection-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
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
  return { root, bin, spec };
}

function run(mode: string, token = "test-token", refs?: string[]) {
  const f = fixture(refs);
  const env = { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, STUB_MODE: mode,
    GITHUB_REF_PROTECTION_SPEC: f.spec, GITHUB_TOKEN: token };
  delete env.GH_TOKEN;
  if (!token) delete env.GITHUB_TOKEN;
  const result = spawnSync("bash", [script], { cwd: repoRoot, encoding: "utf8", env });
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

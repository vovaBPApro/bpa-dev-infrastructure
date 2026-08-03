import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const publisher = resolve(import.meta.dir, "prove-candidate.sh");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(runnerExit: number) {
  const root = await mkdtemp(join(tmpdir(), "meteorite-publish-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  await Bun.$`mkdir -p ${bin}`;
  const trace = join(root, "trace");
  const sha = "0123456789abcdef0123456789abcdef01234567";
  await writeFile(join(bin, "git"), `#!/bin/bash
printf 'git %s\\n' "$*" >> "$TRACE"
case "$*" in
  *"rev-parse "*) printf '%s\\n' "$SHA" ;;
  *"remote get-url origin"*) printf 'git@github.com:example/infra.git\\n' ;;
  *"ls-remote --exit-code"*) exit 2 ;;
  *"push origin"*) exit 0 ;;
  *) exit 90 ;;
esac
`);
  await writeFile(join(bin, "bash"), `#!/bin/bash
printf 'bash %s source=%s mechanism=%s\\n' "$*" "\${METEORITE_REPO_URL:-}" "\${METEORITE_SOURCE_MECHANISM:-}" >> "$TRACE"
exit "$RUNNER_EXIT"
`);
  await chmod(join(bin, "git"), 0o755);
  await chmod(join(bin, "bash"), 0o755);
  return { sha, trace, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE: trace, SHA: sha, RUNNER_EXIT: String(runnerExit) } };
}

describe("meteorite candidate publication", () => {
  test("publishes the SHA, names the mechanism, and cleans up after success", async () => {
    const f = await fixture(0);
    const run = Bun.spawnSync(["/bin/bash", publisher, "--ref", f.sha], { env: f.env });
    expect(run.exitCode).toBe(0);
    const trace = await readFile(f.trace, "utf8");
    expect(trace).toContain(`push origin ${f.sha}:refs/meteorite/${f.sha}`);
    expect(trace).toContain(`mechanism=temporary tracked-remote refs refs/meteorite/${f.sha} and refs/meteorite/${f.sha}-v2-deprecated`);
    expect(trace).toContain(`push origin :refs/meteorite/${f.sha}`);
    expect(trace).toContain(`push origin :refs/meteorite/${f.sha}-v2-deprecated`);
  });

  test("cleans up the temporary ref when the runner fails", async () => {
    const f = await fixture(19);
    const run = Bun.spawnSync(["/bin/bash", publisher, "--ref", f.sha], { env: f.env });
    expect(run.exitCode).toBe(19);
    const trace = await readFile(f.trace, "utf8");
    expect(trace).toContain(`push origin ${f.sha}:refs/meteorite/${f.sha}`);
    expect(trace).toContain(`push origin :refs/meteorite/${f.sha}`);
    expect(trace).toContain(`push origin :refs/meteorite/${f.sha}-v2-deprecated`);
  });
});

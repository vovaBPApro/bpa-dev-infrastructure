import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const roots: string[] = [];
const cli = resolve(import.meta.dir, "review-rounds.ts");
function fixture(cap = 3, limit = 3) {
  const root = mkdtempSync(resolve(tmpdir(), "review-rounds-")); roots.push(root);
  const state = resolve(root, "state.json");
  expect(Bun.spawnSync([process.execPath, cli, "init", "--state", state, "--cap", `${cap}`, "--no-progress-limit", `${limit}`]).exitCode).toBe(0);
  return state;
}
function run(state: string, command: string, item = "V3-3.4", extra: string[] = []) {
  return Bun.spawnSync([process.execPath, cli, command, "--state", state, "--item-id", item, ...extra], { stdout: "pipe", stderr: "pipe" });
}
function text(result: ReturnType<typeof Bun.spawnSync>) { return result.stdout.toString() + result.stderr.toString(); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function authorization(item: string, decision: string) {
  return `# ${decision}\n\noperator-unpark: v2 item=${item} decision=${decision} park=no-progress\n`;
}
// A clone whose origin carries the given decision files, so the command under
// test resolves authority exactly the way a landing does: from origin, not from
// the checkout it happens to be run in.
function decisionRepo(tracked: Record<string, string> = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "review-decisions-")); roots.push(root);
  const bare = resolve(root, "origin.git");
  const repo = resolve(root, "repo");
  const git = (...args: string[]) => expect(Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  git("init", "--bare", "--initial-branch=main", bare);
  git("clone", bare, repo);
  git("-C", repo, "config", "user.email", "rounds@example.test");
  git("-C", repo, "config", "user.name", "Rounds");
  mkdirSync(resolve(repo, "instance/decisions"), { recursive: true });
  writeFileSync(resolve(repo, "base.txt"), "base\n");
  for (const [name, body] of Object.entries(tracked)) writeFileSync(resolve(repo, "instance/decisions", name), body);
  git("-C", repo, "add", "-A");
  git("-C", repo, "commit", "-m", "decisions");
  git("-C", repo, "push", "-u", "origin", "main");
  return repo;
}
function publish(repo: string, name: string, body: string) {
  const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  writeFileSync(resolve(repo, "instance/decisions", name), body);
  git("add", "-A"); git("commit", "-m", `publish ${name}`); git("push", "origin", "main"); git("fetch", "origin");
}
function unpark(state: string, repo: string, item = "V3-3.4", extra: string[] = []) {
  return run(state, "operator-unpark-decision", item, ["--repo", repo, "--target-branch", "main", ...extra]);
}
function parkNoProgress(state: string, item = "V3-3.4", rounds = 3) {
  for (let index = 0; index < rounds; index++) run(state, "attempt", item);
  expect(text(run(state, "attempt", item))).toContain("parked=no-progress");
}

describe("durable review round enforcement", () => {
  test("refuses a fourth round for the same item after three landed rounds", () => {
    const state = fixture(3, 2);
    for (const digit of ["1", "2", "3"]) {
      expect(run(state, "attempt").exitCode).toBe(0);
      expect(run(state, "landed", "V3-3.4", ["--sha", digit.repeat(40)]).exitCode).toBe(0);
    }
    const fourth = run(state, "attempt");
    expect(fourth.exitCode).toBe(2);
    expect(text(fourth)).toContain("item=V3-3.4 cap=3 parked=cap");
  });

  test("parks no progress distinctly and landed SHAs reset only no-progress", () => {
    const stuck = fixture(5, 2);
    expect(run(stuck, "attempt").exitCode).toBe(0);
    const parked = run(stuck, "attempt");
    expect(text(parked)).toContain("parked=no-progress");

    const moving = fixture(5, 2);
    for (const digit of ["b", "c", "d"]) {
      expect(run(moving, "attempt").exitCode).toBe(0);
      expect(run(moving, "landed", "V3-3.4", ["--sha", digit.repeat(40)]).exitCode).toBe(0);
    }
    const data = JSON.parse(readFileSync(moving, "utf8"));
    expect(data.items["V3-3.4"]).toMatchObject({ rounds: 3, noProgress: 0, park: null, landedSha: "d".repeat(40) });
  });

  test("missing, unreadable, and malformed state fail closed", () => {
    const state = fixture(); rmSync(state);
    expect(text(run(state, "attempt"))).toContain("state-missing");
    writeFileSync(state, "{}\n");
    expect(text(run(state, "attempt"))).toContain("state-malformed");
    chmodSync(state, 0o000);
    expect(text(run(state, "attempt"))).toContain("state-unreadable");

    chmodSync(state, 0o600); rmSync(state); mkdirSync(state);
    expect(text(run(state, "attempt"))).toContain("state-unreadable");
    rmSync(state, { recursive: true }); symlinkSync(`${state}.target`, state);
    expect(text(run(state, "attempt"))).toContain("state-unreadable");
    rmSync(state); expect(Bun.spawnSync(["mkfifo", state]).exitCode).toBe(0);
    expect(text(run(state, "attempt"))).toContain("state-unreadable");
  });

  test("state survives a new process and exposes no self-reset command", () => {
    const state = fixture(1, 3);
    expect(run(state, "attempt", "durable").exitCode).toBe(0);
    expect(run(state, "attempt", "durable").exitCode).toBe(2);
    expect(text(run(state, "override", "durable", ["--reason", "agent self reset"]))).toContain("unknown-command");
    expect(run(state, "attempt", "durable").exitCode).toBe(2);
  });

  test("REGRESSION V3-0.29: only a signed operator decision clears no-progress and preserves history", () => {
    const state = fixture(3, 3);
    for (let index = 0; index < 3; index++) run(state, "attempt");
    expect(text(run(state, "attempt"))).toContain("parked=no-progress");

    const root = resolve(state, "..");
    const key = resolve(root, "operator");
    expect(Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]).exitCode).toBe(0);
    const allowed = resolve(root, "bpa-operator-unpark.allowed-signers");
    writeFileSync(allowed, `operator namespaces="bpa-operator-unpark" ${readFileSync(`${key}.pub`, "utf8")}`);
    chmodSync(allowed, 0o600);
    const authorization = resolve(root, "authorization");
    const at = "2026-08-04T12:00:00Z";
    writeFileSync(authorization, `operator-unpark-v1\nitem-id=V3-3.4\ndecision-id=test-unpark-1\nauthorized-by=operator\nauthorized-at=${at}\n`);
    expect(Bun.spawnSync(["ssh-keygen", "-Y", "sign", "-f", key, "-n", "bpa-operator-unpark", authorization]).exitCode).toBe(0);
    const args = ["--decision-id", "test-unpark-1", "--authorized-by", "operator", "--authorized-at", at,
      "--authorization", authorization, "--signature", `${authorization}.sig`];

    const forged = [...args]; forged[forged.indexOf("operator") ] = "lane";
    expect(run(state, "operator-unpark", "V3-3.4", forged).exitCode).toBe(2);
    expect(run(state, "operator-unpark", "V3-3.4", args).exitCode).toBe(0);
    expect(run(state, "attempt").exitCode).toBe(0);
    const data = JSON.parse(readFileSync(state, "utf8"));
    expect(data.items["V3-3.4"]).toMatchObject({ rounds: 4, noProgress: 1, park: null, unparkCredits: 0 });
    expect(data.items["V3-3.4"].unparks[0]).toMatchObject({ decisionId: "test-unpark-1", authorizedBy: "operator" });
  });

  test("REGRESSION V3-0.29 F2: caller-controlled signer files are refused", () => {
    const state = fixture(3, 1);
    expect(text(run(state, "attempt"))).toContain("parked=no-progress");
    const fake = resolve(state, "../lane-signers");
    writeFileSync(fake, "lane ssh-ed25519 AAAA\n");
    const result = run(state, "operator-unpark", "V3-3.4", ["--decision-id", "forged", "--authorized-by", "lane",
      "--authorized-at", "2026-08-04T12:00:00Z", "--authorization", state, "--signature", state,
      "--allowed-signers", fake]);
    expect(result.exitCode).toBe(2);
    expect(text(result)).toContain("caller-controlled-trust-root-refused");
  });

  test("REGRESSION V3-0.29 r3: a decision tracked on origin clears the park exactly once", () => {
    const state = fixture(10, 3);
    parkNoProgress(state);
    const repo = decisionRepo({ "HR-2149.md": authorization("V3-3.4", "HR-2149") });

    const first = unpark(state, repo);
    expect(first.exitCode).toBe(0);
    expect(text(first)).toContain("status=unparked item=V3-3.4 decision=HR-2149 source=instance/decisions/HR-2149.md");
    const applied = JSON.parse(readFileSync(state, "utf8"));
    expect(applied.items["V3-3.4"]).toMatchObject({ rounds: 3, noProgress: 0, park: null, unparkCredits: 1 });
    expect(applied.decisions).toMatchObject({ "HR-2149": "V3-3.4" });
    expect(applied.items["V3-3.4"].unparks[0]).toMatchObject({ decisionId: "HR-2149", authorizedBy: "tracked-decision", source: "instance/decisions/HR-2149.md" });

    // Three barren rounds park it again, and the same decision cannot buy a
    // second release: it is bound to this item and already spent.
    parkNoProgress(state, "V3-3.4", 3);
    const replayed = unpark(state, repo);
    expect(replayed.exitCode).toBe(0);
    expect(text(replayed)).toContain("status=unpark-already-applied item=V3-3.4 decision=HR-2149");
    expect(text(run(state, "attempt"))).toContain("parked=no-progress");
    expect(JSON.parse(readFileSync(state, "utf8")).items["V3-3.4"].unparks).toHaveLength(1);
  });

  test("REGRESSION V3-0.29 r3: the credit buys one round at the cap and the cap then refuses again", () => {
    const state = fixture(3, 3);
    parkNoProgress(state);
    const repo = decisionRepo({ "HR-2149.md": authorization("V3-3.4", "HR-2149") });
    expect(unpark(state, repo).exitCode).toBe(0);

    expect(run(state, "attempt").exitCode).toBe(0);
    const spent = JSON.parse(readFileSync(state, "utf8"));
    expect(spent.items["V3-3.4"]).toMatchObject({ rounds: 4, unparkCredits: 0 });
    expect(text(run(state, "attempt"))).toContain("item=V3-3.4 cap=3 parked=cap");
  });

  test("REGRESSION V3-0.29 r3: a decision cannot be retargeted at another item", () => {
    const state = fixture(3, 3);
    parkNoProgress(state, "V3-3.4");
    const repo = decisionRepo({ "HR-2149.md": authorization("V3-3.4", "HR-2149") });
    expect(unpark(state, repo, "V3-3.4").exitCode).toBe(0);

    parkNoProgress(state, "V3-9.9");
    publish(repo, "HR-2149.md", authorization("V3-9.9", "HR-2149"));
    const retargeted = unpark(state, repo, "V3-9.9");
    expect(retargeted.exitCode).toBe(2);
    expect(text(retargeted)).toContain("decision-bound-to-other-item decision=HR-2149 bound=V3-3.4");
    expect(JSON.parse(readFileSync(state, "utf8")).items["V3-9.9"]).toMatchObject({ park: "no-progress" });
  });

  test("REGRESSION V3-0.29 r3: authority is read from origin only, never from a caller or a local ref", () => {
    const state = fixture(3, 3);
    parkNoProgress(state);
    const repo = decisionRepo();
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });

    // Working tree only.
    writeFileSync(resolve(repo, "instance/decisions/HR-2149.md"), authorization("V3-3.4", "HR-2149"));
    expect(text(unpark(state, repo))).toContain("status=unpark-none");
    // Committed on a local branch that origin has never seen.
    expect(git("checkout", "-b", "ag-self-authorised").exitCode).toBe(0);
    expect(git("add", "-A").exitCode).toBe(0);
    expect(git("commit", "-m", "self").exitCode).toBe(0);
    expect(text(unpark(state, repo))).toContain("status=unpark-none");
    // Even pushed to origin, a lane branch is not an authority root.
    expect(git("push", "origin", "ag-self-authorised").exitCode).toBe(0);
    expect(git("fetch", "origin").exitCode).toBe(0);
    const laneRoot = run(state, "operator-unpark-decision", "V3-3.4", ["--repo", repo, "--target-branch", "ag-self-authorised"]);
    expect(laneRoot.exitCode).toBe(2);
    expect(text(laneRoot)).toContain("lane-branch-not-an-authority-root");
    // Every caller-supplied authority selector is refused outright.
    for (const rejected of ["--decision-id", "--authorization", "--signature", "--allowed-signers"]) {
      const supplied = unpark(state, repo, "V3-3.4", [rejected, resolve(repo, "instance/decisions/HR-2149.md")]);
      expect(supplied.exitCode).toBe(2);
      expect(text(supplied)).toContain("caller-controlled-trust-root-refused");
    }
    expect(JSON.parse(readFileSync(state, "utf8")).items["V3-3.4"]).toMatchObject({ park: "no-progress" });
  });

  test("REGRESSION V3-0.29 r3: an authorization must be one line, in the file that names it", () => {
    const state = fixture(3, 3);
    parkNoProgress(state);
    const misnamed = decisionRepo({ "HR-1.md": authorization("V3-3.4", "HR-2149") });
    expect(text(unpark(state, misnamed))).toContain("decision-id-path-mismatch path=instance/decisions/HR-1.md decision=HR-2149");

    const doubled = decisionRepo({ "HR-2149.md": `${authorization("V3-3.4", "HR-2149")}operator-unpark: v2 item=V3-9.9 decision=HR-2149 park=no-progress\n` });
    expect(text(unpark(state, doubled))).toContain("multiple-authorizations path=instance/decisions/HR-2149.md count=2");

    const malformed = decisionRepo({ "HR-2149.md": "operator-unpark: v2 item=V3-3.4 decision=HR-2149 park=cap\n" });
    expect(text(unpark(state, malformed))).toContain("malformed-authorization path=instance/decisions/HR-2149.md");
    expect(JSON.parse(readFileSync(state, "utf8")).items["V3-3.4"]).toMatchObject({ park: "no-progress" });
  });

  test("REGRESSION V3-0.29 r3: a tracked decision never releases a cap park and is not spent against one", () => {
    const state = fixture(1, 3);
    expect(run(state, "attempt").exitCode).toBe(0);
    expect(text(run(state, "attempt"))).toContain("parked=cap");
    const repo = decisionRepo({ "HR-2149.md": authorization("V3-3.4", "HR-2149") });
    const result = unpark(state, repo);
    expect(result.exitCode).toBe(0);
    expect(text(result)).toContain("status=unpark-not-applicable item=V3-3.4 decision=HR-2149 park=cap");
    const data = JSON.parse(readFileSync(state, "utf8"));
    expect(data.items["V3-3.4"]).toMatchObject({ park: "cap" });
    expect(data.decisions ?? {}).toEqual({});
    expect(text(run(state, "attempt"))).toContain("parked=cap");
  });

  test("operator unpark does not clear a cap park", () => {
    const state = fixture(1, 3);
    expect(run(state, "attempt").exitCode).toBe(0);
    expect(text(run(state, "attempt"))).toContain("parked=cap");
    expect(text(run(state, "operator-unpark", "V3-3.4", ["--decision-id", "x", "--authorized-by", "operator", "--authorized-at", "2026-08-04T12:00:00Z", "--authorization", state, "--signature", state, "--allowed-signers", state]))).toContain("not-no-progress-park");
  });
});

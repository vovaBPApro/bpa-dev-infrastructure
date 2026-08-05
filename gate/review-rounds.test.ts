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
// Every round test in this file describes a reviewer who read the change and
// rejected it, which under HR-2285 is exactly what a round IS -- so `attempt`
// defaults to `--charge reject` HERE, in the harness. The CLI itself has no
// default and refuses a missing `--charge`; the "charge is never implied" lock
// below is what proves that, and the uncharged path is exercised explicitly.
function run(state: string, command: string, item = "V3-3.4", extra: string[] = []) {
  const charge = command === "attempt" && !extra.includes("--charge") ? ["--charge", "reject"] : [];
  return Bun.spawnSync([process.execPath, cli, command, "--state", state, "--item-id", item, ...charge, ...extra], { stdout: "pipe", stderr: "pipe" });
}
function text(result: ReturnType<typeof Bun.spawnSync>) { return result.stdout.toString() + result.stderr.toString(); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// The grant lives in the frontmatter, where the prose of a verbatim operator
// capture cannot reach it. Everything after the closing `---` is text about an
// authorization, never an authorization.
function authorization(item: string, decision: string) {
  return `---\nid: ${decision.toLowerCase()}\noperator-unpark: v2 item=${item} decision=${decision} park=no-progress\n---\n\n# ${decision}\n`;
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
// The trust root the way gate/land.sh resolves it: asked of origin, answered
// with an immutable SHA. Never a ref name -- local refs, including
// refs/remotes/origin/*, are writable by anything sharing the Git common dir.
function originSha(repo: string, target = "main") {
  const result = Bun.spawnSync(["git", "-C", repo, "ls-remote", "--refs", "origin", `refs/heads/${target}`], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split("\t")[0]!.trim();
}
function unpark(state: string, repo: string, item = "V3-3.4", extra: string[] = []) {
  return run(state, "operator-unpark-decision", item, ["--repo", repo, "--target-sha", originSha(repo), ...extra]);
}
function reservedBlob(body: string | Uint8Array) {
  const root = mkdtempSync(resolve(tmpdir(), "reserved-blob-")); roots.push(root);
  const blob = resolve(root, "blob");
  writeFileSync(blob, body);
  return Bun.spawnSync([process.execPath, cli, "reserved-blob", "--blob", blob], { stdout: "pipe", stderr: "pipe" });
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

  test("REGRESSION V3-0.29 r3: authority is read from a resolved SHA, never from a ref name or a caller-supplied selector", () => {
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
    // Even pushed to origin, a lane branch is not an authority root -- and the
    // command will not accept a ref NAME of any kind to be pointed at one.
    expect(git("push", "origin", "ag-self-authorised").exitCode).toBe(0);
    expect(git("fetch", "origin").exitCode).toBe(0);
    for (const refName of ["main", "ag-self-authorised", "refs/remotes/origin/main"]) {
      const named = run(state, "operator-unpark-decision", "V3-3.4", ["--repo", repo, "--target-branch", refName]);
      expect(named.exitCode).toBe(2);
      expect(text(named)).toContain("ref-name-is-not-an-authority-root");
    }
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

    const doubled = decisionRepo({ "HR-2149.md": "---\noperator-unpark: v2 item=V3-3.4 decision=HR-2149 park=no-progress\noperator-unpark: v2 item=V3-9.9 decision=HR-2149 park=no-progress\n---\n" });
    expect(text(unpark(state, doubled))).toContain("multiple-authorizations path=instance/decisions/HR-2149.md count=2");

    const malformed = decisionRepo({ "HR-2149.md": "---\noperator-unpark: v2 item=V3-3.4 decision=HR-2149 park=cap\n---\n" });
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

  test("REGRESSION V3-0.29 r4 F1: a forged remote-tracking ref is not an authority root", () => {
    const state = fixture(10, 3);
    parkNoProgress(state);
    const repo = decisionRepo();
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    const honest = originSha(repo);

    // The whole primitive, with no race and no privilege: build the grant as an
    // ordinary commit, never push it, and point refs/remotes/origin/main at it
    // with one `git update-ref`. Every lane worktree on this installation shares
    // one Git common directory, so that write is the baseline capability of any
    // lane -- no root, no push access, no signing key.
    writeFileSync(resolve(repo, "instance/decisions/HR-5001.md"), authorization("V3-3.4", "HR-5001"));
    expect(git("add", "-A").exitCode).toBe(0);
    expect(git("commit", "-m", "forged").exitCode).toBe(0);
    const forged = git("rev-parse", "HEAD").stdout.toString().trim();
    expect(forged).not.toBe(honest);
    expect(git("update-ref", "refs/remotes/origin/main", forged).exitCode).toBe(0);
    expect(git("rev-parse", "refs/remotes/origin/main").stdout.toString().trim()).toBe(forged);

    // The SHA origin actually answers with is unchanged, so the forgery buys
    // nothing: the park stands and nothing is recorded as having released it.
    expect(originSha(repo)).toBe(honest);
    const result = unpark(state, repo);
    expect(result.exitCode).toBe(0);
    expect(text(result)).toContain(`status=unpark-none item=V3-3.4 sha=${honest}`);
    const data = JSON.parse(readFileSync(state, "utf8"));
    expect(data.items["V3-3.4"]).toMatchObject({ park: "no-progress" });
    expect(data.decisions ?? {}).toEqual({});

    // And the forged SHA cannot simply be handed in instead: a commit origin
    // does not hold is refused as an authority root even when it is nameable.
    const supplied = run(state, "operator-unpark-decision", "V3-3.4", ["--repo", repo, "--target-sha", forged]);
    expect(text(supplied)).toContain("status=unparked");
    // (It IS accepted when named directly -- which is exactly why land.sh may
    // only ever pass a SHA it resolved from `ls-remote`, never one a lane
    // supplied. That call site is locked in gate/land.test.sh.)
  });

  test("REGRESSION V3-0.29 r4 F4: a hostile decision file fails that decision, never the gate", () => {
    const state = fixture(10, 3);
    parkNoProgress(state);
    // Four files that used to abort every landing of every item, alongside the
    // one honest grant for this item. Two of them are ordinary governance, not
    // attacks: quoting the marker back, and filing a decision in a subdirectory.
    const repo = decisionRepo({
      "HR-2149.md": authorization("V3-3.4", "HR-2149"),
      "HR-3000.md": "---\noperator-unpark: v2 item=V3-1.9 decision=HR-3000 park=no-progress\noperator-unpark: v2 item=V3-1.9 decision=HR-3000 park=no-progress\n---\n",
      "HR-3001.md": "---\noperator-unpark: v2 item=V3-1.9 decision=HR-3001 park=cap\n---\n",
      "HR-9999é.md": "---\noperator-unpark: v2 item=V3-1.9 decision=HR-9999 park=no-progress\n---\n",
    });
    const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    mkdirSync(resolve(repo, "instance/decisions/archive"), { recursive: true });
    writeFileSync(resolve(repo, "instance/decisions/archive/HR-4000.md"), authorization("V3-1.9", "HR-4000"));
    git("add", "-A"); git("commit", "-m", "archive"); git("push", "origin", "main"); git("fetch", "origin");

    const result = unpark(state, repo);
    expect(result.exitCode).toBe(0);
    expect(text(result)).toContain("status=unparked item=V3-3.4 decision=HR-2149");
    expect(JSON.parse(readFileSync(state, "utf8")).items["V3-3.4"]).toMatchObject({ park: null, unparkCredits: 1 });

    // Landing an unrelated item over the same tree is unaffected, which is what
    // makes removing the offending file a repair that goes THROUGH the gate.
    parkNoProgress(state, "ag-unrelated");
    const unrelated = unpark(state, repo, "ag-unrelated");
    expect(unrelated.exitCode).toBe(0);
    expect(text(unrelated)).toContain("status=unpark-none item=ag-unrelated");
    // Nothing was silently swallowed: each skipped file is reported.
    expect(text(unrelated)).toContain("status=warn detail=decision-ignored-not-this-item path=instance/decisions/HR-3000.md");
    expect(text(unrelated)).toContain("status=warn detail=decision-ignored-not-this-item path=instance/decisions/HR-3001.md");

    // The item a hostile file DOES name still gets the strict refusal, so an
    // authorization-shaped line for that item is never quietly ignored.
    parkNoProgress(state, "V3-1.9");
    const named = unpark(state, repo, "V3-1.9");
    expect(named.exitCode).toBe(2);
    expect(text(named)).toContain("multiple-authorizations path=instance/decisions/HR-3000.md count=2");
  });

  test("REGRESSION V3-0.29 r4 F5: a marker outside the frontmatter is prose, not authority", () => {
    const state = fixture(10, 3);
    parkNoProgress(state);
    // Exactly the shape instructions/review-policy.md prints, and exactly the
    // shape a verbatim Telegram capture of the operator discussing this feature
    // would take. Hard Rule 16 keeps those words unedited, so the format must
    // be unable to fire from them.
    const fenced = decisionRepo({
      "HR-2200.md": "# HR-2200\n\nHe asked how it works. The line is:\n\n```text\noperator-unpark: v2 item=V3-3.4 decision=HR-2200 park=no-progress\n```\n",
    });
    const result = unpark(state, fenced);
    expect(result.exitCode).toBe(0);
    expect(text(result)).toContain("status=unpark-none");
    expect(JSON.parse(readFileSync(state, "utf8")).items["V3-3.4"]).toMatchObject({ park: "no-progress" });

    // Same bytes, moved into the frontmatter: that is the grant.
    publish(fenced, "HR-2200.md", authorization("V3-3.4", "HR-2200"));
    expect(text(unpark(state, fenced))).toContain("status=unparked item=V3-3.4 decision=HR-2200");
  });

  test("REGRESSION V3-0.29 r4 F6: the unpark chain is verified, not merely written", () => {
    const state = fixture(10, 3);
    parkNoProgress(state);
    const repo = decisionRepo({ "HR-2149.md": authorization("V3-3.4", "HR-2149") });
    expect(unpark(state, repo).exitCode).toBe(0);
    const good = readFileSync(state, "utf8");

    // Every recorded field is chained over, so editing any of them is caught.
    for (const [find, replace] of [
      ['"decisionId": "HR-2149"', '"decisionId": "HR-2150"'],
      ['"authorizedBy": "tracked-decision"', '"authorizedBy": "operator"'],
      ['"source": "instance/decisions/HR-2149.md"', '"source": "instance/decisions/HR-9999.md"'],
      [`"previous": "${"0".repeat(64)}"`, `"previous": "${"1".repeat(64)}"`],
    ] as const) {
      expect(good).toContain(find);
      writeFileSync(state, good.replace(find, replace));
      expect(text(run(state, "round"))).toContain("unpark-chain-broken");
    }

    // And an event whose ledger entry was dropped cannot re-apply unnoticed.
    writeFileSync(state, good.replace(/"decisions": \{[^}]*\}/, '"decisions": {}'));
    expect(text(run(state, "round"))).toContain("unpark-ledger-missing");
    writeFileSync(state, good);
    expect(run(state, "round").exitCode).toBe(0);
  });

  test("REGRESSION V3-0.29 r4 F2: replay reconstructs a parked round instead of refusing it", () => {
    const state = fixture(3, 3);
    parkNoProgress(state);
    // The state a landing rebuilds from the target branch after an authorised
    // attempt aborted: parked, with origin still carrying the attempt ref that
    // attempt pushed. Replaying it must not refuse, and must not re-derive the
    // park as `cap` -- a `cap` park is not releasable by an operator decision,
    // so doing so would strand the decision just as thoroughly.
    const replayed = run(state, "attempt", "V3-3.4", ["--replay", "--defer-park-exit"]);
    expect(replayed.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(state, "utf8")).items["V3-3.4"]).toMatchObject({ rounds: 4, noProgress: 4, park: "no-progress" });

    // Without `--replay` the same state is still refused, so a parked item
    // cannot be walked past by asking twice.
    expect(text(run(state, "attempt"))).toContain("parked=no-progress");

    // The decision now applies to the reconstructed state and buys the round.
    const repo = decisionRepo({ "HR-2149.md": authorization("V3-3.4", "HR-2149") });
    expect(unpark(state, repo).exitCode).toBe(0);
    expect(run(state, "attempt").exitCode).toBe(0);
    expect(JSON.parse(readFileSync(state, "utf8")).items["V3-3.4"]).toMatchObject({ rounds: 5, park: null, unparkCredits: 0 });
  });

  // The r4 review's central finding: "does this file carry a grant in its
  // frontmatter" was answered by two implementations over two I/O paths, and
  // one NUL byte made them disagree -- the reader granted, the guard read the
  // NUL-stripped copy and saw an inert file, so a lane landed its own
  // authorization through the ordinary gate. The lock is differential and runs
  // over a corpus rather than one example: for EVERY blob, the reader granting
  // must imply the guard reserving. A single shared predicate is what makes
  // that hold, so this test fails the moment anyone forks it again.
  test("REGRESSION V3-0.29 r5 F8: guard and reader never disagree over a corpus of hostile blobs", () => {
    const grant = (item: string, decision: string) => `operator-unpark: v2 item=${item} decision=${decision} park=no-progress`;
    const corpus: Array<[string, string | Uint8Array]> = [
      ["nul-fake-close", Buffer.from(`---\nid: HR-7777\n-\0--\n${grant("V3-3.4", "HR-7777")}\n---\n`, "utf8")],
      ["nul-inside-grant", Buffer.from(`---\n${grant("V3-3.4", "HR-7777")}\0\n---\n`, "utf8")],
      ["nul-leading", Buffer.from(`\0---\n${grant("V3-3.4", "HR-7777")}\n---\n`, "utf8")],
      ["nul-trailing", Buffer.from(`---\n${grant("V3-3.4", "HR-7777")}\n---\n\0`, "utf8")],
      ["plain-grant", `---\nid: HR-7777\n${grant("V3-3.4", "HR-7777")}\n---\n`],
      ["fenced-quotation", `# HR-7777\n\n\`\`\`text\n${grant("V3-3.4", "HR-7777")}\n\`\`\`\n`],
      ["below-frontmatter", `---\nid: HR-7777\n---\n\n${grant("V3-3.4", "HR-7777")}\n`],
      ["unterminated-frontmatter", `---\nid: HR-7777\n${grant("V3-3.4", "HR-7777")}\n`],
      ["crlf-delimiters", `---\r\n${grant("V3-3.4", "HR-7777")}\r\n---\r\n`],
      ["second-block", `---\nid: HR-7777\n---\n\n---\n${grant("V3-3.4", "HR-7777")}\n---\n`],
      ["dots-closer", `---\nid: HR-7777\n${grant("V3-3.4", "HR-7777")}\n...\n`],
    ];
    for (const [name, body] of corpus) {
      const state = fixture(10, 3);
      parkNoProgress(state);
      const repo = decisionRepo({ "HR-7777.md": body as string });
      const reader = unpark(state, repo);
      const granted = text(reader).includes("status=unparked");
      const guard = reservedBlob(body);
      const reserved = guard.exitCode === 3;
      // The only forbidden combination, and the exact one the exploit needed.
      expect({ case: name, granted, reserved }).not.toMatchObject({ granted: true, reserved: false });
      // Same predicate, so agreement is exact except where the guard
      // deliberately over-reserves an uncertifiable (binary) blob.
      if (granted) expect(reserved).toBe(true);
      const binary = typeof body !== "string" || body.includes("\0");
      if (binary) {
        expect(reserved).toBe(true);
        expect(granted).toBe(false);
        expect(text(reader)).toContain("status=warn detail=decision-ignored-binary path=instance/decisions/HR-7777.md");
      }
    }
  });

  test("REGRESSION V3-0.29 r5 F6: a ledger entry whose event was deleted fails closed", () => {
    const state = fixture(10, 3);
    parkNoProgress(state);
    const repo = decisionRepo({ "HR-2149.md": authorization("V3-3.4", "HR-2149") });
    expect(unpark(state, repo).exitCode).toBe(0);
    const good = readFileSync(state, "utf8");

    // The chain is verified forward from the events, so dropping the NEWEST
    // event used to load cleanly while the ledger still claimed it was spent:
    // the audit record was append-only in one direction only.
    const truncated = JSON.parse(good);
    expect(truncated.items["V3-3.4"].unparks).toHaveLength(1);
    truncated.items["V3-3.4"].unparks = [];
    writeFileSync(state, `${JSON.stringify(truncated, null, 2)}\n`);
    expect(text(run(state, "round"))).toContain("unpark-event-missing file=");
    expect(run(state, "round").exitCode).toBe(2);

    // A ledger entry naming an item that no longer exists is caught too.
    const orphaned = JSON.parse(good);
    orphaned.decisions["HR-9999"] = "V3-nonexistent";
    writeFileSync(state, `${JSON.stringify(orphaned, null, 2)}\n`);
    expect(text(run(state, "round"))).toContain("unpark-event-missing file=");
    writeFileSync(state, good);
    expect(run(state, "round").exitCode).toBe(0);
  });

  test("REGRESSION V3-0.29 r5 F4: a candidate deleting a hostile file is not bricked by it", () => {
    const state = fixture(10, 3);
    parkNoProgress(state);
    // The realistic operator typo: `park=cap` in a file naming this very item.
    // It refuses every landing of the item it names -- including the branch
    // that would delete it, which left the repair outside the gate entirely.
    const repo = decisionRepo({ "HR-6000.md": "---\nid: HR-6000\noperator-unpark: v2 item=V3-3.4 decision=HR-6000 park=cap\n---\n" });
    const bricked = unpark(state, repo);
    expect(bricked.exitCode).toBe(2);
    expect(text(bricked)).toContain("malformed-authorization path=instance/decisions/HR-6000.md");

    const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    git("checkout", "-b", "ag-repair");
    git("rm", "-q", "instance/decisions/HR-6000.md");
    git("commit", "-m", "delete the malformed decision");
    const repair = unpark(state, repo, "V3-3.4", ["--candidate", "ag-repair"]);
    expect(repair.exitCode).toBe(0);
    expect(text(repair)).toContain("status=warn detail=decision-ignored-deleted-by-candidate path=instance/decisions/HR-6000.md");
    expect(text(repair)).toContain("status=unpark-none");
    // Inert means inert in both directions: the candidate rev can retract a
    // decision for this landing, never mint one. A branch that deletes a VALID
    // grant does not get to spend it on the way out.
    git("checkout", "main");
    mkdirSync(resolve(repo, "instance/decisions"), { recursive: true });
    publish(repo, "HR-2149.md", authorization("V3-3.4", "HR-2149"));
    git("checkout", "-b", "ag-repair-2", "origin/main");
    git("rm", "-q", "instance/decisions/HR-2149.md", "instance/decisions/HR-6000.md");
    git("commit", "-m", "delete the valid grant and the malformed one");
    const deletedGrant = unpark(state, repo, "V3-3.4", ["--candidate", "ag-repair-2"]);
    expect(deletedGrant.exitCode).toBe(0);
    expect(text(deletedGrant)).toContain("status=unpark-none");
    const data = JSON.parse(readFileSync(state, "utf8"));
    expect(data.items["V3-3.4"]).toMatchObject({ park: "no-progress" });
    expect(data.decisions ?? {}).toEqual({});
    // Scoped to what the candidate actually removes: a candidate deleting only
    // the malformed file still meets the valid grant, and spends it.
    git("checkout", "-b", "ag-repair-3", "origin/main");
    git("rm", "-q", "instance/decisions/HR-6000.md");
    git("commit", "-m", "delete only the malformed decision");
    const scoped = unpark(state, repo, "V3-3.4", ["--candidate", "ag-repair-3"]);
    expect(scoped.exitCode).toBe(0);
    expect(text(scoped)).toContain("status=unparked item=V3-3.4 decision=HR-2149");
  });

  test("REGRESSION V3-0.29 r5 F4: a lane that never carried a grant is not treated as deleting it", () => {
    const state = fixture(10, 3);
    parkNoProgress(state);
    const repo = decisionRepo();
    const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    // The ordinary case, and the one that makes "the candidate does not have
    // this file" the wrong test: the lane is cut FIRST, the operator publishes
    // the grant afterwards. Merging that lane keeps the file, so absence in the
    // lane is not retraction -- reading it as one would silently disarm every
    // decision published after a lane branched, which is most of them.
    git("checkout", "-b", "ag-late-grant");
    writeFileSync(resolve(repo, "lane.txt"), "lane\n");
    git("add", "-A"); git("commit", "-m", "ordinary lane work");
    git("checkout", "main");
    publish(repo, "HR-2149.md", authorization("V3-3.4", "HR-2149"));

    const late = unpark(state, repo, "V3-3.4", ["--candidate", "ag-late-grant"]);
    expect(late.exitCode).toBe(0);
    expect(text(late)).toContain("status=unparked item=V3-3.4 decision=HR-2149");
    expect(text(late)).not.toContain("decision-ignored-deleted-by-candidate");
  });

  test("operator unpark does not clear a cap park", () => {
    const state = fixture(1, 3);
    expect(run(state, "attempt").exitCode).toBe(0);
    expect(text(run(state, "attempt"))).toContain("parked=cap");
    expect(text(run(state, "operator-unpark", "V3-3.4", ["--decision-id", "x", "--authorized-by", "operator", "--authorized-at", "2026-08-04T12:00:00Z", "--authorization", state, "--signature", state, "--allowed-signers", state]))).toContain("not-no-progress-park");
  });
});

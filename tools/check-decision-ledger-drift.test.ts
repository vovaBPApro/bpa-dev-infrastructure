import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

// This test IS the executor for tools/check-decision-ledger-drift.sh.
//
// The script was landed in 2687420 with nothing running it -- the operator caught
// that immediately (Telegram 1771: "Оце, тіпа, його V3 інфраструктура буде якось
// запускати?"). A check nobody runs is the same defect class as the unarmed
// watchdog and the reap script wired to nothing: written, tracked, inert.
//
// Placing it here means the landing gate's declared checks run it on every
// candidate, because those checks execute the tracked test suite. The ledger
// therefore cannot silently drift again without a landing failing.

const repoRoot = join(import.meta.dir, "..");
const script = join(repoRoot, "tools", "check-decision-ledger-drift.sh");

function runCheck(env: Record<string, string> = {}) {
  return spawnSync("bash", [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("the decision ledger carries every record the donor line has", () => {
  const result = runCheck();
  // Surface the drift itself on failure -- a bare exit code would make someone
  // re-run the script by hand to learn which record went missing.
  expect(`${result.stdout}${result.stderr}`).not.toContain("LEDGER-DRIFT missing");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("undispositioned-missing=0");
});

test("an unverifiable donor ref fails closed instead of passing", () => {
  // Hard Floor 7: an unmeasured subject is never a pass. If the donor line is
  // gone the check can prove nothing, and proving nothing must not look clean.
  // This case also keeps the test above honest -- it proves the script has a
  // reachable failure path rather than exiting 0 unconditionally.
  const result = runCheck({ LEDGER_DONOR_REF: "no-such-ref-should-not-exist" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("donor-ref-missing");
});

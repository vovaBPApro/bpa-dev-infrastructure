/**
 * V3-3.10 wiring lock.
 *
 * Token accounting is spread across three files that must agree: the argv conf
 * asks the CLI for `stream-json`, the lane payload puts the masker into the
 * matching mode, and the launcher supplies the attribution. Each edit is
 * individually harmless-looking and any one of them alone is a defect:
 *
 *   - conf without masker flag  -> the lane log fills with raw JSON, and the
 *     operator's main window into a running lane is destroyed;
 *   - masker flag without conf  -> the log is fine and every lane silently
 *     records `unmeasured`, which looks exactly like a provider outage;
 *   - launcher without setenv   -> rows land with a null lane and the question
 *     "what did this lane cost?" stops being answerable.
 *
 * None of those fail a test that only exercises the pieces separately, which is
 * why this file asserts the seam itself.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..", "..");
const read = (...parts: string[]): string => readFileSync(join(repo, ...parts), "utf8");

/** Argv entries only: these confs carry long rationale comments that mention
 * the very flags being checked, and a grep over the whole file would pass on
 * the prose alone. */
function argv(conf: string): string[] {
  return read("instance", conf).split("\n").map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

const confs = readdirSync(join(repo, "instance")).filter((entry) => /^lane-agent-command.*\.conf$/.test(entry));

test("every claude-family lane conf asks for the output format usage needs", () => {
  const claudeConfs = confs.filter((conf) => argv(conf).includes("claude"));
  expect(claudeConfs.length).toBeGreaterThan(0);
  for (const conf of claudeConfs) {
    const entries = argv(conf);
    expect(entries).toContain("--output-format");
    expect(entries[entries.indexOf("--output-format") + 1]).toBe("stream-json");
    // Refused at launch without it, not merely quieter.
    expect(entries).toContain("--verbose");
  }
});

test("a conf for another provider is left alone rather than given claude's flags", () => {
  // A codex lane emits plain text, records an unmeasured turn, and keeps the
  // log it has today. Adding claude's flags here would break the launch.
  for (const conf of confs.filter((entry) => argv(entry).includes("codex"))) {
    expect(argv(conf)).not.toContain("--output-format");
  }
});

test("the lane payload puts the masker in the matching mode and passes the validated role", () => {
  const payload = read("orchestrator", "fleet", "lane-payload.sh");
  expect(payload).toContain('"$bun" "$masker" --format stream-json --role "$role"');
  // Role travels positionally, from the value this file already validated --
  // not from the environment, where the tenth-argument incident lost it.
  expect(payload).toMatch(/role=\$\{10\}/);
});

test("the launcher supplies the attribution the masker reads from its environment", () => {
  const launcher = read("orchestrator", "fleet", "launch-lane.sh");
  expect(launcher).toContain('--setenv="LANE_USAGE_LANE=$name"');
  expect(launcher).toContain('--setenv="LANE_USAGE_ITEM=$item"');
  // Every value crossing systemd's expander is checked for `$` before launch;
  // a new setenv value that skipped that list would vanish in transit.
  const guard = launcher.slice(launcher.indexOf("for systemd_value in"), launcher.indexOf("mkdir -p \"$lanes_dir\""));
  expect(guard).toContain('"$name"');
  expect(guard).toContain('"$item"');
});

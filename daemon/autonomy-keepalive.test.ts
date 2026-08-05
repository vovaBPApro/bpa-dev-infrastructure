import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AutonomyKeepalive, parseFleetConfig, parseSystemdLaneUnits } from "./autonomy-keepalive";

const REPO = join(import.meta.dir, "..");

// The correct block, as instance/params.yaml now carries it.
const PARAMS = [
  "fleet:",
  "  cap: 3",
  "  wake_below: 1",
  "  notify_human_below: 1",
  "  keepalive_interval_minutes: 15",
  "  status: active",
  "",
  "orchestrator:",
  "  session: bpa-orchestrator",
].join("\n");

function fleetOf(running: number, params = PARAMS) {
  const messages: string[] = [];
  const units = [
    // Inactive units are present in every real census; only active ones count.
    { name: "lane-finished.service", active: false },
    ...Array.from({ length: running }, (_, index) => ({ name: `lane-open-${index}.service`, active: true })),
  ];
  return {
    messages,
    keepalive: (open: number | null) =>
      new AutonomyKeepalive({
        fleet: parseFleetConfig(params),
        countOpenWork: () => open,
        listUnits: () => units,
        nudge: async (message) => { messages.push(message); },
      }),
  };
}

async function timerAt(running: number, open: number | null, params = PARAMS): Promise<string[]> {
  const { messages, keepalive } = fleetOf(running, params);
  await keepalive(open).timerTick();
  return messages;
}

test("the parameter file this repository ships parses to the landed semantics", () => {
  const config = parseFleetConfig(readFileSync(join(REPO, "instance", "params.yaml"), "utf8"));
  // The cap is HR-2538's three; the wake threshold does NOT move with it, which
  // is the decoupling V3-2.11's B3 landed and V3-2.15 wrote into the file. The
  // number moved 3 -> 5 -> 3 in one day and the threshold never followed it.
  expect(config).toEqual({ cap: 3, wakeBelow: 1, target: 0, intervalMs: 900_000 });
});

// The behaviour the workboard row asks to be shown, at every lane count the cap
// allows. HR-2342: "Three is a ceiling, not a target: fewer is allowed whenever
// the work does not need them."
test("with open work: 0 running lanes nudges, 1, 2 and 3 are silent", async () => {
  expect(await timerAt(0, 61)).toEqual([
    "fleet idle: 0 running with 61 open workboard rows; dispatch or inspect blocked lanes." +
      " HR-2538 caps parallel lanes at 3 — a ceiling, not a target.",
  ]);
  expect(await timerAt(1, 61)).toEqual([]);
  expect(await timerAt(2, 61)).toEqual([]);
  expect(await timerAt(3, 61)).toEqual([]);
});

// The regression lock for audit F1 / workboard V3-2.15. Against `floor: 10` this
// same census nudged "dispatch more work" at 1, 2 and 3 running lanes —
// permanently, because at a cap of three every allowed state is below ten.
test("a leftover floor: 10 cannot resurrect the retired threshold", async () => {
  const stale = PARAMS.replace("  cap: 3", "  cap: 3\n  floor: 10\n  ceiling: 15");
  expect(parseFleetConfig(stale).wakeBelow).toBe(1);
  expect(await timerAt(1, 61, stale)).toEqual([]);
  expect(await timerAt(3, 61, stale)).toEqual([]);
  expect(await timerAt(0, 61, stale)).toHaveLength(1);
});

test("an idle fleet with an empty board says nothing — that message is the watchdog's, and it deduplicates", async () => {
  expect(await timerAt(0, 0)).toEqual([]);
});

// A board that cannot be counted must never read as "no work": that inversion
// is exactly why this backstop had never fired (audit F4).
test("a board that cannot be counted nudges rather than reading as no work", async () => {
  expect(await timerAt(0, null)).toEqual([
    "0 running and the workboard could not be counted; check the board and the fleet-nudge counter",
  ]);
});

test("a zero threshold is clamped to one, so the severe tier cannot be deleted", async () => {
  const zero = PARAMS.replace("wake_below: 1", "wake_below: 0");
  expect(parseFleetConfig(zero).wakeBelow).toBe(1);
  expect(await timerAt(0, 61, zero)).toHaveLength(1);
});

// The seam workboard V3-0.34 asks for: off by default, and when a later row
// derives a width from measured capacity, this is where it goes.
test("the target seam is off by default and reaches only the orchestrator when set", async () => {
  expect(parseFleetConfig(PARAMS).target).toBe(0);
  const withTarget = PARAMS.replace("  cap: 3", "  cap: 3\n  target: 2");
  expect(await timerAt(1, 61, withTarget)).toEqual([
    "fleet below target: 1/2 running with 61 open workboard rows; dispatch more work." +
      " HR-2538 caps parallel lanes at 3 — a ceiling, not a target.",
  ]);
  expect(await timerAt(2, 61, withTarget)).toEqual([]);
});

test("an unreadable parameter file falls back to idleness only, and quotes no cap it does not know", async () => {
  expect(parseFleetConfig("")).toEqual({ cap: null, wakeBelow: 1, target: 0, intervalMs: 900_000 });
  expect(await timerAt(1, 61, "")).toEqual([]);
  expect(await timerAt(0, 61, "")).toEqual([
    "fleet idle: 0 running with 61 open workboard rows; dispatch or inspect blocked lanes.",
  ]);
});

test("the lane-exit event path is unchanged by the threshold", async () => {
  const messages: string[] = [];
  let units = [{ name: "lane-a.service", active: true }, { name: "lane-b.service", active: true }];
  const keepalive = new AutonomyKeepalive({
    fleet: parseFleetConfig(PARAMS),
    countOpenWork: () => 61,
    listUnits: () => units,
    nudge: async (message) => { messages.push(message); },
  });
  await keepalive.eventTick();
  expect(messages).toEqual([]);
  units = [{ name: "lane-a.service", active: true }];
  await keepalive.eventTick();
  expect(messages).toEqual(["lane b finished; inspect evidence and continue dispatch"]);
});

test("only active lane units are counted", () => {
  expect(parseSystemdLaneUnits([
    "lane-one.service loaded active running BPA lane one",
    "lane-two.service loaded inactive dead BPA lane two",
    "bpa-telegram-daemon.service loaded active running not a lane",
  ].join("\n"))).toEqual([
    { name: "lane-one.service", active: true },
    { name: "lane-two.service", active: false },
  ]);
});

// The counter the daemon injects has ONE home, and this proves that home works
// against the real board. Before this change the daemon carried its own copy,
// which parsed the v2 bullet board and answered "no open work" on every v3
// board — so the timer path could never fire, whatever the threshold said.
test("the tracked open-work counter answers on this repository's real board", () => {
  const counted = Bun.spawnSync([
    "bash",
    join(REPO, "orchestrator", "fleet", "fleet-nudge.sh"),
    "--count-open",
    join(REPO, "instance", "workboard.md"),
  ]);
  expect(counted.exitCode, counted.stderr.toString()).toBe(0);
  const open = Number(counted.stdout.toString().trim().split("\n").pop());
  expect(Number.isSafeInteger(open)).toBe(true);
  expect(open).toBeGreaterThan(0);
});

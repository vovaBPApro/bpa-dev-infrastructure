#!/usr/bin/env bun
// The fleet block of instance/params.yaml cannot contradict the ruling it cites.
//
// Why this file exists (workboard V3-2.15, audit finding F1): `fleet.floor: 10`
// sat in this repository from 2026-07-31 until 2026-08-05, four days after
// instance/decisions/HR-2342.md capped parallel lanes at three and said so in
// the same sentence — "a ceiling, not a target". Nothing noticed, because
// nothing compared the number in the parameter file against the number in the
// ruling. The value was not decorative on either side of that gap:
// daemon/autonomy-keepalive.ts read it live, so every lane census under ten read
// as "below floor"; and tools/instructions/session-load.ts pushes params.yaml
// into the orchestrator's standing context verbatim, so every new session was
// told to hold ten lanes. An agent handed a false premise does not argue with
// it, it reasons from it.
//
// ── What this check covers ─────────────────────────────────────────────────
//
//   1. The cap in params.yaml equals the cap declared by EVERY binding decision
//      record that declares one (`lane_cap:`), and at least one such record
//      exists. A ruling with no parameter, or a parameter with no ruling, both
//      fail — absence is never a skip.
//   2. The superseded knob names (`floor`, `ceiling`) cannot come back. They are
//      rejected by name, so re-adding the exact defect is a hard failure rather
//      than a silent regression.
//   3. Every wake threshold is 1. This is derived, not chosen: HR-2342 permits
//      every count from 1 to the cap, so the only lane count that can be a fault
//      is ZERO. A threshold of 2 or 3 re-installs the ceiling as a floor and
//      turns permitted operation into a permanent alarm — which is what the
//      operator was woken by.
//   4. A target may exist but must be OFF (0) unless a `target_source:` key
//      names a file that exists. That is the seam for the capacity-derived
//      budget (workboard V3-0.34); it refuses another underived constant taking
//      the place of the one being removed.
//   5. The two mechanisms that consume the cap agree with the parameter file:
//      orchestrator/fleet/fleet-nudge.sh's defaults, and this repository's own
//      daemon parser, cannot drift away from it silently.
//   6. Every HR record cited inside the fleet block exists on disk.
//
// ── What it does NOT cover ─────────────────────────────────────────────────
//
// Only the fleet block, and only numbers. It does not validate the rest of
// params.yaml (the schema-plus-per-key verifier is its own row), it cannot read
// prose — a comment may still describe the cap wrongly in words — and it says
// nothing about whether the host can actually carry the cap, which is the
// measured budget of V3-0.34. It also does not check the operator's live fleet:
// it compares the tracked claim against the tracked ruling, not against reality.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PARAMS_FILE = join("instance", "params.yaml");
export const DECISIONS_DIR = join("instance", "decisions");
export const FLEET_NUDGE_FILE = join("orchestrator", "fleet", "fleet-nudge.sh");
export const DAEMON_KEEPALIVE_FILE = join("daemon", "autonomy-keepalive.ts");

// Knob names retired by HR-2342, mapped to what replaced them. Keyed by name so
// the failure names the ruling rather than reporting a bare "unknown key".
const RETIRED_KEYS = new Map([
  ["floor", "a floor is not a cap — HR-2342 permits every count from 1 to `cap`"],
  ["ceiling", "the ceiling IS `cap` — HR-2342/HR-2398 state it once"],
]);

// Wake thresholds: which key, and which mechanism reads it. Both must be 1 (see
// coverage note 3); naming the reader makes a failure actionable rather than
// abstract.
const WAKE_KEYS = new Map([
  ["wake_below", DAEMON_KEEPALIVE_FILE],
  ["notify_human_below", join("orchestrator", "watchdog.sh")],
]);

export type FleetEntry = { value: string; line: number };

/** The raw `fleet:` block, comments included — the text an agent actually reads. */
export function fleetBlockText(yaml: string): string {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^fleet:\s*(#.*)?$/.test(line));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

/** The `fleet:` block's key/value pairs, comments stripped, line numbers kept. */
export function readFleetBlock(yaml: string): Map<string, FleetEntry> {
  const entries = new Map<string, FleetEntry>();
  const lines = yaml.split(/\r?\n/);
  let inside = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^fleet:\s*(#.*)?$/.test(line)) { inside = true; continue; }
    if (!inside) continue;
    if (/^\S/.test(line)) break;                       // the next top-level key ends the block
    const match = line.match(/^\s+([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!match) continue;                              // a comment or a blank line
    entries.set(match[1]!, { value: match[2]!.replace(/\s+#.*$/, "").trim(), line: index + 1 });
  }
  return entries;
}

/** Decision records declaring a `lane_cap:`, with the status they declare it under. */
export function declaredLaneCaps(repo: string): { id: string; cap: number; binding: boolean }[] {
  const dir = join(repo, DECISIONS_DIR);
  if (!existsSync(dir)) return [];
  const found: { id: string; cap: number; binding: boolean }[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!/^HR-.+\.md$/.test(entry)) continue;
    const contents = readFileSync(join(dir, entry), "utf8");
    const cap = contents.match(/^lane_cap:\s*(\d+)\s*$/m)?.[1];
    if (cap === undefined) continue;
    found.push({
      id: entry.replace(/\.md$/, ""),
      cap: Number(cap),
      binding: /^status:\s*binding\s*$/m.test(contents),
    });
  }
  return found;
}

function integer(entry: FleetEntry | undefined): number | undefined {
  if (!entry || !/^\d+$/.test(entry.value)) return undefined;
  return Number(entry.value);
}

/** A shell default of the `NAME=${VAR:-N}` form, as an integer. */
export function shellDefault(source: string, variable: string): number | undefined {
  const match = source.match(new RegExp(`\\$\\{${variable}:-(\\d+)\\}`));
  return match ? Number(match[1]) : undefined;
}

export function checkFleetCap(repo: string): string[] {
  const errors: string[] = [];
  const paramsPath = join(repo, PARAMS_FILE);
  if (!existsSync(paramsPath)) return [`${PARAMS_FILE}: absent — the fleet parameters cannot be checked`];
  const params = readFileSync(paramsPath, "utf8");
  const fleet = readFleetBlock(params);
  if (fleet.size === 0) return [`${PARAMS_FILE}: no fleet block — the cap must be stated where the daemon reads it`];

  const at = (key: string) => `${PARAMS_FILE}:${fleet.get(key)?.line ?? 0} fleet.${key}`;

  for (const [key, why] of RETIRED_KEYS) {
    if (fleet.has(key)) errors.push(`${at(key)}: retired by instance/decisions/HR-2342.md — ${why}`);
  }

  // 1. The cap, against every ruling that declares one.
  const cap = integer(fleet.get("cap"));
  const declared = declaredLaneCaps(repo);
  const binding = declared.filter((row) => row.binding);
  for (const row of declared.filter((row) => !row.binding)) {
    errors.push(`${DECISIONS_DIR}/${row.id}.md: declares lane_cap: ${row.cap} without \`status: binding\` — a cap nobody is bound by is not a cap`);
  }
  if (cap === undefined) {
    errors.push(`${at("cap")}: missing or not a positive integer — the operator's cap must be stated as a number`);
  } else if (binding.length === 0) {
    errors.push(`${DECISIONS_DIR}/: no binding decision record declares \`lane_cap:\` — ${PARAMS_FILE} states a cap of ${cap} that no ruling backs`);
  } else {
    for (const row of binding) {
      if (row.cap !== cap) {
        errors.push(`${at("cap")}: ${cap} contradicts ${DECISIONS_DIR}/${row.id}.md, which declares lane_cap: ${row.cap}`);
      }
    }
  }

  // 3. Wake thresholds. Only zero running lanes can be a fault.
  for (const [key, reader] of WAKE_KEYS) {
    const value = integer(fleet.get(key));
    if (value === undefined) {
      errors.push(`${at(key)}: missing or not an integer — ${reader} reads it, so an absent threshold is an unstated one`);
      continue;
    }
    if (value !== 1) {
      errors.push(`${at(key)}: ${value} treats a lane count HR-2342 permits as a fault (read by ${reader}); only 0 running lanes is idle, so this is 1`);
    }
  }

  // 4. The target seam stays off until something derives it.
  const target = integer(fleet.get("target")) ?? 0;
  if (fleet.has("target") && integer(fleet.get("target")) === undefined) {
    errors.push(`${at("target")}: not an integer — 0 disables the target, any other value needs target_source`);
  } else if (target > 0) {
    const source = fleet.get("target_source")?.value;
    if (!source || !existsSync(join(repo, source))) {
      errors.push(`${at("target")}: ${target} is an underived constant — a non-zero target needs target_source naming a file that derives it (workboard V3-0.34)`);
    }
    if (cap !== undefined && target > cap) {
      errors.push(`${at("target")}: ${target} exceeds the cap of ${cap} — a target above the ceiling is the defect this check exists for`);
    }
  }

  // 5. The consumers cannot drift away from the parameter file.
  const nudgePath = join(repo, FLEET_NUDGE_FILE);
  if (!existsSync(nudgePath)) {
    errors.push(`${FLEET_NUDGE_FILE}: absent — the timer watchdog named by fleet_idle_check must exist`);
  } else {
    const nudge = readFileSync(nudgePath, "utf8");
    const pairs: [string, string, number | undefined][] = [
      ["FLEET_NUDGE_CAP", "cap", cap],
      ["FLEET_NUDGE_CRITICAL", "wake_below", integer(fleet.get("wake_below"))],
      ["FLEET_NUDGE_TARGET", "target", integer(fleet.get("target")) ?? 0],
    ];
    for (const [variable, key, expected] of pairs) {
      const actual = shellDefault(nudge, variable);
      if (actual === undefined) {
        errors.push(`${FLEET_NUDGE_FILE}: no \${${variable}:-N} default found — the watchdog's ${key} cannot be compared with ${PARAMS_FILE}`);
      } else if (expected !== undefined && actual !== expected) {
        errors.push(`${FLEET_NUDGE_FILE}: ${variable} defaults to ${actual}, but ${at(key)} is ${expected} — two mechanisms, two numbers`);
      }
    }
  }

  // 5b. The daemon reads the same knobs by name. A rename that leaves the file
  // silently falling back to its own defaults is the failure mode here.
  const keepalivePath = join(repo, DAEMON_KEEPALIVE_FILE);
  if (!existsSync(keepalivePath)) {
    errors.push(`${DAEMON_KEEPALIVE_FILE}: absent — fleet_idle_backstop names it`);
  } else {
    const keepalive = readFileSync(keepalivePath, "utf8");
    for (const key of ["cap", "wake_below", "target"]) {
      if (!keepalive.includes(`'${key}'`) && !keepalive.includes(`${key}:`)) {
        errors.push(`${DAEMON_KEEPALIVE_FILE}: does not read fleet.${key} — the parameter would be inert`);
      }
    }
  }

  // 6. Cited rulings must exist. Comments count: session-load.ts pushes them
  // into the orchestrator's context verbatim, so a comment naming a record that
  // was never written is a false citation like any other.
  for (const match of fleetBlockText(params).matchAll(/\bHR-(\d+)\b/g)) {
    const file = join(DECISIONS_DIR, `HR-${match[1]}.md`);
    if (!existsSync(join(repo, file))) {
      errors.push(`${PARAMS_FILE}: the fleet block cites ${file}, which does not exist`);
    }
  }

  return errors;
}

if (import.meta.main) {
  const index = process.argv.indexOf("--repo");
  const repo = index >= 0 ? process.argv[index + 1] : process.cwd();
  if (!repo) throw new Error("--repo requires a path");
  const errors = checkFleetCap(repo);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  const fleet = readFleetBlock(readFileSync(join(repo, PARAMS_FILE), "utf8"));
  const declared = declaredLaneCaps(repo).filter((row) => row.binding).map((row) => row.id);
  console.log(
    `FLEET-CAP clean cap=${fleet.get("cap")?.value} wake_below=${fleet.get("wake_below")?.value} ` +
      `notify_human_below=${fleet.get("notify_human_below")?.value} target=${fleet.get("target")?.value ?? 0} ` +
      `declared_by=${declared.join(",")}`,
  );
}

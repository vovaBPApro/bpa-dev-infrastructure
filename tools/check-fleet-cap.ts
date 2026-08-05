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
//   1. The cap in params.yaml equals the cap declared by every binding decision
//      record that declares a LIVE one (`lane_cap:` without a
//      `lane_cap_superseded_by:` pointer), and at least one such record exists.
//      A ruling with no parameter, or a parameter with no ruling, both fail —
//      absence is never a skip. A superseded number stays in the ledger as
//      history and must forward to a ruling that declares its own cap, so a
//      pointer cannot mute a binding number instead of replacing it.
//   1b. A binding record that AMENDS a cap-declaring record declares a cap
//      itself. See the HR-2456 note below.
//   1c. `declared_by` equals the set of rulings that declare the live cap,
//      recomputed from the ledger on every run. Every operator-facing message
//      quotes that key instead of a typed id, so this is the single place the
//      citation can be wrong — and a superseding ruling turns it red without
//      anyone editing this file (workboard V3-5.10).
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
//   5. The mechanisms that consume the cap agree with the parameter file:
//      orchestrator/fleet/fleet-nudge.sh's defaults, and this repository's own
//      daemon parser, cannot drift away from it silently. The cap itself may no
//      longer carry a numeric default in the nudge at all, no consumer may
//      retype a ruling id into the sentence it shows the operator, and
//      orchestrator/fleet/launch-lane.sh must read the cap, take a census, and
//      offer the declared over-cap exception.
//   6. Every HR record cited inside the fleet block exists on disk.
//
// ── Why 1b exists (HR-2456, 2026-08-05) ────────────────────────────────────
//
// The operator raised the cap to five while the lane implementing the cap of
// three was already running. The ruling was recorded as prose with no
// `lane_cap:` field, so this check could not see it: it read `clean cap=3`
// with the superseding ruling sitting in the same directory. Nothing was
// wrong with the number in params.yaml at that moment — what was wrong is that
// a binding ruling changing the cap could be silently ignored rather than
// flagged, which is the exact failure mode this file was written to end.
//
// The cheap catch is the amendment edge: a cap-changing ruling names the
// ruling it amends, because that is how the ledger already records
// supersession. So a binding record that amends a cap-declaring record and
// declares no cap of its own is refused, and the fix is one line of
// frontmatter. It is a narrow net by design — see below for what it misses.
//
// ── What it does NOT cover ─────────────────────────────────────────────────
//
// 1b catches a cap-changing ruling that declares an `amends:`/`supersedes:`
// edge to a cap-declaring record. A ruling that changes the cap while naming
// no such edge is still invisible here, and no cheap assertion closes that:
// deciding "does this prose change the cap" from text is the judgement the
// structured field exists to replace. The residual guard is the triage step
// that writes a ledger row, not this checker.
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
export const FLEET_LAUNCHER_FILE = join("orchestrator", "fleet", "launch-lane.sh");
export const FLEET_PARAMS_FILE = join("orchestrator", "fleet", "fleet-params.sh");

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

export type DecisionRecord = {
  id: string;
  binding: boolean;
  /** The `lane_cap:` this record declares, if any. */
  cap?: number;
  /** The ruling that replaced this record's number, from `lane_cap_superseded_by:`. */
  supersededBy?: string;
  /** Rulings named by `amends:`/`supersedes:` frontmatter. */
  amends: string[];
};

/**
 * Rulings named by a record's `amends:`/`supersedes:` frontmatter, continuation
 * lines included — the ledger wraps those values. Lower-case keys only, so
 * "Supersedes the hardcoded fleet floor" in prose is not mistaken for a field.
 */
export function amendedRulings(contents: string): string[] {
  const lines = contents.split(/\r?\n/);
  const ids = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:amends|supersedes):/.test(lines[index]!)) continue;
    let text = lines[index]!;
    for (let next = index + 1; next < lines.length && /^\s+\S/.test(lines[next]!); next += 1) text += `\n${lines[next]}`;
    for (const match of text.matchAll(/\bHR-(\d+)\b/gi)) ids.add(`HR-${match[1]}`);
  }
  return [...ids];
}

/** Every decision record, with the cap fields and amendment edges this check reads. */
export function decisionRecords(repo: string): DecisionRecord[] {
  const dir = join(repo, DECISIONS_DIR);
  if (!existsSync(dir)) return [];
  const found: DecisionRecord[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!/^HR-.+\.md$/.test(entry)) continue;
    const contents = readFileSync(join(dir, entry), "utf8");
    const cap = contents.match(/^lane_cap:\s*(\d+)\s*$/m)?.[1];
    found.push({
      id: entry.replace(/\.md$/, ""),
      binding: /^status:\s*binding\s*$/m.test(contents),
      cap: cap === undefined ? undefined : Number(cap),
      supersededBy: contents.match(/^lane_cap_superseded_by:\s*(HR-\d+)\s*$/m)?.[1],
      amends: amendedRulings(contents),
    });
  }
  return found;
}

/** Decision records declaring a `lane_cap:`, with the status they declare it under. */
export function declaredLaneCaps(repo: string): DecisionRecord[] {
  return decisionRecords(repo).filter((row) => row.cap !== undefined);
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

  // 1. The cap, against every ruling that declares a live one.
  const cap = integer(fleet.get("cap"));
  const records = decisionRecords(repo);
  const byId = new Map(records.map((row) => [row.id, row]));
  const declared = records.filter((row) => row.cap !== undefined);
  for (const row of declared.filter((row) => !row.binding)) {
    errors.push(`${DECISIONS_DIR}/${row.id}.md: declares lane_cap: ${row.cap} without \`status: binding\` — a cap nobody is bound by is not a cap`);
  }

  // A superseded number stays in the ledger as history — HR-2342's cap of three
  // is still the record of what he ruled on 2026-08-04 — but it must forward to
  // the ruling that replaced it, and that ruling must declare its own number.
  // Otherwise the pointer deletes a binding cap instead of replacing it, which
  // is a quieter version of the drift this file exists to catch.
  for (const row of declared) {
    if (!row.supersededBy) continue;
    const replacement = byId.get(row.supersededBy);
    if (!replacement) {
      errors.push(`${DECISIONS_DIR}/${row.id}.md: lane_cap_superseded_by names ${row.supersededBy}, which does not exist`);
    } else if (replacement.cap === undefined) {
      errors.push(
        `${DECISIONS_DIR}/${row.id}.md: lane_cap_superseded_by names ${row.supersededBy}, which declares no lane_cap — ` +
          `a pointer that forwards to no number mutes this one rather than replacing it`,
      );
    }
  }

  const live = declared.filter((row) => row.binding && !row.supersededBy);
  if (cap === undefined) {
    errors.push(`${at("cap")}: missing or not a positive integer — the operator's cap must be stated as a number`);
  } else if (live.length === 0) {
    errors.push(`${DECISIONS_DIR}/: no binding decision record declares a live \`lane_cap:\` — ${PARAMS_FILE} states a cap of ${cap} that no ruling backs`);
  } else {
    for (const row of live) {
      if (row.cap !== cap) {
        errors.push(`${at("cap")}: ${cap} contradicts ${DECISIONS_DIR}/${row.id}.md, which declares lane_cap: ${row.cap}`);
      }
    }
  }

  // 1b. A binding ruling that amends a cap-declaring ruling states the number
  // itself. HR-2456 raised the cap in prose, named the rulings it amended, and
  // declared no `lane_cap:` — so this check read `clean cap=3` while the ruling
  // that replaced three sat in the same directory.
  const capDeclaring = new Set(declared.map((row) => row.id));
  for (const row of records) {
    if (!row.binding || row.cap !== undefined) continue;
    const amended = row.amends.filter((id) => capDeclaring.has(id));
    if (amended.length === 0) continue;
    errors.push(
      `${DECISIONS_DIR}/${row.id}.md: amends ${amended.join(", ")}, which declare \`lane_cap:\`, but declares none itself — ` +
        `state the cap it leaves in force, or a ruling that changes the cap is invisible to this check`,
    );
  }

  // 2. `declared_by`, recomputed rather than trusted. The ruling id in every
  // operator-facing message used to be a literal in each consumer, hand-retyped
  // at a cap change; it is now stated once here and read from here, so this is
  // the one place it can go stale. Recomputing it from the ledger on every run
  // is what makes it derived rather than merely centralised: a ruling that
  // supersedes the current one fails this check without anyone touching it.
  const declaredBy = fleet.get("declared_by")?.value ?? "";
  const expectedDeclaredBy = live.map((row) => row.id).sort().join(",");
  if (!declaredBy) {
    errors.push(
      `${at("declared_by")}: missing — the ruling id quoted beside the cap must be stated here, ` +
        `or every consumer goes back to retyping it (expected \`${expectedDeclaredBy}\`)`,
    );
  } else if (expectedDeclaredBy && declaredBy !== expectedDeclaredBy) {
    errors.push(
      `${at("declared_by")}: ${declaredBy} is not the set of rulings declaring the live cap ` +
        `(${expectedDeclaredBy}) — the operator would be quoted a ruling that does not declare this number`,
    );
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
    // The cap is the one knob here that must NOT carry a numeric default. A
    // literal was what drifted: `${FLEET_NUDGE_CAP:-5}` was correct only until
    // the day someone changed the cap and edited one of the two files. The
    // fallback is deliberately absent rather than merely equal to params.yaml,
    // so an unreadable parameter drops the sentence instead of inventing a
    // ceiling. CRITICAL and TARGET keep their literals on purpose: they are 1
    // and 0 by derivation from HR-2342 and do not move with the cap.
    const nudgeCapLiteral = shellDefault(nudge, "FLEET_NUDGE_CAP");
    if (nudgeCapLiteral !== undefined) {
      errors.push(
        `${FLEET_NUDGE_FILE}: FLEET_NUDGE_CAP defaults to the literal ${nudgeCapLiteral} — ` +
          `the cap is read from ${PARAMS_FILE}, and a retyped default is the drift this check exists for`,
      );
    }
    if (!/\bfleet_cap\b/.test(nudge)) {
      errors.push(`${FLEET_NUDGE_FILE}: does not call fleet_cap — the cap it quotes would not be read from ${PARAMS_FILE}`);
    }
    const pairs: [string, string, number | undefined][] = [
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
    for (const key of ["cap", "declared_by", "wake_below", "target"]) {
      if (!keepalive.includes(`'${key}'`) && !keepalive.includes(`${key}:`)) {
        errors.push(`${DAEMON_KEEPALIVE_FILE}: does not read fleet.${key} — the parameter would be inert`);
      }
    }
  }

  // 5c. No consumer retypes the ruling id into the sentence it shows the
  // operator. This is the exact drift of workboard V3-5.10: `fleet-nudge.sh` and
  // `autonomy-keepalive.ts` each carried their own `HR-… caps parallel lanes at
  // …`, both correct only because one person edited both at the last cap change
  // — and the prose beside one of them was already wrong (it said five against a
  // parameter of three) with nothing failing. The id belongs to `declared_by`
  // and reaches the message as a variable; a literal on the sentence line is
  // refused wherever it appears, comment or code.
  for (const file of [FLEET_NUDGE_FILE, DAEMON_KEEPALIVE_FILE, FLEET_LAUNCHER_FILE]) {
    const path = join(repo, file);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!/caps parallel lanes/.test(line)) continue;
      const literal = line.match(/\bHR-\d+\b/)?.[0];
      if (literal) {
        errors.push(
          `${file}:${index + 1}: retypes ${literal} into the cap sentence — ` +
            `quote fleet.declared_by instead, or the next cap change leaves this line behind`,
        );
      }
    }
  }

  // 5d. The launcher enforces the cap it reads. The row this check grew for
  // found that nothing in it refused a lane at all; the executable proof is
  // orchestrator/fleet/launch-lane.test.sh launching at cap+1, and this is the
  // cheap shape assertion beside it — a launcher that stopped reading the
  // parameter would otherwise fail only that one suite.
  const launcherPath = join(repo, FLEET_LAUNCHER_FILE);
  if (!existsSync(launcherPath)) {
    errors.push(`${FLEET_LAUNCHER_FILE}: absent — the cap has no enforcement point`);
  } else {
    const launcher = readFileSync(launcherPath, "utf8");
    if (!/\bfleet_cap\b/.test(launcher)) {
      errors.push(`${FLEET_LAUNCHER_FILE}: does not call fleet_cap — the cap would be quoted elsewhere and enforced nowhere`);
    }
    if (!/\bfleet_running_lanes\b/.test(launcher)) {
      errors.push(`${FLEET_LAUNCHER_FILE}: does not call fleet_running_lanes — a cap with no census cannot refuse anything`);
    }
    if (!/--allow-over-cap/.test(launcher)) {
      errors.push(`${FLEET_LAUNCHER_FILE}: no --allow-over-cap path — refusal must be the default, not the only possibility`);
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
  const declared = declaredLaneCaps(repo)
    .filter((row) => row.binding && !row.supersededBy)
    .map((row) => row.id);
  console.log(
    `FLEET-CAP clean cap=${fleet.get("cap")?.value} wake_below=${fleet.get("wake_below")?.value} ` +
      `notify_human_below=${fleet.get("notify_human_below")?.value} target=${fleet.get("target")?.value ?? 0} ` +
      `declared_by=${declared.join(",")}`,
  );
}

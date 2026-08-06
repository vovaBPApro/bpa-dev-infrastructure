#!/usr/bin/env bun
// The configured top-orchestrator model cannot disagree with the ruling that pins it.
//
// Why this file exists (workboard V3-5.23): on 2026-08-04
// instance/decisions/HR-2315.md pinned `claude-opus-5` and said in terms "Do not
// restore Fable (or any other value) without a newer HR row". For the whole of
// the next day instance/params.yaml `orchestrator.top_model` still read
// `claude-fable-5` and cited HR-709 — the ruling HR-2315 had just superseded. So
// the pin said Opus, the configuration said Fable, and any restart in that
// window would have come up against the then-binding ruling with nothing
// noticing. It was found on 2026-08-05 while answering an operator question
// about restarting, not by an audit, and it was closed by HR-2613 restoring
// Fable — which means the configuration happened to be already in the state a
// later ruling made correct. That is luck, not compliance.
//
// This is the same shape as the fleet-cap drift closed the same day, where
// tools/check-fleet-cap.ts exists precisely so the number and the ruling cannot
// disagree. This is that checker for the model pin, and it is deliberately built
// in the same shape.
//
// ── What this check covers ─────────────────────────────────────────────────
//
//   1. Exactly one LIVE ruling pins the resting top-orchestrator model. A pin
//      ruling is superseded when another pin ruling names it in `supersedes:` or
//      `amends:`, so HR-709 → HR-2315 → HR-2613 collapses to HR-2613. Zero live
//      pins and two live pins are both errors: absence is never a skip, and
//      "which of these two is newest" is not a judgement this file will guess.
//   2. `instance/params.yaml orchestrator.top_model` equals that ruling's model.
//   3. The ruling id CITED beside `top_model` is that same ruling. The 08-04
//      drift was visible in the citation before it was visible in the value —
//      the line named HR-709 while HR-2315 was binding — so the citation is
//      checked as strictly as the value. Every record cited there must exist.
//   4. A binding ruling that supersedes or amends a pin ruling declares a pin
//      itself. Without this, a ruling that moves the pin in prose alone is
//      invisible here — the failure mode that made check-fleet-cap.ts report
//      `clean cap=3` while the ruling that replaced three sat beside it.
//   5. The consumers cannot drift away from the parameter file:
//      `orchestrator/launch.sh` CLAUDE_MODEL — the value that survives a fresh
//      clone with no runtime.env, which is exactly what the meteorite test
//      restores — and `daemon/model-registry.ts`, whose catalog is the closed
//      set the operator can switch between.
//   6. A decisions record whose frontmatter fence is opened and never closed is
//      an error naming the file. An unterminated fence is not a cosmetic defect
//      here: it is how a `top_model:` field stops being read at all.
//
// ── How a ruling declares a pin ────────────────────────────────────────────
//
// Either shape counts, and a file using both must agree with itself:
//
//   - a `top_model: <model>` frontmatter field (the structured path, preferred
//     for new rulings — a field is read the same way every time);
//   - the canonical sentence the ledger already uses, which is how HR-709,
//     HR-2315 and HR-2613 each state it:
//         **Resting top-orchestrator model is `claude-fable-5`.**
//     Matched across line wrapping, because the ledger wraps at 80 columns.
//
// ── What it does NOT cover ─────────────────────────────────────────────────
//
// It compares tracked claim against tracked ruling. It does not read the LIVE
// process: `orchestrator/runtime.env` is gitignored host state, and the session
// running right now may be on something else entirely — that mismatch is a
// separate defect (HR-709 records an instance of it) and needs a runtime probe,
// not a file comparison. It cannot decide from prose whether an arbitrary ruling
// moved the pin; coverage 4 catches only the rulings that declare a supersession
// edge, and the residual guard is the triage step that writes the ledger row.
// And it says nothing about whether the pinned model is runnable on this
// installation's accounts — the catalog entry asserts that, this file only
// asserts the pin is in the catalog.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PARAMS_FILE = join("instance", "params.yaml");
export const DECISIONS_DIR = join("instance", "decisions");
export const LAUNCH_FILE = join("orchestrator", "launch.sh");
export const REGISTRY_FILE = join("daemon", "model-registry.ts");

/** A model id as the CLI accepts it — no spaces, no quotes, no backticks. */
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The canonical pin sentence, matched against whitespace-normalized text so a
 * declaration wrapped across two lines reads the same as one on a single line.
 */
const PIN_SENTENCE = /\*\*Resting top-orchestrator model is\s+`([^`]*)`\s*\.?\s*\*\*/g;

export type ParamEntry = { value: string; line: number };

/** A top-level YAML block's key/value pairs, comments stripped, line numbers kept. */
export function readBlock(yaml: string, name: string): Map<string, ParamEntry> {
  const entries = new Map<string, ParamEntry>();
  const lines = yaml.split(/\r?\n/);
  const head = new RegExp(`^${name}:\\s*(#.*)?$`);
  let inside = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (head.test(line)) { inside = true; continue; }
    if (!inside) continue;
    if (/^\S/.test(line)) break;                       // the next top-level key ends the block
    const match = line.match(/^\s+([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!match) continue;                              // a comment or a blank line
    entries.set(match[1]!, { value: match[2]!.replace(/\s+#.*$/, "").trim(), line: index + 1 });
  }
  return entries;
}

/**
 * The decision records cited beside a key, in the order they appear: the key
 * line's own trailing comment plus the run of comment lines directly under it.
 * That run is one annotation in the file and is read as one by an agent, so a
 * ruling named anywhere in it is a citation. The FIRST is the one the value
 * claims to follow — the 08-04 line led with HR-709 and mentioned nothing else
 * binding, which is exactly the state this must refuse.
 */
export function citedRulings(yaml: string, keyLine: number): string[] {
  const lines = yaml.split(/\r?\n/);
  if (keyLine < 1 || keyLine > lines.length) return [];
  let text = lines[keyLine - 1]!.replace(/^[^#]*/, "");   // the trailing comment only
  for (let index = keyLine; index < lines.length && /^\s*#/.test(lines[index]!); index += 1) {
    text += `\n${lines[index]}`;
  }
  const ids: string[] = [];
  for (const match of text.matchAll(/\bHR-(\d+)\b/g)) {
    const id = `HR-${match[1]}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export type PinRecord = {
  id: string;
  /** Repo-relative path, so every error names the file the reader must open. */
  file: string;
  binding: boolean;
  /** Distinct models this record declares. More than one is a contradiction. */
  models: string[];
  /** Rulings named by `supersedes:`/`amends:` frontmatter. */
  supersedes: string[];
  /** Set when the record could not be parsed; the error text names the reason. */
  malformed?: string;
};

/**
 * Rulings named by a record's `supersedes:`/`amends:` frontmatter, continuation
 * lines included — the ledger wraps those values. Lower-case, line-anchored
 * keys only, so a body sentence opening with "Supersedes …" is prose, not an
 * edge.
 */
export function supersededRulings(contents: string): string[] {
  const lines = contents.split(/\r?\n/);
  const ids = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:supersedes|amends):/.test(lines[index]!)) continue;
    let text = lines[index]!;
    for (let next = index + 1; next < lines.length && /^\s+\S/.test(lines[next]!); next += 1) text += `\n${lines[next]}`;
    for (const match of text.matchAll(/\bHR-(\d+)\b/g)) ids.add(`HR-${match[1]}`);
  }
  return [...ids];
}

/** Every model this record declares, by either accepted shape, deduplicated. */
export function declaredModels(contents: string): string[] {
  const models: string[] = [];
  const field = contents.match(/^top_model:\s*(.*)$/m)?.[1]?.trim();
  if (field !== undefined) models.push(field.replace(/^`|`$/g, ""));
  const flat = contents.replace(/\s+/g, " ");
  for (const match of flat.matchAll(PIN_SENTENCE)) models.push(match[1]!.trim());
  return [...new Set(models)];
}

/** Every decision record, with the pin fields and supersession edges this check reads. */
export function decisionRecords(repo: string): PinRecord[] {
  const dir = join(repo, DECISIONS_DIR);
  if (!existsSync(dir)) return [];
  const found: PinRecord[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!/^HR-.+\.md$/.test(entry)) continue;
    const file = join(DECISIONS_DIR, entry);
    const contents = readFileSync(join(dir, entry), "utf8");
    const lines = contents.split(/\r?\n/);
    const record: PinRecord = {
      id: entry.replace(/\.md$/, ""),
      file,
      binding: /^status:\s*binding\s*$/m.test(contents),
      models: declaredModels(contents),
      supersedes: supersededRulings(contents),
    };
    // A fence opened and never closed swallows every field under it, including
    // `top_model:` and `status:` — the record would read as declaring nothing.
    if (lines[0]?.trim() === "---" && lines.slice(1).filter((line) => line.trim() === "---").length === 0) {
      record.malformed = "frontmatter opens with `---` and is never closed — every field under it is unreadable";
    }
    found.push(record);
  }
  return found;
}

/** The `NAME="${A:-${B:-value}}"` pin default a shell script falls back to. */
export function shellPin(source: string, variable: string): string | undefined {
  const match = source.match(new RegExp(`${variable}="\\$\\{[A-Za-z_]+:-\\$\\{[A-Za-z_]+:-([^}"]+)\\}\\}"`));
  return match ? match[1] : undefined;
}

export function checkModelPin(repo: string): string[] {
  const errors: string[] = [];
  const paramsPath = join(repo, PARAMS_FILE);
  if (!existsSync(paramsPath)) return [`${PARAMS_FILE}: absent — the model pin cannot be checked`];
  const params = readFileSync(paramsPath, "utf8");
  const orchestrator = readBlock(params, "orchestrator");
  if (orchestrator.size === 0) {
    return [`${PARAMS_FILE}: no orchestrator block — the resting model must be stated where the launcher reads it`];
  }

  const records = decisionRecords(repo);
  const byId = new Map(records.map((row) => [row.id, row]));

  // 6. Unparsable records first: they are why a later "no ruling declares a pin"
  // could otherwise be reported as a state of the world rather than a read failure.
  for (const row of records) {
    if (row.malformed) errors.push(`${row.file}: ${row.malformed}`);
  }

  const pins = records.filter((row) => row.models.length > 0);
  for (const row of pins) {
    if (row.models.length > 1) {
      errors.push(
        `${row.file}: declares more than one resting model (${row.models.join(", ")}) — ` +
          `a ruling that contradicts itself pins nothing`,
      );
    }
    for (const model of row.models) {
      if (!MODEL_TOKEN.test(model)) {
        errors.push(`${row.file}: declares \`${model}\` as the resting model, which is not a model id`);
      }
    }
    if (!row.binding) {
      errors.push(
        `${row.file}: pins ${row.models.join(", ")} without \`status: binding\` — a pin nobody is bound by is not a pin`,
      );
    }
    for (const id of row.supersedes) {
      if (!byId.has(id)) {
        errors.push(`${row.file}: supersedes ${id}, which does not exist — the chain this pin claims to continue is broken`);
      }
    }
  }

  // 1. The live pin: the pin ruling no other pin ruling supersedes.
  const supersededByAPin = new Set(pins.flatMap((row) => row.supersedes));
  const usable = pins.filter((row) => row.binding && row.models.length === 1 && MODEL_TOKEN.test(row.models[0]!));
  const live = usable.filter((row) => !supersededByAPin.has(row.id));
  let livePin: PinRecord | undefined;
  if (pins.length === 0) {
    errors.push(`${DECISIONS_DIR}/: no decision record pins a resting top-orchestrator model — ${PARAMS_FILE} states one that no ruling backs`);
  } else if (live.length === 0) {
    errors.push(
      `${DECISIONS_DIR}/: every ruling that pins a resting model is superseded (${pins.map((row) => row.id).join(", ")}) — ` +
        `the chain forwards to nothing, so no pin is in force`,
    );
  } else if (live.length > 1) {
    errors.push(
      `${DECISIONS_DIR}/: ${live.length} rulings each claim to be the newest resting-model pin ` +
        `(${live.map((row) => `${row.file} pins ${row.models[0]}`).join("; ")}) — ` +
        `the newer one must name the older in \`supersedes:\``,
    );
  } else {
    livePin = live[0];
  }

  // 4. A binding ruling that supersedes a pin declares a pin itself.
  const pinIds = new Set(pins.map((row) => row.id));
  for (const row of records) {
    if (!row.binding || row.models.length > 0) continue;
    const touched = row.supersedes.filter((id) => pinIds.has(id));
    if (touched.length === 0) continue;
    errors.push(
      `${row.file}: supersedes ${touched.join(", ")}, which pin the resting model, but pins none itself — ` +
        `state the model it leaves in force, or a ruling that moves the pin is invisible to this check`,
    );
  }

  // 2. The parameter equals the live ruling.
  const at = (key: string) => `${PARAMS_FILE}:${orchestrator.get(key)?.line ?? 0} orchestrator.${key}`;
  const entry = orchestrator.get("top_model");
  if (!entry || !MODEL_TOKEN.test(entry.value)) {
    errors.push(`${at("top_model")}: missing or not a model id — the resting model must be stated as a value the launcher can pass to --model`);
  } else if (livePin && entry.value !== livePin.models[0]) {
    errors.push(
      `${at("top_model")}: ${entry.value} contradicts ${livePin.file}, which pins ${livePin.models[0]}`,
    );
  }

  // 3. The citation names the live ruling, and every record it names exists.
  if (entry) {
    const cited = citedRulings(params, entry.line);
    for (const id of cited) {
      const file = join(DECISIONS_DIR, `${id}.md`);
      if (!existsSync(join(repo, file))) errors.push(`${at("top_model")}: cites ${file}, which does not exist`);
    }
    if (cited.length === 0) {
      errors.push(`${at("top_model")}: states a model with no HUMAN RULING cited — a pin with no ruling beside it cannot be checked against one`);
    } else if (livePin && cited[0] !== livePin.id) {
      errors.push(
        `${at("top_model")}: cites ${cited[0]} as the ruling it follows, but the live pin is ${livePin.id} ` +
          `(${livePin.file}) — this is the 2026-08-04 drift, where the line still named the superseded ruling`,
      );
    }
  }

  // 5. The consumers. launch.sh is the value a fresh clone with no runtime.env
  // starts on, so a stale pin here is exactly what the meteorite test restores.
  const model = entry && MODEL_TOKEN.test(entry.value) ? entry.value : undefined;
  const launchPath = join(repo, LAUNCH_FILE);
  if (!existsSync(launchPath)) {
    errors.push(`${LAUNCH_FILE}: absent — the launcher that carries the pin into a fresh clone must exist`);
  } else {
    const pinned = shellPin(readFileSync(launchPath, "utf8"), "CLAUDE_MODEL");
    if (pinned === undefined) {
      errors.push(
        `${LAUNCH_FILE}: no CLAUDE_MODEL pin default found — an unpinned claude launch emits no --model ` +
          `and the top orchestrator silently becomes the account default`,
      );
    } else if (model && pinned !== model) {
      errors.push(
        `${LAUNCH_FILE}: CLAUDE_MODEL falls back to ${pinned}, but ${at("top_model")} is ${model} — ` +
          `a fresh clone with no runtime.env would start on the wrong model`,
      );
    }
  }

  const registryPath = join(repo, REGISTRY_FILE);
  if (!existsSync(registryPath)) {
    errors.push(`${REGISTRY_FILE}: absent — the closed catalog orchestrator.model_switch names must exist`);
  } else if (model) {
    const registry = readFileSync(registryPath, "utf8");
    if (!registry.includes(`'${model}'`) && !registry.includes(`"${model}"`)) {
      errors.push(
        `${REGISTRY_FILE}: the catalog does not contain ${model} — ${at("top_model")} pins a model the operator ` +
          `cannot select and no entry asserts is runnable`,
      );
    }
  }

  return errors;
}

if (import.meta.main) {
  const index = process.argv.indexOf("--repo");
  const repo = index >= 0 ? process.argv[index + 1] : process.cwd();
  if (!repo) throw new Error("--repo requires a path");
  const errors = checkModelPin(repo);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  const orchestrator = readBlock(readFileSync(join(repo, PARAMS_FILE), "utf8"), "orchestrator");
  const pins = decisionRecords(repo).filter((row) => row.models.length > 0);
  const superseded = new Set(pins.flatMap((row) => row.supersedes));
  const live = pins.filter((row) => row.binding && !superseded.has(row.id)).map((row) => row.id);
  console.log(
    `MODEL-PIN clean top_model=${orchestrator.get("top_model")?.value} ` +
      `source=${orchestrator.get("top_model_source")?.value} status=${orchestrator.get("top_model_status")?.value} ` +
      `pinned_by=${live.join(",")}`,
  );
}

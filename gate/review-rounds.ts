#!/usr/bin/env bun
import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Item = { rounds: number; noProgress: number; landedSha: string | null; park: null | "cap" | "no-progress" };
type State = { version: 1; cap: number; noProgressLimit: number; items: Record<string, Item>; overrides: Array<{ item: string; reason: string; at: string }> };

function die(message: string): never { console.error(`REVIEW_ROUNDS status=fail detail=${message}`); process.exit(2); }
function arg(name: string): string {
  const index = Bun.argv.indexOf(name);
  if (index < 0 || !Bun.argv[index + 1]) die(`missing-${name.slice(2)}`);
  return Bun.argv[index + 1];
}
function natural(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) die(`invalid-${name}`);
  return Number(value);
}
function validateItem(item: unknown): item is Item {
  if (!item || typeof item !== "object") return false;
  const value = item as Record<string, unknown>;
  return Number.isSafeInteger(value.rounds) && (value.rounds as number) >= 0 &&
    Number.isSafeInteger(value.noProgress) && (value.noProgress as number) >= 0 &&
    (value.landedSha === null || (typeof value.landedSha === "string" && /^[0-9a-f]{40}$/.test(value.landedSha))) &&
    (value.park === null || value.park === "cap" || value.park === "no-progress");
}
function load(path: string): State {
  let stat;
  try { stat = lstatSync(path); } catch { die(`state-missing file=${path}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o444) === 0) die(`state-unreadable file=${path}`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { die(`state-malformed file=${path}`); }
  const state = parsed as State;
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.cap) || state.cap < 1 ||
      !Number.isSafeInteger(state.noProgressLimit) || state.noProgressLimit < 1 ||
      !state.items || typeof state.items !== "object" || Array.isArray(state.items) ||
      !Object.values(state.items).every(validateItem) || !Array.isArray(state.overrides)) die(`state-malformed file=${path}`);
  return state;
}
function save(path: string, state: State): void {
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

const command = Bun.argv[2];
const path = resolve(arg("--state"));
if (command === "init") {
  const cap = natural(arg("--cap"), "cap");
  const noProgressLimit = natural(arg("--no-progress-limit"), "no-progress-limit");
  mkdirSync(dirname(path), { recursive: true });
  try { closeSync(openSync(path, "wx", 0o600)); } catch { die(`state-already-exists file=${path}`); }
  save(path, { version: 1, cap, noProgressLimit, items: {}, overrides: [] });
  console.log(`REVIEW_ROUNDS status=initialized cap=${cap} no_progress_limit=${noProgressLimit}`);
  process.exit(0);
}
const state = load(path);
const itemId = arg("--item-id");
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(itemId)) die("invalid-item-id");
const item = state.items[itemId] ?? { rounds: 0, noProgress: 0, landedSha: null, park: null };
if (command === "attempt") {
  if (item.park) die(`item=${itemId} parked=${item.park}`);
  if (item.rounds >= state.cap) { item.park = "cap"; state.items[itemId] = item; save(path, state); die(`item=${itemId} cap=${state.cap} parked=cap`); }
  item.rounds += 1;
  item.noProgress += 1;
  if (item.noProgress >= state.noProgressLimit) item.park = "no-progress";
  state.items[itemId] = item;
  save(path, state);
  if (item.park) die(`item=${itemId} consecutive_no_progress=${item.noProgress} parked=no-progress`);
  console.log(`REVIEW_ROUNDS status=pass item=${itemId} round=${item.rounds} no_progress=${item.noProgress}`);
} else if (command === "landed") {
  const sha = arg("--sha").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) die("invalid-sha");
  if (item.rounds < 1) die(`item=${itemId} landed-without-attempt`);
  item.landedSha = sha; item.noProgress = 0;
  state.items[itemId] = item; save(path, state);
  console.log(`REVIEW_ROUNDS status=landed item=${itemId} sha=${sha}`);
} else if (command === "override") {
  const reason = arg("--reason").trim();
  if (!reason || /[\r\n\t]/.test(reason)) die("invalid-override-reason");
  item.park = null; item.rounds = 0; item.noProgress = 0;
  state.items[itemId] = item; state.overrides.push({ item: itemId, reason, at: new Date().toISOString() }); save(path, state);
  console.log(`REVIEW_ROUNDS status=overridden item=${itemId}`);
} else die("unknown-command");

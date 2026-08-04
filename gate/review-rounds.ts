#!/usr/bin/env bun
import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

type Unpark = { decisionId: string; authorizedBy: string; at: string; previous: string; digest: string };
type Item = { rounds: number; noProgress: number; landedSha: string | null; park: null | "cap" | "no-progress"; unparkCredits?: number; unparks?: Unpark[] };
type State = { version: 1; cap: number; noProgressLimit: number; items: Record<string, Item> };

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
    (value.park === null || value.park === "cap" || value.park === "no-progress") &&
    (value.unparkCredits === undefined || (Number.isSafeInteger(value.unparkCredits) && (value.unparkCredits as number) >= 0)) &&
    (value.unparks === undefined || (Array.isArray(value.unparks) && value.unparks.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as Record<string, unknown>;
      return typeof record.decisionId === "string" && typeof record.authorizedBy === "string" &&
        typeof record.at === "string" && typeof record.previous === "string" && typeof record.digest === "string";
    })));
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
      !Object.values(state.items).every(validateItem)) die(`state-malformed file=${path}`);
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
  save(path, { version: 1, cap, noProgressLimit, items: {} });
  console.log(`REVIEW_ROUNDS status=initialized cap=${cap} no_progress_limit=${noProgressLimit}`);
  process.exit(0);
}
const state = load(path);
const itemId = arg("--item-id");
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(itemId)) die("invalid-item-id");
const item = state.items[itemId] ?? { rounds: 0, noProgress: 0, landedSha: null, park: null };
if (command === "round") {
  console.log(item.rounds);
} else if (command === "check") {
  if (item.park) die(`item=${itemId} parked=${item.park}`);
  console.log(`REVIEW_ROUNDS status=admissible item=${itemId} round=${item.rounds}`);
} else if (command === "attempt") {
  if (item.park) die(`item=${itemId} parked=${item.park}`);
  if (item.rounds >= state.cap && !(item.unparkCredits && item.unparkCredits > 0)) { item.park = "cap"; state.items[itemId] = item; save(path, state); die(`item=${itemId} cap=${state.cap} parked=cap`); }
  if (item.rounds >= state.cap) item.unparkCredits!--;
  item.rounds += 1;
  item.noProgress += 1;
  if (item.noProgress >= state.noProgressLimit) item.park = "no-progress";
  state.items[itemId] = item;
  save(path, state);
  if (item.park && !Bun.argv.includes("--defer-park-exit")) die(`item=${itemId} consecutive_no_progress=${item.noProgress} parked=no-progress`);
  console.log(`REVIEW_ROUNDS status=pass item=${itemId} round=${item.rounds} no_progress=${item.noProgress}`);
} else if (command === "landed") {
  const sha = arg("--sha").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) die("invalid-sha");
  if (item.rounds < 1) die(`item=${itemId} landed-without-attempt`);
  item.landedSha = sha; item.noProgress = 0;
  state.items[itemId] = item; save(path, state);
  console.log(`REVIEW_ROUNDS status=landed item=${itemId} sha=${sha}`);
} else if (command === "operator-unpark") {
  if (item.park !== "no-progress") die(`item=${itemId} not-no-progress-park`);
  const decisionId = arg("--decision-id");
  const authorizedBy = arg("--authorized-by");
  const at = arg("--authorized-at");
  const authorization = resolve(arg("--authorization"));
  const signature = resolve(arg("--signature"));
  if (Bun.argv.includes("--allowed-signers")) die("caller-controlled-trust-root-refused");
  const allowedSigners = resolve(dirname(path), "bpa-operator-unpark.allowed-signers");
  let allowedStat;
  try { allowedStat = lstatSync(allowedSigners); } catch { die("operator-trust-root-missing"); }
  if (!allowedStat.isFile() || allowedStat.isSymbolicLink() || (allowedStat.mode & 0o022) !== 0)
    die("operator-trust-root-unsafe");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(decisionId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(authorizedBy) || Number.isNaN(Date.parse(at))) die("invalid-authorization-fields");
  const expected = `operator-unpark-v1\nitem-id=${itemId}\ndecision-id=${decisionId}\nauthorized-by=${authorizedBy}\nauthorized-at=${at}\n`;
  let supplied: string;
  try { supplied = readFileSync(authorization, "utf8"); } catch { die("authorization-unreadable"); }
  if (supplied !== expected) die("authorization-payload-mismatch");
  const verified = Bun.spawnSync(["ssh-keygen", "-Y", "verify", "-f", allowedSigners, "-I", authorizedBy, "-n", "bpa-operator-unpark", "-s", signature], { stdin: Buffer.from(supplied), stdout: "pipe", stderr: "pipe" });
  if (verified.exitCode !== 0) die("operator-signature-invalid");
  const unparks = item.unparks ?? [];
  const prior = unparks.find((entry) => entry.decisionId === decisionId);
  if (prior) {
    console.log(`REVIEW_ROUNDS status=unpark-already-applied item=${itemId} decision=${decisionId} digest=${prior.digest}`);
    process.exit(0);
  }
  const previous = unparks.at(-1)?.digest ?? "0".repeat(64);
  const digest = createHash("sha256").update(`${previous}\n${expected}`).digest("hex");
  unparks.push({ decisionId, authorizedBy, at, previous, digest });
  item.unparks = unparks; item.unparkCredits = (item.unparkCredits ?? 0) + 1;
  item.noProgress = 0; item.park = null;
  state.items[itemId] = item; save(path, state);
  console.log(`REVIEW_ROUNDS status=unparked item=${itemId} decision=${decisionId} authorized_by=${authorizedBy} digest=${digest}`);
} else die("unknown-command");

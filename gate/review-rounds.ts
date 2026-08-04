#!/usr/bin/env bun
import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

type Unpark = { decisionId: string; authorizedBy: string; at: string; previous: string; digest: string; source?: string };
type Item = { rounds: number; noProgress: number; landedSha: string | null; park: null | "cap" | "no-progress"; unparkCredits?: number; unparks?: Unpark[] };
type State = { version: 1; cap: number; noProgressLimit: number; items: Record<string, Item>; decisions?: Record<string, string> };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// The tracked-decision authority. `instance/decisions/` reaches the integration
// branch only through this gate, and gate/land.sh reserves that directory
// against any candidate branch whose own version of a file there carries this
// marker in its frontmatter -- so a lane cannot land the authorization that
// would release it. The directory scanned here and the directory reserved there
// are the same one, and "carries an authorization" means the same thing in both
// (see frontmatterGrants below and the awk in land.sh's reserved-path loop);
// changing either without the other either opens the self-authorization hole
// that reserved path exists to close, or blocks the operator's verbatim words
// from landing whenever they quote the format back.
const DECISION_DIR = "instance/decisions";
const DECISION_MARKER = "operator-unpark: v2 ";
const DECISION_LINE = /^operator-unpark: v2 item=([^ ]+) decision=([^ ]+) park=no-progress$/;

function die(message: string): never { console.error(`REVIEW_ROUNDS status=fail detail=${message}`); process.exit(2); }
// A refusal that is scoped to one decision file and never to the gate. Every
// parse failure below that cannot be attributed to THIS item comes out here.
function warn(message: string): void { console.error(`REVIEW_ROUNDS status=warn detail=${message}`); }
// The authorization lives in the file's YAML frontmatter and nowhere else.
// `instance/decisions/` is where the operator's words are stored verbatim (Hard
// Rule 16), and those words routinely quote this very format back -- in prose, in
// a blockquote, in a fenced block. Matching at column 1 anywhere in the file
// cannot tell a quotation from a grant, and the doc that teaches the format
// prints the line in a fence, so capturing the operator's message about this
// feature would silently unpark whatever item it quotes. The grant is therefore
// put where prose cannot reach: between the opening `---` on line 1 and the first
// `---` that closes it. Anything else in the file is text about an authorization,
// not an authorization.
function frontmatterGrants(body: string): string[] {
  const lines = body.split("\n");
  if (lines[0] !== "---") return [];
  const grants: string[] = [];
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] === "---") return grants;
    if (lines[index]!.startsWith(DECISION_MARKER)) grants.push(lines[index]!);
  }
  // An unterminated frontmatter block is not a frontmatter block, so it carries
  // no authority. Under-accepting here is safe; over-accepting is the defect.
  return [];
}
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
        typeof record.at === "string" && typeof record.previous === "string" && typeof record.digest === "string" &&
        (record.source === undefined || typeof record.source === "string");
    })));
}
// The consumed-decision ledger is global, not per item: it is what makes a
// decision usable exactly once, for exactly the item it named.
function validateDecisions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([decisionId, boundItem]) =>
    ID_PATTERN.test(decisionId) && typeof boundItem === "string" && ID_PATTERN.test(boundItem));
}
// The payload a recorded event was chained over, reconstructed from the event's
// own fields. `source` is what distinguishes the two authorities: the tracked
// decision names the file it came from, the signature names its signer.
function unparkPayload(id: string, entry: Unpark): string {
  return entry.source === undefined
    ? `operator-unpark-v1\nitem-id=${id}\ndecision-id=${entry.decisionId}\nauthorized-by=${entry.authorizedBy}\nauthorized-at=${entry.at}\n`
    : `operator-unpark-v2\nitem-id=${id}\ndecision-id=${entry.decisionId}\nsource=${entry.source}\nauthorized-at=${entry.at}\n`;
}
// A hash chain that is written and never read is provenance, not tamper-evidence.
// Recompute every link from the recorded fields on load, so editing a decision
// id, an authorizer, a timestamp, a source path, or the order of events is a
// fail-closed refusal rather than a value the next event quietly chains onto.
function verifyUnparkChain(id: string, item: Item): boolean {
  let previous = "0".repeat(64);
  for (const entry of item.unparks ?? []) {
    // `authorizedBy` is not part of the v2 payload -- it is derived, not
    // supplied -- so the digest alone cannot speak for it. Bind it structurally
    // instead: `source` is present exactly for tracked-decision events, so
    // relabelling one authority as the other is a refusal rather than a field
    // the chain silently passes over.
    if ((entry.source !== undefined) !== (entry.authorizedBy === "tracked-decision")) return false;
    if (entry.previous !== previous) return false;
    if (entry.digest !== createHash("sha256").update(`${previous}\n${unparkPayload(id, entry)}`).digest("hex")) return false;
    previous = entry.digest;
  }
  return true;
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
      !Object.values(state.items).every(validateItem) ||
      !validateDecisions((parsed as Record<string, unknown>).decisions)) die(`state-malformed file=${path}`);
  for (const [id, item] of Object.entries(state.items)) {
    if (!verifyUnparkChain(id, item)) die(`unpark-chain-broken file=${path} item=${id}`);
    // The consumed-decision ledger is what makes a decision spendable once. A
    // state carrying the event but not the ledger entry would let the same
    // authorization apply again, so the two must agree or the state is malformed.
    for (const entry of item.unparks ?? []) {
      if ((state.decisions ?? {})[entry.decisionId] !== id) die(`unpark-ledger-missing file=${path} item=${id} decision=${entry.decisionId}`);
    }
  }
  return state;
}
function save(path: string, state: State): void {
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
function git(repo: string, args: string[]) {
  return Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
}
// Consume one operator authorization, whichever authority produced it. Both
// paths land here so replay is refused identically: the global ledger binds a
// decision id to the one item it released, forever.
function applyUnpark(grant: { decisionId: string; authorizedBy: string; at: string; payload: string; source?: string }):
  { status: "applied" | "already-applied" | "not-applicable"; digest: string } {
  const decisions = state.decisions ?? {};
  const bound = decisions[grant.decisionId];
  if (bound !== undefined && bound !== itemId) die(`decision-bound-to-other-item decision=${grant.decisionId} bound=${bound}`);
  const unparks = item.unparks ?? [];
  if (bound === itemId) {
    return { status: "already-applied", digest: unparks.find((entry) => entry.decisionId === grant.decisionId)?.digest ?? "" };
  }
  // Not applicable is not consumption: an authorization that arrives before the
  // park exists waits for it, and one that meets a `cap` park never fires.
  if (item.park !== "no-progress") return { status: "not-applicable", digest: "" };
  const previous = unparks.at(-1)?.digest ?? "0".repeat(64);
  const digest = createHash("sha256").update(`${previous}\n${grant.payload}`).digest("hex");
  unparks.push({ decisionId: grant.decisionId, authorizedBy: grant.authorizedBy, at: grant.at, previous, digest, ...(grant.source === undefined ? {} : { source: grant.source }) });
  item.unparks = unparks;
  item.unparkCredits = (item.unparkCredits ?? 0) + 1;
  item.noProgress = 0;
  item.park = null;
  decisions[grant.decisionId] = itemId;
  state.decisions = decisions;
  state.items[itemId] = item;
  save(path, state);
  return { status: "applied", digest };
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
if (!ID_PATTERN.test(itemId)) die("invalid-item-id");
const item = state.items[itemId] ?? { rounds: 0, noProgress: 0, landedSha: null, park: null };
if (command === "round") {
  console.log(item.rounds);
} else if (command === "check") {
  if (item.park) die(`item=${itemId} parked=${item.park}`);
  console.log(`REVIEW_ROUNDS status=admissible item=${itemId} round=${item.rounds}`);
} else if (command === "attempt") {
  // `--replay` reconstructs a round that origin already proves happened (a
  // durable attempt ref), as opposed to admitting a new one. The distinction
  // matters only when the reconstructed state is parked: the ref proves an
  // authorization had released that park when the attempt was made, but the
  // landing that granted it aborted before the release reached the target
  // branch, so the rebuilt state does not carry the credit. Refusing here is
  // what stranded the operator's one-time decision -- every later landing died
  // in the replay loop before either unpark authority was consulted, and the
  // decision could never be spent. Replay therefore counts the round and leaves
  // the park exactly as the target branch recorded it, for the authorities that
  // run after this loop to release. It must not manufacture a fresh park either:
  // a `no-progress` park is releasable by an operator decision and a `cap` park
  // is not, so re-deriving one here would strand the decision a second way.
  const replay = Bun.argv.includes("--replay");
  if (item.park && !replay) die(`item=${itemId} parked=${item.park}`);
  if (item.park) {
    item.rounds += 1;
    item.noProgress += 1;
  } else {
    if (item.rounds >= state.cap && !(item.unparkCredits && item.unparkCredits > 0)) { item.park = "cap"; state.items[itemId] = item; save(path, state); die(`item=${itemId} cap=${state.cap} parked=cap`); }
    if (item.rounds >= state.cap) item.unparkCredits!--;
    item.rounds += 1;
    item.noProgress += 1;
    if (item.noProgress >= state.noProgressLimit) item.park = "no-progress";
  }
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
  if (!ID_PATTERN.test(decisionId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(authorizedBy) || Number.isNaN(Date.parse(at))) die("invalid-authorization-fields");
  const expected = `operator-unpark-v1\nitem-id=${itemId}\ndecision-id=${decisionId}\nauthorized-by=${authorizedBy}\nauthorized-at=${at}\n`;
  let supplied: string;
  try { supplied = readFileSync(authorization, "utf8"); } catch { die("authorization-unreadable"); }
  if (supplied !== expected) die("authorization-payload-mismatch");
  const verified = Bun.spawnSync(["ssh-keygen", "-Y", "verify", "-f", allowedSigners, "-I", authorizedBy, "-n", "bpa-operator-unpark", "-s", signature], { stdin: Buffer.from(supplied), stdout: "pipe", stderr: "pipe" });
  if (verified.exitCode !== 0) die("operator-signature-invalid");
  const result = applyUnpark({ decisionId, authorizedBy, at, payload: expected });
  if (result.status === "already-applied") {
    console.log(`REVIEW_ROUNDS status=unpark-already-applied item=${itemId} decision=${decisionId} digest=${result.digest}`);
    process.exit(0);
  }
  console.log(`REVIEW_ROUNDS status=unparked item=${itemId} decision=${decisionId} authorized_by=${authorizedBy} digest=${result.digest}`);
} else if (command === "operator-unpark-decision") {
  // Authority by tracked decision. Nothing about the authorization comes from
  // the caller: not the payload, not the trust root, not even WHICH decision to
  // apply. The content root is an immutable commit SHA, and a ref NAME is
  // refused outright -- including `refs/remotes/origin/<target>`, which this
  // command used to trust. A remote-tracking ref is a local branch ref by
  // another name: every lane worktree here shares one Git common directory, so
  // any lane can point it at a commit origin has never held with an ordinary
  // `git update-ref`, and authorize itself with no push, no key and no
  // privilege. The caller resolves the SHA the way gate/land.sh already
  // resolves its push target -- `git ls-remote --refs origin refs/heads/<t>` --
  // and a SHA cannot be substituted after it is resolved.
  for (const rejected of ["--authorization", "--signature", "--allowed-signers", "--decision-id", "--decision-file"]) {
    if (Bun.argv.includes(rejected)) die("caller-controlled-trust-root-refused");
  }
  if (Bun.argv.includes("--target-branch")) die("ref-name-is-not-an-authority-root");
  const repo = resolve(arg("--repo"));
  const targetSha = arg("--target-sha").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(targetSha)) die("invalid-target-sha");
  if (git(repo, ["rev-parse", "--verify", "--quiet", `${targetSha}^{tree}`]).exitCode !== 0) die(`origin-target-missing sha=${targetSha}`);
  const scan = git(repo, ["grep", "-l", "-z", "-E", "-e", `^${DECISION_MARKER}`, targetSha, "--", `${DECISION_DIR}/`]);
  if (scan.exitCode !== 0 && scan.exitCode !== 1) die(`decision-scan-failed sha=${targetSha}`);
  const grants: Array<{ decisionId: string; at: string; payload: string; source: string }> = [];
  // `-z` keeps the path bytes raw. Without it Git C-quotes any non-ASCII or
  // special path, and every read of the quoted string fails -- which used to be
  // a `die`, i.e. one oddly named file under instance/decisions/ took the whole
  // gate down.
  for (const entry of scan.stdout.toString().split("\0")) {
    if (!entry) continue;
    const source = entry.startsWith(`${targetSha}:`) ? entry.slice(targetSha.length + 1) : die(`decision-scan-failed sha=${targetSha}`);
    const shown = git(repo, ["show", `${targetSha}:${source}`]);
    if (shown.exitCode !== 0) { warn(`decision-unreadable path=${source}`); continue; }
    const shaped = frontmatterGrants(shown.stdout.toString());
    if (shaped.length === 0) continue;
    // Filter by item BEFORE any strict check. A decision file that does not
    // name this item is not this item's business: it is skipped, never a die.
    // Every refusal below used to fire ahead of this filter, so one malformed,
    // archived or hostile file aborted every landing of every item -- including
    // the landing of the branch that would delete it, which left no repair path
    // through the gate at all. A bad decision must fail that decision only.
    if (!shaped.some((line) => line.includes(` item=${itemId} `))) {
      if (shaped.length !== 1 || !DECISION_LINE.test(shaped[0]!)) warn(`decision-ignored-not-this-item path=${source}`);
      continue;
    }
    // From here the file DOES name this item, so it is held to the whole
    // contract: an authorization-shaped line for this item is never silently
    // ignored, and a file that names it cannot be padded with extra grants, so
    // "which decision authorised this" has exactly one answer.
    if (shaped.length !== 1) die(`multiple-authorizations path=${source} count=${shaped.length}`);
    const parsed = DECISION_LINE.exec(shaped[0]!);
    if (!parsed) die(`malformed-authorization path=${source}`);
    const [, authorizedItem, decisionId] = parsed as unknown as [string, string, string];
    if (!ID_PATTERN.test(authorizedItem) || !ID_PATTERN.test(decisionId)) die(`malformed-authorization path=${source}`);
    // The decision id IS the file name, so a decision is one tracked file and a
    // reader can go from the audit record straight to the operator's words.
    if (source !== `${DECISION_DIR}/${decisionId}.md`) die(`decision-id-path-mismatch path=${source} decision=${decisionId}`);
    if (authorizedItem !== itemId) continue;
    const dated = git(repo, ["log", "-1", "--format=%cI", targetSha, "--", source]);
    const at = dated.exitCode === 0 ? dated.stdout.toString().trim() : "";
    if (!at) die(`decision-provenance-missing path=${source}`);
    grants.push({ decisionId, at, source, payload: `operator-unpark-v2\nitem-id=${itemId}\ndecision-id=${decisionId}\nsource=${source}\nauthorized-at=${at}\n` });
  }
  if (grants.length === 0) {
    console.log(`REVIEW_ROUNDS status=unpark-none item=${itemId} sha=${targetSha}`);
    process.exit(0);
  }
  for (const grant of grants.sort((left, right) => left.decisionId.localeCompare(right.decisionId))) {
    const result = applyUnpark({ decisionId: grant.decisionId, authorizedBy: "tracked-decision", at: grant.at, payload: grant.payload, source: grant.source });
    if (result.status === "applied") {
      console.log(`REVIEW_ROUNDS status=unparked item=${itemId} decision=${grant.decisionId} source=${grant.source} authorized_at=${grant.at} digest=${result.digest}`);
    } else if (result.status === "already-applied") {
      console.log(`REVIEW_ROUNDS status=unpark-already-applied item=${itemId} decision=${grant.decisionId} digest=${result.digest}`);
    } else {
      console.log(`REVIEW_ROUNDS status=unpark-not-applicable item=${itemId} decision=${grant.decisionId} park=${item.park ?? "none"}`);
    }
  }
} else die("unknown-command");

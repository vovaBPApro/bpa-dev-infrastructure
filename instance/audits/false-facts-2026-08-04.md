# False-facts audit — every "fact" the system states to its own agents

Dispatched at the operator's explicit request (Telegram 2404), above the lane cap.
Read-only audit. Nothing was changed, deployed, installed, started, stopped or landed.

## Pack manifest echo (consumption check)

- lane-lifecycle  sha256:5c085937730a  # Lane Lifecycle
- verification-and-locks  sha256:b55e7c26f233  # Verification and Regression Locks
- tool-permissions  sha256:955630cc416e  # Tool Permissions
- repository-hygiene  sha256:02acdffe2a56  # Repository Hygiene
- isolated-test-environments  sha256:6ffd35d7c9f1  # Isolated Test Environments
- operator-feedback  sha256:6dc6f5d4768f  # Operator Feedback
- instruction-layers  sha256:cd21f4ce0990  # Instruction Layers
- branching-policy  sha256:98cd92116325  # Branching Policy
- reproducible-from-git  sha256:822d9efe694b  # Reproducible From Git

INSTANCE FACTS received: `phase=sole-mission active_scope=v3-infrastructure-to-cutover
capture.mode=manual operator.language=uk` — one of those four is false, see F2.

---

## The structural finding, first, because it reframes the rest

`tools/instructions/session-load.ts:239` reads `instance/params.yaml` and pushes it into
the orchestrator's SessionStart context **verbatim, comments included**. `compose.ts:434`
prints four of its values into every lane pack. So `params.yaml` is not a config file: it
is the single largest block of asserted fact this system feeds an agent, it is delivered
whole to the role with the most authority, and it is the only such channel with **no
schema and no verifier of any kind**.

Measured consumption of `params.yaml` keys by code, not by assumption:

| key | read by |
|---|---|
| `phase.current`, `phase.active_scope`, `capture.mode`, `operator.language` | `compose.ts:282` → every pack header |
| `capture.mode` | `ledger.ts:222` |
| `fleet.floor`, `fleet.keepalive_interval_minutes` | `daemon/autonomy-keepalive.ts:7` (live daemon) |
| `fleet.notify_human_below` | `orchestrator/watchdog.sh:616` |
| `repos.git_remote` | `gate/land.sh:98` |
| **everything else** | **nothing — but all of it reaches the orchestrator via session-load** |

`active_scope` was not an isolated defect. It was the one key in this file that happened
to be printed in a header where somebody eventually read it.

---

## Ranked findings — by blast radius on agent behaviour

### F1 — `fleet.floor: 10` / `ceiling: 15` — **false**, and it drives dispatch

**Asserted:** `instance/params.yaml`, `fleet.floor: 10  # HIS TARGET (2026-07-31): «У тебе
задача — десять лейнів стабільно тримати»`, `ceiling: 15`, `status: active`.

**Consumed by:** `daemon/autonomy-keepalive.ts:7` (live — `daemon/server.ts:1593`
constructs `AutonomyKeepalive` with it) and `session-load.ts:239`, which puts the line and
its comment into the orchestrator's standing context at every session start.

**True?** **False.** `instance/decisions/HR-2342.md` is `status: binding` and supersedes it
*by name*: "**At most three lanes run in parallel.** This replaces the 'fleet floor of 10'
that the autonomy nudge asserts and that no one ever derived." `HR-2398.md` amends the
scope (per repository) and leaves the number. `instructions/autonomy-and-capacity.md` is
current and correct — it cites both rulings and even writes "HR-281 was given when the
configured floor **was** ten", past tense — while `params.yaml` still configures ten and
the daemon still reads ten.

**How established:** read both HR files; `grep` for readers of `fleet.floor`; confirmed the
live wiring at `daemon/server.ts:1593`.

**What an agent does wrong:** the orchestrator starts every session with an instance fact
saying the operator's target is ten concurrent lanes, against a binding cap of three. This
is the worst possible key to have stale, because HR-2342's own argument is that width above
capacity *corrupts the evidence the fleet produces* — a false floor does not merely waste
quota, it degrades every green the fleet reports. Two L1 sources (a binding doc and an
instance param) directly contradict each other, and the agent receives both.

### F2 — `capture.mode: manual` — **false**, live mirror, in every pack header

**Asserted:** `params.yaml capture.mode: manual`, plus a comment instructing that the mode
flips to `daemon` "only when the mirror is proven live". Restated in prose by
`instructions/orchestrator-fallback.md` §"Human capture — read `capture.mode`, do not
assume the mirror is live" (orchestrator **and** manager baseline packs): "While
`capture.mode: manual`, the daemon inbox mirror is NOT a proven live transport: the
incoming orchestrator captures every Human directive into the decisions ledger **by hand**
before dispatch."

**True?** **False.** The mirror has been live since 2026-07-30.

- `/root/bpa-dev-infrastructure/instance/decisions/inbox.jsonl` — 739 rows, 396318 bytes,
  mtime 2026-08-04 23:08 CEST.
- First row `msg_id 5, ts 2026-07-30T11:53:22Z`; last row `msg_id 2408, ts
  2026-08-04T21:08:31.000Z` — written while this audit was running.
- Writer: `daemon/server.ts:3719` → `appendInboxLine` (`daemon/inbox-mirror.ts`).
  `bpa-telegram-daemon.service` is `enabled` and `active`.

**What an agent does wrong:** two things. It hand-captures directives that are already on
disk, spending a session's attention on a transport that works. And it is told to report
`NO-GO` on a "capture is live" claim that is true — the doc converts a working mechanism
into a standing degraded-mode belief.

**Do not fix this with a one-word edit.** `ledger.ts:222` makes a *missing* `inbox.jsonl`
a hard FAIL when the mode is `daemon`. `inbox.jsonl` is gitignored
(`instance/decisions/.gitignore:4`), so it is absent in **every lane worktree** — flipping
the flag to match reality turns the instruction checker red in every lane. The honest fix
has to distinguish "the canonical checkout, where the mirror writes" from "a lane
worktree, where the file cannot exist by design". That is a successor row, not an edit.

### F3 — `tool-permissions.md`: "Hooks enforce the floor" — **false**, in every lane pack

**Asserted:** `instructions/tool-permissions.md` (coder + reviewer baseline): "Maintain a
versioned, fail-closed permission surface", a three-way Allow/Approval/Deny policy, and
"**Hooks enforce the floor: validate lane ownership and path scope, block denied commands,
require explicit approval where configured, and emit auditable evidence.**"

**True?** **False, for the hooks and the versioned policy.**

- `git ls-files` matching `settings.json`, `hooks/` or `permission` returns exactly one
  path: `instructions/tool-permissions.md` itself. There is no versioned permission policy.
- There is no `.claude/` directory in the repository.
- `/root/.claude/settings.json` is 48 bytes with a single key,
  `skipDangerousModePermissionPrompt`. No `hooks` key.
- Every lane launches with `--dangerously-skip-permissions` (visible in the live
  `lane-*.service` argv).

**In fairness:** the doc's *opening* paragraph is true and important — it says harness
prompts are not the safety boundary and names the real floor (landing gate, mandatory
independent risky-path review, canonical secret-scan, isolated worktrees). Those four all
exist and were exercised in this audit. The defect is confined to the hooks and
versioned-policy paragraphs, which describe a mechanism that was never built.

**What an agent does wrong:** this is the most dangerous shape in the whole audit — a
false *safety* claim. A lane that believes path-scope validation and denied-command
blocking will catch it is measurably more willing to attempt the thing that would be
caught. The doc tells it to "fail closed and route an asynchronous decision request" when a
command does not fit "the versioned allow/approval/deny policy" — there is no such policy
to fit, so the instruction is unexecutable as written.

### F4 — the daemon's fleet backstop is inert — proven by execution

**Asserted:** `params.yaml`: `keepalive_interval_minutes: 15  # daemon timer backstop;
independent of lane exit events`.

**True?** **False — the timer backstop has never fired.**
`daemon/autonomy-keepalive.ts:32` gates the nudge on `hasOpenWorkboardRows`, which parses
the **v2 bullet board**: it looks for a `## Open` heading and lines matching `^- \*\*`.
`instance/workboard.md` is a v3 **table** — its headings are `## Phase 0` … `## Phase 4`,
and it contains no `- **` bullet rows at all.

Executed against the real board:

```
bun -e 'import {hasOpenWorkboardRows} from "./daemon/autonomy-keepalive.ts"; ...'
hasOpenWorkboardRows(real v3 board) = false
```

Corroborated by the journal: `journalctl -u bpa-telegram-daemon` contains **no** "below
floor" line, all-time. Only the lane-exit event path has ever delivered a nudge.

**What an agent does wrong:** nothing wakes an idle orchestrator on the timer path. If the
fleet reaches zero without a lane-exit event — a daemon restart, a missed event, lanes
dying together — it stays at zero until the operator notices. This is the exact V3-2.11
incident (a watchdog parsing the deprecated board) reproduced in a **second, separate
mechanism** that V3-2.11 did not touch. Note the compounding: F1 makes the floor wrong and
F4 makes the comparison against it never happen, so the two defects have been hiding each
other.

### F5 — `gate/land-batch.sh` does not exist — named by four binding docs

**Asserted:** `branching-policy.md:30` (a **Hard Floor** doc, in every coder pack): "the
only path into `main` is the landing gate (`gate/land.sh`, or `gate/land-batch.sh` for a
reviewed serialized batch of up to 3 disjoint branches)". Also `landing-and-merge.md:17`,
`review-policy.md:34`, `orchestrator-playbook.md:30`.

**True?** **False.** `ls gate/` — the file is absent. `gate/land.sh` exists.

**Why nothing caught it:** `tools/instructions/check.ts:261` *does* have a referenced-command
check, and it is the closest existing thing to the mechanism this audit should produce. But
it matches only backticked strings beginning `bun tools/` or `bash gate/` — a bare path in
backticks, which is how docs actually cite files, is invisible to it. The checker reports
green.

**What an agent does wrong:** an orchestrator told to land a reviewed batch reaches for a
script that is not there, mid-landing.

### F6 — `fleet_idle_check: tools/state-contract/check.ts:FLEET-IDLE` — **false**

**Asserted:** `params.yaml`, with the sentence "Enforced by the state-contract checker: open
work plus zero measured system lane units is FLEET-IDLE; an unavailable system lane count
also fails closed." Also cited by `instance/decisions/HR-281.md:52` and workboard V3-0.6.

**True?** **False.** `find` for `*state-contract*` returns only those prose mentions; the
directory `tools/state-contract/` does not exist. Nothing enforces FLEET-IDLE — the live
mechanism moved to `daemon/autonomy-keepalive.ts`, which is the one F4 shows is inert.

**What an agent does wrong:** it believes a fail-closed idle detector is watching, and does
not build or check one. In the orchestrator's SessionStart dump.

### F7 — `orchestrator/watchdog.sh` as "the operational projection" — not running here

**Asserted:** `lane-lifecycle.md` (every coder pack): "Liveness is derived from a fresh
lease, heartbeat, process probe, and durable status—not a chat claim.
`orchestrator/watchdog.sh` and `orchestrator/status.sh` are the operational projections."

**True?** The scripts are tracked. The mechanism is **not running on this host**:
`bpa-orchestrator-watchdog.service` and `.timer` are not installed in
`/etc/systemd/system/` (`systemctl status` → "could not be found"), and no
`orchestrator/watchdog.sh` process exists. The only live watchdog pair is
`orch-fleet-nudge{,-liveness}`, a different mechanism.

**Consequence:** `fleet.notify_human_below: 3` — whose sole consumer is
`orchestrator/watchdog.sh:616` — is inert. The operator will not be paged by it.

### F8 — `expected-mechanism-exclusions.tsv`: several rows false by their own header

**Asserted:** the file's header says "**Rows are invalid as soon as the mechanism becomes
reachable.**" Measured against the host:

| row | claimed | actual |
|---|---|---|
| `unit:bpa-telegram-daemon.service` | "activation is parked pending accepted bootstrap stage" | enabled, active |
| `unit:orch-fleet-nudge.timer` | "V3-2.11 keeps the watchdog deliberately stopped" | enabled, active (armed 22:21 CEST tonight) |
| `unit:orch-fleet-nudge-liveness.timer` | same | enabled, active |
| `unit:orch-morning-report.timer` | "activation is parked" | enabled, active |
| `unit:orch-morning-report.service` | "only reachable through an unarmed timer" | timer armed; the service ran today and is `failed`, `Result=exit-code`, `ExecMainStatus=1` |

**Why nothing caught it:** `check-mechanism-reachability.ts` consumes only the row's **id**;
the reason string is prose no mechanism ever reads. The file states an invalidation
condition it cannot enforce.

**What an agent does wrong:** an agent auditing supervision reads that the fleet watchdog is
deliberately stopped and the daemon unactivated, and reasons from a host that stopped
existing hours ago. `orch-morning-report.service` failing today is a live, unnoticed
defect this file actively conceals — the operator's morning readiness rhythm
(`operator-feedback`, binding) has a failed unit behind it.

### F9 — `instance/README.md` does not exist — named by `CLAUDE.md`

**Asserted:** `CLAUDE.md:37`: "`instance/README.md` indexes this installation's facts and
retained evidence." Also `instance/decisions/HR-735.md:23` — binding through
`operator-feedback` — sends an agent to `instance/README.md` §"Where the full Telegram
history actually lives" before asking the operator anything. Also `daemon/inbox-mirror.ts:9`.

**True?** **False.** The file is absent. (`instructions/README.md`, the other entry point in
the same sentence, exists and its freshness check passes.)

**What an agent does wrong:** HR-735 requires checking whether the operator already answered
a question *before* asking. The routing target for that check does not exist, so the
precondition is unsatisfiable and the agent either asks anyway or skips the check.

### F10 — `migration-prep/` does not exist — cited as the design authority in every pack

**Asserted:** `instructions/instruction-layers.md` (every pack): "Full design rationale:
`migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md`." The same path is cited by
`instance/packs.conf`, `instance/tags.conf`, `instance/parked.md`, `params.yaml`, eight
files under `tools/instructions/`, `orchestrator/dispatch-lane.sh`, `daemon/server.ts` and
`daemon/inbox-mirror.ts`. `params.yaml operator.timezone` cites a second file in the same
absent directory (`migration-prep/HUMAN_REQUIREMENTS_MATRIX_2026-07-28.md`).

**True?** **False.** The directory does not exist in this repository.

**What an agent does wrong:** it is told the binding text is a snapshot and the rationale
lives elsewhere; when it goes to resolve a genuine ambiguity — what §2.3 or §2.4 actually
requires — there is nothing there. Low harm per incident, very wide surface.

### F11 — `workspace/repos.conf` does not exist

**Asserted:** `repo-layout.md:40`: "`workspace/repos.conf` is the machine-readable registry
of managed repos". **False** — no `workspace/` directory. This one matters more the day a
product repo appears, which HR-2398 says is the operator's morning decision.

### F12 — `unit-path-exemptions.tsv` contradicts `required-mechanisms.tsv`

`unit-path-exemptions.tsv` excuses `bpa-meteorite.service` because "`meteorite/run.sh` not
yet built on v3; tracked at instance/workboard.md row V3-1.5". `meteorite/run.sh` **exists**
and `required-mechanisms.tsv` lists it as `runner:meteorite`. The exemption's evidence
string is false; the other four rows in that class are accurate (`orchestrator/full-suite.sh`,
`orchestrator/morning.sh`, `bootstrap/check-deployed-drift.sh` and every `database/`,
`deploy/` and `instance/live-stands/` target are all genuinely absent — verified
individually).

### F13 — `github-protected-refs.tsv` — **unverifiable** for protection, refined

**Asserted:** five refs exist on GitHub with the branch API `protected` flag true.

**Established, split into two claims:**

- **Existence: true and checked.** `git ls-remote --heads origin` over ssh returns exactly
  one hit each for `main`, `v3`, `v2-deprecated`, `ag-s3-1-r3`, `ag-s3-2-r3`.
- **Protection: UNKNOWN.** `bash tools/check-github-ref-protection.sh` exits **2** with
  `NO-GO github-ref-protection reason=credential-missing set=GITHUB_TOKEN-or-GH_TOKEN`.

**The checker itself is correct and fail-closed** — it dies on a missing credential rather
than passing. Worth recording because it is the only mechanism in this audit that handles
its own unverifiability properly, and it is the template for the rest. Its one caller is its
own test file, which uses stubbed API responses, so no suite ever asserts the live claim.

### F14 — `orchestrator.top_model: claude-fable-5`, `top_model_status: pinned`

The live top orchestrator (tmux `bpa-orchestrator`, pid 1399183) runs `claude --model
claude-opus-5`. `params.yaml` already carries a comment recording a version of this drift
dated 2026-08-01 (naming `claude-sonnet-5`), so the divergence is known and honestly
written down — but the machine-readable value still reads `pinned`, and the comment now
names the wrong model. Nothing reads `top_model`; it reaches the orchestrator only via
session-load. **False, recorded, low blast radius.**

### F15 — `coder_provider: codex` / `manager_provider: codex` — **false**

`instance/lane-agent-command.conf`, which is the file the launcher actually consumes, has
been `claude --model claude-opus-5` since 2026-08-04 (operator instruction, Telegram 2082,
recorded in the conf's own header). Every running agent process on this host is
`claude-opus-5`. `params.yaml` still says Codex for both roles, and its `top_model` comment
still reasons about "minimizing FABLE quota burn" because "all child agents are raised on
Codex". No code reads these keys; the orchestrator gets them via session-load.

**What an agent does wrong:** quota arithmetic. An orchestrator planning a night's work
believes lane-hours bill to Codex when they bill to Anthropic — the same account it is
itself running on, and the one `instance/quota-readings.tsv` exists to measure.

### F16 — `phase.current: sole-mission` — **true-but-unenforced**, confirmed

Currently true. Nothing would notice if it stopped being true:

- `sunset:` is only type-checked as a string (`schema.ts:164`); no predicate is ever
  evaluated.
- **No doc in `instructions/` carries a `sunset:` field at all** — `grep -n "^sunset:"
  instructions/*.md CLAUDE.md` returns nothing. CLAUDE.md Hard Rule 6 states its sunset in
  prose only.
- The string `sole-mission` appears in no `.ts` or `.sh` outside `instance/`.

It is nonetheless one of only four values printed in every pack's INSTANCE FACTS line — the
header carries the key with the least mechanical meaning, while `fleet.floor`, which drives
dispatch, is not in it.

---

## True and checked — recorded so the report is falsifiable in both directions

- **Host facts all match:** `hostname` = `bpa-infra`; `nproc` = 12; `free -g` total = 251;
  `144.76.185.238` present on `enp4s0`; Ubuntu 24.04.4 LTS.
- **`repos.git_remote`** — read by `gate/land.sh:98` and pinned across landings; ssh to
  origin works.
- **The three mechanism manifests are accurate.** Every unit template named by
  `expected-units.tsv` exists in its declared source directory; every target in
  `required-mechanisms.tsv` exists; `bun tools/check-mechanism-reachability.ts` and
  `bun tools/check-documented-mission-cli.ts` both exit 0.
- **`repository-hygiene`'s "ignored `instance/decisions/inbox.jsonl`"** — confirmed by
  `git check-ignore -v` via `instance/decisions/.gitignore:4`. Raw chat is not committable
  by accident, which matters given the `git add -A` scratch-commit pattern `lane-lifecycle`
  teaches.
- **Hard Rule 5** — `AGENTS.md` is a symlink to `CLAUDE.md`; no `GEMINI.md` or `CODEX.md`.
- **Hard Rule 4** — `git ls-files "*.py"` is empty.
- **`instructions/autonomy-and-capacity.md`** is current on the lane cap and cites both
  rulings correctly. This is what makes F1 a contradiction rather than a shared error.
- **`bash tools/check-decision-ledger-drift.sh`** exits 0.
- **`bun tools/instructions/check.ts --repo /root/bpa-dev-infrastructure`** exits 0 with no
  FAIL and no WARN — which is the point of this audit, not a reassurance.

---

## CLAUDE.md Hard Rules — which are mechanisms and which are assertions

Asked for explicitly in the mission scope.

**Backed by a mechanism that would refuse:** Rule 2 (secret scan —
`gate/land-lib.sh:661`, run by the landing gate); Rules 3 and 8 (report contract —
`gate/completion-guard.ts`, exit 2 on violation); Rule 7's floor list (floor checker, drift
in `CLAUDE.md` is FAIL); Rule 9 (`gate/review-artifact-check.sh` + `gate/review-policy.conf`
+ the `review:` field guard); Rule 10 (guard exits 2 or 3, never launders a failure); Rule
12 (`hygiene/reap.sh` with `instance/hygiene-protected-branches.txt`, report-by-default).

**Assertion only — nothing would notice a violation:** Rule 4 (Bun/TS only — true today, no
checker); Rule 5 (no vendor prompt forks — true today, no checker); **Rule 6** (single-repo
boundary — nothing enforces it, and its `sunset: phase != sole-mission` predicate is never
evaluated by anything, per F16); Rule 13 (one visible mission chain); Rule 14 (ask almost
never); Rule 15 (do not outsource agent work); Rule 16 (preserve verbatim words — the ledger
checker validates quote drift, but nothing binds a *mission artifact* to a verbatim block);
Rule 17 (language).

That split is itself worth the operator's attention: the rules with mechanisms are the ones
about artifacts, and the rules without are the ones about **judgement** — which is exactly
the set a false premise corrupts.

---

## Proposed mechanism — smallest thing that makes this class fail closed

Not built, per the mission. Ranked by cost.

**The general shape:** every fact the system states to an agent carries a machine-checkable
predicate, and the checker that already runs refuses when the predicate is absent or false.
"Absent" must be a failure, not a skip — that is the whole lesson of `active_scope`, which
had no predicate and therefore never had anything to fail.

**(a) Widen the check that already exists — cheapest, catches five findings.**
`tools/instructions/check.ts:261` already verifies referenced commands, but only for
backticks starting `bun tools/` or `bash gate/`. Change the match to: any backticked token
in a `status: binding` doc that looks like a repo-relative path must exist, with an explicit
`absent-by-design:` allowlist in `instance/` for the deliberate negatives (`GEMINI.md`,
`CODEX.md`) and for gitignored runtime files (`inbox.jsonl`). F5, F9, F10, F11 and half of
F12 are one regex apart from being caught, and the fix is confined to a checker that is
already wired into the gate and already fails per-doc.

**(b) A schema for `params.yaml` — the actual hole.** Add `instance/params.schema.yaml`,
keyed by param path, where every key must carry exactly one of:

- `enum: [...]` — a closed vocabulary (`active_scope`, `phase.current`, `capture.mode`,
  `fleet.status`). This is the `active_scope` fix generalised.
- `verify: <command>` — exit 0 means still true. `capture.mode` becomes a two-line
  comparison between the flag and whether the mirror wrote recently; `fleet_idle_check`
  becomes a path test; `vm.cores` becomes `nproc`; `fleet.floor` becomes a comparison
  against the newest binding HR that names it.
- `verify: unverifiable:<reason>` — renders as **UNKNOWN** wherever the value is presented,
  and is never allowed to read as truth. `github-protected-refs.tsv` already behaves this
  way; this makes it the rule.
- `verify: none` — permitted only with `expires: <date>`, after which the checker reddens.

A key with no schema entry is a FAIL. That is the fail-closed property: adding a fact to
this file must cost you a predicate, or the checker stops you.

**(c) Manifest reasons become predicates.** `expected-mechanism-exclusions.tsv` already
declares its invalidation condition in its own header — make the checker enforce it by
requiring each reason to name a testable condition (`unarmed:<unit>` → `systemctl
is-enabled` must not return `enabled`) instead of prose. F8 becomes automatic, and the
`orch-morning-report.service` failure stops being concealed.

**(d) One thing to deliberately NOT do.** Do not lengthen the pack's INSTANCE FACTS header.
`phase` and `operator.language` are in it and drive nothing; `fleet.floor`, which drives
dispatch volume, is not. The problem is not how many facts are stated — it is that no fact
is required to be checkable. Adding unverified values to the header would make this worse
while looking like a fix.

**Sequencing note for whoever takes the successor row:** F2's fix is blocked behind the
lane-worktree/canonical-checkout distinction described above; F1's fix is a value change
plus deciding whether `fleet.floor` should exist at all now that the binding cap lives in
the decisions ledger and `autonomy-and-capacity.md`. Doing (a) first is safe, independent,
and closes the widest surface for the least review.

---

commit: 2ff3881c7a4a44d120ded2e2cb2ac190d6e46327 [ORCH] correct the active scope, and repair the red main I pushed
verify: bun tools/instructions/check.ts --repo /root/bpa-dev-infrastructure
result: clean
secret-scan: clean
remaining: sixteen findings, none fixed by design — read-only audit. Successor rows, in the order argued above: (a) widen the referenced-path check in tools/instructions/check.ts; (b) schema plus per-key verifier for instance/params.yaml; (c) predicate-valued reasons in expected-mechanism-exclusions.tsv. Two live defects found in passing and NOT part of this audit's scope, each needing its own row: daemon/autonomy-keepalive.ts parses the deprecated workboard so the fleet timer backstop has never fired (F4), and orch-morning-report.service is in a failed state on this host (F8).

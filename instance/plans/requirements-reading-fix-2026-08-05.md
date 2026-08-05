# Plan — make "he told us" mechanically equal to "it is in front of us"

- mission: Telegram 2469 — design the fix for "he tells us things and they are not acted on"
- date: 2026-08-05
- branch: `ag-v3-fable-plan`, written against HEAD `d3fdb6d`
- evidence base: `ag-v3-req-audit:instance/audits/requirements-reading-2026-08-05.md` (F1–F8),
  `instance/decisions/HR-2451.md`, `instance/in-flight-2026-08-05-night.md`, and direct
  reads of `compose.ts`, `session-load.ts`, `ledger.ts`, `launch.sh`, `check.ts`
- status: **plan only** — no code, no decision file, no workboard row changed

## Manifest echo (consumption check)

- orchestrator-playbook sha256:10dc2e7be7e2 — Orchestrator Playbook
- orchestrator-fallback sha256:811f13bc3373 — Orchestrator Session Portability
- autonomy-and-capacity sha256:8b591407c2bd — Autonomy and Capacity
- landing-and-merge sha256:951d9781cffa — Landing and Merge
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

---

## The design in one paragraph

Every list an agent reads today is assembled by an **allowlist** predicate — "show me
`state: pending`" — and nothing on this board satisfies it, so a well-captured requirement
reaches nobody, and the file that captured it suppresses the raw inbox row on filename
alone. The fix is to invert the polarity everywhere, once: **a requirement is visible
unless a machine-checkable proof of closure exists**, absence of bookkeeping is a suite
FAIL rather than silence, every closure proof is re-verified on every run (so it cannot rot
when the board is renumbered), and the checkers themselves gain an automated invocation
site — because I verified that today `check.ts --strict` and `ledger.ts` are wired into
**nothing**: no gate, no unit, no timer runs them against the real corpus. Six of the seven
items below widen mechanisms that already exist (`ledger.ts`, `check.ts`, `compose.ts`,
`session-load.ts`, `dispatch-check.ts`, the exemption-ledger pattern, the generated-README
freshness pattern); only the outbound-retention decision is new, and it is his to make.

One verified correction to the mission brief: the trap is even worse than F3 states. Not
only does no HR file carry `state: pending` — the checker that would flag the resulting
debt **has no execution path at all**. Fixing the predicate without fixing the wiring
reproduces the R4 defect the in-flight handoff already names: "a predicate nobody runs is
the same shape as a rule nobody enforces."

---

## Ranked plan

Risk note that applies to items 1–5: they modify evidence-gate logic and orchestrator
core. Per Hard Rule 9 / `roles` risk routing, every one of them requires **independent,
preferably cross-vendor review**, and per `landing-and-merge` they land only through
`gate/land.sh`.

### 1. Invert the ledger: absence is open, unknown is FAIL, and the checker actually runs

**What it closes:** F3 (the trap), F2 (stateless HR files are inert), F7 (green checker
over 80 uncleared records), plus the unexecuted-checker gap found while writing this plan.

**Mechanism.**

- `state:` becomes **mandatory** on every `instance/decisions/HR-*.md`. Vocabulary
  (declared in `instruction-layers`, updated in the same commit):
  - `pending` — captured, not yet triaged/routed; interim-binding, delivered in full to
    packs (unchanged semantics).
  - `owed` — **new**: triaged, obligation identified, work not done. Must carry
    `tracked-by: <workboard-row-id>` that resolves (see item 2). This is the state
    HR-2171 needed and could not express — the current vocabulary conflates "ruling routed
    into a doc" with "work request discharged", and that conflation is why a perfect
    capture had nowhere honest to sit.
  - `routed` — binding force moved to a doc/param; `routes-to:` must resolve.
  - `parked` — with `review-by:` (existing rule).
  - `superseded` — must carry `superseded-by:` that resolves to an HR id or msg id.
  - **No `state:`, or a value outside this set → checker FAIL, and the file is treated as
    open** (delivered to the session load) until fixed. Fail-visible, never fail-hidden.
- `routedMsgIds()` (`ledger.ts:147`) and its inline twin (`session-load.ts:167–173`) stop
  inferring "handled" from the filename. An HR file marks a message **captured** (it no
  longer counts as untriaged); only a closed state (`routed`/`superseded`, resolving)
  marks it **discharged**. Captured-but-open goes onto the open list (item 3), not into
  the void.
- Delivery predicates flip from allowlist to blocklist:
  - `compose.ts:371` (`collectPendingDecisions`): still delivers `pending` in full;
    additionally the pack preamble states the count of open obligations and points at the
    generated list, so no lane can believe the backlog is empty.
  - `session-load.ts:155` (`collectPendingHr`): delivers everything **not provably
    closed** — `pending`, `owed`, and any invalid/stateless file.
  - `ledger.ts:308` (`checkHrAging`): `pending` keeps the 72h SLA; `owed` has **no
    invented threshold** — HR-2451 says the number is his to set — but every `owed` row
    appears in every session load and in the item-5 dispatch report until closed, so it
    cannot be quiet while it waits.
- **Execution wiring — the part with no current home.** Three sites, all widening things
  that already run:
  - `gate/lane-exit.sh` and `gate/land.sh` run `bun tools/instructions/check.ts --strict`
    against the real corpus (check.ts already imports the ledger and session-load
    checkers; today nothing calls it). A red ledger blocks landing, exactly like the
    README freshness check would.
  - the session-start hook (item 4) runs it at every orchestrator boot.
  - a rendered timer unit (same `instance/units/*.in` + `bootstrap/unit-render-lib.sh`
    machinery as the staleness timer) runs it on the host on a schedule and routes
    failures through the existing operator-alert path. Plan only — deployment of the unit
    follows the normal render/land flow, not a hand install.
- **Existing debt is exempted with expiry, not hidden and not blocking.** Landing this
  checker with 31 stateless files would turn every landing red instantly; relabeling it
  WARN would violate Hard Floor 7. Use the proven pattern from V3-2.16: an exemption
  ledger (`instance/hr-state-exemptions.tsv`) enumerating the exact known-legacy files,
  each with an expiry date; a new violation fails immediately; an expired exemption fails
  (V3-2.16's lesson: an exemption must not outlive its reason). The remediation lane
  (item 6) drains the ledger to empty.
- **The checker must be provably able to fail.** Fixture tests: a stateless HR file →
  FAIL; an out-of-vocabulary state → FAIL; an `owed` without `tracked-by` → FAIL. This is
  the direct counter to the "check that cannot fail" class (seven instances in two days of
  audits).

**Named failures it would have caught:** HR-2171 — a 13 272-byte capture with no state and
no row would have been FAIL-open since the day it was written, delivered into every session
load, instead of surfacing as *«Ааааа, та ти чого блять!»* on 08-05. The 31 fieldless
files, the `open`/`backlog`/`captured` strays, and the green `--strict` run over all of it
(F7) are all direct fixture cases.

**Size:** M — one coder lane (ledger.ts + session-load.ts + compose.ts + check.ts wiring +
gate lines + exemption ledger + tests), 1–2 review rounds, cross-vendor. The timer unit can
be a second small lane if review prefers the split.

**Leaves open:** adequacy — a resolving target can still be a bad target (see "not
addressed"); and the backlog itself, which item 6 drains.

### 2. A closure claim must name a target that exists — checked on every run, forever

**What it closes:** F1 (persona requirement closed against `NI-1/NI-2/NI-3`, rows that do
not exist; read as closed in git since 07-31 through four asks: msgs 146, 563, 1931, 2449).

**Mechanism.**

- `routes-to:` / `tracked-by:` / `superseded-by:` on HR files must resolve to: a workboard
  row id present in `instance/workboard.md`, an existing repo path, or a doc id in the
  generated instructions index. Unresolvable → FAIL. (`grep -rn "routes-to" tools/ gate/`
  returns nothing today — the field is pure decoration.)
- Triage rows gain a structured optional `closes:` field with the same resolution rule. A
  `verdict: directive` row must carry either `answer_status: owed` (open, listed) or a
  resolving `closes:`. Free-text `reason` stops being able to assert completion — 89 rows
  currently claim capture/routing/completion in prose and 3 are provably false; prose
  claims are exactly the "property defended by accident" shape.
- Resolution is re-verified on **every** checker run, not at write time. This is the part
  that makes renumbering safe: the NI→V3 board rebuild silently orphaned three closures;
  under this rule the renumbering commit itself would have gone red at the gate before
  landing. A rule checked once at write time would not have caught it.
- The three known-false closures (triage rows for msgs 563, 162, 564) are **reopened, not
  exempted** — they are the defect, not legacy noise.

**Named failure it would have caught:** F1 exactly, on 2026-07-31, at the commit that
rebuilt the board.

**Size:** S–M. Same files as item 1 — **fold into the same lane** (one coherent
"ledger fail-closed" change; two lanes editing `ledger.ts` in parallel would just queue at
the landing gate).

**Leaves open:** existence ≠ adequacy; a `tracked-by` pointing at a vacuous workboard row
passes. Review behavior covers adequacy; the checker cannot.

### 3. One generated open-obligations file, guarded by the freshness pattern that already works

**What it closes:** requirement 3 of the mission (open obligations visible without
archaeology), the F8 dangling pre-ask route through the never-existing
`instance/README.md`, and the operative demand of HR-2451 ("Open obligations must be
visible as one list, not scattered one-line rows in triage.jsonl").

**Mechanism.**

- `instance/open-requirements.md`, **generated** by the ledger tooling (widening item 1's
  code, not a second implementation), tracked in git, hand-edits impossible: a freshness
  check in `check.ts` regenerates and diffs, red on drift — the identical, proven pattern
  that guards `instructions/README.md`.
- Built **only from tracked inputs** (triage.jsonl, `HR-*.md`, workboard.md), so it is
  deterministic in a clean checkout and survives the meteorite. One row per undischarged
  obligation: msg id, date, age, the tracked quote, its state, and the target it waits on.
- The audit exposed a second polarity bug to avoid here: the inbox ledger once "passed in
  a checkout where its input file was absent." So the checkers split into two declared
  tiers, by construction rather than by `[[ -f ]]`:
  - **repo tier** — tracked inputs only; runs everywhere (gates, CI, containers);
    absence of a tracked input is FAIL.
  - **host tier** — requires the gitignored `inbox.jsonl`; runs only in host contexts
    (session hook, timer, dispatch gate), where absence of the inbox is FAIL, never SKIP.
    Container contexts never invoke the host tier, so nothing "passes by never running."
- Routing: `CLAUDE.md`'s HR-735 pre-ask check re-points from the absent
  `instance/README.md` to this file. This is his own proposal from msg 2444, made
  checkable.

**Named failures it would have caught:** the fifteen directives that sat `owed` overnight
while the orchestrator worked self-chosen rows (HR-2451's trigger) would have been fifteen
visible rows in every session load and every pack preamble; msg 1931 (personas MD, owed
since 08-03) would have aged in public instead of in a jsonl line.

**Size:** S–M, one lane, after item 1 lands (it consumes item 1's state semantics).

**Leaves open:** it guarantees the list exists and is honest; it does not make anyone read
it — items 4 and 5 are what force it into the read path.

### 4. The session load must run, from a tracked file, and refuse to be skipped

**What it closes:** F4 — the live orchestrator is `provider=claude`; the claude branch of
`build_command` (`launch.sh:252–295`, verified) wires **no** SessionStart hook at all; the
codex branch points at `.claude/hooks/session-load.sh`, which does not exist and is
untracked; the `[[ -x ]]` guard skips it silently while the adjacent comment claims "the
hook source is this repository." 28 inbox rows are reachable only through this path.

**Mechanism.**

- One provider-neutral hook script, **tracked**: `orchestrator/hooks/session-start.sh`.
  It runs `bun tools/instructions/session-load.ts` and `check.ts --strict` (host tier) and
  emits their output into the session's standing context; a non-zero load prints an
  unmissable NO-GO banner rather than degrading quietly (per `orchestrator-fallback`:
  skipping the load is a fail-closed NO-GO on the session).
- `launch.sh` claude branch: the settings JSON it already writes for the Stop relay gains
  a `SessionStart` hook entry pointing at the tracked script. Codex branch re-points to
  the same file.
- **Every `[[ -x ]]` fail-open guard in `build_command` becomes fail-closed**: hook or
  relay missing/not executable → launch refuses with an explicit error. (The Stop relay
  sits behind the same silent guard today — same defect class, fix it in the same pass.)
  Break-glass: a single explicit `ORCH_SKIP_SESSION_HOOK=1` for repairing the tooling
  itself, mirroring the existing `DISPATCH_OVERRIDE` convention, so the escape hatch is
  loud and greppable instead of implicit.
- Drift test that can fail: assert `git ls-files` contains the hook path, it is
  executable, and the rendered command line for **each** provider branch references it.
  Delete the file or unwire a branch → red. This also clears the Hard Floor 5 defect (a
  mechanism existing only as a path some host might satisfy).
- Adoption: proven by launching a scratch session and showing `SessionStart hook
  (completed)` plus the loaded content — **not** by restarting the live orchestrator. The
  live session picks it up at its next natural restart; until then the orchestrator runs
  `session-load.ts` by hand each session and says so in the rollup (visible degraded mode,
  per `orchestrator-fallback`).

**Named failure it would have caught:** F4 itself — every claude-provider boot since the
launcher existed has been blind, silently; under this design the very first blind boot
would have refused to start. Msgs 2405/2407 (his shared-drive answer) would have reached a
session instead of being re-asked seven hours after he had already answered.

**Size:** M, one lane, **independent of items 1–3** — dispatch in parallel on day 1.

**Leaves open:** the hook loads context at session start; a message arriving mid-session
still waits for the next turn (item 5 narrows this; the daemon mirror closes it fully,
which is out of scope until `capture.mode: daemon` is proven).

### 5. HR-2451 becomes a gate, not a habit: an unhandled message blocks the next dispatch

**What it closes:** the priority inversion he named — his messages first, then work in
flight, then the board. His chosen rule (Telegram 2461, binding from 08-05): an unhandled
message blocks the next dispatch. Today that rule lives in prose; every prose rule in this
repository has already failed at least once.

**Mechanism.**

- Widen `tools/instructions/dispatch-check.ts` (which already gates dispatch and already
  has the `DISPATCH_OVERRIDE` break-glass for tooling-repair lanes): before composing any
  lane pack, run the host-tier check — **any inbound message with no triage verdict and no
  HR file → dispatch refuses.** "Handled" = triaged (a verdict recorded, and if
  `directive`, the item-1 rules force it to an honest state at triage time). Triage is
  minutes of work, so the gate forces "read him first" rather than deadlocking the fleet.
- Deliberately narrow: it blocks on **unhandled** messages, not on open obligations —
  blocking dispatch on every open `owed` row would deadlock, since lanes are how
  obligations get discharged. `owed` rows exert pressure through items 3/4 visibility and
  through the dispatch report (the refusal output lists the open count alongside).
- `inbox.jsonl` absent on the host → FAIL, not skip (host tier, item 3's rule).

**Named failure it would have caught:** the night of 08-04→05 — 15 directives sat owed
while V3-2.14/15/16 were dispatched from review findings; under this gate the first
dispatch after his first unread message would have refused. Honest limit: msg 2449
(a detail arriving while a lane was already running) is only narrowed, not eliminated — a
systemd lane still takes no new instruction; the gate guarantees the *next* dispatch sees
it, and the daemon mirror is the real fix for mid-flight delivery.

**Size:** S, one lane, after item 1 (it consumes the "handled" definition).

### 6. Drain the backlog the audit found — one-time remediation lanes

**What it closes:** the existing debt that items 1–5 only fence off: 31 stateless HR
files, 4 out-of-vocabulary states, 28 untriaged inbox rows, 3 false closures, 172
flattened directives, and the two artifacts he is owed **right now**.

**Dispatch rows, in order:**

1. **Immediately, independent of everything** (these are owed, not infrastructure):
   - file the backup workboard row from HR-2171 + the audit's by-product consolidation
     (cadence 5 min, last-10 rotation, the shared drive he created, the two standing
     constraints — it is all ruled and unambiguous; the audit did the reading);
   - deliver the personas/roles MD (msgs 146/1931/2449): reconcile `instance/cast.md`
     against HR-146's full requirement, close the gap, link it to HR-146 and the triage
     rows, and **send it** — with the send recorded in the rollup, since F5 means delivery
     is otherwise unprovable.
2. After item 1 lands: a lane sweeps all 80+ HR files, assigns honest states, drains
   `instance/hr-state-exemptions.tsv` to empty, reopens the three false closures as real
   workboard rows.
3. Triage the 28 untriaged rows (host-side, quotes secret-scanned before anything is
   promoted into tracked files).
4. The 172 flattened directives: batched re-read of the host inbox oldest→newest,
   promoting each to a full-text HR file or a resolving `closes:`. This is the largest
   item and is honest re-reading work; batch it (~30–40 msgs/lane) so each batch lands
   and shows progress rather than one lane holding 172 messages in the air.

**Size:** L in total — rows 1–3 are a day at the current cap; row 4 is roughly 4–6 lane
batches. With landing serialized, estimate ~2–3 wall-clock days for rows 1–3 plus the
structural items, and up to a week including the full 172-row sweep, **at the HR-2456 cap
of five with one slot held by review** (concurrency stated per HR-1494).

### 7. Forward guard against flattening: a fragment can no longer impersonate a capture

**What it closes:** F6's *next* instance (msg 563: 3 237 chars → 47-char quote, 1.5%).

**Mechanism:** host-tier rule — for every new `directive` triage row, quote length is
compared to the original message length in the inbox; a truncated quote with no
accompanying full-text HR file → FAIL. Full text lands in the HR file verbatim,
secret-scanned first; any redaction is explicit (`[redacted: <reason>]`) so absence of
content is visible rather than silent. Nothing can distinguish "was one line" from
"was flattened to one line" today because only the quote survives; this makes the
distinction mechanical.

**Size:** S, folds into the host-tier checker once item 3's tier split exists.

---

## Decision request for him (not a lane): outbound retention — F5

Whether `instance/cast.md` was ever sent to him is unanswerable: `history-logger.ts`
stores only length + sha256, retention 30 days, host-only, oldest-trimmed. "Did I already
tell him?" is structurally unanswerable for our side of the conversation, and HR-735's
check needs it. Retaining outbound **content** is a privacy/secret-handling decision that
is his to make (the audit says the same). Recommendation to put to him: retain full
outbound text, host-only, inside the state folder his backup design already covers, with
the existing landing-gate secret pattern applied at write time; sha256 already in the log
makes any later tracked excerpt verifiable against the retained text. Until he rules,
every "sent to him" claim in a rollup must cite a message id from the history log —
provable delivery of *something*, even while content is unproven.

## What this plan does NOT address, explicitly

- **F5 itself** — stated above as his decision; no lane is dispatched for it.
- **The never-captured class.** Ground truth is `inbox.jsonl`; a message that never
  reached it is invisible to every mechanism here. That is the capture transport
  (`capture.mode: manual` → `daemon`), a separate proven-liveness project.
- **Mid-flight delivery.** A running systemd lane still takes no new instruction (msg
  2449's case). Item 5 guarantees the next dispatch sees the message; only the daemon
  mirror closes the gap fully.
- **Adequacy of closure targets.** Item 2 proves a target exists, not that it satisfies
  him. That stays with review and with him.
- **Recovering flattened nuance for outbound-dependent context** — inbound is fully
  re-readable from the host inbox (item 6.4); outbound before 2026-08-01 is gone.
- **Reading, finally, is behavior.** The plan makes the open list impossible to not
  generate, impossible to falsify, loaded at every session start, and blocking at every
  dispatch. The residual "orchestrator reads it and acts well" is judgment, and the
  honest claim is that every mechanical predecessor of that judgment now fails loudly.

## What stops this recurring in another two months?

The polarity inversion, plus wiring, plus tested checkers — specifically:

1. **Forgetting now has a failure mode.** Today, forgetting renders as silence: no state
   → no pack, no session, no aging, and a green checker. After item 1, the same omission
   is a red suite at the landing gate, a NO-GO banner at session start, and a refused
   dispatch. The system stops depending on anyone remembering, which is the mission's
   requirement 5 — the operator of this system is unreliable and the design now assumes
   it.
2. **Closure proofs are live, not archival.** Item 2 re-checks every `routes-to`,
   `tracked-by` and `closes:` on every run, so the *next* board renumbering goes red in
   the commit that breaks it — the F1 mechanism cannot re-arise quietly, even though
   boards will certainly be renumbered again.
3. **The checks are proven able to fail, and proven to run.** Fixture tests that must go
   red (closing the "check that cannot fail" class), and three invocation sites (gate,
   session hook, timer) replacing today's zero. The audit's own smallest-mechanism
   proposal would have joined R4 as a predicate nobody runs; this plan makes "it runs" an
   acceptance row.
4. **The audit becomes a standing measurement.** State distribution, closure resolution,
   untriaged count, quote coverage — the one-time queries in the audit become permanent
   checker output, so drift is measured continuously instead of excavated after two
   months of suffering.

What can still recur, said plainly: a message that never reaches the inbox; work closed
against an existing-but-hollow target; and an orchestrator that reads a red board and
proceeds anyway — but the timer routes red through the operator-alert path, so even that
last failure becomes visible to *him* instead of silent, which is the difference between
a defect and a betrayal.

## Report contract

```text
commit: d3fdb6d [ORCH] give HR-2456 the lane_cap field the checker reads (plan written at this SHA; no commits made — plan-only constraint)
verify: cat /root/.cache/infra-lanes/v3-fable-reading-plan.report.md
result: clean — deliverable is this plan; no code, decision file, or workboard row changed
secret-scan: clean (report scanned with the pattern extracted from gate/land-lib.sh land_secret_scan(); no key material, no tokens, no drive URLs; service-account key path referenced but never read)
remaining: dispatch per §Ranked plan — day 1: lane A (items 1+2), lane C (item 4), lanes E1/E2 (item 6.1, the two owed artifacts), one review slot; then items 3, 5, 7, backlog batches
```

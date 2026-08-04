# Consilium — cutover sprint programme, 2026-08-04 evening (Sonnet, throughput seat)

Independent answer. I have not seen and did not guess at the other four members'
reports. Budget: read `CLAUDE.md`, `instance/workboard.md` (full, 253 lines),
`instance/in-flight-2026-08-04-evening.md`, the previous consilium synthesis,
the launcher incident report, `instance/params.yaml`, `instructions/reproducible-from-git.md`,
and `gate/land.sh` (the actual lock/freshness/review-round code, not just its
description). All claims below are marked **verified** (I read the file/ran the
command), **inferred** (derived from verified facts), or **guessed**.

## Executive answer

The binding constraint is not lane-hours, it is **one non-blocking lock**
(`gate/land.sh:122`, `flock -n 9`, repo-wide, one landing at a time) combined
with a git-native property nothing here works around: every successful landing
moves `main`, and every review artifact is pinned to an exact SHA (by design —
report-pinning-convention), so a moved `main` invalidates every other
in-flight ACCEPT and forces a rebase-plus-re-attestation cycle that itself
consumes the same one lock. Today that composition, not coding, produced
5.8 lane-hours per landed row against ~1.7 the day before. **The correct
first move is not "advance the chain" or "fix the launcher" as separate
races — it is to shrink the number of times the lock must be acquired and
make the acquisitions that do happen collision-proof**, because every later
landing this sprint — including the Hard-Floor-5 launcher fix, which is a
real and separate cutover blocker — pays the same tax if this is not done
first. The previous consilium's "fix the landing machinery" is still right;
the new incident does not replace it, it adds one more parallel-track item
that must also clear the same lock, and the programme below is built so that
item does not have to wait behind the fix — it is dispatched immediately, in
parallel, and lands right after the lock is hardened.

## 1. State of affairs — verified, with one stale-record finding

**Verified**: `gate/land.sh` takes a single `bpa-land.lock` file per repository
with `flock -n` (non-blocking — a contested landing fails immediately with
`land_fail lock 2`, it does not queue; the handoff's "wait on the lock, do not
test it" operating rule exists because of exactly this). Verified in the same
file: the freshness/review-rounds/attempt-ref machinery reads and writes
`origin` directly inside the locked section (ls-remote, atomic push of attempt
refs, a second operator-authority read from a decision file on the target
branch) — so the lock protects the *sequence*, not the *content* staying
still; a landing still aborts if `origin/main` moves underneath it for any
reason, including the orchestrator's own bookkeeping pushes (V3-0.47, open,
measured 3 collisions today, one costing a full ~10-minute chain re-run).

**Verified**: the launcher incident
(`instance/incidents/2026-08-04-orchestrator-launcher-unstartable-from-git.md`)
is real and independently re-verified twice: `mission_cli reap`/`lease` are
called by `orchestrator/launch.sh` and implemented nowhere in
`core/mission-cli.ts`; `orchestrator/preflight-cli-auth.sh` is required by the
launcher and absent from `HEAD` (last alive `75411d9`, 2026-08-02). The
orchestrator runs today only via two lines in gitignored
`orchestrator/runtime.env` pointing at `/root/oldorch-breakglass/`. Both left
untouched, per instruction. This is a Hard Floor 5 breach with a currently
live blast radius: a meteorite-clean host would not currently start.

**Stale-record finding**: `instance/params.yaml:16` (`active_scope:
instruction-mechanics-only`, citing HR-11570, dated 2026-07-29) still reads as
binding — "active work is ONLY the L1 instruction tooling... VM migration and
stack Phase 0 are parked awaiting his go." Every row on `instance/workboard.md`
and every decision from HR-1718 onward is stack/VM work under a *different*
numbering series (HR-2xxx/HR-17xx/HR-19xx), all clearly superseding HR-11570
in practice, but nothing in `params.yaml` marks it superseded — the file the
mission itself calls "installation facts" disagrees with the installation.
This is a live instance of exactly the defect class `reproducible-from-git.md`
names ("when reality and the record disagree, the record is the defect"). Low
cost, low urgency (nobody is currently confused by it), but it should be
swept — see Batch F below.

**Inferred, not independently re-run**: the previous consilium's ~5.8
lane-hours/row figure and the 12-landings-in-11.75-hours measurement, because
its synthesis document shows its own correction of the prior day's wrong
4-row denominator and cites a reproducible `git log` command; I did not re-run
it, but the correction methodology is sound and I have no reason to distrust
the corrected number.

## 2. Path travelled

**Verified from the handoff and workboard**: 15 rows landed 2026-08-04
proper, 5 more finished/ACCEPTed and stuck on bookkeeping (not quality), and
32 rows were filed the same day. That is diverging on paper and converging on
substance: the backlog of *open, undiagnosed* problems is not growing — nearly
every new row filed today is a **named, executed, evidence-backed** defect in
the landing/evidence machinery itself (the V3-0.3x/0.4x/0.5x band), not a
fresh unknown. The synthesis document's own three-way split (operator asks:
non-decaying; one external audit: one-time; defects-found-by-working: decays
with engineering) is the right frame and I adopt it unchanged. What is new
since that synthesis is that **defects-found-by-working** now includes one
that is not a landing-machinery defect at all — the launcher/Hard-Floor-5
incident — found by a crash, not by a lane. That is a second source that does
not decay with more landing-machinery engineering, and the programme below
treats it as its own track for exactly that reason.

## 3. Definition of cutover-ready (decidable)

The operator's own words: move everything to a new server, bring it up there,
run V3 with all features. I read that as five conditions, each a command a
lane or the orchestrator can execute and report a verdict for, not a judgement
call:

1. **The repository alone starts the orchestrator on a clean host.**
   `meteorite/run.sh`, extended, does not stop at file/clone verification — it
   installs the rendered units, starts `bpa-orchestrator.service` (or the
   equivalent target), and asserts a live, responsive state (a real Telegram
   round trip, or a systemd `is-active` on the actual unit graph) inside the
   container, with `orchestrator/runtime.env` and
   `/root/oldorch-breakglass/` **absent** from the container's filesystem
   entirely. `result: clean` under that condition is the acceptance test for
   Hard Floor 5 as applied to the launcher, closing the incident by
   construction rather than by inspection.
2. **Every host-only mechanism is enumerated, not just the ones already
   found.** The four untracked scripts and the secret-bearing
   `.env.bak` named in the evening handoff (`orch-fleet-nudge.timer`'s
   script, three more, `orchestrator.env.bak-20260730`) are each either
   committed or explicitly written down per `reproducible-from-git.md`'s
   "not in git is never allowed to mean not written down" — zero silent
   absences.
3. **Host state that is not code has an enumerated, proven restore path.**
   V3-2.9 (already deep in flight, see Batch B) landed with its restore
   proven into the meteorite container; V3-2.10's credential runbook exists
   and each credential's verification command runs and correctly refuses
   when the credential is absent.
4. **Supervision does not depend on the operator noticing.** V3-2.1
   (unattended restart armed by bootstrap, not by hand) and V3-4.1 (Telegram
   channel survives a restart of the *real* daemon, not the round-1 fixture)
   both hold, proven by killing the process and observing recovery inside
   the container — this is Phase 2's own stated purpose and the workboard
   confirms none of these units are even running on this host today.
5. **The evidence gate itself is trustworthy at the moment of the go.** No
   known false-green in the classes discovered today: the pipe/exit-code hole
   (V3-0.40/38), the reviewer-lane-always-`failed` signal (V3-0.44), and the
   `result: NO-GO`-vs-pending-review ambiguity that strands ACCEPTed work
   (V3-0.52) are closed. Hard Floor 7 ("green is fail-closed") is the
   precondition for trusting conditions 1-4's own green results, so this is
   listed last but gates the *credibility* of everything above it, not its
   own separate slot in time.

Only after 1-5 does the operator's explicit go (V3-4.3) become a real
question rather than a formality he would be asked to rubber-stamp.

## 4. The programme

Ordering rule used throughout: **the lock is the scarce resource, not lane
count.** Landing is strictly one-at-a-time and fail-fast, not queued, so the
programme minimizes (a) how many times it must be acquired and (b) the odds
each acquisition collides with something else moving `main`. Coding and
review scale with lane count and run in parallel; only the actual `gate/land.sh`
invocation is serial. Batches are grouped so that related small fixes share
one landing event instead of several — the same diagnosis V3-0.50 makes about
one-row-per-defect-instance, applied here to landing-lock economy specifically.

### Batch B — land the free backlog first (dispatch: immediate, ~0 new coding)

Already-ACCEPTed rows where cost is gate-only: **V3-0.55** (re-attested ACCEPT
exists), **V3-2.9** (re-attestation running now on `ag-s11-4-r6`, collect its
report first), **V3-0.43** (re-attestation exists), **V3-0.28** (small recut —
its test hardcodes a line number that moved, fix and land). Land these
back-to-back, as fast as the lock allows, before anything else queues behind
them. **Why first**: zero discovery risk, and clearing them off the board
early reduces the population of stale-ACCEPT collisions everything after has
to dodge. **Lane-hours**: ~3 (mostly gate-invocation and rebase time, one
small recut). **Parallel**: no — these compete for the same lock by
definition, but nothing else needs to wait on them; other lanes below start
coding immediately. **Evidence**: each lands with `verdict=landed`, SHA
recorded, and `origin/main` unchanged by anyone else in the interim (checked
by rerunning `git ls-remote` before/after each).

### Batch A — harden the lock itself (dispatch: immediate, parallel with B and C)

Bundle three related "two-sided contract" defects into **one** reviewed
change instead of three, because they touch overlapping files
(`gate/completion-guard.ts`, `gate/lane-exit.sh`, `gate/land-lib.sh`) and are
diagnosed by the board itself as the same class:
- **V3-0.47**: the orchestrator's own bookkeeping pushes collide with a
  landing's freshness check. Fix per the row's own stated option: a rebase
  that is content-neutral for gate-guarded paths
  (`git diff --stat <base>..origin/main -- gate/ instructions/review-policy.md`
  empty) re-validates without a new review round; a rebase that touches those
  paths still requires one. This is the fix that also answers "re-attestation
  after rebase" from the brief directly — it is the mechanism that decides
  when a rebase is cheap and when it is not.
- **V3-0.52**: `result: NO-GO` cannot currently mean "work is done, landing
  is blocked on an artifact only the orchestrator can supply" — costing a
  full re-issue round on finished work twice already today.
- **V3-0.44** + **V3-0.39**: reviewer lanes report `failed` unconditionally
  (false status for half the fleet) and the review artifact's required field
  names have no single tracked home (`identity:` vs `reviewer:` cost a
  481-line ACCEPT once already).

**Why this earns the first landing slot after Batch B, ahead of everything
else with new coding**: every subsequent landing this sprint — Batch C's
Hard-Floor-5 fix included — pays the freshness-collision and stale-ACCEPT tax
until this lands. Not landing it first is how today became 4.5-6 working
days on zero new discovery. **Lane-hours**: ~14-17 combined (this is judgement
work, escalate under HR-2166 if round 3 does not clear it — these are
evidence-gate paths, Hard Rule 9 review applies). **Parallel**: the coding and
review run in a dedicated lane pool (2-3 lanes) while Batch B is landing and
Batch C is being coded; only its own landing is serial. **Evidence**: a
fixture proves a bookkeeping push mid-landing no longer aborts when the push
is gate-path-neutral; `result: NO-GO` with a stated orchestrator-only blocker
lands without a re-issue round; a real reviewer-lane run against a valid
ACCEPT and a truncated one both terminate correctly.

### Batch C — the Hard-Floor-5 launcher fix (dispatch: immediate, parallel with A/B)

Three fixes named explicitly in the incident report, none of them requiring
new discovery — the incident already states the exact defect:
1. Implement `reap` and `lease acquire/renew/release` in `core/mission-cli.ts`
   against `DurableStore`, with a test that locks caller (`launch.sh`) and
   callee (`mission-cli.ts`) vocabulary against each other so this class
   cannot recur silently. ~4-5 lane-hours.
2. Restore `orchestrator/preflight-cli-auth.sh` as a tracked file (diff it
   against the copy already serving as the live break-glass at
   `/root/oldorch-breakglass/` for content parity — read-only comparison,
   the break-glass itself stays untouched) plus a test asserting every path
   the launcher requires exists in the tree. ~2-3 lane-hours.
3. Extend the meteorite proof to install and start the orchestrator inside
   the container and assert a live state, per cutover condition 1 above —
   this folds **V3-4.2** (clean-machine rehearsal) into the same work rather
   than treating it as a separate row, since they are the same proof at
   different depths. ~5-6 lane-hours.

**Why parallel-dispatch now, not after Batch A lands**: this track does not
touch the same files as Batch A, so coding and review proceed independently;
it only has to wait its turn *at the lock*, and by dispatching it immediately
its review finishes at roughly the same time Batch A clears the lock, instead
of starting review only after Batch A lands. **Lane-hours**: ~12-14.
**Parallel**: yes, 2-3 lanes, fully independent of A/B during coding/review.
**Evidence**: the acceptance test in cutover condition 1 — meteorite green
from a fresh `ubuntu:24.04` container with no break-glass files present, with
the orchestrator reaching a checkable live state.

### Batch D — credential and state runbook (dispatch: immediate, parallel)

**V3-2.10**: tracked runbook naming every credential, destination, scope, and
a verification command that fails closed when the credential is absent or
wrong; proven once against a fixture identity. Mostly documentation plus
executable checks, low coding risk, no dependency on A/B/C.
**Lane-hours**: ~4-5. **Parallel**: yes, 1 lane. **Evidence**: the runbook
executed end to end against a fixture identity, no secret entering git.

### Batch E — supervision (dispatch: after Batch A lands, so its own landing
does not compete with the collision-fix for the lock)

**V3-2.1** (unattended restart, armed by bootstrap) bundled with **V3-2.3**
(deployment-drift detector — small, same review pass) since neither is
currently running on this host at all (verified: `bpa-orchestrator.service`
loaded-inactive, watchdog/meteorite/deploy-drift timers not-found). **V3-4.1**
round 2 — the real production daemon, not the 30-line fixture the round-1
reviewer correctly rejected — runs in its own lane. **Lane-hours**: ~11-15
combined. **Parallel**: yes, 2 lanes; land after Batch A to avoid a second
collision-fix-adjacent race. **Evidence**: kill the orchestrator and the
daemon independently inside a container; both recover within the configured
interval; a real Telegram round trip survives a daemon restart.

### Batch F — board integrity sweep (dispatch: whenever a lane is free, land
opportunistically)

**V3-0.43**'s workboard-corruption checker: 25 of 80+ rows already carry no
state column and 6 more mis-render on an unescaped pipe — this is the
document every dispatch decision in this sprint is made from, and it has
already silently corrupted itself once (`e0cd52b`) with no gate catching it.
Cheap, and it protects every batch above from a repeat of V3-0.30's
"dispatched onto an already-landed row." Fold in a one-line fix to the
`params.yaml` HR-11570 staleness noted in §1. **Lane-hours**: ~3.
**Parallel**: yes, 1 lane, any time. **Evidence**: a fixture with a
duplicated section or a malformed row count is rejected by the checker in the
landing tier; `params.yaml` correctly marks HR-11570 superseded.

### Rough shape of the 10-12 hours

Landing events needed: Batch B (4 landings) + Batch A (1 bundled landing) +
Batch C (2 landings) + Batch D (1) + Batch E (2) + Batch F (1) ≈ 11 landing
events. At a hardened lock with collisions largely eliminated by Batch A, a
chain averaging 10-20 minutes (most of these do not touch
bootstrap/meteorite/unit paths and so skip the ~3-4 minute meteorite proof;
Batch C's meteorite-extension change is the one row that must pay full
end-to-end cost, once) puts total serialized lock-time at roughly 2.5-4
hours — comfortably inside the window. Total lane-hours across all batches:
roughly **50-60**, plus a 20-25% buffer for HR-2166 escalation rounds and
rebase churn ≈ **62-72 lane-hours**. At 5-8 concurrent lanes (the measured
sustainable width, not the theoretical ceiling of 10) that is **~9-12 hours
wall clock** — this programme fits the window if, and only if, Batch A lands
before Batches C/D/E queue behind it. If Batch A slips past round 3 of
HR-2166 (real risk — it touches evidence-gate logic directly, Tier-A/escalated
review applies), the whole programme's wall-clock estimate inflates by
whatever multiple today's uncollision-fixed landings cost, which is the
scenario this ordering exists to avoid.

## 5. What I deliberately cut

- **V3-1.9/1.9b/1.9c/1.10** (non-root lanes, the privilege-boundary operator
  door). Explicitly out of scope by the operator's ruling today. Risk
  accepted: the fleet keeps running as root through cutover, and the
  self-authorization findings V3-0.29 already surfaced remain theoretically
  exploitable by any lane — mitigated only by the existing tamper-*detecting*
  (not -proof) mirror-ref design, unchanged this sprint.
- **V3-1.7** (third-level junior-agent hierarchy). Blocked on the operator's
  own restatement; there is nothing to dispatch. No risk from cutting it —
  it was never going to be sprint work.
- **V3-1.11** (hardware self-tuning) and **V3-1.12** (bounded operator-absence
  handling). Real but not cutover-blocking for one guided move to one named
  new server. Risk accepted: if the new server's core/RAM profile differs
  meaningfully from this host, fleet-floor and deadline constants may be
  wrong on day one — mitigate by having the operator sanity-check
  `params.yaml`'s `vm:`/`fleet:` block by hand once the new host is up,
  rather than building an automatic negotiator now.
- **V3-3.2/3.3/3.5/3.7/3.9/3.10** (Spark routing, model-discovery catalog,
  decision-button wording, OCR, quota-exhaustion handling, persisted
  consumption graph). None gate a single cutover event. Risk accepted:
  development stays on the current provider mix and quota visibility stays
  point-in-time (already shipped, V3-3.6) rather than historical, post-cutover.
- **V3-0.50's generalized round-trip-schema tooling.** Its diagnosis is
  correct and I use it directly (Batch A bundles exactly the instances it
  names), but building the generator itself is design work, not sprint work.
  Risk accepted: a seventh instance of the same contract-mismatch class can
  still appear and cost one more one-off row — cheaper than a mid-sprint
  design detour, per the row's own stated scoping risk.
- **V3-0.46/0.49(b)/(c)** (reaper-worktree wiring, completion-guard timeout
  and worktree-leak on a hanging `verify:`). Real — 18 stale
  `completion-verify-*` worktrees measured — but not cutover-blocking within
  one sprint. Risk accepted, and named explicitly since it is the item
  closest to violating a Hard Floor: branch/worktree count keeps growing
  (108 branches, 120 worktrees measured today) and Hard Floor 12 forbids
  letting refs breed. Mitigate with a manual `hygiene/reap.sh` sweep near the
  end of the window if lane time remains, rather than a dedicated batch.
- **V3-0.34** (fleet floor as a derived resource budget) and **V3-0.41/0.42**
  (round-counter `check` truthfulness, mechanism-inventory drift checker
  against `v2-deprecated`). Tuning and hygiene value, not cutover-blocking.
  Risk accepted: `check` stays misleading for parked items when queried
  directly (the durable attempt refs remain authoritative, so no incorrect
  landing results from this, only a confusing manual read).

## 6. The measurement at hour 12 (falsifiable)

- **Collision rate**: of all landing attempts in the sprint window, the
  fraction that aborted on `freshness`/`push`/stale-review rather than
  reaching `verdict=landed`. Today's known floor is at least 3 of a handful
  observed. Target: near zero once Batch A is landed; report the actual
  before/after split, not an assertion.
- **Hard Floor 5, binary**: `meteorite/run.sh` (extended) exits 0 from a
  fresh `ubuntu:24.04` container containing only this repository's tracked
  content, with `orchestrator/runtime.env` and `/root/oldorch-breakglass/`
  **not present** in the container, and the orchestrator reaches a checkable
  live state. Pass or fail, no partial credit — this is the one condition
  the previous meteorite proof could pass while this exact incident was live.
- **Board integrity, binary**: `instance/workboard.md` parses with zero rows
  missing a state column and zero duplicated sections, checked by the landed
  checker rather than by eye.
- **Rows-filed-by-working vs rows-closed**, continuing the prior sprint's own
  named measurement: did the ratio invert this window? If defects found by
  working (not operator asks, not the one-time Fable audit) close faster
  than new ones of the same class appear, the landing-machinery fix is
  actually paying for itself and a real cutover date becomes an honest
  thing to state next session. If not, say so plainly rather than re-issuing
  the same hope with a later timestamp.
- **Untracked host mechanisms**: the count of scripts/files named in the
  2026-08-04 evening handoff as untracked-and-live drops to zero, each
  either committed or written down with an explicit, reasoned exemption —
  not silently still absent.

# In flight, 2026-08-04 ~15:40 — handoff for a restarted session

Written because the operator asked when a restart would be cheapest (Telegram 2289).
The honest answer was "once this is current", so here it is. The earlier
`instance/in-flight-2026-08-04.md` describes the morning and is now five hours stale;
**read this file instead**, and that one only for background.

## Read this first — the state in one paragraph

Fifteen rows landed today. Five more are finished and independently ACCEPTed but are
stuck in bookkeeping, not in quality. The blocker is a compound of three defects the
orchestrator measured today: its own bookkeeping pushes move `main`, lanes' bases go
stale by 12–15 commits, and a review artifact pinned to a SHA dies on the rebase that
fixes the staleness. The operator has ruled on the round-counting half (HR-2285).

## Landed today (15), the ones that matter

| row | commit | what it closed |
|---|---|---|
| V3-0.51 | `4b578c7` | the lane harness killed any foreground command at **exactly 2m00s**, exit 143, truncated output — while the suite takes 98–155s. Composed with V3-0.40 that produced "exit 0, no trailing triple", which is verbatim V3-0.23's symptom. Four rounds had chased the wrong cause. |
| V3-0.29 | `158c312` | the operator door. Five rounds. The escalated tier found two ways a lane could authorise itself — a NUL byte that bash strips from `$(…)` so guard and reader see different bytes, and `remote.origin.url` being writable from any of ~123 worktrees — and landed a park release through both before round 5 closed them. |
| V3-0.44 | `6714091` | `gate/lane-exit.sh` never learned a lane's role, so **all 14 reviewer lanes** reported `failed`, including ones whose ACCEPTs landed. |
| V3-0.15, V3-0.20, V3-1.9a | `c8e52f6`, `cd0b1c3`, `48a59b3` | earlier in the day |

## Finished, ACCEPTed, and blocked on paperwork

| row | SHA | what it needs |
|---|---|---|
| V3-0.55 | `7c9c85f` | **parked at `no-progress`** — three landing attempts, none of them a reviewer's judgement. HR-2285 says it should never have been charged. Re-attested ACCEPT exists at `ag-s11-9-r2.review.md`. |
| V3-2.9 | rebased to `0fe08f0` | re-attestation after rebase; a lane is finishing this now on `ag-s11-4-r5` |
| V3-0.43 | `33c11a0` | re-attestation exists (`ag-s11-3-r3.review.md`); needs a landing attempt |
| V3-0.28 | `bdc96a6` | **recut, not landing** — its test hard-codes `gate/land.sh:416` while main moved that invocation to 609 |
| V3-0.47 | `fc148e5` | report re-issue (the lane ended mid-measurement), then review |

## Decisions recorded today — read these before planning anything

- **HR-2166** — the 3+2+2 ladder. Three standard review rounds, then two with the model
  raised on **both** coder and a new reviewer, then two final rounds requiring a running
  system and real logs. It paid for itself on first use: the escalated tier found what
  three standard rounds missed on V3-0.29. A one-day trial runs to **2026-08-05 09:12 UTC**;
  the measurement is defined in the decision file, and the three rows past the cap when it
  started do not count as evidence.
- **HR-2285** — a round is charged **only** when a reviewer examined the change and
  rejected it. Paperwork refusals do not count. **This does not relax the gate** — the
  operator's explicit qualification, and the part most likely to be lost in retelling.
- **HR-2171** (as simplified) — archive the state directory, upload the archive, unpack to
  restore. The orchestrator over-built it around WAL consistency for 110 KB of state.
- **HR-2224** — time budgets are per-subject with **named, tracked** exceptions; the
  meteorite first. A run exceeding its own budget is still killed and still reported killed.
- **HR-2149** — the operator's one-time unpark go-ahead. **Still unapplied**, deliberately:
  the mechanism it flows through only landed today, and HR-2285 may remove the need.

## The consilium, and the plan

Three members on three models, none seeing another's answer, all independently named the
same sprint 05: **fix the landing machinery before advancing the chain**. Tracked in
`instance/consilium-sprints-2026-08-04-synthesis.md` with the three verbatim reports.

Totals: 170–230 lane-hours ≈ 4.5–6 working days to cutover with zero new discovery. No
member would give a date and neither should you: **32 rows were filed today against 10–12
closed**. The synthesis names the measurement that would make a date honest.

## Operating rules learned today — do not rediscover these

- **Wait on the landing lock, do not test it.** `flock -n … -c true` reports free and the
  lock is taken before you act; that cost one landing. Use `until flock -n …; do sleep; done`.
- **Never push to `origin/main` while a landing is in flight.** It aborted four landings
  today, one after ten minutes of successful work.
- **Never re-point a stale ACCEPT at a new SHA.** Refused four times today; once vindicated
  — a re-attestation came back REJECT because the suite had gone red between the two SHAs.
- **Write review briefs from scratch, do not `sed`-patch old ones.** Two rounds were lost
  today to a patched brief naming a superseded commit and a wrong artifact path.
- **Lanes must run long measurements in the background.** Briefs saying "measure in the
  foreground under `timeout`" were the orchestrator's own error, propagated widely before
  V3-0.51 explained it.
- **Do not clean Docker or `/root/.cache`** (operator ruling, Telegram 2132, 2134).

## Four asks outstanding with the operator

1. Share a My Drive folder with `bpa-dev-orch@bpapro-agents.iam.gserviceaccount.com`.
2. Which credentials besides Drive and GitHub must the machine hold (V3-2.10)?
3. Should an unpark authorisation that meets no park expire, and after how long
   (V3-0.29 F7)?
4. V3-1.7 awaits his restatement.

## Live Hard Floor 5 exposure, unresolved

`orch-fleet-nudge.timer` is **armed, root, firing every ten minutes**, and its script
`/root/.local/bin/orch-fleet-nudge.sh` is **not in git**. It is what drives the fleet nudges
the orchestrator acts on. Three more untracked fleet-operating scripts and a secret-bearing
`orchestrator.env.bak-20260730` are on the host. Nothing was touched — the decision is the
operator's, and V3-2.9 exists so the enumeration names them rather than leaving them absent.

## The orchestrator's own failure mode, recorded honestly

Three times today it announced a conclusion ahead of its measurement: blaming V3-0.29 for a
meteorite failure without reading the log, declaring those failures transient without
reproducing, and reporting the fleet broken on a `usage:` line without establishing who
called the script. Each time the announcement was wrong and each time it did **not** act on
it — no rollback, no landing past a red gate. The pattern to watch: a plausible explanation
gets stated as established rather than marked as a hypothesis.

## Running at the moment of restart

**`ag-s11-4-r6`**, lane `v3-2.9-rebase-only` — a deliberately narrow round: rebase V3-2.9's
ACCEPTed work onto current `origin/main`, audit it for position-coupling, run the full
suite, and stop. It runs as its own systemd unit and is unaffected by the session restart.

**It was told not to run the meteorite and not to land** — both are the orchestrator's, this
round. Two earlier attempts at the same work died mid-turn because the brief bundled a
rebase, a ten-minute meteorite and a full suite into one lane. That was the orchestrator's
error and this round is the correction.

When it finishes: collect `$LANE_REPORT_PATH`
(`/root/.cache/infra-lanes/v3-2.9-rebase-only.report.md`), then **you** run
`meteorite/prove-candidate.sh --ref <its SHA>`, then dispatch a re-attestation (its standing
ACCEPT names `71d1105` and will be stale), then land. If it died mid-turn again, its commits
are still on the branch — check before re-dispatching.

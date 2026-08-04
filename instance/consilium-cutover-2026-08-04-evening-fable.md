# Consilium — the 10–12 hour cutover sprint, 2026-08-04 evening (Fable)

Member: Fable (claude-fable-5), the model that authored `instance/fable-global-review-2026-08-04.md`.
Everything below marked **verified** was established by opening the file or running the
read-only command named. Inference and guesses are labelled. No code was changed, nothing
was committed, landed, pushed, or dispatched; the break-glass was not touched.

## Executive answer

**Cutover is, by the operator's own definition, "bring the system up on a new server from
the repository" — and that is the single capability measured broken today.** I re-verified
both launcher blockers myself: `orchestrator/launch.sh` calls `mission_cli reap`/`lease`
verbs that `core/mission-cli.ts:111` does not implement, and it requires
`orchestrator/preflight-cli-auth.sh`, which `git cat-file -e HEAD:…` confirms is absent
from the tree (recoverable from `75411d9`). The system runs only through two lines in a
gitignored file pointing at an untracked directory. This displaces the previous
consilium's sprint 05 to **second** place — but does not invalidate it, because the fix
itself is three small lanes that must pass through the same landing machinery, and five
finished, independently ACCEPTed rows are already stuck in that machinery's bookkeeping.
The sprint is therefore: make HEAD startable and prove it by a meteorite that *starts the
orchestrator*, while in parallel draining the finished-work queue and landing the two
cheapest machinery fixes. One more thing the operator should know before anything else:
the incident record itself (`2c0499c`) exists **only on this host** — local `main` is one
commit ahead of `origin/main` (verified) — so the written record of the Hard Floor 5
breach would die with the machine. The cheapest fix on the whole board is one `git push`.

---

## 1. State of affairs — what is actually true right now

### 1.1 The launcher, re-verified rather than trusted

- **Verified**: `orchestrator/launch.sh` lines 145/173/466/602/630/664 call
  `mission_cli lease release|acquire|renew` and `mission_cli reap`. The usage string at
  `core/mission-cli.ts:111` — the whole dispatch contract — has no `reap` and no `lease`
  verb (the nearest thing is `lane claim`, a different primitive). The block is guarded by
  `state_available()`, so the regression armed itself when lane activity created
  `runtime/state.db`, exactly as the incident record says.
- **Verified**: `orchestrator/preflight-cli-auth.sh` does not exist in `HEAD`
  (`git cat-file -e` → exit 128) and does exist at `75411d9`, so restoration is a
  cherry-pick plus a lock, not archaeology.
- **Verified**: `orchestrator/runtime.env` (gitignored, `.gitignore:15`) and
  `orchestrator/runtime.env.bak-oldorch-20260804` (now ignored by `2c0499c`'s
  `.gitignore:20` — a commit **not yet on origin**) are the only reason the system runs.
- **Verified**: no workboard row exists for any of the three fixes the incident names. The
  incident's disposition is honest ("not fixed here"), but a finding without a row is the
  filed-and-forgotten shape — it must become rows tomorrow morning or it will be lost.
- **Verified**: `orch-fleet-nudge.timer` is `active` on this host while its script
  `/root/.local/bin/orch-fleet-nudge.sh` is outside the repository — a second live
  mechanism that does not travel with git. `bpa-orchestrator.service` is `inactive`; the
  orchestrator does not run under the supervision the repo defines.

### 1.2 The finished-but-stuck queue

- **Verified**: the `v3-2.9-rebase-only` lane (`ag-s11-4-r6`) named in the handoff has
  **finished, clean**: report at `/root/.cache/infra-lanes/v3-2.9-rebase-only.report.md`,
  rebased tip `a0aa099`, base distance 0, patch-id identical to the ACCEPTed work, full
  suite `660 pass / 0 fail` with the trailing triple present under `pipefail`, completion
  guard `verdict=pass`, and an explicit negative position-coupling audit. Remaining work
  is entirely the orchestrator's: meteorite proof, re-attestation dispatch, land. **V3-2.9
  — the gap my review ranked largest — is one orchestrator morning from landed.**
- **Verified** (handoff + counter registration `d58b8b1`): V3-0.55 has a re-attested
  ACCEPT at `7c9c85f` and sits parked at `no-progress` — a park HR-2285 says should never
  have been charged. Notably, **V3-0.55 has no workboard row at all** (grep confirms):
  it exists in the counter and in review artifacts but not in the plan document.
- V3-0.43 (re-attestation exists), V3-0.28 (recut needed — its test hard-codes
  `gate/land.sh:416`, and the V3-2.9 lane's report §3 already documents the safe
  behavioural-assertion pattern the recut should copy), V3-0.47 (report re-issue): all
  per the handoff, not independently re-verified — **inferred** current.

### 1.3 The tracked record is wrong in specific, checkable places

- **Verified**: workboard rows V3-0.44 and V3-0.51 still read **open** while both landed
  today (`6714091` = ag-s11-7, `4b578c7` = ag-s11-6; the coder commits `51f140a` and
  `866f0e0` are on `origin/main`). V3-0.29's row reads "round 4 running"; it landed at
  `158c312` (round 5). That is the fourth, fifth and sixth live instance of the V3-0.30
  class *since my review reported the third*. The handoff is currently more truthful than
  the board. Any dispatch tomorrow must be planned from the handoff plus the counter, and
  the board must be reconciled inside this sprint or the operator's go/no-go will be
  decided from a wrong document.
- **Verified**: the piped-`verify:` hole (my §1.15, V3-0.40) is **still live at HEAD** —
  `gate/completion-guard.ts:145` is still `spawnSync(command, { shell: true })` with no
  pipefail guard. Lanes are currently protected by *prose*: briefs teach the
  `bash -c 'set -o pipefail; …'` idiom (the V3-2.9 lane used it correctly). Prose-not-
  mechanism is this repository's named defect shape. V3-0.40's round 2 is in flight and
  already cost a live incident (V3-0.54: it consumed real counter rounds probing the gate).

### 1.4 Disposition of my global review — acted on, or dropped?

Judged finding by finding, since that was my specific charge:

| finding | disposition |
|---|---|
| §1.7 re-measure V3-0.23 first | **acted on, fully converged** — V3-0.51 found the 120s harness axe, landed today; V3-0.23's expensive serialisation was refused with reasons. This was the review's highest-expected-value call and it paid out exactly as predicted. |
| §1.2 V3-0.28 detector | **acted on in filing** (reopened, recut in flight), not landed. |
| §1.15 pipe hole (V3-0.40/0.38) | **acted on in filing**, not landed; hole live at HEAD (verified above). |
| §1.8 counter interface (V3-0.41) | filed, untouched. |
| §1.9 board reconciliation (V3-0.30) | in round 5, stuck behind V3-0.52; meanwhile three fresh instances accumulated. |
| §3.1 backup/state (V3-2.9) | **acted on hard** — HR-2171 ruled, six lanes ran, one landing-ready tonight. |
| §3.2 credentials (V3-2.10) | filed; blocked on operator ask #2, correctly overlapped. |
| §3.3–3.6 (quota, absence, daemon, inventory diff) | filed as V3-3.9, V3-1.12, V3-4.4, V3-0.42; all open — acceptable, none gates cutover. |
| §3.7 disk/log growth | **quietly dropped** — no row exists (V3-0.46 covers worktrees only, nothing covers log growth). Small; file it, do not sprint on it. |

So: the review was consumed honestly — filed, mostly; landed, barely. That is not
negligence, it is the same landing-tax finding all three previous members made,
measured a second way.

## 2. Path travelled — converging or diverging?

Honest split answer. **The quality machinery converges**: the review process remains the
strongest thing in the repository (my audit of all 73 artifacts stands), gates genuinely
fail closed (the completion guard refused the V3-2.9 lane's first report over a count-
claim technicality and was right to), and throughput rose — 15 landings today (verified:
`git log origin/main --since="2026-08-04" | grep -c "land lane"` → 15) against 12
yesterday, at a harder difficulty mix. **The inventory diverges**: 32 rows filed against
~15 closed, the board itself is wrong in at least three places tonight, and the launcher
incident proves discovery is not finished — the one mechanism nothing ever tested was the
one that starts everything. But the streams analysis from the synthesis still holds:
today's filings are dominated by one-time sources (my audit: 8; operator rulings: 9). The
decaying stream — defects found by working — is the one sprint 05 attacks, and V3-0.51's
landing already deleted four rounds of phantom work from V3-0.23. Verdict: **converging in
capability, not yet in count**, and the count inversion is precisely what this sprint must
demonstrate (§6).

## 3. Definition of cutover-ready — the decidable version

The operator can move to a new server when every line below is green at one named SHA.
Each is a command or an artifact, not a judgement:

1. **Cold-start from git**: on a clean container, the repository at the cutover SHA
   bootstraps and `orchestrator/launch.sh start` reaches a defined live state (singleton
   held, lease acquired, no unknown-action error), with the auth preflight present in-tree
   and provider auth stubbed as declared test data. Proven by an extended meteorite (or a
   dedicated `start-from-git` proof run at every landing that touches the start path).
   *This is the condition the current green meteorite does not test, which is how it
   stayed green through an unstartable launcher.*
2. **No break-glass required**: the same proof passes with `ORCH_STATE_DB` and
   `ORCH_AUTH_PREFLIGHT` unset — i.e. the two workaround lines are demonstrably
   unnecessary at HEAD. (Removing them on the live host is a separate, operator-visible
   step after the proof, never before.)
3. **State travels**: V3-2.9 landed (enumeration of non-git host state with per-item
   verify commands), plus the HR-2171 backup (archive → upload → unpack) executed once,
   restore proven **into the meteorite container** with mission/lane history intact.
4. **Credentials are a runbook, not a memory**: V3-2.10's runbook exists naming every
   credential, destination, scope and verify command, executed once end-to-end. Requires
   the operator's answer to standing ask #2 — re-send it at sprint open, in the morning.
5. **The channel survives**: V3-4.1 landed with the proof against the **production**
   daemon (round 1 was correctly REJECTed for proving a 30-line fixture).
6. **Supervision is armed by bootstrap**: a tracked decision of which units run on the
   new host (the HR-1720 question my review left open), with `bpa-orchestrator.service`
   and its watchdog among them, and the fleet-nudge script either tracked or retired —
   today it is untracked, root, live, and load-bearing (verified).
7. **The plan document is evidence again**: the board reconciled against the counter and
   `origin/main` at the cutover SHA — mechanically (V3-0.30) or, failing that inside the
   window, by one recorded hand reconciliation.
8. **His explicit go** (V3-4.3). Not ours to green.

Deliberately **not** in the definition: non-root lanes and the V3-1.9/1.10 privilege
chain (operator ruling today: stay on root until cutover), V3-0.29's remaining findings
beyond what landed, quota accounting, lane naming, squash landings, hardware
self-fitting. All post-cutover.

## 4. The programme — 10–12 hours, up to ~10 lanes

Ordered by when each starts; most run in parallel. Lane-hours are estimates
(**guesses**, calibrated on today's measured ~5.8 h/landed row for gated rows, much less
for orchestrator-side paperwork).

**P0 — hour 0, orchestrator, no lanes (~15 min): push local `main`.** `2c0499c` (the
incident record and the env-backup ignore) exists only on this host. One push closes the
most ironic Hard Floor 5 hole on the board. Evidence: `git ls-remote origin main` shows
`2c0499c`.

**P1 — hours 0–3, orchestrator + 2 short re-attestation lanes: drain the stuck queue.**
Land V3-2.9 (meteorite proof on `a0aa099`, dispatch re-attestation, land — the lane left
exactly this remaining), unpark and land V3-0.55 under HR-2285 (its re-attested ACCEPT
exists), land V3-0.43. Closes three finished rows and the largest gap my review found.
~4–6 lane-hours total, mostly orchestrator judgement. Evidence: three `land lane` commits
on `origin/main`; counter records the SHAs.

**P2 — hours 0–6, three parallel lanes: make HEAD startable (the new #1).**
- **P2a**: implement `reap` and `lease acquire|renew|release` in `core/mission-cli.ts`
  against `DurableStore`, plus a **vocabulary-parity lock**: extract every
  `mission_cli <verb>` invocation from `launch.sh` and assert each is dispatchable — the
  exact shape V3-0.15 already built for `instructions/`, so the pattern exists to copy.
  ~4–6 lane-hours.
- **P2b**: restore `orchestrator/preflight-cli-auth.sh` from `75411d9` as a tracked file,
  with a lock asserting every path the launcher `require`s exists in the tree.
  ~1–2 lane-hours. Trivially parallel with P2a.
- **P2c**: extend the meteorite (or add a landing-tier `start-from-git` proof) to start
  the orchestrator in the container and assert it reaches the live state, auth preflight
  stubbed as declared data. This is the class-closer — without it, conditions 1–2 of §3
  can regress silently again. ~6–10 lane-hours; the risky one. Scope it to "reaches lease
  acquisition with a stub preflight", not to full provider auth.
  Evidence for P2 jointly: the §3.1/§3.2 proof green at a landed SHA.

**P3 — hours 0–6, two parallel lanes: the two machinery fixes that pay for this sprint.**
- **P3a**: V3-0.52 — make "work complete, review pending" landable without a re-issue
  round. It is blocking V3-0.30 round 5 right now and taxes every future Tier-A row.
  ~2–3 lane-hours.
- **P3b**: V3-0.47 — let the orchestrator write bookkeeping without aborting in-flight
  landings (the round-4 lane already demonstrated the cheap content-neutral test). Four
  landings died to this today. ~3–4 lane-hours.
- Finish V3-0.40/V3-0.38 (round 2 is in flight): close the pipe hole in the guard itself
  so the protection stops being prose. ~2–4 lane-hours.

**P4 — hours 2–10, two lanes: state and channel.**
- **P4a**: HR-2171 backup as ruled (archive the state dir, upload, unpack to restore),
  restore proven into the meteorite container. Depends on P1's V3-2.9 landing for the
  enumeration it backs up. ~4–6 lane-hours.
- **P4b**: V3-4.1 round 2 against the production daemon. ~4–6 lane-hours.

**P5 — hours 8–12, orchestrator + 1 lane: make the record true.**
- Reconcile the board by execution (every open row vs counter vs `origin/main`), commit
  the reconciliation, and land V3-0.30 round 5 with the reopening-aware model its
  reviewer demanded if it fits; otherwise the hand reconciliation stands as evidence.
- Write the **cutover-ready checklist** (§3, one line per condition, verdict per line) as
  a tracked instance file. This is what the operator reads at hour 12.
- Run the HR-2166 ladder-trial measurement, due 2026-08-05 09:12 UTC — it is a standing
  promise to the operator and lands inside this window. ~2 orchestrator-hours.

**Morning asks to re-send at sprint open (overlap the latency, cost ≈ 0)**: the Drive
folder share, the V3-2.10 credential list, the unpark-expiry question, V3-1.7
restatement. None gate the first 8 hours; #2 gates §3.4.

Total: roughly 32–45 lane-hours across 10–12 wall-clock hours at 5–8 effective lanes —
inside the measured envelope of today's actual throughput.

## 5. What I deliberately cut, and the risk accepted

- **The entire non-root/privilege chain** (V3-1.9a/b, V3-1.10, V3-0.29 follow-ups):
  operator ruling, restated today. Risk: everything runs as root through cutover,
  including the window where a fresh server holds live credentials. Accepted — his call,
  and reversing it mid-sprint would burn the window.
- **V3-0.28's detector recut landing**: the reachability checker keeps lying until it is
  recut. Risk: a "no executor" defect ships undetected this week. Accepted because this
  sprint relies on direct proofs (P2c, meteorite), not on that checker.
- **V3-0.41, V3-0.42, V3-0.50 (beyond filing), V3-0.35/0.36, V3-1.11, V3-3.x features,
  V3-3.10 quota graph**: none gate a server move. Risk: known nuisances persist.
- **V3-1.12 operator absence, V3-3.9 quota exhaustion, V3-4.4 daemon failure modes
  beyond restart**: post-cutover. Risk accepted because cutover is by definition an
  operator-present event, and a mid-sprint quota cliff would cost work — that is a real,
  named exposure I am choosing to carry for 12 hours rather than fix first.
- **§3.7 disk/log growth**: file the row; spend nothing.

## 6. The measurement at hour 12 — falsifiable

1. **Headline**: a clean container, from the repository alone at the sprint's final SHA,
   reaches a live orchestrator state with the break-glass variables unset — exit 0,
   recorded in the proof artifact. If this line is false, the sprint failed, whatever
   else landed.
2. The finished-but-stuck queue is ≤ 1 row (was 5), and **rows landed during the sprint ≥
   rows filed during the sprint** — the ratio inversion the previous synthesis said would
   make a cutover date honest. If the ratio does not invert even with the one-time
   streams gone, the 4.5–6-day estimate is fiction and the honest report says so.
3. The restore proof exists: mission/lane history restored into the meteorite container,
   intact, from the HR-2171 archive.
4. The cutover-ready checklist (§3) is committed with a per-line verdict, and the
   operator can read exactly which lines are still red and why — including any that are
   red because only he can green them (credentials list, his go).
5. `2c0499c` is on `origin/main` and the board's stale rows (V3-0.44, V3-0.51, V3-0.29,
   the missing V3-0.55) are corrected in a landed commit.

## One sentence, if only one is read

The previous consilium was right that the landing machinery eats the sprint, but the
launcher incident changes the rank: a control plane that cannot start from its own
repository has no cutover to optimise — fix startability first, drain the five finished
rows in parallel, and let hour 12 be judged by one number: does a clean container come up
alive from git.

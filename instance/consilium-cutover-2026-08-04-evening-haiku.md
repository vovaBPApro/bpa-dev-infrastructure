# Consilium report — plain reading of state, 2026-08-04 evening

## Executive: The meteorite proof is broken and undetected; this blocks cutover.

The tracked record is honest about the work: 15 rows landed, 5 finished but stuck on paperwork. The three previous consilium members correctly identified Sprint 05 (fix the landing machinery) as the immediate priority. However, the central claim that enables cutover — "the repository alone can rebuild the host" (Hard Floor 5) — is **currently false and the mechanism that should have caught this is not running end to end**. The orchestrator restarted today only because two lines in `orchestrator/runtime.env` (gitignored) paper over two missing pieces: `orchestrator/preflight-cli-auth.sh` was deleted from git on 2026-08-02 and `mission_cli reap/lease` were never implemented at all. The meteorite proof has three blocking findings and one real run showing 17 failures; it is parked without an independent ACCEPT. Cutover requires this to work and to be verified working. This is the blocker that matters most, and it is not in the previous consilium's programme.

## State of affairs — what the tracked record actually shows

**Verified facts:**

1. `orchestrator/preflight-cli-auth.sh` is absent from `HEAD` (confirmed: `git cat-file -e HEAD:orchestrator/preflight-cli-auth.sh` → does not exist). It exists at `75411d9` (2026-08-02). The file is required by `orchestrator/launch.sh:139` and the launcher returns exit 2 without it.

2. `core/mission-cli.ts` implements: mission create/complete, manager create, lane create/claim/ack/progress/complete, outbox enqueue, status. It does not implement `reap` or `lease acquire/renew/release`. These are called by `orchestrator/launch.sh` at lines 143, 145, 173, 466, 602, 630, 664. The block is guarded by `state_available()`, so it fires only after the state database is created by lane activity — this is why a fresh box starts fine but crashed today after lanes ran.

3. Both workarounds live in `orchestrator/runtime.env` (gitignored at `.gitignore:15`), pointing to `/root/oldorch-breakglass/preflight-cli-auth.sh`. The break-glass directory is **not in git**. So the repository alone cannot currently start the orchestrator — which is precisely what cutover requires.

4. The meteorite proof (`V3-1.5`) is parked without an ACCEPT. Its one real run against `origin/main` in a clean `ubuntu:24.04` failed with 17 failures. The three blocking findings at round 3 (all related to cleanup not being crash-safe and cleanup failures leaving false-green reports) remain unresolved. The mechanism to prove Hard Floor 5 is therefore broken and unverified.

5. The previous consilium synthesis correctly identified that 12 rows actually landed today (not 3), at ~5.8 lane-hours per row, and all three members independently named Sprint 05 as the priority: "fix the landing machinery, not advance the chain." This is accurate against git state.

**Measurements that confirm the record:**
- 12 `[ORCH] land lane` commits in the last 24 hours (verified: `git log origin/main --since="2026-08-04 00:00" | grep -c "land lane"`)
- 32 rows filed against 10–12 closed on 2026-08-03 (from synthesis); system diverging, not converging
- Hard Floor 5 is currently unmet: repository alone cannot start orchestrator, meteorite cannot verify rebuild, one run showed 17 failures

## Path travelled — the work has been real but is diverging

| measurement | count | assessment |
|---|---|---|
| Rows filed in last two days | ~32 | Healthy discovery rate; operator steering is the largest source (9 rows, unbounded) |
| Rows closed in last two days | ~22 | Slower than filing; system is diverging, not converging |
| Lane-hours per landed row (2026-08-04) | ~5.8 | Phase 1 work is expensive (complex gates); Sprint 05 exists because this is untenable long-term |
| Landings actually executed | 12 | Previous brief said 3; counting error was using a 4-hour window, not the full day |
| Hard Floor 5 status | BROKEN | Orchestrator requires gitignored runtime.env; meteorite proof is parked, 1 real run = 17 failures |
| Review capacity consumed by machinery defects | ~6 of ~15 review rounds | Opus/Fable/Sonnet all identified this as the right thing to fix |

The landed work is real and the previous consilium's analysis is correct. The problem is that **the foundation is unsound**: if the operator cutover-ed to a new server today, the launcher would not start there, the meteorite proof would not validate it, and the operator would discover both on the live system.

## Definition of cutover-ready

Cutover means: move everything to a new server, bring it up there, and have it run on V3 with all features. This requires:

1. **Hard Floor 5 must hold:** The repository alone, without any host-specific configuration or break-glass files, must rebuild the system. This is verified by the meteorite proof starting clean `ubuntu:24.04`, cloning the repository with zero credentials, and producing `result: clean`.

2. **The orchestrator must start and reach a live state:** Not just the files copying across (the meteorite currently proves only this), but the orchestrator process starting, reading the state database, and becoming ready to dispatch lanes.

3. **All Phase 0 machinery must be landed and verified:** Phase 0 is "make the loop work at all" — a lane can finish, be reviewed, and land without human nursing. This is the foundation the previous consilium identified as the immediate blocker for both cutover and faster development.

4. **Evidence gates must be trusted:** Landing reviews must not consume excessive rounds on machinery defects; landings must not be aborted by orchestrator bookkeeping; the evidence chain must be unbroken.

5. **The meteorite proof must include orchestrator startup**, not just file rebuild. This is the gap that left the current hard-floor breakage undetected — the proof passes when the files are intact but never exercises what depends on them.

Current state against this definition:
- ❌ Hard Floor 5: Broken. Orchestrator requires gitignored environment. One real meteorite run = 17 failures.
- ❌ Orchestrator must start: Cannot start from git. Blocked by two missing implementations.
- ⚠️ Phase 0 machinery: Mostly landed but machinery defects (lane-exit role, landing gate concurrency, count-field parsing, unpark authority) are consuming rounds.
- ❌ Evidence gates trusted: Landings are being aborted mid-chain by orchestrator bookkeeping. Rate of rows filed >> rows closed.
- ❌ Meteorite includes startup: No. Proof has three blocking findings. Last real run failed.

## The programme for 10–12 hours

The previous consilium correctly identified Sprint 05 as the bottleneck. However, **it cannot be the only work**. Hard Floor 5 is currently unprovable and cutover is therefore not viable. The programme must address both the machinery defects AND the hard-floor breach. 

Assume 6–8 concurrent lanes. The constraint is not lane-hours but **the hard-floor blocker must be closed before anything else is credible**. A lane that lands Phase 1 work onto a repository that cannot rebuild itself from git is shipping a false green.

### Tier 1 — Hard Floor 5 (prerequisite for cutover claim)
**Lane hours: ~8–10. Parallel: yes (two lanes).**

| item | closes | lane-hours | evidence |
|---|---|---|---|
| **Implement mission_cli reap and lease** | Both blockers guarding `state_available()` in orchestrator/launch.sh | 5–6 | `bun test core/mission-cli.test.ts` passes; `mission_cli reap` and all three lease actions reply with sensible output; fresh state database does not cause launcher to die |
| **Restore preflight-cli-auth.sh to git** | Launcher's missing required file | 1–2 | File is in git at a known commit (75411d9); tracked location matches what launcher requires; test asserting the path exists in tree at land-time; test asserting launcher can find it without `ORCH_AUTH_PREFLIGHT` env override |
| **Extend meteorite to start orchestrator and measure it alive** | The gap that left Hard Floor 5 undetected; obsoletes current parked V3-1.5 | 3–4 | `meteorite/run.sh` starts orchestrator in container and waits for a status reply; `result: clean` only if the orchestrator reaches `state: ready`; real run in clean `ubuntu:24.04` exits 0 |

**Why this tier first:** Cutover is not possible without it. Every row landed after this moment is shipped onto a repository that may not work on day 2. The blocks must unblock.

### Tier 2 — Sprint 05 (the previous consilium's item; machinery defects)
**Lane hours: ~35–50. Parallel: yes (all lanes).**

**Queue, in order:** Land the five finished, ACCEPTed rows (V3-0.55, V3-2.9, V3-0.43, V3-0.28, V3-0.47) which are blocked only on paperwork. Then close the six machinery defects named by the previous consilium's review (V3-0.51 already landed; need V3-0.52, V3-0.44 follow-up, V3-0.40+V3-0.38, V3-0.31, V3-0.49).

**Evidence:** Each row landed with independent ACCEPT, or re-verified green after the previous row that unblocked it.

**Why here:** The rate of rows filed >> rows closed; machinery defects are the cause. Landing these five plus the six machinery fixes should visibly invert the ratio and prove the previous consilium's diagnosis.

### Tier 3 — Phase 1, starting with the lanes that depend on landing machinery being fixed
**Lane hours: ~60–80. Parallel: yes.**

**After Tier 2 lands:** Dispatch V3-1.6 (lane dispatch from v3 only), then the dependent rows (V3-1.7 requires operator restatement, V3-2.5, V3-2.6).

**Evidence:** Lanes reported from clean container; meteorite proof red-before on each phase-1 blocker.

## What I deliberately cut, and the risk accepted

1. **Cut: V3-1.9 unpark in this sprint** (the operator's one-time unpark go-ahead). It is legitimate work, but it depends on Tier 2 landing machinery fixes. Parking it for 12 hours trades a few lane-hours now for a cleaner gate later, and the row was already parked at no-progress so it incurs no new debt.

2. **Cut: Operator asks queued at sprint open** (the four decision/credential requests). They overlap with the work and should be dispatched in parallel with Tier 1. The risk of cutting them is that Tier 1 stalls on "waiting for operator decision" — but the four are orthogonal to the hard-floor fixes, so the dependency risk is low. The orchestrator should push them to the operator immediately and not wait for sprint completion.

3. **Cut: V3-0.23 root-cause proof** (the shell-tier concurrency contention). It is real, but Opus's diagnosis (the 120-second harness kill = V3-0.51, already landed) explains it, and V3-0.23 r3's watchdog work is sound on its own merits. Retrying it after V3-0.51 lands is the right move, not in this sprint.

4. **Cut: The six-instance contract-class audit** (V3-0.50). Filing it now is right; working it in this sprint would delay Tier 2 and dilute focus. File it, let it be clear why it exists, and tackle it after Tier 2.

## Measurement — what should be true at hour 12

**Cutover readiness:** At hour 12, run the orchestrator restart test: `ORCH_STATE_DB=/dev/null ORCH_AUTH_PREFLIGHT=/dev/true bash orchestrator/launch.sh start 2>&1; echo $?` should exit 0, not 2 or "unknown action: reap". The orchestrator should reply to `status` with a parseable JSON durable state. This proves Tier 1 is closed.

**Machinery defects:** The five queued rows should be landed (V3-0.55, V3-2.9, V3-0.43, V3-0.28, V3-0.47). Measure from `git log origin/main --since="2026-08-04 18:00 UTC" | grep "land lane"` — should see at least 5 new landings. This proves Tier 2's starting queue is clear.

**Convergence signal:** `git log --since="2026-08-05 02:00 UTC" --grep="filed" instance/ | wc -l` should be less than or equal to the number of new landings. (Yesterday: 32 filed, ~12 closed; this evening: ratio should invert.) If the ratio is still diverging, the machinery defects are not fixed yet and more hours are needed.

**Hard Floor 5 proven:** `meteorite/prove-candidate.sh --ref HEAD` should exit 0 (or report a named, transient blocker like "orchestrator not yet responding in container"), not a parser error or cleanup failure. The report should name every stage and show the orchestrator reaching a live state.

If all four hold, the sprint worked: hard floors are restored, machinery is fixed, and lanes can land faster. If any fails, the blocker is named in the measurement and the next round is bounded by it.

---

## Summary for the operator (15 lines)

**State:** Tracked record is accurate; 15 rows landed, 5 stuck on paperwork, system diverging (32 filed vs 10–12 closed). However, Hard Floor 5 (repository alone rebuilds host) is currently broken: orchestrator requires gitignored `runtime.env`, preflight-cli-auth.sh is missing from git, mission_cli has no reap/lease, and the meteorite proof is parked unverified.

**Path:** Previous consilium (three independent members) correctly identified Sprint 05 as the bottleneck. Machinery defects are consuming review rounds. Landings are real and working, but the foundation is unsound.

**Programme (10–12 hours):** Tier 1 (hard-floor restore): Implement mission_cli actions, restore preflight-cli-auth.sh, extend meteorite to start orchestrator — 8–10 lane-hours, unblock everything else. Tier 2 (Sprint 05): Land five queued rows, close six machinery defects — 35–50 lane-hours. Tier 3 (Phase 1): Lane dispatch, privilege boundary, machine memory — 60–80 lane-hours (starts after Tier 2).

**Measurement at +12h:** Orchestrator starts without gitignored env. Queued rows are landed. Ratio of rows filed/closed inverts. Meteorite proof exits 0 with full orchestrator startup in container.

**Cuts:** V3-1.9 unpark (deferred), operator asks (dispatch in parallel), V3-0.23 root-cause (retried after V3-0.51), contract audit V3-0.50 (filed, worked after sprint).


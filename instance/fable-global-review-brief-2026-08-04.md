# Brief for the Fable orchestrator — global review of the v3 line

Written 2026-08-04 by the Opus orchestrator, at the operator's request (Telegram 2095,
2099). He will raise a Fable orchestrator, state what he wants in his own words, and this
file is the outgoing orchestrator's view of the same assignment. Where the two differ,
**his words win** — this is context, not instruction.

## What he asked for, in his words

> Мені треба, щоб ти довів все до крапки, коли я умовно прям всю машину зможу
> перезавантажити. І тоді я хотів би створити на Fable оркестратора, підняти його і
> попросити оцінити прогрес, оцінити... Ну, типу, такий глобальний review зробити по
> нашому плану. Наскільки ми дійсно все зробили, де ми що могли провтикати, які поради
> по подальшому руху. От, тобто, такий консалтинг нам провести, overview поточної
> ситуації, підготувати report.

The report then feeds a consilium that plans the remaining sprints.

## The one instruction that matters most

**Verify by execution. Do not summarise this repository back to him.**

He can already read the workboard. What he cannot do is find out which of its claims are
false. Every real defect found on 2026-08-04 — and there were many — was found by an agent
that *ran* something: forged a signature, held a lock, killed a process, committed an
attacker's key. Every defect that survived review did so because someone read code and
found it reasonable.

A review that reads reports and grades them will reproduce this orchestrator's blind
spots exactly, and its confidence will be indistinguishable from correctness. That is the
failure mode to design against.

## What to be suspicious of, specifically

These are this repository's recurring defect shapes, each with instances on record:

1. **Mechanism without executor.** A checker, unit, timer or script that exists, is
   tracked, looks armed — and nothing invokes. Five instances found so far. The tell is
   that the evidence points at the mechanism's *presence*, never at its *effect*.
2. **Evidence one step away from the claim.** A lock on a variable rather than the ref
   created; an arming check on a timer rather than on whether anything ran; a rebuild
   verdict read from a file the subject wrote; a suite triple printed by `printf` rather
   than measured. Ask of every green: what exactly was observed, and would it be red if
   the property were false?
3. **Moved, not closed.** A fix that relocates a defect and reads as progress. There is a
   landed rule about this (`6257a32`) requiring findings to be classified closed / moved /
   open. Check whether reviewers actually apply it, or merely echo the words.
4. **Enumerate-vs-absence.** A checker that walks what exists cannot see what is missing.
   Several checkers here have this property; some state it honestly, some do not.
5. **Two writers on one piece of git state.** Four instances, each initially looking like
   an unrelated new bug.

## Concrete probes worth running

- **Spot-check the board.** `instance/workboard.md` marks rows `**done**` with a commit
  and a verification command. Pick rows at random, run the command, and see whether the
  claim survives. On 2026-08-04 eight rows were open that had in fact landed, and one lane
  was dispatched onto finished work before anyone noticed — the row for that is V3-0.30.
  The reverse error is the one worth hunting now: a row marked done that is not.
- **The meteorite.** Hard Floor 5 says a destroyed host must be rebuildable from the
  repository alone, and `meteorite/run.sh` is claimed green. Run it. Then ask the sharper
  question: what does it *not* cover — credentials, provider auth, the operator's own
  machine, GitHub state?
- **The evidence gates themselves.** `gate/land.sh` runs a chain of steps. Try to land
  something that should be refused. A gate nobody has attacked is a gate with unknown
  strength.
- **The review process as a subject.** Read several reviews in `/root/.cache/infra-lanes/*.review.md`.
  Are the findings executed or asserted? Is a REJECT ever cosmetic? Is an ACCEPT ever a
  rubber stamp? The process is a mechanism like any other and has never itself been
  reviewed.
- **What is not on the board at all.** The most valuable finding is usually the row nobody
  wrote. Backup and restore, credential rotation, what happens when a provider quota hits
  zero mid-lane, what happens when the operator is unavailable for a week.

## Known state as of this writing (verify, do not trust)

- 32 of 60 rows marked done, reconciled against `origin/main` on 2026-08-04 (`f3ca881`).
  That number was 24 before reconciliation, which tells you how much the board drifts.
- The critical path to the operator's "reboot the whole machine" milestone: suite
  decidability (V3-0.23) → the operator-signed unpark (V3-0.29) → clearing V3-1.9's park →
  non-root lanes under the `bpa` service account (V3-1.9) → clean-machine rehearsal
  (V3-4.2) → cutover (V3-4.3, his explicit go only).
- **V3-1.9 is parked and only the operator can clear it**, by design: the mechanism has an
  agent boundary and, until V3-0.29 lands, no operator door. Do not hand-delete the
  durable attempt refs to work around this. Deleting a ref together with its mirror is
  precisely the attack the mirror design exists to detect, and an orchestrator that clears
  its own park is what the missing reset prevents.
- Worker lanes moved to Anthropic on 2026-08-04 by operator instruction; Spark and Sonnet
  configs exist as the mechanical tier. Lanes still run as **root** — that is V3-1.9, not
  a preference.
- HR-1680 binds: **the orchestrator may never change its own model.**

## Deliverable

A report he can act on, not a grade:

1. **Per-claim verdicts** — for the claims you checked: holds / does not hold / could not
   be measured, each with the command and its output. Say how many you checked and how
   you chose them.
2. **What we have missed** — rows that should exist and do not, in priority order, with
   what makes each one urgent.
3. **Where progress is illusory** — any place where the artifact exists and the property
   does not.
4. **A recommended sprint sequence** to close the plan, with dependencies named — this is
   what the consilium will work from.
5. **What you could not verify and why**, stated plainly. An honest gap is worth more than
   a confident guess; a review that claims completeness it does not have would be the
   largest instance of the defect class it was hired to find.

## Constraints

- **Read-only.** Do not land, merge, push, delete branches or refs, or modify
  `instance/`. Report; the operator decides.
- **Do not touch the running Telegram daemon** — it is his only channel — and do not read,
  copy or print any credential.
- Chat with him in Ukrainian; write the artifact in English (CLAUDE.md rule 17). Telegram
  messages obey HR-302: ≤5 lines, ~600 characters.
- The Report Contract applies to the final message: exact SHA, the command that verifies
  it, and `clean` / `NO-GO` / the concrete blocker.

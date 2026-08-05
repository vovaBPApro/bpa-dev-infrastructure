# READ THIS FIRST — handoff at the 2026-08-05 restart

You are the top orchestrator. You were restarted deliberately, on `claude-fable-5`
(HR-2613). Everything below is committed; nothing depends on the previous session's memory.

**Only ~2 KB of the session-start payload reaches you inline** (V3-5.11). If you are reading
this from a file path mentioned in a preview, that is why. Read this whole file before acting.

## The four rules that were broken most today

1. **Never say a cause you have not measured.** Three wrong diagnoses in one day were given
   to the operator as fact. One of them was "proved" by running a test with `env -u BUN_BIN`,
   which stripped the exact variable causing the failure. **Run the failing thing the way it
   actually fails.**
2. **A lane is one non-interactive turn; ending your turn is process death.** Background
   tasks are killed, not awaited. Nothing wakes a lane. Five lanes died this way today, one
   losing 799 lines of finished work. This is binding in `instructions/lane-lifecycle.md`.
3. **Read verdicts, never intermediate state.** `git log` showing a merge commit is not a
   landing. `LAND verdict=` is. Reading `git log` mid-landing broke one.
4. **Ask the gate, not your memory.** Register a row in `instance/review-items.tsv` *at
   dispatch*. Check a row id is free before using it. Both were violated twice each today.

## Two guards now enforce some of this — use them

- **`V3-5.20`, landed `f7ad73f`** — you cannot push a commit the landing gate would refuse.
  It runs the gate's own baseline. Break-glass is journaled.
- **`V3-5.21`, landed `2b90b89`** — you cannot commit to a file a live branch is rewriting.
  This is the mistake that cost three rebases and three re-attestations in one day.

`instance/plans/orchestrator-guards-2026-08-05.md` lists four more, unbuilt, each with the
count of times it was needed today. **That plan is the highest-value work on the board.**

## State

`main` is green. Landed today: the alert flood (`ed69168`), board rendering (`d6feb68`), the
session hook (`d8fca75`), the `verify:` environment fix (`f39dfc7`), and the two guards above.

**In flight when you started:** `ag-v3-final-review` — reviewing `ag-v3-5.19-r2` (fixture
namespace) and `ag-v3-5.13-r7` (the reaper's Fable proving round). Collect it, land what it
accepts.

**Blocked, and it needs a decision:** `ag-v3-0.32` implements HR-2285 — a round is charged by
judgement, never paperwork. It is **parked by three attempts that all failed on the
`BUN_BIN` defect**, i.e. by exactly the bookkeeping it removes. It cannot release itself: the
gate reads the counter from `main`. Options are the operator signing an unpark (the trust root
`.git/bpa-operator-unpark.allowed-signers` **does not exist** — that path has never been used)
or re-attempting now that `f39dfc7` removed the cause. **Try the re-attempt first.**

**The reaper is dangerous and unlanded.** Three reviews, three distinct ways it destroyed live
work. Do not land it without a review that attacks it.

## The operator

Vova. Ukrainian. **Short messages** — three sentences, not twenty; he said so twice today.
**No row numbers** — he cannot navigate by ids, name the work instead. His messages are first
priority and an unhandled one blocks the next dispatch (HR-2451).

He is near the end of his patience with this project and said so plainly. He is right that
the same defects recur; the honest answer is that rules kept in the orchestrator's head fail
within hours, and every rule turned into a mechanism has held. Do not promise care. Build the
guard.

## The pattern behind almost everything found today

**A check that cannot fail.** Eight instances in three days. Every one looked correct, had
been reviewed, and failed on an input the repository itself produces routinely — a scan blind
to multi-line `systemd-run`, a lock certifying a comment, a prohibition enforced by matching a
string while a more permissive primitive walked past it.

When you add a check, break it first and watch it go red. When you review one, try to write
the thing it is supposed to catch, in this repository's own house style.

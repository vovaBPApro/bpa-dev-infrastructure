# In flight, 2026-08-05 ~02:00 — handoff after the overnight infrastructure run

Supersedes `instance/in-flight-2026-08-04-evening.md`, which describes the state before the
orchestrator crashed and was recovered by hand. Read this one; that one only for background.

## The state in one paragraph

Autonomy is back. The fleet watchdog is armed and honest, lane statuses stopped lying, and
four landings went in overnight through full Tier-A/Tier-B review plus container proof. The
launcher is still **not** reproducible from git — the orchestrator runs on two lines in a
gitignored file — so the cutover gates remain red. The operator decided the infrastructure
is not finished (Telegram 2398) and will decide about product work in the morning.

## Landed overnight

| row | sha | what it closed |
|---|---|---|
| V3-2.11 | `1fd31cc` | the fleet watchdog, restored from `v2-deprecated` and adapted. Three coder rounds, four independent reviews, one meteorite refusal. |
| V3-0.44 (reopened) | `aaf7ec6` | **systemd ate the tenth argument.** Every lane was invoking its exit gate as `--role ""`, so every lane reported `failed` regardless of its work. |
| V3-2.13 | `cae28ff` | "this document names a file that exists" is now a check. |
| V3-2.13 R2/R3 | in flight at time of writing | pair-keying lock + extensionless citations. |

## The four defect classes found, which matter more than the four fixes

1. **A variable expander silently substitutes empty.** systemd ate `${10}`; `envsubst` ate
   `$FULL_SUITE_ON_CALENDAR` and `$ORCH_WATCHDOG_INTERVAL` (V3-2.12, open — on a clean
   rebuild the nightly-suite and watchdog timers render broken); the inbox ledger passed in
   a checkout where its input file was absent. Absence rendering as success.
2. **A property defended by accident, not construction.** Pair keying held only because the
   ledger happened to carry duplicate paths; prose exclusion holds only because today's
   top-level directory names don't collide (N1); the fleet-count glob was safe until a test
   fixture claimed `lane-*`; `active_scope` was never wrong-looking because nothing ever
   evaluated it.
3. **The system asserts facts to its own agents that are false.** Sixteen findings in
   `instance/audits/false-facts-2026-08-04.md`, fourteen false. `CLAUDE.md` names
   `instance/README.md`, and HR-735 routes an agent there to check whether the operator
   already answered *before* asking him — the file does not exist, so he gets asked twice.
   He has objected to exactly that, twice.
4. **The gate checks an artifact instead of observing behaviour.** The meteorite proved
   files copy; it never started the orchestrator. It still doesn't — gate D is open.

## Open debts, in the order they should be paid

- **N1/N2 (V3-2.13)** — the prose-exclusion comment states a corpus measurement in the
  grammar of a rule property. One sentence to fix; a future lane will otherwise trust it
  instead of re-measuring.
- **R4 (V3-2.13)** — nothing runs the referenced-path checker against the real corpus
  automatically. **This is the row that decides whether the class is actually ended**: a
  predicate nobody runs is the same shape as a rule nobody enforces.
- **R1 (V3-2.13)** — a `<placeholder>` segment still makes any false citation invisible.
- **V3-2.12** — the `envsubst` render gap. On the cutover path.
- **F1, F2, F14, F15** from the audit — false *values* rather than paths, unreachable by the
  path predicate. `fleet.floor: 10` is still in `params.yaml`, still injected into the
  orchestrator's session context, still contradicting HR-2342 by name. Wants a schema plus
  per-key verifier.
- **V3-2.9** — host-state enumeration and restore. The operator shared a Drive folder for it
  (Telegram 2407) and the service-account key exists at
  `/root/.config/bpa/oauth/gcp-sa-bpapro-agents.json`, but **there is no Drive client in the
  repo and neither `gcloud` nor `rclone` is installed**, so "verify the folder works" is
  build work, not a check. This is the only loss that is irreversible.

## Operator rulings recorded overnight

HR-1494 (estimates are converted at measured fleet width, recorded two days late — the
error it named recurred in the meantime), HR-2335 (root until cutover; non-root out of
scope), HR-2342 (three lanes), HR-2367 (record the quota balance), HR-2369 (**repair only
what blocks the product**; everything else is reactive), HR-2377 (token and cost accounting
per model and per role — spec at `instance/specs/token-usage-accounting.md`), HR-2398 (the
cap is per repository; reliability outranks speed), HR-2401 (active scope corrected).

## What he is waiting on

1. A quota screenshot from him — `daemon/vendor-quota.ts` returns Claude as `unknown`, so
   the machine genuinely cannot read it. Baseline is in `instance/quota-readings.tsv`.
2. His decision on starting product work, which he said he would make in the morning.
3. Nothing else. Do not ask him things the record already answers — that is finding 3.

## Operating notes earned overnight

- **Do not run `bootstrap/install.sh` to deploy units.** Its `hygiene` step installs an
  hourly `reap.sh worktrees --apply` cron, and lane worktrees live under `/root/.cache`,
  which he has ruled off-limits. Mirror `render_units` only. Full sequence and the abort
  gate are in the incident file.
- **Lanes must run long commands in the background.** A lane died overnight ending its turn
  with the suite still running — V3-0.37, and its work was only recovered because the
  status was finally truthful.
- **Omit `verify-count:` and keep test counts out of report prose.**
  `gate/completion-guard.ts:130` anchors `^([0-9]+) pass$` and bun indents its summary, so
  the field cannot match and a count in prose trips the same rule.
- Branch names must strip to their registered root: `-r2` strips, `-r2b` does not.

## The orchestrator's own failures overnight, recorded so they are not rediscovered

- **Three confident wrong numbers**, all corrected: a `FAIL`-in-prose grep tally, the inbox
  98/78/15 split, and "twelve findings" for an audit that has sixteen. Same mechanism each
  time — a count reached for mid-sentence and written before it was verified. The third one
  propagated into a lane's report before a reviewer caught it.
- **Pushed a red `main`** by treating `check.ts --strict` as verification of a commit. It is
  not the suite. Red for about twenty minutes.
- **Kept him awake.** Knew the watchdog was failing every ten minutes and correctly paging
  him, left the timer armed while dispatching the repair, then sent him several hundred more
  words after he said he wanted to sleep. He said so twice.

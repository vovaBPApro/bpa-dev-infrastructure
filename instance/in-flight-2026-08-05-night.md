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
| V3-2.13 R2/R3 | `b68f651` | pair-keying lock + extensionless citations. |
| V3-2.12 | `b5f1cad` | unit rendering no longer silently empties the nightly-suite and watchdog timers on a rebuilt host. **Four coder rounds, five reviews, three landing attempts.** |
| V3-2.16 | `d8a2731` | the unit-path exemption ledger expires an entry. `meteorite/run.sh` had stayed excused as "not yet built on v3" while executing in every landing all night. Two ledgers in one repository had settled the same rule differently; they now agree. |

## V3-2.12 is the row to read if you read only one

Its two landing refusals were both the gate working on evidence, and **neither cause was in
the change under review**:

1. The completion guard re-ran the verify command in its own fresh checkout and found a
   failure three prior green runs had missed — the lane's, the reviewer's and the exit
   gate's all ran where ambient host state happened to be benign. Cause: `/usr/bin/X11` had
   been rewritten into a self-loop (`instance/incidents/2026-08-05-host-symlink-corruption-broke-the-suite.md`).
2. The meteorite refused it: `instance/units/agentic-bpa-stand-verifier.service.in` requires
   `postgresql.service`, absent in a clean container, so `systemd-analyze` emits
   `Unit <name> not found` and the classifier called it fatal. That defect had been in the
   row **since its first commit** and had never been executed in a clean container. Four
   reviews looked at that code and none could have seen it.

**And the orchestrator dispatched round 3 against a diagnosis it had inferred rather than
measured** — that the container lacked `systemd-analyze`. The lane ran the container's own
prerequisites command, found the binary present, reported `NO-GO`, and changed nothing,
because the brief said to confirm the cause first and stop if it differed. Had it been
agreeable it would have shipped a no-op, the meteorite would have failed a third time, and
the real cause would have been hidden behind a plausible fix. That is exactly how V3-0.44
spent a day marked `done` against the wrong cause. **Keep that instruction in every brief
that hands over an inference rather than a measurement.**

## The four defect classes found, which matter more than the four fixes

1. **A variable expander silently substitutes empty.** systemd ate `${10}`; `envsubst` ate
   `$FULL_SUITE_ON_CALENDAR` and `$ORCH_WATCHDOG_INTERVAL` (V3-2.12, open — on a clean
   rebuild the nightly-suite and watchdog timers render broken); the inbox ledger passed in
   a checkout where its input file was absent. Absence rendering as success.
2. **A property defended by accident, not construction — the dominant pattern, eight
   instances.** Pair keying held only because the ledger happened to carry duplicate paths.
   Prose exclusion holds only because this repository's top-level directory names happen to
   be ordinary words — backtick the existing phrase `vendor/session` in `CLAUDE.md` and the
   checker goes red. The fleet-count glob was safe until a test fixture claimed `lane-*`.
   A shell guard and a TypeScript test turned out to be accidental complements, catching
   the unquoted and quoted forms respectively, "which is not a designed division".
   `active_scope` was never wrong-looking because nothing ever evaluated it. V3-2.12's
   derived list "carries two meanings that only coincide today". Every one was correct when
   written and one edit away from silently ceasing to be.

   **This is the finding to hand the operator, not the individual fixes.** Each instance is
   cheap; the pattern is not. A property nothing asserts is a property that will drift, and
   the drift is invisible because the code still reads correctly.

   Its close relative, seen seven times: **a check that cannot fail.** A drift test
   asserting no `${VAR}` survived, which unrestricted `envsubst` can never leave. A
   bootstrap check invoking `rg`, absent on this host, so it exited 127 and passed by never
   running. A "one list" guard whose regex required `$` immediately after `=` while every
   real assignment has a quote there — added by the very commit that fixed the other two.
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

## Measured at 07:30, recorded and deliberately not acted on

Watchdog health after ~9 hours armed: both timers `active`, `Result=success`, **0 restarts**,
heartbeat 21s old with `status=0`, and **exactly one** operator alert file across hours of
idle — B1's per-episode deduplication holding in production, against 36 messages a night
before it.

Lane sprawl, `/root/.cache/infra-lanes`:

| | count |
|---|---|
| registered git worktrees (`land-main`) | 165 |
| registered git worktrees (primary repo) | 48 |
| instruction pack directories | 306 |
| total size | 1.9G |

Root filesystem is 36% used with 247G free, so this is not urgent. It is recorded because
**Hard Floor 12 says worktrees must not breed and the operator has ruled `/root/.cache`
off-limits for cleaning** (Telegram 2132/2134, message 1839: *"не треба прибирати, ми все
одно все вичистимо і почнемо з нуля коли в3 буде готова"*). Those two are in tension, his
ruling wins, and the tension should be visible rather than quietly resolved by a reaper.

It is also a cutover question with a subtlety: a large share of these worktrees carry
`state: failed` statuses that **were lies** until `aaf7ec6` landed. Going forward a status
means something; historically it does not. So "discard the failed ones" is not a safe rule
for anything created before that commit, and the safe reading is that pre-`aaf7ec6` lane
statuses carry no information at all.

## Operator rulings recorded overnight

HR-1494 (estimates are converted at measured fleet width, recorded two days late — the
error it named recurred in the meantime), HR-2335 (root until cutover; non-root out of
scope), HR-2342 (three lanes), HR-2367 (record the quota balance), HR-2369 (**repair only
what blocks the product**; everything else is reactive), HR-2377 (token and cost accounting
per model and per role — spec at `instance/specs/token-usage-accounting.md`), HR-2398 (the
cap is per repository; reliability outranks speed), HR-2401 (active scope corrected).

## STATE AT 07:10 — read this first if you are a compacted or restarted session

**Do not restart to "reload context". It will not reload.** Audit finding F4: the
SessionStart hook is wired only on the codex branch of `launch.sh`, points at
`.claude/hooks/session-load.sh`, and that file does not exist and is untracked. A restarted
orchestrator comes up blank and learns only what it reads from this file. Also
`orchestrator/runtime.env` currently pins `ORCH_CLAUDE_MODEL=claude-fable-5`, so a restart
changes the model.

**Branches finished, reviewed or not, all pushed — none is host-only:**

| branch | state | next step |
|---|---|---|
| `ag-v3-2.9-r7` | rebased, suite green, ACCEPT is stale | re-attestation, then land |
| `ag-v3-req-audit` | the requirements audit (384 lines) | land the artifact |
| `ag-v3-instance-readme` | generated `instance/README.md` | review, then land |
| `ag-v3-3.10` | token+cost accounting, `stream-json` shape | review, then land |
| `ag-v3-2.15` → `ag-v3-2.15-r2` | fleet cap; r2 moves 3→5 per HR-2456 | review, then land |

**Running when this was written:** `ag-v3-fable-plan` (Fable, manager role — the plan for
the requirements-reading problem, his top priority), `ag-v3-2.15-r2`.

**The generated obligations list now exists** (`instance/README.md` on its branch): **285
directives captured, 234 answered, 33 open, 18 with no status at all**. The orchestrator had
been saying "15 owed" — that was one triage batch presented as the whole. Trust the file,
not a remembered number.

**His two new rulings this morning**, both binding: `HR-2451` (his messages are first
priority; **an unhandled message blocks the next dispatch** — he chose the strict form over
a time threshold) and `HR-2456` (lane cap raised to five; five is the *measured saturation
point* of this host, not headroom — watch the suite's runtime).

**Asked of the old orchestrator** via `/root/orch-mailbox/to-oldorch.md` (live, polls ~60s):
the on-the-fly model-switch mechanism, and the cached `preflight-cli-auth.sh` source. Check
`from-oldorch.md` for replies.

## Owed to him right now — written down because forgetting these is the defect under audit

1. **`character` column in the token-accounting table** (Telegram 2449, *"скажи хай
   додає"*). The V3-3.10 lane was already running when he asked and a running lane cannot
   be given new instructions, so this is a short follow-up commit after it lands. Nullable,
   empty until the cast exists — his own idea from messages 1915–1919 (жнець, архітект,
   кодер, Менеджер, Вова), still unbuilt.
2. **An MD file with the roles, their relationships, and an explanation of each character**
   (message 1931, 2026-08-03: *"запусти агента, виділи список ролей… В MD-файл там"*). It
   is in `triage.jsonl` as a **directive with `answer_status: owed`** — captured, triaged,
   marked not-done, and then not done. He raised it again on 2026-08-05 with
   *"ти благополучно проїбав"*, which is accurate. Deferred until the requirements audit
   reports, because the audit may show the real role set differs from the assumed one.
3. **Check the requirements audit actually found both** the Drive/backup case (HR-2171) and
   message 1931. He asked for them to be included after the lane had started, so its brief
   does not name them. If a sweep of the whole history misses two known instances, that is a
   defect in the audit and must be reported as one rather than quietly patched.

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

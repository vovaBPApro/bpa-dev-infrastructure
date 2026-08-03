# v3 workboard

The tracked plan for finishing v3. Built from measurements taken 2026-08-03, not
from estimates. Sources, all on `v2-deprecated`:
`instance/v3-mechanism-gap-2026-08-03.md` (126 missing mechanisms, 33 blocking),
`instance/consilium2-2026-08-03-v3-viability.md`, `instance/reap-executed-2026-08-03.md`,
`instance/report-pinning-convention-2026-08-03.md`.

Every row has an acceptance criterion that is a command, not a judgement. A row is
done when the command exits 0 at a landed SHA. Rows are ordered by dependency: a
later phase cannot start honestly until the earlier one holds, because the earlier
phase is what makes "done" measurable at all.

Operator constraints in force: HR-1720 (host deployment deferred to v3, so all of
this lands in the repo and is proven in a container, not by touching this host),
HR-1718 (v3 stays the working line; cutover last), HR-1726 (review rounds capped at
3, escalate to executable locks).

---

## Phase 0 — make the loop work at all

Nothing else can be trusted until a lane can finish, be reviewed, and land without a
human nursing it.

| id | row | acceptance | state |
|---|---|---|---|
| V3-0.1 | Port `gate/land.sh --target-branch` from the abandoned line. Without it landing is only possible onto the repository default branch. | `env -u BUN_BIN bash gate/land-target-branch.test.sh; echo $?` → 0 | **done** — landed `f331295`, `verdict=landed review=accepted`. See "Nested gate invocations" below: the apparent flakiness was the verify command, not the change. |
| V3-0.2 | Lane terminal reports: enforce the corrected convention. The report is an external file naming the branch tip; a report committed into its own branch can never match the tip (proven, see `report-pinning-convention`). Wire `gate/completion-guard.ts` at lane exit, not only at land time. | a dispatched lane cannot end while `bun gate/completion-guard.ts --report <path> --repo . --branch <tip>` exits non-zero | not started |
| V3-0.3 | Landing gate rollback defect: an aborted landing left local `main` advanced to the merged commit with a dirty tree. Origin was never touched, so the push boundary held, but the local ref moved after `verdict=aborted`. | a test that aborts a landing at post-merge-verify and asserts `git rev-parse <target>` is unchanged | not started |
| V3-0.4 | Ledger drift check — **done**, landed 2687420 + 76c5363. | `bun test tools/check-decision-ledger-drift.test.ts` → 2 pass | **done** |

## Phase 1 — a clean server can be rebuilt from this repo

The 33 blocking mechanisms from the gap inventory. Until this phase holds, wiping the
host is unrecoverable and Hard Floor 5 is not satisfied by v3 alone — the only copy of
the rebuild path is on `v2-deprecated`.

| id | row | acceptance |
|---|---|---|
| V3-1.1 | Port/rewrite `bootstrap/` — `install.sh`, `deploy-host-mechanism.sh`, `check-unit-drift.sh`, `check-deployed-drift.sh`, `telegram-transport-preflight.sh` and their tests. | `bash bootstrap/bootstrap.test.sh; echo $?` → 0 |
| V3-1.2 | Port the 17 unit templates under `bootstrap/units/`, including `bpa-telegram-daemon.service.in` and `bpa-orchestrator.service.in` — the units that start the system at all. | `bash bootstrap/check-unit-drift.sh; echo $?` → 0 against a container |
| V3-1.3 | `tools/whisper/install.sh`. v3 has `daemon/transcribe.ts`, which calls whisper, and nothing that installs it. Raised by the operator directly (Telegram 1760). | in a clean container: install, then `$WHISPER_BIN --version` exits 0, then a voice fixture transcribes |
| V3-1.4 | `hygiene/reap.sh` + `install-cron.sh`, and an executor. On the old line the cron was tracked and never invoked (`crontab -l` → "no crontab for root"), which is why 1372 branches accumulated. | reap runs on a timer in the container and a seeded stale branch disappears |
| V3-1.5 | `meteorite/run.sh` — the clean-rebuild proof itself, absent from v3 while the plan measured v3 against it. | `bash meteorite/run.sh` from a clean clone in Docker exits 0 |

## Phase 2 — supervision that does not depend on the Human noticing

The 2026-08-03 investigation found the watchdog had not run since 2026-08-01 12:35:57Z,
`orch-runtime-watchdog.timer` installed but never armed, and
`notify_human_below` declared in `params.yaml` and read nowhere.

| id | row | acceptance |
|---|---|---|
| V3-2.1 | Unattended orchestrator restart, armed by the bootstrap path, not by hand. | kill the orchestrator in a container; it is back within the configured interval |
| V3-2.2 | Human escalation when running lanes fall below `fleet.notify_human_below`. Make the knob live or delete it — a config promising escalation and delivering nothing is worse than none. | seed 0 lanes in the container; a Human-addressed message is emitted |
| V3-2.3 | Deployment-drift detection that is not itself subject to the drift it detects. `bpa-deploy-drift-guard` was among the 8 units missing from the host, which is why the gap went unreported for days. | remove a deployed unit in the container; the guard reports it and exits non-zero |
| V3-2.4 | Orchestrator model pin asserted at startup; a mismatch between the pin and the live session is a fail-closed error. HR-1680: the orchestrator may never change its own model, and v3 must make it structurally impossible. | start with a mismatched pin; startup refuses |

## Phase 3 — requirements that were agreed and silently dropped

From the requirements-coverage audit. These are not new features; each was ruled by the
Human and then lost when the fork copied a file tree instead of a ledger.

| id | row | source |
|---|---|---|
| V3-3.1 | `/model` switches the live session, not only the next relaunch. | HR-1349 |
| V3-3.2 | Spark routable as the cheap tier for mechanical lanes; quota is measured today and cannot be spent. | HR-1734, restating 1562 |
| V3-3.3 | Weekly per-provider model discovery with fit metadata, pluggable providers, fail-closed to the last committed catalog. | HR-1739 |
| V3-3.4 | Review round cap enforced by a counter and the gate, not by prose. The current rule carries a PROSE ONLY banner because nothing counts rounds. **Plus a no-progress detector** (operator ask, Telegram 1780): the cap counts attempts, which is not the same as detecting a stuck item. If N consecutive rounds on one item produce no landed SHA, park it automatically — an item can burn rounds while looking busy, which is exactly what the `authority` epic did across r6–r23. | HR-1726, HR-1780 |
| V3-3.5 | Decision-request options explained in the message body; a button label is ~3 legible words. | HR-1752 |
| V3-3.6 | Vendor quota display, so a quota cliff is visible before it is hit. | ML-6 |
| V3-3.7 | Self-hosted, user-teachable OCR. | HR-1418 |

## Phase 4 — cutover

Only after Phases 0–2 hold.

| id | row | acceptance |
|---|---|---|
| V3-4.1 | v3's daemon proven to hold the Telegram channel across a restart. | restart in the container; a round-trip message survives |
| V3-4.2 | Clean-machine rehearsal from a bare container using only this repo. | `meteorite/run.sh` green from a fresh clone |
| V3-4.3 | Host cutover — the operator's "почищу сервак і з нуля почнемо". | his explicit go, after 4.1 and 4.2 |

---

## Nested gate invocations — a property to know before writing a `verify:`

`gate/land-lib.sh:19-23` (`land_resolve_bun`) refuses to run when `BUN_BIN` is already
set in the environment:

```sh
if [ -n "${BUN_BIN:-}" ]; then
  echo "LAND step=preflight status=fail detail=caller-bun-override-refused" >&2
  return 1
fi
```

That is a deliberate supply-chain control: a caller must not be able to choose which
`bun` binary the landing gate trusts. It resolves only from the fixed host baseline
`/usr/local/bin:/usr/bin:/bin` and canonicalises symlinks.

The consequence is easy to trip over. `gate/land.sh` exports `BUN_BIN` for its own
run, so **any test that itself invokes `gate/land.sh` will fail when used as a
landing's `verify:` command** — the nested gate correctly refuses. It passes standalone
and fails under the gate, which looks exactly like flakiness and is not.

This cost roughly an hour of misdiagnosis on 2026-08-03, including a workboard row
wrongly marked blocked. The fix in a `verify:` line is `env -u BUN_BIN`, which restores
the standalone condition without weakening the control — the nested gate still resolves
its own bun from the trusted path.

Note also that this host carries two bun installations: `/usr/local/bin/bun` 1.2.22
(the one the gate's trusted path finds) and `/root/.bun/bin/bun` 1.3.14 (the one on
the interactive `PATH`, which lanes test with). The gate is not wrong to pin the
baseline, but lanes verifying on a different version than the gate is a skew worth
closing in Phase 1.

## Standing check this plan creates

The fork copied files and lost rulings. `tools/check-decision-ledger-drift.sh` now
closes that for the decision ledger. The same shape is still open for mechanisms: a
scheduled inventory diff of executable mechanisms between this line and
`v2-deprecated`, failing until each absence is either ported or dispositioned with a
reason. Until that exists, Phase 1's list is a snapshot that can go stale the same way
the ledger did.

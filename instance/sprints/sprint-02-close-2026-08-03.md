# Sprint 02 close — 2026-08-03

Planned 15:15–20:15 Europe/Warsaw. Closed early. Three of the four planned rows landed;
the fourth was withdrawn by the operator, not missed.

## Verified the ungameable way

Re-executed fresh at the landed SHA `e32efa5`, never taken from a lane's self-report:

| row | acceptance command | exit |
|---|---|---|
| S2-3 / V3-1.1 | `bash bootstrap/bootstrap.test.sh` | 0 |
| S2-3 / V3-1.1 | `bash bootstrap/install.sh --dry-run` | 0 |
| V3-0.5 | `env -u BUN_BIN bash gate/lane-exit.test.sh` | 0 |
| all | `env -u BUN_BIN bun test` | 444 pass, 3 skip, **0 fail** |

S2-2's proof is deliberately not in that sweep — it costs ~284 s and ~1.5 GB per run —
and was verified once at its own landing, in a clean container.

## What landed

- **S2-2 / V3-1.3 container proof** (`e32efa5`). V3-1.3 landed this morning with three
  things honestly deferred. All three are now closed, for real: a clean
  `oven/bun:1-debian` image deliberately missing `git`, `cmake`, `g++`, `make`, `curl`,
  `ffmpeg` and `espeak-ng`; a real `apt-get` of ~150 packages; a real whisper.cpp compile
  from the pinned commit; a real 1,624,555,275-byte Hugging Face download with checksum
  verification; and a transcript asserted **on content** through the real
  `daemon/transcribe.ts` path, using a different phrase than the installer's own smoke
  test so the two cannot vouch for each other.
- **S2-3 / V3-1.1 stage 1** (`88361ff`). The first piece of the only tracked path that
  can rebuild this server.
- **V3-0.5** (`1f30726`). The lane-exit guard stopped being advisory.

## What the reviews caught, again

- `core/mission-cli.ts`'s `lane complete` accepted a report path and **never opened it**.
  A lane could record itself terminal pointing at a file that did not exist — proven by
  execution: pre-fix it returned exit 0 with `terminalVerdict: "clean"`.
- `orchestrator/dispatcher.ts` validated reports with `report.includes()`, a substring
  check. A forged report with an injected line passed it. The reviewer hand-forged one
  rather than rerunning the lane's test.
- `sync_repository` fast-forwarded whatever branch was checked out without checking
  which. On this host — deliberately on `v2-deprecated` while `origin/main` is v3 — it
  would have reported a clean bootstrap and left the machine on the abandoned line.
- `unzip` had been trimmed from prerequisites as "only needed elsewhere". The reviewer
  fetched the real `bun.sh/install` and found `error 'unzip is required to install bun'`.
  On a clean machine — the only place this script matters — bun would not have installed.

Each of those was **reproduced**, not argued.

## The self-test list paid for itself

Sprint 02's briefs carried a list of the failure classes reviewers kept finding. Its
first return: the S2-3 lane caught its own violation of
`instructions/verification-and-locks.md` — it had copied the secret pattern literal into
a test, which that instruction forbids — and fixed it before requesting review. That is a
class that previously cost a full review round.

It does **not** cover everything. Both S2-3 defects were factual claims about what
something else requires (`bun.sh/install` needs `unzip`; the installer must target a
specific branch). The rule added: when trimming or dropping anything because it is "only
needed elsewhere", verify against the thing itself, the way the reviewer did by reading
bun's installer.

## Two corrections recorded

**Codex was available all along.** The orchestrator told the operator that subagents
could only be Claude, based on `orchestrator/dispatch-lane.sh` on v3 saying no launcher
exists. That was wrong: `orchestrator/fleet/launch-lane.sh` on `v2-deprecated` — the
branch this working tree is checked out on — launches `codex exec` and works. Proven by
dispatching a smoke lane, which ran and reported `Я працюю на моделі GPT-5`. A full day
of lanes therefore burned the scarcer Anthropic quota while Codex sat idle. Mechanical,
well-specified rows move to codex lanes from here; Claude stays on Tier A review, where
adversarial reasoning earns its cost.

**The GitHub CI row was mis-prioritised at dispatch.** It was planned on the finding that
"nothing on v3 verifies automatically". `gate/land.sh` already runs the full tracked
suite through `land_run_declared_checks` on every landing, so the premise was overstated.
The operator deprioritised it; the lane was stopped before committing, and its slot went
to V3-0.5. Its inventory work was kept.

## Prediction, settled

The adversarial seat predicted 4 rows and named the assumption that would falsify it —
that splitting `bootstrap/` into container-independent sub-rows in the donor's
stub-fixture style would allow 6–7. The split was taken. Three landed, one was withdrawn
by the operator. Its reasoning about Tier A cost held: every Tier A row needed a second
review round.

## Carried forward

- `V3-1.1` stages 2+: test gate, unit rendering, then `activate_units` last — it runs
  `systemctl enable --now bpa-orchestrator.service` and needs a maintenance boundary.
- `V3-1.5` `meteorite/run.sh` — now genuinely runnable, since a container harness exists.
- `V3-0.6` fleet counter, `V3-0.7` `refs/stash`, `V3-0.8` manifest anchor.
- The scheduled trigger for the whisper proof, left out to avoid a scope collision.

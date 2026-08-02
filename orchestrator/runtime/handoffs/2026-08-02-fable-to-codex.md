# Handoff: fable session → codex successor (2026-08-02, quota emergency HR-1457)

## Where everything stands

- **main** @ see `git log`: HR-1439 "unmeasured = failed" is LAW in
  verification-and-locks (landed f866b0e via full gate). All of today's HR
  captures (1349..1457), triage rows, W-39..W-48 routed. Reviews and analysis
  retained under reports/.
- **v3 branch** (HR-1382, marriage of two bases): landed = foundation, state
  (+fenced retry, + atomic completeLaneWithEscalation on ag-v3-state-r4b tip
  dee8ba19 — NOT yet landed), recovery (+transport quarantine), telegram
  (fail-closed masker), dispatcher, fixture-gating. Root suite 391/0 at
  99db22d→(71ef09c,99db22d landed later — see origin/v3 log).
- **Critical path to Vova's evening test** (task: land remaining, then
  clean-clone `git switch v3 && ./scripts/meteorite.sh`):
  1. WAIT lane `v3-dispatch-r10` (consumes atomic API; base ag-v3-state-r4
     23498a7c). Then review-14 of the coupled pair: state tip dee8ba19 +
     dispatch-r10 tip. Conventions: canonical report at tip via code-sha
     two-step; UNMEASURED=FAIL; kill-anywhere probes.
  2. Land state-r4b then dispatch-r10 into v3 (merge --no-ff in worktree
     /root/.cache/infra-lanes/v3-integrate, verify at boundary, family
     secret scan vs v3 root, push).
  3. Meteorite rerun on updated tree with container context
     (ag-v3-container-r4 @ 14026b38): expect gates 6-9 now measurable
     (dispatch git-less provenance fixed in r8/r9 — landed? NO: r8/r9 NOT
     landed either — they are part of the r10 chain lineage. Verify lineage
     before rerun: r10 sits on state-r4 which sits on v3; r8/r9 fixes were
     folded via the dispatch chain — CHECK `git log ag-v3-dispatch-r10` for
     e99aae50/795cd950 ancestry).
  4. Container entrypoint lock at combined tree → land container → land
     meteorite chain → full clean-clone run → hand Vova the command.
- **Running background lanes**: hist-genesis (his early instructions →
  testable reqs), hist-oldorch (old-orc archive; W-30 encoding). Collect
  reports, retain to reports/, route UNROUTED items to workboard.
- **Parked**: W-47 junior tier (measure in-quota tiering first), HR-1451
  product consilium (prep done — round-1 lens reports = input), W-48 night
  admission gaps V3-GAP-1..6 (NO overnight runs until landed).
- **Fleet discipline**: all lanes codex-only (msg 1358); lane count to Vova
  unprompted (HR-281); message ceiling 5 lines/600 chars (HR-302); his words
  verbatim always.

## Quota rules now

Anthropic ~10% for today+tomorrow: top orchestrator on codex gpt-5.6-sol
(pinned in runtime.env), Claude only for exceptional single calls if Vova
explicitly approves. Fable/Opus untouched without his word.

## UPDATE (last fable turn): review-14 outcome

- state-r4b dee8ba19: ACCEPT — may land into v3 (independently additive).
- dispatch-r10 4a5d8463: REJECT on LINEAGE ONLY (chain was rebased; r8/r9 not
  ancestors; e99aae50 not even an object). Behavior fully green at tip (14/14
  parity, 13/13 locks, all windows). Successor: add durable provenance mapping
  the cherry-picked commits (32224ce, 119836c) to r8/r9 originals — or rebuild
  the chain with true ancestry — then re-review the exact new tip
  (v3-review-15) and land coupled with state-r4b. Review retained:
  reports/v3-review-14-2026-08-02.md. genesis/oldorch addenda retained in
  reports/ with UNROUTED items to route.

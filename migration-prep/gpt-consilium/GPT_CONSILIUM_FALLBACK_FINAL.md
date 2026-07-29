# GPT Consilium — Fallback-Mode Readiness Review (FINAL)

Provenance: ordered by the Human (Vova, Telegram 11582, 2026-07-29 — captured
verbatim in `instance/decisions/HR-11582.md`): review the instruction stack on
GPT models so it works maximally well when the orchestrator runs on a SOL/GPT
model. Three independent Codex CLI sessions, three models, three lenses, all
reviewing SHA `aac0ac99` read-only:

| Lens | Model | Verdict file | Verdict |
|---|---|---|---|
| Operator (cold GPT orchestrator walkthrough) | gpt-5.6-sol | `verdict-operator-gpt56sol.md` | NOT GPT-ready today |
| Architecture / portability | gpt-5.6-terra | `verdict-portability-gpt56terra.md` | NO-GO for vendor neutrality |
| Instruction clarity for GPT readers | gpt-5.5 | `verdict-clarity-gpt55.md` | 10 findings, 1 blocker |

The full verdicts are preserved unedited beside this file. This synthesis
groups them; it adds no findings of its own.

## Convergent findings (independently found by 2–3 reviewers — settled)

1. **`orchestrator-fallback` is not in the orchestrator baseline pack**
   (all three; BLOCKER). Tag-reachable ≠ delivered: a cold GPT orchestrator
   doesn't know to ask for `--tags fallback`. Fix: add to `[orchestrator]`
   (and `[manager]`) baselines in `instance/packs.conf`; consider an explicit
   `--runtime primary|fallback` compose mode.
2. **`session-load.ts` referenced as mandatory but missing at the reviewed
   SHA** (all three; BLOCKER at aac0ac99). Already fixed in flight: branch
   `ag-item6-tail` implements `tools/instructions/session-load.ts` + the
   SessionStart hook + the `[session-load]` budget check. Residual fix: the
   fallback doc's soft "may land slightly later" wording must become a
   deterministic manual-load fallback sequence (clarity F2), and sol's
   stricter bundle expectations (SHA/dirty-state, mission/lane state,
   handoff freshness, startup verdict) become the tool's v2 backlog.
3. **The composed pack's "self-contained, do not read other files" claim is
   false in fallback-relevant ways** (sol HIGH, clarity F3-adjacent): packs
   omit `instance/params.yaml` facts, active scope restrictions carried by
   `routed` decisions (HR-11570 parking), and the root report contract. Fix:
   include normalized instance facts + active-scope section in packs; decide
   the routed-row rule (clarity F3: only `pending` rows are interim-binding;
   binding force of `routed` rows lives in the routed doc — the routed doc
   must therefore actually carry the restriction).
4. **Capture honesty contradiction** (sol HIGH): `orchestrator-fallback.md`
   says the daemon mirror "keeps writing" while `instruction-layers.md` says
   it is planned and the checker SKIPs on the missing `inbox.jsonl`. The
   mirror code landed (640e7213) but is NOT live-deployed. Fix: a
   `capture.mode: manual|daemon` param in `instance/params.yaml`; the
   fallback doc and the checker derive from it; a binding "capture is live"
   claim with no inbox present must FAIL, not SKIP.

## Single-reviewer findings accepted into the fix list

- **Codex launched with `--dangerously-bypass-approvals-and-sandbox` by
  default** (terra BLOCKER; `orchestrator/launch.sh`, `daemon/server.ts`).
  Contradicts the fail-closed permission floor. Fix: explicit audited
  override + Codex permission-profile adapter. Tier A (permission surface).
- **`gate/review-policy.conf` does not cover `tools/instructions/`** (terra
  HIGH) — the checker/composer (evidence-gate logic) can land review-less
  while the prose policy calls it Tier A. Fix: add `tools/instructions/` (and
  `templates/`) to the conf. Note: today's `ag-item6-tail` was voluntarily
  independent-reviewed in anticipation of exactly this gap.
- **`--skip-review` is an unaudited bypass; ACCEPT parsing cannot prove
  independence** (terra HIGH). Fix: machine-validated review-record schema
  (SHA, session identity, provider, independence mode, deferred-cross-vendor
  status); break-glass requires durable authorization evidence.
- **`result: clean` is not decidable** (clarity F5, sol F10): define the
  exact conditions (SHA current, verify run at that SHA exit 0, review
  evidence exists, no unexplained dirty state, secret-scan evidence) in ONE
  binding doc included in every role baseline; `CLAUDE.md` references it.
- **No canonical secret-scan command** (clarity F6): name the exact command
  in the hygiene doc; absent scanner ⇒ `secret-scan: NO-GO`, never "clean by
  inspection".
- **Lifecycle-vs-autonomy conflict** (clarity F4/F7): state that the mission
  artifact IS the approval for a coder lane; Discussion→Approval applies
  before dispatch or on material scope change, not per-lane re-asks.
- **Switchover handoff has no schema/path/freshness gate** (sol HIGH, terra
  F1-adjacent): define `runtime/handoffs/<ts>-<from>-to-<to>.json` (schema
  tracked in git), `session-load` validates freshness.
- **`deferred-to-primary` underspecified** (sol MEDIUM, clarity F8): narrow
  to the verbatim-block finalization act only; add a durable queue state and
  resumption trigger; authority declared in `instance/params.yaml`, not by
  model brand in generic text.
- **Scaffolded repos can't resolve their L1 authority day one** (terra HIGH):
  scaffold must pin an L1 reference/bootstrap manifest; integration test = a
  fresh Codex session in a generated repo finds and validates its rules.
- **Sandboxed-lane capability contract** (terra MEDIUM): declare which steps
  need the trusted executor (network fetch, tmux/systemd, Docker) vs what a
  sandboxed lane may do; emit `NO-GO capability=<…>` instead of stalling.
- **Cold-start playbook gap** (sol HIGH): an `orchestrator-cold-start` doc
  with copy-pasteable commands for mission/dispatch/review/land/report on
  either harness.
- **Strict checker readiness gaps** (sol MEDIUM): mandatory-referenced-command
  existence check; effective-pack (not just tag-reachable) coverage for
  vendor-critical docs; required-transport SKIPs fail under `--strict`.

## What all three said already works (do not churn)

`AGENTS.md` symlink; deterministic Bun/TS tooling (compose/check/floor/
scaffold) usable by any vendor; snapshot materialization + manifest hashes;
unknown-tag fail-closed; the concrete landing gate; the hard floor and
false-green language; pack sizes fine for GPT models.

## Execution order (fix waves)

- **Wave 1 (quick, high-payoff):** packs.conf baseline fix (#1);
  fallback-doc corrections (deterministic manual-load, capture honesty via
  `capture.mode` param, routed-row rule, narrowed deferred-to-primary);
  `result: clean` definition + canonical secret-scan command; review-policy
  conf coverage of `tools/instructions/` (gate/ change ⇒ independent review).
- **Wave 2:** review-record schema + `--skip-review` hardening; handoff
  schema + session-load freshness; pack instance-facts/active-scope section;
  checker readiness checks.
- **Wave 3 (Tier A / decisions):** Codex launch permission profiles (remove
  dangerous default); scaffold L1 pinning + fresh-Codex integration test;
  cold-start doc; capability contract.

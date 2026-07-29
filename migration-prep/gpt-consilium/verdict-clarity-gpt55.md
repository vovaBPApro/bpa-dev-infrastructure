Reviewed SHA: `aac0ac993e77b530f53de3f3a12c843c91f02db9`  
Commands run: `bun tools/instructions/compose.ts --role coder`, `--role reviewer`, `--role orchestrator`, plus full source/instance reads.

**Findings**

1. **GPT fallback rules are not in the orchestrator baseline pack**  
Severity: BLOCKER  
Evidence: `instructions/orchestrator-fallback.md:13-27` defines mandatory GPT/fallback startup rules, but `instance/packs.conf:33-40` omits `orchestrator-fallback`; `bun tools/instructions/compose.ts --role orchestrator` output also omits it.  
Concrete change: add `orchestrator-fallback` to `[orchestrator]` and `[manager]` baselines, or add a root rule:  
“Any orchestrator session running outside Claude/Fable MUST load `instructions/orchestrator-fallback.md` before dispatch, landing, or reporting. This doc is part of the orchestrator baseline pack.”

2. **Fallback startup points to a non-existent tool with soft wording**  
Severity: HIGH  
Evidence: `instructions/orchestrator-fallback.md:21-24`: `run bun tools/instructions/session-load.ts (may land slightly later than this doc — reference it by path)`. The tool is not present.  
Concrete change:  
“First try: `bun tools/instructions/session-load.ts`. If that file does not exist or exits non-zero, do not stop. Manually read, before dispatch: `CLAUDE.md`, `instance/params.yaml`, every `instance/decisions/*.md` whose `state` is `pending`, and every binding doc with `audience: orchestrator` or `audience: all`. Record the exact files loaded in the mission rollup.”

3. **Decision-row delivery rules conflict between docs and composer**  
Severity: HIGH  
Evidence: `instructions/orchestrator-fallback.md:24-26` says load every open `pending`/`routed` row; `instructions/instruction-layers.md:79-80` says open `pending` rows are appended; `tools/instructions/compose.ts:317-328` includes only `state: pending`.  
Concrete change:  
“Only `state: pending` decision rows are interim-binding and pack-delivered. `state: routed` rows are provenance; their binding force lives in the routed doc named by `routes-to`.”

4. **Lifecycle approval rules conflict with autonomy rules for dispatched lanes**  
Severity: HIGH  
Evidence: `instructions/development-workflow.md:12-20` says every change starts with Discussion and no implementation without explicit Human approval; `instructions/autonomy-and-capacity.md:12-13` says execute approved, reviewed, dev-only work immediately.  
Concrete change:  
“An orchestrator-created mission with scope, acceptance rows, and risk tier is the approval artifact for a coder lane. `Discussion -> Plan -> Review -> Approval` applies before dispatch or when scope materially changes; a dispatched coder does not ask the Human again unless the irreversible set is reached.”

5. **Report contract can be satisfied in letter but still false-green**  
Severity: HIGH  
Evidence: `CLAUDE.md:24-30` and `CLAUDE.md:112-117` allow `result: clean|NO-GO|blocker` but do not define exact conditions for `clean`.  
Concrete change:  
“`result: clean` is allowed only when: the reported SHA is current, the verification command was actually run at that SHA and exited 0, required review/landing evidence exists, `git status --short` has no unexplained relevant changes, and secret scan evidence is present. Any skipped, partial, stale, timeout, or inferred evidence is `result: NO-GO`, with `blocker: <reason>`.”

6. **Secret scan is mandatory but no canonical command is named**  
Severity: HIGH  
Evidence: `CLAUDE.md:40-51`, `instructions/repository-hygiene.md:20`, `instructions/landing-and-merge.md:16`; no visible `secret`/`gitleaks`/scanner script found via `rg --files`.  
Concrete change:  
“Canonical secret scan command: `<exact repo command>`. If the command is absent, report `secret-scan: NO-GO scanner missing`; do not write `secret-scan: clean` from manual inspection.”

7. **“Approved, reviewed, dev-only work” is under-defined**  
Severity: MEDIUM  
Evidence: `instructions/autonomy-and-capacity.md:12`, `instructions/roles.md:72-74`. A GPT orchestrator may treat “reviewed” as requiring pre-review before implementation, or may over-execute without a mission artifact.  
Concrete change:  
“Eligible dev-only work means: a mission row exists, scope is bounded, risk tier is assigned, acceptance rows are testable, and the action is outside the irreversible set. ‘Reviewed’ means required plan/diff review for that phase, not a routine Human confirmation.”

8. **Fallback “primary model” finalization is too broad**  
Severity: MEDIUM  
Evidence: `instructions/orchestrator-fallback.md:48-54`: “Any step reserved to the primary (Fable-tier) model — the final pass over a Human verbatim artifact…”  
Concrete change:  
“Only finalization or pruning of a verbatim Human source block is reserved for the primary model. GPT fallback sessions may still preserve, quote, route, implement from, and report on Human requirements, but must not edit or finalize the verbatim block.”

9. **Pack-size guard exists but no operating threshold is declared**  
Severity: MEDIUM  
Evidence: `tools/instructions/compose.ts:71-75`, `tools/instructions/compose.ts:466-472`; baseline sizes observed: coder 354 lines, reviewer 315, orchestrator 335, manager 277.  
Concrete change:  
“Dispatch MUST run compose with `--assert-budget 600` for baseline packs and `--assert-budget 900` for tagged packs unless the mission record states a higher bounded limit and why. If exceeded, split tags or create a narrower mission.”

10. **UI approval can deadlock autonomy unless explicitly scoped**  
Severity: LOW  
Evidence: `instructions/design-first-ui.md:25-36` requires Human approval before frontend implementation; `CLAUDE.md:89-92` says ask almost never.  
Concrete change:  
“Frontend design approval is one of the required Human decisions for visible new UI or intended-look changes. It is not required for backend-only work or visual defect fixes that preserve the intended look.”

**What is already unambiguous and should not be touched**

The hard floor in `CLAUDE.md:37-42` is clear and model-portable. The L1/L2/L3 precedence rule in `instructions/instruction-layers.md:56-61` is strong. The trunk-only branching model in `instructions/branching-policy.md:22-44` is explicit. The false-green rejection language in `instructions/verification-and-locks.md:33-39` is direct and useful. The prompt-injection trust boundary in `instructions/prompt-injection-trust-model.md:14-22` is crisp. The composed baseline packs are not too long for GPT/SOL models today.

Verdict: the top three clarity fixes for SOL-mode quality are: put `orchestrator-fallback` into the orchestrator baseline pack, replace the missing `session-load.ts` soft reference with a deterministic manual-load fallback, and tighten the report contract so `clean` has decidable evidence requirements. Those three changes directly reduce the highest-risk GPT failure modes: starting without the fallback rules, stalling on a missing tool, and reporting false-green completion.

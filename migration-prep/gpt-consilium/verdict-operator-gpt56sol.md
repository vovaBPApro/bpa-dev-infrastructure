## Prioritized findings

1. **GPT fallback rules are not loaded into the orchestrator baseline — BLOCKER**

   **Evidence:** `instance/packs.conf:33-40` defines the orchestrator baseline but omits `orchestrator-fallback`. Running:

   ```sh
   bun tools/instructions/compose.ts --role orchestrator
   ```

   produced seven baseline documents and did not include `orchestrator-fallback`. The checker nevertheless reports:

   ```text
   PASS orchestrator-fallback.md [pack-coverage] reachable via a known tag
   ```

   A GPT orchestrator dropped into the repository does not know it should supply `--tags fallback` or even that fallback mode is special. This defeats the document intended specifically for cold GPT startup.

   **Concrete proposed change:** Add `orchestrator-fallback` to `[orchestrator]` in `instance/packs.conf`. Preferably introduce an explicit composition mode:

   ```sh
   bun tools/instructions/compose.ts --role orchestrator --runtime fallback
   ```

   Make `--runtime` mandatory for orchestrators, with `primary | fallback` values, and include the fallback document automatically for the latter. Extend `check.ts` so a vendor-critical document must be baseline-reachable in its applicable runtime, not merely tag-reachable.

2. **The mandatory GPT session loader does not exist, yet strict validation is green — BLOCKER**

   **Evidence:** `instructions/orchestrator-fallback.md:20-27` makes `bun tools/instructions/session-load.ts` the mandatory first step while explicitly admitting it “may land slightly later.” The file is absent:

   ```text
   MISSING tools/instructions/session-load.ts
   ```

   Yet:

   ```text
   bun tools/instructions/check.ts --strict
   summary: 0 FAIL, 0 WARN, 1 SKIP, 60 PASS
   ```

   Thus the stack declares itself valid while its mandatory cold-start command fails.

   **Concrete proposed change:** Implement `tools/instructions/session-load.ts` before treating fallback mode as ready. It should emit one machine-verifiable startup bundle containing:

   - exact repository SHA and dirty-state warning;
   - composed fallback orchestrator pack;
   - instance parameters;
   - open decisions;
   - durable mission/lane/lease status;
   - branches and worktrees;
   - unlanded reports;
   - latest vendor handoff;
   - explicit startup verdict.

   Add a strict check that every command/path named as mandatory in a binding document exists and has a smoke test. Until implementation, replace “MUST run” with an exact executable manual command sequence and report fallback startup as `NO-GO`.

3. **The supposedly self-contained orchestrator pack omits active installation constraints — HIGH**

   **Evidence:** `tools/instructions/compose.ts:367-369` tells the recipient:

   > “Do not go read other files … this snapshot IS the binding text”

   But the pack excludes `instance/params.yaml`, all routed decision rows, the root contract, and the fallback document. In particular, `instance/decisions/HR-11570.md:19-25` says only instruction work is authorized and migration/stack work remains parked. Because its state is `routed`, `compose.ts:317-339` excludes it, while the routed target `instruction-layers` does not preserve that active scope restriction.

   A cold GPT can therefore obey the composed pack and still dispatch prohibited work.

   **Concrete proposed change:** Make the pack genuinely self-contained:

   - include a normalized installation-facts section from `instance/params.yaml`;
   - include active scope/parking state from a dedicated durable workboard;
   - verify that every `routed` decision has a machine-checkable disposition in its target;
   - remove the “do not read other files” claim unless completeness is mechanically proven.

   Add a test using HR-11570-like data: changing a decision from `pending` to `routed` must not make an active restriction disappear.

4. **Human capture is described both as operational and as not implemented — HIGH**

   **Evidence:** `instructions/orchestrator-fallback.md:68-70` says the Telegram daemon and inbox mirror “keeps writing” and requires no special handling. But `instructions/instruction-layers.md:81-82` says the daemon mirror is “planned, not yet wired” and triage is manual. The strict checker confirms:

   ```text
   SKIP instance/decisions/inbox.jsonl [ledger] no inbox.jsonl (daemon mirror not live yet)
   ```

   This is exactly the sort of contradiction a GPT orchestrator may resolve optimistically and silently skip capture.

   **Concrete proposed change:** Correct `orchestrator-fallback.md` to state the current mechanism:

   ```text
   Until inbox mirroring is proven live, the incoming orchestrator must capture
   every Human directive manually before dispatch and verify it with the ledger
   checker. Missing inbox transport is a visible degraded-mode/NO-GO condition,
   not “no special handling.”
   ```

   Change strict checking so a binding claim that capture is live cannot coexist with a missing inbox. Put the implementation state in `instance/params.yaml`, for example `capture.mode: manual | daemon`, and derive both startup behavior and checks from it.

5. **The operational playbook names artifacts but does not tell a cold orchestrator where or how to create them — HIGH**

   **Evidence:** `instructions/orchestrator-playbook.md:15-30` requires an immutable mission record, dispatch, rollup updates, terminal evidence, landing, and watchdog recovery. It provides commands only for landing/watchdog. The “reports dir” in `orchestrator-fallback.md:61-62`, the handoff path, mission-artifact path, evidence destination, dispatch mechanism, and rollup format are undefined.

   The repository has `core/mission-cli.ts`, but `core/README.md:39-47` exposes only IDs and state transitions; it does not capture verbatim requirements, acceptance rows, tier, routing, evidence destination, or rollup owner demanded by the playbook.

   **Concrete proposed change:** Add `instructions/orchestrator-cold-start.md` as an orchestrator baseline document with copy-pasteable commands and canonical paths for:

   - inspecting/restoring state;
   - creating the complete mission artifact;
   - composing and materializing lane context;
   - creating a branch/worktree and dispatching in each supported harness;
   - receiving and validating the terminal report;
   - selecting and recording review;
   - landing and reaping;
   - writing the Human report.

   Extend the durable mission schema/CLI so required playbook fields are stored, rather than leaving the real mission record to an unspecified side artifact.

6. **Switchover handoff is mandatory but has no durable schema, location, or freshness gate — HIGH**

   **Evidence:** `instructions/orchestrator-fallback.md:58-64` requires a handoff “before and after every switch,” but “latest handoff” and “reports dir” have no defined path or machine-readable format. `restart-recovery.md:14-21` requires durable reconstruction but does not connect it to a handoff artifact.

   **Concrete proposed change:** Define a versioned file or generated record, for example:

   ```text
   runtime/handoffs/<timestamp>-<from>-to-<to>.json
   ```

   If runtime files are intentionally untracked, store their schema and generator in Git. Include source SHA, timestamp, vendor/session, mission IDs, lane/branch/worktree state, report paths, open decisions, deferred reviews, and unresolved `NO-GO` rows. Have `session-load.ts` validate freshness against durable events and refuse a clean startup verdict when the handoff is absent or stale.

7. **Review fallback is conceptually sound but not operationally dispatchable across GPT harnesses — MEDIUM**

   **Evidence:** `instructions/review-policy.md:41-49` and `orchestrator-fallback.md:38-46` require separate same-provider sessions and three domain passes. Neither document defines how a Codex/GPT orchestrator proves session independence, dispatches the passes without Claude’s `Agent` semantics, or stores their individual verdicts against one SHA.

   **Concrete proposed change:** Add a provider-neutral review record schema and dispatch contract. Require unique session/run identifiers, exact SHA, domain (`security`, `operations`, `regression`), commands, verdict, and deferred cross-vendor-review status. Provide a CLI that assembles the three records and fails unless all target the same SHA. Describe harness-specific launch adapters as implementation details, not assumed tools.

8. **“Deferred to primary/Fable” creates an underspecified permanent stall — MEDIUM**

   **Evidence:** `instructions/orchestrator-fallback.md:48-54` says a fallback model cannot perform a step “reserved to the primary (Fable-tier) model.” But `instructions/human-requirements.md:18-21` speaks only of a “designated final authority,” and `instance/params.yaml:40-42` explicitly has no model/vendor map. Nothing identifies which artifacts require Fable, who designates authority, or how deferred work is resumed.

   **Concrete proposed change:** Remove model-brand authority from the generic instruction. Add an explicit instance parameter or mission field such as:

   ```yaml
   finalization:
     authority: human
     model_restriction: none
   ```

   If some artifact truly requires a particular route, declare it per mission with a reason, durable queue state, and resumption command. GPT should preserve verbatim text exactly and defer only an explicitly identified finalization act—not infer that all Human-verbatim work is blocked.

9. **Strict validation checks reachability, not effective delivery or operational truth — MEDIUM**

   **Evidence:** `tools/instructions/check.ts:173-209` accepts any document having a known tag as “pack-covered.” It does not prove that a cold role knows to request that tag. It also permits one `SKIP` under `--strict`, yielding exit zero despite the missing capture inbox.

   **Concrete proposed change:** Split checks into:

   - schema reachability;
   - role/runtime effective-pack coverage;
   - mandatory referenced-command existence;
   - operational readiness.

   Under `--strict`, unresolved mandatory startup dependencies and required transport skips should fail. Add golden tests asserting that the GPT fallback pack contains fallback rules, instance facts, current scope, capture mode, review fallback, and landing/report contracts.

10. **The report contract is inconsistent across generated packs — LOW**

   **Evidence:** `CLAUDE.md:108-118` defines the exact final report shape, including `secret-scan` and `remaining`. The orchestrator composer does not include the root contract; `landing-and-merge.md:15` describes it only narratively. `compose.ts:376` additionally requires manifest echoing but does not specify how that fits the fixed report shape.

   **Concrete proposed change:** Put the canonical report schema in one binding document included in all role baselines. Make the completion guard validate role-specific extensions such as context-manifest consumption. Root `CLAUDE.md` should reference that schema rather than maintaining a second textual form.

## What already works well on a GPT model

- `AGENTS.md` is correctly symlinked to `CLAUDE.md`, so Codex discovers the same root contract instead of receiving a divergent provider fork.
- The root rules are direct, explicit, and generally model-portable. Role separation, fail-closed evidence, secret scanning, branch hygiene, and Ukrainian operator language are hard to misinterpret.
- The generated coder pack is strong: it supplies complete documents for lane lifecycle, verification, permissions, hygiene, isolation, feedback, routing, and branching.
- Full snapshot materialization and manifest hashes reduce dependence on model memory and filesystem exploration.
- Unknown tags fail closed, pending decisions are appended mechanically, and hard-floor drift is checked.
- Landing is unusually concrete: `gate/land.sh`, the completion guard, review-policy configuration, secret-range scan, canonical-tree verification, and cleanup behavior exist.
- Review tiering and the emergency same-provider consortium preserve independence better than simply allowing self-review when Anthropic quota is unavailable.
- Durable state, leases, fencing, watchdog/status commands, and restart principles are provider-neutral foundations.
- `bun tools/instructions/check.ts --strict` currently completes with `0 FAIL, 0 WARN`; the implementation is internally tidy even though its readiness criteria need strengthening.

## Verdict

The stack is **not fully GPT-ready today**. Its provider-neutral foundations and coder instructions are good, but a cold SOL orchestrator can miss the very fallback rules meant for it, cannot run the mandatory session loader, and can receive a “self-contained” pack that omits active scope and installation state. The top three improvements are: **(1)** make fallback mode an explicit effective orchestrator baseline, **(2)** implement and strictly gate a machine-readable `session-load.ts` cold-start bundle, and **(3)** make composition preserve active decisions, instance facts, capture state, handoff state, and operational artifact paths.

```text
commit: aac0ac993e77b530f53de3f3a12c843c91f02db9 [ORCH] land lane ag-fallback-doc
verify: bun tools/instructions/compose.ts --role orchestrator >/tmp/orchestrator-pack && bun tools/instructions/compose.ts --role coder >/tmp/coder-pack && bun tools/instructions/check.ts --strict
result: NO-GO — fallback rules are absent from the orchestrator baseline and the mandatory session loader is missing
secret-scan: clean — read-only review; no commit or tracked-file mutation was made
remaining: implement the three verdict priorities above; pre-existing untracked orchestrator/runtime/ was not modified
```

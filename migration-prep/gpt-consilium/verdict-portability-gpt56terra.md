## Prioritized findings

1. **Fallback session bootstrap is specified but missing** — **BLOCKER**  
   Evidence: [instructions/orchestrator-fallback.md](/home/bpa-shell/bpa-dev-infrastructure/instructions/orchestrator-fallback.md:20) mandates `bun tools/instructions/session-load.ts`; no such tracked file exists. The orchestrator baseline also omits `orchestrator-fallback` ([instance/packs.conf](/home/bpa-shell/bpa-dev-infrastructure/instance/packs.conf:33)).  
   Proposed change: implement `session-load.ts` as a read-only, provider-neutral loader that composes the correct role pack, reads open decisions and latest handoff, emits a manifest/hash, and fails closed. Invoke it from the provider launcher before opening either CLI; add it to the orchestrator baseline when fallback mode is selected.

2. **Codex is launched with all approvals and sandboxing bypassed** — **BLOCKER**  
   Evidence: [orchestrator/launch.sh](/home/bpa-shell/bpa-dev-infrastructure/orchestrator/launch.sh:95) and [daemon/server.ts](/home/bpa-shell/bpa-dev-infrastructure/daemon/server.ts:121) default to `--dangerously-bypass-approvals-and-sandbox`, contradicting the committed fail-closed permission policy ([instructions/tool-permissions.md](/home/bpa-shell/bpa-dev-infrastructure/instructions/tool-permissions.md:14)).  
   Proposed change: remove dangerous defaults. Make an explicit, audited emergency override require a durable operator decision and a scoped runtime profile. Add a Codex-specific permission adapter/preflight that maps the portable allow/approval/deny policy to the available harness controls.

3. **Landing gate permits an unaudited review bypass and cannot prove reviewer independence** — **HIGH**  
   Evidence: `--skip-review` directly marks a risky review as skipped ([gate/land-lib.sh](/home/bpa-shell/bpa-dev-infrastructure/gate/land-lib.sh:63)); an `ACCEPT` requires only a nonempty reviewer string not equal to the branch name ([gate/land-lib.sh](/home/bpa-shell/bpa-dev-infrastructure/gate/land-lib.sh:72)). This cannot enforce the same-provider emergency-consortium requirements in [instructions/review-policy.md](/home/bpa-shell/bpa-dev-infrastructure/instructions/review-policy.md:41).  
   Proposed change: delete public `--skip-review`, or require a signed/recorded emergency authorization. Define a machine-validated review schema containing reviewed SHA, reviewer session identity, provider, coder identity, independence mode, required domain passes, and deferred cross-vendor status.

4. **Risk routing and the executable gate disagree on what needs review** — **HIGH**  
   Evidence: Tier A includes “evidence-gate changes” ([instructions/review-policy.md](/home/bpa-shell/bpa-dev-infrastructure/instructions/review-policy.md:18)), but [gate/review-policy.conf](/home/bpa-shell/bpa-dev-infrastructure/gate/review-policy.conf:3) covers only `gate/`, `core/`, `daemon/`, `bootstrap/`, and `.github/`; it misses `tools/instructions/`, which contains the instruction/evidence checker.  
   Proposed change: make the policy declarative by risk class, with complete path coverage including instruction tooling, templates, runtime launchers, and permission-policy files. Test that every Tier-A surface invokes the review gate.

5. **Telegram state and restoration remain Claude-path dependent** — **HIGH**  
   Evidence: default state root is `~/.claude` ([daemon/server.ts](/home/bpa-shell/bpa-dev-infrastructure/daemon/server.ts:74)); orchestration state, lock, mission state, and reconnect restore all read `~/.claude` ([daemon/server.ts](/home/bpa-shell/bpa-dev-infrastructure/daemon/server.ts:100), [1804](/home/bpa-shell/bpa-dev-infrastructure/daemon/server.ts:1804), [2562](/home/bpa-shell/bpa-dev-infrastructure/daemon/server.ts:2562)).  
   Proposed change: move durable operational state to one provider-neutral configured state root, e.g. `BPA_STATE_DIR`, with provider-specific caches below it only when needed. Restore state through the durable mission/handoff record for both Claude and Codex, not through a Claude memory path.

6. **Newly scaffolded repos cannot resolve their claimed L1 authority day one** — **HIGH**  
   Evidence: template contracts direct agents to L1 `instructions/` ([templates/agent-repo/CLAUDE.md](/home/bpa-shell/bpa-dev-infrastructure/templates/agent-repo/CLAUDE.md:31)), but the scaffold only creates its local minimal `instructions/README.md` and a symlinked contract ([tools/instructions/scaffold.ts](/home/bpa-shell/bpa-dev-infrastructure/tools/instructions/scaffold.ts:217)). No pinned L1 source, bootstrap pack, or provider-neutral loader is installed.  
   Proposed change: scaffold a pinned L1 reference plus a bootstrap manifest, or vendor a minimal cross-vendor baseline. Add an integration test that starts a fresh Codex session in the generated repo and proves it can discover, load, and validate its governing instructions without host-global files.

7. **The operating instructions assume host privileges unavailable to sandboxed Codex lanes** — **MEDIUM**  
   Evidence: lanes are required to use isolated worktrees and Docker/runtime checks ([instructions/isolated-test-environments.md](/home/bpa-shell/bpa-dev-infrastructure/instructions/isolated-test-environments.md:14)), while landing always fetches from origin ([gate/land.sh](/home/bpa-shell/bpa-dev-infrastructure/gate/land.sh:107)); runtime launching requires `tmux` and `systemd-run` ([orchestrator/launch.sh](/home/bpa-shell/bpa-dev-infrastructure/orchestrator/launch.sh:150)).  
   Proposed change: add a capability preflight and lane-mode contract: sandboxed lanes may inspect/test locally, while a trusted landing/runtime executor owns network, Docker, worktree reaping, and service operations. Emit explicit `NO-GO capability=<…>` evidence rather than relying on interactive recovery.

## What already works well cross-vendor

- `AGENTS.md` is a symlink to the canonical contract, so Codex can load the same root rules without a divergent `CODEX.md` ([CLAUDE.md](/home/bpa-shell/bpa-dev-infrastructure/CLAUDE.md:59)).
- The instruction schema, composition, generated index, floor checking, decision ledger, and scaffold are deterministic Bun/TypeScript tooling rather than Claude-only hooks.
- The fallback document correctly identifies the major portability problems: no SessionStart hook, vendor-local memory, shared-vendor review limits, and durable handoff ([instructions/orchestrator-fallback.md](/home/bpa-shell/bpa-dev-infrastructure/instructions/orchestrator-fallback.md:18)).
- The daemon already has a real Codex turn-completion path and provider-aware relay logic ([daemon/reliability.ts](/home/bpa-shell/bpa-dev-infrastructure/daemon/reliability.ts:215)).
- The root contract’s evidence, secret-scan, scope, and fail-closed rules are model-neutral.

Verdict: **NO-GO** for maximal vendor neutrality until three structural changes land: (1) a real provider-neutral bootstrap/state-handoff mechanism, (2) permission/capability profiles that remove dangerous Codex defaults and distinguish sandboxed lanes from trusted executors, and (3) machine-verifiable review provenance with no unauthorised bypass. These changes turn the existing good policy into enforceable portability rather than Claude-oriented documentation plus Codex exceptions.

commit: `aac0ac993e77b530f53de3f3a12c843c91f02db9` `[ORCH] land lane ag-fallback-doc`  
verify: `bun tools/instructions/check.ts --repo . --strict`  
result: `NO-GO` — blockers above; instruction checker itself is clean (0 FAIL, 0 WARN).  
secret-scan: clean  
remaining: implement and test the three structural changes.

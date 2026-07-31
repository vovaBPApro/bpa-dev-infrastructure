# Independent review: ag-ci-dispatch-gate

reviewed-sha: 9e8b146c1ef910756d7425063cee75556816db14
reviewer: Codex reviewer lane (independent; did not author the branch)
independence: independent session from the coder; exact committed diff and evidence rerun
tier: A — CI dispatch evidence gate
verdict: ACCEPT

## Manifest consumption

- review-policy sha256:b95d6eb6d0e5 — Review Policy
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Scope and findings

Reviewed `origin/main...9e8b146c1ef910756d7425063cee75556816db14`: three files, 22 insertions and 2 deletions. Runtime changes only replace implicit `git rev-parse --short HEAD` with explicit `--short=8` in both composer and checker. The added regression test sets `core.abbrev=7` and requires an eight-character marker. No validation branch, refusal path, override path, or materialized-document check was relaxed.

No blocking findings. Rollback is the narrow revert of this commit; the pre-fix reproduction below demonstrates the expected six-failure regression if reverted under seven-character abbreviation.

## Evidence

Fresh shallow clone and exact reviewed state:

```sh
cd /root/.cache && rm -rf rev-repro
git clone --depth 1 file:///root/bpa-dev-infrastructure rev-repro
git -C rev-repro fetch --depth 1 file:///root/.cache/infra-lanes/ag-ci-dispatch-gate ag-ci-dispatch-gate
git -C rev-repro checkout --detach FETCH_HEAD
git -C rev-repro rev-parse HEAD
git -C rev-repro rev-parse --is-shallow-repository
cd rev-repro
bun test ./tools/instructions/compose.test.ts ./tools/instructions/dispatch-check.test.ts ./tools/instructions/dispatch-check-fullpack.test.ts
```

Result: SHA `9e8b146c1ef910756d7425063cee75556816db14`; shallow repository `true`; 53 pass, 0 fail, 154 expectations across 3 files.

Fail-before/pass-after lock, with the CI-triggering abbreviation setting:

```sh
git checkout --detach 239e17a688e189e82d6f79d216dbf8f07f58bb34
git config core.abbrev 7
bun test ./tools/instructions/compose.test.ts ./tools/instructions/dispatch-check.test.ts ./tools/instructions/dispatch-check-fullpack.test.ts
git checkout --detach 9e8b146c1ef910756d7425063cee75556816db14
git config core.abbrev 7
bun test ./tools/instructions/compose.test.ts ./tools/instructions/dispatch-check.test.ts ./tools/instructions/dispatch-check-fullpack.test.ts
```

Result: pre-fix exit 1 with exactly 46 pass and 6 fail; reviewed SHA exit 0 with 53 pass and 0 fail. The extra passing test is the new deterministic-eight-character regression lock.

Manual fail-closed probes used a genuine composer output, a marker-less existing file, a copy with a materialized-document body mutation, and a copy with marker SHA `deadbeef`:

```text
marker-less: exit 3, REFUSED — missing or invalid compose.ts pack marker
tampered:    exit 3, REFUSED — hash mismatch for materialized doc 'lane-lifecycle'
wrong-SHA:   exit 3, REFUSED — L1 SHA mismatch
genuine:     exit 0, OK (full pack valid)
```

Full working-tree run at the reviewed SHA:

```sh
cd /root/.cache/infra-lanes/ag-ci-dispatch-gate
git config core.abbrev 7
bun test ./tools/instructions/compose.test.ts ./tools/instructions/dispatch-check.test.ts ./tools/instructions/dispatch-check-fullpack.test.ts
```

Result: 53 pass, 0 fail, 154 expectations across 3 files.

## Verdict

ACCEPT. The change fixes composer/checker disagreement in shallow-clone CI without weakening the dispatch gate. All required negative cases still fail closed with exit 3, and both shallow-clone and working-tree suites are green at the exact reviewed SHA.

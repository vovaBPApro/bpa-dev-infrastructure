# W-18 Durable Triage Verdicts Review

verdict: ACCEPT
reviewed-sha: a4ad199e8a7bd4c8c66283003872f67a2d24e9f8
reviewer: Codex GPT-5 reviewer lane `ag-triage-durable`
independence: Independent reviewer session; no authorship of the reviewed coder commit.
tier: Tier A — repository hygiene, secrets, durable operating evidence, and evidence-gate behavior.

## Manifest consumption check

- review-policy sha256:b95d6eb6d0e5 # Review Policy
- verification-and-locks sha256:b13ed13070c1 # Verification and Regression Locks
- roles sha256:cd4c40c4e640 # Roles
- instruction-layers sha256:f9a51936be92 # Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd # Tool Permissions
- reproducible-from-git sha256:822d9efe694b # Reproducible From Git

## Scope and diff reviewed

Reviewed `origin/main...a4ad199e8a7bd4c8c66283003872f67a2d24e9f8` after rebasing the lane onto current `origin/main` (`741e6268`). Changed paths:

- `instance/decisions/.gitignore`
- `instance/decisions/triage.jsonl`
- `instructions/repository-hygiene.md`
- `tools/instructions/check.test.ts`
- `tools/instructions/ledger.test.ts`
- `tools/instructions/ledger.ts`

No scope breach found.

## Evidence and findings

- Durability: `git ls-files --error-unmatch instance/decisions/triage.jsonl` succeeds, and `.gitignore` now ignores only the raw `inbox.jsonl`. The regression tests prove valid chatter and directive verdicts suppress re-aging of already judged inbox rows.
- Secret hygiene: manually read all eight migrated JSONL rows. They contain only the six allowlisted structured fields. No quote, raw message text, link, or other verbatim Human words survived.
- Enforcement red proof: temporarily added a valid-looking row with an extra `text` field containing message-like words and ran `bun tools/instructions/check.ts`. It exited 1 with `FAIL instance/decisions/triage.jsonl:9 ... forbidden free-text field(s): text` and summary `1 FAIL, 0 WARN`. The temporary row was then removed.
- Enforcement green proof: after restoring the reviewed content, `bun tools/instructions/check.ts` exited 0 with `0 FAIL, 0 WARN, 1 SKIP, 70 PASS`.
- Open directive: msg 59 is present as `{"msg_id":59,"verdict":"directive","category":"product-input","reason":"open-follow-up",...}`. Its open status was neither flattened nor dropped.
- Tests: `bun test tools/instructions/ledger.test.ts tools/instructions/check.test.ts` passed: 42 pass, 0 fail, 103 expectations.
- Diff integrity: `git diff --check` passed.
- Rollback posture: a normal revert of the coder commit restores the former behavior without migration or external-state mutation. That rollback intentionally forfeits durable verdicts, so it is operationally safe but would reopen W-18.

## Commands run

```sh
git fetch origin
git rebase origin/main
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
git diff origin/main...HEAD
git ls-files --error-unmatch instance/decisions/triage.jsonl
git check-ignore -v instance/decisions/triage.jsonl
bun test tools/instructions/ledger.test.ts tools/instructions/check.test.ts
bun tools/instructions/check.ts # with temporary forbidden `text` field: exit 1, 1 FAIL / 0 WARN
bun tools/instructions/check.ts # restored reviewed content: exit 0, 0 FAIL / 0 WARN
git diff --check
git show a4ad199:instance/decisions/triage.jsonl
```

## Verdict

ACCEPT. The reviewed SHA makes triage verdicts rebuild-durable while mechanically excluding raw Human message text, retains msg 59 as an open directive, and preserves a clean instruction checker.

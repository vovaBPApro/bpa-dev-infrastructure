# Landing and Merge

## Binding rules

- Landing is serialized. Coder worktrees are evidence sources, not the canonical integration tree.
- A lane supplies a fixed terminal report with commit, runnable verification command, verdict, secret-scan result, and remaining work. Missing or contradictory evidence is `NO-GO`.
- Before merge, run the completion guard and a secret scan over the complete incoming commit range. Review risk according to `gate/review-policy.conf`; risky changes need independent review.
- Merge with the landing gate, not an ad-hoc Git command: `gate/land.sh` performs guard, range secret scan, no-fast-forward merge, optional canonical-tree verification, push, and cleanup fail-closed. Use `gate/land-batch.sh` only for a reviewed serialized batch.
- Re-run required verification from the canonical tree after merge. A worktree's green result cannot prove the merged tree is green.
- Preserve provenance: the landing record names source branch, source SHA, review disposition, merge SHA, commands, and evidence. Do not replace a failed gate with a narrative exception.
- If post-merge verification, push, or reaping fails, retain the evidence and report the exact gate verdict. Do not call the outcome clean until all required stages pass.
- Reap only a landed, accepted lane worktree and branch; unmerged or investigation-required refs are retained with evidence.

Why: one canonical, fail-closed sequence prevents unreviewed merges, secret leakage, and false-green worktree results.

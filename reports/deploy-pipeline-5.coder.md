# Deploy pipeline fifth attempt — coder evidence

The live sequence is encoded in `deploy/live-stand.sh`: migration diff and
conditional disposable-schema preflight precede detached release creation;
install/build and post-build permissions precede atomic activation; systemd
settling and a second delay precede exact-SHA health; failure restores and
health-checks the previous release. Protected auth, token-store, and preflight
boundaries remain refusal-only and were not modified.

Regression command: `bun test deploy/live-stand.test.ts`. The fixture breaks
each boundary: migration conflict, non-release build context, regenerated 0700
directories, premature activating-state probe, malformed health, missing
`build.commit`, wrong candidate identity, and rollback startup delay. It proves
refusal before release creation or a healthy exact-SHA rollback.

Full verification command: `bun test`.

## Pack consumption

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:fc36fafe4623 — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

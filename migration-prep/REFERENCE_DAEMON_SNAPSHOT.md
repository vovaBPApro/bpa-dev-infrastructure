# Stable daemon reference snapshot

This is a read-only acquisition record for the migration. No source from the
reference repository is wired into the new runtime by this artifact, and no
package manifest or lockfile is changed.

## Provenance

- Repository: `git@github.com:vovaBPApro/telegram-dev-daemon.git`
- Reference ref: `main`
- Pinned source SHA: `4cdf3c70c6ec9d28608d7921b4dd4dd31ce340aa`
- Acquired: 2026-07-28 (UTC), shallow clone over SSH
- Purpose: compatibility inventory and parity source for the Bun/TypeScript
  daemon migration.

## Required reference surface

The following paths are the minimum stable surface to inventory before any
implementation or cutover:

```text
AGENTS.md
CLAUDE.md
docs/orchestrator_policy.md
docs/roles.md
docs/review_policy.md
docs/development_workflow.md
docs/ops/permissions_policy.md
docs/ops/auto_approve.example.json
scripts/dispatch-agent.sh
scripts/merge-shards.sh
scripts/orchestrator-turnend-relay.sh
scripts/prune-merged-branches.sh
templates/daemon/server.ts
templates/daemon/server.test.ts
templates/daemon/relay.ts
templates/daemon/relay.test.ts
templates/daemon/reliability.ts
templates/daemon/package.json
templates/daemon/bun.lock
templates/daemon/launch-orchestrator.sh
templates/daemon/run-daemon.sh.tmpl
templates/launchd/pro.bpa.claude-session-SLUG.plist.tmpl
tools/claude-telegram-daemon/orchestrator-watchdog.sh
tools/claude-telegram-daemon/ctl.sh
tools/claude-telegram-daemon/package.json
tools/claude-telegram-daemon/bun.lock
```

## Deterministic verification

From a clean checkout, verify the exact source and required paths without
modifying this repository:

```bash
tmp="$(mktemp -d)"
git clone --depth 1 --branch main git@github.com:vovaBPApro/telegram-dev-daemon.git "$tmp/ref"
test "$(git -C "$tmp/ref" rev-parse HEAD)" = 4cdf3c70c6ec9d28608d7921b4dd4dd31ce340aa
git -C "$tmp/ref" ls-tree -r --name-only HEAD | grep -Fx 'templates/daemon/server.ts'
git -C "$tmp/ref" ls-tree -r --name-only HEAD | grep -Fx 'tools/claude-telegram-daemon/orchestrator-watchdog.sh'
rm -rf "$tmp"
```

Any SHA or required-path mismatch is `NO-GO`; do not substitute a moving tip.

# Instruction artifact review — a0fee4da

Verdict: **ACCEPT for pinned artifact fidelity; NO-GO for deployment/migration**.

## Verified

- Imported files that exist in the pinned remote were byte-identical by SHA-256
  comparison against a fresh clone at `4cdf3c70c6ec9d28608d7921b4dd4dd31ce340aa`.
- `bash -n` passes for imported watchdog/relay shell scripts.
- Artifacts remain under `migration-prep/reference-daemon` and are explicitly
  documented as read-only; no runtime wiring or dependency mutation is hidden.

## Omissions / deployment blockers

- These artifacts are not installed into the new runtime and their shell tests
  assume an already-installed `$HOME/.claude` layout and Bun.
- The imported watchdog plist is macOS launchd-specific with absolute
  `/Users/...` paths; it is not an Ubuntu service definition.
- No Linux systemd/VM bootstrap, Telegram/MCP integration, Docker evidence,
  or replay comparison was added. Running the copied turn-end scripts alone
  cannot prove daemon parity.

Therefore the snapshot is faithful reference material, but HR-02/04/15/18 and
the Docker/parity Go gates remain open.

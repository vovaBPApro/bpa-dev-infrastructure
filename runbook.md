# P0 runbook

1. Create a disposable stand and record source SHA, remote, image and UTC time.
2. Start the old control plane and the new sidecar in shadow (read-only) mode.
3. Replay three synthetic missions; compare active, blocked and terminal state.
4. Inject restart, reconnect, duplicate message and expired-lease scenarios.
5. Promote exactly one manager to canary only after all no-go checks remain clear.
6. Roll back to the old daemon on any unexplained projection or side-effect diff.

The first implementation target is persistence and replay; product workers are
out of scope.

## Clean Ubuntu / friend installation

Run the bootstrap in dry-run first. Confirm host resources, package signatures,
service user, firewall/TLS assumptions and redacted diagnostics. Pair Telegram
only after local synthetic replay passes. Export the manifest and rollback
instructions before enabling dispatch. For a friend install, use a versioned
bundle, local-only mode, explicit pairing and the documented uninstall path.

Never paste secrets into issue reports or Telegram. If initialization, pairing,
reconnect, disk quota or rollback fails, keep dispatch disabled and preserve the
diagnostics for review.

# Telegram-transited credential rotation runbook

Status: prepared only. **Do not execute this runbook without the operator at the
console.** No credential was rotated while preparing it.

This inventory is intentionally value-free. Do not paste a value into a shell
argument, terminal transcript, issue, commit, or chat. Enter replacement values
directly into a mode-`0600` staging file at the console.

## Inventory and exposure window

The durable W-19 record and its creating commit establish that all four entries
below transited Telegram during the live integration setup on 2026-07-31. The
exact Telegram message timestamps are no longer recoverable: the operator asked
for the mirrored messages to be purged, and the raw inbox is absent. Do not
invent more precise times from file metadata.

| credential | current use/location | blast radius if abused |
| --- | --- | --- |
| Intuit QuickBooks OAuth application client ID and client secret (one credential pair) | Host handoff: `/root/.config/bpa/oauth/qbo.env`; application copy: `/etc/agentic-bpa/app.env`; used to start and complete QuickBooks OAuth for the production company connection | An attacker can impersonate the OAuth application, solicit grants, and attack callback flows. With a valid grant they can access the connected company's accounting data within the app's scopes. The client ID is an identifier, but the pair must be replaced because both travelled together. |
| Google OAuth client secret | Host handoff: `/root/.config/bpa/oauth/google.env`; application copy: `/etc/agentic-bpa/app.env`; used by the Gmail/Drive OAuth callback flow | An attacker can impersonate the OAuth client and attack authorization-code exchange. Existing user grants may remain usable until separately revoked; exposure reaches Gmail/Drive data allowed by the configured scopes. |
| GCP service-account JSON key A | Superseded bootstrap identity formerly staged as `/root/.config/bpa/gcp-sa-bpa-automations.json`; that path is absent now | Anyone holding the private key can act as that service account until the key is disabled/deleted, reaching every GCP and Workspace resource granted to the identity. Local absence does not revoke the provider-side key. |
| GCP service-account JSON key B | Current host handoff: `/root/.config/bpa/oauth/gcp-sa-bpapro-agents.json`; used for BPA agent Google automation/debug access | Anyone holding the private key can act as that service account until the key is disabled/deleted, reaching every GCP and Workspace resource granted to the identity. |

Before rotation, identify keys A and B in Google Cloud by service-account name,
key creation time, and key ID shown by the console. Record those identifiers in
operator-local notes only. If the console cannot distinguish both exposed keys,
stop: deleting an assumed key is not an acceptable substitute.

## Preconditions and value-free backup

1. Schedule an operator-attended maintenance window and stop new OAuth connects
   and imports. Do not stop existing services yet.
2. In Intuit and Google Cloud, confirm the application/service-account names,
   owners, scopes/roles, redirect URIs, and currently active keys. Do not copy
   secret values into the notes.
3. Make an encrypted, operator-controlled backup of the three current local
   credential files and `/etc/agentic-bpa/app.env`. Record only the backup
   location and checksum in operator-local evidence, not in Git.
4. Confirm the local targets are regular, non-symlink files with the expected
   owners and mode `0600`. Keep replacement files on the same filesystem so the
   final rename is atomic.
5. Establish a live smoke baseline: application health, QuickBooks connect and
   one read-only import/reconciliation check, Google OAuth connect, one Gmail
   read, and one Drive read. A failing baseline is `NO-GO` for rotation.

## Intuit QuickBooks OAuth application pair

Intuit normally rotates the client secret, while the client ID identifies the
app. Because both travelled through Telegram, use a replacement Intuit app if
the client ID itself must change; otherwise explicitly record the operator's
decision that the non-secret ID remains and rotate the secret.

1. Open the Intuit Developer dashboard, select the production OAuth app by
   name, and compare its redirect URI and scopes with the running application.
2. Choose one provider-supported path: create a replacement production app for
   a new client ID/secret pair, or generate a new client secret for the existing
   app. Keep the old credential active during the verification overlap where
   Intuit permits it.
3. At the console, write the replacement pair to a new mode-`0600` sibling of
   `/root/.config/bpa/oauth/qbo.env`; validate required variable names without
   printing values; atomically replace the file.
4. Update the QuickBooks fields in `/etc/agentic-bpa/app.env` through the same
   restricted staging-and-rename procedure, then restart only the application
   unit that consumes it.
5. Verify health, initiate a fresh QuickBooks OAuth flow, complete the callback,
   run a read-only transaction import, and confirm the expected production
   company plus one-to-one reconciliation smoke check. Inspect service logs for
   auth failures using status codes only, never request bodies or environment.
6. If verification fails before old-credential revocation, atomically restore
   the encrypted backup files, restart the consumer, and repeat the baseline.
   If the old credential has already been revoked, rollback is unavailable:
   keep imports stopped and repair the new app configuration.
7. Only after green verification, revoke/delete the exposed Intuit secret and,
   when a replacement app was used, retire the exposed app. Re-run the smoke
   checks after revocation so success cannot be coming from the old credential.

## Google OAuth client secret

1. Open Google Cloud Console for the recorded OAuth application and confirm its
   application name, consent screen, redirect URIs, and Gmail/Drive scopes.
2. Create a new client secret on the same OAuth client if Google permits an
   overlap. Do not delete the exposed secret yet.
3. Write the replacement to a restricted sibling of
   `/root/.config/bpa/oauth/google.env`, validate names without printing values,
   and atomically replace it. Update only the corresponding Google fields in
   `/etc/agentic-bpa/app.env` and restart the consuming application unit.
4. Verify health, a fresh Google authorization and callback, one Gmail read, one
   Drive read, and the application connection-status route. Existing tokens are
   not proof that the new client secret completed a fresh code exchange.
5. On failure before revocation, restore the encrypted backup files and restart
   the consumer. On success, delete the exposed client secret in Google Cloud,
   then repeat a fresh authorization-code exchange and both read checks.
6. If there is evidence that user grants or refresh tokens also transited the
   channel, stop and add them to this inventory; revoke affected grants and
   reconnect. This runbook currently has no evidence that they did.

## GCP service-account JSON keys A and B

Perform the following sequence separately for each provider-side key. Never
assume that replacing key B also revokes key A.

1. In IAM & Admin, open the named service account and enumerate its keys by key
   ID and creation time. Confirm which entry is A or B without downloading the
   old key.
2. Review the service account's IAM roles and Workspace/Shared Drive grants;
   remove unnecessary access before creating the replacement.
3. Create one new user-managed key. Download it directly to an operator-local
   restricted staging file; do not transport it through Telegram or chat.
4. For the currently used identity, validate JSON structure without echoing
   fields and atomically install it at
   `/root/.config/bpa/oauth/gcp-sa-bpapro-agents.json` with `root:root` ownership
   and mode `0600`. Update any consumer path reference only if the path changes,
   then restart that consumer.
5. Verify a token can be obtained and perform the smallest read-only Google API
   and Shared Drive checks required by the current role. Verify denial for a
   representative resource outside that role's intended scope.
6. Before deletion, rollback is the encrypted restoration of the prior local
   file followed by a consumer restart and the same read checks. After deletion,
   the provider-side key cannot be restored; keep the new key and repair IAM or
   consumer configuration instead.
7. Delete the exposed provider-side key, then repeat token acquisition and the
   read/denial checks. For key A, which has no current local file, delete the
   exposed provider-side key after confirming no consumer uses its key ID; do
   not create or retain a replacement unless the identity still has a justified
   consumer.

## Containment verification performed on 2026-07-31 — NO-GO

The preparation check was non-printing and value-aware where a canonical local
copy exists:

- Git: the canonical signature pattern was extracted at run time from
  `gate/land-lib.sh` and applied to `git log -p --all --full-history`. That broad
  scan reports historical test fixtures and imported legacy private-key proofs,
  so it is not clean as a whole. Exact-value checks of the current QuickBooks
  secret, Google OAuth secret, and current service-account key ID found no match
  in this repository's refs. The final branch diff is scanned again before
  commit with the canonical landing command.
- Disk mirrors: `/root`, `/srv`, and `/etc` were searched without emitting
  matching content. Telegram raw inbox, daemon mission log, Claude history,
  session transcripts, repo worktrees, caches, and backups were included.
  Exact-value searches derived in-process from the canonical credential files
  found both the current QuickBooks client secret and Google OAuth client secret
  in `/root/.claude/projects/-root-bpa-dev-infrastructure/f91387e0-b59a-41b4-bb81-bbdb606e03c9.jsonl`.
  This undeclared cleartext survivor is the concrete `NO-GO` blocker. It was not
  deleted during this prepare-only lane.
- Metadata: the current three handoff files are regular `root:root` mode-`0600`
  files. The superseded key-A path and ignored raw decision inbox are absent.

Containment is therefore not proven. The declared current handoff and
application files intentionally contain cleartext needed by their consumers;
therefore the literal claim "none survives anywhere on disk in cleartext" is
not true until those consumers use an encrypted secret store. Any undeclared
exact-value match is a blocker and must be removed with bounded, audited cleanup
before rotation. After cleanup, repeat the same exact-value scan over the whole
host. Telegram's copy is outside this host and is why all four credentials
remain rotation candidates even after local containment.

## Closeout

After all four exposed provider-side credentials are revoked, repeat every
post-revocation smoke check, inspect value-free audit events, and update W-19
with provider key/app names, revocation times, commands, and results only. Never
record credential values or hashes derived from low-entropy values. Destroy the
encrypted rollback backup after the operator accepts the result and its
retention requirement ends.

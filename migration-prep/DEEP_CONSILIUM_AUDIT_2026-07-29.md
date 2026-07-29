# Deep Adversarial Consilium — bpa-dev-infrastructure control-plane audit

Date: 2026-07-29 · Requested by Vova (msg 11609: «підніми консиліум на кодексах,
зроби все максімально ретельно»). Four independent Codex auditors (gpt-5.6 terra/sol)
ran read-only against the real repo + throwaway clones, each on a distinct lens.
This doc is the synthesis + disposition. Verdicts archived under
`migration-prep/deep-consilium/verdict-{redteam,e2e,tests,daemon}.md` (raw).

## What is genuinely PROVEN (not fake)

- **The control-plane loop works end-to-end.** The e2e auditor drove the full
  lifecycle by hand in a throwaway clone with a fake bare origin: compose pack →
  dispatch-check → coder commit → review artifact → `land.sh --run-verify` →
  landed + pushed + branch reaped + post-merge check green. All **five** failure
  paths correctly ABORTED without advancing main: stale reviewed-sha, missing
  artifact, `result: NO-GO`, bad commit SHA, secret-in-diff. Verdict: YES.
- **Core test locks survive mutation.** The test-quality auditor inverted the
  source of the three highest-value locks in throwaway copies — status 0-count,
  dispatch-check refusal, gate reviewed-sha match — and each corresponding test
  went red. No `expect(true).toBe(true)` tautologies found.
- **Inbox mirror is safe.** Append-only (`appendFileSync`), JSONL-injection-proof
  (newline/CRLF/quote/fake-row payloads round-trip only inside `text`, ids stay
  sequential), never blocks message delivery on write failure, and the serializer
  whitelists only `msg_id/chat_id/ts/text` so the Telegram token is never persisted.
  `capture.mode: manual` ⇒ honestly not yet live.

## Real holes found → disposition

Severity as labeled by the auditors. NOTE on threat model: this is a
single-operator trusted control plane; these gates are guardrails against an
over-eager/sloppy agent self-certifying, not against an external attacker. But
holes 1–3 defeat exactly the review gate's *purpose* (Rule 18: stop
self-certification), so they are fixed regardless.

### Lane A — gate hardening (`ag-gate-hardening`)
| # | Sev | Hole | Fix |
|---|-----|------|-----|
| A1 | CRITICAL | Self-authored review lands: gate checks only `reviewer != branch`, so `reviewer: Author` on branch `ag-self` passed. | Reject when reviewer identity == commit author (`%an <%ae>`). |
| A2 | HIGH | `--skip-review '   '` (whitespace reason) landed with review=skipped. | Require reason non-empty after stripping whitespace, in land.sh + land-batch.sh. |
| A3 | HIGH | Review artifact as a symlink accepted. | Reject non-regular / symlinked artifact. |
| A4 | HIGH | Secret-shaped **filename** landed (scan only checks blob content). | Scan changed path names too. |
| A5 | HIGH | Unicode look-alike reviewer dodged the author/branch compare. | Reject non-ASCII/control chars in provenance fields. |

### Lane B — dispatch hardening (`ag-dispatch-hardening`)
| # | Sev | Hole | Fix |
|---|-----|------|-----|
| B1 | CRITICAL | Forged marker `<!-- compose.ts pack v1 forged -->` passes dispatch-check (substring match, not grammar). | Validate full anchored marker grammar (role=<known> + l1=<hex>). |
| B2 | CRITICAL | `ORCH_DISPATCH_CHECK=/tmp/always-ok.ts` swaps the checker → unmarked prompt dispatched. | Remove/allowlist prod override behind explicit test-only guard. |
| B3 | HIGH | `ORCH_OPS_JOURNAL=/dev/null` break-glass override left no audit trail, exit 0. | Refuse override unless journal is a durable regular file and append verified. |

### Lane C — /status honesty (`ag-status-honesty`) — Vova's #1 complaint
| # | Sev | Hole | Fix |
|---|-----|------|-----|
| C1 | HIGH | `/status` counts **lane worktrees**, but agents run from the main checkout (`codex exec -C repo`), so it printed `agents_active: 0 (verified)` while 4+ codex agents ran. This is the original "0 coders while 3 ran" complaint, reincarnated. | Relabel to `lane_worktrees`; add `running_agents` by process, or `unknown` — never a fabricated 0. |
| C2 | HIGH | Synchronous git with no timeout can hang the daemon event loop. | Hard deadline on every git call; timeout ⇒ `unknown (git timeout)`. |
| C3 | MED | Stale legacy state fields (plan/providers/quota/mission) presented as current; missing keys fabricated as 0. | Freshness stamp + `unknown` for missing keys; probe `instance` PID liveness. |

### Deferred to workboard (MEDIUM/LOW — documented, not blocking)
- Base64 / split-string secret forms evade the signature grep (residual scanner
  limit; needs entropy/decoding detector) → workboard.
- `handoff.ts write` accepts a future timestamp though `validate` rejects it →
  workboard (policy decision + test).
- batch `--skip-review` had no test (Lane A adds one) ✓.
- CRLF-in-fields accepted (LOW) → Lane A fixes if trivial.
- Several `/status` fields still process-local / cache-derived (last_relay,
  buffered_msgs) — relabel as observations → workboard.

## Bottom line
The loop is real and its happy+failure paths are proven. The audit did its job:
it found that the guardrails were optimistic in five+ places and that the
`/status` fix did not actually fix Vova's complaint. Lanes A/B/C fix the
CRITICAL/HIGH set with fail-before/pass-after locks; the rest is tracked.

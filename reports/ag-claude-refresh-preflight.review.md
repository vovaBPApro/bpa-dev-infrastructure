# Independent review: Claude OAuth refresh-aware preflight

reviewed-sha: 75411d9c517250975e1b56bec9bdc5859135b154
base-sha: 3d0e827c9f973d43ffdb0e8ca2fe8c5525c56345
reviewer: Claude reviewer lane `/root/.cache/infra-lanes/review-claude-refresh-preflight` (cross-vendor, Claude session)
independence: reviewer did not author the reviewed commit; review-only lane, candidate code unmodified
tier: Tier A — authentication boundary in the launch preflight (fail-closed auth gate)
verdict: ACCEPT

Human requirement, verbatim: «Виправ плз». Live incident: launcher rejected an
expired access token before Claude CLI could use a still-valid refresh
credential; a direct Claude invocation refreshed successfully.

## Manifest consumption check

- review-policy sha256:6537ef28ad14 (baseline) # Review Policy
- verification-and-locks sha256:07e760358365 (baseline) # Verification and Regression Locks
- roles sha256:cd4c40c4e640 (baseline) # Roles
- instruction-layers sha256:cd21f4ce0990 (baseline) # Instruction Layers
- tool-permissions sha256:955630cc416e (baseline) # Tool Permissions
- reproducible-from-git sha256:822d9efe694b (baseline) # Reproducible From Git

## Scope

```sh
git diff 3d0e827c..75411d9c --name-only
# orchestrator/preflight-auth.test.sh
# orchestrator/preflight-cli-auth.sh
```

Two files, both in the assigned auth-preflight surface. No other paths touched.
Working tree at review time: clean, HEAD == reviewed SHA.

## What the change does

The Claude credential check in `preflight-cli-auth.sh` previously refused any
record whose `expiresAt <= Date.now()`. It now distinguishes three states:

1. current access token (`expiresAt > now`) → pass, unchanged;
2. expired access token WITH a structurally complete, unexpired refresh
   credential (`refreshToken` non-empty string, `refreshTokenExpiresAt` finite
   number `> now`) → pass, because the Claude CLI exchanges the refresh
   credential automatically on startup — this is the live-incident fix;
3. everything else → refuse (exit 3 for structural incompleteness, exit 4 →
   launcher-visible exit 1 with the loud `ERROR claude-auth-expired`
   classification when the refresh credential is itself expired).

The script's external exit-code contract (0/1/2) is unchanged; verdict 4 is
internal and maps to exit 1. `launch.sh:474-477` treats any nonzero preflight
exit as a refusal, so no caller contract changed.

## Commands run and results

All at reviewed SHA `75411d9c` in this lane worktree.

```sh
bash -n orchestrator/preflight-cli-auth.sh        # OK
bash -n orchestrator/preflight-auth.test.sh       # OK
shellcheck orchestrator/preflight-cli-auth.sh orchestrator/preflight-auth.test.sh
                                                  # clean, no findings
bash orchestrator/preflight-auth.test.sh          # preflight auth tests: PASS, exit 0
```

### Fail-before proof (named regression lock)

Candidate test suite run against the BASE (pre-fix) script:

```sh
git show 3d0e827c:orchestrator/preflight-cli-auth.sh > /tmp/review-failbefore/preflight-cli-auth.sh
git show 75411d9c:orchestrator/preflight-auth.test.sh > /tmp/review-failbefore/preflight-auth.test.sh
bash /tmp/review-failbefore/preflight-auth.test.sh
# FAIL: regression access-expired-refresh-valid: recoverable Claude OAuth was
#       refused before CLI auto-refresh
# exit=1
```

Red at base on exactly the new named regression, green at the candidate. The
lock locks the incident, not a tautology.

### Adversarial fixtures (reviewer-authored, beyond the committed tests)

Each run: `env -i ... ORCH_CLAUDE_CRED_FILE=<fixture> bash preflight-cli-auth.sh claude`,
output swept for the fixture access/refresh token strings.

| fixture | exit | expected |
|---|---|---|
| refreshToken wrong type (number), access expired | 1 | refuse ✓ |
| refreshToken null, access expired | 1 | refuse ✓ |
| refreshToken empty string, access expired | 1 | refuse ✓ |
| refreshTokenExpiresAt as string `"4102444800000"` | 1 | refuse ✓ |
| refreshTokenExpiresAt `1e999` (parses to Infinity) | 1 | refuse ✓ |
| expiresAt `1e999` (parses to Infinity) | 1 | refuse ✓ |
| refreshTokenExpiresAt negative (expired refresh) | 1 | refuse ✓ |
| claudeAiOauth is an array | 1 | refuse ✓ |
| current access + garbage refresh fields | 0 | pass ✓ (refresh only consulted after access expiry) |
| expired access + valid refresh + unknown extra fields | 0 | pass ✓ (unknown fields ignored, fail-closed core intact) |

No token material appeared in any output.

### Real JSON boundary check (fixtures are not a weaker mock)

Keys-only, types-only inspection of the live launcher input
`~/.claude/.credentials.json` on this host (no values read out):

```text
accessToken: string len=108
refreshToken: string len=108
expiresAt: number finite=true inFuture=true
refreshTokenExpiresAt: number finite=true inFuture=true
scopes: array
subscriptionType: string len=3
rateLimitTier: string len=22
```

The real CLI record carries every field the fix depends on, with the exact
types the check requires. The test fixtures mirror this schema through the
same file-on-disk + Bun-parse boundary the launcher uses — not a weaker mock.
If a future CLI version drops `refreshTokenExpiresAt`, the gate refuses
(exit 3) rather than false-greening.

### Clock boundary and unknown schema

- Strict `>` comparisons: `expiresAt === now` counts as expired and falls
  through to the refresh check; `refreshTokenExpiresAt === now` counts as
  expired and refuses. Both boundaries resolve in the fail-closed direction.
- No skew margin is applied; a token expiring milliseconds after preflight
  passes could be expired at CLI start — but the CLI then refreshes it, which
  is precisely the recoverable path this change encodes. Not a defect.
- Unknown-schema behavior unchanged: missing `claudeAiOauth`, wrong shapes,
  empty access token, malformed JSON, missing parser all still refuse
  (exercised by the committed suite at the reviewed SHA).

### Bans and leak surface unchanged

The committed suite (run at the reviewed SHA) still exercises every
API-key/cloud-routing ban (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS,
CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, AWS_BEARER_TOKEN_BEDROCK) for
both providers, the embedded-key refusal, the no-parser refusal, and the
ALL_OUTPUT credential-leak sweep — now including the new refresh-token fixture
string. The Bun check script prints nothing; refusal messages carry paths and
variable names only.

### Canonical secret scan

```sh
pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY")
git diff 3d0e827c...75411d9c | LC_ALL=C grep -aE "$pat"
# no output
```

secret-scan: clean

## Findings

Blocking: none.

Observations (non-blocking):

1. The mission asked for the report under `orchestrator/runtime/reports/`, but
   that path is gitignored (`.gitignore:8`) — a report there cannot be a
   committed, durable artifact. This tracked file at `reports/` follows the
   repository's existing review-record convention; a courtesy copy was placed
   at the runtime path for any live pickup.
2. The verdict-4 refusal message ("re-authenticate") remains accurate: after
   this change it is reachable only when the refresh credential is itself
   expired or the record is structurally complete but stale, where interactive
   re-login is indeed the only recovery.

## Verdict and next action

ACCEPT. The recoverable case (expired access + live refresh) now reaches the
CLI; every degraded refresh record stays fail-closed; the ban and leak
surfaces are intact; the regression lock is proven red-before/green-after.

Next action: orchestrator lands `75411d9c` through `gate/land.sh` and reaps
the lane. Not landed or pushed by this reviewer.

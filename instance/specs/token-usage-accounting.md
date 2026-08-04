# Spec — token and cost accounting per model and per role

Written at the operator's request (Telegram 2396: *"можеш описати це як слід, і в якийсь
спрінт це реалізуємо"*). Implements ruling **HR-2377**; the workboard row is **V3-3.10**.

## Context and goal

Every cost argument on this system is currently made from impressions. Whether HR-2166's
escalated review tier earns its price, whether simple work belongs on a cheaper model,
what a lane-hour actually costs (HR-1494) — none is answerable today, because nothing
records consumption.

**Goal:** persist input and output token counts, and cost, for every model invocation,
attributed to the **model** and the **role** that spent it, so the operator can graph
consumption over time and settle those arguments with data.

**System stage:** the orchestrator runs lanes as systemd units invoking the Claude CLI.
There is no product repo yet, so this is L1 infrastructure work.

**Scope boundaries.** In scope: capture, storage, and a query path. Out of scope: the
rendering of graphs, quota-percentage scraping (see "Why not quota" below), and any
provider other than the Claude CLI until a second one is actually in use.

## Breaking changes

**Yes — one, and it is the main implementation risk.**

Lanes currently run `claude --print …` emitting plain text, which is piped through
`daemon/mask-stream.ts` into the lane log. Usage data requires `--output-format json` or
`stream-json`, which changes that stream. A naive switch **breaks the lane log and the
masker**, and the log is the operator's main window into a running lane.

Affected: `instance/lane-agent-command*.conf` (the argv files), `orchestrator/fleet/
lane-payload.sh` (the pipeline), `daemon/mask-stream.ts` (the consumer).

Required action: keep the human-readable stream intact. Two viable shapes, and the
implementer must choose with evidence:

- **(a) `--output-format stream-json`** — the CLI emits events including a terminal result
  event carrying `usage`. The masker learns to render text events to the log and divert
  the result event to the accounting sink. One process, one stream, no second invocation.
- **(b) Side-channel** — keep the text stream untouched and have the lane write its usage
  block to a separate file that the orchestrator ingests on lane exit. Simpler, but a lane
  that dies mid-turn records nothing, which is exactly the case worth measuring.

Rollback posture: the accounting sink is additive. If capture fails, the lane must still
run and still log; **a failure to record consumption is never allowed to fail a lane.**

## Interfaces first

### Source data — verified, not assumed

`claude --print --output-format json` returns, confirmed by direct execution on this host:

```json
{"is_error":false,"duration_api_ms":1664,"num_turns":1,"stop_reason":"end_turn",
 "session_id":"95dc44c7-…","total_cost_usd":0.0221456,
 "usage":{"input_tokens":10,"cache_creation_input_tokens":10086,
          "cache_read_input_tokens":17536,"output_tokens":42,
          "service_tier":"standard", …}}
```

Cost arrives directly as `total_cost_usd`. Cache reads and cache creation are **separate**
from `input_tokens` and must be stored separately — they are priced differently, and
collapsing them into one "input" number would misprice exactly the caching behaviour that
makes long lanes affordable.

### Record shape

One row per model invocation. Proposed columns, to live in the existing state database
(`core/` owns it; do not invent a second store):

| column | type | note |
|---|---|---|
| `id` | integer pk | |
| `observed_at` | integer, epoch ms | when the record was written |
| `model` | text | e.g. `claude-opus-5`; **never** inferred, always as reported |
| `role` | text | `coder` \| `reviewer` \| `orchestrator` \| `manager` |
| `lane` | text, nullable | lane name when the spend belongs to a lane |
| `item_id` | text, nullable | workboard row, when known |
| `input_tokens` | integer | |
| `output_tokens` | integer | |
| `cache_creation_input_tokens` | integer | |
| `cache_read_input_tokens` | integer | |
| `cost_usd` | real | from `total_cost_usd` |
| `service_tier` | text, nullable | |
| `session_id` | text, nullable | for reconciliation against provider records |
| `source` | text | `cli-json` \| `estimated` \| `unmeasured` |

`source` is load-bearing. A row whose numbers were not observed **must** carry
`unmeasured` and null counts — never zero. This is the standing rule for this data
(HR-2377, `instance/quota-readings.tsv`, V3-3.10): the destination is a graph, and a zero
on a graph reads as "we spent nothing" rather than "we did not look".

### Query path

A read command sufficient for a time series, grouped by any of model / role / hour. It
must be usable from the CLI so the operator can ask without a UI existing.

Shape, described rather than shown as a runnable line: a **new** `mission-cli` action —
proposed name `usage` — taking a `--since <iso>` window and a `--group-by` list drawn from
`model`, `role`, `hour`. The implementer registers it in `core/mission-cli-actions` like
any other action.

It is deliberately not written here as an executable example.
`tools/check-documented-mission-cli.ts` refuses documentation that names a `mission-cli`
action which is not dispatchable, and it **caught the first draft of this spec doing
exactly that** — the action does not exist yet, so writing it as a runnable command made
the repository assert a capability it does not have. That check is the same class of guard
this whole night has been about, and it earned its keep on its author.

## Configuration and dependencies

- No new external service. No credentials. No network egress beyond what the CLI already does.
- Depends on the Claude CLI continuing to emit `usage`. If the field is absent, the record
  is written with `source=unmeasured` rather than skipped, so a provider that stops
  reporting is **visible** instead of invisible.
- The orchestrator's own consumption counts too: it is a role (`orchestrator`) and it is
  currently the largest single spender. A design that only measures lanes would answer the
  wrong question.

## Why not quota percentages

`daemon/vendor-quota.ts` reads Codex quota from JSONL but returns Claude as
`{ state: 'unknown' }` — there is no machine-readable Claude quota on this host, so
percentages depend on the operator sending a screenshot (`instance/quota-readings.tsv`
holds those, hand-kept). Token counts are observable at the point of use. This spec
deliberately measures what the machine can own; the screenshots remain a coarse cross-check.

## Steps and risks

1. Prove the stream shape end to end for one real lane under option (a), including what the
   masker does with each event kind. **Stop point:** if `stream-json` cannot preserve a
   readable lane log, take (b) and say why.
2. Add the table and a migration to the state DB. Existing rows unaffected.
3. Write the capture path. It must be non-fatal: wrap it so any failure logs and continues.
4. Attribute `role` and `lane` from the launcher, which already knows both — do not parse
   them out of the prompt.
5. Add the query command.
6. Backfill nothing. Historical spend is not recoverable and must not be guessed.

**Risks and edge cases to handle explicitly:** a lane killed mid-turn (record what is
known, mark `unmeasured` for the rest); a model swapped mid-session (HR-2315 makes this
relaunch-scoped, but the record must follow the reported model, not the configured one);
concurrent lanes writing at once (the state DB is shared — this is the same two-writers
hazard as V3-0.20 and V3-0.7, so use the existing store's transaction discipline rather
than a new one).

## Acceptance and verification

- A lane runs; a row exists afterwards with non-null input and output counts, the correct
  `model`, the correct `role`, and a `cost_usd` matching the CLI's `total_cost_usd`.
- The lane log is **unchanged in readability** from today — assert against a captured
  sample, not by eye.
- A lane whose usage block is absent produces a row with `source=unmeasured` and **null**
  counts. Assert that no code path writes `0` for an unobserved value.
- Killing a lane mid-turn still leaves the system consistent and the lane still fails or
  passes on its own merits — accounting never changes a lane's verdict.
- The query command returns a series grouped by model and by role across a window spanning
  more than one lane.
- The orchestrator's own spend appears with `role=orchestrator`.
- Survives a restart: stop the daemon, restart, query again, same rows.

## Review record

Reserved. Findings, resolutions and explicit non-actions go here.

Non-action recorded now: graph rendering is **not** in this spec. The operator asked for
graphs, and graphs need data first; a page that draws from an empty table would be the
same false comfort as a green check with nothing to check.

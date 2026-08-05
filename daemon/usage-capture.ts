/**
 * Token and cost capture from the Claude CLI's `stream-json` output.
 * V3-3.10, implementing instance/specs/token-usage-accounting.md (HR-2377).
 *
 * The spec named the one real risk: lanes emit plain text into the lane log,
 * which is the operator's main window into a running lane, and usage data needs
 * a JSON output format. Shape (a) was chosen over the side channel and the
 * evidence is instance/evidence/v3-3.10/: `--output-format stream-json
 * --verbose` carries the terminal result event on the SAME stream, so a lane
 * that dies mid-turn is still recorded -- which is precisely the case the side
 * channel would have lost, and precisely the case worth measuring.
 *
 * The log is preserved by rendering, not by luck. `claude --print` writes
 * exactly the final result text and nothing else; this module emits exactly
 * that text out of the result event and drops the machinery events `--print`
 * never showed. daemon/mask-stream.test.ts asserts the two are byte-identical
 * against a captured sample rather than trusting the reading.
 *
 * Nothing here throws for accounting reasons. A malformed event is passed to
 * the log as text and skipped for accounting: a lane's verdict must never
 * depend on whether its consumption was recorded.
 */
import type { UsageEventInput, UsageRole } from "../core/schema";

export type UsageAttribution = { role: UsageRole; lane?: string | null; itemId?: string | null };

/**
 * The event types this renderer is allowed to consume, MEASURED from an
 * agentic stream on this host rather than assumed: `system` (init and
 * thinking_tokens), `rate_limit_event`, `assistant`, `user` (tool results) and
 * `result`. Everything else is written to the log verbatim.
 *
 * An allowlist rather than "anything with a `type` field", because the two
 * failure directions are not equally bad. An unrecognized line passed through
 * shows up as one ugly JSON line in the log -- visible, and someone fixes it. A
 * line consumed by a catch-all disappears with no trace, and this stream also
 * carries a plain-text provider's output (the codex confs) and merged stderr,
 * where a single-line JSON object is entirely possible. Silent loss from the
 * operator's main window is the worse outcome, so unknown means "show it".
 */
const STREAM_EVENT_TYPES = new Set(["system", "rate_limit_event", "assistant", "user", "result"]);

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A count is read ONLY when the provider actually reported it. A field that is
 * absent, null, or not a non-negative integer becomes null and stays null all
 * the way to the column. There is deliberately no `?? 0` anywhere in this file:
 * the destination is a graph, and a manufactured zero there reads as "we spent
 * nothing" rather than "the provider stopped telling us".
 */
function count(source: Json | undefined, ...keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    if (!(key in source)) continue;
    const value = source[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

function cost(source: Json | undefined, ...keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    if (!(key in source)) continue;
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function text(source: Json | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Usage rows for one terminal `result` event.
 *
 * The event carries two views of the same turn and they do not agree, so the
 * choice between them matters. Top-level `usage` is the LAST message's block;
 * `modelUsage` is the whole session broken down BY MODEL, and its costs sum to
 * `total_cost_usd`. The spec requires attribution to the model that spent, and
 * a session now routinely spans more than one model (subagents), so the
 * per-model breakdown is what "one row per model invocation" means in the data
 * that actually arrives. Top-level `usage` is the fallback for a provider build
 * that reports no breakdown, and it is attributed to the model the stream
 * itself reported -- never to the model the launcher configured, because
 * HR-2315 lets those differ.
 */
export function usageFromResultEvent(event: Json, attribution: UsageAttribution, reportedModel?: string | null, observedAt?: number): UsageEventInput[] {
  const sessionId = text(event, "session_id");
  const usage = isObject(event.usage) ? event.usage : undefined;
  const serviceTier = text(usage, "service_tier");
  const base = { role: attribution.role, lane: attribution.lane ?? null, itemId: attribution.itemId ?? null, sessionId, serviceTier, observedAt };

  const modelUsage = isObject(event.modelUsage) ? event.modelUsage : undefined;
  const rows: UsageEventInput[] = [];
  if (modelUsage) {
    for (const [model, raw] of Object.entries(modelUsage)) {
      if (!isObject(raw)) continue;
      const inputTokens = count(raw, "inputTokens");
      const outputTokens = count(raw, "outputTokens");
      if (inputTokens === null || outputTokens === null) continue;
      rows.push({
        ...base, model, source: "cli-json",
        inputTokens, outputTokens,
        cacheCreationInputTokens: count(raw, "cacheCreationInputTokens"),
        cacheReadInputTokens: count(raw, "cacheReadInputTokens"),
        costUsd: cost(raw, "costUSD"),
        // One row per model, so the identity that makes a re-ingest idempotent
        // is the session plus the model, not a message id this event has none of.
        eventId: "result",
      });
    }
  }
  if (rows.length) return rows;

  const inputTokens = count(usage, "input_tokens");
  const outputTokens = count(usage, "output_tokens");
  const model = reportedModel ?? null;
  if (model !== null && inputTokens !== null && outputTokens !== null) {
    return [{
      ...base, model, source: "cli-json", inputTokens, outputTokens,
      cacheCreationInputTokens: count(usage, "cache_creation_input_tokens"),
      cacheReadInputTokens: count(usage, "cache_read_input_tokens"),
      costUsd: cost(event, "total_cost_usd"),
      eventId: "result",
    }];
  }

  // The provider finished the turn and reported nothing usable. That is a fact
  // worth a row: an absent usage block must make the provider VISIBLE, not
  // invisible, so it is recorded as unmeasured with null counts rather than
  // skipped or filed as zero.
  return [{
    ...base, model: null, serviceTier: null, source: "unmeasured",
    inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null,
    costUsd: null, eventId: "result",
  }];
}

/**
 * Drives one lane's stream: renders the human-readable log and collects the
 * usage rows. The caller owns masking (the rendered text is what gets masked,
 * so a secret inside assistant text is still caught) and owns the sink.
 */
export class LaneUsageCollector {
  private rows: UsageEventInput[] = [];
  private sawResult = false;
  private reportedModel: string | null = null;

  /**
   * `attribution` is nullable, and the log does not care which it is. Rendering
   * must never depend on accounting configuration: an early draft skipped the
   * renderer when no role had arrived, and the lane log filled with raw JSON --
   * the precise breakage the spec warned about, reached through a missing flag
   * rather than a missing feature. daemon/mask-stream.test.ts locks it.
   */
  constructor(private readonly attribution: UsageAttribution | null, private readonly now: () => number = Date.now) {}

  /** One line of the agent's stdout+stderr. Returns what belongs in the log. */
  observe(line: string): string {
    const trimmed = line.trim();
    // stderr is merged into this pipe by orchestrator/fleet/lane-payload.sh, and
    // a provider warning is not JSON. Anything that is not a recognizable event
    // passes through verbatim: those lines are diagnostics, and swallowing them
    // would make the log LESS readable than the plain-text stream it replaces.
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return line;
    let event: unknown;
    try { event = JSON.parse(trimmed); } catch { return line; }
    if (!isObject(event) || typeof event.type !== "string" || !STREAM_EVENT_TYPES.has(event.type)) return line;

    if (event.type === "assistant" && isObject(event.message)) {
      // The model as REPORTED, kept only as the fallback attribution for a
      // result event that carries no per-model breakdown.
      const model = text(event.message, "model");
      if (model) this.reportedModel = model;
      return "";
    }
    if (event.type !== "result") return "";

    this.sawResult = true;
    try {
      if (this.attribution) this.rows.push(...usageFromResultEvent(event, this.attribution, this.reportedModel, this.now()));
    } catch {
      // Accounting never fails a lane. The log line below is still emitted.
    }
    const result = event.result;
    if (typeof result === "string") return result.endsWith("\n") ? result : `${result}\n`;
    // An error turn can end without result text. `claude --print` would have
    // said something here, so say something rather than logging silence.
    return `[lane] turn ended with no result text (subtype=${typeof event.subtype === "string" ? event.subtype : "unknown"})\n`;
  }

  /**
   * Rows to record once the stream is over.
   *
   * A stream that ended with no result event is a lane killed mid-turn -- the
   * case the side-channel design would have recorded as nothing at all. It gets
   * an unmeasured row: what is known (role, lane) is kept, what is not is null,
   * and the turn stays visible on the graph as a turn nobody could measure.
   */
  finish(): UsageEventInput[] {
    if (!this.attribution || this.sawResult) return this.rows;
    return [{
      role: this.attribution.role, lane: this.attribution.lane ?? null, itemId: this.attribution.itemId ?? null,
      model: null, inputTokens: null, outputTokens: null, cacheCreationInputTokens: null,
      cacheReadInputTokens: null, costUsd: null, serviceTier: null, sessionId: null,
      eventId: null, source: "unmeasured", observedAt: this.now(),
    }];
  }
}

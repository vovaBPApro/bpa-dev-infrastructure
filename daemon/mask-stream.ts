#!/usr/bin/env bun
/**
 * The lane log writer. Everything a lane prints reaches disk through here, so
 * this file has two jobs and must not confuse them: mask secrets, and -- since
 * V3-3.10 -- render the provider's `stream-json` events back into the
 * plain-text log the operator has always read.
 *
 * Default behaviour is unchanged and byte-identical: with no `--format
 * stream-json` this is the same pass-through masker it was, which is what keeps
 * the codex-family lanes (instance/lane-agent-command-codex.conf) working.
 */
import { SecretMaskStream } from './secret-masker';
import { LaneUsageCollector, type UsageAttribution } from './usage-capture';
import { recordUsageRows } from './usage-sink';
import type { UsageRole } from '../core/state';
export { SecretMaskStream } from './secret-masker';

type Options = { streamJson: boolean; role: UsageRole | null; lane: string | null; itemId: string | null; dbPath?: string };

const ROLES: readonly string[] = ['coder', 'reviewer', 'orchestrator', 'manager'];

export function parseMaskStreamArgs(argv: string[], env: Record<string, string | undefined> = process.env): Options {
  const options: Options = {
    streamJson: false, role: null,
    // Attribution the launcher already knows. It travels by environment
    // (orchestrator/fleet/launch-lane.sh sets it with --setenv, exactly as it
    // already does for LANE_REPORT_PATH) rather than as new positional
    // parameters: the tenth-argument incident recorded in lane-payload.sh is
    // what a growing positional contract costs.
    lane: env.LANE_USAGE_LANE || null, itemId: env.LANE_USAGE_ITEM || null,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--format') { options.streamJson = value === 'stream-json'; index++; continue; }
    if (flag === '--role') { options.role = ROLES.includes(value ?? '') ? (value as UsageRole) : null; index++; continue; }
    if (flag === '--lane') { options.lane = value || null; index++; continue; }
    if (flag === '--item') { options.itemId = value || null; index++; continue; }
    if (flag === '--db') { options.dbPath = value; index++; continue; }
  }
  return options;
}

/**
 * stream-json mode. Lines are the unit here because the provider emits one JSON
 * event per line and because stderr is merged into the same pipe upstream, so a
 * non-event line must survive to the log untouched.
 *
 * Masking is applied to the RENDERED text, not to the raw event JSON: a secret
 * inside assistant output is still caught, and the masker never sees the
 * structural JSON it would otherwise be free to mangle.
 */
async function runStreamJson(options: Options): Promise<void> {
  const masker = new SecretMaskStream();
  const attribution: UsageAttribution | null = options.role ? { role: options.role, lane: options.lane, itemId: options.itemId } : null;
  if (!attribution) {
    // Render, do not record. A lane whose role never arrived is still a lane
    // whose log the operator needs; refusing to run -- or falling back to
    // echoing raw events -- would trade a whole lane for an accounting row.
    process.stderr.write('WARN usage-accounting no valid --role; the lane log is unaffected and nothing is recorded\n');
  }
  const collector = new LaneUsageCollector(attribution);
  const emit = (text: string): void => { if (text) process.stdout.write(masker.push(text)); };

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const drain = (chunk: string): void => {
    pending += chunk;
    for (;;) {
      const boundary = pending.indexOf('\n');
      if (boundary < 0) break;
      const line = pending.slice(0, boundary + 1);
      pending = pending.slice(boundary + 1);
      emit(collector.observe(line));
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    drain(decoder.decode(value, { stream: true }));
  }
  drain(decoder.decode());
  if (pending) emit(collector.observe(pending));
  process.stdout.write(masker.end());

  // Recorded last, and wrapped: by this point the log is complete on disk, so
  // nothing an accounting failure can do reaches the lane's evidence.
  try { recordUsageRows(collector.finish(), { dbPath: options.dbPath }); }
  catch (error) { process.stderr.write(`WARN usage-accounting capture failed: ${error instanceof Error ? error.message : String(error)}\n`); }
}

async function runPassThrough(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  const masker = new SecretMaskStream();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(masker.push(decoder.decode(value, { stream: true })));
  }
  process.stdout.write(masker.push(decoder.decode()));
  process.stdout.write(masker.end());
}

if (import.meta.main) {
  const options = parseMaskStreamArgs(Bun.argv.slice(2));
  await (options.streamJson ? runStreamJson(options) : runPassThrough());
}

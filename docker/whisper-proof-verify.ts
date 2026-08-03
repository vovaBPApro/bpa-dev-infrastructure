// docker/whisper-proof-verify.ts — independent, content-asserting proof that
// tools/whisper/install.sh produced a genuinely working whisper install.
// Runs INSIDE the whisper-proof container only (see
// docker/whisper-proof-run.sh); never touches a host's live
// /opt/whisper.cpp.
//
// Deliberately exercises the REAL production integration point,
// daemon/transcribe.ts's transcribeAudio()/resolveWhisperConfig(), instead
// of shelling out to whisper-cli by hand — that is the code path a real
// Telegram voice message goes through, and it is a different, independent
// check from install.sh's own internal end-of-run smoke test (step 5 of
// install.sh), which:
//   - calls whisper-cli directly, not through daemon/transcribe.ts;
//   - only asserts its output file is non-empty, not that the content is
//     the phrase that was spoken (a fixture that asserts "the command
//     exited 0" proves nothing about whisper — see the sprint-02 brief for
//     this row).
//
// This script asserts on ACTUAL transcript content, and uses a different
// synthesized phrase than install.sh's own smoke test ("testing one two
// three") on purpose: a pass here cannot be explained by accidentally
// re-reading install.sh's leftover output file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWhisperConfig, transcribeAudio } from '../daemon/transcribe.ts';

const PHRASE = 'the quick brown fox jumps over the lazy dog';
// Words expected to survive real ASR noise on this short, clean, synthesized
// utterance. Asserting these as substrings (not full-string equality) keeps
// the check from being flaky on whisper's own punctuation/casing choices,
// while still proving real content, not just non-empty output.
const REQUIRED_WORDS = ['quick', 'brown', 'fox', 'lazy', 'dog'];

function die(msg: string): never {
  console.error(`[whisper-proof-verify] FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    die(
      `${cmd.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'whisper-proof-verify-'));
  try {
    const raw = join(work, 'fixture-raw.wav');
    // Deterministic, synthesized inside the container rather than committed
    // to git as a binary fixture — espeak-ng is already this repository's
    // established fixture generator for exactly this purpose (see
    // install.sh step 5 and tools/whisper/install.test.ts's header comment).
    // A missing/broken espeak-ng here fails this script closed via run()'s
    // exit-code check, it is never treated as "no fixture, so skip".
    run(['espeak-ng', '-v', 'en', PHRASE, '-w', raw]);

    const cfg = resolveWhisperConfig();
    console.log(
      `[whisper-proof-verify] using bin=${cfg.bin} model=${cfg.model}`,
    );

    const result = await transcribeAudio(raw, cfg);
    if (!result.ok) {
      die(`transcribeAudio failed: ${result.reason}`);
    }

    const got = result.text.toLowerCase();
    const missing = REQUIRED_WORDS.filter((w) => !got.includes(w));
    if (missing.length > 0) {
      die(
        `transcript missing expected word(s) [${missing.join(', ')}]; got: "${result.text}"`,
      );
    }

    // Tagged line the runner (docker/whisper-proof-run.sh) greps out to
    // surface the real transcript in its own output/report.
    console.log(`WHISPER_PROOF_TRANSCRIPT: ${result.text}`);
    console.log(
      `[whisper-proof-verify] OK — real transcription in ${result.durationMs}ms matched all expected words`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();

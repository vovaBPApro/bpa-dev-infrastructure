// Local speech-to-text for Telegram voice/audio messages (HR-146 §NI-3).
//
// The Human's requirement: voice messages must be transcribed LOCALLY on this
// server (Ukrainian first, English required, Polish possible) and processed by
// the orchestrator as text. The engine is whisper.cpp — a native binary built
// by tools/whisper/install.sh into a HOST location (default /opt/whisper.cpp),
// deliberately outside the repo tree. This module is the only integration
// point: Bun shells out to ffmpeg (opus .oga → 16 kHz mono wav) and then to
// whisper-cli. No Python anywhere (Hard Rule 4).
//
// Fail-closed contract: every failure returns { ok: false, reason } with a
// concrete reason. The CALLER must still surface the voice message to the
// session with that reason — a transcription failure must never silently drop
// the message (the W-15 disease).

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type WhisperConfig = {
  /** whisper-cli binary (host state, installed by tools/whisper/install.sh). */
  bin: string;
  /** ggml model file. Primary: large-v3-turbo. Fallback: medium. */
  model: string;
  /** ffmpeg binary used for the opus → 16 kHz wav conversion. */
  ffmpeg: string;
  /** whisper threads. Default 8 of the box's 12 cores. */
  threads: number;
  /** Hard wall-clock cap for each external command. */
  timeoutMs: number;
  /** Whisper language hint; 'auto' detects (uk/en/pl all required to work). */
  language: string;
};

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function resolveWhisperConfig(
  env: Record<string, string | undefined> = process.env,
): WhisperConfig {
  const prefix = env.ORCH_WHISPER_PREFIX ?? '/opt/whisper.cpp';
  return {
    bin: env.ORCH_WHISPER_BIN ?? join(prefix, 'bin', 'whisper-cli'),
    model:
      env.ORCH_WHISPER_MODEL ??
      join(prefix, 'models', 'ggml-large-v3-turbo.bin'),
    ffmpeg: env.ORCH_FFMPEG_BIN ?? 'ffmpeg',
    threads: parsePositiveInt(env.ORCH_WHISPER_THREADS) ?? 8,
    timeoutMs: parsePositiveInt(env.ORCH_WHISPER_TIMEOUT_MS) ?? 180_000,
    language: env.ORCH_WHISPER_LANG ?? 'auto',
  };
}

export type TranscriptionResult =
  | { ok: true; text: string; durationMs: number }
  | { ok: false; reason: string };

/** True when both the binary and the model are installed on this host. */
export function whisperAvailable(
  cfg: WhisperConfig = resolveWhisperConfig(),
): boolean {
  return existsSync(cfg.bin) && existsSync(cfg.model);
}

async function run(
  argv: string[],
  timeoutMs: number,
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(argv, {
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    return { code, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function tail(s: string, n = 300): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

/**
 * Transcribe an audio file (any format ffmpeg reads — Telegram voice is
 * opus-in-ogg) to plain text. Never throws: every failure path returns
 * { ok: false, reason }.
 */
export async function transcribeAudio(
  audioPath: string,
  cfg: WhisperConfig = resolveWhisperConfig(),
): Promise<TranscriptionResult> {
  const started = Date.now();
  if (!existsSync(audioPath)) {
    return { ok: false, reason: `audio file missing: ${audioPath}` };
  }
  if (!existsSync(cfg.bin)) {
    return {
      ok: false,
      reason: `whisper binary missing: ${cfg.bin} (run tools/whisper/install.sh)`,
    };
  }
  if (!existsSync(cfg.model)) {
    return {
      ok: false,
      reason: `whisper model missing: ${cfg.model} (run tools/whisper/install.sh)`,
    };
  }

  let work: string | null = null;
  try {
    work = mkdtempSync(join(tmpdir(), 'stt-'));
    const wav = join(work, 'in16k.wav');

    const conv = await run(
      [
        cfg.ffmpeg,
        '-y',
        '-loglevel',
        'error',
        '-i',
        audioPath,
        '-ar',
        '16000',
        '-ac',
        '1',
        wav,
      ],
      cfg.timeoutMs,
    );
    if (conv.timedOut) return { ok: false, reason: 'ffmpeg timed out' };
    if (conv.code !== 0) {
      return { ok: false, reason: `ffmpeg failed: ${tail(conv.stderr)}` };
    }

    const outPrefix = join(work, 'out');
    const whisper = await run(
      [
        cfg.bin,
        '-m',
        cfg.model,
        '-f',
        wav,
        '-l',
        cfg.language,
        '-t',
        String(cfg.threads),
        '-np',
        '-otxt',
        '-of',
        outPrefix,
      ],
      cfg.timeoutMs,
    );
    if (whisper.timedOut) return { ok: false, reason: 'whisper timed out' };
    if (whisper.code !== 0) {
      return { ok: false, reason: `whisper failed: ${tail(whisper.stderr)}` };
    }

    const txtPath = `${outPrefix}.txt`;
    if (!existsSync(txtPath)) {
      return { ok: false, reason: 'whisper produced no output file' };
    }
    const text = readFileSync(txtPath, 'utf8').replace(/\s+/g, ' ').trim();
    if (!text) {
      return { ok: false, reason: 'transcription produced no text' };
    }
    return { ok: true, text, durationMs: Date.now() - started };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `transcription error: ${msg}` };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

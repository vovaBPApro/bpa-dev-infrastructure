// Unit tests for the local whisper.cpp transcription module (HR-146 §NI-3).
//
// Two layers:
//   1. Fail-closed contract tests — run everywhere, no model needed: every
//      failure path must return { ok: false, reason } with a concrete reason.
//   2. Real-engine tests against the HOST whisper install (tools/whisper/
//      install.sh): multilingual fixtures are generated at test time with
//      espeak-ng and pushed through the REAL ffmpeg → whisper-cli pipeline,
//      including the Telegram wire format (.oga opus). If the host stack is
//      absent these are SKIPPED with a named reason — on the operator's box
//      the installer has been run, so they execute for real there.
//
// Fixture honesty: espeak-ng's robotic Ukrainian voice defeats Whisper's
// LANGUAGE AUTO-DETECTION (it hears Italian/Finnish phonemes), so the
// Ukrainian test forces -l uk and asserts Cyrillic output rather than exact
// words. Real human speech is what large-v3-turbo is trained on; English via
// espeak transcribes exactly and is asserted by content.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveWhisperConfig,
  transcribeAudio,
  whisperAvailable,
} from './transcribe';

const scratchDirs: string[] = [];
afterAll(() => {
  for (const d of scratchDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'transcribe-test-'));
  scratchDirs.push(d);
  return d;
}

async function espeak(
  voice: string,
  text: string,
  outWav: string,
): Promise<void> {
  const proc = Bun.spawn(
    ['espeak-ng', '-v', voice, '-s', '140', text, '-w', outWav],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  if ((await proc.exited) !== 0) throw new Error('espeak-ng failed');
}

async function toOgaOpus(srcWav: string, outOga: string): Promise<void> {
  const proc = Bun.spawn(
    ['ffmpeg', '-y', '-loglevel', 'error', '-i', srcWav, '-c:a', 'libopus', outOga],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  if ((await proc.exited) !== 0) throw new Error('ffmpeg opus encode failed');
}

// ── 1. Fail-closed contract (no model required) ─────────────────────────────

test('a missing audio file fails with a concrete reason, never throws', async () => {
  const result = await transcribeAudio('/nonexistent/voice.oga');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain('audio file missing');
});

test('a missing whisper binary names the binary and the installer', async () => {
  const dir = scratch();
  const audio = join(dir, 'a.wav');
  writeFileSync(audio, 'fake');
  const cfg = {
    ...resolveWhisperConfig({}),
    bin: '/nonexistent/whisper-cli',
  };
  const result = await transcribeAudio(audio, cfg);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toContain('whisper binary missing');
    expect(result.reason).toContain('tools/whisper/install.sh');
  }
});

test('a missing model names the model and the installer', async () => {
  const dir = scratch();
  const audio = join(dir, 'a.wav');
  writeFileSync(audio, 'fake');
  // A bin that exists (any executable) with a model that does not.
  const cfg = {
    ...resolveWhisperConfig({}),
    bin: process.execPath,
    model: '/nonexistent/ggml.bin',
  };
  const result = await transcribeAudio(audio, cfg);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain('whisper model missing');
});

test('config env overrides are honored and defaults are sane', () => {
  const def = resolveWhisperConfig({});
  expect(def.bin).toBe('/opt/whisper.cpp/bin/whisper-cli');
  expect(def.model).toBe('/opt/whisper.cpp/models/ggml-large-v3-turbo.bin');
  expect(def.language).toBe('auto');
  expect(def.threads).toBeGreaterThan(0);
  expect(def.timeoutMs).toBeGreaterThan(0);

  const custom = resolveWhisperConfig({
    ORCH_WHISPER_PREFIX: '/srv/w',
    ORCH_WHISPER_MODEL: '/srv/w/models/ggml-medium.bin',
    ORCH_WHISPER_THREADS: '4',
    ORCH_WHISPER_TIMEOUT_MS: '5000',
    ORCH_WHISPER_LANG: 'uk',
  });
  expect(custom.bin).toBe('/srv/w/bin/whisper-cli');
  expect(custom.model).toBe('/srv/w/models/ggml-medium.bin');
  expect(custom.threads).toBe(4);
  expect(custom.timeoutMs).toBe(5000);
  expect(custom.language).toBe('uk');

  // Garbage numeric envs fall back to defaults instead of poisoning the run.
  const garbage = resolveWhisperConfig({
    ORCH_WHISPER_THREADS: '-3',
    ORCH_WHISPER_TIMEOUT_MS: 'soon',
  });
  expect(garbage.threads).toBe(def.threads);
  expect(garbage.timeoutMs).toBe(def.timeoutMs);
});

// ── 2. Real engine (skip-with-named-reason when host stack is absent) ───────

const cfg = resolveWhisperConfig();
const hostReason = !existsSync(cfg.bin)
  ? `whisper binary missing: ${cfg.bin} — run tools/whisper/install.sh`
  : !existsSync(cfg.model)
    ? `whisper model missing: ${cfg.model} — run tools/whisper/install.sh`
    : !Bun.which('ffmpeg')
      ? 'ffmpeg missing — run tools/whisper/install.sh'
      : !Bun.which('espeak-ng')
        ? 'espeak-ng missing (fixture generator) — run tools/whisper/install.sh'
        : null;

test('whisperAvailable is false when the binary or model is absent', () => {
  expect(whisperAvailable({ ...cfg, bin: '/nonexistent/whisper-cli' })).toBe(
    false,
  );
  expect(whisperAvailable({ ...cfg, model: '/nonexistent/ggml.bin' })).toBe(
    false,
  );
});

if (hostReason) {
  test.skip(`REAL-ENGINE TESTS SKIPPED: ${hostReason}`, () => {});
} else {
  test(
    'transcribes an English .oga opus voice message (the Telegram wire format)',
    async () => {
      const dir = scratch();
      const raw = join(dir, 'en.wav');
      const oga = join(dir, 'en.oga');
      await espeak(
        'en',
        'Hello, this is a test voice message for the orchestrator using the local whisper model.',
        raw,
      );
      await toOgaOpus(raw, oga);

      const result = await transcribeAudio(oga, cfg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text.toLowerCase()).toContain('voice message');
        expect(result.text.toLowerCase()).toContain('orchestrator');
        expect(result.durationMs).toBeGreaterThan(0);
      }
    },
    240_000,
  );

  test(
    'transcribes a Ukrainian sample to Cyrillic text (forced -l uk; see fixture note)',
    async () => {
      const dir = scratch();
      const raw = join(dir, 'uk.wav');
      await espeak(
        'uk',
        'Привіт! Це тестове голосове повідомлення для оркестратора.',
        raw,
      );
      const result = await transcribeAudio(raw, { ...cfg, language: 'uk' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text.length).toBeGreaterThan(0);
        // The robotic fixture yields phonetic output; the load-bearing claim
        // is that the uk pipeline produces Ukrainian-script text at all.
        expect(/[А-Яа-яІіЇїЄєҐґ]/.test(result.text)).toBe(true);
      }
    },
    240_000,
  );

  test(
    'garbage audio fails closed with the ffmpeg reason',
    async () => {
      const dir = scratch();
      const bad = join(dir, 'noise.oga');
      writeFileSync(bad, 'this is not audio at all');
      const result = await transcribeAudio(bad, cfg);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('ffmpeg failed');
    },
    60_000,
  );
}

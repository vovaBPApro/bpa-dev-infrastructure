#!/usr/bin/env bun
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';

function die(message: string): never { console.error(`redact-live-jsonl: ${message}`); process.exit(2); }
const args = process.argv.slice(2);
const valueFiles = args.flatMap((arg, index) => arg === '--values-file' && args[index + 1] ? [args[index + 1]] : []);
const target = args[args.indexOf('--target') + 1];
if (!valueFiles.length || !target) die('usage: --values-file FILE [--values-file FILE ...] --target JSONL');

const credentialName = /(?:SECRET|TOKEN|PASSWORD|API_KEY|CLIENT_ID|PRIVATE_?KEY)$/i;
const found = new Set<string>();
function collectJson(value: unknown, key = ''): void {
  if (typeof value === 'string' && credentialName.test(key) && Buffer.byteLength(value) >= 8) found.add(value);
  else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) collectJson(child, childKey);
}
for (const valueFile of valueFiles) {
  const text = readFileSync(valueFile, 'utf8');
  try { collectJson(JSON.parse(text)); } catch {
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (!match || !credentialName.test(match[1])) continue;
      const value = match[2].replace(/^(['"])([\s\S]*)\1$/, '$2');
      if (Buffer.byteLength(value) >= 8) found.add(value);
    }
  }
}
const credentialValues = [...found];
const values = credentialValues.map((value) => Buffer.from(value));
if (!values.length) die('runtime store yielded no credential values');

const before = readFileSync(target);
const parsedBefore = before.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const containsSemanticValue = (subject: unknown, value: string): boolean => {
  if (typeof subject === 'string') return subject.includes(value);
  if (Array.isArray(subject)) return subject.some((child) => containsSemanticValue(child, value));
  return Boolean(subject && typeof subject === 'object' && Object.values(subject).some((child) => containsSemanticValue(child, value)));
};
const presentValues = new Set(credentialValues.filter((value) => parsedBefore.some((row) => containsSemanticValue(row, value))));
const originalSize = statSync(target).size;
const fd = openSync(target, 'r+');
let replacements = 0;
try {
  const current = Buffer.alloc(originalSize);
  if (readSync(fd, current, 0, current.length, 0) !== current.length) die('short read; target changed during inspection');
  const encodedValues = credentialValues.flatMap((value) => {
    const raw = Buffer.from(value);
    const json = Buffer.from(JSON.stringify(value).slice(1, -1));
    const unicodeText = [...value].map((character) => {
      const units: string[] = [];
      for (let index = 0; index < character.length; index += 1) units.push(`\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`);
      return units.join('');
    }).join('');
    const unicode = Buffer.from(unicodeText);
    const unicodeUpper = Buffer.from(unicodeText.toUpperCase().replaceAll('\\U', '\\u'));
    const url = Buffer.from(encodeURIComponent(value));
    const base64 = Buffer.from(raw.toString('base64'));
    return [...new Map([raw, json, unicode, unicodeUpper, url, base64].map((candidate) => [candidate.toString('hex'), candidate])).values()];
  });
  for (const value of encodedValues) {
    let offset = 0;
    while ((offset = current.indexOf(value, offset)) !== -1) {
      const stars = Buffer.alloc(value.length, 0x2a);
      if (writeSync(fd, stars, 0, stars.length, offset) !== stars.length) die('short write; stopped');
      stars.copy(current, offset);
      replacements += 1;
      offset += value.length;
    }
  }
} finally { closeSync(fd); }
if (statSync(target).size !== originalSize) die('target size changed');
const after = readFileSync(target, 'utf8');
const parsedAfter = after.split('\n').filter(Boolean).map((line) => JSON.parse(line));
for (const value of values) if (Buffer.from(after).includes(value)) die('exact value survived target redaction');
for (const value of presentValues) {
  if (parsedAfter.some((row) => containsSemanticValue(row, value))) die('semantic value survived target redaction');
}
if (presentValues.size && replacements === 0) die('target contained credential values but no replacements were made');
console.log(`redact-live-jsonl: replacements=${replacements} files=1 bytes_unchanged=${originalSize}`);

const scanRoots = args.flatMap((arg, index) => arg === '--scan-root' && args[index + 1] ? [args[index + 1]] : []);
if (scanRoots.length) {
  const excluded = new Set(valueFiles.map(realpathSync));
  const scratch = mkdtempSync(`${tmpdir()}/exact-secret-scan-`);
  const patterns = `${scratch}/patterns`;
  // rg pattern files are line-oriented. Multiline values were already checked
  // byte-for-byte in the JSONL target above; do not degrade them into common
  // PEM marker fragments that would create false whole-host survivors.
  const patternLines = values.map((value) => value.toString('utf8')).filter((value) => !value.includes('\n') && Buffer.byteLength(value) >= 8);
  writeFileSync(patterns, `${patternLines.join('\n')}\n`, { mode: 0o600 });
  const result = Bun.spawnSync(['rg', '--files-with-matches', '--fixed-strings', '--no-messages', '--text', '-f', patterns, ...scanRoots], { stdout: 'pipe', stderr: 'pipe' });
  rmSync(scratch, { recursive: true, force: true });
  if (![0, 1].includes(result.exitCode)) die('whole-host scanner failed');
  const survivors = result.stdout.toString().split('\n').filter(Boolean).filter((path) => {
    try { return !excluded.has(realpathSync(path)); } catch { return false; }
  });
  for (const path of survivors) console.error(`redact-live-jsonl: survivor file=${path}`);
  if (survivors.length) die(`whole-host exact-value survivors=${survivors.length}`);
  console.log(`redact-live-jsonl: exact-value survivors=0 roots=${scanRoots.length}`);
}

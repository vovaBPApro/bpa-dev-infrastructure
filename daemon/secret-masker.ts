import { join } from 'node:path';

const CREDENTIAL_ASSIGNMENT = /((?:client[_-]?(?:id|secret)|(?:refresh|access)[_-]?token|(?:[A-Z][A-Z0-9_]*_)?(?:SECRET|TOKEN|PASSWORD|API_KEY))\s*[:=]\s*)([^\s"']{8,})/gim;
const BEARER = /(\bBearer\s+)([0-9A-Za-z._~+/-]{8,})/gi;
const PRIVATE_KEY = /(-----BEGIN\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY-----)([\s\S]*?)(-----END\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY-----)/g;

let canonical: RegExp | undefined;

function categoryMask(value: string): string {
  if (value.length < 8) return '********';
  const stars = value.length < 24 ? 8 : value.length < 64 ? 12 : 16;
  return `${value.slice(0, 3)}${'*'.repeat(stars)}${value.slice(-3)}`;
}

function canonicalPattern(): RegExp {
  if (canonical) return canonical;
  const repo = join(import.meta.dir, '..');
  const result = Bun.spawnSync(['bash', '-c', `eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' "$1/gate/land-lib.sh")"; printf '%s' "$REPLY"`, '_', repo], {
    stdout: 'pipe', stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error('canonical secret pattern unavailable');
  const javascriptPattern = result.stdout.toString()
    .replaceAll('[[:space:]]', '\\s')
    .replaceAll('[^[:space:]]', '[^\\s]');
  canonical = new RegExp(javascriptPattern, 'gm');
  return canonical;
}

export function maskSecrets(input: string): string {
  // Fail closed if the shared definition cannot be loaded, even though the
  // structured replacements below provide the useful partial-value format.
  canonicalPattern();
  return input
    .replace(PRIVATE_KEY, (_all, begin, _body, end) => `${begin}\n****************\n${end}`)
    .replace(CREDENTIAL_ASSIGNMENT, (_all, prefix, value) => `${prefix}${categoryMask(value)}`)
    .replace(BEARER, (_all, prefix, value) => `${prefix}${categoryMask(value)}`)
    .replace(canonicalPattern(), (value) => categoryMask(value));
}

export function installStderrSecretMasker(): void {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return write(maskSecrets(text), ...(args as [BufferEncoding?, ((error?: Error | null) => void)?]));
  }) as typeof process.stderr.write;
}

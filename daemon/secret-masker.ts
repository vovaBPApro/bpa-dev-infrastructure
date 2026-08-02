import { join } from 'node:path';

const CREDENTIAL_ASSIGNMENT = /((?:client[_-]?(?:id|secret)|(?:refresh|access)[_-]?token|(?:[A-Z][A-Z0-9_]*_)?(?:SECRET|TOKEN|PASSWORD|API_KEY))(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)([^\s"']{8,})/gim;
const BEARER = /(\bBearer\s+)([0-9A-Za-z._~+/-]{8,})/gi;
const PRIVATE_KEY = /(-----BEGIN\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY-----)([\s\S]*?)(-----END\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY-----)/g;

let canonical: RegExp | undefined;

export class CanonicalSecretPatternError extends Error {
  readonly code = 'CANONICAL_SECRET_PATTERN_UNAVAILABLE';

  constructor(detail: string, options?: ErrorOptions) {
    super(`canonical secret pattern unavailable: ${detail}`, options);
    this.name = 'CanonicalSecretPatternError';
  }
}

function categoryMask(value: string): string {
  // Short credentials do not have enough entropy to safely disclose an edge.
  // For medium values, one character at either edge is sufficient to compare
  // two configured values without exposing most of either value.
  if (value.length <= 12) return '********';
  if (value.length < 24) return `${value.slice(0, 1)}********${value.slice(-1)}`;
  const stars = value.length < 64 ? 12 : 16;
  return `${value.slice(0, 3)}${'*'.repeat(stars)}${value.slice(-3)}`;
}

export function loadCanonicalSecretPattern(repo = join(import.meta.dir, '..')): RegExp {
  const result = Bun.spawnSync(['bash', '-c', `eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' "$1/gate/land-lib.sh")"; printf '%s' "$REPLY"`, '_', repo], {
    stdout: 'pipe', stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new CanonicalSecretPatternError('extraction failed');
  const extractedPattern = result.stdout.toString();
  if (extractedPattern.trim().length === 0) throw new CanonicalSecretPatternError('extracted pattern is empty');
  const javascriptPattern = extractedPattern
    .replaceAll('[[:space:]]', '\\s')
    .replaceAll('[^[:space:]]', '[^\\s]');
  try {
    return new RegExp(javascriptPattern, 'gm');
  } catch (error) {
    throw new CanonicalSecretPatternError('extracted pattern is invalid', { cause: error });
  }
}

function canonicalPattern(): RegExp {
  if (!canonical) canonical = loadCanonicalSecretPattern();
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

export class SecretMaskStream {
  private pending = '';

  push(chunk: string): string {
    this.pending += chunk;
    const boundary = this.pending.lastIndexOf('\n');
    if (boundary < 0) return '';
    const complete = this.pending.slice(0, boundary + 1);
    this.pending = this.pending.slice(boundary + 1);
    return maskSecrets(complete);
  }

  end(): string {
    const complete = this.pending;
    this.pending = '';
    return maskSecrets(complete);
  }
}

export function installStderrSecretMasker(): void {
  const write = process.stderr.write.bind(process.stderr);
  const masker = new SecretMaskStream();
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const masked = masker.push(text);
    if (!masked) {
      const callback = args.find((arg) => typeof arg === 'function') as ((error?: Error | null) => void) | undefined;
      callback?.();
      return true;
    }
    return write(masked, ...(args as [BufferEncoding?, ((error?: Error | null) => void)?]));
  }) as typeof process.stderr.write;

  process.once('beforeExit', () => {
    const masked = masker.end();
    if (masked) write(masked);
  });
}

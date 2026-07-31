#!/usr/bin/env bun
import { maskSecrets } from './secret-masker';

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

if (import.meta.main) {
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

#!/usr/bin/env bun
import { SecretMaskStream } from './secret-masker';
export { SecretMaskStream } from './secret-masker';

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

#!/usr/bin/env bun
import { maskSecrets } from './secret-masker';

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  process.stdout.write(maskSecrets(decoder.decode(value, { stream: true })));
}
const tail = decoder.decode();
if (tail) process.stdout.write(maskSecrets(tail));

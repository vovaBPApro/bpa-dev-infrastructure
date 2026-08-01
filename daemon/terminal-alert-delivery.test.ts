import { expect, test } from 'bun:test';
import { deliverTerminalAlert } from './terminal-alert-delivery';
import {
  classifyTerminalFailure,
  formatTerminalAlert,
  formatTerminalAlertPointer,
  terminalAlertPointerFromFrame,
} from './terminal-alert';

const payloadText = 'fatal error: payload must remain journal-only';
const nonce = 'nonce-w37';
const renderedNonce = 'invalid-nonce';
const frame = formatTerminalAlert(
  { kind: 'fatal', line: payloadText, session: 'ag-w37' },
  () => nonce,
);

function expectInertPointer(pointer: string): void {
  expect(pointer).toBe(
    `terminal-alert: kind=f·atal nonce=${renderedNonce} — details in daemon journal`,
  );
  expect(pointer).not.toContain('internal terminal failure');
  expect(pointer).not.toContain(payloadText);
}

test('REGRESSION W-37: connected MCP receives only the inert pointer and is preferred', async () => {
  const calls: string[] = [];
  await deliverTerminalAlert(frame, {
    journal: (text) => calls.push(`journal:${text}`),
    notifyMcp: async (text) => {
      calls.push(`mcp:${text}`);
    },
    tmuxAvailable: async () => {
      calls.push('tmux-check');
      return true;
    },
    pasteTmux: async (text) => {
      calls.push(`paste:${text}`);
      return true;
    },
  });

  expect(calls[0]).toBe(`journal:${frame}`);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.startsWith('mcp:')).toBe(true);
  expectInertPointer(calls[1]!.slice('mcp:'.length));
});

const adversarialNonces = [
  'fatal error',
  'API Error 429',
  'Worker exited unexpectedly',
  'watchdog crashed',
  'prefix-fatal error-suffix',
  'prefix-API Error 429-suffix',
  'prefix-Worker exited unexpectedly-suffix',
  'prefix-watchdog crashed-suffix',
] as const;

function pointerSurfaceVariants(text: string): string[] {
  const variants = [
    text,
    `"${text}"`,
    `← telegram: ${text}`,
    `───\n⠋ Working\n← telegram: ${text}\n❯ Press up to edit\n───`,
  ];
  return variants.flatMap((variant) => [
    variant,
    variant.replace(/\n/g, '\r\r\n'),
  ]);
}

test.each([...adversarialNonces])(
  'REGRESSION W-37 round 2: adversarial nonce %p is inert through every pointer truncation',
  (adversarialNonce) => {
    const adversarialFrame = formatTerminalAlert(
      { kind: 'fatal', line: payloadText, session: 'ag-w37' },
      () => adversarialNonce,
    );
    const pointers = [
      terminalAlertPointerFromFrame(adversarialFrame),
      formatTerminalAlertPointer('fatal', adversarialNonce),
    ];

    for (const pointer of pointers) {
      expect(pointer).toContain('nonce=invalid-nonce');
      expect(pointer).not.toContain(adversarialNonce);
      for (let end = 0; end <= pointer.length; end += 1) {
        for (const variant of pointerSurfaceVariants(pointer.slice(0, end))) {
          expect(classifyTerminalFailure(variant)).toBeNull();
        }
      }
    }
  },
);

test('REGRESSION W-37 round 2: canonical UUID remains correlatable', () => {
  const canonicalNonce = '123e4567-e89b-12d3-a456-426614174000';
  expect(formatTerminalAlertPointer('network', canonicalNonce)).toContain(
    `nonce=${canonicalNonce}`,
  );
});

test('REGRESSION W-37: disconnected MCP falls back to tmux with only the inert pointer', async () => {
  let pasted = '';
  let journaled = '';
  await deliverTerminalAlert(frame, {
    journal: (text) => (journaled = text),
    notifyMcp: null,
    tmuxAvailable: async () => true,
    pasteTmux: async (text) => {
      pasted = text;
      return true;
    },
  });

  expect(journaled).toBe(frame);
  expectInertPointer(pasted);
});

test('REGRESSION W-37: unavailable MCP and tmux preserve the failure path', async () => {
  expect(
    deliverTerminalAlert(frame, {
      journal: () => {},
      notifyMcp: null,
      tmuxAvailable: async () => false,
      pasteTmux: async () => true,
    }),
  ).rejects.toThrow('orchestrator unavailable');
});

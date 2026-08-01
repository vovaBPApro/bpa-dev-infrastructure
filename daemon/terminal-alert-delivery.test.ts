import { expect, test } from 'bun:test';
import { deliverTerminalAlert } from './terminal-alert-delivery';
import { formatTerminalAlert } from './terminal-alert';

const payloadText = 'fatal error: payload must remain journal-only';
const nonce = 'nonce-w37';
const frame = formatTerminalAlert(
  { kind: 'fatal', line: payloadText, session: 'ag-w37' },
  () => nonce,
);

function expectInertPointer(pointer: string): void {
  expect(pointer).toBe(
    `terminal-alert: kind=f·atal nonce=${nonce} — details in daemon journal`,
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

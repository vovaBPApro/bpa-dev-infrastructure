import { expect, test } from 'bun:test';
import {
  deliverTerminalAlert,
  type TerminalAlertDeliveryDependencies,
} from './terminal-alert-delivery';
import { formatTerminalAlert } from './terminal-alert';

test('REGRESSION W-37: delivery has one out-of-band journal edge and no session edge', async () => {
  const frame = formatTerminalAlert(
    {
      kind: 'fatal',
      line: 'fatal error: payload must remain journal-only',
      session: 'ag-w37',
    },
    () => '123e4567-e89b-12d3-a456-426614174000',
  );
  const journal: string[] = [];
  const forbiddenInBandCalls: string[] = [];

  // Poison legacy fields prove that even a caller retaining the former
  // MCP/tmux dependency object cannot reactivate the feedback edge.
  const legacyShapedDependencies = {
    journal: (text: string) => journal.push(text),
    notifyMcp: async (text: string) => {
      forbiddenInBandCalls.push(`mcp:${text}`);
    },
    tmuxAvailable: async () => {
      forbiddenInBandCalls.push('tmux-check');
      return true;
    },
    pasteTmux: async (text: string) => {
      forbiddenInBandCalls.push(`paste:${text}`);
      return true;
    },
  } as unknown as TerminalAlertDeliveryDependencies;
  await Promise.resolve(deliverTerminalAlert(frame, legacyShapedDependencies));

  expect(journal).toEqual([frame]);
  expect(forbiddenInBandCalls).toEqual([]);
});

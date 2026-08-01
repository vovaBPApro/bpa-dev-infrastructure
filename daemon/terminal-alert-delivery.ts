import { terminalAlertPointerFromFrame } from './terminal-alert';

export type TerminalAlertDeliveryDependencies = {
  journal: (frame: string) => void;
  notifyMcp: ((pointer: string) => Promise<void>) | null;
  tmuxAvailable: () => Promise<boolean>;
  pasteTmux: (pointer: string) => Promise<boolean>;
};

export async function deliverTerminalAlert(
  frame: string,
  deps: TerminalAlertDeliveryDependencies,
): Promise<void> {
  deps.journal(frame);
  const pointer = terminalAlertPointerFromFrame(frame);

  if (deps.notifyMcp) {
    await deps.notifyMcp(pointer);
    return;
  }
  if ((await deps.tmuxAvailable()) && (await deps.pasteTmux(pointer))) return;
  throw new Error('orchestrator unavailable');
}

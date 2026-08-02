import { createNotifyHandler } from './notify-handler';
import {
  deliverTerminalAlert,
  type JournalSink,
} from './terminal-alert-delivery';

type ProductionTerminalAlertNotifyDependencies = {
  journal: JournalSink;
  notifyChatId: () => string | null;
  relayHuman: (chatId: string, text: string) => void;
  acceptanceTimeoutMs?: number;
};

/** Exact production composition for /notify terminal-alert delivery. */
export function createProductionTerminalAlertNotifyHandler(
  deps: ProductionTerminalAlertNotifyDependencies,
) {
  return createNotifyHandler({
    notifyChatId: deps.notifyChatId,
    relayHuman: deps.relayHuman,
    relayInternal: (frame) =>
      deliverTerminalAlert(frame, {
        journal: deps.journal,
        acceptanceTimeoutMs: deps.acceptanceTimeoutMs,
      }),
  });
}

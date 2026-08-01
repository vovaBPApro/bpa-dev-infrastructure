export type TerminalAlertDeliveryDependencies = {
  journal: (frame: string) => void;
};

/**
 * Terminal alerts cross an out-of-band boundary exactly once: the daemon
 * journal. Never route them through MCP notifications or tmux. Both surfaces
 * are rendered in the pane that terminal-alert.ts watches, which makes any
 * in-band delivery (including an allegedly inert pointer) a feedback edge.
 */
export function deliverTerminalAlert(
  frame: string,
  deps: TerminalAlertDeliveryDependencies,
): void {
  deps.journal(frame);
}

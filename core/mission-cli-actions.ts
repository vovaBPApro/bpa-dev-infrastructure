export const missionCliActions = [
  ["mission", "create"], ["mission", "complete"], ["manager", "create"], ["lane", "create"],
  ["lane", "claim"], ["lane", "ack"], ["lane", "progress"],
  ["lane", "complete"], ["outbox", "enqueue"], ["status", undefined],
  // V3-3.10. Takes flags rather than positional arguments, so its "action" slot
  // is empty exactly as `status`'s is; see the flag-aware split in mission-cli.ts.
  ["usage", undefined],
] as const;

export function isMissionCliAction(group: string, action?: string): boolean {
  return missionCliActions.some(([knownGroup, knownAction]) => group === knownGroup && action === knownAction);
}

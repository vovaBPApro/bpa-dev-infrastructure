export const missionCliActions = [
  ["mission", "create"], ["mission", "complete"], ["manager", "create"], ["lane", "create"],
  ["lane", "claim"], ["lane", "ack"], ["lane", "progress"],
  ["lane", "complete"], ["outbox", "enqueue"], ["status", undefined],
] as const;

export function isMissionCliAction(group: string, action?: string): boolean {
  return missionCliActions.some(([knownGroup, knownAction]) => group === knownGroup && action === knownAction);
}

export const capabilities = [
  "inspect",
  "test",
  "commit",
  "push",
  "network",
  "docker",
  "worktree-reap",
  "service-ops",
  "land",
] as const;

export type Capability = (typeof capabilities)[number];

export const laneModes = ["sandboxed-lane", "trusted-executor"] as const;
export type LaneMode = (typeof laneModes)[number];

export const laneCapabilities: Record<LaneMode, ReadonlySet<Capability>> = {
  "sandboxed-lane": new Set(["inspect", "test", "commit"]),
  "trusted-executor": new Set(capabilities),
};

export type CapabilityDecision =
  | { allowed: true }
  | { allowed: false; verdict: `NO-GO capability=${string}` };

function noGo(capability: string): CapabilityDecision {
  return {
    allowed: false,
    verdict: `NO-GO capability=${capability || "unknown"}`,
  };
}

export function checkCapability(mode: string, capability: string): CapabilityDecision {
  if (!laneModes.includes(mode as LaneMode)) return noGo(capability);
  if (!capabilities.includes(capability as Capability)) return noGo(capability);
  if (!laneCapabilities[mode as LaneMode].has(capability as Capability)) return noGo(capability);
  return { allowed: true };
}

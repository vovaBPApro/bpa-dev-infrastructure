import { expect, test } from "bun:test";
import { checkCapability } from "./capabilities";

const sandboxedCapabilities = ["inspect", "test", "commit", "push"] as const;
const trustedOnlyCapabilities = ["network", "docker", "worktree-reap", "service-ops", "land"] as const;

test("sandboxed lanes may exercise local lane capabilities", () => {
  for (const capability of sandboxedCapabilities) {
    expect(checkCapability("sandboxed-lane", capability)).toEqual({ allowed: true });
  }
});

test("sandboxed lanes emit exact NO-GO evidence for trusted-only capabilities", () => {
  for (const capability of trustedOnlyCapabilities) {
    expect(checkCapability("sandboxed-lane", capability)).toEqual({
      allowed: false,
      verdict: `NO-GO capability=${capability}`,
    });
  }
});

test("trusted executors may exercise trusted capabilities", () => {
  for (const capability of trustedOnlyCapabilities) {
    expect(checkCapability("trusted-executor", capability)).toEqual({ allowed: true });
  }
});

test("unknown modes and capabilities fail closed", () => {
  expect(checkCapability("unknown-mode", "inspect")).toEqual({
    allowed: false,
    verdict: "NO-GO capability=inspect",
  });
  expect(checkCapability("trusted-executor", "unknown-capability")).toEqual({
    allowed: false,
    verdict: "NO-GO capability=unknown-capability",
  });
});

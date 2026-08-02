import { expect, test } from "bun:test";
import { join } from "node:path";
import { WATCHDOG_UNIT, verifyWatchdogSnapshot, type SystemdSnapshot } from "./watchdog-provenance";

const repoRoot = join(import.meta.dir, "..");
const fragment = `/etc/systemd/system/${WATCHDOG_UNIT}`;
const installed = Bun.file(join(repoRoot, "bootstrap/units/bpa-orchestrator-watchdog.service.in"))
  .text().then((text) => text.replaceAll("$INSTALL_ROOT", repoRoot).replaceAll("$ENV_FILE", "/etc/bpa/runtime.env"));
const base = (await installed);
const snapshot: SystemdSnapshot = {
  unitName: WATCHDOG_UNIT,
  invocationId: "abcdef0123456789abcdef0123456789",
  controlGroup: "/system.slice/bpa-orchestrator-watchdog.service",
  processCgroup: "/system.slice/bpa-orchestrator-watchdog.service",
  fragmentPath: fragment,
  activeState: "active",
};
const io = { read: () => base, realpath: () => fragment };

test("REGRESSION GAP-5 r5: tracked active systemd process authenticates producer provenance", () => {
  expect(verifyWatchdogSnapshot(snapshot, repoRoot, io)).toMatchObject({
    producerId: "bpa-orchestrator-watchdog",
    unitName: WATCHDOG_UNIT,
    invocationId: snapshot.invocationId,
  });
});

test.each([
  ["direct CLI", { processCgroup: "/user.slice/shell.scope" }],
  ["cross unit", { unitName: "copied.service" }],
  ["arbitrary invocation", { invocationId: "aaaaaaaa" }],
  ["inactive invocation", { activeState: "inactive" }],
  ["copied fragment", { fragmentPath: "/tmp/copied.service" }],
  ["cross-unit cgroup replay", { processCgroup: "/system.slice/other.service" }],
])("REGRESSION GAP-5 r5: %s remains UNMEASURED", (_name, mutation) => {
  expect(() => verifyWatchdogSnapshot({ ...snapshot, ...mutation }, repoRoot, io)).toThrow("UNMEASURED");
});

test("REGRESSION GAP-5 r5: symlinked and drifted installed units remain UNMEASURED", () => {
  expect(() => verifyWatchdogSnapshot(snapshot, repoRoot, { ...io, realpath: () => "/tmp/copied.service" })).toThrow("UNMEASURED");
  expect(() => verifyWatchdogSnapshot(snapshot, repoRoot, { ...io, read: () => `${base}\nEnvironment=DRIFT=1\n` })).toThrow("UNMEASURED");
});

test("REGRESSION GAP-5 r6: historical accounting does not require a fabricated process cgroup", () => {
  expect(verifyWatchdogSnapshot({ ...snapshot, processCgroup: undefined }, repoRoot, { ...io, requireProcessCgroup: false, historicalOneshot: true })).toMatchObject({
    invocationId: snapshot.invocationId,
  });
});

test("REGRESSION GAP-5 r6: historical accounting measures and rejects inactive oneshot state", () => {
  const historical = { ...snapshot, processCgroup: undefined };
  for (const mutation of [{ activeState: "inactive" }, { activeState: "failed" }]) {
    expect(() => verifyWatchdogSnapshot({ ...historical, ...mutation }, repoRoot, { ...io, requireProcessCgroup: false, historicalOneshot: true })).toThrow("UNMEASURED");
  }
});

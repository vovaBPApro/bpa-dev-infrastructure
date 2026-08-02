import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const WATCHDOG_UNIT = "bpa-orchestrator-watchdog.service";
const SYSTEMCTL = "/usr/bin/systemctl";

export type WatchdogProvenance = {
  producerId: "bpa-orchestrator-watchdog";
  unitName: typeof WATCHDOG_UNIT;
  unitFingerprint: string;
  invocationId: string;
  controlGroup: string;
};

export type SystemdSnapshot = {
  unitName: string;
  invocationId: string;
  controlGroup: string;
  fragmentPath: string;
  activeState: string;
  result?: string;
  execMainStatus?: string;
  processCgroup?: string;
};

type VerificationIo = {
  canonicalFragment?: string;
  read?: (path: string) => string;
  realpath?: (path: string) => string;
  requireProcessCgroup?: boolean;
  historicalOneshot?: boolean;
  expectedUnit?: string;
};

export function verifyWatchdogSnapshot(snapshot: SystemdSnapshot, repoRoot: string, io: VerificationIo = {}): WatchdogProvenance {
  const expectedUnit = io.expectedUnit ?? WATCHDOG_UNIT;
  if (snapshot.unitName !== expectedUnit) throw new Error("UNMEASURED: process is not the tracked watchdog unit");
  if (!/^[0-9a-f]{32}$/.test(snapshot.invocationId)) throw new Error("UNMEASURED: systemd invocation identity unavailable");
  if (io.historicalOneshot) {
    if (snapshot.activeState !== "activating" && snapshot.activeState !== "active") {
      throw new Error("UNMEASURED: watchdog producer epoch is not currently active");
    }
  } else if (snapshot.activeState !== "activating" && snapshot.activeState !== "active") throw new Error("UNMEASURED: watchdog unit is not active");
  if ((io.requireProcessCgroup ?? true) && (!snapshot.controlGroup || snapshot.processCgroup !== snapshot.controlGroup)) throw new Error("UNMEASURED: process cgroup is not the active unit cgroup");

  const canonicalFragment = io.canonicalFragment ?? `/etc/systemd/system/${expectedUnit}`;
  if (snapshot.fragmentPath !== canonicalFragment || (io.realpath ?? realpathSync)(snapshot.fragmentPath) !== canonicalFragment) {
    throw new Error("UNMEASURED: watchdog fragment is copied, linked, or outside the installed boundary");
  }
  const installed = (io.read ?? ((path) => readFileSync(path, "utf8")))(snapshot.fragmentPath);
  const exec = installed.match(/^ExecStart=\/usr\/bin\/bash (.+)\/orchestrator\/watchdog\.sh$/m);
  const environment = installed.match(/^Environment=ORCH_CONFIG_FILE=(.+)$/m);
  if (!exec || !environment) throw new Error("UNMEASURED: installed watchdog unit lacks tracked bindings");
  const installedRoot = exec[1];
  const template = readFileSync(join(repoRoot, "bootstrap/units/bpa-orchestrator-watchdog.service.in"), "utf8")
    .replaceAll("$INSTALL_ROOT", installedRoot)
    .replaceAll("$ENV_FILE", environment[1])
    .replaceAll(WATCHDOG_UNIT, expectedUnit);
  if (installed !== template) throw new Error("UNMEASURED: installed watchdog unit digest differs from the tracked render");

  return {
    producerId: "bpa-orchestrator-watchdog",
    unitName: expectedUnit as typeof WATCHDOG_UNIT,
    unitFingerprint: createHash("sha256").update(installed).digest("hex"),
    invocationId: snapshot.invocationId,
    controlGroup: snapshot.controlGroup,
  };
}

function properties(unitName: string): Record<string, string> {
  const result = Bun.spawnSync([SYSTEMCTL, "show", unitName,
    "--property=InvocationID", "--property=ControlGroup", "--property=FragmentPath", "--property=ActiveState",
    "--property=Result", "--property=ExecMainStatus",
    "--no-pager"]);
  if (result.exitCode !== 0) throw new Error("UNMEASURED: systemd did not authenticate the watchdog unit");
  return Object.fromEntries(result.stdout.toString().trim().split("\n").map((line) => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1)];
  }));
}

export function currentWatchdogProvenance(): WatchdogProvenance {
  const repoRoot = resolve(dirname(import.meta.dir));
  const unitName = process.env.ORCH_WATCHDOG_UNIT ?? WATCHDOG_UNIT;
  const fragmentPath = process.env.ORCH_WATCHDOG_FRAGMENT ?? `/etc/systemd/system/${unitName}`;
  const processCgroup = readFileSync("/proc/self/cgroup", "utf8").split("\n")
    .map((line) => line.slice(line.lastIndexOf(":") + 1)).find((path) => basename(path) === unitName);
  if (!processCgroup) throw new Error("UNMEASURED: direct CLI is outside the watchdog systemd cgroup");
  const value = properties(unitName);
  return verifyWatchdogSnapshot({
    unitName,
    invocationId: value.InvocationID ?? "",
    controlGroup: value.ControlGroup ?? "",
    fragmentPath: value.FragmentPath ?? "",
    activeState: value.ActiveState ?? "",
    result: value.Result ?? "",
    execMainStatus: value.ExecMainStatus ?? "",
    processCgroup,
  }, repoRoot, { canonicalFragment: fragmentPath, expectedUnit: unitName });
}

export function currentInstalledWatchdogProvenance(storedInvocationId: string): WatchdogProvenance {
  const repoRoot = resolve(dirname(import.meta.dir));
  const unitName = process.env.ORCH_WATCHDOG_UNIT ?? WATCHDOG_UNIT;
  const fragmentPath = process.env.ORCH_WATCHDOG_FRAGMENT ?? `/etc/systemd/system/${unitName}`;
  const value = properties(unitName);
  const currentInvocationId = value.InvocationID ?? "";
  if (currentInvocationId !== storedInvocationId) throw new Error("UNMEASURED: stored watchdog producer epoch is stale");
  return verifyWatchdogSnapshot({
    unitName,
    invocationId: currentInvocationId,
    controlGroup: value.ControlGroup ?? "",
    fragmentPath: value.FragmentPath ?? "",
    activeState: value.ActiveState ?? "",
    result: value.Result ?? "",
    execMainStatus: value.ExecMainStatus ?? "",
  }, repoRoot, { canonicalFragment: fragmentPath, expectedUnit: unitName, requireProcessCgroup: false, historicalOneshot: true });
}

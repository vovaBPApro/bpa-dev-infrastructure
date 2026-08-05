// ── What this timer measures ────────────────────────────────────────────────
//
// IDLENESS, not shortfall. The lane cap — its number and the ruling that
// declares it, both read from instance/params.yaml rather than written here
// (workboard V3-5.10) — leaves HR-2342's framing standing: "a ceiling, not a
// target: fewer
// is allowed whenever the work does not need them." HR-2398 scopes that cap per
// repository. A backstop that installs the ceiling as a floor turns every lane
// count the ruling expressly permits into a permanent fault, and sub-floor IS
// the normal state, so it would nudge forever. That is exactly what `floor: 10`
// did here (audit F1): every census under ten read as below floor. Note which
// way a raise cuts — a wider cap widens the permitted band, so the fault
// threshold stays at zero rather than rising with the cap.
//
// The semantics are not re-derived here. `orchestrator/fleet/fleet-nudge.sh`
// landed them (workboard V3-2.11 B3, twice reviewed) and this file is the same
// rule in the daemon, knob for knob:
//
//   running < wake_below   the fleet is doing NOTHING while work remains. Nudge.
//   running < target       below a capacity-derived width. DISABLED by default.
//   otherwise              allowed by HR-2342. Silent.
export type LaneUnit = { name: string; active: boolean };

export type FleetConfig = {
  // The HR-2342 ceiling, quoted to the orchestrator so it knows how wide it may
  // go. It is NOT a trigger: nothing here compares the lane count against it.
  // `null` when the params file could not be read — an unknown cap is omitted
  // from the message rather than invented.
  cap: number | null;
  // The ruling id quoted beside the cap, read from `fleet.declared_by` and never
  // typed here. It was a literal `HR-2456`, then a literal `HR-2538`, each
  // hand-retyped at a cap change in this file and in fleet-nudge.sh together —
  // right only while someone remembered both. `null` when the params file could
  // not be read, and then the sentence is dropped rather than half-quoted.
  declaredBy: string | null;
  wakeBelow: number;
  target: number;
  intervalMs: number;
};

function knob(fleet: string, key: string, fallback: number): number {
  const raw = fleet.match(new RegExp(`^\\s+${key}:\\s*(\\d+(?:\\.\\d+)?)`, 'm'))?.[1];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function parseFleetConfig(yaml: string): FleetConfig {
  const fleet = yaml.match(/^fleet:\s*\n((?:^[ \t]+.*(?:\n|$))*)/m)?.[1] ?? '';
  const capRaw = fleet.match(/^\s+cap:\s*(\d+)/m)?.[1];
  const cap = capRaw === undefined ? null : Number(capRaw);
  const declaredRaw = fleet.match(/^\s+declared_by:\s*([^#\n]+)/m)?.[1]?.trim();
  const declaredBy = declaredRaw && /^HR-\d/.test(declaredRaw) ? declaredRaw : null;
  // Never zero. `running < 0` is unreachable, so a zero here silently deletes
  // the severe tier and the backstop can never fire — the same defect
  // fleet-nudge.sh clamps against by name.
  const wakeBelow = Math.max(1, Math.trunc(knob(fleet, 'wake_below', 1)));
  // The seam for the capacity-derived budget (workboard V3-0.34), deliberately
  // OFF (0) by default: no measured host capacity exists yet, and installing
  // another underived constant is the defect that row exists to end. Replacing
  // an underived 10 with an underived 3 would re-commit it.
  const target = Math.max(0, Math.trunc(knob(fleet, 'target', 0)));
  const minutes = knob(fleet, 'keepalive_interval_minutes', 15);
  return {
    cap: cap !== null && Number.isFinite(cap) && cap > 0 ? cap : null,
    declaredBy,
    wakeBelow,
    target,
    intervalMs: minutes > 0 ? minutes * 60_000 : 900_000,
  };
}

export function parseSystemdLaneUnits(output: string): LaneUnit[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const fields = line.split(/\s+/);
      if (!/^lane-[^\s]+\.service$/.test(fields[0] ?? '') || fields.length < 4) {
        return [];
      }
      return [{ name: fields[0], active: fields[2] === 'active' }];
    });
}

// The open-work gate used to live here as a second board parser, and it read
// the **v2 bullet board** (`## Open`, `- **`). The v3 board is a markdown table,
// so it answered `false` on the real board and the timer backstop had never
// fired once — proven by execution and by an all-time-empty journal (audit F4).
// F1 (the wrong floor) and F4 (the comparison never happening) had been hiding
// each other.
//
// It is deleted rather than repaired: "what counts as open work" is a rule, and
// a rule with two implementations drifts. `orchestrator/fleet/fleet-nudge.sh
// --count-open` is the one home for it — a deliberately side-effect-free
// diagnostic (it runs before the heartbeat trap is armed, so querying it cannot
// make a dead watchdog look alive), POSIX-clean under mawk, and fail-closed on a
// board it cannot read. The daemon asks it instead of guessing.
export type OpenWorkCount = number | null; // null = the board could not be counted

type AutonomyDelivery = {
  tmuxAvailable: () => Promise<boolean>;
  paste: (text: string) => Promise<boolean>;
  log: (message: string) => void;
};

/** Reject unless tmux acknowledges the paste so callers retain pending work. */
export async function deliverAutonomyNudge(
  message: string,
  delivery: AutonomyDelivery,
): Promise<void> {
  if (!(await delivery.tmuxAvailable())) {
    delivery.log('autonomy nudge deferred: tmux unavailable');
    throw new Error('autonomy nudge not delivered: tmux unavailable');
  }
  const ok = await delivery.paste(
    `<channel source="autonomy" audience="orchestrator">${message}</channel>`,
  );
  if (!ok) {
    delivery.log(`autonomy nudge failed: ${message}`);
    throw new Error('autonomy nudge not delivered: paste failed');
  }
  delivery.log(`autonomy nudge delivered: ${message}`);
}

type KeepaliveOptions = {
  fleet: FleetConfig;
  countOpenWork: () => OpenWorkCount | Promise<OpenWorkCount>;
  listUnits: () => LaneUnit[] | Promise<LaneUnit[]>;
  nudge: (message: string) => Promise<void>;
};

/** Independent event and timer paths which share only their delivery method. */
export class AutonomyKeepalive {
  private previousRunning: Set<string> | null = null;

  constructor(private readonly opts: KeepaliveOptions) {}

  async eventTick(): Promise<void> {
    const units = await this.opts.listUnits();
    const running = new Set(
      units.filter((unit) => unit.active).map((unit) => unit.name),
    );
    if (this.previousRunning) {
      const finished: string[] = [];
      for (const name of this.previousRunning) {
        if (!running.has(name)) {
          finished.push(name.replace(/^lane-/, '').replace(/\.service$/, ''));
        }
      }
      if (finished.length > 0) {
        await this.opts.nudge(
          `lane ${finished.join(', ')} finished; inspect evidence and continue dispatch`,
        );
      }
    }
    this.previousRunning = running;
  }

  async timerTick(): Promise<void> {
    const { cap, declaredBy, wakeBelow, target } = this.opts.fleet;
    const units = await this.opts.listUnits();
    const running = units.filter((unit) => unit.active).length;
    const idle = running < wakeBelow;
    const belowTarget = target > 0 && running < target;
    // 1 and 2 running lanes at the default settings land here and the backstop
    // stays silent: HR-2342 permits them, so they are not a fault and must not
    // be reported as one.
    if (!idle && !belowTarget) return;

    const open = await this.opts.countOpenWork();
    // A board that cannot be counted must never read as "no work" — that
    // inversion is what made this backstop inert. Nudging the orchestrator is
    // the cheap direction; this path reaches the orchestrator's tmux only,
    // never the operator.
    if (open === null) {
      await this.opts.nudge(
        `${running} running and the workboard could not be counted; check the board and the fleet-nudge counter`,
      );
      return;
    }
    // Nothing left to dispatch. Asking the operator what comes next is the one
    // operator-facing outcome, and it belongs to fleet-nudge.sh, which
    // deduplicates it; a second unguarded channel for it is a second alarm.
    if (open === 0) return;

    // Both halves are read, or the sentence is not said. Quoting a number
    // without the ruling that declares it, or a ruling id nothing checked
    // against the ledger, is the drift this was rewritten to remove.
    const ceiling =
      cap === null || declaredBy === null
        ? ''
        : ` ${declaredBy} caps parallel lanes at ${cap} — a ceiling, not a target.`;
    await this.opts.nudge(
      idle
        ? `fleet idle: ${running} running with ${open} open workboard rows; dispatch or inspect blocked lanes.${ceiling}`
        : `fleet below target: ${running}/${target} running with ${open} open workboard rows; dispatch more work.${ceiling}`,
    );
  }
}

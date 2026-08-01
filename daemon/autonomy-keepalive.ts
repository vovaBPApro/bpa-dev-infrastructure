export type LaneUnit = { name: string; active: boolean };

export type FleetConfig = { floor: number; intervalMs: number };

export function parseFleetConfig(yaml: string): FleetConfig {
  const fleet = yaml.match(/^fleet:\s*\n((?:^[ \t]+.*(?:\n|$))*)/m)?.[1] ?? '';
  const floor = Number(fleet.match(/^\s+floor:\s*(\d+)/m)?.[1] ?? 1);
  const minutes = Number(
    fleet.match(/^\s+keepalive_interval_minutes:\s*(\d+(?:\.\d+)?)/m)?.[1] ?? 15,
  );
  return {
    floor: Number.isFinite(floor) && floor > 0 ? floor : 1,
    intervalMs:
      Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 900_000,
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

export function hasOpenWorkboardRows(markdown: string): boolean {
  const open = markdown.match(/^## Open\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m)?.[1] ?? '';
  return open
    .split('\n')
    .filter((line) => /^- \*\*/.test(line))
    .some((line) => !/\bCLOSED\b/i.test(line));
}

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
  floor: number;
  readWorkboard: () => string;
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
    const units = await this.opts.listUnits();
    const running = units.filter((unit) => unit.active).length;
    if (running >= this.opts.floor) return;
    if (!hasOpenWorkboardRows(this.opts.readWorkboard())) return;
    await this.opts.nudge(
      `fleet below floor: ${running}/${this.opts.floor} running with open workboard rows; dispatch more work`,
    );
  }
}

export type LaneUnit = { name: string; active: boolean };

/** Retry only unacknowledged recipients within one fleet-drop episode. */
export async function deliverFleetAlert<ChatId>(
  message: string,
  chatIds: ChatId[],
  acknowledged: Set<ChatId>,
  send: (chatId: ChatId, message: string) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    chatIds
      .filter((chatId) => !acknowledged.has(chatId))
      .map(async (chatId) => {
        await send(chatId, message);
        acknowledged.add(chatId);
      }),
  );
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('fleet alert was not delivered to every Human chat');
  }
}

export type FleetConfig = {
  floor: number;
  notifyHumanBelow: number;
  intervalMs: number;
};

export function parseFleetConfig(yaml: string): FleetConfig {
  const fleet = yaml.match(/^fleet:\s*\n((?:^[ \t]+.*(?:\n|$))*)/m)?.[1] ?? '';
  const floor = Number(fleet.match(/^\s+floor:\s*(\d+)/m)?.[1] ?? 1);
  const notifyHumanBelow = Number(
    fleet.match(/^\s+notify_human_below:\s*(\d+)/m)?.[1] ?? 1,
  );
  const minutes = Number(
    fleet.match(/^\s+keepalive_interval_minutes:\s*(\d+(?:\.\d+)?)/m)?.[1] ?? 15,
  );
  return {
    floor: Number.isFinite(floor) && floor > 0 ? floor : 1,
    notifyHumanBelow:
      Number.isFinite(notifyHumanBelow) && notifyHumanBelow > 0
        ? notifyHumanBelow
        : 1,
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
  notifyHumanBelow: number;
  readWorkboard: () => string;
  listUnits: () => LaneUnit[];
  nudge: (message: string) => Promise<void>;
  alertHuman: (message: string) => Promise<void>;
  resetHumanAlert?: () => void;
};

/** Independent event and timer paths which share only their delivery method. */
export class AutonomyKeepalive {
  private previousRunning: Set<string> | null = null;
  private humanAlertActive = false;
  private humanAlertAcknowledged = false;

  constructor(private readonly opts: KeepaliveOptions) {}

  async eventTick(): Promise<void> {
    const running = new Set(
      this.opts
        .listUnits()
        .filter((unit) => unit.active)
        .map((unit) => unit.name),
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
    let running: number | null = null;
    let workboard: string | null = null;
    const unknown: string[] = [];
    try {
      running = this.opts.listUnits().filter((unit) => unit.active).length;
    } catch {
      unknown.push('systemd unit census failed');
    }
    try {
      workboard = this.opts.readWorkboard();
    } catch {
      unknown.push('workboard read failed');
    }

    if (
      unknown.length > 0 ||
      running === null ||
      running < this.opts.notifyHumanBelow
    ) {
      if (!this.humanAlertActive) {
        this.humanAlertActive = true;
        this.humanAlertAcknowledged = false;
      }
      if (!this.humanAlertAcknowledged) {
        await this.opts.alertHuman(
          unknown.length > 0
            ? `fleet status unknown — ${unknown.join(' and ')}; treating as below alert threshold (${this.opts.notifyHumanBelow})`
            : `${running} lanes running — not enough work in flight (alert threshold: ${this.opts.notifyHumanBelow})`,
        );
        this.humanAlertAcknowledged = true;
      }
    } else {
      if (this.humanAlertActive) this.opts.resetHumanAlert?.();
      this.humanAlertActive = false;
      this.humanAlertAcknowledged = false;
    }
    if (unknown.length > 0 || running === null || workboard === null) return;
    if (running >= this.opts.floor) return;
    if (!hasOpenWorkboardRows(workboard)) return;
    await this.opts.nudge(
      `fleet below floor: ${running}/${this.opts.floor} running with open workboard rows; dispatch more work`,
    );
  }
}

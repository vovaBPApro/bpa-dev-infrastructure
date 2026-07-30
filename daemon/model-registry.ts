// Orchestrator model selection for the Telegram `/model` command.
//
// Why this exists: the agreed architecture (instance/handoff-oldorch-2026-07-30.md
// §1) is a THIN Claude top orchestrator on a lean tier with Fable as an
// ESCALATION tier — switch up for a hairy incident, switch back down after.
// There was no mechanism to switch at all, so the posture was unimplementable
// and `/model fable` fell through to the orchestrator as plain text.
//
// Two invariants shape everything below.
//
// 1. Pins are PROVIDER-SCOPED. `orchestrator/runtime.env` is SOURCED by
//    launch.sh, so every value there overrides the environment the daemon
//    exports — including the per-launch `ORCH_PROVIDER='…' launch.sh start`.
//    Writing ORCH_PROVIDER there would hijack the live orchestrator on its next
//    restart and desynchronise it from `binding.provider`, which decideRelay
//    then rejects as `provider_mismatch` — the operator's only channel goes
//    silent. Writing the legacy provider-agnostic ORCH_MODEL is nearly as bad:
//    it hands a Claude model to codex the moment the provider flips. So the
//    allowlist below is the whole write surface, and it is enforced in the
//    upsert rather than at the call site.
//
// 2. The switch is RELAUNCH-SCOPED, and every reply says so. The model is an
//    argv element of a running CLI process (`claude --model …`); nothing can
//    change it in place. Silently doing nothing until an unrelated restart
//    would be worse than no command, so each reply names the exact next step
//    (`/restart` or `/start_<provider>`) and what is still running until then.

export type ModelProvider = 'claude' | 'codex';

/**
 * The ONLY environment keys `/model` may write into runtime.env. Provider-
 * scoped by construction: see invariant 1 above.
 */
export const PINNABLE_ENV_KEYS = [
  'ORCH_CLAUDE_MODEL',
  'ORCH_CODEX_MODEL',
] as const;

export type PinnableEnvKey = (typeof PINNABLE_ENV_KEYS)[number];

export type ModelChoice = {
  /** The token the operator types: `/model fable`. */
  name: string;
  provider: ModelProvider;
  /** The exact value handed to the CLI's `--model`. */
  model: string;
  envKey: PinnableEnvKey;
  /** Where this tier sits in the escalation posture. */
  role: string;
};

// A CLOSED catalog. An unknown name is an error, never a silent pass-through:
// a typo that reached the CLI would surface as a provider crash in a detached
// tmux pane with no operator-visible cause. Extending it is a one-line edit —
// but each entry is a model verified to be runnable by this installation's
// accounts, so adding one is an evidence step, not a guess.
export const MODEL_CATALOG: readonly ModelChoice[] = [
  {
    name: 'sonnet',
    provider: 'claude',
    model: 'claude-sonnet-5',
    envKey: 'ORCH_CLAUDE_MODEL',
    role: 'lean — дешевий thin top, рутинна маршрутизація',
  },
  {
    name: 'opus',
    provider: 'claude',
    model: 'claude-opus-5',
    envKey: 'ORCH_CLAUDE_MODEL',
    role: 'default — базовий рівень (пін у launch.sh)',
  },
  {
    name: 'fable',
    provider: 'claude',
    model: 'claude-fable-5',
    envKey: 'ORCH_CLAUDE_MODEL',
    role: 'escalation — важкий інцидент, потім назад униз',
  },
  {
    name: 'sol',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    envKey: 'ORCH_CODEX_MODEL',
    role: 'fallback — Codex top (instance/params.yaml)',
  },
];

/**
 * Resolve an operator token to a catalog entry. Accepts the short name or the
 * exact model id, case-insensitively. Returns null for anything else — the
 * caller must report the error, never fall back to a default.
 */
export function resolveModelChoice(raw: string): ModelChoice | null {
  const needle = raw.trim().toLowerCase();
  if (!needle) return null;
  return (
    MODEL_CATALOG.find(
      (c) => c.name === needle || c.model.toLowerCase() === needle,
    ) ?? null
  );
}

// runtime.env is SOURCED, so an unvalidated value is shell input arriving from
// Telegram. Today every value comes from the closed catalog above, so this can
// never fire — which is exactly why it must stay: it is the guard that keeps a
// future caller from turning the pin file into an execution vector.
const SAFE_ENV_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Return `existing` with `key=value` set exactly once.
 *
 * An existing live assignment is replaced IN PLACE (a second appended line
 * would silently win at source time and make the file lie about itself).
 * Commented documentation lines are left untouched.
 *
 * Throws on any key outside {@link PINNABLE_ENV_KEYS} or any value that would
 * not survive `source` as a literal.
 */
export function upsertEnvAssignment(
  existing: string,
  key: string,
  value: string,
): string {
  if (!(PINNABLE_ENV_KEYS as readonly string[]).includes(key)) {
    throw new Error(
      `refusing to write ${key} into runtime.env: only ${PINNABLE_ENV_KEYS.join(
        ', ',
      )} are provider-scoped and safe to pin`,
    );
  }
  if (!SAFE_ENV_VALUE.test(value)) {
    throw new Error(
      `refusing to write an unsafe runtime.env value for ${key}: ${JSON.stringify(
        value,
      )}`,
    );
  }

  const assignment = `${key}=${value}`;
  const live = new RegExp(`^${key}=`);
  const lines = existing.length ? existing.split('\n') : [];
  let replaced = false;
  const out = lines.map((line) => {
    if (!replaced && live.test(line)) {
      replaced = true;
      return assignment;
    }
    return line;
  });

  if (!replaced) {
    // Trim trailing blank lines so the appended pin does not drift away from
    // the content over repeated writes.
    while (out.length && out[out.length - 1]!.trim() === '') out.pop();
    if (out.length) out.push('');
    out.push('# Pinned by the Telegram /model command.');
    out.push(assignment);
  }

  return out.join('\n').replace(/\n*$/, '\n');
}

export type LauncherModelState = {
  provider: string;
  configFile: string;
  claudeModel: string;
  codexModel: string;
};

/**
 * Parse `launch.sh model`. The launcher is the single source of truth for what
 * a launch would actually run — duplicating its precedence chain here would
 * give the operator a confident report of a model that is not the one starting.
 * A partial or unparseable report yields null so the caller reports NO-GO
 * rather than a plausible-looking guess.
 */
export function parseLauncherModelState(
  stdout: string,
): LauncherModelState | null {
  const fields = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const provider = fields.get('provider');
  const configFile = fields.get('config_file');
  const claudeModel = fields.get('claude_model');
  const codexModel = fields.get('codex_model');
  if (!provider || !configFile || !claudeModel || !codexModel) return null;
  return { provider, configFile, claudeModel, codexModel };
}

function catalogLines(): string {
  return MODEL_CATALOG.map(
    (c) => `  /model ${c.name} — ${c.model} (${c.provider}) · ${c.role}`,
  ).join('\n');
}

const RELAUNCH_NOTE =
  'Зміна моделі застосовується НЕ миттєво: модель — це аргумент запущеного ' +
  'CLI-процесу, тож вона діє з наступного старту оркестратора.';

/** `/model` with no argument: what is running now + the full vocabulary. */
export function formatModelReport(args: {
  liveProvider: ModelProvider | null;
  state: LauncherModelState | null;
}): string {
  const { liveProvider, state } = args;
  const lines: string[] = ['🧠 Модель оркестратора', ''];

  if (!state) {
    lines.push(
      'NO-GO: не вдалося прочитати `launch.sh model` — поточну модель ' +
        'підтвердити нічим. Пін нижче все одно можна виставити, але перевір ' +
        'launch.sh перед тим, як покладатись на нього.',
    );
  } else {
    const runningModel =
      liveProvider === 'codex' ? state.codexModel : state.claudeModel;
    if (liveProvider) {
      lines.push(`Зараз працює: ${liveProvider} — ${runningModel}`);
    } else {
      lines.push(
        'Сесія не запущена. Наступний старт візьме:',
        `  /start_claude → ${state.claudeModel}`,
        `  /start_codex  → ${state.codexModel}`,
      );
    }
    if (liveProvider) {
      lines.push(
        `Інший провайдер: ${liveProvider === 'codex' ? 'claude' : 'codex'} — ` +
          `${liveProvider === 'codex' ? state.claudeModel : state.codexModel}`,
      );
    }
    lines.push(`Пін-файл: ${state.configFile}`);
  }

  lines.push('', 'Доступні:', catalogLines(), '', RELAUNCH_NOTE);
  return lines.join('\n');
}

/** `/model <unknown>`: refuse, and hand back the whole vocabulary. */
export function formatUnknownModel(raw: string): string {
  return [
    `❌ Невідома модель: \`${raw.trim()}\``,
    '',
    'Нічого не змінено. Доступні:',
    catalogLines(),
  ].join('\n');
}

/** `/model <valid>`: what was pinned, what is still running, what applies it. */
export function formatModelSelection(args: {
  choice: ModelChoice;
  liveProvider: ModelProvider | null;
  sessionAlive: boolean;
  previousModel: string | null;
}): string {
  const { choice, liveProvider, sessionAlive, previousModel } = args;
  const lines: string[] = [
    `✅ Закріплено: ${choice.provider} — ${choice.model}`,
    `Записано як ${choice.envKey} у orchestrator/runtime.env — пін переживе ` +
      'рестарт демона й оркестратора.',
    '',
  ];

  const sameProvider = sessionAlive && liveProvider === choice.provider;

  if (sameProvider) {
    lines.push(
      RELAUNCH_NOTE,
      previousModel
        ? `Поточна сесія далі працює на ${previousModel}.`
        : 'Поточна сесія далі працює на попередній моделі.',
      'Щоб застосувати зараз — надішли /restart (це підніме оркестратора ' +
        'наново на новій моделі).',
    );
  } else if (sessionAlive && liveProvider && liveProvider !== choice.provider) {
    lines.push(
      RELAUNCH_NOTE,
      `Зараз активний інший провайдер (${liveProvider}), тож ця модель ` +
        `застосується, коли піднімеш /start_${choice.provider}.`,
    );
  } else {
    lines.push(
      RELAUNCH_NOTE,
      `Сесія не запущена — модель застосується на /start_${choice.provider}.`,
    );
  }

  return lines.join('\n');
}

/** Build a child-process environment without inherited live control-plane state. */
export function isolatedTestEnv(
  overrides: Record<string, string>,
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (key.startsWith('ORCH_')) continue;
    if (key.startsWith('TELEGRAM_')) continue;
    if (key.startsWith('INFRA_')) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "preview.ts"), "utf8");

describe("preview isolation contract", () => {
  test("reserves production and daemon ports", () => {
    expect(source).toContain("port === 3000 || port === 4822");
    expect(source).toContain('"-p", `127.0.0.1:${port}:${containerPort}`');
  });
  test("uses isolated state, database, and no integrations", () => {
    expect(source).toContain("crypto.randomUUID()");
    expect(source).toContain('"APP_STATE_DIR=/preview-state"');
    expect(source).toContain('"INTEGRATIONS_MODE=NOT-CONFIGURED"');
    expect(source).toContain('"OAUTH_CALLBACKS_ENABLED=false"');
    expect(source).not.toContain("/srv/projects/agentic-bpa");
    expect(source).not.toContain("/var/lib/agentic-bpa");
  });
  test("sets hard resource and process limits", () => {
    expect(source).toContain('PREVIEW_APP_CPUS ?? "0.75"');
    expect(source).toContain('PREVIEW_DB_CPUS ?? "0.25"');
    expect(source).toContain('"--pids-limit", "256"');
    expect(source).toContain('"--pids-limit", "128"');
    expect(source).toContain('"--health-cmd"');
    expect(source).toContain('=== "healthy"');
  });
  test("generates callback denial before the preview proxy", () => {
    const callback = source.indexOf("/api/integrations/*/callback");
    const proxy = source.indexOf("reverse_proxy 127.0.0.1:${port}");
    expect(callback).toBeGreaterThan(0);
    expect(proxy).toBeGreaterThan(callback);
  });
});

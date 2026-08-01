#!/usr/bin/env bun
import { readFileSync } from "node:fs";

type Role = { login: boolean; superuser: boolean; bypassRls: boolean };
type Declaration = {
  database: string;
  owner: string;
  roles: Record<string, Role>;
  schemas: Record<string, { owner: string; grants: Record<string, string[]> }>;
};

const root = new URL("../", import.meta.url).pathname;
const declarationPath = process.env.DB_ACCESS_DECLARATION ?? `${root}database/access.declaration.json`;
const declaration = JSON.parse(readFileSync(declarationPath, "utf8")) as Declaration;
const apply = process.argv.includes("--apply");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DB-GRANT ALARM: DATABASE_URL is not configured");
const connection = new URL(databaseUrl);
if (connection.protocol !== "postgres:" && connection.protocol !== "postgresql:") {
  throw new Error("DB-GRANT ALARM: DATABASE_URL must use postgres:// or postgresql://");
}
const pgEnv = {
  ...process.env,
  PGHOST: connection.hostname,
  PGPORT: connection.port || "5432",
  PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
  PGUSER: decodeURIComponent(connection.username),
  PGPASSWORD: decodeURIComponent(connection.password),
};

const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function psql(sql: string): Promise<string> {
  const proc = Bun.spawn(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], {
    env: pgEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`DB-GRANT ALARM: psql failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function reconcile(): Promise<void> {
  const statements: string[] = [];
  for (const [name, role] of Object.entries(declaration.roles)) {
    const exists = await psql(`SELECT 1 FROM pg_roles WHERE rolname=${literal(name)}`);
    const attrs = `${role.login ? "LOGIN" : "NOLOGIN"} ${role.superuser ? "SUPERUSER" : "NOSUPERUSER"} ${role.bypassRls ? "BYPASSRLS" : "NOBYPASSRLS"}`;
    statements.push(exists ? `ALTER ROLE ${ident(name)} ${attrs}` : `CREATE ROLE ${ident(name)} ${attrs}`);
  }
  statements.push(`ALTER DATABASE ${ident(declaration.database)} OWNER TO ${ident(declaration.owner)}`);
  for (const [schema, expected] of Object.entries(declaration.schemas)) {
    statements.push(`ALTER SCHEMA ${ident(schema)} OWNER TO ${ident(expected.owner)}`);
    for (const [role, grants] of Object.entries(expected.grants)) {
      statements.push(`GRANT ${grants.join(", ")} ON SCHEMA ${ident(schema)} TO ${ident(role)}`);
    }
  }
  await psql(`BEGIN; ${statements.join("; ")}; COMMIT;`);
}

async function drift(): Promise<string[]> {
  const failures: string[] = [];
  const current = await psql("SELECT current_database()")
  if (current !== declaration.database) failures.push(`database expected=${declaration.database} actual=${current}`);
  const dbOwner = await psql("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")
  if (dbOwner !== declaration.owner) failures.push(`database owner expected=${declaration.owner} actual=${dbOwner || "missing"}`);
  for (const [name, expected] of Object.entries(declaration.roles)) {
    const actual = await psql(`SELECT rolcanlogin||'|'||rolsuper||'|'||rolbypassrls FROM pg_roles WHERE rolname=${literal(name)}`);
    const wanted = `${expected.login}|${expected.superuser}|${expected.bypassRls}`;
    if (actual !== wanted) failures.push(`role ${name} expected=${wanted} actual=${actual || "missing"}`);
  }
  for (const [schema, expected] of Object.entries(declaration.schemas)) {
    const owner = await psql(`SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=${literal(schema)}`);
    if (owner !== expected.owner) failures.push(`schema ${schema} owner expected=${expected.owner} actual=${owner || "missing"}`);
    for (const [role, grants] of Object.entries(expected.grants)) {
      for (const grant of grants) {
        const present = await psql(`SELECT has_schema_privilege(${literal(role)}, ${literal(schema)}, ${literal(grant)})`);
        if (present !== "t") failures.push(`schema ${schema} role=${role} missing=${grant}`);
      }
    }
  }
  return failures;
}

if (apply) await reconcile();
const failures = await drift();
if (failures.length) {
  for (const failure of failures) console.error(`DB-GRANT ALARM: ${failure}`);
  if (process.env.DB_GRANT_NOTIFY_URL) {
    await fetch(process.env.DB_GRANT_NOTIFY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `DB-GRANT ALARM: ${failures.join("; ")}` }) }).catch(() => undefined);
  }
  process.exit(1);
}
console.log(`DB-GRANT OK database=${declaration.database}`);

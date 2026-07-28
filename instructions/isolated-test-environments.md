# Isolated Test Environments

## Binding rules

- Give each code lane an isolated checkout and dependency output. Never install, build, migrate, or rewrite dependencies in the canonical working tree to run a lane test.
- Tests that exercise durable data or database logic use a real, per-lane disposable database. Shared test databases are forbidden for parallel lanes.
- A lane owns its slot, database, ports, and container project through a lease or reservation. Do not permit two writers in one checkout, slot, database, or mutable stand.
- Create isolated resources before the lock and destroy only the named resources on release. Cleanup must be idempotent and report residual containers, networks, volumes, databases, processes, and temporary files.
- Bound real-database concurrency to the host resource budget; serialize lanes when the available slots, memory, disk, or database capacity require it.
- Never publish test containers or test databases on public interfaces. Bind to private networks or loopback and use explicit, authenticated test routes where a route is needed. Accidental public exposure is a security incident, not a test convenience.
- Use `stand/` for disposable Compose-based isolation and its matrix/acceptance checks; use `soak/` to exercise concurrent durable-state and landing behavior. A missing or incomplete environment is `NO-GO`, not permission to substitute a shared service.

Why: realistic locks require production-like dependencies, while isolation prevents one lane's setup or teardown from corrupting another lane or a live system.

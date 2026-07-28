# Pinned daemon import review

Verdict: **REJECT as a compatibility snapshot**.

The imported TypeScript sources and replay fixture are useful, but the import
is not a faithful runnable snapshot of the pinned reference. The inventory
declares these required paths, yet they are absent from commit `7ebe9ce3`:

- `templates/daemon/package.json`
- `templates/daemon/bun.lock`
- `tools/claude-telegram-daemon/package.json`
- `tools/claude-telegram-daemon/bun.lock`
- `migration-prep/verify_reference_daemon.sh`

Thus the reference tests cannot be run from the imported tree and provenance
cannot be mechanically re-verified there. No new runtime claims are made;
`server.ts`/`relay.ts` remain read-only source, not integrated production code.

Next gates: import the missing manifests/lockfiles unchanged (dependency gate),
add the verifier, run Bun tests at the pinned SHA, then execute differential
replay and the Docker health/auth/resource/manifest/rollback matrix.

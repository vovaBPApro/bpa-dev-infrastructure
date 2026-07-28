# Pinned reference daemon snapshot

This directory is a read-only compatibility snapshot from
`telegram-dev-daemon` `4cdf3c70c6ec9d28608d7921b4dd4dd31ce340aa`.
It is not production wiring and must not be edited in place. Changes belong in
the new runtime and are compared against this snapshot.

The four package/lock files are included byte-for-byte as provenance inputs;
they are not installed or mutated by this snapshot.

Verify provenance from the repository root with:

```bash
migration-prep/verify_reference_daemon.sh
```

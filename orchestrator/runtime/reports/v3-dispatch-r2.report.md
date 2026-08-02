commit: 563554e8ca349c298d885767991882b3be6ccba3
tests: `LOCK_SHA=HEAD ./tests/red-before-dispatch.sh d016f05...` exit 1; `./tests/red-before-dispatch.sh HEAD` and `bun test orchestrator/dispatcher.test.ts vendor/old-contracts/dispatcher-parity.test.ts` exit 0 (7 pass)
secret-scan: NO-GO (canonical `gate/land-lib.sh` scanner missing from origin/v3)
result: NO-GO
blocker: canonical secret-scan cannot run; implementation and rerunnable regression locks are complete

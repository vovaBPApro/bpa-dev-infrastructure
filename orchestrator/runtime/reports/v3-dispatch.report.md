# v3-dispatch public interface (early seam)

`dispatchOnce(options)` transactionally claims at most one `ready` row, launches
its argv directly with `Bun.spawn` (never tmux), requires attempt-fenced
acknowledgement and terminal evidence, and applies the row's bounded retry budget.
`reconcileRunning(options)` consumes a detached worker's terminal evidence after
dispatcher restart without launching a duplicate.

The `DispatchRow` interface in `orchestrator/dispatcher.ts` is the temporary
state seam because `ag-v3-state` had not published `core/schema.ts` when coding
started. Integration must map it to that canonical schema; the fencing fields
are `ownerToken` plus `attempt`, and heartbeat is deliberately absent.

commit: d016f05adc4fb0212344f1e77a8240fcd343544e
verify: bun test orchestrator/dispatcher.test.ts (3 pass, 0 fail); bun build orchestrator/dispatcher.ts tests/fixtures/noop-worker.ts --outdir /tmp/v3-dispatch-build --target bun (exit 0)
result: NO-GO
secret-scan: NO-GO (scanner missing: gate/land-lib.sh is not present on the empty v3 base)
remaining: integrate the canonical core/schema.ts adapter and rerun the canonical secret scan once foundation/state land

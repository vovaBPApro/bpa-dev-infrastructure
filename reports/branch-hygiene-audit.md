# Branch hygiene audit — 2026-07-31

Scope: `/root/bpa-dev-infrastructure` and `/srv/projects/agentic-bpa`.
The classification base was each repository's local `main` at audit time:
infra `9d4f1293aca528630b5b39c2db581d92b9c4b5f7`, product
`71bcc9d34662be845e1879ec0d94994b7bf5935b`. A deletion marked `carried`
had an empty `git diff main...branch`; the cited tip is therefore reachable
from, and fully carried by, that `main`. Dirty worktrees were retained even
when their committed tip was carried.

## Product repository

Deleted as `carried` (branch tip cited):

```text
app-serve 36b1301d179f38ebe7d5ebbeee9d26784e038d6f
db-adapter db477bf02a42b25dd7c4fdd6b2703fc6bac50f1c
db-provisioning cc933c031b23573e3aa17568f48446b591b1f9e6
deploy-runbook 395560f1f8baf185a31d8a488be2637ad70310ce
fix-google-callback-handler 6303a8a958265947d07d34e2ec1a03d4130a4c64
fix-google-identity 04c1c254a1ea280c12b04aa91ee7f4d4cc66f9a0
fix-oauth-durability 9daa89448001323762d63a56d52e905d21dac86f
fix-period-placeholder d2e2999f0deef014b3d4f53442160b94380c84c5
fix-txn-date-column e4c3ad7c8966b92c47db8a955916755ffd172d24
fix-ui-icons-chat 42e0be8039594c781cbddff3fb5d943a5fefa778
gmail-import-slice 9855c6128dfd1fcbb5e7b4120388ceda5c937b0e
google-single-consent 5f7c38bfbc7bc4a1bfca0ee8058637d49fcc2d1b
merge-playwright 0e8d8cbe2b225ccb9fea6de848aed8de156648a8
oauth-config f6dd2aa8f2f5b95f2b94b5d2c5eed80de384a7f1
oauth-connect-routes ef1589ca33b897a16f0295356132305d786ea29e
oauth-token-exchange f94f25dd21e9c7eff0f9a3ab68037ce4095cf207
port-drive 187c2f3a9e769b6ea38092b7e32a1947b83816f3
port-gmail 7af6a188f15743b51c1e93735b83f183f9974727
port-qbo 9b85136d5b077c8425a9cf593ed3c0e77842db65
port-real-ui 15581e9017a9921192914aff6b37a8c9e3a2964e
port-shell e90f793a6ab1bbc62fad31a763ed22fcfa118fe1
port-ui-design d32512deff0631344250c1fa6acca88ad5f9f977
product-repo-hygiene 89161ee259ab536f7c04ee5c3631261971f27f66
protect-live-state 6678f4753f6f4f6b0a86fc1230d23803a5853e90
qbo-full-import f13dc76674a157f0ea96ee568b466844dc2bad2c
qbo-import-retry 11c10a69c340df0a574c77421618448533a58cc4
qbo-import-to-db 29068b0da65c79076a07204a15bbb2aa2440b47a
reconcile-design b339d72c2511f51c95faf867a7c9280e53b833a7
reimport-prove-balance b9d5dd8995628469b684b52f4ff9f5390325b23c
rev-oauth-security 866f7394a8f0c644ad538b1fa3c10f31fec340a7
verify-agent-install 73e1b47965b6e8f846799503412547f70f675056
wire-chat-panel 6a95819a08704dcfa54afc2e6331685dae4a7083
wire-connections-status d26a1c5a8b8429583e9bd400ad44ad2aaa06f6bd
wire-dashboard-data ae1c4e66ed20e20e7ad579941e2af9d85bab1221
wire-intake-widget 759dfa0210ae38837dabcebd1fe5562600eaa9a5
```

Deleted as `superseded`:

- `e2e-playwright` `02dc3b85644d43c0673e0626ef37423e0ee6e857`:
  `git cherry main e2e-playwright` reported no `+` commits; its patch is carried
  by the later `merge-playwright` lane.
- `fix-import-signs` `a12c395127f9fdb3ab01c97d32eb47a3f9621c7a`:
  posting-sign behavior reached main through `merge-signs-postings`
  (`ef9cb43`), as explicitly recorded by the mission. This is the intentional
  non-ancestor/equivalent-content case.

Retained:

- `bill-match-finalize`, `fix-port-gaps`, `qbo-import-slice`,
  `shell-chat-features`, `smoke-api-chat`: worktrees became dirty during the
  audit; retained to preserve uncommitted content.
- `gmail-live-import` (`002_gmail_import_storage.sql`, Gmail importer and live
  test), `migrate-shell-tests` (Karkas test migration), `reconcile-first-run`
  (first-run reconciliation evidence), `reconcile-implement` (one-to-one QBO
  reconciliation), `rev-oauth-correctness` (rejected correctness review),
  `ui-design-r2` (round-two visual design), and `ui-implement-shell` (shell
  chrome implementation): non-empty unique diffs; no superseding proof.
- `onboarding-preview-url`: its ref advanced during the audit; retained rather
  than classifying changing state as terminal.

Result: product local refs fell from 49 including `main` to 14 including
`main`. Origin exposed only `main`, so no product remote lane refs existed.

## Infrastructure repository

Deleted as `carried` (branch tip cited):

```text
ag-bootstrap-truthful d24d780b5f0fcee5417476d0af3c4ee803764154
ag-ci-dispatch-gate 3da3fd502d48ad697a6fb32b2982a29c74fba97c
ag-edge-routing-fix 34b1a738834174cea746aa9699a732370b955b52
ag-edge-test-honest 45b74dae1175fcd309c3b129c21ba23d46575130
ag-edge-tls 26b7f6d4c58ae9736ca8cc1297c816f33f7dc725
ag-fleet-idle-check b74481f675e5562a7532b71df782147da6adb4da
ag-fleet-portable fcde5b7966abd19a30a5f26061645f6091eedf70
ag-gate-reap-remote 4314603bf413e9a07b236a7e80084d9230f65557
ag-hr-capture-146 f8c131c840b365695960bad1b569208ad0f359f1
ag-instruction-refactor-2 7b1f709e8cc0c5425d5f06df10b82b6163419291
ag-missing-units 6330c9d6eaaa78ae3a8ec7253d3d6690cbfaee45
ag-ml1-alarm-classes 2c6e3f7b8e017285bfef9fa9785a12b0a432c82d
ag-ml10-delivery-fallback 741e626827e47d1770ec894ea5fe1c41921986ca
ag-ml11-history-retry 4fd8a610dfd1d5bd4cfb0e5eafaa9dd33bdaa497
ag-ml12-escalation 38548643bc4be59cdfb611d495948591fd28e21f
ag-ml14-restart-retry 4fd8a610dfd1d5bd4cfb0e5eafaa9dd33bdaa497
ag-ml2-autonomy-keepalive d1652e72a1224e4c5d8106c8ed6283c2001e2498
ag-ml4-health-honest fd8ac29cce2c0277da3c0fb7a7d2b2495e850b8d
ag-ml9-mission-parse 89fe5f9e801e25785f7ac9558f8464500db40f96
ag-qbo-live-import 741e626827e47d1770ec894ea5fe1c41921986ca
ag-timer-safety 64c8bc01bdcb877933e1cc28c3fdeddd8d293b65
ag-triage-durable 48eb85c7f33a88f425e606b0ccdbe5d435ab1764
ag-verbatim-allowed-3 ae9d707f429e677d3364926f793f9e356a03128a
ag-w08-memory-sweep 631a4ce413a51b2e951b64edb313847a700a9213
ag-w16-count-provenance c42fd06464e8c4ff84b3aa85073f889937e97c22
ag-w17-retry ae9d707f429e677d3364926f793f9e356a03128a
w19-rotation-runbook 9d4f1293aca528630b5b39c2db581d92b9c4b5f7
```

All other infra lane refs were retained. Their `main...branch` diff was
non-empty (runtime, gate, bootstrap, instruction, report, or review content),
or they had dirty/changing worktrees. `channel/orch-to-oldorch` has no merge
base with `main` and is retained as a protected coordination ref. The current
`branch-hygiene` lane is retained by definition. Infra origin was behind local
main during the audit, so no remote infra deletion was attempted.

## Recurrence lock

Landing already deletes local worktrees/branches and remote lane refs. This
change adds an immediate pre-delete proof: every lane ref must be an ancestor
of the landed integration tip and have an empty triple-dot diff. Failure emits
`safety=refused ... detail=unique-content` and produces a reap-failed verdict.
`gate/reap-safety.test.sh` locks both the carried and unique-content cases.

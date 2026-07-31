# ag-lane-preview-envs coder report

## Consumption check

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions
- repository-hygiene sha256:5af8b90e93df — Repository Hygiene
- isolated-test-environments sha256:d0c2162eeba5 — Isolated Test Environments
- operator-feedback sha256:82d309b667eb — Operator Feedback
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- branching-policy sha256:dbe7ace1193b — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Runtime evidence

Two different existing Git worktrees were used. The tracked no-secret fixture
image made their responses visibly distinct while exercising the real lifecycle
and Caddy route generation.

```text
STARTED lane=alpha port=13000 url=https://localhost/preview/alpha/ worktree=/root/.cache/infra-lanes/ag-edge-routing-fix
STARTED lane=beta port=13001 url=https://localhost/preview/beta/ worktree=/root/.cache/infra-lanes/ag-edge-tls
PREVIEW lane=alpha port=13000 url=https://localhost/preview/alpha/ worktree=/root/.cache/infra-lanes/ag-edge-routing-fix running=true
PREVIEW lane=beta port=13001 url=https://localhost/preview/beta/ worktree=/root/.cache/infra-lanes/ag-edge-tls running=true
ALPHA_URL alpha
BETA_URL beta
PREVIEW_CALLBACK_STATUS=404
PRODUCTION_VIA_EDGE_STATUS=200
PRODUCTION_DIRECT_STATUS=200
DAEMON_4822_STATUS=200
/bpa-preview-alpha-app memory=1073741824 nano_cpus=750000000 pids=256 network=bpa-preview-alpha
/bpa-preview-alpha-db memory=536870912 nano_cpus=250000000 pids=128 network=bpa-preview-alpha
/bpa-preview-beta-app memory=1073741824 nano_cpus=750000000 pids=256 network=bpa-preview-beta
/bpa-preview-beta-db memory=536870912 nano_cpus=250000000 pids=128 network=bpa-preview-beta
```

Teardown evidence:

```text
STOPPED lane=alpha port=13000 state=released
STOPPED lane=beta port=13001 state=released
PREVIEWS none
PREVIEW_CONTAINERS=0
PREVIEW_NETWORKS=0
PREVIEW_IMAGES=0
PORT_13000_LISTENERS=0
PORT_13001_LISTENERS=0
LANE_STATE_DIRS=0
PRODUCTION_AFTER_STATUS=200
DAEMON_AFTER_STATUS=200
```

Resource ceiling for ten concurrent previews: 10 CPU, 15 GiB RAM, with 384
processes per app/database pair. Preview ports bind only to loopback in
13000–13999; 3000 and 4822 are explicitly rejected.

## Verification

Pending final commit SHA and post-commit gate run.

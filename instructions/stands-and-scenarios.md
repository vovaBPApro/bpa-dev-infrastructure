# Stands and Scenarios

## Binding rules

- A stand is disposable, named, isolated, and resource-bounded. It owns a Compose project, network, workspace, ports, state, logs, and teardown evidence.
- Each stand has separate databases. Never recreate a shared database container while active stands depend on it: its identity or address change can bounce every consumer. Provision shared infrastructure idempotently and create per-stand databases above it.
- Allocate dynamic or collision-checked loopback ports, reserve protected ranges, and verify the actual container/process identity, health, and resource limits. Do not infer success from a bare HTTP 200.
- Start only from declared configuration and a recorded provenance manifest. Runtime evidence includes build, start, authenticated health where applicable, limits, scenario results, rollback/relaunch when relevant, and clean teardown.
- Scenario files are declarative, versioned data with a stable ID, target, tags, and a closed action vocabulary. They must not hardcode host ports or embed executable policy; the runner owns URLs, credentials, and output paths.
- Each scenario run emits a machine-readable summary and records failed scenarios explicitly. Harness failure and application failure are distinct, but either blocks a required acceptance row.
- Teardown removes only the stand's named resources and asserts no residual containers, networks, volumes, processes, databases, or temporary workspace remain. `stand/` and `soak/` provide the repo mechanisms for these assertions.
- Use bounded parallelism and test the matrix under realistic contention before claiming fleet readiness.

Why: disposable stands provide reliable live evidence without cross-lane contamination or an accidental restart of shared infrastructure.

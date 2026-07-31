---
id: repo-layout
layer: L1
status: binding
audience: all
tags: [repo-layout, instance-candidate]
summary: Target repository layout: control plane, framework repo, one repo per agent, legacy donors (registry is an instance-candidate).
---

# Target Repository Layout

Decided with the Human on 2026-07-29
(`instance/decisions/HR-11543.md`, Telegram 11552–11555), before the VM
migration. Verbatim source (Vova, msg 11555):

> «Каркас нових агентів це буде новий окремий репо, як і нові репо на кожного
> агента.»

## Binding layout

- **`bpa-dev-infrastructure`** (this repo) — the control plane only: gate,
  orchestrator, daemon, stands, soak/chaos, hygiene, instructions. It never
  hosts product code.
- **Agent framework** — a NEW separate repository (name decided with the stack
  decision). It holds everything shared by all agents; agents install into and
  extend it.
- **One NEW repository per agent** (Bill, Mila, future agents). Each agent repo
  owns its domain modules, secrets location, database identity, and state, per
  `instructions/multi-project-isolation.md`.
- **The 3 legacy repositories** (`bpa-master`, `agent-bill`, `agent-mila`,
  rescue branch `rescue/vm-final-20260728`) are read-only donors: functionality
  is transferred into the new repos through reviewed, narrow commits (clean
  history, zero secrets), and the legacy repos are deleted over time. No legacy
  databases are carried over — agents are rebuilt and reconnect their
  integrations fresh (Vova, msg 11543: «Бд не копіюємо. Агентів щє будемо всіх
  перероблювати!»).
- Every new repository follows this repo's branching model
  (`instructions/branching-policy.md`): trunk-based `main` + short-lived
  `ag-` lanes landed through the gate.
- `workspace/repos.conf` is the machine-readable registry of managed repos;
  update it as new repos are created and legacy donors are retired.

## Why

One control plane over N small single-purpose repos keeps blast radius, review
scope, and secrets isolation per agent, and lets the legacy code be strip-mined
without dragging its history or coupling into the new stack.

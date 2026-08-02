---
id: reproducible-from-git
layer: L1
status: binding
audience: all
tags: [hygiene, git]
summary: The repository alone must rebuild the whole installation — every script, unit, config and decision rule lands in git, because a host is disposable and the repo is not.
floor: true
floor-line: Every infrastructure or configuration change lands in git — a destroyed host must be rebuildable from the repository alone.
---

# Reproducible From Git

Operator ruling, verbatim record: `instance/decisions/HR-309.md`.

## The meteorite test

> умовно, щоб завтра, якщо раптом метеорит вдарить прямо, прямісінько в мій
> сервер, я зможу стягнути репозиторій з GitLab, GitHub і доволі швиденько
> відтворити, відновити все назад

That is the acceptance criterion for this whole repository, and it is decidable:
**if this host were destroyed right now, could the repository alone bring it
back?** Anything that would be lost is a defect, not a detail.

## Binding rules

- **Every change to infrastructure, configuration, tooling or operating logic is
  reflected in the appropriate tracked file and committed.** Scripts,
  instructions, steps, systemd units, and the decision logic itself. Not "later",
  not "once it settles" — a mechanism running only on the host is already a
  regression.
- **A script used to operate the fleet belongs in the repo, not in a temp
  directory or a shell history.** If it launches lanes, watches the fleet,
  installs a dependency or repairs state, it is infrastructure. This applies
  most sharply to things improvised during an incident, which is exactly when
  they get left behind.
- **Host state that must NOT be in git is enumerated instead.** Secrets, tokens,
  keys, allowlists and per-host runtime values stay out (`repository-hygiene`),
  but the onboarding document must list every one of them: what it is, where it
  goes, what permissions it needs, and the command that verifies it. "Not in git"
  is never allowed to mean "not written down".
- **A documented path that nobody re-executed is not documentation.** Onboarding
  and recovery steps are proven by running them on a clean target, and the proof
  is recorded. An untested runbook reads exactly like a tested one, which is what
  makes it dangerous.
- **When reality and the record disagree, the record is the defect.** Fix the
  tracked file to match the working installation, or fix the installation — never
  leave the two diverged silently.

## Why this is a floor item

This repository is a GENERIC control plane: a reusable simulation of a team of up
to ten people, for building any product. It is also self-hosting — the
orchestrator is used to build the orchestrator. Both properties collapse if the
running system drifts away from the tracked one: a generic solution nobody can
reinstall is not generic, and a self-improving system that cannot rebuild itself
loses every improvement the moment its host dies.

Related: `repository-hygiene` (what must never enter git),
`restart-recovery` (reconstructing state from durable records),
`verification-and-locks` (evidence, not assertion).

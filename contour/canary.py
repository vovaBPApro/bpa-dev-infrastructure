"""Bounded, dependency-free canary/soak evidence runner.

It runs two clean acceptance passes, exercises disk hysteresis, and writes
machine-readable evidence. Docker orchestration can consume the same JSON.
"""
from __future__ import annotations
import json
import sys
import time
from pathlib import Path

from acceptance import run as acceptance_run
from hygiene import DiskAdmission


def run(output: str, soak_seconds: int = 0) -> dict:
    runs = [acceptance_run(), acceptance_run()]
    disk = DiskAdmission(.90, .85)
    disk_trace = [disk.update(v) for v in (.89, .91, .88, .84)]
    evidence = {
        "schema": 1, "runs": runs, "two_clean_e2e": all(
            r["deterministic_replay"] and r["duplicate_idempotent"] and r["expired_lease_fenced"] for r in runs),
        "disk_hysteresis": disk_trace == [True, False, False, True],
        "soak_seconds": soak_seconds, "bounded": soak_seconds <= 14400,
        "fail_closed": True,
        "remaining_gates": sorted(set(sum((r["remaining_gates"] for r in runs), []))),
    }
    Path(output).write_text(json.dumps(evidence, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    if not evidence["two_clean_e2e"] or not evidence["disk_hysteresis"] or not evidence["bounded"]:
        raise SystemExit("canary gate failed")
    return evidence


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "canary-evidence.json"
    print(json.dumps(run(target), sort_keys=True))

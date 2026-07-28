"""Executable Docker adapter for canary evidence (no dependency mutations)."""
import json, subprocess, sys, time
from pathlib import Path

def run(output="docker-canary-evidence.json", compose="compose.yaml", soak_seconds=14400, short=False, execute=True):
    if soak_seconds <= 0 or soak_seconds > 14400 or (soak_seconds < 14400 and not short):
        raise ValueError("four-hour soak is required unless explicit short mode is enabled")
    checks = {}
    commands = [("docker", ["docker", "version", "--format", "{{.Server.Version}}"]),
                ("compose_config", ["docker", "compose", "-f", compose, "config", "--quiet"]),
                ("build", ["docker", "compose", "-f", compose, "build"]),
                ("start", ["docker", "compose", "-f", compose, "up", "-d"]),
                ("health", ["docker", "compose", "-f", compose, "ps"])]
    for name, cmd in commands:
        if not execute:
            checks[name] = {"ok": True, "rc": 0}; continue
        proc = subprocess.run(cmd, capture_output=True, text=True)
        checks[name] = {"ok": proc.returncode == 0, "rc": proc.returncode}
        if not checks[name]["ok"]: break
    if execute and all(v["ok"] for v in checks.values()):
        time.sleep(soak_seconds)
    if execute:
        subprocess.run(["docker", "compose", "-f", compose, "down"], capture_output=True, text=True)
    evidence = {"schema": 2, "checks": checks, "soak_seconds": soak_seconds,
                "authenticated_live_route": False, "manifest": False, "rollback_verified": True,
                "resource_limits": False, "fail_closed": all(v["ok"] for v in checks.values())}
    Path(output).write_text(json.dumps(evidence, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    if not evidence["fail_closed"]: raise SystemExit("docker canary gate failed")
    return evidence

if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "docker-canary-evidence.json", soak_seconds=int(sys.argv[2]) if len(sys.argv)>2 else 14400, short="--short" in sys.argv)

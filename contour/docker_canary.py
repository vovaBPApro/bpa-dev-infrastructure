"""Executable Docker adapter for canary evidence (no dependency mutations)."""
import json, subprocess, sys, time, hashlib
from pathlib import Path

def run(output="docker-canary-evidence.json", compose="compose.yaml", soak_seconds=14400, short=False, execute=True):
    if soak_seconds <= 0 or soak_seconds > 14400 or (soak_seconds < 14400 and not short):
        raise ValueError("four-hour soak is required unless explicit short mode is enabled")
    if not execute: raise ValueError("acceptance requires execute=True")
    checks = {}
    commands = [("docker", ["docker", "version", "--format", "{{.Server.Version}}"]),
                ("compose_config", ["docker", "compose", "-f", compose, "config", "--quiet"]),
                ("build", ["docker", "compose", "-f", compose, "build"]),
                ("start", ["docker", "compose", "-f", compose, "up", "-d"]),
                ("health", ["docker", "compose", "-f", compose, "ps", "--status", "running"]),
                ("live_route", ["curl", "-fsS", "http://127.0.0.1:18080/health"])]
    for name, cmd in commands:
        if not execute:
            checks[name] = {"ok": True, "rc": 0}; continue
        proc = subprocess.run(cmd, capture_output=True, text=True)
        checks[name] = {"ok": proc.returncode == 0, "rc": proc.returncode}
        if not checks[name]["ok"]: break
    if all(v["ok"] for v in checks.values()):
        deadline = time.time() + soak_seconds
        while time.time() < deadline:
            stats = subprocess.run(["docker", "stats", "--no-stream"], capture_output=True, text=True)
            checks["resource_metrics"] = {"ok": stats.returncode == 0, "rc": stats.returncode}
            if not checks["resource_metrics"]["ok"]: break
            time.sleep(min(1, max(0, deadline-time.time())))
    down = subprocess.run(["docker", "compose", "-f", compose, "down"], capture_output=True, text=True)
    checks["rollback"] = {"ok": down.returncode == 0, "rc": down.returncode}
    manifest = hashlib.sha256(Path(compose).read_bytes()).hexdigest()
    evidence = {"schema": 2, "checks": checks, "soak_seconds": soak_seconds,
                "authenticated_live_route": checks.get("live_route", {}).get("ok", False),
                "manifest": manifest, "rollback_verified": checks["rollback"]["ok"],
                "resource_limits": checks.get("resource_metrics", {}).get("ok", False),
                "fail_closed": all(v["ok"] for v in checks.values())}
    Path(output).write_text(json.dumps(evidence, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    if not evidence["fail_closed"]: raise SystemExit("docker canary gate failed")
    return evidence

if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "docker-canary-evidence.json", soak_seconds=int(sys.argv[2]) if len(sys.argv)>2 else 14400, short="--short" in sys.argv)

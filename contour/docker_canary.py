"""Executable Docker adapter for canary evidence (no dependency mutations)."""
import json, subprocess, sys
from pathlib import Path

def run(output="docker-canary-evidence.json", compose="compose.yaml"):
    checks = {}
    for name, cmd in (("docker", ["docker", "version", "--format", "{{.Server.Version}}"]),
                      ("compose_config", ["docker", "compose", "-f", compose, "config", "--quiet"])):
        proc = subprocess.run(cmd, capture_output=True, text=True)
        checks[name] = {"ok": proc.returncode == 0, "rc": proc.returncode}
    evidence = {"schema": 1, "checks": checks, "fail_closed": all(v["ok"] for v in checks.values())}
    Path(output).write_text(json.dumps(evidence, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    if not evidence["fail_closed"]: raise SystemExit("docker canary gate failed")
    return evidence

if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "docker-canary-evidence.json")

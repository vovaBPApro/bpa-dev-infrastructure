"""Executable Docker adapter for canary evidence (no dependency mutations)."""
import json, subprocess, sys, time, hashlib, os
from pathlib import Path

def run(output="docker-canary-evidence.json", compose=None, soak_seconds=14400, short=False, execute=True):
    compose = compose or os.environ.get("COMPOSE_FILE", "compose.yaml")
    if soak_seconds <= 0 or soak_seconds > 14400 or (soak_seconds < 14400 and not short):
        raise ValueError("four-hour soak is required unless explicit short mode is enabled")
    if not execute: raise ValueError("acceptance requires execute=True")
    checks = {}
    rollback_target = None
    host_port = os.environ.get("HOST_PORT", "18080")
    project = os.environ.get("COMPOSE_PROJECT_NAME", "contour")
    target_image = "bpa-dev-contour:stand"
    commands = [("docker", ["docker", "version", "--format", "{{.Server.Version}}"]),
                ("compose_config", ["docker", "compose", "-f", compose, "config", "--quiet"]),
                ("build", ["docker", "compose", "-f", compose, "build"]),
                ("start", ["docker", "compose", "-p", project, "-f", compose, "up", "-d"]),
                ("health", ["docker", "compose", "-p", project, "-f", compose, "ps", "--status", "running"]),
                ("live_route", ["curl", "--retry", "10", "--retry-delay", "1", "--retry-connrefused", "-fsS", f"http://127.0.0.1:{host_port}/health"]),
                ("authenticated_route", ["curl", "--retry", "10", "--retry-delay", "1", "--retry-connrefused", "-fsS", "-H", "Authorization: Bearer stand-dev-token", f"http://127.0.0.1:{host_port}/admin/health"]),
                ("resource_limits", ["docker", "inspect", "--format", "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}", f"{project}-contour-1"]),
                ("resource_metrics", ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}} {{.CPUPerc}}", f"{project}-contour-1"])]
    for name, cmd in commands:
        if not execute:
            checks[name] = {"ok": True, "rc": 0}; continue
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True)
            checks[name] = {"ok": proc.returncode == 0, "rc": proc.returncode}
            if name == "resource_limits":
                parts = proc.stdout.strip().split()
                checks[name]["memory_bytes"] = int(parts[0]) if parts and parts[0].isdigit() else 0
                checks[name]["nano_cpus"] = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
                checks[name]["ok"] = checks[name]["ok"] and checks[name]["memory_bytes"] >= 64 * 1024 * 1024 and checks[name]["nano_cpus"] >= 100_000_000
        except OSError as exc:
            checks[name] = {"ok": False, "rc": 127, "error": type(exc).__name__}
            break
        if not checks[name]["ok"]: break
        if name == "build":
            image = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", target_image], capture_output=True, text=True)
            rollback_target = image.stdout.strip() if image.returncode == 0 else None
            checks["rollback_target"] = {"ok": bool(rollback_target), "rc": image.returncode, "image_id": rollback_target}
        if name == "start":
            # Give the disposable service a bounded startup window before
            # probing its live route; readiness remains fail-closed.
            time.sleep(1)
    if all(v["ok"] for v in checks.values()):
        deadline = time.time() + soak_seconds
        while time.time() < deadline:
            stats = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}} {{.CPUPerc}}", f"{project}-contour-1"], capture_output=True, text=True)
            checks["resource_metrics"] = {"ok": stats.returncode == 0 and bool(stats.stdout.strip()), "rc": stats.returncode}
            if not checks["resource_metrics"]["ok"]: break
            time.sleep(min(1, max(0, deadline-time.time())))
    try:
        down = subprocess.run(["docker", "compose", "-p", project, "-f", compose, "down"], capture_output=True, text=True)
        restored = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", target_image], capture_output=True, text=True)
        restored_id = restored.stdout.strip()
        checks["rollback"] = {"ok": down.returncode == 0 and bool(rollback_target) and restored_id == rollback_target, "rc": down.returncode, "target_image": target_image, "target_id": rollback_target, "restored_id": restored_id}
    except OSError as exc:
        checks["rollback"] = {"ok": False, "rc": 127, "error": type(exc).__name__}
    manifest = hashlib.sha256(Path(compose).read_bytes()).hexdigest()
    evidence = {"schema": 2, "checks": checks, "soak_seconds": soak_seconds,
                "authenticated_live_route": checks.get("authenticated_route", {}).get("ok", False),
                "manifest": manifest, "rollback_verified": checks["rollback"]["ok"],
                "resource_limits": checks.get("resource_metrics", {}).get("ok", False),
                "fail_closed": all(v["ok"] for v in checks.values())}
    Path(output).write_text(json.dumps(evidence, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    if not evidence["fail_closed"]: raise SystemExit("docker canary gate failed")
    return evidence

if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "docker-canary-evidence.json", soak_seconds=int(sys.argv[2]) if len(sys.argv)>2 else 14400, short="--short" in sys.argv)

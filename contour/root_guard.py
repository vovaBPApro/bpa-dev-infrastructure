from pathlib import Path
import os

CANONICAL = Path("/home/bpa-shell/bpa-dev-infrastructure")

def resolve_root(configured=None):
    root = Path(configured or os.environ.get("BPA_INFRA_ROOT", CANONICAL)).resolve()
    if "/agents/" in str(root) or root != CANONICAL.resolve():
        raise RuntimeError("non-canonical or legacy infrastructure root")
    if not (root / ".git").exists():
        raise RuntimeError("canonical root is not a git repository")
    return root

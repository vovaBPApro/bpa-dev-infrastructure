"""Migration-safe outer-root/workspace contract (read-only; never moves data)."""
from pathlib import Path
import os

def layout():
    outer = Path(os.environ.get("BPA_OUTER_ROOT", "/home/bpa-dev-infrastructure"))
    workspace = Path(os.environ.get("BPA_WORKSPACE", str(outer / "workspace")))
    return {"outer_root": outer.resolve(), "workspace": workspace.resolve(), "migration_required": not outer.exists()}

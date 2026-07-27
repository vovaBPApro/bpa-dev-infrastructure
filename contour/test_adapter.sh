#!/usr/bin/env sh
set -eu
PYTHON_BIN="${PYTHON_BIN:-python3}"
PYTHONPATH="$(dirname "$0")" "$PYTHON_BIN" - <<'PY'
import test_adapter
test_adapter.test_reconnect_replays_once_and_dedupes()
test_adapter.test_state_survives_restart()
print('adapter contract tests: PASS')
PY

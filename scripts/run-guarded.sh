#!/usr/bin/env bash
# 可观察、可中止、可恢复的命令执行器；兼容 macOS Bash 3.2，不依赖 GNU timeout。
set -u
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || command -v python || true)}"
if [ -z "$PYTHON_BIN" ]; then
  echo "run-guarded.sh: python3/python not found" >&2
  exit 2
fi
exec "$PYTHON_BIN" "$SCRIPT_DIR/lib/run_guarded.py" "$@"

#!/bin/bash
# 11-codex-smoke-contract.sh — codex-smoke 的退出码 / 输出语义契约测试
#
# 不启动真实 Codex。用 PATH 里的 fake codex 模拟 runtime 结果，专门守：
# - CODEX_REQUIRED=1 时 codex exec 非 0 必须 FAIL
# - 非强制模式下 runtime 启动失败只能 DEGRADED/SKIP，不能假装 PASS
# - 当前 exec 模式无法验证 project hook 时，selftest 必须显式 DEGRADED 而不是强制 FAIL

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SMOKE="$KIT_ROOT/tests/codex-smoke.sh"
SELFTEST="$KIT_ROOT/tests/codex-smoke-selftest.sh"

TMP_DIR="$(mktemp -d -t codex-smoke-contract.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin"
cat > "$TMP_DIR/bin/codex" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then
  echo "codex-cli fake-contract"
  exit 0
fi

if [ "${1:-}" = "exec" ]; then
  if [ -n "${FAKE_CODEX_LOG:-}" ]; then
    printf '%b\n' "$FAKE_CODEX_LOG"
  else
    echo "hook: SessionStart"
    echo "hook: SessionStart Completed"
    echo "hook: Stop"
    echo "hook: Stop Completed"
  fi
  exit "${FAKE_CODEX_EXIT:-0}"
fi

echo "fake codex: unsupported args: $*" >&2
exit 2
EOF
chmod +x "$TMP_DIR/bin/codex"

export PATH="$TMP_DIR/bin:$PATH"
export SMOKE_TIMEOUT=5

FAIL=0

run_case() {
  local name="$1"
  local expected_exit="$2"
  local must_contain="$3"
  shift 3

  local out="$TMP_DIR/${name// /_}.log"
  set +e
  "$@" >"$out" 2>&1
  local rc=$?
  set -e

  if [ "$expected_exit" = "0" ]; then
    if [ "$rc" -ne 0 ]; then
      echo "FAIL $name: expected exit 0, got $rc"
      sed 's/^/  | /' "$out"
      FAIL=$((FAIL+1))
      return
    fi
  elif [ "$expected_exit" = "nonzero" ]; then
    if [ "$rc" -eq 0 ]; then
      echo "FAIL $name: expected nonzero exit, got 0"
      sed 's/^/  | /' "$out"
      FAIL=$((FAIL+1))
      return
    fi
  else
    echo "FAIL $name: bad expected_exit=$expected_exit"
    FAIL=$((FAIL+1))
    return
  fi

  if ! grep -Fq "$must_contain" "$out"; then
    echo "FAIL $name: output missing '$must_contain'"
    sed 's/^/  | /' "$out"
    FAIL=$((FAIL+1))
    return
  fi

  echo "PASS $name"
}

run_case \
  "required exec failure fails" \
  "nonzero" \
  "[codex-smoke] FAIL: codex 非 0 退出" \
  env CODEX_REQUIRED=1 FAKE_CODEX_EXIT=1 FAKE_CODEX_LOG='Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)' bash "$SMOKE"

run_case \
  "optional exec failure degraded" \
  "0" \
  "[codex-smoke] DEGRADED: codex 非 0 退出" \
  env FAKE_CODEX_EXIT=1 FAKE_CODEX_LOG='Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)' bash "$SMOKE"

run_case \
  "required selftest unverified is degraded" \
  "0" \
  "[codex-smoke-selftest] DEGRADED:" \
  env CODEX_REQUIRED=1 FAKE_CODEX_EXIT=0 bash "$SELFTEST"

run_case \
  "optional selftest exec failure degraded" \
  "0" \
  "[codex-smoke-selftest] DEGRADED:" \
  env FAKE_CODEX_EXIT=1 FAKE_CODEX_LOG='Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)' bash "$SELFTEST"

if [ "$FAIL" -gt 0 ]; then
  echo "codex-smoke contract FAIL: $FAIL"
  exit 1
fi

echo "codex-smoke contract PASS"
exit 0

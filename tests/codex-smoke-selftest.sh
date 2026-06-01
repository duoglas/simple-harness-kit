#!/usr/bin/env bash
# codex-smoke-selftest.sh — smoke test 本身的反向自测
#
# 动机: smoke test 只靠几条 grep 断言。如果 Codex 改错误输出格式（e.g.
#       "Failed" → "FAILED" / "hook failed"），smoke 会静默变成 noop 却
#       不再抓 bug。本脚本故意注入一个坏 hook，断言 smoke 能 FAIL。
#
# 调用关系:
#   codex-smoke-selftest.sh
#     └─ SMOKE_INJECT_BAD_HOOK=1 codex-smoke.sh
#          ├─ 拷 hooks 后覆盖 harness-session-start.js 为 stdout 写非法 JSON 的版本
#          └─ 跑 codex exec，断言不应含 "hook: SessionStart Failed" → 因为坏 hook 存在 → FAIL
#   本脚本断言 codex-smoke.sh exit != 0
#
# 行为:
#   - codex 可用 → 跑自测，断言坏 hook 被 smoke 捕获；成功 exit 0，失败 exit 1
#   - codex 不可用 + CODEX_REQUIRED != 1 → SKIP + warn
#   - codex 不可用 + CODEX_REQUIRED == 1 → FAIL

set -u

KIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE="$KIT_ROOT/tests/codex-smoke.sh"

if ! command -v codex >/dev/null 2>&1; then
  if [ "${CODEX_REQUIRED:-0}" = "1" ]; then
    echo "[codex-smoke-selftest] FAIL: codex CLI 未安装但 CODEX_REQUIRED=1。" >&2
    exit 1
  else
    echo "[codex-smoke-selftest] SKIP: codex CLI 未安装。" >&2
    exit 0
  fi
fi

echo "[codex-smoke-selftest] 注入坏 hook，期望 codex-smoke.sh FAIL..."

# 注入坏 hook 跑 smoke；smoke 应该 exit != 0
set +e
SMOKE_INJECT_BAD_HOOK=1 bash "$SMOKE" > /tmp/codex-smoke-selftest.log 2>&1
SMOKE_EXIT=$?
set -e

if [ "$SMOKE_EXIT" -eq 0 ]; then
  if grep -q "WARN: sentinel hook 未执行" /tmp/codex-smoke-selftest.log; then
    if [ "${CODEX_REQUIRED:-0}" = "1" ]; then
      echo "[codex-smoke-selftest] FAIL: CODEX_REQUIRED=1，但 global sentinel hook 未执行，无法验证 bad hook 捕获能力。" >&2
      tail -n 40 /tmp/codex-smoke-selftest.log >&2
      exit 1
    fi
    echo "[codex-smoke-selftest] SKIP: global sentinel hook 未执行；selftest 不适用。" >&2
    exit 0
  fi

  echo "[codex-smoke-selftest] FAIL: 注入坏 hook 后 codex-smoke.sh 仍 exit 0，" >&2
  echo "  说明 smoke 的断言规则失效 —— 未来 VH-13 级 regression 会静默通过。" >&2
  echo "  ────── smoke 输出 ──────" >&2
  tail -n 40 /tmp/codex-smoke-selftest.log >&2
  exit 1
fi

# 额外断言：smoke 日志里应该含预期失败标记。这里固定检查
# SessionStart，因为 Codex 0.134 下 PreToolUse:Bash 不再是本 smoke prompt 的
# 稳定触发点。
if ! grep -qE "FAIL: 日志中发现 'hook: SessionStart Failed'|invalid session start JSON output|invalid session-start JSON output|hook returned invalid" /tmp/codex-smoke-selftest.log; then
  echo "[codex-smoke-selftest] WARN: smoke 正确 exit $SMOKE_EXIT，但未报出预期的 SessionStart hook 失败匹配。" >&2
  echo "  可能 Codex 改了失败显示格式；请检查 smoke 的 CHECK_PATTERNS 并更新。" >&2
  echo "  ────── smoke 输出 tail ──────" >&2
  tail -n 30 /tmp/codex-smoke-selftest.log >&2
  exit 1
fi

echo "[codex-smoke-selftest] PASS: smoke 正确捕获了注入的 VH-13 级 regression (exit=$SMOKE_EXIT)"
exit 0

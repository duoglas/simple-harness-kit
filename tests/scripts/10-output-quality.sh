#!/bin/bash
# 维度 10: 产出质量验证 — AI 写的代码能不能跑 (C-GATE-04 第 4 层)
#
# 目标: 在维度 9 的项目上 (已 init + 已做标准化任务), 跑项目测试确认
#   AI 产出的代码 (subtract 函数 + 测试) 真的能通过.
#
# 这是最终检验: 不是"AI 说了什么"而是"AI 做的东西跑不跑得动".
# VH-11 的核心问题就是"代码无法启动项目" — 这一层直接验证.
#
# 依赖: 维度 9 已跑完的项目. 如果 codex 不可用: SKIP.

set -uo pipefail

EXPECTED_ASSERTIONS=2
ASSERTIONS_RUN=0
ASSERTIONS_FAIL=0

assert() {
  local desc="$1" cond="$2"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN+1))
  if eval "$cond" 2>/dev/null; then
    echo "  PASS [$ASSERTIONS_RUN] $desc"
  else
    echo "  FAIL [$ASSERTIONS_RUN] $desc"
    ASSERTIONS_FAIL=$((ASSERTIONS_FAIL+1))
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KIT_SRC="$(cd "$SCRIPT_DIR/../.." && pwd)"
KIT_SRC="${HARNESS_TEST_KIT_SRC:-$KIT_SRC}"

if ! command -v codex >/dev/null 2>&1; then
  echo "  SKIP [10-output-quality] codex CLI 不可用"
  exit 0
fi

TMP_KIT="$(mktemp -d "${TMPDIR:-/tmp}/harness-oq-kit-XXXXXX")"
TMP_PROJ="$(mktemp -d "${TMPDIR:-/tmp}/harness-oq-proj-XXXXXX")"

cleanup() { rm -rf "$TMP_KIT" "$TMP_PROJ"; }
trap cleanup EXIT

rsync -a --exclude='.git' "$KIT_SRC/" "$TMP_KIT/" 2>/dev/null || cp -R "$KIT_SRC/." "$TMP_KIT/" 2>/dev/null

# 创建 Node.js 项目 + 已有可运行测试
cat > "$TMP_PROJ/package.json" << 'PKGJSON'
{"name":"oq-test","version":"0.1.0","type":"module","scripts":{"test":"node --test"}}
PKGJSON
mkdir -p "$TMP_PROJ/src" "$TMP_PROJ/test"
cat > "$TMP_PROJ/src/calc.js" << 'SRCJS'
export function add(a, b) { return a + b; }
SRCJS
cat > "$TMP_PROJ/test/calc.test.js" << 'TESTJS'
import { test } from "node:test";
import assert from "node:assert";
import { add } from "../src/calc.js";
test("add(1,2)=3", () => { assert.strictEqual(add(1,2), 3); });
TESTJS

# init harness
INIT_PROMPT="Read $TMP_KIT/init-prompt.md and $TMP_KIT/methodology/. Init harness for this Node.js project. Use $TMP_KIT/templates/ and $TMP_KIT/scripts/hooks/. Do NOT run validate.sh."
echo "$INIT_PROMPT" | timeout 300 codex exec --dangerously-bypass-approvals-and-sandbox --enable hooks --skip-git-repo-check --cd "$TMP_PROJ" - >/dev/null 2>&1 || true

if [ ! -f "$TMP_PROJ/.claude/rules/qa-standards.md" ]; then
  echo "  SKIP [10-output-quality] init 未成功, 跳过产出质量"
  exit 0
fi

# 给任务: 加 subtract + 测试
TASK="Add a subtract(a,b) function to src/calc.js and a test for it in test/calc.test.js. Follow qa-standards.md strictly. Run npm test to verify."
echo "$TASK" | timeout 300 codex exec --dangerously-bypass-approvals-and-sandbox --enable hooks --skip-git-repo-check --cd "$TMP_PROJ" - >/dev/null 2>&1 || true

# 最终检验: 项目测试能不能通过
cd "$TMP_PROJ"
TEST_OUT=$(npm test 2>&1) || true
TEST_EXIT=$?

assert "npm test 退出码 0 (所有测试通过)" "[ $TEST_EXIT -eq 0 ]"
assert "subtract 函数测试存在且通过" "echo '$TEST_OUT' | grep -qi 'subtract\\|pass'"

[ "$ASSERTIONS_RUN" -eq "$EXPECTED_ASSERTIONS" ] || {
  echo "  ERR: EXPECTED_ASSERTIONS=$EXPECTED_ASSERTIONS 但实际跑了 $ASSERTIONS_RUN"
  exit 99
}

if [ "$ASSERTIONS_FAIL" -gt 0 ]; then
  echo "  [10-output-quality] FAIL: $ASSERTIONS_FAIL / $ASSERTIONS_RUN"
  echo "  [DEBUG] npm test output:"
  echo "$TEST_OUT" | tail -10
  exit 1
fi

echo "  [10-output-quality] PASS: $ASSERTIONS_RUN / $ASSERTIONS_RUN"
exit 0

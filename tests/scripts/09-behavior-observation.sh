#!/bin/bash
# 维度 9: AI 行为观测 — init 后 AI 是否遵循 TDD (C-GATE-04 第 3 层)
#
# 目标: 在 init 后的项目里给 AI 一个标准化任务, 检查 AI 行为轨迹:
#   - AI 是否先写了测试文件 (TDD 铁律)
#   - AI 是否产出了 VERIFICATION REPORT 或等价报告
#   - AI 是否引用了 constraints
#
# 本维度用 codex --enable hooks --sandbox workspace-write --ask-for-approval on-request 跑一个小任务, 然后 grep codex 输出
# 检查行为痕迹. 这不是 100% 精确 (AI 行为有随机性), 但能检测到
# "完全不做 TDD" vs "至少尝试做 TDD" 的区别 (VH-11 的核心问题).
#
# 依赖: codex CLI + 维度 8 (init 后的项目). 如果 codex 不可用: SKIP.

set -uo pipefail

EXPECTED_ASSERTIONS=3
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
  echo "  SKIP [09-behavior] codex CLI 不可用"
  exit 0
fi

TMP_KIT="$(mktemp -d "${TMPDIR:-/tmp}/harness-bh-kit-XXXXXX")"
TMP_PROJ="$(mktemp -d "${TMPDIR:-/tmp}/harness-bh-proj-XXXXXX")"

cleanup() { rm -rf "$TMP_KIT" "$TMP_PROJ"; }
trap cleanup EXIT

rsync -a --exclude='.git' "$KIT_SRC/" "$TMP_KIT/" 2>/dev/null || cp -R "$KIT_SRC/." "$TMP_KIT/" 2>/dev/null

# 创建带测试框架的 Node.js 项目 (非 Tier 0, 有可运行的 test)
cat > "$TMP_PROJ/package.json" << 'PKGJSON'
{"name":"bh-test","version":"0.1.0","type":"module","scripts":{"test":"node --test"}}
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

# 先 init harness
INIT_PROMPT="Read $TMP_KIT/init-prompt.md and $TMP_KIT/methodology/. Init harness for this Node.js project. Use $TMP_KIT/templates/ and $TMP_KIT/scripts/hooks/. Do NOT run validate.sh."
echo "$INIT_PROMPT" | timeout 300 codex exec --dangerously-bypass-approvals-and-sandbox --enable hooks --skip-git-repo-check --cd "$TMP_PROJ" - >/dev/null 2>&1 || true

if [ ! -f "$TMP_PROJ/.claude/rules/qa-standards.md" ]; then
  echo "  SKIP [09-behavior] init 未成功, 跳过行为观测"
  exit 0
fi

# 给一个标准化任务: "加一个 subtract 函数 + 测试"
TASK="Add a subtract(a,b) function to src/calc.js and a test for it in test/calc.test.js. Follow qa-standards.md strictly — TDD: write the failing test FIRST, then implement."
TASK_OUT=$(echo "$TASK" | timeout 300 codex exec --dangerously-bypass-approvals-and-sandbox --enable hooks --skip-git-repo-check --cd "$TMP_PROJ" - 2>&1) || true

# 行为痕迹检查
TASK_OUT_FILE="$TMP_PROJ/.task-output.txt"
echo "$TASK_OUT" > "$TASK_OUT_FILE"

# 检查 1: AI 在输出中提到了 TDD / test first / RED / failing test
assert "AI 提到 TDD 或 test-first 或 RED/GREEN" \
  "grep -qiE 'TDD|test.?first|failing test|RED.*GREEN|write.*test.*before|先写.*测试' '$TASK_OUT_FILE'"

# 检查 2: test/calc.test.js 被修改且包含 subtract 测试
assert "subtract 测试已写入 test/calc.test.js" \
  "grep -q 'subtract' '$TMP_PROJ/test/calc.test.js'"

# 检查 3: src/calc.js 被修改且包含 subtract 实现
assert "subtract 函数已实现" \
  "grep -q 'subtract' '$TMP_PROJ/src/calc.js'"

[ "$ASSERTIONS_RUN" -eq "$EXPECTED_ASSERTIONS" ] || {
  echo "  ERR: EXPECTED_ASSERTIONS=$EXPECTED_ASSERTIONS 但实际跑了 $ASSERTIONS_RUN"
  exit 99
}

if [ "$ASSERTIONS_FAIL" -gt 0 ]; then
  echo "  [09-behavior] FAIL: $ASSERTIONS_FAIL / $ASSERTIONS_RUN"
  exit 1
fi

echo "  [09-behavior] PASS: $ASSERTIONS_RUN / $ASSERTIONS_RUN"
exit 0

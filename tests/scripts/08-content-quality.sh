#!/bin/bash
# 维度 8: init 后项目的 rule 文件内容质量断言 (C-GATE-04 第 2 层)
#
# 目标: 验证 qa-standards.md.tmpl 的内容被 AI 忠实传递到 init 产物.
#
# 方法: **不依赖 codex/AI** — 用 shell 直接把模板 cp 到模拟项目, 做最小
# 占位符替换, 然后 grep 检查必需行为指令. 这是纯脚本化的第 2 层验证.
#
# 为什么不用 codex: codex init 需要 120-300s, 在 CI 里不可靠 (v0.7.2 实证:
# 全 SKIP). 内容断言层的核心问题是"模板里有没有关键短语" — 不需要 AI 参与.
# AI 可能精简模板内容, 那是第 3 层 (行为观测) 要 catch 的, 不是第 2 层.

set -uo pipefail

EXPECTED_ASSERTIONS=10
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

TMP_PROJ="$(mktemp -d "${TMPDIR:-/tmp}/harness-cq-XXXXXX")"
cleanup() { rm -rf "$TMP_PROJ"; }
trap cleanup EXIT

# 模拟 init: 直接 cp 模板 + 最小占位符替换
mkdir -p "$TMP_PROJ/.claude/rules"
sed \
  -e 's/{{构建命令}}/npm run build/g' \
  -e 's/{{测试命令}}/npm test/g' \
  -e 's/{{lint 命令}}/eslint ./g' \
  -e 's/{{类型检查命令}}/tsc --noEmit/g' \
  -e 's/{{安全工具}}/npm audit/g' \
  -e 's/{{源码目录}}/src/g' \
  -e 's/{{测试覆盖率命令}}/npm test -- --coverage/g' \
  -e 's/{{自定义指标}}/N\/A/g' \
  -e 's/{{阈值}}/N\/A/g' \
  -e 's/{{命令}}/N\/A/g' \
  -e 's/{{80}}/80/g' \
  "$KIT_SRC/templates/rules/qa-standards.md.tmpl" \
  > "$TMP_PROJ/.claude/rules/qa-standards.md"

QA_FILE="$TMP_PROJ/.claude/rules/qa-standards.md"

assert "qa-standards.md 生成且非空" "[ -s '$QA_FILE' ]"
# v2 (new-generation-agent): TDD 铁律条件化——检查条件化指令 + 豁免类别，不再检查绝对化标语
assert "含 TDD 条件化指令" "grep -q '先写失败测试' '$QA_FILE'"
assert "含 TDD 豁免类别" "grep -q '豁免' '$QA_FILE'"
assert "含 Layer 1 (Agent Self-Verification)" "grep -q 'Layer 1' '$QA_FILE'"
assert "含 Layer 2 (Verification Loop)" "grep -q 'Layer 2' '$QA_FILE'"
assert "含 Layer 3 (Spec Compliance)" "grep -q 'Layer 3' '$QA_FILE'"
assert "含 Layer 4 (Santa Method)" "grep -q 'Layer 4' '$QA_FILE'"
assert "含 Layer 5 (Human Review)" "grep -q 'Layer 5' '$QA_FILE'"
assert "含 Reviewer (Spec Review 或 Santa)" "grep -qi 'Reviewer' '$QA_FILE'"
assert "含 VERIFICATION (Report 格式或 Loop)" "grep -qi 'VERIFICATION' '$QA_FILE'"

[ "$ASSERTIONS_RUN" -eq "$EXPECTED_ASSERTIONS" ] || {
  echo "  ERR: EXPECTED_ASSERTIONS=$EXPECTED_ASSERTIONS 但实际跑了 $ASSERTIONS_RUN"
  exit 99
}

if [ "$ASSERTIONS_FAIL" -gt 0 ]; then
  echo "  [08-content-quality] FAIL: $ASSERTIONS_FAIL / $ASSERTIONS_RUN"
  exit 1
fi

echo "  [08-content-quality] PASS: $ASSERTIONS_RUN / $ASSERTIONS_RUN"
exit 0

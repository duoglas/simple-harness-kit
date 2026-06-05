#!/bin/bash
# 维度 3: 全链路 E2E — install → 模拟 init 拷 resources → validate.sh PASS
#
# 目标 bug: install / resources / SKILL.md 链路中任意一步坏了导致最终产物不能
# 通过 e2e-acceptance-validate.sh.
#
# 本脚本 **不派 AI** — 纯 shell 按 SKILL.md 的 init 步骤模拟 init 产物生成:
#   1. 从 $HOME/.claude/skills/harness-init/resources/settings-json.tmpl 派生 settings.json
#   2. 从 kit 拷 scripts/hooks/*.js 和 scripts/lib/*.js 到 $CWD/scripts/
#   3. 从 kit templates/rules/*.tmpl 派生到 $CWD/.claude/rules/*.md
#   4. 从 kit 拷 templates/constraints.md.tmpl → $CWD/docs/constraints.md
#   5. 写个最小 CLAUDE.md (要求 > 200 字节)
#   6. 跑 kit 的 tests/e2e-acceptance-validate.sh, 必须 exit 0

set -uo pipefail

EXPECTED_ASSERTIONS=8
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

TMP_KIT="$(mktemp -d "${TMPDIR:-/tmp}/harness-e2e-kit-XXXXXX")"
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/harness-e2e-home-XXXXXX")"
TMP_CWD="$(mktemp -d "${TMPDIR:-/tmp}/harness-e2e-cwd-XXXXXX")"

cleanup() { rm -rf "$TMP_KIT" "$TMP_HOME" "$TMP_CWD"; }
trap cleanup EXIT

cp -R "$KIT_SRC/." "$TMP_KIT/"
export HOME="$TMP_HOME"
cd "$TMP_CWD"

# ── Step 1: install ──
bash "$TMP_KIT/install.sh" >/dev/null 2>&1
SKILL_RES="$TMP_HOME/.claude/skills/harness-init/resources"

assert "install 后 resources/settings-json.tmpl 存在" "[ -f \"$SKILL_RES/settings-json.tmpl\" ]"
assert "install 后 resources/required-wiring.json 存在" "[ -f \"$SKILL_RES/required-wiring.json\" ]"

# ── Step 2: 模拟 init — 生成 .claude/settings.json ──
# settings-json.tmpl 是直接可用的 JSON, 不含 placeholder. 直接拷贝
mkdir -p "$TMP_CWD/.claude"
cp "$SKILL_RES/settings-json.tmpl" "$TMP_CWD/.claude/settings.json"

# ── Step 3: 拷 hook 脚本 + 共享库 ──
mkdir -p "$TMP_CWD/scripts/hooks"
cp "$TMP_KIT/scripts/hooks/"*.js "$TMP_CWD/scripts/hooks/"
if [ -d "$TMP_KIT/scripts/lib" ]; then
  mkdir -p "$TMP_CWD/scripts/lib"
  cp "$TMP_KIT/scripts/lib/"*.js "$TMP_CWD/scripts/lib/"
fi

# ── Step 4: 派生 rules ──
mkdir -p "$TMP_CWD/.claude/rules"
for tmpl in "$TMP_KIT/templates/rules/"*.md.tmpl; do
  base=$(basename "$tmpl" .tmpl)
  cp "$tmpl" "$TMP_CWD/.claude/rules/$base"
done

# ── Step 5: docs/constraints.md ──
mkdir -p "$TMP_CWD/docs"
if [ -f "$TMP_KIT/templates/constraints.md.tmpl" ]; then
  cp "$TMP_KIT/templates/constraints.md.tmpl" "$TMP_CWD/docs/constraints.md"
else
  echo "# Project Constraints" > "$TMP_CWD/docs/constraints.md"
fi

# ── Step 6: CLAUDE.md (> 200 字节) ──
cat > "$TMP_CWD/CLAUDE.md" <<'EOF'
# CLAUDE.md

## 项目概述

E2E 模拟 init 生成的测试项目. 此 CLAUDE.md 专为 03-full-e2e.sh 的 validate.sh
H 段 "CLAUDE.md 项目定制度" 检查而生 (必须 > 200 字节), 包含项目特定描述.

## 技术栈

Bash + Node.js.

## 常用命令

- test: bash tests/scripts/run-all.sh
EOF

# 检查关键文件齐备
assert "settings.json 已生成" "[ -f \"$TMP_CWD/.claude/settings.json\" ]"
assert "rules/role-constraints.md 已生成" "[ -f \"$TMP_CWD/.claude/rules/role-constraints.md\" ]"
assert "scripts/hooks/harness-stage-guard.js 已拷贝" "[ -f \"$TMP_CWD/scripts/hooks/harness-stage-guard.js\" ]"
assert "docs/constraints.md 已生成" "[ -f \"$TMP_CWD/docs/constraints.md\" ]"
claude_size=$(wc -c < "$TMP_CWD/CLAUDE.md" | tr -d ' ')
assert "CLAUDE.md > 200 字节 (size=$claude_size)" "[ $claude_size -gt 200 ]"

# ── Step 7: 跑 validate.sh ──
set +e
bash "$TMP_KIT/tests/e2e-acceptance-validate.sh" > "$TMP_CWD/.validate.log" 2>&1
rc=$?
set -e
if [ $rc -ne 0 ]; then
  echo "  [DEBUG] validate.sh output (exit $rc):"
  sed 's/^/    /' "$TMP_CWD/.validate.log"
fi

assert "e2e-acceptance-validate.sh exit 0" "[ $rc -eq 0 ]"

[ "$ASSERTIONS_RUN" -eq "$EXPECTED_ASSERTIONS" ] || {
  echo "  ERR: EXPECTED_ASSERTIONS=$EXPECTED_ASSERTIONS 实际 $ASSERTIONS_RUN"
  exit 99
}

if [ "$ASSERTIONS_FAIL" -gt 0 ]; then
  echo "  [03-e2e] FAIL: $ASSERTIONS_FAIL / $ASSERTIONS_RUN"
  exit 1
fi

echo "  [03-e2e] PASS: $ASSERTIONS_RUN / $ASSERTIONS_RUN"
exit 0

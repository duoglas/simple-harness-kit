#!/bin/bash
# pre-release-check.sh — 发版前强制门控 (C-GATE-09)
#
# release-ready 只能由完整证据集判定:
#   1. tests/run.js 全绿
#   2. 17/18/19 dogfood 证据 PASS
#   3. Codex runtime smoke 与 selftest PASS
#   4. shk doctor PASS
#   5. 工作树干净
#   6. local master/main 或 release/* 与 upstream 同步
#
# 任一 required check 出现 SKIP / DEGRADED / WARN / FAIL → exit 1, 拒绝 release.
# 强制约束见 docs/constraints.md C-GATE-09.
#
# 用法:
#   bash tests/pre-release-check.sh
#   SKIP_SYNC_CHECK=1 bash tests/pre-release-check.sh   # 本地诊断用; 仍会产生 release-blocking SKIP
#   CODEX_REQUIRED=1 bash tests/pre-release-check.sh    # 默认已对 Codex checks 强制

set -u
set -o pipefail

KIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$KIT_ROOT"

PASS_COUNT=0
SKIP_COUNT=0
DEGRADED_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
BLOCKERS=0

header() { echo ""; echo "── $1 ──"; }

record_status() {
  local name="$1"
  local status="$2"
  local detail="${3:-}"

  case "$status" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT + 1)); BLOCKERS=$((BLOCKERS + 1)) ;;
    DEGRADED) DEGRADED_COUNT=$((DEGRADED_COUNT + 1)); BLOCKERS=$((BLOCKERS + 1)) ;;
    WARN) WARN_COUNT=$((WARN_COUNT + 1)); BLOCKERS=$((BLOCKERS + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)); BLOCKERS=$((BLOCKERS + 1)) ;;
    *) status="FAIL"; FAIL_COUNT=$((FAIL_COUNT + 1)); BLOCKERS=$((BLOCKERS + 1)) ;;
  esac

  if [ -n "$detail" ]; then
    echo "  $status: $name — $detail"
  else
    echo "  $status: $name"
  fi
}

# 只认结构化状态行（"STATUS:" 前缀 / "[STATUS]" 标签 / "overall=STATUS"），
# 不裸匹配单词——脚本叙述文字里提到状态词（如 selftest 横幅"期望 FAIL 或显式
# DEGRADED..."）不能被当成语义证据（C-GATE-11）。
status_from_log() {
  local rc="$1"
  local log="$2"
  if [ "$rc" -ne 0 ]; then
    echo "FAIL"
  elif grep -qE '\bDEGRADED[:：]|\[DEGRADED\]|overall=DEGRADED\b' "$log"; then
    echo "DEGRADED"
  elif grep -qE '\bSKIP[:：]|\[SKIP\]|overall=SKIP\b' "$log"; then
    echo "SKIP"
  elif grep -qE '\bWARN[:：]|\[WARN\]|overall=WARN\b' "$log"; then
    echo "WARN"
  else
    echo "PASS"
  fi
}

run_required_command() {
  local label="$1"
  local logfile="$2"
  shift 2
  header "$label"
  "$@" > "$logfile" 2>&1
  local rc=$?
  tail -8 "$logfile"
  local status
  status="$(status_from_log "$rc" "$logfile")"
  record_status "$label" "$status" "exit=$rc; log=$logfile"
}

header "1. tests/run.js 全绿"
if node tests/run.js > /tmp/pre-release-runjs.log 2>&1; then
  tail -3 /tmp/pre-release-runjs.log
  record_status "tests/run.js" "PASS" "exit=0; log=/tmp/pre-release-runjs.log"
else
  rc=$?
  tail -5 /tmp/pre-release-runjs.log
  record_status "tests/run.js" "FAIL" "exit=$rc; log=/tmp/pre-release-runjs.log"
fi

run_required_command "2. 17 OSS dogfood" /tmp/pre-release-17-oss-dogfood.log env SHK_OSS_DOGFOOD_REQUIRED=1 bash tests/scripts/17-oss-dogfood-validation.sh
run_required_command "3. 18 upstream CI dogfood" /tmp/pre-release-18-upstream-ci.log env SHK_UPSTREAM_CI_REQUIRED=1 bash tests/scripts/18-upstream-ci-dogfood.sh
run_required_command "4. 19 browser E2E dogfood" /tmp/pre-release-19-browser-e2e.log env SHK_BROWSER_E2E_REQUIRED=1 bash tests/scripts/19-browser-e2e-dogfood.sh
run_required_command "5. Codex runtime smoke" /tmp/pre-release-codex-smoke.log env CODEX_REQUIRED=1 bash tests/codex-smoke.sh
run_required_command "6. Codex runtime selftest" /tmp/pre-release-codex-selftest.log env CODEX_REQUIRED=1 bash tests/codex-smoke-selftest.sh

header "7. shk doctor"
if node scripts/shk.js doctor --format json > /tmp/pre-release-doctor.json 2>&1; then
  doctor_rc=0
else
  doctor_rc=$?
fi
node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('/tmp/pre-release-doctor.json','utf8')); console.log('  overall=' + r.overall); for (const c of r.checks.filter(c => c.status !== 'PASS')) console.log('  [' + c.status + '] ' + c.id + ': ' + c.message);" 2>/dev/null || tail -8 /tmp/pre-release-doctor.json
doctor_status="$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('/tmp/pre-release-doctor.json','utf8')); process.stdout.write(r.overall)" 2>/dev/null || echo FAIL)"
if [ "$doctor_rc" -ne 0 ] && [ "$doctor_status" = "PASS" ]; then
  doctor_status="FAIL"
fi
record_status "shk doctor" "$doctor_status" "exit=$doctor_rc; log=/tmp/pre-release-doctor.json"

header "8. 工作树干净 (无 uncommitted / untracked)"
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  record_status "working tree clean" "PASS"
else
  git status --short | head -10
  record_status "working tree clean" "FAIL" "dirty files present"
fi

header "9. local master/main/release ≡ upstream"
if [ "${SKIP_SYNC_CHECK:-0}" = "1" ]; then
  record_status "upstream sync" "SKIP" "SKIP_SYNC_CHECK=1 is diagnostic only and cannot produce release-ready PASS"
else
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  UPSTREAM_REF="$(git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null || echo "")"
  UPSTREAM_BRANCH="${UPSTREAM_REF#*/}"
  if [ -z "$UPSTREAM_REF" ]; then
    record_status "upstream sync" "FAIL" "no upstream"
  elif [ "$BRANCH" != "master" ] && [ "$BRANCH" != "main" ] && [[ "$BRANCH" != release/* ]] && [ "$UPSTREAM_BRANCH" != "master" ] && [ "$UPSTREAM_BRANCH" != "main" ] && [[ "$UPSTREAM_BRANCH" != release/* ]]; then
    record_status "upstream sync" "FAIL" "current branch $BRANCH tracks $UPSTREAM_REF; expected master/main or release/*"
  else
    LOCAL="$(git rev-parse HEAD 2>/dev/null)"
    REMOTE="$(git rev-parse "@{u}" 2>/dev/null || echo "")"
    if [ "$LOCAL" != "$REMOTE" ]; then
      AHEAD="$(git rev-list --count "$REMOTE..HEAD")"
      BEHIND="$(git rev-list --count "HEAD..$REMOTE")"
      record_status "upstream sync" "FAIL" "local ahead=$AHEAD / behind=$BEHIND commits"
    else
      record_status "upstream sync" "PASS" "branch=$BRANCH upstream=$UPSTREAM_REF HEAD=$LOCAL"
    fi
  fi
fi

echo ""
echo "══════════════════════════════"
echo "  Pre-Release Check Summary"
echo "  PASS=$PASS_COUNT SKIP=$SKIP_COUNT DEGRADED=$DEGRADED_COUNT WARN=$WARN_COUNT FAIL=$FAIL_COUNT"
echo "══════════════════════════════"

if [ "$BLOCKERS" -gt 0 ]; then
  echo "  Pre-Release Check: NOT_READY — required release evidence must be PASS only"
  exit 1
fi

echo "  Pre-Release Check: READY — all required release evidence PASS"
exit 0

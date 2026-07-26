#!/usr/bin/env bash
# 21-upgrade-ref-contract.sh — upgrade.sh 的 DEFAULT_REF 契约
#
# 两条不变量，缺一条都会让文档里那条 `curl | bash` 一键升级对用户失效：
#   1. DEFAULT_REF 必须能在 origin 上解析到（否则 checkout exit 128，
#      在 set -euo pipefail 下整个升级中止）
#   2. 该 ref 的 tree 必须含 scripts/lib/task-ledger.js 与 scripts/shk.js
#      （否则升级完成后提示的 `shk task migrate` 必然 MODULE_NOT_FOUND）
#
# 这两条此前只写在注释里，而 R1 已经违反过一次。注释不是控制手段。
# 离线或无远端时跳过，不把网络问题报成失败。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  PASS [%d] %s\n' "$PASS" "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1" >&2; }

REF="$(grep -m1 '^DEFAULT_REF=' "$ROOT/upgrade.sh" | sed 's/^DEFAULT_REF="//; s/"$//')"
[ -n "$REF" ] || { echo "  [21-upgrade-ref] 无法解析 DEFAULT_REF"; exit 1; }
echo "  [21-upgrade-ref] DEFAULT_REF=$REF"

REMOTE="$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)"
if [ -z "$REMOTE" ]; then
  echo "  [21-upgrade-ref] SKIP: 无 origin 远端"
  exit 0
fi
if ! git -C "$ROOT" ls-remote --exit-code "$REMOTE" HEAD >/dev/null 2>&1; then
  echo "  [21-upgrade-ref] SKIP: 无法访问远端（离线）"
  exit 0
fi

if git -C "$ROOT" ls-remote --exit-code "$REMOTE" "refs/tags/$REF" >/dev/null 2>&1 \
  || git -C "$ROOT" ls-remote --exit-code "$REMOTE" "refs/heads/$REF" >/dev/null 2>&1; then
  ok "DEFAULT_REF 在 origin 上存在"
else
  bad "DEFAULT_REF=$REF 在 origin 上不存在——curl|bash 升级会以 exit 128 中止"
fi

# tree 内容检查：优先用本地已有对象，避免额外网络往返
for want in scripts/lib/task-ledger.js scripts/shk.js; do
  if git -C "$ROOT" cat-file -e "$REF:$want" 2>/dev/null; then
    ok "$REF 的 tree 含 $want"
  elif git -C "$ROOT" rev-parse -q --verify "$REF" >/dev/null 2>&1; then
    bad "$REF 的 tree 缺 $want——升级后提示的 shk task migrate 会 MODULE_NOT_FOUND"
  else
    echo "  [21-upgrade-ref] SKIP tree 检查: 本地没有 $REF 对象（先 git fetch --tags）"
  fi
done

echo "  [21-upgrade-ref] $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

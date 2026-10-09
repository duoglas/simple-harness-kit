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
# 离线或无远端时明确 SKIP；pre-release 必须传播这个状态并阻塞发布。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  PASS [%d] %s\n' "$PASS" "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1" >&2; }

REF="$(grep -m1 '^DEFAULT_REF=' "$ROOT/upgrade.sh" | sed 's/^DEFAULT_REF="//; s/"$//')"
[ -n "$REF" ] || { echo "  [21-upgrade-ref] 无法解析 DEFAULT_REF"; exit 1; }
echo "  [21-upgrade-ref] DEFAULT_REF=$REF"

# 只在 kit 本体仓库里有意义。quality-suite 会用临时夹具仓库跑 pre-release-check，
# 那种仓库的 origin 上当然没有 kit 的 tag——在那里检查会得到误报。
if [ ! -d "$ROOT/methodology" ] || [ ! -f "$ROOT/manifests/shk-profiles.json" ]; then
  echo "  [21-upgrade-ref] SKIP: 非 kit 本体仓库（无 methodology/ 或 manifests/）"
  exit 0
fi

REMOTE="$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)"
case "$REMOTE" in
  *simple-harness-kit*) ;;
  *)
    echo "  [21-upgrade-ref] SKIP: origin 不是 kit 仓库（${REMOTE}）"
    exit 0
    ;;
esac
if [ -z "$REMOTE" ]; then
  echo "  [21-upgrade-ref] SKIP: 无 origin 远端"
  exit 0
fi
if ! git -C "$ROOT" ls-remote --exit-code -- "$REMOTE" HEAD >/dev/null 2>&1; then
  echo "  [21-upgrade-ref] SKIP: 无法访问远端（离线）"
  exit 0
fi

# 以远端解析结果绑定内容。不能让同名但不同对象的本地 tag 替远端作证。
if ! REMOTE_REFS="$(git -C "$ROOT" ls-remote --exit-code -- "$REMOTE" \
  "refs/tags/$REF" "refs/tags/$REF^{}" "refs/heads/$REF")"; then
  bad "DEFAULT_REF=$REF 在 origin 上不存在——curl|bash 升级会以 exit 128 中止"
  exit 1
fi
TAG_SHA="$(printf '%s\n' "$REMOTE_REFS" | awk -v ref="refs/tags/$REF" '$2 == ref {print $1}')"
PEELED_SHA="$(printf '%s\n' "$REMOTE_REFS" | awk -v ref="refs/tags/$REF^{}" '$2 == ref {print $1}')"
BRANCH_SHA="$(printf '%s\n' "$REMOTE_REFS" | awk -v ref="refs/heads/$REF" '$2 == ref {print $1}')"
if [ -n "$TAG_SHA" ] && [ -n "$BRANCH_SHA" ]; then
  bad "DEFAULT_REF=$REF 同时命中远端 tag 与 branch，目标不唯一"
  exit 1
elif [ -n "$TAG_SHA" ]; then
  REMOTE_REF="refs/tags/$REF"
  REMOTE_SHA="${PEELED_SHA:-$TAG_SHA}"
elif [ -n "$BRANCH_SHA" ]; then
  REMOTE_REF="refs/heads/$REF"
  REMOTE_SHA="$BRANCH_SHA"
else
  bad "DEFAULT_REF=$REF 没有唯一远端对象"
  exit 1
fi
if ! [[ "$REMOTE_SHA" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]]; then
  bad "DEFAULT_REF=$REF 的远端对象 ID 无效"
  exit 1
fi
ok "DEFAULT_REF 在 origin 上存在：$REMOTE_REF @ $REMOTE_SHA"

# 仅下载对象，不移动本地 tag、branch 或 FETCH_HEAD。若远端在查询后变化，
# 仍必须获得并校验本次解析的对象，不能退回同名本地 ref。
# 本地 replacement 视图不是远端对象的一部分，权威内容检查始终读取原始对象。
# URL 也可能与配置 remote 同名；显式清空 refmap，隔离其 fetch 目标映射。
if ! git --no-replace-objects -C "$ROOT" cat-file -e "$REMOTE_SHA^{commit}" 2>/dev/null; then
  if ! git -C "$ROOT" fetch --quiet --no-tags --no-write-fetch-head --refmap= \
    --no-recurse-submodules -- "$REMOTE" "$REMOTE_REF"; then
    bad "无法获取 DEFAULT_REF 的远端对象 $REMOTE_SHA"
    exit 1
  fi
fi
if ! git --no-replace-objects -C "$ROOT" cat-file -e "$REMOTE_SHA^{commit}" 2>/dev/null; then
  bad "DEFAULT_REF 的远端对象不是可验证 commit：$REMOTE_SHA"
  exit 1
fi
for want in scripts/lib/task-ledger.js scripts/shk.js; do
  ENTRY="$(git --no-replace-objects -C "$ROOT" ls-tree "$REMOTE_SHA" -- "$want" 2>/dev/null)"
  if [[ "$ENTRY" =~ ^100(644|755)[[:space:]]blob[[:space:]] ]]; then
    ok "$REF 远端 tree 含 $want"
  else
    bad "$REF 远端 tree 缺普通文件 ${want}——升级后提示的 shk task migrate 会 MODULE_NOT_FOUND"
  fi
done

echo "  [21-upgrade-ref] $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

#!/usr/bin/env bash
# 23-shell-gate-lint.sh — 门禁脚本的静态检查
#
# kit 有 20+ 个 .sh 门禁脚本。它们判断别人合不合格，所以它们自己出错的代价更高——
# 一个读错退出码的门禁不会报错，它会**放行**。
#
# 本脚本只检测**能可靠静态识别**的两类，不假装覆盖全部四条铁律：
#
#   L1  管道之后取 $?      `cmd | tail` 的 $? 是 tail 的，上游失败会被读成成功。
#                          实证：某工程因此把一次 EXIT=1 读成了成功。
#   L2  pipefail 下裸读文件  `set -euo pipefail` + `$(cat 可能不存在的文件)` = 静默死：
#                          零输出、退出码 1、没有任何错误信息。诊断法是 sh -x，
#                          trace 停在赋值行本身就是这个模式。
#
# 另外两条（不写死测试总数、为消灭某类 bug 写的代码两个分支都要测）**无法静态检测**，
# 属于人工 review 项，见 methodology/21-quality-gate-suite.md。不要因为本脚本全绿
# 就以为那两条也被覆盖了——那正是本 kit 反复吃亏的"绿灯覆盖面未声明"。

set -uo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"

violations=0
checked=0

report() {
  violations=$((violations + 1))
  printf '  [%s] %s:%s\n      %s\n' "$1" "$2" "$3" "$4"
}

scan_file() {
  local f="$1" rel="${1#"$ROOT"/}"
  checked=$((checked + 1))
  local has_pipefail=0
  grep -qE '^[[:space:]]*set[[:space:]]+-[a-z]*o?[[:space:]]*pipefail|^[[:space:]]*set[[:space:]]+-[euo]*[[:space:]]*-o[[:space:]]+pipefail' "$f" && has_pipefail=1

  local lineno=0 prev=""
  while IFS= read -r line; do
    lineno=$((lineno + 1))

    # L1: 上一行含管道且非赋值，本行用 $? —— 取到的是管道最后一段的状态
    if printf '%s' "$line" | grep -qE '\$\?' \
      && printf '%s' "$prev" | grep -qE '\|[[:space:]]*(tail|head|grep|sed|awk|tee|sort|wc)' \
      && ! printf '%s' "$prev" | grep -qE 'PIPESTATUS|^\s*#'; then
      report L1 "$rel" "$lineno" "上一行是管道，此处的 \$? 是管道末段的状态，不是上游的（用 PIPESTATUS 或拆开判断）"
    fi

    # L2: pipefail 脚本里 $(cat ...) 无兜底
    if [ "$has_pipefail" = "1" ] \
      && printf '%s' "$line" | grep -qE '\$\((cat|<)[[:space:]]' \
      && ! printf '%s' "$line" | grep -qE '\|\|[[:space:]]*(true|echo|:)|2>/dev/null' \
      && ! printf '%s' "$line" | grep -qE '^[[:space:]]*#'; then
      report L2 "$rel" "$lineno" "pipefail 下裸读文件：文件不存在会静默死（零输出+rc=1）。加 || true 或先测存在性"
    fi

    prev="$line"
  done < "$f"
}

echo "[23-shell-gate-lint] 扫描门禁脚本..."
while IFS= read -r f; do
  scan_file "$f"
done < <(find "$ROOT/tests" "$ROOT/scripts" -name '*.sh' -type f 2>/dev/null | sort)

echo "[23-shell-gate-lint] 检查了 $checked 个脚本，发现 $violations 处"
if [ "$violations" -gt 0 ]; then
  echo "[23-shell-gate-lint] FAIL"
  exit 1
fi
echo "[23-shell-gate-lint] PASS（L1/L2 无命中；另两条铁律需人工 review，见方法论）"

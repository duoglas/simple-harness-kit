#!/usr/bin/env bash
# 自动化交叉验证打分器 (M3)。
# 约定：每条 lane 的产物按统一文件名落在 lane-<x>/ 下：
#   lane-<x>/ci.yml         —— T1 产出的 GitHub Actions workflow
#   lane-<x>/validator.<ext> —— T2 产出的 no-personal-paths 校验器 (.js/.sh/.py)
# 校验器约定：接受【扫描根目录】作为第一个位置参数。
#
# 用法: ./evaluate.sh           # 评所有 lane
#       ./evaluate.sh lane-a    # 评单条
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
FIX="$HERE/fixtures"

# 准备两个隔离扫描目录：一个只含泄漏样本，一个只含干净样本
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/leak" "$TMP/clean"
cp "$FIX/leak-sample.txt"  "$TMP/leak/"
cp "$FIX/clean-sample.md"  "$TMP/clean/"
# 部分校验器只扫 git 跟踪文件（git ls-files）——这是合理设计，
# 故把两个 fixture 目录初始化为 git 仓库并 add，保证公平。
for d in "$TMP/leak" "$TMP/clean"; do
  ( cd "$d" && git init -q && git add -A ) 2>/dev/null
done

interp_for() { case "$1" in *.js) echo "node";; *.sh) echo "bash";; *.py) echo "python3";; *) echo "";; esac; }

# YAML 合法性：优先 pyyaml，回退结构检查
yaml_valid() {
  python3 - "$1" <<'PY' 2>/dev/null && return 0
import sys
try:
    import yaml
    yaml.safe_load(open(sys.argv[1], encoding='utf-8'))
    sys.exit(0)
except ImportError:
    sys.exit(3)   # 无 pyyaml，交给回退
except Exception:
    sys.exit(1)
PY
  [ $? -eq 3 ] || return 1
  # 回退：结构性 grep
  grep -qE '^[[:space:]]*on:' "$1" && grep -qE '^jobs:' "$1" && grep -qE 'runs-on:' "$1"
}

has_han() { python3 - "$1" <<'PY'
import sys,re
t=open(sys.argv[1],encoding='utf-8',errors='ignore').read()
sys.exit(0 if re.search(r'[一-鿿]',t) else 1)
PY
}

run_validator() {  # $1=validator file  $2=scan dir  -> echo exit code
  local v="$1" d="$2" ip; ip="$(interp_for "$v")"
  [ -z "$ip" ] && { echo 127; return; }
  ( $ip "$v" "$d" ) >/dev/null 2>&1; echo $?
}

eval_lane() {
  local lane="$1"
  local dir="$HERE/$lane"
  [ -d "$dir" ] || { echo "  [skip] $lane 目录不存在"; return; }
  local wf="$dir/ci.yml"
  local val; val="$(find "$dir" -maxdepth 1 -name 'validator.*' | head -1)"
  local score=0

  echo "== $lane =="

  # 1. workflow 合法 YAML
  if [ -f "$wf" ] && yaml_valid "$wf"; then echo "  [PASS] M3.1 workflow 合法 YAML"; score=$((score+1))
  else echo "  [FAIL] M3.1 workflow 合法 YAML"; fi

  # 2. workflow 调用 run-all.sh
  if [ -f "$wf" ] && grep -q 'run-all.sh' "$wf"; then echo "  [PASS] M3.2 调用 run-all.sh"; score=$((score+1))
  else echo "  [FAIL] M3.2 调用 run-all.sh"; fi

  if [ -z "$val" ]; then
    echo "  [FAIL] M3.3 validator 缺失"; echo "  [FAIL] M3.4 validator 缺失"; echo "  [FAIL] M3.5 validator 缺失"
  else
    local ec_leak ec_clean
    ec_leak="$(run_validator "$val" "$TMP/leak")"
    ec_clean="$(run_validator "$val" "$TMP/clean")"
    # 3. 对泄漏样本退出码非 0
    if [ "$ec_leak" != "0" ] && [ "$ec_leak" != "127" ]; then echo "  [PASS] M3.3 抓到植入泄漏 (exit=$ec_leak)"; score=$((score+1))
    else echo "  [FAIL] M3.3 未抓到植入泄漏 (exit=$ec_leak)"; fi
    # 4. 对干净样本退出码 0（不误报）
    if [ "$ec_clean" = "0" ]; then echo "  [PASS] M3.4 不误报 github URL/占位符 (exit=0)"; score=$((score+1))
    else echo "  [FAIL] M3.4 误报 (exit=$ec_clean)"; fi
    # 5. 输出/注释为中文
    if has_han "$val"; then echo "  [PASS] M3.5 中文 (SHK 约定)"; score=$((score+1))
    else echo "  [FAIL] M3.5 非中文"; fi
  fi

  echo "  --> M3 小计: $score / 5"
  echo ""
}

if [ "$#" -gt 0 ]; then LANES=("$@"); else LANES=(lane-a lane-b); fi
for l in "${LANES[@]}"; do eval_lane "$l"; done

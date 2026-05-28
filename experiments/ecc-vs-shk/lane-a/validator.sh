#!/usr/bin/env bash
# scripts/no-personal-paths.sh — 检测 git 跟踪文本文件里的本机绝对路径泄漏
#
# 用途:
#   扫描仓库中 git 跟踪的文本文件，检测是否包含开发者本机的绝对路径。
#   支持 macOS/Linux 格式 (/Users/<name>/...) 和 Windows 格式 (C:\Users\<name>\...)。
#
# 用法:
#   bash scripts/no-personal-paths.sh [扫描根目录]
#
#   扫描根目录 (可选): 传入后脚本以该目录为工作根进行 git ls-files 枚举。
#                       未传入时默认使用当前目录。
#
# 放行规则（以下情况不计为泄漏）:
#   1. 占位符用户名: example / me / user / username / you / yourname / your-username
#   2. 合法 GitHub URL: 含 github.com 的行（不会将项目路径误报为本机路径）
#
# 退出码:
#   0 — 未发现真实路径泄漏
#   1 — 发现至少一处真实路径泄漏
#   2 — 运行环境错误（不在 git 仓库 / 目录不存在）
#
# 设计约束:
#   - 只读，不修改任何文件
#   - 仅扫描 git 跟踪的文件（git ls-files），不扫描未跟踪文件
#   - 跳过二进制文件（用 grep -I 方式或 file 检测）

set -uo pipefail

# ── 参数处理 ──

# 第一个位置参数为扫描根目录（自动化测试时传入）
SCAN_ROOT="${1:-}"

if [ -n "$SCAN_ROOT" ]; then
  # 如果传入了目录参数，切换到该目录
  if [ ! -d "$SCAN_ROOT" ]; then
    echo "错误: 指定的扫描根目录不存在: $SCAN_ROOT" >&2
    exit 2
  fi
  cd "$SCAN_ROOT"
fi

# ── 环境检查 ──

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "错误: 当前目录不在 git 仓库内，无法枚举跟踪文件。" >&2
  exit 2
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# ── 占位符白名单（用户名匹配时放行） ──
# 这些用户名属于文档示例，不是真实本机用户名
# 注意：匹配时不区分大小写
PLACEHOLDER_PATTERN='(example|me|user|username|you|yourname|your-username|your_username)'

# macOS/Linux 路径模式: /Users/<name>/  或  /Users/<name>（行尾或后跟非路径字符）
# Windows 路径模式:     C:\Users\<name>\ 或类似
UNIX_PATTERN='/Users/[A-Za-z0-9_.-]+'
WIN_PATTERN='[A-Za-z]:\\[Uu]sers\\[A-Za-z0-9_.-]+'

echo "── 本机路径泄漏扫描 ──"
echo "仓库根: $REPO_ROOT"
echo ""

LEAK_COUNT=0
LEAK_FILES=()

# 枚举所有 git 跟踪的文件
while IFS= read -r file; do
  [ -z "$file" ] && continue

  # 跳过不存在的文件（已删除但还在 index 里的）
  [ -f "$file" ] || continue

  # 跳过二进制文件：grep -I 对二进制文件直接不匹配，用它来判断
  if ! grep -qI '' "$file" 2>/dev/null; then
    continue
  fi

  # 逐行检测：匹配 Unix 或 Windows 路径模式
  # 对每一个命中行，进一步判断是否属于放行情形
  FILE_HAS_LEAK=0

  while IFS= read -r line_with_num; do
    # line_with_num 格式: "<行号>:<内容>"
    lineno="${line_with_num%%:*}"
    content="${line_with_num#*:}"

    # ── 放行规则 1: GitHub URL ──
    # 包含 github.com 的行，路径部分是 GitHub 仓库路径，不是本机路径
    if echo "$content" | grep -qiE 'github\.com'; then
      continue
    fi

    # ── 放行规则 2: 占位符用户名 ──
    # /Users/example/  /Users/me/  C:\Users\username\ 等均放行
    if echo "$content" | grep -qiE "(/Users/${PLACEHOLDER_PATTERN}([/\\ ]|\$)|[A-Za-z]:\\\\[Uu]sers\\\\${PLACEHOLDER_PATTERN}([/\\\\ ]|\$))"; then
      continue
    fi

    # ── 真实泄漏 ──
    echo "  泄漏 $file:$lineno"
    echo "         $content" | head -c 200
    echo ""
    FILE_HAS_LEAK=1
    LEAK_COUNT=$((LEAK_COUNT + 1))

  done < <(grep -nIE "${UNIX_PATTERN}|${WIN_PATTERN}" "$file" 2>/dev/null || true)

  if [ "$FILE_HAS_LEAK" -eq 1 ]; then
    LEAK_FILES+=("$file")
  fi

done < <(git ls-files 2>/dev/null)

# ── 汇总 ──

echo "── 扫描结果 ──"

if [ "$LEAK_COUNT" -eq 0 ]; then
  echo "未发现本机路径泄漏。"
  echo ""
  exit 0
else
  echo "发现 ${LEAK_COUNT} 处本机路径泄漏，涉及 ${#LEAK_FILES[@]} 个文件："
  for f in "${LEAK_FILES[@]}"; do
    echo "  - $f"
  done
  echo ""
  echo "请将上述本机绝对路径替换为占位符（如 /Users/example/）或相对路径后再提交。"
  echo ""
  exit 1
fi

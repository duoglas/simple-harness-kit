#!/bin/bash
# Simple Harness Kit — 一键升级 bootstrap（curl | bash 入口）
#
# 用法（在旧工程根目录执行）:
#   curl -fsSL https://raw.githubusercontent.com/duoglas/simple-harness-kit/master/upgrade.sh | bash
#
# 指定版本:
#   curl -fsSL .../upgrade.sh | bash -s -- --ref v0.13.0-rc.1
#   或: SHK_REF=v0.13.0-rc.1 curl -fsSL .../upgrade.sh | bash
#
# 行为:
#   1. 定位 kit（~/.simple-harness-kit-root marker 优先，缺省 ~/simple-harness-kit；不存在则 git clone）
#   2. fetch + 切到目标 ref（分支取远端最新，tag 取定点；detached HEAD，不动本地分支）
#   3. 当前目录是 Harness 工程（有 scripts/hooks/）→ update.sh --hooks 同步 hooks + 更新已装 skills
#      否则 → 只更新已装 skills，并提示到工程根目录重跑
#
# 安全: kit 工作区有未提交改动时中止，不覆盖本地修改。

set -euo pipefail

DEFAULT_REF="v0.13.0-rc.1"
REF="${SHK_REF:-$DEFAULT_REF}"
REPO_URL="https://github.com/duoglas/simple-harness-kit.git"

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)
      [ $# -ge 2 ] || { echo "[shk-upgrade] --ref 缺少参数"; exit 1; }
      REF="$2"; shift 2 ;;
    --help|-h)
      echo "用法: curl -fsSL <raw>/upgrade.sh | bash [-s -- --ref <tag|branch>]"; exit 0 ;;
    *) shift ;;
  esac
done

# ── 1. 定位 kit ──
KIT="$(cat "$HOME/.simple-harness-kit-root" 2>/dev/null || true)"
if [ -z "$KIT" ] || [ ! -d "$KIT/.git" ]; then
  KIT="$HOME/simple-harness-kit"
fi
if [ ! -d "$KIT/.git" ]; then
  echo "[shk-upgrade] 未找到已安装的 kit，克隆到 $KIT ..."
  git clone --quiet "$REPO_URL" "$KIT"
fi
echo "[shk-upgrade] kit 位置: $KIT"

# ── 2. 脏工作区保护 + 切版本 ──
if ! git -C "$KIT" diff --quiet 2>/dev/null || ! git -C "$KIT" diff --cached --quiet 2>/dev/null; then
  echo "[shk-upgrade] 中止: kit 工作区有未提交改动（$KIT）。请先处理（git -C \"$KIT\" status）后重试。"
  exit 1
fi
git -C "$KIT" fetch --tags --quiet origin
if git -C "$KIT" show-ref -q --verify "refs/remotes/origin/$REF"; then
  git -C "$KIT" checkout -q --detach "origin/$REF"   # 分支 → 远端最新（detached，不动本地分支）
else
  git -C "$KIT" checkout -q --detach "$REF"          # tag / commit → 定点
fi
echo "[shk-upgrade] kit 已切到 $REF ($(git -C "$KIT" rev-parse --short HEAD))"

# ── 3. 同步 ──
if [ -d "scripts/hooks" ]; then
  bash "$KIT/update.sh" --hooks "$(pwd)"
else
  echo "[shk-upgrade] 当前目录不是 Harness 工程（无 scripts/hooks/），只更新已安装的全局 skills。"
  bash "$KIT/update.sh"
  echo "[shk-upgrade] 提示: 在工程根目录重跑本命令，可同步该工程的 hooks。"
fi

echo ""
echo "[shk-upgrade] 完成。新 session 生效。"
echo "[shk-upgrade] 回滚: git -C \"$KIT\" checkout master && git -C \"$KIT\" pull && bash \"$KIT/update.sh\" --hooks <工程目录>"

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

# DEFAULT_REF 必须是 origin 上**已存在**的 ref，且其 tree 必须含 task-ledger（否则
# 升级完提示的 `shk task migrate` 会 MODULE_NOT_FOUND）。两条都由
# tests/scripts/21-upgrade-ref-contract.sh 强制，不靠注释约束——R1 曾把这个字段
# 写成未推送的分支导致 checkout exit 128，当时只补了注释，注释拦不住第二次。
#
# 打 tag 的顺序：先在本 commit 里把 DEFAULT_REF 指向即将创建的 tag，再让 tag 指向本
# commit——这样 tag 内的 upgrade.sh 是自洽的，避免"必须先有 tag 才能改 ref"的死循环。
DEFAULT_REF="v0.15.0-rc.1"
REF="${SHK_REF:-$DEFAULT_REF}"
REPO_URL="https://github.com/duoglas/simple-harness-kit.git"

DO_MIGRATE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)
      [ $# -ge 2 ] || { echo "[shk-upgrade] --ref 缺少参数"; exit 1; }
      REF="$2"; shift 2 ;;
    --migrate)
      # 显式表达"顺便把本工程迁到任务态"。默认不做——迁移会建目录并改 .gitignore，
      # 属于有副作用的操作，不该在一条同步命令里隐式发生。
      DO_MIGRATE=1; shift ;;
    --help|-h)
      cat <<'USAGE'
用法:
  curl -fsSL <raw>/upgrade.sh | bash                      # 只同步 hooks/lib/CLI
  curl -fsSL <raw>/upgrade.sh | bash -s -- --migrate      # 同步 + 迁移到任务态（一键）
  curl -fsSL <raw>/upgrade.sh | bash -s -- --ref <tag>    # 指定版本

--migrate 会在当前工程执行 `shk task migrate --apply`：
  - 只复制不删除，存量 .harness/ 文件原样保留
  - 建 <tasks_dir>/<TASK-ID>/ 并追加 .gitignore 规则
  - 目标任务目录已存在时拒绝执行，不覆盖任何已有任务数据
USAGE
      exit 0 ;;
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

# ── 4. 任务态迁移 ──
# 默认只提示不执行：迁移会建目录并改 .gitignore，属于有副作用操作。
# 传 --migrate 表示用户已显式表达意图，才真正执行。
if [ -d "scripts/hooks" ] && [ ! -f ".harness/CURRENT" ]; then
  if [ "$DO_MIGRATE" = "1" ]; then
    echo ""
    echo "[shk-upgrade] 迁移到任务态（--migrate）..."
    if [ ! -f "scripts/shk.js" ]; then
      echo "[shk-upgrade] 中止: scripts/shk.js 未同步成功，无法迁移。" >&2
      exit 1
    fi
    if node scripts/shk.js task migrate --apply; then
      echo "[shk-upgrade] 迁移完成。当前任务: $(cat .harness/CURRENT 2>/dev/null || echo '(未知)')"
      echo "[shk-upgrade] 下一步: node scripts/shk.js task status"
    else
      echo "[shk-upgrade] 迁移未执行（见上方原因）。同步本身已完成，可稍后手动重试。" >&2
    fi
  else
    echo ""
    echo "[shk-upgrade] 本工程尚未启用任务态（无 .harness/CURRENT）。"
    echo "[shk-upgrade] 预演迁移: node scripts/shk.js task migrate"
    echo "[shk-upgrade] 一键迁移: 重跑本命令并加 -s -- --migrate"
    echo "[shk-upgrade] 迁移只复制不删除，存量 .harness/ 文件原样保留。"
  fi
fi

echo ""
echo "[shk-upgrade] 完成。新 session 生效。"
echo "[shk-upgrade] 回滚: git -C \"$KIT\" checkout master && git -C \"$KIT\" pull && bash \"$KIT/update.sh\" --hooks <工程目录>"

#!/bin/bash
# Simple Harness Kit — 一键安装全部 Skills
#
# 用法:
#   bash install.sh                    # 交互式选择工具和 scope
#   bash install.sh --target claude    # 只装 Claude Code
#   bash install.sh --target codex     # 只装 Codex CLI
#   bash install.sh --target both      # 两个都装
#   bash install.sh --scope project    # 安装到当前项目（默认 personal 全局）
#
# Skills 在新 session 启动时自动发现，无需额外配置。

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/skills"

# 解析参数
SCOPE="personal"
TARGET=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --scope)
      SCOPE="$2"
      shift 2
      ;;
    --target)
      TARGET="$2"
      shift 2
      ;;
    --help|-h)
      echo "用法: bash install.sh [--target claude|codex|both] [--scope personal|project]"
      echo ""
      echo "  --target claude   只安装到 Claude Code"
      echo "  --target codex    只安装到 Codex CLI"
      echo "  --target both     两个都装"
      echo "  (不指定)          交互式选择"
      echo ""
      echo "  --scope personal  安装到 ~/（默认，所有项目可用）"
      echo "  --scope project   安装到当前项目 .claude/.codex 目录"
      exit 0
      ;;
    *)
      echo "未知参数: $1 (用 --help 查看用法)"
      exit 1
      ;;
  esac
done

echo ""
echo "Simple Harness Kit — Skill 安装"
echo "================================"
echo ""

# ── 工具检测 ──

has_claude=false
has_codex=false
if command -v claude &>/dev/null; then has_claude=true; fi
if command -v codex &>/dev/null; then has_codex=true; fi

# ── 交互式选择（如果未指定 --target）──

if [ -z "$TARGET" ]; then
  # 默认选择所有已安装的
  default_choice=""
  if $has_claude && $has_codex; then
    default_choice="1,2"
  elif $has_claude; then
    default_choice="1"
  elif $has_codex; then
    default_choice="2"
  else
    default_choice="1"
  fi

  if [ -t 0 ]; then
    # 交互模式：显示菜单让用户选择
    echo "检测到已安装的工具:"
    if $has_claude; then echo "  [1] Claude Code  (已安装)"; else echo "  [1] Claude Code  (未检测到)"; fi
    if $has_codex;  then echo "  [2] Codex CLI    (已安装)"; else echo "  [2] Codex CLI    (未检测到)"; fi
    echo ""

    printf "安装目标 (输入数字，多选用逗号分隔，回车=%s): " "$default_choice"
    read -r choice
    if [ -z "$choice" ]; then choice="$default_choice"; fi
  else
    # 非交互模式（管道/脚本）：自动选择已安装的工具
    choice="$default_choice"
  fi

  install_claude=false
  install_codex=false
  IFS=',' read -ra parts <<< "$choice"
  for p in "${parts[@]}"; do
    p=$(echo "$p" | tr -d ' ')
    case "$p" in
      1) install_claude=true ;;
      2) install_codex=true ;;
      *) echo "无效选项: $p"; exit 1 ;;
    esac
  done
else
  # --target 参数
  install_claude=false
  install_codex=false
  case "$TARGET" in
    claude) install_claude=true ;;
    codex)  install_codex=true ;;
    both)   install_claude=true; install_codex=true ;;
    *)
      echo "无效的 --target 值: $TARGET (可选: claude, codex, both)"
      exit 1
      ;;
  esac
fi

if ! $install_claude && ! $install_codex; then
  echo "未选择任何安装目标。"
  exit 1
fi

# ── 构建安装目标列表 ──

DEST_LIST=()

if $install_claude; then
  case "$SCOPE" in
    personal) DEST_LIST+=("$HOME/.claude/skills") ;;
    project)  DEST_LIST+=("$(pwd)/.claude/skills") ;;
    *) echo "无效 scope: $SCOPE"; exit 1 ;;
  esac
fi

if $install_codex; then
  case "$SCOPE" in
    personal) DEST_LIST+=("$HOME/.codex/skills") ;;
    project)  DEST_LIST+=("$(pwd)/.codex/skills") ;;
    *) echo "无效 scope: $SCOPE"; exit 1 ;;
  esac
fi

# ── 安装 ──

total_installed=0
for DEST in "${DEST_LIST[@]}"; do
  echo "来源: $SKILLS_SRC"
  echo "目标: $DEST"
  echo ""

  mkdir -p "$DEST"

  installed=0
  for skill_dir in "$SKILLS_SRC"/*/; do
    if [ -f "$skill_dir/SKILL.md" ]; then
      skill_name=$(basename "$skill_dir")
      # 幂等: 如 dest 已存在必须先删, 否则 cp -r 会把 source 嵌套进 dest (VH-10 根因)
      rm -rf "$DEST/$skill_name"
      cp -r "$skill_dir" "$DEST/$skill_name"
      echo "  OK  $skill_name"
      installed=$((installed + 1))
    fi
  done

  echo ""
  echo "安装完成: $installed 个 Skills → $DEST"
  echo ""
  total_installed=$((total_installed + installed))
done

# ── 持久化 kit 路径（供 harness-init Step 0 优先读取，避免每次都要让用户输入）──
# 参见 SKILL.md Step 0 优先级 (2)。env var 仍是优先级 (1)。
echo "$SCRIPT_DIR" > "$HOME/.simple-harness-kit-root"
echo "已记录 kit 路径到 ~/.simple-harness-kit-root（供 harness-init 自动定位）"
echo ""

# ── 交互式 alias 设置（仅 Codex 装了才询问；非 TTY 跳过）──
# 动机: codex 启动需要 hooks feature 才会触发 Hook；alias 只封装当前官方 flags，不改变 install/init 入口。
# 等效原生方式: ~/.codex/config.toml 加 [features] hooks=true。
# 幂等: 用 marker 块检测，已存在跳过。
if $install_codex; then
  codex_alias_cmd="codex --enable hooks --sandbox workspace-write --ask-for-approval on-request"
  alias_marker_begin="# >>> simple-harness-kit alias >>>"
  alias_marker_end="# <<< simple-harness-kit alias <<<"

  # 检测 shell rc
  shell_basename=$(basename "${SHELL:-/bin/zsh}")
  case "$shell_basename" in
    zsh)  rcfile="$HOME/.zshrc" ;;
    bash) rcfile="$HOME/.bashrc" ;;
    *)    rcfile="" ;;
  esac

  if [ -n "$rcfile" ]; then
    if grep -qF "$alias_marker_begin" "$rcfile" 2>/dev/null; then
      echo "Codex alias 已在 $rcfile 中（跳过，避免重复）。"
      echo ""
    else
      echo "Codex alias 设置（保留 codex 原入口，只补当前 hooks/sandbox flags）:"
      echo "  alias codex='$codex_alias_cmd'"
      echo "  (--enable hooks: 加载 Harness hooks)"
      echo "  (--sandbox workspace-write + --ask-for-approval on-request: 当前 Codex CLI 的显式开发默认)"
      echo "  bypass once: \\codex (反斜杠转义) 或 'command codex'"
      echo ""

      if [ -t 0 ]; then
        printf "添加到 %s? [Y]es / [n]o (打印让你手动加) / [s]kip silently: " "$rcfile"
        read -r alias_choice
      else
        # 非 TTY (CI / 管道) 默认 skip，不打扰
        alias_choice="s"
      fi

      case "${alias_choice:-y}" in
        y|Y|yes|"")
          {
            echo ""
            echo "$alias_marker_begin"
            echo "# Auto-enable Harness hooks for codex. Bypass once: \\codex (escape with backslash)."
            echo "# Or remove this block to disable."
            echo "alias codex='$codex_alias_cmd'"
            echo "$alias_marker_end"
          } >> "$rcfile"
          echo "  已添加到 $rcfile。新 shell 生效，或现在: source $rcfile"
          ;;
        n|N|no)
          echo ""
          echo "  请手动添加到 $rcfile 末尾："
          echo "    alias codex='$codex_alias_cmd'"
          ;;
        s|S|skip|*)
          echo "  跳过 alias 设置。"
          ;;
      esac
      echo ""
    fi
  fi
fi

# ── 后续指引 ──

echo "用户手动触发:"
echo "  /harness-init       为项目初始化 Harness（第一次用）"
echo "  /harness-start      启动新任务（交互式，自动带约束）"
echo "  /harness-feedback   报告问题（交互式，按 F1-F5 处理）"
echo "  /harness-on         启用 Harness 模式"
echo "  /harness-off        临时关闭 Harness 模式"
echo ""
echo "AI 自动调用（无需手动触发）:"
echo "  auto-harness-qa              VERIFY 阶段自动 QA"
echo "  auto-harness-santa           高风险时自动对抗验证"
echo "  auto-harness-review          REVIEW 阶段自动复盘"
echo "  auto-harness-learn           分析行为数据"
echo "  auto-harness-test-bootstrap  补测试体系"
echo ""
echo "下一步:"
echo "  1. 进入你的项目目录"

if $install_claude; then
  echo "  2. [Claude Code] 启动新 session: claude"
  echo "     输入: /harness-init"
fi

if $install_codex; then
  echo "  2. [Codex CLI] 启动 — init 必须 TUI 模式（exec 模式 non-interactive，定位 kit 时会卡死）:"
  echo "     codex                                          # 已设 alias 时（一行覆盖）"
  echo "     codex --enable hooks --sandbox workspace-write --ask-for-approval on-request  # 未设 alias"
  echo "     启动后输入: \$harness-init                       # Codex 用 \$ 不是 / 触发 skill"
fi

echo ""
echo "  init 完成后开新 session（Hook 在新 session 生效）"
echo ""
echo "更新: bash $SCRIPT_DIR/update.sh"
echo ""

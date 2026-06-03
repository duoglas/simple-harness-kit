#!/bin/bash
# Simple Harness Kit — 更新 Skills + 同步 Hook 脚本
#
# 用法:
#   bash update.sh                          # 只更新 Skills
#   bash update.sh --hooks /path/to/project # 同时更新目标项目的 Hook 脚本
#   bash update.sh --hooks-only /path/to/project # 只同步目标项目 Hook，不更新个人 Skills
#
# Skills 更新后需要新 session 生效。

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/skills"
HOOKS_SRC="$SCRIPT_DIR/scripts/hooks"
CODEX_HOOKS_GEN="$SCRIPT_DIR/scripts/generate-codex-hooks.js"

echo ""
echo "Simple Harness Kit — 更新"
echo "========================="
echo ""

# 解析参数
PROJECT_DIR=""
DRY_RUN=false
SKIP_SKILLS=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --hooks)
      if [ -z "$2" ]; then
        echo "缺少参数: --hooks <path>"
        exit 1
      fi
      PROJECT_DIR="$2"
      shift 2
      ;;
    --hooks-only)
      if [ -z "$2" ]; then
        echo "缺少参数: --hooks-only <path>"
        exit 1
      fi
      PROJECT_DIR="$2"
      SKIP_SKILLS=true
      shift 2
      ;;
    --skip-skills)
      SKIP_SKILLS=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help|-h)
      echo "用法: bash update.sh [--hooks /path/to/project] [--hooks-only /path/to/project] [--skip-skills] [--dry-run]"
      echo ""
      echo "  不带参数: 只更新已安装的 Skills (Claude Code + Codex)"
      echo "  --hooks <path>: 同时更新目标项目的 Hook 脚本到最新模板版本"
      echo "  --hooks-only <path>: 只同步目标项目 Hook 脚本，不更新个人 Skills"
      echo "  --skip-skills: 跳过 Skills 更新；可与 --hooks 搭配使用"
      echo "  --dry-run: 只输出版本差异清单，不执行更新"
      exit 0
      ;;
    *)
      echo "未知参数: $1"
      exit 1
      ;;
  esac
done

# ── 1. 更新 Skills（扫描 Claude Code + Codex 两个位置）──

# 检查所有可能的安装位置
updated=0
if $SKIP_SKILLS; then
  echo "跳过 Skills 更新（--skip-skills/--hooks-only）。"
else
  for dest in "$HOME/.claude/skills" "$HOME/.codex/skills" "$(pwd)/.claude/skills" "$(pwd)/.codex/skills"; do
    if [ -d "$dest" ]; then
      echo "更新 Skills: $dest"
      for skill_dir in "$SKILLS_SRC"/*/; do
        if [ -f "$skill_dir/SKILL.md" ]; then
          skill_name=$(basename "$skill_dir")
          if [ -d "$dest/$skill_name" ]; then
            if $DRY_RUN; then
              echo "  [dry-run] 将更新: $skill_name"
            else
              # 幂等: 必须先删 dest, 否则 cp -r 会把 source 嵌套进 dest (VH-10 根因)
              rm -rf "$dest/$skill_name"
              cp -r "$skill_dir" "$dest/$skill_name"
              echo "  更新: $skill_name"
            fi
            updated=$((updated + 1))
          fi
        fi
      done
    fi
  done

  if [ $updated -eq 0 ]; then
    echo "未找到已安装的 Skills。先运行 install.sh 安装。"
  fi
fi

# ── 2. 更新目标项目的 Hook 脚本 ──

# 提取文件中的 @version 值
extract_version() {
  local file="$1"
  if [ -f "$file" ]; then
    grep -m1 '@version' "$file" | sed 's/.*@version[[:space:]]*//' | tr -d ' */'
  fi
}

if [ -n "$PROJECT_DIR" ]; then
  echo ""
  echo "更新 Hook 脚本: $PROJECT_DIR/scripts/hooks/"

  if [ ! -d "$PROJECT_DIR/scripts/hooks" ]; then
    echo "  目标目录不存在: $PROJECT_DIR/scripts/hooks/"
    echo "  请先运行 /harness-init 初始化项目。"
    exit 1
  fi

  # 版本比对清单
  echo ""
  echo "  版本检测:"
  needs_update=0
  up_to_date=0
  locally_modified=0
  new_hooks=0

  for hook in "$HOOKS_SRC"/*.js; do
    if [ -f "$hook" ]; then
      name=$(basename "$hook")
      target="$PROJECT_DIR/scripts/hooks/$name"
      src_ver=$(extract_version "$hook")

      if [ ! -f "$target" ]; then
        echo "  新增: $name (目标不存在)"
        new_hooks=$((new_hooks + 1))
      else
        tgt_ver=$(extract_version "$target")

        if [ "$src_ver" = "$tgt_ver" ]; then
          # 版本号相同，检查内容是否一致
          if diff -q "$hook" "$target" &>/dev/null; then
            echo "  已是最新: $name ($src_ver)"
            up_to_date=$((up_to_date + 1))
          else
            echo "  本地已修改: $name (版本 $tgt_ver 匹配但内容不同)"
            locally_modified=$((locally_modified + 1))
          fi
        elif [ -z "$tgt_ver" ]; then
          echo "  本地已修改: $name (无版本号)"
          locally_modified=$((locally_modified + 1))
        else
          echo "  需要更新: $name ($tgt_ver -> $src_ver)"
          needs_update=$((needs_update + 1))
        fi
      fi
    fi
  done

  echo ""
  echo "  统计: $needs_update 需更新, $locally_modified 本地已修改, $new_hooks 新增, $up_to_date 已最新"

  if $DRY_RUN; then
    echo ""
    echo "  --dry-run 模式，未执行更新。"
  else
    # 执行更新
    synced=0
    installed=0
    for hook in "$HOOKS_SRC"/*.js; do
      if [ -f "$hook" ]; then
        name=$(basename "$hook")
        target="$PROJECT_DIR/scripts/hooks/$name"
        if [ ! -f "$target" ]; then
          cp "$hook" "$target"
          echo "  新增安装: $name"
          installed=$((installed + 1))
        elif ! diff -q "$hook" "$target" &>/dev/null; then
          tgt_ver=$(extract_version "$target")
          src_ver=$(extract_version "$hook")
          if [ -n "$tgt_ver" ] && [ "$src_ver" = "$tgt_ver" ]; then
            echo "  [警告] 覆盖本地修改: $name (可用 git diff 查看被覆盖内容)"
          fi
          cp "$hook" "$target"
          echo "  更新: $name"
          synced=$((synced + 1))
        fi
      fi
    done

    if [ $synced -eq 0 ] && [ $installed -eq 0 ]; then
      echo "  所有 Hook 已是最新版。"
    else
      echo "  更新了 $synced 个, 新增了 $installed 个 Hook。新 session 生效。"
    fi

    # ── 2.5 同步 Codex hooks.json（如果存在）──
    if [ -f "$PROJECT_DIR/.codex/hooks.json" ] && [ -f "$PROJECT_DIR/.claude/settings.json" ]; then
      echo ""
      echo "同步 Codex hooks.json..."
      if [ -f "$CODEX_HOOKS_GEN" ]; then
        gen_cmd=(node "$CODEX_HOOKS_GEN" \
          --input "$PROJECT_DIR/.claude/settings.json" \
          --output "$PROJECT_DIR/.codex/hooks.json")
        if ! "${gen_cmd[@]}"; then
          echo "  [错误] Codex hooks 同步失败: $PROJECT_DIR/.codex/hooks.json" >&2
          echo "  输入文件: $PROJECT_DIR/.claude/settings.json" >&2
          echo "  输出文件: $PROJECT_DIR/.codex/hooks.json" >&2
          echo "  可手动执行:" >&2
          printf '  %q' "${gen_cmd[@]}" >&2
          echo "" >&2
          exit 1
        fi
        echo "  .codex/hooks.json 已从 settings.json 重新生成。"
      else
        echo "  [警告] generate-codex-hooks.js 不存在，跳过 Codex 同步。"
      fi
    fi
  fi
fi

echo ""

# ── 刷新 kit 路径（kit 可能被移动）──
# install.sh 也写这个文件；update.sh 同步以防 kit 路径变化。
echo "$SCRIPT_DIR" > "$HOME/.simple-harness-kit-root"
echo "已刷新 kit 路径到 ~/.simple-harness-kit-root"
echo ""

echo "完成。新 session 生效。"
echo ""

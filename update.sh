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
LIB_SRC="$SCRIPT_DIR/scripts/lib"
CODEX_HOOKS_GEN="$SCRIPT_DIR/scripts/generate-codex-hooks.js"
CODEX_HOOKS_TMP=""
CODEX_HOOKS_TARGET=""

cleanup_codex_hooks_tmp() {
  if [ -n "$CODEX_HOOKS_TMP" ] && [ -f "$CODEX_HOOKS_TMP" ]; then
    rm -f "$CODEX_HOOKS_TMP"
  fi
}
trap cleanup_codex_hooks_tmp EXIT

# Validate every existing parent component without following symlinks. Missing
# parents are allowed during preflight and are created one component at a time
# by ensure_safe_project_parent(). PROJECT_DIR is canonicalized before use.
PROJECT_PATH_PROBLEM=""
safe_project_parent() {
  local rel="$1" parent current part old_ifs
  PROJECT_PATH_PROBLEM=""
  parent="${rel%/*}"
  [ "$parent" != "$rel" ] || parent="."
  current="$PROJECT_DIR"
  old_ifs="$IFS"
  IFS='/' read -r -a parts <<< "$parent"
  IFS="$old_ifs"
  for part in "${parts[@]}"; do
    [ -n "$part" ] && [ "$part" != "." ] || continue
    current="$current/$part"
    if [ -L "$current" ]; then
      PROJECT_PATH_PROBLEM="$rel (parent symlink: ${current#"$PROJECT_DIR/"})"
      return 1
    fi
    if [ -e "$current" ] && [ ! -d "$current" ]; then
      PROJECT_PATH_PROBLEM="$rel (parent type-change: ${current#"$PROJECT_DIR/"})"
      return 1
    fi
    if [ ! -e "$current" ]; then
      # A child cannot already exist below a missing parent. The write path will
      # create and immediately revalidate each missing directory component.
      return 0
    fi
  done
  return 0
}

ensure_safe_project_parent() {
  local rel="$1" parent current part old_ifs
  safe_project_parent "$rel" || return 1
  parent="${rel%/*}"
  [ "$parent" != "$rel" ] || parent="."
  current="$PROJECT_DIR"
  old_ifs="$IFS"
  IFS='/' read -r -a parts <<< "$parent"
  IFS="$old_ifs"
  for part in "${parts[@]}"; do
    [ -n "$part" ] && [ "$part" != "." ] || continue
    current="$current/$part"
    if [ ! -e "$current" ] && [ ! -L "$current" ]; then
      mkdir "$current" || return 1
    fi
    if [ -L "$current" ] || [ ! -d "$current" ]; then
      PROJECT_PATH_PROBLEM="$rel (unsafe parent after create: ${current#"$PROJECT_DIR/"})"
      return 1
    fi
  done
  return 0
}

# Install a managed file without following either its parents or the leaf.
# A same-directory temporary plus atomic replace updates the project path itself;
# directory/non-regular leaves remain fail-closed even in force mode.
atomic_install_file() {
  local source="$1" target="$2" rel dir base tmp
  rel="${target#"$PROJECT_DIR/"}"
  [ "$rel" != "$target" ] || { echo "  [错误] target escapes project: $target" >&2; return 1; }
  ensure_safe_project_parent "$rel" || { echo "  [错误] unsafe project parent: $PROJECT_PATH_PROBLEM" >&2; return 1; }
  if [ ! -L "$target" ] && [ -e "$target" ] && [ ! -f "$target" ]; then
    echo "  [错误] managed target is non-regular and cannot be replaced safely: $rel" >&2
    return 1
  fi
  dir="$(dirname "$target")"
  base="$(basename "$target")"
  if ! tmp="$(mktemp "$dir/.${base}.shk-update.XXXXXX")"; then
    return 1
  fi
  if ! cp -p "$source" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  safe_project_parent "$rel" || { rm -f "$tmp"; echo "  [错误] unsafe project parent before replace: $PROJECT_PATH_PROBLEM" >&2; return 1; }
  if ! python3 - "$tmp" "$target" <<'PY_REPLACE'
import os
import sys
os.replace(sys.argv[1], sys.argv[2])
PY_REPLACE
  then
    rm -f "$tmp"
    return 1
  fi
  if [ -L "$target" ] || [ ! -f "$target" ]; then
    echo "  [错误] managed target did not become a regular file: $rel" >&2
    return 1
  fi
}

echo ""
echo "Simple Harness Kit — 更新"
echo "========================="
echo ""

# 解析参数
PROJECT_DIR=""
DRY_RUN=false
SKIP_SKILLS=false
FORCE_OVERWRITE="${SHK_FORCE_OVERWRITE:-0}"
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
    --force-overwrite)
      FORCE_OVERWRITE=1
      shift
      ;;
    --help|-h)
      echo "用法: bash update.sh [--hooks /path/to/project] [--hooks-only /path/to/project] [--skip-skills] [--dry-run] [--force-overwrite]"
      echo ""
      echo "  不带参数: 只更新已安装的 Skills (Claude Code + Codex)"
      echo "  --hooks <path>: 同时更新目标项目的 Hook 脚本到最新模板版本"
      echo "  --hooks-only <path>: 只同步目标项目 Hook 脚本，不更新个人 Skills"
      echo "  --skip-skills: 跳过 Skills 更新；可与 --hooks 搭配使用"
      echo "  --dry-run: 只输出版本差异清单，不执行更新"
      echo "  --force-overwrite: 显式覆盖无法识别为历史 kit 原版的项目定制文件（默认 fail-closed）"
      exit 0
      ;;
    *)
      echo "未知参数: $1"
      exit 1
      ;;
  esac
done

# 识别目标文件是否为 SHK Git 历史中同路径出现过的已知原版。
# skill 与项目受管文件共用这条判断，避免只比较当前版本而误删旧版原件。
known_kit_blob_rel() {
  local rel="$1" target="$2" blob
  git -C "$SCRIPT_DIR" rev-parse --git-dir >/dev/null 2>&1 || return 1
  blob="$(git -C "$SCRIPT_DIR" hash-object "$target" 2>/dev/null || true)"
  [ -n "$blob" ] || return 1
  git -C "$SCRIPT_DIR" rev-list --objects --all -- "$rel" 2>/dev/null \
    | awk '{print $1}' | grep -Fxq "$blob"
}

known_kit_blob() {
  local source="$1" target="$2" rel
  rel="${source#"$SCRIPT_DIR/"}"
  known_kit_blob_rel "$rel" "$target"
}

skill_customized=()
append_skill_conflict() {
  skill_customized+=("$1")
}

# C-GATE-26：update_skills() 会 rm -rf 整个受管 skill，因此必须在第一次
# 写入前递归审计 HOME + 显式项目的四个 skill roots。当前上游内容以及 Git
# 历史中同路径的旧版原件可安全替换；额外文件、未知内容、symlink/类型变化
# 一律视为定制并 fail-closed。
preflight_skills() {
  local local_skill_root dest skill_dir skill_name target_skill entry rel source
  skill_customized=()
  $SKIP_SKILLS && return 0
  local_skill_root="${PROJECT_DIR:-$(pwd)}"
  for dest in "$HOME/.claude/skills" "$HOME/.codex/skills" "$local_skill_root/.claude/skills" "$local_skill_root/.codex/skills"; do
    [ -d "$dest" ] || continue
    for skill_dir in "$SKILLS_SRC"/*/; do
      [ -f "$skill_dir/SKILL.md" ] || continue
      skill_name="$(basename "$skill_dir")"
      target_skill="$dest/$skill_name"
      if [ -L "$target_skill" ] || { [ -e "$target_skill" ] && [ ! -d "$target_skill" ]; }; then
        append_skill_conflict "$target_skill"
        continue
      fi
      [ -d "$target_skill" ] || continue
      while IFS= read -r -d '' entry; do
        rel="${entry#"$target_skill"/}"
        source="$skill_dir$rel"
        if [ -L "$entry" ]; then
          if [ -L "$source" ] && [ "$(readlink "$entry")" = "$(readlink "$source")" ]; then
            continue
          fi
          append_skill_conflict "$entry"
        elif [ -f "$entry" ]; then
          if [ -f "$source" ] && cmp -s "$source" "$entry"; then
            continue
          fi
          if known_kit_blob_rel "skills/$skill_name/$rel" "$entry"; then
            continue
          fi
          append_skill_conflict "$entry"
        elif [ -d "$entry" ]; then
          if [ -e "$source" ] && [ ! -d "$source" ]; then
            append_skill_conflict "$entry"
          elif [ ! -e "$source" ] && [ -z "$(find "$entry" -mindepth 1 -print -quit 2>/dev/null)" ]; then
            append_skill_conflict "$entry"
          fi
        else
          append_skill_conflict "$entry"
        fi
      done < <(find "$target_skill" -mindepth 1 -print0)
    done
  done
}

report_skill_conflicts() {
  [ ${#skill_customized[@]} -gt 0 ] || return 0
  echo ""
  echo "  [阻断] 检测到 ${#skill_customized[@]} 个 skill 定制或未知文件："
  printf '    - %s\n' "${skill_customized[@]}"
  echo "  默认不覆盖，避免 rm -rf 静默删除 skill 定制。"
  echo "  只有确认要丢弃这些定制时，才使用 --force-overwrite 或 SHK_FORCE_OVERWRITE=1。"
  if ! $DRY_RUN && [ "$FORCE_OVERWRITE" != "1" ]; then
    return 1
  fi
  if [ "$FORCE_OVERWRITE" = "1" ]; then
    echo "  [显式覆盖] 已收到 force-overwrite，将覆盖上述 skill 定制。"
  else
    echo "  [dry-run] 仅报告 skill 冲突，未写入。"
  fi
  return 0
}

# ── 1. 更新 Skills（扫描 Claude Code + Codex 两个位置）──
# 有目标项目时，这个函数只能在完整项目预检通过后调用，避免半升级。
update_skills() {
  local updated=0
  local local_skill_root="${PROJECT_DIR:-$(pwd)}"
  if $SKIP_SKILLS; then
    echo "跳过 Skills 更新（--skip-skills/--hooks-only）。"
  else
    for dest in "$HOME/.claude/skills" "$HOME/.codex/skills" "$local_skill_root/.claude/skills" "$local_skill_root/.codex/skills"; do
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
}

# ── 2. 更新目标项目的 Hook 脚本 ──

# 提取文件中的 @version 值
extract_version() {
  local file="$1"
  if [ -f "$file" ]; then
    grep -m1 '@version' "$file" | sed 's/.*@version[[:space:]]*//' | tr -d ' */'
  fi
}

# 从 "0.13.2(kit 0.13.0 ...)" 这类版本串里取出前导的 x.y.z 数字部分
version_core() {
  printf '%s' "$1" | sed -n 's/^\([0-9][0-9]*\(\.[0-9][0-9]*\)*\).*/\1/p'
}

# 比较两个版本：0=相等 1=第一个更大 2=第二个更大。无法解析时返回 3。
version_cmp() {
  local a b
  a="$(version_core "$1")"; b="$(version_core "$2")"
  [ -n "$a" ] && [ -n "$b" ] || { echo 3; return; }
  [ "$a" = "$b" ] && { echo 0; return; }
  if [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -1)" = "$a" ]; then echo 2; else echo 1; fi
}

preflight_skills

if [ -z "$PROJECT_DIR" ]; then
  report_skill_conflicts || exit 1
  update_skills
fi

if [ -n "$PROJECT_DIR" ]; then
  if [ ! -d "$PROJECT_DIR" ]; then
    echo "  目标项目目录不存在或不是目录: $PROJECT_DIR"
    exit 1
  fi
  PROJECT_DIR="$(cd -P "$PROJECT_DIR" && pwd)"

  echo ""
  echo "更新 Hook 脚本: $PROJECT_DIR/scripts/hooks/"

  # C-GATE-21：项目中的受管文件可能包含已提交的本地定制，不能仅凭
  # @version 较旧就判定为“可覆盖”。目标内容若能在 kit Git 历史中找到完全相同
  # 的 blob，说明它是已知原版，可以安全升级。长期由项目维护的 override 必须在
  # .harness/shk-overrides.v1 里绑定“已审阅的当前上游 blob”；上游一变即重新阻断。
  # 其余未知内容整批 fail-closed。预检必须发生在第一个项目文件写入之前。

  OVERRIDE_MANIFEST="$PROJECT_DIR/.harness/shk-overrides.v1"
  managed_sources=("$HOOKS_SRC"/*.js "$LIB_SRC"/*.js "$LIB_SRC"/*.py \
    "$SCRIPT_DIR/scripts/run-guarded.sh" "$SCRIPT_DIR/scripts/shk.js")

  # C-GATE-29：最终文件安全不够；scripts、hooks、lib、.harness 等任一父路径
  # 若是 symlink/type-change，后续 diff/cp/mktemp 都可能越界。force 也不能放行父路径。
  project_path_errors=()
  for source in "${managed_sources[@]}"; do
    [ -f "$source" ] || continue
    rel="${source#"$SCRIPT_DIR/"}"
    safe_project_parent "$rel" || project_path_errors+=("$PROJECT_PATH_PROBLEM")
  done
  for rel in ".harness/shk-overrides.v1" ".codex/hooks.json" ".claude/settings.json"; do
    safe_project_parent "$rel" || project_path_errors+=("$PROJECT_PATH_PROBLEM")
  done
  if [ ${#project_path_errors[@]} -gt 0 ]; then
    echo ""
    echo "  [阻断] 检测到项目受管路径的 parent symlink/type-change："
    printf '    - %s\n' "${project_path_errors[@]}"
    echo "  父路径边界无法安全确认；--force-overwrite 也不会跟随或替换父目录。"
    exit 1
  fi

  if [ ! -d "$PROJECT_DIR/scripts/hooks" ]; then
    echo "  目标目录不存在: $PROJECT_DIR/scripts/hooks/"
    echo "  请先运行 /harness-init 初始化项目。"
    exit 1
  fi
  if [ -L "$OVERRIDE_MANIFEST" ] || { [ -e "$OVERRIDE_MANIFEST" ] && [ ! -f "$OVERRIDE_MANIFEST" ]; }; then
    echo "  [阻断] override manifest 是 symlink/type-change: $OVERRIDE_MANIFEST"
    exit 1
  fi

  source_for_managed_rel() {
    local want="$1" source rel
    for source in "${managed_sources[@]}"; do
      [ -f "$source" ] || continue
      rel="${source#"$SCRIPT_DIR/"}"
      if [ "$rel" = "$want" ]; then
        printf '%s\n' "$source"
        return 0
      fi
    done
    return 1
  }
  source_blob() {
    git -C "$SCRIPT_DIR" hash-object "$1" 2>/dev/null
  }
  append_manifest_error() {
    if [ -n "$manifest_errors" ]; then
      manifest_errors="$manifest_errors
$1"
    else
      manifest_errors="$1"
    fi
  }
  is_approved_override() {
    local want="$1" item
    [ "$FORCE_OVERWRITE" != "1" ] || return 1
    for item in "${approved_overrides[@]}"; do
      [ "$item" = "$want" ] && return 0
    done
    return 1
  }

  manifest_errors=""
  manifest_entry_count=0
  approved_overrides=()
  if [ -f "$OVERRIDE_MANIFEST" ]; then
    manifest_errors="$(awk '
      /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
      NF != 2 { print "line " NR ": expected <blob> <relative-path>"; next }
      length($1) != 40 && length($1) != 64 { print "line " NR ": invalid git blob length"; next }
      $1 !~ /^[0-9a-f]+$/ { print "line " NR ": git blob must be lowercase hex"; next }
      substr($2, 1, 1) == "/" || $2 ~ /(^|\/)\.\.($|\/)/ { print "line " NR ": path must stay project-relative"; next }
      seen[$2]++ { if (seen[$2] == 2) print "duplicate path: " $2 }
    ' "$OVERRIDE_MANIFEST")"

    while read -r declared_blob rel extra; do
      [ -n "$declared_blob" ] || continue
      case "$declared_blob" in \#*) continue ;; esac
      [ -z "$extra" ] || continue
      manifest_entry_count=$((manifest_entry_count + 1))
      source="$(source_for_managed_rel "$rel" 2>/dev/null || true)"
      if [ -z "$source" ]; then
        append_manifest_error "非 SHK 受管路径: $rel"
        continue
      fi
      current_blob="$(source_blob "$source" 2>/dev/null || true)"
      if [ -z "$current_blob" ]; then
        append_manifest_error "cannot hash managed source: $rel"
      elif [ "$declared_blob" != "$current_blob" ]; then
        append_manifest_error "上游 blob 已变化: $rel manifest=$declared_blob current=$current_blob"
      elif [ "$FORCE_OVERWRITE" != "1" ]; then
        if [ -L "$PROJECT_DIR/$rel" ]; then
          append_manifest_error "override target is a symlink: $rel"
        elif [ ! -f "$PROJECT_DIR/$rel" ]; then
          append_manifest_error "override target missing or non-regular: $rel"
        elif diff -q "$source" "$PROJECT_DIR/$rel" &>/dev/null; then
          append_manifest_error "override target equals upstream and is not a project override: $rel"
        else
          approved_overrides+=("$rel")
        fi
      fi
    done < <(awk 'NF == 2 && $1 !~ /^#/ { print $1, $2 }' "$OVERRIDE_MANIFEST")
  fi

  if [ -n "$manifest_errors" ]; then
    echo ""
    echo "  [阻断] override manifest 无效或已过期: $OVERRIDE_MANIFEST"
    while IFS= read -r item; do
      [ -n "$item" ] && printf '    - %s\n' "$item"
    done <<< "$manifest_errors"
    echo "  manifest 必须只引用当前 SHK 受管路径，并绑定每个当前上游 blob。"
    if ! $DRY_RUN && [ "$FORCE_OVERWRITE" != "1" ]; then
      exit 1
    fi
    if [ "$FORCE_OVERWRITE" = "1" ]; then
      approved_overrides=()
      echo "  [显式覆盖] 将忽略 manifest、覆盖全部项目定制，并在同步成功后删除 manifest。"
    else
      echo "  [dry-run] 仅报告 manifest 错误，未写入项目。"
    fi
  elif [ "$FORCE_OVERWRITE" = "1" ] && [ "$manifest_entry_count" -gt 0 ]; then
    approved_overrides=()
    echo ""
    echo "  [显式覆盖] 将覆盖 manifest 中的全部项目定制，并在同步成功后删除 manifest。"
  fi

  customized=()
  unsafe_target_types=()
  for source in "${managed_sources[@]}"; do
    [ -f "$source" ] || continue
    rel="${source#"$SCRIPT_DIR/"}"
    target="$PROJECT_DIR/$rel"
    if [ -L "$target" ]; then
      customized+=("$rel (symlink/type-change)")
    elif [ -e "$target" ] && [ ! -f "$target" ]; then
      unsafe_target_types+=("$rel (non-regular target)")
    elif [ -f "$target" ] && ! diff -q "$source" "$target" &>/dev/null; then
      if is_approved_override "$rel"; then
        continue
      elif ! known_kit_blob "$source" "$target"; then
        customized+=("$rel")
      fi
    fi
  done
  if [ ${#unsafe_target_types[@]} -gt 0 ]; then
    echo ""
    echo "  [阻断] 检测到 ${#unsafe_target_types[@]} 个目录或其他非普通文件受管目标："
    printf '    - %s\n' "${unsafe_target_types[@]}"
    echo "  为避免 mv 把临时文件放进目录后假成功，此类目标即使 --force-overwrite 也失败关闭。"
    exit 1
  fi
  if [ ${#approved_overrides[@]} -gt 0 ]; then
    echo ""
    echo "  [项目保留] ${#approved_overrides[@]} 个已绑定当前上游 blob 的 override："
    printf '    - %s\n' "${approved_overrides[@]}"
  fi
  if [ ${#customized[@]} -gt 0 ]; then
    echo ""
    echo "  [阻断] 检测到 ${#customized[@]} 个项目定制的 SHK 受管文件："
    printf '    - %s\n' "${customized[@]}"
    echo "  默认不覆盖，避免升级静默删除项目约束。请先三方合并。"
    echo "  只有确认要丢弃这些定制时，才使用 --force-overwrite 或 SHK_FORCE_OVERWRITE=1。"
    if ! $DRY_RUN && [ "$FORCE_OVERWRITE" != "1" ]; then
      exit 1
    fi
    if [ "$FORCE_OVERWRITE" = "1" ]; then
      echo "  [显式覆盖] 已收到 force-overwrite，继续同步。"
    else
      echo "  [dry-run] 仅报告冲突，未写入项目。"
    fi
  fi

  report_skill_conflicts || exit 1

  # Codex hooks 必须先在目标同目录预生成并完成 JSON 结构校验。临时文件与最终
  # hooks.json 位于同一文件系统，写阶段才能用 rename 原子替换；任何生成/校验
  # 失败都发生在 skills、项目受管文件和 HOME marker 的首个写入之前。
  if [ -f "$PROJECT_DIR/.codex/hooks.json" ] && [ -f "$PROJECT_DIR/.claude/settings.json" ]; then
    echo ""
    echo "预生成 Codex hooks.json..."
    CODEX_HOOKS_TARGET="$PROJECT_DIR/.codex/hooks.json"
    if [ ! -f "$CODEX_HOOKS_GEN" ]; then
      echo "  [错误] Codex hooks generator 不存在: $CODEX_HOOKS_GEN" >&2
      exit 1
    fi
    if ! CODEX_HOOKS_TMP="$(mktemp "$PROJECT_DIR/.codex/.hooks.json.shk.XXXXXX")"; then
      echo "  [错误] 无法创建 Codex hooks 临时文件: $PROJECT_DIR/.codex/" >&2
      exit 1
    fi
    # 保留现有 hooks.json 的权限位；generator 只改临时文件内容。
    if ! cp -p "$CODEX_HOOKS_TARGET" "$CODEX_HOOKS_TMP"; then
      echo "  [错误] 无法准备 Codex hooks 临时文件: $CODEX_HOOKS_TMP" >&2
      exit 1
    fi
    gen_cmd=(node "$CODEX_HOOKS_GEN" \
      --input "$PROJECT_DIR/.claude/settings.json" \
      --output "$CODEX_HOOKS_TMP")
    if ! "${gen_cmd[@]}"; then
      echo "  [错误] Codex hooks 同步失败: $CODEX_HOOKS_TARGET" >&2
      echo "  输入文件: $PROJECT_DIR/.claude/settings.json" >&2
      echo "  目标文件保持不变: $CODEX_HOOKS_TARGET" >&2
      echo "  可手动执行:" >&2
      printf '  %q' node "$CODEX_HOOKS_GEN" \
        --input "$PROJECT_DIR/.claude/settings.json" \
        --output "$CODEX_HOOKS_TARGET" >&2
      echo "" >&2
      exit 1
    fi
    if ! node -e '
      const fs = require("fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)
          || !Object.prototype.hasOwnProperty.call(value, "hooks")
          || !value.hooks || typeof value.hooks !== "object" || Array.isArray(value.hooks)) {
        throw new Error("expected top-level object with hooks object");
      }
    ' "$CODEX_HOOKS_TMP"; then
      echo "  [错误] Codex hooks 预生成结果校验失败: $CODEX_HOOKS_TMP" >&2
      echo "  目标文件保持不变: $CODEX_HOOKS_TARGET" >&2
      exit 1
    fi
    echo "  Codex hooks 临时文件已生成并校验。"
  fi

  # 所有 manifest/受管文件冲突和 Codex 生成校验已在任何 skill、项目受管文件
  # 或 HOME marker 写入前完成。
  update_skills

  # 版本比对清单
  echo ""
  echo "  版本检测:"
  needs_update=0
  up_to_date=0
  locally_modified=0
  new_hooks=0
  newer_local=0

  for hook in "$HOOKS_SRC"/*.js; do
    if [ -f "$hook" ]; then
      name=$(basename "$hook")
      target="$PROJECT_DIR/scripts/hooks/$name"
      rel="scripts/hooks/$name"
      src_ver=$(extract_version "$hook")

      if is_approved_override "$rel"; then
        echo "  项目保留: $name (override 已绑定当前上游 blob)"
        locally_modified=$((locally_modified + 1))
      elif [ ! -e "$target" ] && [ ! -L "$target" ]; then
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
        elif [ "$(version_cmp "$tgt_ver" "$src_ver")" = "1" ]; then
          # 目标版本比 kit 新——多半是该工程带了尚未回流 kit 的本地修复。
          # 覆盖它就是静默降级，会丢掉那个修复；此前只比较版本"是否相等"，
          # 于是 0.13.2 -> 0.13.0 被当成"需要更新"直接覆盖。
          if [ "$FORCE_OVERWRITE" = "1" ]; then
            echo "  [显式覆盖] $name: 目标版本更新 ($tgt_ver > $src_ver)"
            needs_update=$((needs_update + 1))
          else
            echo "  [跳过] $name: 目标版本更新 ($tgt_ver > $src_ver)，可能含未回流的本地修复"
            newer_local=$((newer_local + 1))
          fi
        else
          echo "  需要更新: $name ($tgt_ver -> $src_ver)"
          needs_update=$((needs_update + 1))
        fi
      fi
    fi
  done

  echo ""
  echo "  统计: $needs_update 需更新, $locally_modified 本地已修改, $newer_local 目标更新(跳过), $new_hooks 新增, $up_to_date 已最新"

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
        rel="scripts/hooks/$name"
        target="$PROJECT_DIR/$rel"
        if is_approved_override "$rel"; then
          echo "  保留项目 override: $rel"
          continue
        elif [ ! -e "$target" ] && [ ! -L "$target" ]; then
          atomic_install_file "$hook" "$target"
          echo "  新增安装: $name"
          installed=$((installed + 1))
        elif [ -L "$target" ] || ! diff -q "$hook" "$target" &>/dev/null; then
          tgt_ver=$(extract_version "$target")
          src_ver=$(extract_version "$hook")
          if [ -n "$tgt_ver" ] && [ "$(version_cmp "$tgt_ver" "$src_ver")" = "1" ]; then
            echo "  [跳过] $name: 目标 $tgt_ver 比 kit $src_ver 新，不降级"
            echo "         要强制覆盖: SHK_FORCE_DOWNGRADE=1；先把本地修复回流 kit 更好"
            if [ "${SHK_FORCE_DOWNGRADE:-0}" != "1" ] && [ "$FORCE_OVERWRITE" != "1" ]; then
              continue
            fi
          elif [ -n "$tgt_ver" ] && [ "$src_ver" = "$tgt_ver" ]; then
            echo "  [警告] 覆盖本地修改: $name (可用 git diff 查看被覆盖内容)"
          fi
          atomic_install_file "$hook" "$target"
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

    # Hook 共享库依赖。stage-guard 会 require('../lib/spec-quality')，
    # 所以更新 Hook 时必须同步 scripts/lib，否则目标项目 hook 会 MODULE_NOT_FOUND。
    if [ -d "$LIB_SRC" ]; then
      mkdir -p "$PROJECT_DIR/scripts/lib"
      lib_synced=0
      lib_installed=0
      for lib in "$LIB_SRC"/*.js "$LIB_SRC"/*.py; do
        if [ -f "$lib" ]; then
          name=$(basename "$lib")
          rel="scripts/lib/$name"
          target="$PROJECT_DIR/$rel"
          if is_approved_override "$rel"; then
            echo "  保留项目 override: $rel"
            continue
          elif [ ! -e "$target" ] && [ ! -L "$target" ]; then
            atomic_install_file "$lib" "$target"
            echo "  新增共享库: scripts/lib/$name"
            lib_installed=$((lib_installed + 1))
          elif [ -L "$target" ] || ! diff -q "$lib" "$target" &>/dev/null; then
            atomic_install_file "$lib" "$target"
            echo "  更新共享库: scripts/lib/$name"
            lib_synced=$((lib_synced + 1))
          fi
        fi
      done
      if [ $lib_synced -eq 0 ] && [ $lib_installed -eq 0 ]; then
        echo "  Hook 共享库已是最新版。"
      fi
    fi

    # run-guarded 执行器（超时治理，C-AGENT-01 的工具面）。与 lib/*.py 配套，
    # 不同步过去的话目标工程只有规则没有工具。
    if [ -f "$SCRIPT_DIR/scripts/run-guarded.sh" ]; then
      if is_approved_override "scripts/run-guarded.sh"; then
        echo "  保留项目 override: scripts/run-guarded.sh"
      elif [ -L "$PROJECT_DIR/scripts/run-guarded.sh" ] \
        || { [ ! -e "$PROJECT_DIR/scripts/run-guarded.sh" ] && [ ! -L "$PROJECT_DIR/scripts/run-guarded.sh" ]; } \
        || ! diff -q "$SCRIPT_DIR/scripts/run-guarded.sh" "$PROJECT_DIR/scripts/run-guarded.sh" &>/dev/null; then
        atomic_install_file "$SCRIPT_DIR/scripts/run-guarded.sh" "$PROJECT_DIR/scripts/run-guarded.sh"
        chmod +x "$PROJECT_DIR/scripts/run-guarded.sh" 2>/dev/null || true
        echo "  同步执行器: scripts/run-guarded.sh"
      fi
    fi

    # shk CLI 本体。此前只同步 hooks 和 lib，导致升级后的工程拿不到 `shk task`
    # ——而 upgrade.sh 却在提示用户跑 `node scripts/shk.js task migrate`，那条命令必然失败。
    if [ -f "$SCRIPT_DIR/scripts/shk.js" ]; then
      mkdir -p "$PROJECT_DIR/scripts"
      if is_approved_override "scripts/shk.js"; then
        echo "  保留项目 override: scripts/shk.js"
      elif [ ! -e "$PROJECT_DIR/scripts/shk.js" ] && [ ! -L "$PROJECT_DIR/scripts/shk.js" ]; then
        atomic_install_file "$SCRIPT_DIR/scripts/shk.js" "$PROJECT_DIR/scripts/shk.js"
        echo "  新增 CLI: scripts/shk.js"
      elif [ -L "$PROJECT_DIR/scripts/shk.js" ] || ! diff -q "$SCRIPT_DIR/scripts/shk.js" "$PROJECT_DIR/scripts/shk.js" &>/dev/null; then
        atomic_install_file "$SCRIPT_DIR/scripts/shk.js" "$PROJECT_DIR/scripts/shk.js"
        echo "  更新 CLI: scripts/shk.js"
      else
        echo "  shk CLI 已是最新版。"
      fi
    fi

    # ── 2.5 原子安装已预生成的 Codex hooks.json（如果存在）──
    if [ -n "$CODEX_HOOKS_TMP" ]; then
      echo ""
      echo "同步 Codex hooks.json..."
      if ! mv -f "$CODEX_HOOKS_TMP" "$CODEX_HOOKS_TARGET"; then
        echo "  [错误] Codex hooks 原子安装失败: $CODEX_HOOKS_TARGET" >&2
        exit 1
      fi
      CODEX_HOOKS_TMP=""
      echo "  .codex/hooks.json 已从已校验临时文件原子安装。"
    fi

    if [ "$FORCE_OVERWRITE" = "1" ] && [ -f "$OVERRIDE_MANIFEST" ]; then
      rm -f "$OVERRIDE_MANIFEST"
      echo "  已删除 override manifest: .harness/shk-overrides.v1"
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

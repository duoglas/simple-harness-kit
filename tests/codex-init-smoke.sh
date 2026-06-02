#!/usr/bin/env bash
# codex-init-smoke.sh — $harness-init 全流程 E2E 冒烟
#
# 目的: 验证在真实 Codex CLI 上跑 $harness-init skill 能完整产出所有必选文件。
#       这是 codex-smoke.sh 之上的更深一层守门: codex-smoke 只验"hook 不报错",
#       本脚本验"init skill 完整跑完产物对"。补 C-GATE-04 三模式 E2E 在 skill
#       入口的自动化空缺 (VH-08 类型 bug 防御)。
#
# 默认行为:
#   - 默认 SKIP (慢, 不卡 node tests/run.js 默认调用)
#   - 设 CODEX_INIT_SMOKE=1 才执行
#   - codex 不可用 + CODEX_REQUIRED=1 → FAIL
#   - codex 不可用 + CODEX_REQUIRED!=1 → SKIP
#
# 关键设计:
#   - 预设 SIMPLE_HARNESS_KIT_ROOT 环境变量 → SKILL.md Step 0 优先级 (1) 命中, 跳过用户交互
#   - 用 codex exec --dangerously-bypass-approvals-and-sandbox 跑非交互 smoke（仅限 tmp 外部沙箱场景）
#   - prompt 显式指示 "不要询问, 接受所有默认", 双保险防 Codex 卡住
#   - 长 timeout (默认 600s, init 流程要读 methodology + 写多文件)
#
# 退出码:
#   0 — PASS / SKIP
#   1 — FAIL (产物缺失 / hook failed / JSON 错)
#   2 — 环境/准备阶段错

set -u

KIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMEOUT_SEC="${INIT_SMOKE_TIMEOUT:-600}"

# ── opt-in gate ──
if [ "${CODEX_INIT_SMOKE:-0}" != "1" ]; then
  echo "[codex-init-smoke] SKIP: opt-in 测试 (设 CODEX_INIT_SMOKE=1 启用)。" >&2
  exit 0
fi

# ── codex 可用性检查 ──
if ! command -v codex >/dev/null 2>&1; then
  if [ "${CODEX_REQUIRED:-0}" = "1" ]; then
    echo "[codex-init-smoke] FAIL: codex 未安装但 CODEX_REQUIRED=1。" >&2
    exit 1
  else
    echo "[codex-init-smoke] SKIP: codex CLI 未安装。" >&2
    exit 0
  fi
fi

CODEX_VERSION="$(codex --version 2>/dev/null || echo unknown)"
echo "[codex-init-smoke] 使用 codex: $CODEX_VERSION"
echo "[codex-init-smoke] kit: $KIT_ROOT"

# ── 准备 tmp 项目 (干净, 无 init 残留) ──
TMP_DIR="$(mktemp -d -t codex-init-smoke.XXXXXX)"
if [ "${SMOKE_DEBUG:-0}" != "1" ]; then
  trap 'rm -rf "$TMP_DIR"' EXIT
else
  echo "[codex-init-smoke] SMOKE_DEBUG=1, 保留 tmp: $TMP_DIR" >&2
fi

# 假装是真实项目: 给点最小内容让 init Step 2 自动扫描有东西扫
cat > "$TMP_DIR/README.md" <<'EOF'
# init smoke target

A minimal project used by codex-init-smoke.sh to verify $harness-init E2E.
EOF

cat > "$TMP_DIR/package.json" <<'EOF'
{"name":"init-smoke-target","version":"0.0.1","scripts":{"test":"echo no-tests"}}
EOF

# ── 跑 codex exec 触发 $harness-init ──
RUN_LOG="$TMP_DIR/codex-run.log"
echo "[codex-init-smoke] 运行 codex exec '\$harness-init' (timeout=${TIMEOUT_SEC}s)..." >&2

# Prompt 显式约束:
#   - 用 env var 指定的 kit (避免 Step 0 询问)
#   - 接受所有默认 (避免 Step 3 优选询问)
#   - 不要中途暂停问问题
PROMPT='$harness-init

约束 (帮助你在非交互模式完成):
- 使用环境变量 SIMPLE_HARNESS_KIT_ROOT 指向的 kit, 不要再问 kit 路径
- 接受所有可选组件的默认推荐, 不要为每项询问我
- 不要中途暂停等我确认; 完整跑完所有 step 然后输出完成报告'

set +e
(
  cd "$TMP_DIR" && \
  SIMPLE_HARNESS_KIT_ROOT="$KIT_ROOT" \
  timeout "$TIMEOUT_SEC" codex exec \
    --dangerously-bypass-approvals-and-sandbox \
    --enable hooks \
    --skip-git-repo-check \
    --ephemeral \
    "$PROMPT"
) >"$RUN_LOG" 2>&1
RUN_EXIT=$?
set -e

echo "[codex-init-smoke] codex exit: $RUN_EXIT"

# ── 断言 ──
FAILURES=0

assert_file_nonempty() {
  local p="$1"; local label="$2"
  if [ ! -s "$TMP_DIR/$p" ]; then
    echo "[codex-init-smoke] FAIL: $label 缺失或空 ($p)" >&2
    FAILURES=$((FAILURES+1))
    return 1
  fi
  return 0
}

assert_json_valid() {
  local p="$1"; local label="$2"
  if ! node -e "JSON.parse(require('fs').readFileSync('$TMP_DIR/$p','utf8'))" 2>/dev/null; then
    echo "[codex-init-smoke] FAIL: $label JSON 无效 ($p)" >&2
    FAILURES=$((FAILURES+1))
    return 1
  fi
  return 0
}

# A. 必选文件存在
assert_file_nonempty ".claude/settings.json" "Claude settings"
assert_file_nonempty "CLAUDE.md" "CLAUDE.md"
assert_file_nonempty "docs/constraints.md" "constraints.md"

# B. settings.json JSON 有效 + 必选事件 (来自 tests/required-wiring.json)
# 注意: Stop 是 optional (关联 delivery-gate.js, 项目可不启用), 不在必选清单
if assert_json_valid ".claude/settings.json" "settings.json"; then
  for evt in SessionStart PreToolUse PostToolUse; do
    if ! grep -q "\"$evt\"" "$TMP_DIR/.claude/settings.json"; then
      echo "[codex-init-smoke] FAIL: settings.json 缺必选顶层事件 $evt" >&2
      FAILURES=$((FAILURES+1))
    fi
  done
fi

# C. hook 脚本至少 6 个必选
hook_count=$(ls -1 "$TMP_DIR/scripts/hooks/"*.js 2>/dev/null | wc -l | tr -d ' ')
if [ "$hook_count" -lt 6 ]; then
  echo "[codex-init-smoke] FAIL: hook 脚本数 $hook_count < 6 (必选: harness-stage-guard / harness-session-start / session-logger / safety-guard / find-root / session-end)" >&2
  FAILURES=$((FAILURES+1))
fi
for required in harness-stage-guard.js harness-session-start.js session-logger.js safety-guard.js find-root.js; do
  if [ ! -f "$TMP_DIR/scripts/hooks/$required" ]; then
    echo "[codex-init-smoke] FAIL: 必选 hook 缺失: $required" >&2
    FAILURES=$((FAILURES+1))
  fi
done

# D. 复制的 hooks 必须是 v0.8.x clean 版 (无 passthrough stdout)
bad_hook_count=$(grep -l "process.stdout.write" "$TMP_DIR/scripts/hooks/"*.js 2>/dev/null | wc -l | tr -d ' ')
if [ "$bad_hook_count" -gt 0 ]; then
  echo "[codex-init-smoke] FAIL: $bad_hook_count 个 hook 还有 passthrough stdout (VH-13 残留)" >&2
  FAILURES=$((FAILURES+1))
fi

# E. .codex/hooks.json 应该被 init 自动生成 (因为 codex 已检测到)
if [ -f "$TMP_DIR/.codex/hooks.json" ]; then
  assert_json_valid ".codex/hooks.json" "Codex hooks.json"
else
  echo "[codex-init-smoke] WARN: .codex/hooks.json 未生成 (可能 init 未检测到 Codex)" >&2
  # 不算 FAIL — 但要在 stderr 留痕
fi

# F. 整个 codex run log 不应有 hook (failed) / invalid JSON
# 注意: 必须用严格的行首/上下文匹配，因为这些字符串可能作为 docs/constraints.md
# 历史记录文字内容被 codex 写入文件 → echo 到 log → 误报。我们只关心 codex 自己
# emit 的 hook 失败标记:
#   - codex exec 模式: "hook: <Event> Failed" (行首 + 行尾 Failed)
#   - codex TUI 模式: "<Event> hook (failed)" 后跟 "  error: ..." (缩进的 error 行)
LOG_HOOK_FAILED_LINES=$(grep -cE '^hook: (SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop) Failed$' "$RUN_LOG" 2>/dev/null || true)
LOG_TUI_HOOK_FAILED_LINES=$(grep -cE '^[[:space:]]*[A-Za-z]+ hook \(failed\)$' "$RUN_LOG" 2>/dev/null || true)
LOG_INVALID_ERROR_LINES=$(grep -cE '^[[:space:]]+error: hook returned invalid' "$RUN_LOG" 2>/dev/null || true)
if [ "$LOG_HOOK_FAILED_LINES" -gt 0 ]; then
  echo "[codex-init-smoke] FAIL: codex 日志含 $LOG_HOOK_FAILED_LINES 行 'hook: * Failed' (codex exec 模式 hook 失败标记)" >&2
  FAILURES=$((FAILURES+1))
fi
if [ "$LOG_TUI_HOOK_FAILED_LINES" -gt 0 ]; then
  echo "[codex-init-smoke] FAIL: codex 日志含 $LOG_TUI_HOOK_FAILED_LINES 行 '* hook (failed)' (codex TUI 模式 hook 失败标记)" >&2
  FAILURES=$((FAILURES+1))
fi
if [ "$LOG_INVALID_ERROR_LINES" -gt 0 ]; then
  echo "[codex-init-smoke] FAIL: codex 日志含 $LOG_INVALID_ERROR_LINES 行 'error: hook returned invalid'" >&2
  FAILURES=$((FAILURES+1))
fi

if [ "$RUN_EXIT" -eq 124 ]; then
  echo "[codex-init-smoke] FAIL: codex 超时 (${TIMEOUT_SEC}s)。可能 init 卡在某个交互问题。" >&2
  FAILURES=$((FAILURES+1))
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "" >&2
  echo "[codex-init-smoke] ────── 产物清单 ──────" >&2
  ( cd "$TMP_DIR" && find .claude .codex scripts/hooks docs CLAUDE.md AGENTS.md 2>/dev/null | head -40 ) >&2
  echo "[codex-init-smoke] ────── codex log tail ──────" >&2
  tail -n 60 "$RUN_LOG" >&2
  echo "[codex-init-smoke] ────── 结束 ──────" >&2
  echo "[codex-init-smoke] $FAILURES 项断言失败。" >&2
  exit 1
fi

# 即使断言全过, 如果 codex 非 0 退出也要警示 (但不 FAIL — codex 可能因 rate limit 抖动)
if [ "$RUN_EXIT" -ne 0 ]; then
  echo "[codex-init-smoke] WARN: codex 非 0 退出 (exit=$RUN_EXIT) 但产物齐全。可能是 codex 内部错误而非 init 问题。" >&2
fi

echo "[codex-init-smoke] PASS"
exit 0

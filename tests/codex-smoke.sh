#!/usr/bin/env bash
# codex-smoke.sh — 本地 Codex 兼容性冒烟测试
#
# 用途: 在真正的 Codex CLI 上跑一次最小任务，断言不触发 hook (failed) / invalid JSON output。
# 动机 (VH-15): VH-13 修了 passthrough stdout 但 v0.8.1 发出去后用户用 /harness-init 再次撞
#               "invalid pre-tool-use JSON output"。教训是 "Codex runtime 必须机器守门，不能靠
#               用户手动测出来" (C-GATE-08 提案)。本脚本在 kit 本地复现并预防回归。
#
# 已知限制 (VH-18 R3 调查结论)：
#   Codex 0.134.x exec 模式使用 TUI trust 时建立的 hook 缓存。任何未经 TUI trust
#   对话框注册（hooks.state hash 缺失）的 hook entry 在 exec 模式下不会执行——
#   即使设置 --dangerously-bypass-hook-trust 也不例外（该 flag 只跳过已注册 entry
#   的 hash 验证，不能让未注册 entry 执行）。
#   因此，smoke 无法通过 runtime 注入来"证明 project hook command 真实执行"。
#   当前 C-GATE-08 在 exec 模式下只能降级为 DEGRADED：确认 codex runtime
#   完成一次启动且没有出现 "hook (failed)" / invalid JSON 告警；project-level
#   hook 的正确性由 tests/run.js hook-scenarios 覆盖（195 PASS）。
#
# 行为:
#   - codex 可用且 exit 0 → 跑冒烟，断言无 hook (failed) 告警，DEGRADED + exit 0
#   - codex 非 0 + CODEX_REQUIRED != 1 → DEGRADED + warn (exit 0)
#   - codex 非 0 + CODEX_REQUIRED == 1 → FAIL (exit 1)
#   - codex 不可用 + CODEX_REQUIRED != 1 → SKIP + warn (exit 0)
#   - codex 不可用 + CODEX_REQUIRED == 1 → FAIL (exit 1)
#
# 使用:
#   bash tests/codex-smoke.sh                     # 本地默认 (SKIP 兜底)
#   CODEX_REQUIRED=1 bash tests/codex-smoke.sh    # CI 强制执行
#   SMOKE_DEBUG=1 bash tests/codex-smoke.sh       # 打印 tmp 目录位置 + 保留产物
#
# 退出码:
#   0 — DEGRADED / SKIP
#   1 — FAIL (断言命中)
#   2 — 环境/准备阶段错误

set -u

KIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT="Read README.md"
TIMEOUT_SEC="${SMOKE_TIMEOUT:-180}"

if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout "$TIMEOUT_SEC")
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(gtimeout "$TIMEOUT_SEC")
else
  echo "[codex-smoke] WARN: 系统无 timeout/gtimeout，本次不限时（macOS 需 brew install coreutils）" >&2
  TIMEOUT_CMD=()
fi

# ── 前置检查：codex 是否可用 ──
if ! command -v codex >/dev/null 2>&1; then
  if [ "${CODEX_REQUIRED:-0}" = "1" ]; then
    echo "[codex-smoke] FAIL: codex CLI 未安装，但 CODEX_REQUIRED=1 要求强制执行。" >&2
    exit 1
  else
    echo "[codex-smoke] SKIP: codex CLI 未安装（设置 CODEX_REQUIRED=1 可升级为 FAIL）。" >&2
    exit 0
  fi
fi

CODEX_VERSION="$(codex --version 2>/dev/null || echo 'unknown')"
echo "[codex-smoke] 使用 codex: $CODEX_VERSION"

# ── 准备 tmp 项目 ──
TMP_DIR="$(mktemp -d -t codex-smoke.XXXXXX)"
if [ "${SMOKE_DEBUG:-0}" != "1" ]; then
  trap 'rm -rf "$TMP_DIR"' EXIT
else
  echo "[codex-smoke] SMOKE_DEBUG=1，tmp 目录保留: $TMP_DIR" >&2
fi

mkdir -p \
  "$TMP_DIR/.claude" \
  "$TMP_DIR/.codex" \
  "$TMP_DIR/.harness" \
  "$TMP_DIR/scripts/hooks"

# 拷 settings.json 模板（Claude Code 格式，含全部事件）
cp "$KIT_ROOT/templates/settings-json.tmpl" "$TMP_DIR/.claude/settings.json"

# 生成 Codex hooks.json（过滤不支持事件）
node "$KIT_ROOT/scripts/generate-codex-hooks.js" \
  --input "$TMP_DIR/.claude/settings.json" \
  --output "$TMP_DIR/.codex/hooks.json" 2>/dev/null
if [ ! -s "$TMP_DIR/.codex/hooks.json" ]; then
  echo "[codex-smoke] FAIL: generate-codex-hooks.js 未产出 .codex/hooks.json" >&2
  exit 2
fi

# 拷所有 hook 脚本
cp "$KIT_ROOT/scripts/hooks/"*.js "$TMP_DIR/scripts/hooks/"

# SMOKE_INJECT_BAD_HOOK=1：覆盖 harness-session-start.js 为 stdout 写非法 JSON 的版本。
# 注：因已知限制，exec 模式不加载 project .codex/hooks.json，所以此注入仅在
# selftest 的 SKIP 检测路径生效（smoke 会报 SKIP: hooks 未执行，selftest 据此判定）。
# 自测逻辑保留在 selftest.sh 中，为未来 Codex 版本改善兼容性预留入口。
if [ "${SMOKE_INJECT_BAD_HOOK:-0}" = "1" ]; then
  cat > "$TMP_DIR/scripts/hooks/harness-session-start.js" <<'BADEOF'
#!/usr/bin/env node
// SMOKE SELFTEST: 故意坏掉的 hook，stdout 写非法 JSON
let raw=''; process.stdin.on('data',c=>raw+=c);
process.stdin.on('end',()=>{ process.stdout.write('not-json\n'); });
BADEOF
  echo "[codex-smoke] SMOKE_INJECT_BAD_HOOK=1：已注入坏 harness-session-start.js（仅在 hooks 真实执行时有效）" >&2
fi

# 建最小 README.md（给 "Read README.md" 有内容读）
cat > "$TMP_DIR/README.md" <<'EOF'
# smoke test project

codex 冒烟测试用的临时 readme。
EOF

# 建 current-stage.json (EXECUTE + now) 避免 first-call guard 阻止
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
cat > "$TMP_DIR/.harness/current-stage.json" <<EOF
{"stage":"EXECUTE","since":"$NOW","task":"codex smoke test"}
EOF

# tool-count=999 跳过 first-call guard
echo '{"count":999}' > "$TMP_DIR/.harness/tool-count.json"

# stage-history 留一行 EXECUTE 免得未来若有 REVIEW gate 拦路
echo "{\"stage\":\"EXECUTE\",\"t\":\"$NOW\"}" > "$TMP_DIR/.harness/stage-history.jsonl"

# ── 跑 codex ──
RUN_LOG="$TMP_DIR/codex-run.log"
echo "[codex-smoke] 运行 codex exec (prompt=$PROMPT, timeout=${TIMEOUT_SEC}s)..." >&2

set +e
(
  cd "$TMP_DIR" && \
  ${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} codex exec \
    --dangerously-bypass-approvals-and-sandbox \
    --enable hooks \
    --skip-git-repo-check \
    --ephemeral \
    "$PROMPT"
) >"$RUN_LOG" 2>&1
RUN_EXIT=$?
set -e

# ── 断言 ──
FAILURES=0

echo "[codex-smoke] codex exit: $RUN_EXIT"

if [ "$RUN_EXIT" -eq 124 ]; then
  echo "[codex-smoke] FAIL: codex 超时（${TIMEOUT_SEC}s）" >&2
  FAILURES=$((FAILURES+1))
fi

# 核心断言：不能出现 hook 执行失败相关告警
#
# Codex 根据模式显示不同粒度的错误:
#   - codex exec: 简化形式 "hook: PreToolUse Failed"
#   - codex (TUI): 详细形式 "hook returned invalid pre-tool-use JSON output"
CHECK_PATTERNS=(
  "hook: SessionStart Failed"
  "hook: UserPromptSubmit Failed"
  "hook: PreToolUse Failed"
  "hook: PostToolUse Failed"
  "hook: Stop Failed"
  "hook (failed)"
  "hook returned invalid"
  "invalid pre-tool-use JSON output"
  "invalid post-tool-use JSON output"
  "invalid session start JSON output"
  "invalid session-start JSON output"
  "invalid stop JSON output"
  "invalid user-prompt-submit JSON output"
)
for pattern in "${CHECK_PATTERNS[@]}"; do
  if grep -Fq "$pattern" "$RUN_LOG"; then
    echo "[codex-smoke] FAIL: 日志中发现 '$pattern'" >&2
    FAILURES=$((FAILURES+1))
  fi
done

if [ "$FAILURES" -gt 0 ]; then
  echo "[codex-smoke] ────── codex 运行日志（截取 tail）──────" >&2
  tail -n 80 "$RUN_LOG" >&2
  echo "[codex-smoke] ────── 日志结束 ──────" >&2
  echo "[codex-smoke] $FAILURES 项断言失败。" >&2
  exit 1
fi

# exec 根本没跑起来时，不能把 smoke 宣称为 PASS。
# 非强制本地模式可以 DEGRADED 退出，强制模式必须 FAIL。
if [ "$RUN_EXIT" -ne 0 ]; then
  if [ "${CODEX_REQUIRED:-0}" = "1" ]; then
    echo "[codex-smoke] FAIL: codex 非 0 退出（exit=${RUN_EXIT}），CODEX_REQUIRED=1 要求一次有效 runtime smoke。" >&2
    tail -n 80 "$RUN_LOG" >&2
    exit 1
  fi
  echo "[codex-smoke] DEGRADED: codex 非 0 退出（exit=${RUN_EXIT}），未完成有效 runtime smoke；非强制模式不阻塞。" >&2
  tail -n 30 "$RUN_LOG" >&2
  exit 0
fi

# 观察性注释：project hooks 未执行属已知限制，不作为 FAIL 条件
# （exec 模式需要 TUI trust 对话注册 hooks.state hash，runtime 注入无法绕过）
if grep -q "hook: SessionStart Completed" "$RUN_LOG"; then
  echo "[codex-smoke] INFO: Codex lifecycle hook marker 存在，且未发现 hook failure marker。" >&2
fi

# SMOKE_INJECT_BAD_HOOK=1 且 smoke 仍 PASS → exec 模式未加载 project hooks（已知限制）。
# selftest.sh 检测此消息并输出 SKIP（而非 FAIL），表示 bad-hook 捕获机制无法在当前 Codex
# 版本验证，但 smoke 本身的无错断言路径正常。
if [ "${SMOKE_INJECT_BAD_HOOK:-0}" = "1" ]; then
  echo "[codex-smoke] DEGRADED: sentinel hook 未执行（坏 hook 未被 smoke 捕获；exec 模式已知限制）" >&2
  exit 0
fi

echo "[codex-smoke] DEGRADED: project .codex/hooks.json command 未被 exec 模式验证；仅确认本次 codex run 无 hook failure marker。"
exit 0

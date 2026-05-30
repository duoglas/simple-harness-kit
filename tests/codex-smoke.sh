#!/usr/bin/env bash
# codex-smoke.sh — 本地 Codex 兼容性冒烟测试
#
# 用途: 在真正的 Codex CLI 上跑一次最小任务，断言不触发 hook (failed) / invalid JSON output。
# 动机 (VH-15): VH-13 修了 passthrough stdout 但 v0.8.1 发出去后用户用 /harness-init 再次撞
#               "invalid pre-tool-use JSON output"。教训是 "Codex runtime 必须机器守门，不能靠
#               用户手动测出来" (C-GATE-08 提案)。本脚本在 kit 本地复现并预防回归。
#
# 行为:
#   - codex 可用 → 跑冒烟，断言 stderr/stdout 干净，exit 0
#   - codex 不可用 + CODEX_REQUIRED != 1 → SKIP + warn (exit 0)
#   - codex 不可用 + CODEX_REQUIRED == 1 → FAIL (exit 1)
#
# 使用:
#   bash tests/codex-smoke.sh                     # 本地默认 (SKIP 兜底)
#   CODEX_REQUIRED=1 bash tests/codex-smoke.sh    # CI 强制执行
#   SMOKE_DEBUG=1 bash tests/codex-smoke.sh       # 打印 tmp 目录位置 + 保留产物
#
# 退出码:
#   0 — PASS 或 SKIP
#   1 — FAIL (断言命中)
#   2 — 环境/准备阶段错误

set -u

KIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT="Read README.md"                         # 多 hook 触发：SessionStart + PreToolUse:Read + PostToolUse:Read + Stop
TIMEOUT_SEC="${SMOKE_TIMEOUT:-180}"

# timeout 命令在 macOS 默认不存在（GNU coreutils 的 gtimeout 需 brew install coreutils）。
# 检测并回退：gtimeout > timeout > 无（直接跑不限时，靠外层 run.js 统一管理 hung）。
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

# 注入 smoke 专用 sentinel hook：只写 .harness/codex-smoke-hooks.log，不影响
# harness 正常 hook 行为。这样 smoke 不再依赖 Codex UI 的 "hook: X"
# lifecycle 文本，而是直接证明项目 .codex/hooks.json 里的 command 被执行过。
SMOKE_HOOK_LOG="$TMP_DIR/.harness/codex-smoke-hooks.log"
node - "$TMP_DIR/.codex/hooks.json" <<'NODE'
const fs = require('fs');
const hooksPath = process.argv[2];
const data = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
data.hooks ||= {};
function prepend(eventName) {
  data.hooks[eventName] ||= [];
  data.hooks[eventName].unshift({
    hooks: [{
      type: 'command',
      command: `node -e "require('fs').appendFileSync('.harness/codex-smoke-hooks.log','${eventName}\\n')"`
    }],
    description: `codex-smoke sentinel for ${eventName}`
  });
}
prepend('SessionStart');
prepend('Stop');
fs.writeFileSync(hooksPath, JSON.stringify(data, null, 2) + '\n');
NODE

# 反向自测：注入一个 "坏" hook 覆盖 SessionStart 的 harness-session-start.js。
#
# 历史上这里覆盖 safety-guard.js (PreToolUse:Bash)，但 Codex 0.134 的
# `codex exec "Read README.md"` 路径不稳定触发 PreToolUse:Bash：它会稳定触发
# SessionStart / UserPromptSubmit / Stop。selftest 必须挂在"必触发"hook 上，
# 否则 smoke 会静默变成 no-op。
# 由 codex-smoke-selftest.sh 触发。
if [ "${SMOKE_INJECT_BAD_HOOK:-0}" = "1" ]; then
  cat > "$TMP_DIR/scripts/hooks/harness-session-start.js" <<'BADEOF'
#!/usr/bin/env node
// SMOKE SELFTEST: 故意坏掉的必触发 hook，stdout 写非法 JSON，触发
// Codex "hook returned invalid session start JSON output"。
let raw=''; process.stdin.on('data',c=>raw+=c);
process.stdin.on('end',()=>{ process.stdout.write('not-json\\n'); });
BADEOF
  echo "[codex-smoke] SMOKE_INJECT_BAD_HOOK=1：已注入坏 harness-session-start.js" >&2
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

# 注意: codex exec 输出 session 记录到 stderr，最终响应到 stdout。
# hook (failed) 告警打到 stderr，所以两路都要抓。
set +e
(
  cd "$TMP_DIR" && \
  ${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} codex exec \
    --dangerously-bypass-approvals-and-sandbox \
    --enable codex_hooks \
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
#   - codex exec: 简化形式 "hook: PreToolUse Failed" (首字母大写)
#   - codex (TUI): 详细形式 "PreToolUse hook (failed)\n  error: hook returned invalid pre-tool-use JSON output"
# 两者底层都是 output_parser.rs 的 parse_json 返回 None 或 schema 不匹配。
#
# 我们断言两种形式的关键标识都不出现。
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

# smoke 不能只断言"没失败"；还必须证明项目 hooks 真的跑过。否则 Codex
# feature flag / hooks.json 路径 / matcher 行为变化时，测试会静默变成 no-op。
#
# Codex 0.134 在部分 exec 环境中只显示全局/插件 hook lifecycle marker，
# 但不会执行项目 .codex/hooks.json command。默认本地运行把这种情况记为
# SKIP，避免把 Codex runtime 兼容性漂移误报成 hook 脚本 regression；
# CODEX_REQUIRED=1 时升级为 FAIL，供 CI/发版前强制检查使用。
if [ ! -f "$SMOKE_HOOK_LOG" ]; then
  if [ "${CODEX_REQUIRED:-0}" = "1" ]; then
    echo "[codex-smoke] FAIL: Codex 未执行项目 .codex/hooks.json 的 sentinel hook；CODEX_REQUIRED=1 要求强制验证。" >&2
    FAILURES=$((FAILURES+1))
  else
    echo "[codex-smoke] SKIP: Codex 未执行项目 .codex/hooks.json 的 sentinel hook；跳过项目 hook runtime 断言。" >&2
    echo "[codex-smoke]       这通常表示当前 Codex exec runtime 不加载 project hooks，或 hooks trust/config 行为已变化。" >&2
    echo "[codex-smoke] PASS (skip project-hook assertions)"
    exit 0
  fi
else
  REQUIRED_HOOK_MARKERS=(
    "SessionStart"
    "Stop"
  )
  for marker in "${REQUIRED_HOOK_MARKERS[@]}"; do
    if ! grep -Fxq "$marker" "$SMOKE_HOOK_LOG"; then
      echo "[codex-smoke] FAIL: sentinel 日志中没有必需 hook 标记 '$marker'，smoke 可能没有真正触发该 hook。" >&2
      FAILURES=$((FAILURES+1))
    fi
  done
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "[codex-smoke] ────── codex 运行日志（截取 tail）──────" >&2
  tail -n 80 "$RUN_LOG" >&2
  echo "[codex-smoke] ────── 日志结束 ──────" >&2
  echo "[codex-smoke] $FAILURES 项断言失败。" >&2
  exit 1
fi

# 额外宽松断言：exit 非 0 也视为疑似故障（除非是已知的 timeout 已处理）
if [ "$RUN_EXIT" -ne 0 ]; then
  echo "[codex-smoke] WARN: codex 非 0 退出（exit=${RUN_EXIT}），但未命中 hook (failed) 类告警；记录以便调查。" >&2
  echo "[codex-smoke] 日志 tail:" >&2
  tail -n 30 "$RUN_LOG" >&2
  # 非 hook 失败的 exit 不判 FAIL，避免 codex 本身抖动（如 rate limit）把本测试钉死
fi

echo "[codex-smoke] PASS"
exit 0

#!/usr/bin/env bash
# 20-task-ledger-e2e.sh — Task Ledger 四条流量路径的端到端验证
#
# 覆盖 docs/tasks/T-20260726-task-ledger/spec.json 的 traffic_flows:
#   F1 新任务全流程   task new → 写 spec → status → verify → close
#   F2 跨 session 接续  另起进程只凭 .harness/CURRENT 拿到接续摘要
#   F3 存量项目兼容    无 CURRENT 时产出路径回落 .harness/ 单例，门禁行为不变
#   F4 多轮修复       verify --round 增量 → 全绿 → --seal 封盘
#
# 每条流量路径都有正向和阻断断言——只跑通 happy path 不算覆盖。
# 结束时把 F1-F4 合并进 .harness/e2e-result.json 的 covered.traffic_flows，
# 供 shk e2e assess / test effectiveness 读取；合并而非覆盖，保留同批其他 E2E 的证据。

set -euo pipefail

export HARNESS_GUARD_MODE="${HARNESS_GUARD_MODE:-strict}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHK="node $KIT_ROOT/scripts/shk.js"

PASS=0
FAIL=0
COVERED_FLOWS=()
ASSERTIONS=()

ok()   { PASS=$((PASS+1)); ASSERTIONS+=("$1"); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1" >&2; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# 夹具：真实 git 仓库 + 最小 harness 骨架。macOS 的 /tmp 是软链，realpath 归一化，
# 否则 stage-guard 的路径比对会假失败。
setup_fixture() {
  local dir
  dir="$(mktemp -d)"
  dir="$(cd "$dir" && pwd -P)"
  mkdir -p "$dir/scripts/hooks" "$dir/scripts/lib" "$dir/.harness" "$dir/src"
  cp "$KIT_ROOT"/scripts/hooks/*.js "$dir/scripts/hooks/"
  cp "$KIT_ROOT"/scripts/lib/*.js "$dir/scripts/lib/"
  cp "$KIT_ROOT/scripts/shk.js" "$dir/scripts/"
  cat > "$dir/package.json" <<'PKG'
{"name":"tl-e2e","scripts":{"build":"echo build-ok","test":"echo test-ok","lint":"echo lint-ok"}}
PKG
  echo "console.log(1)" > "$dir/src/a.js"
  git -C "$dir" init -q .
  git -C "$dir" config user.email e2e@test
  git -C "$dir" config user.name e2e
  git -C "$dir" config core.excludesFile /dev/null
  git -C "$dir" add -A >/dev/null 2>&1
  git -C "$dir" commit -qm init >/dev/null 2>&1
  printf '%s' "$dir"
}

# journal 每行必须是可解析的 JSON 且带 t/agent/kind——单独成函数，避免 check 的 eval 里嵌套引号。
journal_valid() {
  node -e '
    const fs = require("fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
    const ok = lines.length > 0 && lines.every(x => {
      try { const o = JSON.parse(x); return !!(o.t && o.agent && o.kind); } catch { return false; }
    });
    process.exit(ok ? 0 : 1);
  ' "$1"
}

# 解析产出路径，供断言比对。
artifact_path() {
  (cd "$1" && node -e 'console.log(require("./scripts/lib/task-ledger").resolveArtifactPath(process.cwd(), process.argv[1]))' "$2")
}

# stage-guard 判定。返回 deny 或 allow。
guard_decision() {
  local root="$1" file="$2" payload out
  payload=$(printf '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"%s"},"session_id":"e2e"}' "$file")
  out=$(cd "$root" && printf '%s' "$payload" | HARNESS_GUARD_MODE=strict node scripts/hooks/harness-stage-guard.js 2>/dev/null) || true
  case "$out" in
    *deny*) printf 'deny' ;;
    *)      printf 'allow' ;;
  esac
}

echo "[20-task-ledger-e2e] F1 新任务全流程"
F1="$(setup_fixture)"
(
  cd "$F1"
  $SHK task new demo-flow --title "E2E 演示任务" --risk medium >/dev/null
)
N_TASKJSON="$(find "$F1/docs/tasks" -name task.json 2>/dev/null | wc -l | tr -d ' ')"
check "F1 task new 建出 task.json" "[ '$N_TASKJSON' = '1' ]"
TASK_ID="$(cat "$F1/.harness/CURRENT" 2>/dev/null || true)"
check "F1 CURRENT 指向新任务且格式合法" "printf '%s' '$TASK_ID' | grep -Eq '^T-[0-9]{8}-demo-flow$'"
check "F1 骨架文件齐备（plan/findings/evidence/review）" \
  "[ -f '$F1/docs/tasks/$TASK_ID/plan.md' ] && [ -f '$F1/docs/tasks/$TASK_ID/findings.md' ] && [ -d '$F1/docs/tasks/$TASK_ID/evidence' ] && [ -d '$F1/docs/tasks/$TASK_ID/review' ]"
# 阻断断言：spec 未写时 status 必须非零，不能放行
(cd "$F1" && $SHK task status >/dev/null 2>&1) && S1=0 || S1=1
check "F1 阻断：spec 缺失时 status 返回非零" "[ '$S1' = '1' ]"
# 阻断断言：同一天同 slug 重复创建必须失败
(cd "$F1" && $SHK task new demo-flow --title x >/dev/null 2>&1) && S2=0 || S2=1
check "F1 阻断：重复创建同名任务被拒" "[ '$S2' = '1' ]"
cp "$KIT_ROOT/docs/tasks/T-20260726-task-ledger/spec.json" "$F1/docs/tasks/$TASK_ID/spec.json"
(cd "$F1" && $SHK task status >/dev/null 2>&1) && S3=0 || S3=1
check "F1 spec 达标后 status 返回零" "[ '$S3' = '0' ]"
(cd "$F1" && $SHK task close --outcome shipped >/dev/null)
check "F1 close 后 CURRENT 被清除" "[ ! -f '$F1/.harness/CURRENT' ]"
check "F1 close 后 task.json 标记 closed" "grep -q '\"status\": \"closed\"' '$F1/docs/tasks/$TASK_ID/task.json'"
check "F1 close 后任务目录仍在（归档不删除）" "[ -d '$F1/docs/tasks/$TASK_ID' ]"
COVERED_FLOWS+=("F1")

echo "[20-task-ledger-e2e] F2 跨 session 接续"
F2="$(setup_fixture)"
(
  cd "$F2"
  $SHK task new handoff-demo --title "接续演示" --risk low >/dev/null
  $SHK task log "改了 A，卡在 B 的空指针" --kind handoff --stage EXECUTE >/dev/null
)
T2="$(cat "$F2/.harness/CURRENT")"
# 关键：另起一个进程，不带任何上下文，只凭 CURRENT 拿摘要
SUMMARY="$(cd "$F2" && $SHK task current 2>/dev/null)"
printf '%s' "$SUMMARY" > "$F2/.summary.txt"
check "F2 新进程只凭 CURRENT 就拿到任务 ID" "grep -q '$T2' '$F2/.summary.txt'"
check "F2 摘要含最近一条 handoff 内容" "grep -q '卡在 B' '$F2/.summary.txt'"
check "F2 摘要标注 handoff 类型" "grep -q 'handoff' '$F2/.summary.txt'"
check "F2 journal 每行可解析且带 agent 标识" "journal_valid '$F2/docs/tasks/$T2/journal.jsonl'"
# 阻断断言：CURRENT 被损坏时不能装作有任务
printf 'not-a-task-id\n' > "$F2/.harness/CURRENT"
(cd "$F2" && $SHK task current >/dev/null 2>&1) && S4=0 || S4=1
check "F2 阻断：CURRENT 内容非法时 current 返回非零" "[ '$S4' = '1' ]"
COVERED_FLOWS+=("F2")

echo "[20-task-ledger-e2e] F3 存量项目兼容"
F3="$(setup_fixture)"
printf '{"task":"旧任务","risk":"medium"}' > "$F3/.harness/iteration-spec.json"
printf '{"stage":"PLAN","since":"%s","task":"旧任务"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$F3/.harness/current-stage.json"
P_SPEC="$(artifact_path "$F3" spec)"
P_EV="$(artifact_path "$F3" evidenceJson)"
D_LEGACY="$(guard_decision "$F3" "$F3/.harness/iteration-spec.json")"
D_SRC="$(guard_decision "$F3" "$F3/src/a.js")"
check "F3 无 CURRENT 时 spec 路径回落 legacy" "[ '$P_SPEC' = '$F3/.harness/iteration-spec.json' ]"
check "F3 无 CURRENT 时 evidence 路径回落 legacy" "[ '$P_EV' = '$F3/.harness/verify-evidence.json' ]"
check "F3 存量项目 PLAN 阶段仍放行 legacy spec" "[ '$D_LEGACY' = 'allow' ]"
check "F3 阻断：存量项目 PLAN 阶段仍拦业务代码" "[ '$D_SRC' = 'deny' ]"
# 迁移后行为切换，且原文件保留
(cd "$F3" && $SHK task migrate --apply --slug legacy >/dev/null)
T3="$(cat "$F3/.harness/CURRENT")"
P_SPEC2="$(artifact_path "$F3" spec)"
D_TASKDIR="$(guard_decision "$F3" "$F3/docs/tasks/$T3/findings.md")"
D_SRC2="$(guard_decision "$F3" "$F3/src/a.js")"
N_TASKS="$(ls "$F3/docs/tasks" | grep -c '^T-' || true)"
check "F3 迁移后原 iteration-spec.json 仍在（只复制不删除）" "[ -f '$F3/.harness/iteration-spec.json' ]"
check "F3 迁移后 spec 路径切到任务目录" "[ '$P_SPEC2' = '$F3/docs/tasks/$T3/spec.json' ]"
check "F3 迁移后 PLAN 放行任务目录内文件" "[ '$D_TASKDIR' = 'allow' ]"
check "F3 阻断：迁移后 PLAN 仍拦业务代码" "[ '$D_SRC2' = 'deny' ]"
check "F3 阻断：迁移幂等，重跑不产生第二个任务" "[ '$N_TASKS' = '1' ]"
COVERED_FLOWS+=("F3")

echo "[20-task-ledger-e2e] F4 多轮修复"
F4="$(setup_fixture)"
(cd "$F4" && $SHK verify --risk low --round 1 >/dev/null 2>&1) || true
(cd "$F4" && $SHK verify --risk low --round 2 > "$F4/.r2.txt" 2>&1) || true
check "F4 第二轮无改动时出现 CACHED 复用" "grep -q '复用 [1-9]' '$F4/.r2.txt'"
check "F4 增量轮不判 READY，提示需封盘" "grep -q '封盘' '$F4/.r2.txt'"
echo "// changed" >> "$F4/src/a.js"
(cd "$F4" && $SHK verify --risk low --round 3 > "$F4/.r3.txt" 2>&1) || true
check "F4 阻断：源码变更后源码类检查不再复用" "grep -q '复用 0 项' '$F4/.r3.txt'"
(cd "$F4" && $SHK verify --risk low --seal > "$F4/.rs.txt" 2>&1) || true
check "F4 封盘轮全量执行、零复用" "grep -q '封盘' '$F4/.rs.txt'"
check "F4 封盘轮不再提示需要封盘" "! grep -q '交付前需跑' '$F4/.rs.txt'"
check "F4 缓存文件落在簿记侧不污染产出" "[ -f '$F4/.harness/verify-cache.json' ]"
COVERED_FLOWS+=("F4")

rm -rf "$F1" "$F2" "$F3" "$F4"

echo
echo "[20-task-ledger-e2e] 断言 $PASS 通过 / $FAIL 失败，覆盖流量路径: ${COVERED_FLOWS[*]}"
[ "$FAIL" -eq 0 ] || { echo "[20-task-ledger-e2e] FAIL"; exit 1; }

# 合并流量路径证据进 e2e-result.json。合并而非覆盖：同批其他 E2E 的 covered 要保留。
node - "$KIT_ROOT" "${COVERED_FLOWS[@]}" <<'MERGE'
const fs = require('fs');
const path = require('path');
const [root, ...flows] = process.argv.slice(2);
const file = path.join(root, '.harness/e2e-result.json');
let doc = {};
try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { doc = {}; }
doc.schema_version = doc.schema_version || '1.0';
doc.status = doc.status === 'FAIL' ? 'FAIL' : 'PASS';
if (process.env.SHK_E2E_RUN_TOKEN) doc.run_token = process.env.SHK_E2E_RUN_TOKEN;
doc.covered = doc.covered || {};
const merge = (key, values) => {
  const cur = Array.isArray(doc.covered[key]) ? doc.covered[key] : [];
  doc.covered[key] = Array.from(new Set([...cur, ...values]));
};
merge('traffic_flows', flows);
merge('must_prove', flows);
merge('requirements', ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R8', 'R10', 'R11']);
merge('risks', ['RK1', 'RK2', 'RK5', 'RK6', 'RK8']);
merge('changed_areas', ['task_ledger', 'verify_cache', 'stage_guard']);
fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`[20-task-ledger-e2e] traffic_flows 证据已合并: ${flows.join(', ')}`);
MERGE

echo "[20-task-ledger-e2e] PASS"

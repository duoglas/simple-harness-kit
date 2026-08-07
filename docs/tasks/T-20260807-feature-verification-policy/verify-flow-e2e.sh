#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TASK_DIR="$ROOT/docs/tasks/T-20260807-feature-verification-policy"
SPEC="$TASK_DIR/spec.json"
RUN_TOKEN="${SHK_E2E_RUN_TOKEN:-manual-verification-policy-run}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/shk-verification-policy.XXXXXX")"
PROJECT="$TMP/project"
EXEC_LOG="$TMP/executions.log"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[verification-policy-e2e] FAIL: $*" >&2
  exit 1
}

assert_file() {
  [ -f "$1" ] || fail "missing file: $1"
}

mkdir -p "$PROJECT/.harness"
cat > "$PROJECT/.harness/config.json" <<'JSON'
{
  "commands": {
    "build": "printf 'build-root\\n' >> \"$SHK_TEST_LOG\" && node -e \"require('assert').strictEqual(2 + 2, 4)\"",
    "tests": "printf 'tests-standalone\\n' >> \"$SHK_TEST_LOG\" && node -e \"require('assert').strictEqual('ok', 'ok')\""
  },
  "verification_policy": {
    "suite_includes": {
      "build": ["tests"]
    }
  }
}
JSON
cat > "$PROJECT/README.md" <<'EOF_PROJECT'
# Verification policy fixture
EOF_PROJECT

(
  cd "$PROJECT"
  git init -q
  git config user.email 'verification-policy@example.invalid'
  git config user.name 'Verification Policy Fixture'
  git add README.md .harness/config.json
  git commit -q -m 'fixture: initialize verification policy project'
)

export SHK_TEST_LOG="$EXEC_LOG"
: > "$EXEC_LOG"
(
  cd "$PROJECT"
  node "$ROOT/scripts/shk.js" verify --risk low --phase final --write-evidence > "$TMP/final.out"
)
assert_file "$PROJECT/.harness/verify-evidence.json"
assert_file "$PROJECT/.harness/verification-baseline.json"
[ "$(grep -c '^build-root$' "$EXEC_LOG" || true)" -eq 1 ] || fail 'final phase did not execute containing suite exactly once'
[ "$(grep -c '^tests-standalone$' "$EXEC_LOG" || true)" -eq 0 ] || fail 'included tests suite executed separately'
node - "$PROJECT/.harness/verification-baseline.json" <<'NODE'
const fs = require('fs');
const evidence = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (evidence.overall !== 'READY') throw new Error(`baseline overall=${evidence.overall}`);
if (evidence.provenance.mode !== 'full') throw new Error(`baseline mode=${evidence.provenance.mode}`);
if (!evidence.provenance.verification.test_manifest_digest) throw new Error('missing test_manifest_digest');
if (!evidence.checks.tests || evidence.checks.tests.status !== 'PASS' || evidence.checks.tests.inherited !== true) {
  throw new Error('included suite result lacks inherited PASS provenance');
}
NODE

: > "$EXEC_LOG"
(
  cd "$PROJECT"
  node "$ROOT/scripts/shk.js" verify --risk low --phase integration > "$TMP/integration.out"
)
grep -q 'Full admission: REUSE' "$TMP/integration.out" || fail 'exact integration did not reuse final evidence'
[ ! -s "$EXEC_LOG" ] || fail 'integration reuse executed commands'

printf '\nDocumentation-only candidate change.\n' >> "$PROJECT/README.md"
: > "$EXEC_LOG"
set +e
(
  cd "$PROJECT"
  node "$ROOT/scripts/shk.js" verify --risk low --phase focused > "$TMP/focused.out" 2> "$TMP/focused.err"
)
focused_rc=$?
set -e
[ "$focused_rc" -ne 0 ] || fail 'focused reuse incorrectly claimed final READY'
grep -q '可信 baseline 复用' "$TMP/focused.out" || fail 'focused phase did not report trusted baseline reuse'
[ ! -s "$EXEC_LOG" ] || fail 'documentation-only focused phase reran build/tests'

set +e
(
  cd "$PROJECT"
  node "$ROOT/scripts/shk.js" verify --risk low --phase integration > "$TMP/rewrite.out" 2> "$TMP/rewrite.err"
)
rewrite_rc=$?
set -e
[ "$rewrite_rc" -ne 0 ] || fail 'rewritten candidate reused stale integration evidence'
grep -q 'Full admission rejected' "$TMP/rewrite.err" || fail 'rewrite rejection lacked structured admission message'

cp "$PROJECT/.harness/config.json" "$TMP/config.good.json"
node - "$PROJECT/.harness/config.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.verification_policy.suite_includes.hidden = ['build'];
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
NODE
set +e
(
  cd "$PROJECT"
  node "$ROOT/scripts/shk.js" verify --risk low --phase focused > "$TMP/unknown.out" 2> "$TMP/unknown.err"
)
unknown_rc=$?
set -e
[ "$unknown_rc" -ne 0 ] || fail 'unknown suite parent was accepted'
grep -q 'SUITE_UNKNOWN_REFERENCE' "$TMP/unknown.err" || fail 'unknown suite rejection lacked reason code'
cp "$TMP/config.good.json" "$PROJECT/.harness/config.json"

TASK_ID='T-20260807-placeholder-fixture'
mkdir -p "$PROJECT/docs/tasks/$TASK_ID/evidence" "$PROJECT/docs/tasks/$TASK_ID/review"
printf '%s\n' "$TASK_ID" > "$PROJECT/.harness/CURRENT"
cat > "$PROJECT/docs/tasks/$TASK_ID/task.json" <<JSON
{"id":"$TASK_ID","title":"placeholder fixture","status":"open","risk":"high","stage":"REVIEW"}
JSON
cat > "$PROJECT/docs/tasks/$TASK_ID/spec.json" <<'JSON'
{"requirements":[{"text":"observable requirement"}],"design":{"summary":"complete design"}}
JSON
cat > "$PROJECT/docs/tasks/$TASK_ID/plan.md" <<'MD'
# Plan

## 目标
（补充）

## 验收标准
- observable acceptance
MD
printf '# Findings\n' > "$PROJECT/docs/tasks/$TASK_ID/findings.md"
set +e
(
  cd "$PROJECT"
  node "$ROOT/scripts/shk.js" task close --outcome shipped > "$TMP/close.out" 2> "$TMP/close.err"
)
close_rc=$?
set -e
[ "$close_rc" -ne 0 ] || fail 'placeholder requirement entered shipped state'
grep -q 'REQUIRED_CONTENT_PLACEHOLDER' "$TMP/close.err" || fail 'placeholder rejection lacked reason code'
node - "$PROJECT/docs/tasks/$TASK_ID/task.json" <<'NODE'
const fs = require('fs');
const task = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (task.status !== 'open') throw new Error(`task mutated before rejection: ${task.status}`);
NODE

if [ -n "${SHK_PUBLIC_FORBIDDEN_PATTERN:-}" ]; then
  added="$({
    git -C "$ROOT" diff --unified=0 HEAD -- .
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      sed 's/^/+/' "$ROOT/$file"
    done < <(git -C "$ROOT" ls-files --others --exclude-standard)
  } | grep -E '^\+[^+]' || true)"
  if printf '%s\n' "$added" | grep -Eiq "$SHK_PUBLIC_FORBIDDEN_PATTERN"; then
    fail 'new public lines contain a caller-forbidden term'
  fi
fi

node - "$ROOT" "$SPEC" "$RUN_TOKEN" <<'NODE'
const fs = require('fs');
const path = require('path');
const [root, specFile, runToken] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const ids = values => (Array.isArray(values) ? values : []).map(v => v && v.id).filter(Boolean);
const requirements = ids(spec.requirements);
const risks = ids(spec.design && spec.design.risk_points);
const trafficFlows = ids(spec.traffic_flows);
const changedAreas = Array.isArray(spec.design && spec.design.changed_areas) ? spec.design.changed_areas : [];
const mustProve = [...requirements, ...risks, ...trafficFlows];
const harness = path.join(root, '.harness');
fs.mkdirSync(harness, { recursive: true });
fs.writeFileSync(path.join(harness, 'task-quality-contract.json'), `${JSON.stringify({
  schema_version: '1.0',
  risk: spec.risk || 'high',
  changed_areas: changedAreas,
  must_prove: mustProve,
  source: 'task-spec',
}, null, 2)}\n`);
fs.writeFileSync(path.join(harness, 'mutation-result.json'), `${JSON.stringify({
  schema_version: '1.0',
  status: 'PASS',
  killed: 6,
  survived: 0,
  mutants: [
    { id: 'MUT-BASELINE-TRUST', status: 'KILLED', proof: 'tampered/partial baseline unit controls reject reuse' },
    { id: 'MUT-BASELINE-ANCESTRY', status: 'KILLED', proof: 'focused CLI accepts only a reachable ancestor baseline' },
    { id: 'MUT-CANDIDATE-REWRITE', status: 'KILLED', proof: 'integration CLI rejects the rewritten candidate' },
    { id: 'MUT-SUITE-DUPLICATE', status: 'KILLED', proof: 'fixture observes containing suite once and standalone suite zero times' },
    { id: 'MUT-SUITE-UNKNOWN', status: 'KILLED', proof: 'unknown suite parent fails closed with a structured code' },
    { id: 'MUT-PLACEHOLDER', status: 'KILLED', proof: 'task close rejects placeholder before task mutation' }
  ]
}, null, 2)}\n`);
fs.writeFileSync(path.join(harness, 'e2e-result.json'), `${JSON.stringify({
  schema_version: '1.0',
  status: 'PASS',
  run_token: runToken,
  covered: { changed_areas: changedAreas, must_prove: mustProve, requirements, risks, traffic_flows: trafficFlows },
  assertions: [
    'final writes an attested READY exact-candidate baseline with test-manifest identity',
    'integration reuses the exact candidate without executing commands and rejects a rewritten candidate',
    'focused reuses unaffected checks only from a compatible reachable full baseline',
    'suite inclusion executes the containing suite once and records inherited PASS provenance',
    'unknown suite references fail closed',
    'completed requirements containing placeholders are rejected before task mutation',
    'new public lines contain no caller-supplied forbidden terms'
  ],
  paths: [
    { type: 'positive', proof: 'exact final/integration/focused and declared inclusion flows pass in a real temporary Git repository' },
    { type: 'negative', proof: 'candidate rewrite, unknown suite reference, and placeholder completion are blocked' }
  ]
}, null, 2)}\n`);
NODE

echo '[verification-policy-e2e] PASS'

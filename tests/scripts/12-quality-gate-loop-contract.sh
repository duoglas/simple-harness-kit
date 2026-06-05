#!/usr/bin/env bash
# 12-quality-gate-loop-contract.sh — AI workflow quality gate / E2E / loop backend contract
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHK="$KIT_ROOT/scripts/shk.js"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/shk-quality-loop-XXXXXX")"
cleanup() {
  python3 - "$TMP" <<'PY_CLEAN'
import shutil, sys
shutil.rmtree(sys.argv[1], ignore_errors=True)
PY_CLEAN
}
trap cleanup EXIT

pass=0
fail=0
assert() {
  local name="$1"
  shift
  if "$@"; then
    pass=$((pass+1))
    echo "  PASS [$pass] $name"
  else
    fail=$((fail+1))
    echo "  FAIL [$((pass+fail))] $name"
  fi
}

mkdir -p "$TMP/.harness"
cat > "$TMP/package.json" <<'JSON'
{"scripts":{"test":"node -e \"process.exit(0)\""}}
JSON
set +e
(cd "$TMP" && node "$SHK" quality status --risk release --format json) > "$TMP/release-quality.json" 2> "$TMP/release-quality.err"
rc=$?
set -e
assert "release risk without E2E is NOT_READY" test "$rc" -ne 0
assert "release quality output says NOT_READY" grep -q '"overall": "NOT_READY"' "$TMP/release-quality.json"
assert "release quality points AI to e2e plan" grep -q 'e2e plan' "$TMP/release-quality.json"

cat > "$TMP/package.json" <<'JSON'
{"scripts":{"test":"node -e \"process.exit(0)\"","test:e2e":"node -e \"process.exit(0)\""}}
JSON
(cd "$TMP" && node "$SHK" e2e plan --format json) > "$TMP/e2e-plan.out"
assert "e2e plan writes json evidence" test -s "$TMP/.harness/e2e-plan.json"
assert "e2e plan writes markdown evidence" test -s "$TMP/.harness/e2e-plan.md"
assert "e2e plan recommends npm test:e2e" grep -q 'npm run test:e2e' "$TMP/e2e-plan.out"

set +e
(cd "$TMP" && node "$SHK" e2e assess --risk medium --format json) > "$TMP/fake-e2e-assess.json" 2> "$TMP/fake-e2e-assess.err"
rc=$?
set -e
assert "fake E2E assess is blocked" test "$rc" -ne 0
assert "fake E2E assess says NOT_SUFFICIENT" grep -q '"overall": "NOT_SUFFICIENT"' "$TMP/fake-e2e-assess.json"

mkdir -p "$TMP/tests/e2e"
cat > "$TMP/tests/e2e/quality-contract.e2e.js" <<'JS'
const assert = require('assert');
const fs = require('fs');
assert.strictEqual('READY', 'READY');
assert.notStrictEqual('NOT_READY', 'READY');
console.log('positive path READY evidence');
console.log('negative blocking path: fake E2E is NOT_SUFFICIENT');
fs.mkdirSync('.harness', { recursive: true });
fs.writeFileSync('.harness/e2e-result.json', JSON.stringify({
  schema_version: '1.0',
  status: 'PASS',
  run_token: process.env.SHK_E2E_RUN_TOKEN || '',
  covered: {
    changed_areas: ['quality_gate', 'e2e'],
    must_prove: [
      'fake E2E is not sufficient',
      'failed E2E blocks delivery'
    ]
  },
  assertions: ['READY is accepted', 'fake E2E is not sufficient'],
  paths: [
    { type: 'positive', proof: 'READY evidence is accepted' },
    { type: 'negative', proof: 'failed E2E blocks delivery' }
  ]
}, null, 2));
JS
cat > "$TMP/package.json" <<'JSON'
{"scripts":{"test":"node -e \"process.exit(0)\"","test:e2e":"node tests/e2e/quality-contract.e2e.js"}}
JSON
cat > "$TMP/.harness/task-quality-contract.json" <<'JSON'
{
  "schema_version": "1.0",
  "risk": "medium",
  "changed_areas": ["quality_gate", "e2e"],
  "must_prove": [
    "fake E2E is not sufficient",
    "failed E2E blocks delivery"
  ]
}
JSON
(cd "$TMP" && node "$SHK" e2e assess --risk medium --format json) > "$TMP/valid-e2e-assess.json"
assert "contract-backed E2E assess is READY" grep -q '"overall": "READY"' "$TMP/valid-e2e-assess.json"

(cd "$TMP" && node "$SHK" loop state --format json) > "$TMP/loop-state.json"
assert "loop state caps iterations at 3" grep -q '"max_iterations": 3' "$TMP/loop-state.json"
assert "loop state forbids push tag release" grep -q '"no_push_tag_release": true' "$TMP/loop-state.json"

if [ "$fail" -gt 0 ]; then
  echo "  [12-quality-loop] FAIL: $fail failures"
  exit 1
fi

echo "  [12-quality-loop] PASS: $pass / $pass"

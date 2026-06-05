#!/usr/bin/env bash
# 15-ai-harness-app-workflow.sh — AI 工具 Harness 真实工作方式合同
#
# 这个脚本验证的不是“用户手敲 JS CLI”，而是：
# 1. SHK 作为 AI 工具 Harness 被装进一个目标应用工程；
# 2. 目标工程里的 AI skill 明确要求：新应用没有 E2E 时 AI 要生成第一套；
# 3. 一个按该 Harness 指令执行的 agent workflow 能在目标工程内生成质量合约、E2E、evidence；
# 4. 正常代码 PASS，故意破坏业务行为后 E2E FAIL。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shk-ai-harness-workflow.XXXXXX")"
APP_DIR="$TMP_ROOT/target-app"
TEST_HOME="$TMP_ROOT/home"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$APP_DIR/src" "$APP_DIR/tests/e2e" "$APP_DIR/.harness" "$TEST_HOME"

cat > "$APP_DIR/package.json" <<'JSON'
{
  "name": "target-app-without-e2e",
  "version": "0.0.0",
  "scripts": {
    "dev": "node src/app.js",
    "test": "node -e \"process.exit(0)\""
  },
  "dependencies": {
    "vite": "^latest",
    "react": "^latest",
    "react-dom": "^latest"
  }
}
JSON

cat > "$APP_DIR/vite.config.js" <<'JS'
export default {};
JS

cat > "$APP_DIR/src/App.jsx" <<'JS'
export default function App() {
  return <main><h1>Cart App</h1></main>;
}
JS

cat > "$APP_DIR/src/app.js" <<'JS'
'use strict';

function checkout(input) {
  if (!input || !input.email || !input.email.includes('@')) {
    throw new Error('Valid email is required');
  }
  return { status: 'Checkout complete' };
}

module.exports = { checkout };
JS

echo "[15-ai-harness] install SHK skills into target app"
(cd "$APP_DIR" && HOME="$TEST_HOME" bash "$KIT_ROOT/install.sh" --target codex --scope project >/tmp/shk-ai-harness-install.log 2>&1)

SKILL_FILE="$APP_DIR/.codex/skills/auto-harness-test-bootstrap/SKILL.md"
test -f "$SKILL_FILE"
grep -q "新应用没有 E2E 时，AI 要生成第一套" "$SKILL_FILE"
grep -q "e2e inspect" "$SKILL_FILE"
grep -q "e2e bootstrap" "$SKILL_FILE"

echo "[15-ai-harness] AI reads Harness backend signals"
INSPECT_JSON="$(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" e2e inspect --format json)"
BOOTSTRAP_JSON="$(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" e2e bootstrap --risk medium --format json)"
echo "$INSPECT_JSON" | grep -q '"e2e_status": "missing"'
echo "$BOOTSTRAP_JSON" | grep -q '"status": "READY_TO_GENERATE"'

echo "[15-ai-harness] AI generates contract and E2E inside target app"
cat > "$APP_DIR/.harness/task-quality-contract.json" <<'JSON'
{
  "schema_version": "1.0",
  "risk": "medium",
  "changed_areas": ["checkout_flow"],
  "must_prove": [
    "valid checkout returns Checkout complete",
    "invalid email is blocked"
  ]
}
JSON

cat > "$APP_DIR/tests/e2e/checkout-flow.e2e.js" <<'JS'
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { checkout } = require('../../src/app');

const ok = checkout({ email: 'buyer@example.com' });
assert.strictEqual(ok.status, 'Checkout complete');
assert.throws(() => checkout({ email: 'bad-input' }), /Valid email is required/);

fs.mkdirSync(path.join(__dirname, '../../.harness'), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, '../../.harness/e2e-result.json'),
  JSON.stringify({
    schema_version: '1.0',
    status: 'PASS',
    run_token: process.env.SHK_E2E_RUN_TOKEN || '',
    covered: {
      changed_areas: ['checkout_flow'],
      must_prove: [
        'valid checkout returns Checkout complete',
        'invalid email is blocked'
      ]
    },
    assertions: [
      'valid checkout returns Checkout complete',
      'invalid email throws Valid email is required'
    ],
    paths: [
      { type: 'positive', proof: 'valid checkout returns Checkout complete' },
      { type: 'negative', proof: 'invalid email is blocked' }
    ]
  }, null, 2) + '\n'
);

console.log('positive path: valid checkout returns Checkout complete');
console.log('negative blocking path: invalid email is blocked');
console.log('writes .harness/e2e-result.json structured evidence');
JS

node - "$APP_DIR/package.json" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.scripts['test:e2e'] = 'node tests/e2e/checkout-flow.e2e.js';
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
NODE

echo "[15-ai-harness] normal app must pass and assess READY"
(cd "$APP_DIR" && npm run test:e2e >/tmp/shk-ai-harness-e2e-pass.log 2>&1)
(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" e2e assess --risk medium --format json | grep -q '"overall": "READY"')

echo "[15-ai-harness] mutate target app; E2E must fail"
perl -0pi -e "s/Checkout complete/Checkout queued/g" "$APP_DIR/src/app.js"
set +e
(cd "$APP_DIR" && npm run test:e2e >/tmp/shk-ai-harness-e2e-mutated.log 2>&1)
MUTATED_RC=$?
set -e

if [ "$MUTATED_RC" -eq 0 ]; then
  echo "[15-ai-harness] FAIL: target app mutation still passed E2E"
  cat /tmp/shk-ai-harness-e2e-mutated.log
  exit 1
fi

echo "[15-ai-harness] PASS: AI Harness workflow generated target-app E2E that catches mutation"

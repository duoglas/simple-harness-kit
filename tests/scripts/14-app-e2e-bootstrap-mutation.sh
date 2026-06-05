#!/usr/bin/env bash
# 14-app-e2e-bootstrap-mutation.sh — 新应用工程 E2E bootstrap 有效性证明
#
# 这个脚本不证明 SHK 自己的 wrapper，而是证明“一个新应用工程的 E2E
# 能抓住真实业务坏掉的情况”：
# 1. 正常 fixture app 下 E2E PASS；
# 2. 故意破坏关键业务输出；
# 3. 重跑 E2E 必须 FAIL；
# 4. 如果坏代码下仍 PASS，说明 E2E 是摆设，本脚本失败。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shk-app-e2e-bootstrap.XXXXXX")"
APP_DIR="$TMP_ROOT/app"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$APP_DIR/.harness" "$APP_DIR/tests/e2e"

cat > "$APP_DIR/package.json" <<'JSON'
{
  "scripts": {
    "test": "node -e \"process.exit(0)\"",
    "test:e2e": "node tests/e2e/order-flow.e2e.js",
    "dev": "node app.js"
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

mkdir -p "$APP_DIR/src"
cat > "$APP_DIR/src/App.jsx" <<'JS'
export default function App() {
  return <main><h1>Order App</h1></main>;
}
JS

cat > "$APP_DIR/app.js" <<'JS'
'use strict';

function submitOrder(input) {
  if (!input || !input.email || !input.email.includes('@')) {
    throw new Error('Email is required');
  }
  return { status: 'Order saved' };
}

module.exports = { submitOrder };
JS

cat > "$APP_DIR/tests/e2e/order-flow.e2e.js" <<'JS'
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { submitOrder } = require('../../app');

const ok = submitOrder({ email: 'buyer@example.com' });
assert.strictEqual(ok.status, 'Order saved');
assert.throws(() => submitOrder({ email: 'bad-input' }), /Email is required/);

fs.mkdirSync(path.join(__dirname, '../../.harness'), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, '../../.harness/e2e-result.json'),
  JSON.stringify({
    schema_version: '1.0',
    status: 'PASS',
    run_token: process.env.SHK_E2E_RUN_TOKEN || '',
    covered: {
      changed_areas: ['order_flow'],
      must_prove: [
        'valid order returns Order saved',
        'bad email is blocked'
      ]
    },
    assertions: [
      'valid order returns Order saved',
      'bad email throws Email is required'
    ],
    paths: [
      { type: 'positive', proof: 'valid order returns Order saved' },
      { type: 'negative', proof: 'bad email is blocked' }
    ]
  }, null, 2) + '\n'
);

console.log('positive path: valid order returns Order saved');
console.log('negative blocking path: bad email is blocked');
console.log('writes .harness/e2e-result.json structured evidence');
JS

cat > "$APP_DIR/.harness/task-quality-contract.json" <<'JSON'
{
  "schema_version": "1.0",
  "risk": "medium",
  "changed_areas": ["order_flow"],
  "must_prove": [
    "valid order returns Order saved",
    "bad email is blocked"
  ]
}
JSON

echo "[14-app-e2e-bootstrap] inspect"
INSPECT_JSON="$(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" e2e inspect --format json)"
echo "$INSPECT_JSON" | grep -q '"project_type"'

echo "[14-app-e2e-bootstrap] bootstrap"
BOOTSTRAP_JSON="$(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" e2e bootstrap --risk medium --format json)"
echo "$BOOTSTRAP_JSON" | grep -q '"flows"'

echo "[14-app-e2e-bootstrap] normal app must pass"
(cd "$APP_DIR" && npm run test:e2e >/tmp/shk-app-e2e-pass.log 2>&1)
(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" e2e assess --risk medium --format json | grep -q '"overall": "READY"')

echo "[14-app-e2e-bootstrap] mutate app: critical success output changes"
perl -0pi -e "s/Order saved/Order queued/g" "$APP_DIR/app.js"

set +e
(cd "$APP_DIR" && npm run test:e2e >/tmp/shk-app-e2e-mutated.log 2>&1)
MUTATED_RC=$?
set -e

if [ "$MUTATED_RC" -eq 0 ]; then
  echo "[14-app-e2e-bootstrap] FAIL: mutated app still passed E2E"
  cat /tmp/shk-app-e2e-mutated.log
  exit 1
fi

echo "[14-app-e2e-bootstrap] PASS: generated-style E2E fails after mutation, so it can catch real bugs"

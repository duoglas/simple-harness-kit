#!/usr/bin/env bash
# 16-spec-driven-target-app-acceptance.sh — Phase 2 spec 驱动目标应用验收
#
# 这个脚本验证的不是“事后补文档”，而是完整交付流程依赖 spec：
# 1. 目标应用没有 iteration spec 时，medium 风险必须 NOT_READY；
# 2. AI 先写 spec，再根据 spec 生成 E2E；
# 3. E2E/test effectiveness/verify 都必须回到 spec 的需求、风险和流量路径；
# 4. 故意破坏目标应用关键行为后，E2E 必须 FAIL。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shk-spec-driven-app.XXXXXX")"
APP_DIR="$TMP_ROOT/spec-driven-target-app"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$APP_DIR/src" "$APP_DIR/tests/e2e" "$APP_DIR/.harness"

cat > "$APP_DIR/package.json" <<'JSON'
{
  "name": "spec-driven-target-app",
  "version": "0.0.0",
  "scripts": {
    "test": "node -e \"process.exit(0)\""
  },
  "dependencies": {
    "express": "^latest"
  }
}
JSON

cat > "$APP_DIR/src/orders.js" <<'JS'
'use strict';

function createOrder(input) {
  if (!input || !Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('Order must contain at least one item');
  }
  return { status: 'ORDER_CREATED', totalItems: input.items.length };
}

module.exports = { createOrder };
JS

echo "[16-spec-driven] missing spec must block medium delivery"
set +e
MISSING_SPEC_OUTPUT="$(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" spec status --risk medium --format json 2>&1)"
MISSING_SPEC_RC=$?
set -e
if [ "$MISSING_SPEC_RC" -eq 0 ]; then
  echo "[16-spec-driven] FAIL: missing spec was accepted"
  echo "$MISSING_SPEC_OUTPUT"
  exit 1
fi
echo "$MISSING_SPEC_OUTPUT" | grep -q '"overall": "NOT_READY"'

echo "[16-spec-driven] stage guard must block EXECUTE before spec"
cat > "$APP_DIR/.harness/current-stage.json" <<JSON
{"stage":"PLAN","since":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)","task":"spec-driven target app acceptance"}
JSON
STAGE_EXECUTE_INPUT="$(node - "$APP_DIR/.harness/current-stage.json" <<'NODE'
const path = require('path');
const stageFile = path.resolve(process.argv[2]);
process.stdout.write(JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: {
    file_path: stageFile,
    content: JSON.stringify({ stage: 'EXECUTE', since: 'now', task: 'implement order creation' })
  }
}));
NODE
)"
set +e
MISSING_STAGE_OUTPUT="$(cd "$APP_DIR" && printf '%s' "$STAGE_EXECUTE_INPUT" | node "$KIT_ROOT/scripts/hooks/harness-stage-guard.js" 2>&1)"
MISSING_STAGE_RC=$?
set -e
if [ "$MISSING_STAGE_RC" -eq 0 ]; then
  echo "[16-spec-driven] FAIL: stage guard allowed EXECUTE without spec"
  echo "$MISSING_STAGE_OUTPUT"
  exit 1
fi
echo "$MISSING_STAGE_OUTPUT" | grep -q "不能进入 EXECUTE"

echo "[16-spec-driven] write spec before generating tests"
cat > "$APP_DIR/.harness/iteration-spec.json" <<'JSON'
{
  "schema_version": "1.0",
  "risk": "medium",
  "requirements": [
    {
      "id": "REQ-ORDER-1",
      "text": "用户可以创建包含商品的订单。",
      "priority": "must",
      "source": "user"
    }
  ],
  "design": {
    "summary": "createOrder 校验 items 后返回 ORDER_CREATED。",
    "changed_areas": ["order_creation"],
    "risk_points": [
      { "id": "RISK-ORDER-1", "text": "空订单不能被当作创建成功。" }
    ]
  },
  "traffic_flows": [
    {
      "id": "FLOW-ORDER-1",
      "name": "create order api flow",
      "entrypoint": "POST /orders",
      "steps": ["submit order with items", "assert ORDER_CREATED", "submit empty order", "assert blocking error"],
      "covers": ["REQ-ORDER-1"],
      "risks": ["RISK-ORDER-1"]
    }
  ],
  "test_plan": [
    {
      "id": "TEST-ORDER-1",
      "type": "e2e",
      "covers": ["REQ-ORDER-1"],
      "risks": ["RISK-ORDER-1"],
      "traffic_flows": ["FLOW-ORDER-1"],
      "scenario": "create order positive and empty-order blocking flow",
      "assertions": ["ORDER_CREATED is returned", "empty order throws blocking error"],
      "negative_or_boundary": true
    }
  ],
  "acceptance": [
    {
      "id": "AC-ORDER-1",
      "text": "订单创建正向和空订单阻断都有自动化证据。",
      "covers": ["REQ-ORDER-1"],
      "tests": ["TEST-ORDER-1"],
      "must_have_evidence": true
    }
  ]
}
JSON

echo "[16-spec-driven] stage guard allows EXECUTE after spec is ready"
READY_STAGE_OUTPUT="$(cd "$APP_DIR" && printf '%s' "$STAGE_EXECUTE_INPUT" | node "$KIT_ROOT/scripts/hooks/harness-stage-guard.js" 2>&1)"
echo "$READY_STAGE_OUTPUT" | grep -q "阶段切换"

echo "[16-spec-driven] AI generates tests from spec"
cat > "$APP_DIR/.harness/task-quality-contract.json" <<'JSON'
{
  "schema_version": "1.0",
  "risk": "medium",
  "changed_areas": ["order_creation"],
  "must_prove": ["REQ-ORDER-1", "RISK-ORDER-1", "FLOW-ORDER-1"]
}
JSON

cat > "$APP_DIR/tests/e2e/order-flow.e2e.js" <<'JS'
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createOrder } = require('../../src/orders');

const result = createOrder({ items: ['sku-1'] });
assert.strictEqual(result.status, 'ORDER_CREATED');
assert.strictEqual(result.totalItems, 1);
assert.throws(() => createOrder({ items: [] }), /at least one item/);

fs.mkdirSync(path.join(__dirname, '../../.harness'), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, '../../.harness/e2e-result.json'),
  JSON.stringify({
    schema_version: '1.0',
    status: 'PASS',
    run_token: process.env.SHK_E2E_RUN_TOKEN || '',
    covered: {
      changed_areas: ['order_creation'],
      requirements: ['REQ-ORDER-1'],
      risks: ['RISK-ORDER-1'],
      traffic_flows: ['FLOW-ORDER-1'],
      must_prove: ['REQ-ORDER-1', 'RISK-ORDER-1', 'FLOW-ORDER-1']
    },
    assertions: [
      'ORDER_CREATED is returned',
      'empty order throws blocking error'
    ],
    paths: [
      { type: 'positive', proof: 'POST /orders with items returns ORDER_CREATED' },
      { type: 'negative', proof: 'empty order is blocked' }
    ]
  }, null, 2) + '\n'
);

console.log('positive path: REQ-ORDER-1 POST /orders with items returns ORDER_CREATED');
console.log('negative blocking path: RISK-ORDER-1 empty order is blocked');
console.log('traffic flow FLOW-ORDER-1 create order api flow covered');
console.log('writes .harness/e2e-result.json structured evidence');
JS

node - "$APP_DIR/package.json" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.scripts['test:e2e'] = 'node tests/e2e/order-flow.e2e.js';
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
NODE

cat > "$APP_DIR/.harness/mutation-result.json" <<'JSON'
{
  "schema_version": "1.0",
  "status": "PASS",
  "killed": 1,
  "survived": 0,
  "mutants": [
    { "id": "MUT-ORDER-1", "target": "ORDER_CREATED status", "status": "KILLED" }
  ]
}
JSON

echo "[16-spec-driven] spec, e2e, effectiveness and verify must be READY"
(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" spec status --risk medium --format json | grep -q '"overall": "READY"')
(cd "$APP_DIR" && npm run test:e2e >/tmp/shk-spec-driven-e2e-pass.log 2>&1)
(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" e2e assess --risk medium --format json | grep -q '"overall": "READY"')
(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" test effectiveness --risk medium --format json | grep -q '"overall": "READY"')
(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" verify --risk medium --write-evidence >/tmp/shk-spec-driven-verify.log 2>&1)
grep -q "overall: READY" "$APP_DIR/.harness/verify-evidence.md"
grep -q "test_effectiveness" "$APP_DIR/.harness/verify-evidence.md"

echo "[16-spec-driven] fake e2e and comment-only mutation must not be enough"
cat > "$APP_DIR/tests/e2e/fake-keywords.e2e.js" <<'JS'
'use strict';

// mutation broken must fail KILLED
console.log('PASS should expect assert e2e-result.json structured evidence');
console.log('positive negative blocking order_creation REQ-ORDER-1 RISK-ORDER-1 FLOW-ORDER-1');
JS

node - "$APP_DIR/package.json" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.scripts['test:e2e'] = 'node tests/e2e/fake-keywords.e2e.js';
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
NODE
rm -f "$APP_DIR/.harness/e2e-result.json" "$APP_DIR/.harness/mutation-result.json"

set +e
(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" e2e assess --risk medium --format json >/tmp/shk-spec-driven-fake-assess.json 2>&1)
FAKE_ASSESS_RC=$?
(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" test effectiveness --risk medium --format json >/tmp/shk-spec-driven-fake-effectiveness.json 2>&1)
FAKE_EFFECTIVENESS_RC=$?
(cd "$APP_DIR" && node "$KIT_ROOT/scripts/shk.js" verify --risk medium --write-evidence >/tmp/shk-spec-driven-fake-verify.log 2>&1)
FAKE_VERIFY_RC=$?
set -e
FAKE_ASSESS_OVERALL="$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('/tmp/shk-spec-driven-fake-assess.json','utf8')); console.log(r.overall || '')")"
FAKE_EFFECTIVENESS_OVERALL="$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('/tmp/shk-spec-driven-fake-effectiveness.json','utf8')); console.log(r.overall || '')")"
FAKE_VERIFY_OVERALL="$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('$APP_DIR/.harness/verify-evidence.json','utf8')); console.log(r.overall || '')")"

if [ "$FAKE_ASSESS_RC" -eq 0 ] || [ "$FAKE_ASSESS_OVERALL" = "READY" ]; then
  echo "[16-spec-driven] FAIL: fake E2E keyword stub was accepted by e2e assess"
  cat /tmp/shk-spec-driven-fake-assess.json
  exit 1
fi
if [ "$FAKE_EFFECTIVENESS_RC" -eq 0 ] || [ "$FAKE_EFFECTIVENESS_OVERALL" = "READY" ]; then
  echo "[16-spec-driven] FAIL: comment-only mutation evidence was accepted by test effectiveness"
  cat /tmp/shk-spec-driven-fake-effectiveness.json
  exit 1
fi
if [ "$FAKE_VERIFY_RC" -eq 0 ] || [ "$FAKE_VERIFY_OVERALL" = "READY" ]; then
  echo "[16-spec-driven] FAIL: fake E2E + comment mutation reached verify READY"
  cat /tmp/shk-spec-driven-fake-verify.log
  exit 1
fi

node - "$APP_DIR/package.json" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.scripts['test:e2e'] = 'node tests/e2e/order-flow.e2e.js';
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
NODE
cat > "$APP_DIR/.harness/mutation-result.json" <<'JSON'
{
  "schema_version": "1.0",
  "status": "PASS",
  "killed": 1,
  "survived": 0,
  "mutants": [
    { "id": "MUT-ORDER-1", "target": "ORDER_CREATED status", "status": "KILLED" }
  ]
}
JSON

echo "[16-spec-driven] mutate target behavior; generated E2E must fail"
perl -0pi -e "s/ORDER_CREATED/ORDER_QUEUED/g" "$APP_DIR/src/orders.js"
set +e
(cd "$APP_DIR" && npm run test:e2e >/tmp/shk-spec-driven-e2e-mutated.log 2>&1)
MUTATED_RC=$?
set -e
if [ "$MUTATED_RC" -eq 0 ]; then
  echo "[16-spec-driven] FAIL: mutation still passed E2E"
  cat /tmp/shk-spec-driven-e2e-mutated.log
  exit 1
fi

echo "[16-spec-driven] PASS: target app delivery is spec-driven, and tests catch broken behavior"

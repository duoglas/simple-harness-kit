#!/usr/bin/env bash
# 17-oss-dogfood-validation.sh — Phase 2 真实开源工程 dogfood 验证
#
# 这个脚本验证的不是 SHK 自己造出来的 fixture，而是：
# 1. 把 SHK 装进两个真实开源工程的临时副本；
# 2. AI-style 写入 spec / 质量合约 / E2E / evidence；
# 3. 正常 OSS 代码下 E2E 与 SHK 后端探针通过；
# 4. 故意改坏真实 OSS 源码后，同一条 E2E 必须失败；
# 5. fake / smoke-only / 注释关键词证据不能让 medium 风险 READY。
#
# 源码来源：
# - frontend: 1Marc/modern-todomvc-vanillajs
# - api: rwieruch/node-express-server-rest-api
#
# 默认优先读取 /private/tmp/shk-oss-dogfood-downloads 下的 tarball。
# 如果没有缓存，可显式设置 SHK_OSS_DOGFOOD_ALLOW_DOWNLOAD=1 允许下载。
# 如果有离线源码，可设置 SHK_OSS_DOGFOOD_OFFLINE_DIR，目录下包含 frontend/ 和 api/。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shk-oss-dogfood.XXXXXX")"
TEST_HOME="$TMP_ROOT/home"
DOWNLOAD_DIR="${SHK_OSS_DOGFOOD_DOWNLOAD_DIR:-/private/tmp/shk-oss-dogfood-downloads}"
ARTIFACT_DIR="${SHK_OSS_DOGFOOD_ARTIFACT_DIR:-/private/tmp/shk-oss-dogfood-artifacts}"
OFFLINE_DIR="${SHK_OSS_DOGFOOD_OFFLINE_DIR:-}"
ALLOW_DOWNLOAD="${SHK_OSS_DOGFOOD_ALLOW_DOWNLOAD:-0}"
REQUIRED="${SHK_OSS_DOGFOOD_REQUIRED:-0}"

FRONTEND_URL="https://codeload.github.com/1Marc/modern-todomvc-vanillajs/tar.gz/refs/heads/main"
API_URL="https://codeload.github.com/rwieruch/node-express-server-rest-api/tar.gz/refs/heads/master"
FRONTEND_TARBALL="$DOWNLOAD_DIR/modern-todomvc.tar.gz"
API_TARBALL="$DOWNLOAD_DIR/node-express-rest-api.tar.gz"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "[17-oss-dogfood] FAIL: $*"
  exit 1
}

skip_or_fail() {
  if [ "$REQUIRED" = "1" ]; then
    fail "$*"
  fi
  echo "[17-oss-dogfood] SKIP: $*"
  echo "[17-oss-dogfood] 说明：没有使用 fixture 冒充真实 OSS。提供 tarball 缓存或设置 SHK_OSS_DOGFOOD_ALLOW_DOWNLOAD=1 后可重跑。"
  exit 0
}

hash_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    echo "sha256-unavailable"
  fi
}

ensure_tarball() {
  local url="$1"
  local out="$2"
  local label="$3"
  if [ -s "$out" ]; then
    echo "[17-oss-dogfood] cache hit: $label → $out"
    return 0
  fi
  if [ "$ALLOW_DOWNLOAD" != "1" ]; then
    skip_or_fail "缺少 $label tarball：$out"
  fi
  mkdir -p "$DOWNLOAD_DIR"
  echo "[17-oss-dogfood] download: $label"
  curl -L -sS -o "$out" "$url"
  test -s "$out" || fail "下载后仍找不到 $label tarball: $out"
}

prepare_sources() {
  local frontend_dir="$1"
  local api_dir="$2"
  mkdir -p "$frontend_dir" "$api_dir"

  if [ -n "$OFFLINE_DIR" ]; then
    test -d "$OFFLINE_DIR/frontend" || fail "SHK_OSS_DOGFOOD_OFFLINE_DIR 缺 frontend/: $OFFLINE_DIR"
    test -d "$OFFLINE_DIR/api" || fail "SHK_OSS_DOGFOOD_OFFLINE_DIR 缺 api/: $OFFLINE_DIR"
    cp -R "$OFFLINE_DIR/frontend/." "$frontend_dir/"
    cp -R "$OFFLINE_DIR/api/." "$api_dir/"
    echo "[17-oss-dogfood] source: offline dir $OFFLINE_DIR"
    return 0
  fi

  ensure_tarball "$FRONTEND_URL" "$FRONTEND_TARBALL" "modern-todomvc-vanillajs"
  ensure_tarball "$API_URL" "$API_TARBALL" "node-express-server-rest-api"
  tar -xzf "$FRONTEND_TARBALL" -C "$frontend_dir" --strip-components=1
  tar -xzf "$API_TARBALL" -C "$api_dir" --strip-components=1
}

patch_package_script() {
  local package_json="$1"
  local e2e_command="$2"
  node - "$package_json" "$e2e_command" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const e2e = process.argv[3];
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.scripts = pkg.scripts || {};
pkg.scripts.test = pkg.scripts.test || 'node -e "process.exit(0)"';
pkg.scripts['test:e2e'] = e2e;
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
NODE
}

install_harness_project_skills() {
  local app_dir="$1"
  (cd "$app_dir" && HOME="$TEST_HOME" bash "$KIT_ROOT/install.sh" --target codex --scope project >/tmp/shk-oss-dogfood-install.log 2>&1)
  test -f "$app_dir/.codex/skills/auto-harness-test-bootstrap/SKILL.md" || fail "SHK project skill 未安装到 $app_dir"
}

write_frontend_spec_and_tests() {
  local app_dir="$1"
  mkdir -p "$app_dir/.harness" "$app_dir/tests/e2e"

  cat > "$app_dir/.harness/oss-source.json" <<JSON
{
  "schema_version": "1.0",
  "kind": "real_oss_dogfood",
  "repo": "1Marc/modern-todomvc-vanillajs",
  "source_url": "$FRONTEND_URL",
  "tarball_sha256": "$(test -s "$FRONTEND_TARBALL" && hash_file "$FRONTEND_TARBALL" || echo "offline-dir")",
  "note": "真实开源工程临时副本，不是 SHK fixture。"
}
JSON

  cat > "$app_dir/.harness/iteration-spec.json" <<'JSON'
{
  "schema_version": "1.0",
  "risk": "medium",
  "requirements": [
    {
      "id": "REQ-TODO-STORE-1",
      "text": "TodoStore 可以新增待办，并把新待办保存为未完成状态。",
      "priority": "must",
      "source": "oss-dogfood"
    }
  ],
  "design": {
    "summary": "在真实 TodoMVC store.js 上验证 add/remove/toggle/clearCompleted 的核心状态变化。",
    "changed_areas": ["todo_store"],
    "risk_points": [
      { "id": "RISK-TODO-STORE-1", "text": "新增待办如果默认变成 completed，会让 active/completed 筛选和剩余数量错误。" }
    ]
  },
  "traffic_flows": [
    {
      "id": "FLOW-TODO-STORE-1",
      "name": "todo store create and filter flow",
      "entrypoint": "TodoStore.add/remove/toggle/clearCompleted",
      "steps": [
        "add a todo",
        "assert it is active",
        "remove missing id as boundary",
        "toggle and clear completed"
      ],
      "covers": ["REQ-TODO-STORE-1"],
      "risks": ["RISK-TODO-STORE-1"]
    }
  ],
  "test_plan": [
    {
      "id": "TEST-TODO-STORE-1",
      "type": "e2e",
      "covers": ["REQ-TODO-STORE-1"],
      "risks": ["RISK-TODO-STORE-1"],
      "traffic_flows": ["FLOW-TODO-STORE-1"],
      "scenario": "TodoStore creates an active todo, keeps state on missing-id remove, then clears completed todos",
      "assertions": [
        "new todo starts as active",
        "missing-id remove keeps existing todo",
        "completed todo can be cleared"
      ],
      "negative_or_boundary": true
    }
  ],
  "acceptance": [
    {
      "id": "AC-TODO-STORE-1",
      "text": "TodoStore 正向创建和边界行为都有自动化证据，且默认 completed mutation 会被 E2E 杀死。",
      "covers": ["REQ-TODO-STORE-1"],
      "tests": ["TEST-TODO-STORE-1"],
      "must_have_evidence": true
    }
  ]
}
JSON

  cat > "$app_dir/.harness/task-quality-contract.json" <<'JSON'
{
  "schema_version": "1.0",
  "risk": "medium",
  "changed_areas": ["todo_store"],
  "must_prove": ["REQ-TODO-STORE-1", "RISK-TODO-STORE-1", "FLOW-TODO-STORE-1"]
}
JSON

  cat > "$app_dir/tests/e2e/todo-store.e2e.js" <<'JS'
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTodoStore() {
  const sourcePath = path.join(__dirname, '../../js/store.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transformed = source.replace(
    'export const TodoStore = class extends EventTarget',
    'const TodoStore = class extends EventTarget'
  ) + '\nmodule.exports = { TodoStore };\n';

  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
    clear() { storage.clear(); }
  };
  class HarnessCustomEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.detail = init.detail;
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(transformed, {
    module,
    exports: module.exports,
    window: { localStorage, addEventListener() {} },
    Event,
    EventTarget,
    CustomEvent: HarnessCustomEvent,
    console,
  }, { filename: sourcePath });
  return module.exports.TodoStore;
}

const TodoStore = loadTodoStore();
const store = new TodoStore('shk-oss-dogfood-todos');

store.add({ title: 'Prove SHK dogfood' });
assert.strictEqual(store.all().length, 1, 'positive path: add creates one todo');
assert.strictEqual(store.all()[0].title, 'Prove SHK dogfood');
assert.strictEqual(store.all()[0].completed, false, 'new todo must start active');
assert.strictEqual(store.all('active').length, 1, 'active filter includes the new todo');
assert.strictEqual(store.all('completed').length, 0, 'completed filter excludes the new todo');

store.remove({ id: 'missing-id' });
assert.strictEqual(store.all().length, 1, 'boundary path: missing-id remove keeps existing todo');

store.toggle(store.all()[0]);
assert.strictEqual(store.all('completed').length, 1, 'toggle moves todo to completed');
store.clearCompleted();
assert.strictEqual(store.all().length, 0, 'clearCompleted removes completed todo');

fs.mkdirSync(path.join(__dirname, '../../.harness'), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, '../../.harness/e2e-result.json'),
  JSON.stringify({
    schema_version: '1.0',
    status: 'PASS',
    run_token: process.env.SHK_E2E_RUN_TOKEN || '',
    covered: {
      changed_areas: ['todo_store'],
      requirements: ['REQ-TODO-STORE-1'],
      risks: ['RISK-TODO-STORE-1'],
      traffic_flows: ['FLOW-TODO-STORE-1'],
      must_prove: ['REQ-TODO-STORE-1', 'RISK-TODO-STORE-1', 'FLOW-TODO-STORE-1']
    },
    assertions: [
      'new todo starts as active',
      'missing-id remove keeps existing todo',
      'completed todo can be cleared'
    ],
    paths: [
      { type: 'positive', proof: 'TodoStore.add creates an active todo' },
      { type: 'negative boundary', proof: 'missing-id remove keeps existing todo' }
    ]
  }, null, 2) + '\n'
);

console.log('positive path: REQ-TODO-STORE-1 TodoStore.add creates an active todo');
console.log('negative boundary path: RISK-TODO-STORE-1 missing-id remove keeps existing todo');
console.log('traffic flow FLOW-TODO-STORE-1 todo store create and filter flow covered');
console.log('writes .harness/e2e-result.json structured evidence');
JS

  patch_package_script "$app_dir/package.json" "node tests/e2e/todo-store.e2e.js"
}

write_api_spec_and_tests() {
  local app_dir="$1"
  mkdir -p "$app_dir/.harness" "$app_dir/tests/e2e"

  cat > "$app_dir/.harness/oss-source.json" <<JSON
{
  "schema_version": "1.0",
  "kind": "real_oss_dogfood",
  "repo": "rwieruch/node-express-server-rest-api",
  "source_url": "$API_URL",
  "tarball_sha256": "$(test -s "$API_TARBALL" && hash_file "$API_TARBALL" || echo "offline-dir")",
  "note": "真实开源工程临时副本，不是 SHK fixture。"
}
JSON

  cat > "$app_dir/.harness/iteration-spec.json" <<'JSON'
{
  "schema_version": "1.0",
  "risk": "medium",
  "requirements": [
    {
      "id": "REQ-MESSAGE-API-1",
      "text": "Message API 可以创建 message，并能按 id 读回刚创建的 message。",
      "priority": "must",
      "source": "oss-dogfood"
    }
  ],
  "design": {
    "summary": "在真实 Express message route 上验证 POST /messages 与 GET /messages/:messageId 的核心数据流。",
    "changed_areas": ["message_api"],
    "risk_points": [
      { "id": "RISK-MESSAGE-API-1", "text": "创建 message 时如果没有保存请求 body.text，客户端读回的业务内容会错误。" }
    ]
  },
  "traffic_flows": [
    {
      "id": "FLOW-MESSAGE-API-1",
      "name": "message create and readback api flow",
      "entrypoint": "POST /messages → GET /messages/:messageId",
      "steps": [
        "post message text",
        "assert response text and user id",
        "read message by id",
        "query missing id as boundary"
      ],
      "covers": ["REQ-MESSAGE-API-1"],
      "risks": ["RISK-MESSAGE-API-1"]
    }
  ],
  "test_plan": [
    {
      "id": "TEST-MESSAGE-API-1",
      "type": "e2e",
      "covers": ["REQ-MESSAGE-API-1"],
      "risks": ["RISK-MESSAGE-API-1"],
      "traffic_flows": ["FLOW-MESSAGE-API-1"],
      "scenario": "POST /messages stores body.text and GET /messages/:id reads it back, with missing-id boundary",
      "assertions": [
        "created message keeps request text",
        "created message uses current user id",
        "missing id returns no message"
      ],
      "negative_or_boundary": true
    }
  ],
  "acceptance": [
    {
      "id": "AC-MESSAGE-API-1",
      "text": "Message API 创建、读回和 missing-id 边界都有自动化证据，且 text mutation 会被 E2E 杀死。",
      "covers": ["REQ-MESSAGE-API-1"],
      "tests": ["TEST-MESSAGE-API-1"],
      "must_have_evidence": true
    }
  ]
}
JSON

  cat > "$app_dir/.harness/task-quality-contract.json" <<'JSON'
{
  "schema_version": "1.0",
  "risk": "medium",
  "changed_areas": ["message_api"],
  "must_prove": ["REQ-MESSAGE-API-1", "RISK-MESSAGE-API-1", "FLOW-MESSAGE-API-1"]
}
JSON

  cat > "$app_dir/tests/e2e/message-route.e2e.js" <<'JS'
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeRouter {
  constructor() {
    this.routes = [];
  }
  get(routePath, handler) { this.routes.push({ method: 'get', path: routePath, handler }); }
  post(routePath, handler) { this.routes.push({ method: 'post', path: routePath, handler }); }
  put(routePath, handler) { this.routes.push({ method: 'put', path: routePath, handler }); }
  delete(routePath, handler) { this.routes.push({ method: 'delete', path: routePath, handler }); }
  find(method, routePath) {
    const route = this.routes.find((r) => r.method === method && r.path === routePath);
    assert(route, `route not registered: ${method.toUpperCase()} ${routePath}`);
    return route.handler;
  }
}

function loadMessageRouter() {
  const sourcePath = path.join(__dirname, '../../src/routes/message.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transformed = source
    .replace("import { v4 as uuidv4 } from 'uuid';", "const uuidv4 = () => 'dogfood-message-id';")
    .replace("import { Router } from 'express';", "const Router = () => new FakeRouter();")
    .replace('export default router;', 'module.exports = router;');
  const module = { exports: {} };
  vm.runInNewContext(transformed, {
    module,
    exports: module.exports,
    FakeRouter,
    assert,
    console,
  }, { filename: sourcePath });
  return module.exports;
}

function createModels() {
  return {
    users: {
      1: { id: '1', username: 'Robin Wieruch' },
      2: { id: '2', username: 'Dave Davids' },
    },
    messages: {
      1: { id: '1', text: 'Hello World', userId: '1' },
    },
  };
}

function invoke(router, method, routePath, options = {}) {
  const models = options.models || createModels();
  const handler = router.find(method, routePath);
  let sent;
  const req = {
    body: options.body || {},
    params: options.params || {},
    context: {
      models,
      me: models.users[2],
    },
  };
  const res = {
    send(value) {
      sent = value;
      return value;
    },
  };
  handler(req, res);
  return { sent, models };
}

const router = loadMessageRouter();
const models = createModels();

const created = invoke(router, 'post', '/', {
  models,
  body: { text: 'Hello OSS dogfood' },
});
assert.strictEqual(created.sent.id, 'dogfood-message-id', 'positive path: POST returns deterministic id');
assert.strictEqual(created.sent.text, 'Hello OSS dogfood', 'created message keeps request text');
assert.strictEqual(created.sent.userId, '2', 'created message uses current user id');
assert.strictEqual(models.messages['dogfood-message-id'].text, 'Hello OSS dogfood', 'message is stored in model');

const readBack = invoke(router, 'get', '/:messageId', {
  models,
  params: { messageId: 'dogfood-message-id' },
});
assert.strictEqual(readBack.sent.text, 'Hello OSS dogfood', 'GET /:messageId reads created text back');

const missing = invoke(router, 'get', '/:messageId', {
  models,
  params: { messageId: 'missing-message-id' },
});
assert.strictEqual(missing.sent, undefined, 'boundary path: missing id returns no message');
assert.strictEqual(Object.keys(models.messages).length, 2, 'missing id lookup does not mutate messages');

fs.mkdirSync(path.join(__dirname, '../../.harness'), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, '../../.harness/e2e-result.json'),
  JSON.stringify({
    schema_version: '1.0',
    status: 'PASS',
    run_token: process.env.SHK_E2E_RUN_TOKEN || '',
    covered: {
      changed_areas: ['message_api'],
      requirements: ['REQ-MESSAGE-API-1'],
      risks: ['RISK-MESSAGE-API-1'],
      traffic_flows: ['FLOW-MESSAGE-API-1'],
      must_prove: ['REQ-MESSAGE-API-1', 'RISK-MESSAGE-API-1', 'FLOW-MESSAGE-API-1']
    },
    assertions: [
      'created message keeps request text',
      'created message uses current user id',
      'missing id returns no message'
    ],
    paths: [
      { type: 'positive', proof: 'POST /messages creates a message and GET /messages/:messageId reads it back' },
      { type: 'negative boundary', proof: 'missing message id returns no message and does not mutate messages' }
    ]
  }, null, 2) + '\n'
);

console.log('positive path: REQ-MESSAGE-API-1 POST /messages creates and readbacks message text');
console.log('negative boundary path: RISK-MESSAGE-API-1 missing id returns no message');
console.log('traffic flow FLOW-MESSAGE-API-1 message create and readback api flow covered');
console.log('writes .harness/e2e-result.json structured evidence');
JS

  patch_package_script "$app_dir/package.json" "node tests/e2e/message-route.e2e.js"
}

assert_probe_ready() {
  local app_dir="$1"
  local label="$2"
  echo "[17-oss-dogfood] $label: spec status"
  (cd "$app_dir" && node "$KIT_ROOT/scripts/shk.js" spec status --risk medium --format json | grep -q '"overall": "READY"')

  echo "[17-oss-dogfood] $label: e2e assess"
  (cd "$app_dir" && node "$KIT_ROOT/scripts/shk.js" e2e assess --risk medium --format json | grep -q '"overall": "READY"')

  echo "[17-oss-dogfood] $label: test effectiveness"
  (cd "$app_dir" && node "$KIT_ROOT/scripts/shk.js" test effectiveness --risk medium --format json | grep -q '"overall": "READY"')

  echo "[17-oss-dogfood] $label: verify"
  (cd "$app_dir" && node "$KIT_ROOT/scripts/shk.js" verify --risk medium --write-evidence >/tmp/shk-oss-dogfood-"$label"-verify.log 2>&1)
  grep -q "overall: READY" "$app_dir/.harness/verify-evidence.md"
}

assert_fake_e2e_blocked() {
  local app_dir="$1"
  local label="$2"
  local package_json="$app_dir/package.json"
  local old_package="$TMP_ROOT/$label.package.before-fake.json"
  cp "$package_json" "$old_package"

  cat > "$app_dir/tests/e2e/fake-keywords.e2e.js" <<'JS'
'use strict';

// mutation broken KILLED survived 0 e2e-result.json assert expect PASS
console.log('PASS READY positive negative blocking structured evidence');
console.log('REQ-TODO-STORE-1 RISK-TODO-STORE-1 FLOW-TODO-STORE-1 REQ-MESSAGE-API-1 RISK-MESSAGE-API-1 FLOW-MESSAGE-API-1');
JS

  patch_package_script "$package_json" "node tests/e2e/fake-keywords.e2e.js"
  rm -f "$app_dir/.harness/e2e-result.json"

  set +e
  (cd "$app_dir" && node "$KIT_ROOT/scripts/shk.js" e2e assess --risk medium --format json >/tmp/shk-oss-dogfood-"$label"-fake-assess.json 2>&1)
  local fake_rc=$?
  set -e
  if [ "$fake_rc" -eq 0 ] && grep -q '"overall": "READY"' /tmp/shk-oss-dogfood-"$label"-fake-assess.json; then
    cat /tmp/shk-oss-dogfood-"$label"-fake-assess.json
    fail "$label fake E2E keyword stub reached READY"
  fi

  cp "$old_package" "$package_json"
}

prove_mutation_killed() {
  local app_dir="$1"
  local label="$2"
  local target_file="$3"
  local perl_expr="$4"
  local mutant_id="$5"
  local mutant_target="$6"
  local backup="$TMP_ROOT/$label.mutation.backup"
  cp "$target_file" "$backup"

  echo "[17-oss-dogfood] $label: normal E2E must pass"
  (cd "$app_dir" && npm run test:e2e >/tmp/shk-oss-dogfood-"$label"-e2e-pass.log 2>&1)

  echo "[17-oss-dogfood] $label: mutate real OSS source"
  perl -0pi -e "$perl_expr" "$target_file"
  set +e
  (cd "$app_dir" && npm run test:e2e >/tmp/shk-oss-dogfood-"$label"-e2e-mutated.log 2>&1)
  local mutated_rc=$?
  set -e
  cp "$backup" "$target_file"

  if [ "$mutated_rc" -eq 0 ]; then
    cat /tmp/shk-oss-dogfood-"$label"-e2e-mutated.log
    fail "$label mutation still passed E2E"
  fi

  cat > "$app_dir/.harness/mutation-result.json" <<JSON
{
  "schema_version": "1.0",
  "status": "PASS",
  "killed": 1,
  "survived": 0,
  "mutants": [
    { "id": "$mutant_id", "target": "$mutant_target", "status": "KILLED" }
  ]
}
JSON
}

write_report() {
  local frontend_dir="$1"
  local api_dir="$2"
  mkdir -p "$ARTIFACT_DIR"
  local snapshot="$ARTIFACT_DIR/phase2-oss-dogfood-snapshot"
  mkdir -p "$snapshot/frontend" "$snapshot/api"
  cp "$frontend_dir/.harness/iteration-spec.json" "$snapshot/frontend/iteration-spec.json"
  cp "$frontend_dir/.harness/task-quality-contract.json" "$snapshot/frontend/task-quality-contract.json"
  cp "$frontend_dir/.harness/e2e-result.json" "$snapshot/frontend/e2e-result.json"
  cp "$frontend_dir/.harness/mutation-result.json" "$snapshot/frontend/mutation-result.json"
  cp "$frontend_dir/.harness/verify-evidence.json" "$snapshot/frontend/verify-evidence.json"
  cp "$frontend_dir/tests/e2e/todo-store.e2e.js" "$snapshot/frontend/todo-store.e2e.js"
  cp "$api_dir/.harness/iteration-spec.json" "$snapshot/api/iteration-spec.json"
  cp "$api_dir/.harness/task-quality-contract.json" "$snapshot/api/task-quality-contract.json"
  cp "$api_dir/.harness/e2e-result.json" "$snapshot/api/e2e-result.json"
  cp "$api_dir/.harness/mutation-result.json" "$snapshot/api/mutation-result.json"
  cp "$api_dir/.harness/verify-evidence.json" "$snapshot/api/verify-evidence.json"
  cp "$api_dir/tests/e2e/message-route.e2e.js" "$snapshot/api/message-route.e2e.js"
  local json="$ARTIFACT_DIR/phase2-oss-dogfood-result.json"
  local md="$ARTIFACT_DIR/phase2-oss-dogfood-result.md"
  cat > "$json" <<JSON
{
  "schema_version": "1.0",
  "status": "PASS",
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sources": [
    {
      "kind": "frontend",
      "repo": "1Marc/modern-todomvc-vanillajs",
      "source_url": "$FRONTEND_URL",
      "temp_copy": "$frontend_dir (removed after script exit)",
      "evidence_snapshot": "$snapshot/frontend",
      "mutation": "js/store.js completed:false -> completed:true",
      "result": "normal E2E PASS; mutated source FAIL; SHK spec/e2e/effectiveness/verify READY after killed mutation evidence"
    },
    {
      "kind": "api",
      "repo": "rwieruch/node-express-server-rest-api",
      "source_url": "$API_URL",
      "temp_copy": "$api_dir (removed after script exit)",
      "evidence_snapshot": "$snapshot/api",
      "mutation": "src/routes/message.js text:req.body.text -> text:'MUTATED_TEXT'",
      "result": "normal E2E PASS; mutated source FAIL; SHK spec/e2e/effectiveness/verify READY after killed mutation evidence"
    }
  ],
  "boundary": "真实 OSS 临时副本；未跑上游完整依赖安装/浏览器/线上流量；验证的是 SHK spec-driven E2E generation/effectiveness gate 能否在真实代码路径上抓 mutation。"
}
JSON
  cat > "$md" <<EOF
# Phase 2 OSS dogfood 验证结果

可以证明的事：

- SHK 不是只在自造 fixture 上跑通；这次接入了两个真实开源工程的临时副本。
- 前端工程测的是 TodoMVC 的真实 \`js/store.js\`：新增 todo、active/completed 筛选、missing-id 边界、clear completed。
- API 工程测的是 Express demo 的真实 \`src/routes/message.js\`：创建 message、按 id 读回、missing-id 边界。
- 两个工程正常代码下 E2E 都通过，并写入本轮 run-token 结构化 evidence。
- 两个工程都做了真实源码 mutation；坏代码下同一条 E2E 都失败，所以不是只走流程。
- mutation 通过后才写 \`.harness/mutation-result.json\`，并且只用 \`killed=1, survived=0\` 作为有效证据。
- fake / smoke-only / 注释关键词脚本没有被 \`e2e assess --risk medium\` 当成 READY。
- 关键 evidence 已复制到 \`$snapshot\`，不会因为临时工程清理而丢失。

还没证明的事：

- 没有跑上游完整 npm install / 浏览器全链路 / 线上真实流量回放。
- 这轮验证的是“SHK 能在真实 OSS 代码路径上生成和判断有效 E2E”，不是替代目标工程自己的完整 CI。

机器状态：READY
EOF
  echo "[17-oss-dogfood] report: $md"
}

mkdir -p "$TEST_HOME"
FRONTEND_APP="$TMP_ROOT/frontend"
API_APP="$TMP_ROOT/api"
prepare_sources "$FRONTEND_APP" "$API_APP"

test -f "$FRONTEND_APP/js/store.js" || fail "frontend OSS source missing js/store.js"
test -f "$API_APP/src/routes/message.js" || fail "api OSS source missing src/routes/message.js"

echo "[17-oss-dogfood] install SHK project skills into real OSS temp copies"
install_harness_project_skills "$FRONTEND_APP"
install_harness_project_skills "$API_APP"

echo "[17-oss-dogfood] generate spec/contract/E2E for frontend OSS"
write_frontend_spec_and_tests "$FRONTEND_APP"
assert_fake_e2e_blocked "$FRONTEND_APP" "frontend"
prove_mutation_killed \
  "$FRONTEND_APP" \
  "frontend" \
  "$FRONTEND_APP/js/store.js" \
  "s/completed: false/completed: true/" \
  "MUT-TODO-STORE-1" \
  "new todo default completed flag"
assert_probe_ready "$FRONTEND_APP" "frontend"

echo "[17-oss-dogfood] generate spec/contract/E2E for API OSS"
write_api_spec_and_tests "$API_APP"
assert_fake_e2e_blocked "$API_APP" "api"
prove_mutation_killed \
  "$API_APP" \
  "api" \
  "$API_APP/src/routes/message.js" \
  "s/text: req\\.body\\.text/text: 'MUTATED_TEXT'/" \
  "MUT-MESSAGE-API-1" \
  "message text assignment"
assert_probe_ready "$API_APP" "api"

write_report "$FRONTEND_APP" "$API_APP"

echo "[17-oss-dogfood] PASS: real OSS dogfood caught frontend and API mutations"

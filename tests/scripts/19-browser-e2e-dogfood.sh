#!/usr/bin/env bash
# 19-browser-e2e-dogfood.sh — Phase 2 browser E2E dogfood
#
# 这个脚本补上一轮没有做的“浏览器真实链路”证据：
# 1. 使用真实 TodoMVC OSS 临时副本；
# 2. 启动真实静态页面；
# 3. 用 headless browser 输入 todo、检查 DOM/计数/筛选/清理；
# 4. mutation `completed: false -> completed: true` 后，同一条 browser E2E 必须失败；
# 5. 写 fresh `.harness/e2e-result.json` + mutation evidence，再跑 SHK assess/effectiveness/verify。
#
# 依赖策略：
# - 默认查找 SHK_BROWSER_E2E_TOOLS_DIR 下的 playwright-chromium；
# - 如果没有且 SHK_BROWSER_E2E_ALLOW_INSTALL=1，则安装到 /private/tmp，不写入仓库；
# - npm 代理可用 SHK_NPM_PROXY=http://127.0.0.1:8016 指定；
# - 如果依赖不可用，默认 SKIP；设置 SHK_BROWSER_E2E_REQUIRED=1 时 FAIL。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shk-browser-e2e.XXXXXX")"
TEST_HOME="$TMP_ROOT/home"
DOWNLOAD_DIR="${SHK_OSS_DOGFOOD_DOWNLOAD_DIR:-/private/tmp/shk-oss-dogfood-downloads}"
ARTIFACT_DIR="${SHK_BROWSER_E2E_ARTIFACT_DIR:-/private/tmp/shk-browser-e2e-artifacts}"
TOOLS_DIR="${SHK_BROWSER_E2E_TOOLS_DIR:-/private/tmp/shk-browser-e2e-tools}"
OFFLINE_DIR="${SHK_OSS_DOGFOOD_OFFLINE_DIR:-}"
ALLOW_DOWNLOAD="${SHK_OSS_DOGFOOD_ALLOW_DOWNLOAD:-0}"
ALLOW_INSTALL="${SHK_BROWSER_E2E_ALLOW_INSTALL:-0}"
REQUIRED="${SHK_BROWSER_E2E_REQUIRED:-0}"
NPM_PROXY="${SHK_NPM_PROXY:-}"

FRONTEND_URL="https://codeload.github.com/1Marc/modern-todomvc-vanillajs/tar.gz/refs/heads/main"
FRONTEND_TARBALL="$DOWNLOAD_DIR/modern-todomvc.tar.gz"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "[19-browser-e2e] FAIL: $*"
  exit 1
}

skip_or_fail() {
  if [ "$REQUIRED" = "1" ]; then
    fail "$*"
  fi
  echo "[19-browser-e2e] SKIP: $*"
  echo "[19-browser-e2e] 说明：没有用源码级/fixture 测试冒充浏览器 E2E。安装 browser 依赖后可重跑。"
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
  if [ -s "$FRONTEND_TARBALL" ]; then
    echo "[19-browser-e2e] cache hit: modern-todomvc-vanillajs → $FRONTEND_TARBALL"
    return 0
  fi
  if [ "$ALLOW_DOWNLOAD" != "1" ]; then
    skip_or_fail "缺少 modern-todomvc tarball：$FRONTEND_TARBALL"
  fi
  mkdir -p "$DOWNLOAD_DIR"
  echo "[19-browser-e2e] download: modern-todomvc-vanillajs"
  curl -L -sS -o "$FRONTEND_TARBALL" "$FRONTEND_URL"
  test -s "$FRONTEND_TARBALL" || fail "下载后仍找不到 modern-todomvc tarball"
}

prepare_source() {
  local app_dir="$1"
  mkdir -p "$app_dir"
  if [ -n "$OFFLINE_DIR" ]; then
    test -d "$OFFLINE_DIR/frontend" || fail "SHK_OSS_DOGFOOD_OFFLINE_DIR 缺 frontend/: $OFFLINE_DIR"
    cp -R "$OFFLINE_DIR/frontend/." "$app_dir/"
    echo "[19-browser-e2e] source: offline dir $OFFLINE_DIR/frontend"
    return 0
  fi
  ensure_tarball
  tar -xzf "$FRONTEND_TARBALL" -C "$app_dir" --strip-components=1
}

run_npm_install_tools() {
  mkdir -p "$TOOLS_DIR"
  if [ ! -f "$TOOLS_DIR/package.json" ]; then
    cat > "$TOOLS_DIR/package.json" <<'JSON'
{
  "private": true,
  "description": "Temporary browser E2E tools for SHK dogfood"
}
JSON
  fi
  local npm_flags=(
    --no-audit
    --fund=false
    --prefer-offline
    --fetch-timeout=60000
    --fetch-retries=1
    --fetch-retry-mintimeout=5000
    --fetch-retry-maxtimeout=60000
  )
  if [ -n "$NPM_PROXY" ]; then
    npm_flags+=(--proxy="$NPM_PROXY" --https-proxy="$NPM_PROXY")
  fi
  echo "[19-browser-e2e] install browser tool: playwright-chromium"
  set +e
  (cd "$TOOLS_DIR" && npm install playwright-chromium@1.44.1 "${npm_flags[@]}" >/tmp/shk-browser-e2e-install.log 2>&1)
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    if grep -Eiq 'ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|proxy|registry|ECONNRESET|certificate|download' /tmp/shk-browser-e2e-install.log; then
      skip_or_fail "playwright-chromium 安装失败，像是网络/proxy/browser 下载问题；log=/tmp/shk-browser-e2e-install.log"
    fi
    fail "playwright-chromium 安装失败；log=/tmp/shk-browser-e2e-install.log"
  fi
}

ensure_browser_tool() {
  if NODE_PATH="$TOOLS_DIR/node_modules" node -e "require('playwright-chromium'); console.log('ok')" >/dev/null 2>&1; then
    echo "[19-browser-e2e] browser tool cache hit: $TOOLS_DIR/node_modules/playwright-chromium"
    return 0
  fi
  if [ "$ALLOW_INSTALL" != "1" ]; then
    skip_or_fail "缺少 playwright-chromium；设置 SHK_BROWSER_E2E_ALLOW_INSTALL=1 可安装到 $TOOLS_DIR"
  fi
  run_npm_install_tools
  NODE_PATH="$TOOLS_DIR/node_modules" node -e "require('playwright-chromium'); console.log('ok')" >/dev/null 2>&1 \
    || fail "playwright-chromium 安装后仍不可用"
}

patch_package_script() {
  local package_json="$1"
  node - "$package_json" "$TOOLS_DIR" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const toolsDir = process.argv[3];
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.scripts = pkg.scripts || {};
pkg.scripts.test = pkg.scripts.test || 'node -e "process.exit(0)"';
pkg.scripts['test:e2e'] = `NODE_PATH=${toolsDir}/node_modules node tests/e2e/todo-browser.e2e.js`;
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
NODE
}

write_spec_and_browser_test() {
  local app_dir="$1"
  mkdir -p "$app_dir/.harness" "$app_dir/tests/e2e"
  cat > "$app_dir/.harness/oss-source.json" <<JSON
{
  "schema_version": "1.0",
  "kind": "real_browser_oss_dogfood",
  "repo": "1Marc/modern-todomvc-vanillajs",
  "source_url": "$FRONTEND_URL",
  "tarball_sha256": "$(test -s "$FRONTEND_TARBALL" && hash_file "$FRONTEND_TARBALL" || echo "offline-dir")",
  "note": "真实开源前端工程浏览器链路，不是 SHK fixture。"
}
JSON
  cat > "$app_dir/.harness/iteration-spec.json" <<'JSON'
{
  "schema_version": "1.0",
  "risk": "medium",
  "requirements": [
    {
      "id": "REQ-BROWSER-TODO-1",
      "text": "用户在浏览器页面输入 todo 后，页面显示该 todo，并显示 1 item left。",
      "priority": "must",
      "source": "oss-browser-dogfood"
    }
  ],
  "design": {
    "summary": "启动真实 TodoMVC 页面，用浏览器验证新增、筛选、完成和清理链路。",
    "changed_areas": ["browser_todo_flow"],
    "risk_points": [
      { "id": "RISK-BROWSER-TODO-1", "text": "新增 todo 如果默认 completed，页面剩余数量和 Active/Completed 筛选会错误。" }
    ]
  },
  "traffic_flows": [
    {
      "id": "FLOW-BROWSER-TODO-1",
      "name": "browser todo create complete clear flow",
      "entrypoint": "GET /index.html",
      "steps": [
        "open TodoMVC page",
        "type todo and press Enter",
        "assert DOM label and 1 item left",
        "toggle completed and assert filters",
        "clear completed"
      ],
      "covers": ["REQ-BROWSER-TODO-1"],
      "risks": ["RISK-BROWSER-TODO-1"]
    }
  ],
  "test_plan": [
    {
      "id": "TEST-BROWSER-TODO-1",
      "type": "browser-e2e",
      "covers": ["REQ-BROWSER-TODO-1"],
      "risks": ["RISK-BROWSER-TODO-1"],
      "traffic_flows": ["FLOW-BROWSER-TODO-1"],
      "scenario": "Browser creates a todo, checks active/completed filters, and clears completed item",
      "assertions": [
        "todo label appears in DOM",
        "count shows 1 item left after create",
        "completed filter shows toggled item",
        "clear completed removes item"
      ],
      "negative_or_boundary": true
    }
  ],
  "acceptance": [
    {
      "id": "AC-BROWSER-TODO-1",
      "text": "浏览器链路和 completed 默认值 mutation 都有自动化证据。",
      "covers": ["REQ-BROWSER-TODO-1"],
      "tests": ["TEST-BROWSER-TODO-1"],
      "must_have_evidence": true
    }
  ]
}
JSON
  cat > "$app_dir/.harness/task-quality-contract.json" <<'JSON'
{
  "schema_version": "1.0",
  "risk": "medium",
  "changed_areas": ["browser_todo_flow"],
  "must_prove": ["REQ-BROWSER-TODO-1", "RISK-BROWSER-TODO-1", "FLOW-BROWSER-TODO-1"]
}
JSON
  cat > "$app_dir/tests/e2e/todo-browser.e2e.js" <<'JS'
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-chromium');

const root = path.join(__dirname, '../..');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveFile(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

(async () => {
  const server = http.createServer(serveFile);
  const port = await listen(server);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await page.fill('[data-todo="new"]', 'Browser dogfood todo');
    await page.press('[data-todo="new"]', 'Enter');

    const labels = await page.$$eval('[data-todo="label"]', els => els.map(el => el.textContent.trim()));
    assert.deepStrictEqual(labels, ['Browser dogfood todo'], 'todo label appears in DOM');

    const countAfterCreate = await page.textContent('[data-todo="count"]');
    assert.match(countAfterCreate.replace(/\s+/g, ' ').trim(), /^1 item left$/, 'count shows 1 item left after create');

    await page.click('[data-todo="toggle"]');
    await page.click('a[href="#/completed"]');
    await page.waitForTimeout(50);
    const completedLabels = await page.$$eval('[data-todo="list"] [data-todo="label"]', els => els.map(el => el.textContent.trim()));
    assert.deepStrictEqual(completedLabels, ['Browser dogfood todo'], 'completed filter shows toggled item');

    await page.click('[data-todo="clear-completed"]');
    const labelsAfterClear = await page.$$eval('[data-todo="label"]', els => els.map(el => el.textContent.trim()));
    assert.deepStrictEqual(labelsAfterClear, [], 'clear completed removes item');

    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.harness/e2e-result.json'),
      JSON.stringify({
        schema_version: '1.0',
        status: 'PASS',
        run_token: process.env.SHK_E2E_RUN_TOKEN || '',
        runtime: 'headless-browser',
        covered: {
          changed_areas: ['browser_todo_flow'],
          requirements: ['REQ-BROWSER-TODO-1'],
          risks: ['RISK-BROWSER-TODO-1'],
          traffic_flows: ['FLOW-BROWSER-TODO-1'],
          must_prove: ['REQ-BROWSER-TODO-1', 'RISK-BROWSER-TODO-1', 'FLOW-BROWSER-TODO-1']
        },
        assertions: [
          'todo label appears in DOM',
          'count shows 1 item left after create',
          'completed filter shows toggled item',
          'clear completed removes item'
        ],
        paths: [
          { type: 'positive browser', proof: 'open page, create todo, assert DOM label and count' },
          { type: 'negative boundary browser', proof: 'completed default mutation changes count/filter and fails this test' }
        ]
      }, null, 2) + '\n'
    );

    console.log('positive browser path: REQ-BROWSER-TODO-1 create todo shows DOM label and 1 item left');
    console.log('negative boundary browser path: RISK-BROWSER-TODO-1 completed default mutation is caught');
    console.log('traffic flow FLOW-BROWSER-TODO-1 browser todo create complete clear flow covered');
    console.log('writes .harness/e2e-result.json structured evidence');
  } finally {
    await browser.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
JS
  patch_package_script "$app_dir/package.json"
}

install_harness_project_skills() {
  local app_dir="$1"
  (cd "$app_dir" && HOME="$TEST_HOME" bash "$KIT_ROOT/install.sh" --target codex --scope project >/tmp/shk-browser-e2e-install-shk.log 2>&1)
  test -f "$app_dir/.codex/skills/auto-harness-test-bootstrap/SKILL.md" || fail "SHK project skill 未安装到 $app_dir"
}

prove_browser_mutation_killed() {
  local app_dir="$1"
  local target_file="$app_dir/js/store.js"
  local backup="$TMP_ROOT/store.js.before-mutation"
  cp "$target_file" "$backup"

  echo "[19-browser-e2e] normal browser E2E must pass"
  set +e
  (cd "$app_dir" && NODE_PATH="$TOOLS_DIR/node_modules" npm run test:e2e >/tmp/shk-browser-e2e-pass.log 2>&1)
  local normal_rc=$?
  set -e
  if [ "$normal_rc" -ne 0 ]; then
    if grep -Eiq 'listen EPERM|operation not permitted|browserType.launch|Executable doesn.t exist|Host system is missing dependencies' /tmp/shk-browser-e2e-pass.log; then
      skip_or_fail "浏览器 E2E runtime 不可用或沙盒禁止本地监听；log=/tmp/shk-browser-e2e-pass.log"
    fi
    cat /tmp/shk-browser-e2e-pass.log
    fail "normal browser E2E failed"
  fi

  echo "[19-browser-e2e] mutate real browser source"
  perl -0pi -e "s/completed: false/completed: true/" "$target_file"
  set +e
  (cd "$app_dir" && NODE_PATH="$TOOLS_DIR/node_modules" npm run test:e2e >/tmp/shk-browser-e2e-mutated.log 2>&1)
  local mutated_rc=$?
  set -e
  cp "$backup" "$target_file"
  if [ "$mutated_rc" -eq 0 ]; then
    cat /tmp/shk-browser-e2e-mutated.log
    fail "browser mutation still passed E2E"
  fi

  cat > "$app_dir/.harness/mutation-result.json" <<'JSON'
{
  "schema_version": "1.0",
  "status": "PASS",
  "killed": 1,
  "survived": 0,
  "mutants": [
    { "id": "MUT-BROWSER-TODO-1", "target": "new todo completed default", "status": "KILLED" }
  ]
}
JSON
}

assert_probe_ready() {
  local app_dir="$1"
  echo "[19-browser-e2e] spec status"
  (cd "$app_dir" && NODE_PATH="$TOOLS_DIR/node_modules" node "$KIT_ROOT/scripts/shk.js" spec status --risk medium --format json | grep -q '"overall": "READY"')
  echo "[19-browser-e2e] e2e assess"
  (cd "$app_dir" && NODE_PATH="$TOOLS_DIR/node_modules" node "$KIT_ROOT/scripts/shk.js" e2e assess --risk medium --format json | grep -q '"overall": "READY"')
  echo "[19-browser-e2e] test effectiveness"
  (cd "$app_dir" && NODE_PATH="$TOOLS_DIR/node_modules" node "$KIT_ROOT/scripts/shk.js" test effectiveness --risk medium --format json | grep -q '"overall": "READY"')
  echo "[19-browser-e2e] verify"
  (cd "$app_dir" && NODE_PATH="$TOOLS_DIR/node_modules" node "$KIT_ROOT/scripts/shk.js" verify --risk medium --write-evidence >/tmp/shk-browser-e2e-verify.log 2>&1)
  grep -q "overall: READY" "$app_dir/.harness/verify-evidence.md"
}

write_report() {
  local app_dir="$1"
  mkdir -p "$ARTIFACT_DIR/snapshot"
  cp "$app_dir/.harness/iteration-spec.json" "$ARTIFACT_DIR/snapshot/iteration-spec.json"
  cp "$app_dir/.harness/task-quality-contract.json" "$ARTIFACT_DIR/snapshot/task-quality-contract.json"
  cp "$app_dir/.harness/e2e-result.json" "$ARTIFACT_DIR/snapshot/e2e-result.json"
  cp "$app_dir/.harness/mutation-result.json" "$ARTIFACT_DIR/snapshot/mutation-result.json"
  cp "$app_dir/.harness/verify-evidence.json" "$ARTIFACT_DIR/snapshot/verify-evidence.json"
  cp "$app_dir/tests/e2e/todo-browser.e2e.js" "$ARTIFACT_DIR/snapshot/todo-browser.e2e.js"

  cat > "$ARTIFACT_DIR/phase2-browser-e2e-dogfood-result.json" <<JSON
{
  "schema_version": "1.0",
  "status": "PASS",
  "repo": "1Marc/modern-todomvc-vanillajs",
  "source_url": "$FRONTEND_URL",
  "runtime": "headless Playwright Chromium",
  "mutation": "js/store.js completed:false -> completed:true",
  "evidence_snapshot": "$ARTIFACT_DIR/snapshot",
  "human_summary": "真实 TodoMVC 页面浏览器链路通过；改坏 completed 默认值后同一条 browser E2E 失败。"
}
JSON
  cat > "$ARTIFACT_DIR/phase2-browser-e2e-dogfood-result.md" <<EOF
# Phase 2 browser E2E dogfood 结果

可以证明的事：

- 打开了真实 TodoMVC OSS 页面，不是源码级替代。
- 浏览器里输入 todo，检查 DOM label 和 \`1 item left\`。
- 完成 todo 后检查 Completed 筛选，再 clear completed。
- 把真实 \`js/store.js\` 改坏为 \`completed: true\` 后，同一条 browser E2E 失败。
- SHK 的 \`e2e assess\`、\`test effectiveness\`、\`verify\` 都基于 fresh run-token evidence 通过。

还没证明的事：

- 这仍是本地 headless browser，不是线上真实用户流量。
- 没有覆盖所有 UI 交互，只覆盖本轮 spec 里的关键链路。

机器状态：READY
EOF
  echo "[19-browser-e2e] report: $ARTIFACT_DIR/phase2-browser-e2e-dogfood-result.md"
}

mkdir -p "$TEST_HOME" "$ARTIFACT_DIR"
ensure_browser_tool

APP_DIR="$TMP_ROOT/frontend"
prepare_source "$APP_DIR"
test -f "$APP_DIR/index.html" || fail "frontend OSS source missing index.html"
test -f "$APP_DIR/js/store.js" || fail "frontend OSS source missing js/store.js"

install_harness_project_skills "$APP_DIR"
write_spec_and_browser_test "$APP_DIR"
prove_browser_mutation_killed "$APP_DIR"
assert_probe_ready "$APP_DIR"
write_report "$APP_DIR"

echo "[19-browser-e2e] PASS: real browser E2E caught TodoMVC mutation"

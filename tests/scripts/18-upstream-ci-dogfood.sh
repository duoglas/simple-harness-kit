#!/usr/bin/env bash
# 18-upstream-ci-dogfood.sh — Phase 2 upstream npm install / 原项目 CI dogfood
#
# 这个脚本补上一轮没有做的“上游安装/原 CI”证据：
# 1. 使用真实 OSS tarball 临时副本，不用 fixture 冒充；
# 2. 对每个 OSS 工程跑 npm ci / npm install；
# 3. 跑原项目声明的 test/build/lint/typecheck（存在则跑）；
# 4. 如果原项目 test 是 echo ok / No test specified / exit 0 这类空壳，报告为 NO_PROOF，
#    不能把它包装成“上游 CI 有效”；
# 5. 输出结构化报告，区分“依赖安装成功”和“原 CI 有证明力”。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shk-upstream-ci.XXXXXX")"
DOWNLOAD_DIR="${SHK_OSS_DOGFOOD_DOWNLOAD_DIR:-/private/tmp/shk-oss-dogfood-downloads}"
ARTIFACT_DIR="${SHK_UPSTREAM_CI_ARTIFACT_DIR:-/private/tmp/shk-upstream-ci-artifacts}"
OFFLINE_DIR="${SHK_OSS_DOGFOOD_OFFLINE_DIR:-}"
ALLOW_DOWNLOAD="${SHK_OSS_DOGFOOD_ALLOW_DOWNLOAD:-0}"
REQUIRED="${SHK_UPSTREAM_CI_REQUIRED:-0}"
NPM_RUN_SCRIPTS="${SHK_UPSTREAM_NPM_RUN_SCRIPTS:-1}"
NPM_PROXY="${SHK_NPM_PROXY:-}"

FRONTEND_URL="https://codeload.github.com/1Marc/modern-todomvc-vanillajs/tar.gz/refs/heads/main"
API_URL="https://codeload.github.com/rwieruch/node-express-server-rest-api/tar.gz/refs/heads/master"
FRONTEND_TARBALL="$DOWNLOAD_DIR/modern-todomvc.tar.gz"
API_TARBALL="$DOWNLOAD_DIR/node-express-rest-api.tar.gz"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "[18-upstream-ci] FAIL: $*"
  exit 1
}

skip_or_fail() {
  if [ "$REQUIRED" = "1" ]; then
    fail "$*"
  fi
  echo "[18-upstream-ci] SKIP: $*"
  echo "[18-upstream-ci] 说明：没有使用 fixture 冒充 upstream CI。提供 tarball/npm 网络后可重跑。"
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
    echo "[18-upstream-ci] cache hit: $label → $out"
    return 0
  fi
  if [ "$ALLOW_DOWNLOAD" != "1" ]; then
    skip_or_fail "缺少 $label tarball：$out"
  fi
  mkdir -p "$DOWNLOAD_DIR"
  echo "[18-upstream-ci] download: $label"
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
    echo "[18-upstream-ci] source: offline dir $OFFLINE_DIR"
    return 0
  fi
  ensure_tarball "$FRONTEND_URL" "$FRONTEND_TARBALL" "modern-todomvc-vanillajs"
  ensure_tarball "$API_URL" "$API_TARBALL" "node-express-server-rest-api"
  tar -xzf "$FRONTEND_TARBALL" -C "$frontend_dir" --strip-components=1
  tar -xzf "$API_TARBALL" -C "$api_dir" --strip-components=1
}

is_weak_script() {
  local script="$1"
  node - "$script" <<'NODE'
const script = String(process.argv[2] || '').trim();
const weak = [
  /^$/,
  /^true$/,
  /^exit\s+0$/,
  /^echo\s+ok$/i,
  /^echo\s+pass$/i,
  /^node\s+-e\s+["']process\.exit\(0\)["']$/i,
  /No test specified/i,
  /no tests?/i,
].some((pattern) => pattern.test(script));
process.exit(weak ? 0 : 1);
NODE
}

run_with_log() {
  local label="$1"
  local dir="$2"
  local logfile="$3"
  shift 3
  echo "[18-upstream-ci] $label: $*" >&2
  set +e
  (cd "$dir" && "$@" >"$logfile" 2>&1)
  local rc=$?
  set -e
  echo "$rc"
}

package_scripts_json() {
  local dir="$1"
  node - "$dir/package.json" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log(JSON.stringify(pkg.scripts || {}));
NODE
}

run_project() {
  local name="$1"
  local kind="$2"
  local source_url="$3"
  local tarball="$4"
  local dir="$5"
  local out_json="$ARTIFACT_DIR/$name-result.json"
  local out_md="$ARTIFACT_DIR/$name-result.md"
  local install_log="$ARTIFACT_DIR/$name-npm-install.log"

  test -f "$dir/package.json" || fail "$name 缺 package.json"

  local install_cmd="npm install"
  if [ -f "$dir/package-lock.json" ]; then
    install_cmd="npm ci"
  fi
  local script_flag=()
  if [ "$NPM_RUN_SCRIPTS" != "1" ]; then
    script_flag+=(--ignore-scripts)
  fi

  local install_rc
  local npm_network_flags=(
    --fetch-timeout=30000
    --fetch-retries=1
    --fetch-retry-mintimeout=5000
    --fetch-retry-maxtimeout=30000
  )
  if [ -n "$NPM_PROXY" ]; then
    npm_network_flags+=(--proxy="$NPM_PROXY" --https-proxy="$NPM_PROXY")
  fi
  if [ "${#script_flag[@]}" -gt 0 ]; then
    install_rc="$(run_with_log "$name install" "$dir" "$install_log" $install_cmd --no-audit --fund=false --prefer-offline "${npm_network_flags[@]}" "${script_flag[@]}")"
  else
    install_rc="$(run_with_log "$name install" "$dir" "$install_log" $install_cmd --no-audit --fund=false --prefer-offline "${npm_network_flags[@]}")"
  fi
  if [ "$install_rc" != "0" ]; then
    if grep -Eiq 'ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|proxy|registry|ECONNRESET|certificate' "$install_log"; then
      skip_or_fail "$name npm install 失败，像是网络/proxy/registry 问题；log=$install_log"
    fi
    fail "$name npm install 失败；log=$install_log"
  fi

  local scripts_json
  scripts_json="$(package_scripts_json "$dir")"
  local commands_json="$ARTIFACT_DIR/$name-commands.json"
  node - "$name" "$dir" "$scripts_json" "$ARTIFACT_DIR" > "$commands_json" <<'NODE'
const fs = require('fs');
const path = require('path');
const name = process.argv[2];
const dir = process.argv[3];
const scripts = JSON.parse(process.argv[4]);
const artifactDir = process.argv[5];
const candidates = ['test', 'build', 'lint', 'typecheck'];
const out = [];
for (const scriptName of candidates) {
  if (!scripts[scriptName]) continue;
  const body = String(scripts[scriptName]);
  const weak = [
    /^$/,
    /^true$/,
    /^exit\s+0$/,
    /^echo\s+ok$/i,
    /^echo\s+pass$/i,
    /^node\s+-e\s+["']process\.exit\(0\)["']$/i,
    /No test specified/i,
    /no tests?/i,
  ].some((pattern) => pattern.test(body.trim()));
  out.push({
    script: scriptName,
    command: `npm run ${scriptName}`,
    body,
    proof: weak ? 'NO_PROOF' : 'POTENTIAL_PROOF',
    log: path.join(artifactDir, `${name}-npm-${scriptName}.log`),
  });
}
process.stdout.write(JSON.stringify(out, null, 2));
NODE

  local ran_any=0
  local failed_any=0
  local proof_any=0
  local no_proof_any=0

  node - "$commands_json" <<'NODE' | while IFS= read -r script_name; do
const fs = require('fs');
const commands = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const c of commands) console.log(c.script);
NODE
    ran_any=1
    local body
    body="$(node - "$commands_json" "$script_name" <<'NODE'
const fs = require('fs');
const commands = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = commands.find(c => c.script === process.argv[3]);
console.log(item ? item.body : '');
NODE
)"
    local proof
    proof="$(node - "$commands_json" "$script_name" <<'NODE'
const fs = require('fs');
const commands = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = commands.find(c => c.script === process.argv[3]);
console.log(item ? item.proof : 'NO_PROOF');
NODE
)"
    local log
    log="$(node - "$commands_json" "$script_name" <<'NODE'
const fs = require('fs');
const commands = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = commands.find(c => c.script === process.argv[3]);
console.log(item ? item.log : '');
NODE
)"
    local rc
    rc="$(run_with_log "$name npm run $script_name" "$dir" "$log" npm run "$script_name")"
    if [ "$rc" != "0" ]; then failed_any=1; fi
    if [ "$proof" = "POTENTIAL_PROOF" ]; then proof_any=1; else no_proof_any=1; fi
  done

  local commands_compact
  commands_compact="$(cat "$commands_json")"
  node - "$out_json" "$name" "$kind" "$source_url" "$tarball" "$install_cmd" "$install_log" "$install_rc" "$commands_json" <<'NODE'
const fs = require('fs');
const [out, name, kind, sourceUrl, tarball, installCommand, installLog, installRc, commandsPath] = process.argv.slice(2);
const commands = JSON.parse(fs.readFileSync(commandsPath, 'utf8'));
const anyFailed = commands.some(c => {
  try {
    const log = fs.readFileSync(c.log, 'utf8');
    return /npm ERR!|Command failed/i.test(log);
  } catch {
    return false;
  }
});
const proofCommands = commands.filter(c => c.proof === 'POTENTIAL_PROOF');
const noProofCommands = commands.filter(c => c.proof === 'NO_PROOF');
const status = Number(installRc) === 0 && !anyFailed ? 'PASS' : 'FAIL';
const ciProof = proofCommands.length > 0 ? 'PARTIAL' : 'NO_PROOF';
fs.writeFileSync(out, JSON.stringify({
  schema_version: '1.0',
  status,
  kind,
  repo: name,
  source_url: sourceUrl,
  tarball,
  install: {
    status: Number(installRc) === 0 ? 'PASS' : 'FAIL',
    command: installCommand,
    lifecycle_scripts: process.env.SHK_UPSTREAM_NPM_RUN_SCRIPTS === '0' ? 'disabled' : 'enabled',
    log: installLog,
  },
  original_ci: {
    status: anyFailed ? 'FAIL' : 'PASS',
    proof: ciProof,
    commands,
    no_proof_scripts: noProofCommands.map(c => c.script),
  },
  human_summary: ciProof === 'NO_PROOF'
    ? '依赖安装跑通了，但原项目没有有证明力的 test/build/lint/typecheck；不能把 upstream CI 说成有效质量证明。'
    : '依赖安装跑通了，原项目存在非空脚本；仍需结合 SHK 生成的 E2E/mutation evidence 判断交付质量。'
}, null, 2) + '\n');
NODE

  node - "$out_json" "$out_md" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const lines = [];
lines.push(`# ${report.repo} upstream CI dogfood`);
lines.push('');
lines.push(`- install: ${report.install.status} (${report.install.command})`);
lines.push(`- original_ci: ${report.original_ci.status}`);
lines.push(`- proof: ${report.original_ci.proof}`);
if (report.original_ci.no_proof_scripts.length) {
  lines.push(`- no_proof_scripts: ${report.original_ci.no_proof_scripts.join(', ')}`);
}
lines.push('');
lines.push(report.human_summary);
lines.push('');
fs.writeFileSync(process.argv[3], lines.join('\n'));
NODE

  local status
  status="$(node -e "const r=require('$out_json'); console.log(r.status)")"
  test "$status" = "PASS" || fail "$name upstream dogfood failed"
}

mkdir -p "$ARTIFACT_DIR"
FRONTEND_APP="$TMP_ROOT/frontend"
API_APP="$TMP_ROOT/api"
prepare_sources "$FRONTEND_APP" "$API_APP"

run_project "modern-todomvc-vanillajs" "frontend" "$FRONTEND_URL" "$FRONTEND_TARBALL" "$FRONTEND_APP"
run_project "node-express-server-rest-api" "api" "$API_URL" "$API_TARBALL" "$API_APP"

node - "$ARTIFACT_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const files = ['modern-todomvc-vanillajs-result.json', 'node-express-server-rest-api-result.json'];
const reports = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const out = {
  schema_version: '1.0',
  status: reports.every(r => r.status === 'PASS') ? 'PASS' : 'FAIL',
  generated_at: new Date().toISOString(),
  reports,
  human_summary: '两个真实 OSS 工程都完成了 npm install/ci。原项目 CI 证明力单独标注：空壳或缺失脚本不算有效质量证明。',
};
fs.writeFileSync(path.join(dir, 'phase2-upstream-ci-dogfood-result.json'), JSON.stringify(out, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'phase2-upstream-ci-dogfood-result.md'), [
  '# Phase 2 upstream CI dogfood 结果',
  '',
  '可以证明的事：',
  '',
  '- 两个真实 OSS 工程都完成了 npm 依赖安装。',
  '- 原项目自带脚本逐项检查，空壳 test 不会被包装成有效 CI。',
  '- upstream CI 证据和 SHK 生成的 E2E/mutation 证据被分开记录。',
  '',
  '还没证明的事：',
  '',
  '- 原项目如果本身没有有效 test/build/lint，就只能说明 upstream CI 无证明力。',
  '- 这一步不替代浏览器 E2E，也不替代 SHK mutation dogfood。',
  '',
  '机器状态：PASS',
  '',
].join('\n'));
NODE

echo "[18-upstream-ci] report: $ARTIFACT_DIR/phase2-upstream-ci-dogfood-result.md"
echo "[18-upstream-ci] PASS: upstream npm install / original CI dogfood completed"

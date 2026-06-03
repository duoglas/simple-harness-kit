#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const KIT_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(KIT_ROOT, 'manifests/shk-profiles.json');

const RISK_ORDER = { low: 1, medium: 2, high: 3, release: 4 };
const ALL_CHECKS = [
  'build', 'types', 'lint', 'tests', 'coverage', 'e2e',
  'security', 'diff', 'spec', 'santa', 'runtime', 'clean_tree', 'upstream',
];
const RISK_CHECKS = {
  low: ['build', 'tests', 'diff', 'security'],
  medium: ['build', 'tests', 'diff', 'security', 'types', 'lint', 'coverage', 'spec'],
  high: ['build', 'tests', 'diff', 'security', 'types', 'lint', 'coverage', 'spec', 'e2e', 'santa'],
  release: ['build', 'tests', 'diff', 'security', 'types', 'lint', 'coverage', 'spec', 'e2e', 'santa', 'runtime', 'clean_tree', 'upstream'],
};

const DEFAULT_MANIFEST = {
  schema_version: '1.0',
  profiles: {
    minimal: ['stage-guard', 'session-logger'],
    core: ['minimal', 'safety-guard', 'verification-gate'],
    full: ['core', 'delivery-gate', 'context-monitor', 'doctor', 'infra-tier'],
    release: ['full', 'runtime-smoke', 'pre-release-check', 'santa-review'],
    codex: ['core', 'codex-hooks', 'permission-request-guard'],
  },
  components: {
    'stage-guard': { kind: 'hook', script: 'scripts/hooks/harness-stage-guard.js' },
    'session-logger': { kind: 'hook', script: 'scripts/hooks/session-logger.js' },
    'safety-guard': { kind: 'hook', script: 'scripts/hooks/safety-guard.js' },
    'verification-gate': { kind: 'hook', script: 'scripts/hooks/verification-gate.js' },
  },
};

const DEFAULT_SECRET_PATTERN_ENTRIES = [
  { id: 'openai-key', type: 'secret-pattern', pattern: 'sk-[A-Za-z0-9_\\-]{20,}' },
  { id: 'api-key-assignment', type: 'secret-pattern', pattern: "api[_-]?key\\s*[:=]\\s*[\"'][^\"']{8,}" },
  { id: 'password-assignment', type: 'secret-pattern', pattern: "password\\s*[:=]\\s*[\"'][^\"']{6,}" },
  { id: 'secret-assignment', type: 'secret-pattern', pattern: "secret\\s*[:=]\\s*[\"'][^\"']{8,}" },
  { id: 'private-key', type: 'secret-pattern', pattern: '-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----' },
];

const CONFIG_RISK_PATTERNS = [
  { id: 'destructive-rm', pattern: /\brm\s+-rf\b/i, message: 'destructive rm -rf in config command' },
  { id: 'curl-pipe-shell', pattern: /\b(curl|wget)\b[^\n|;]*\|\s*(sh|bash)\b/i, message: 'network installer piped to shell' },
  { id: 'world-writable', pattern: /\bchmod\s+777\b/i, message: 'world-writable chmod in config command' },
  { id: 'sudo', pattern: /\bsudo\b/i, message: 'sudo in config command' },
  { id: 'codex-bypass', pattern: /--dangerously-bypass-approvals-and-sandbox/i, message: 'Codex bypass flag in config command' },
];

function usage() {
  console.log(`shk — Simple Harness Kit command surface

Usage:
  shk verify --risk low|medium|high|release [--write-evidence]
  shk doctor [--format human|json]
  shk status
  shk security scan [--format human|json]
  shk test-infra assess
  shk e2e detect
  shk qa report
  shk skills list
  shk skills explain <name>
  shk consult <request>
  shk lane create <name>
  shk lane list
  shk lane compare
  shk benchmark run --plan <plan.md>
  shk install --profile <name> [--dry-run]
  shk repair --profile <name> [--dry-run] [--force]
`);
}

function projectRoot(start = process.cwd()) {
  let d = path.resolve(start);
  while (d !== path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.harness')) || fs.existsSync(path.join(d, '.git')) || fs.existsSync(path.join(d, 'scripts/hooks/find-root.js'))) return d;
    d = path.dirname(d);
  }
  return path.resolve(start);
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, data) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n'); }
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function rel(root, p) { return path.relative(root, p).replace(/\\/g, '/') || '.'; }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function loadManifest() {
  const loaded = readJson(MANIFEST_PATH);
  if (!loaded || !loaded.profiles) return DEFAULT_MANIFEST;
  return {
    schema_version: loaded.schema_version || '1.0',
    profiles: loaded.profiles || DEFAULT_MANIFEST.profiles,
    components: loaded.components || DEFAULT_MANIFEST.components,
  };
}

function runCommand(root, command, timeout = 120000) {
  if (!command) return { status: 'SKIP', command: '', reason: 'not configured' };
  const res = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 });
  return {
    status: res.status === 0 ? 'PASS' : 'FAIL',
    command,
    exit_code: res.status === null ? 124 : res.status,
    stdout_tail: String(res.stdout || '').slice(-2000),
    stderr_tail: String(res.stderr || '').slice(-2000),
  };
}

function detectCommands(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = pkg && pkg.scripts || {};
  return {
    build: scripts.build ? 'npm run build' : '',
    types: scripts.typecheck ? 'npm run typecheck' : scripts.types ? 'npm run types' : '',
    lint: scripts.lint ? 'npm run lint' : '',
    tests: scripts.test ? 'npm test' : exists(path.join(root, 'tests/run.js')) ? 'node tests/run.js' : '',
    coverage: scripts.coverage ? 'npm run coverage' : '',
    e2e: scripts['test:e2e'] ? 'npm run test:e2e' : scripts.e2e ? 'npm run e2e' : '',
    runtime: exists(path.join(root, 'tests/codex-smoke.sh')) ? 'bash tests/codex-smoke.sh' : '',
  };
}

function scanFiles(root, options = {}) {
  const maxBytes = options.maxBytes || 512 * 1024;
  const skipDirNames = new Set(['.git', 'node_modules', 'coverage', 'dist', 'build', '.next', '.turbo']);
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const r = rel(root, full);
      if (entry.isDirectory()) {
        if (skipDirNames.has(entry.name)) continue;
        if (r === '.harness' || r.startsWith('.harness/')) continue;
        walk(full);
      } else if (entry.isFile()) {
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.size <= maxBytes) out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function normalizePatternEntry(entry, fallbackType) {
  if (typeof entry === 'string') return { id: entry, type: fallbackType, pattern: entry };
  if (!entry || typeof entry !== 'object' || !entry.pattern) return null;
  return {
    id: entry.id || entry.name || entry.type || String(entry.pattern),
    type: entry.type || fallbackType,
    pattern: entry.pattern,
    severity: entry.severity || 'high',
  };
}

function loadPatternEntries(root, relPath, fallbackType) {
  const data = readJson(path.join(root, relPath));
  if (!data) return [];
  const raw = Array.isArray(data) ? data : Array.isArray(data.patterns) ? data.patterns : [];
  return raw.map(e => normalizePatternEntry(e, fallbackType)).filter(Boolean);
}

function compilePatternEntries(entries) {
  const out = [];
  for (const e of entries) {
    try { out.push({ ...e, re: new RegExp(e.pattern, e.flags || 'i') }); } catch {}
  }
  return out;
}

function scanTextPatterns(root, entries) {
  const findings = [];
  const compiled = compilePatternEntries(entries);
  if (compiled.length === 0) return { status: 'PASS', findings: 0, details: [], configured: false };
  for (const file of scanFiles(root)) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const p of compiled) {
        if (p.re.test(line)) {
          findings.push({ file: rel(root, file), line: idx + 1, type: p.type, id: p.id, severity: p.severity || 'high' });
        }
        p.re.lastIndex = 0;
      }
    });
  }
  return { status: findings.length === 0 ? 'PASS' : 'FAIL', findings: findings.length, details: findings.slice(0, 100), configured: true };
}

function runSecretScan(root) {
  const configured = loadPatternEntries(root, '.harness/security-patterns.json', 'custom-security-pattern');
  return scanTextPatterns(root, [...DEFAULT_SECRET_PATTERN_ENTRIES, ...configured]);
}

function runPublicLeakScan(root) {
  const configured = [
    ...loadPatternEntries(root, '.harness/public-leak-patterns.json', 'public-leak-pattern'),
    ...loadPatternEntries(root, '.harness/internal-leak-patterns.json', 'public-leak-pattern'),
  ];
  const result = scanTextPatterns(root, configured);
  return { ...result, configured: configured.length > 0 };
}

function collectConfigStrings(value, out = [], keyPath = []) {
  if (typeof value === 'string') {
    out.push({ value, keyPath: keyPath.join('.') });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectConfigStrings(v, out, keyPath.concat(String(i))));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectConfigStrings(v, out, keyPath.concat(k));
  }
  return out;
}

function runConfigRiskScan(root) {
  const configFiles = [
    '.claude/settings.json',
    '.codex/hooks.json',
    '.mcp.json',
    'mcp.json',
    '.cursor/mcp.json',
    '.gemini/settings.json',
  ];
  const findings = [];
  for (const file of configFiles) {
    const full = path.join(root, file);
    if (!exists(full)) continue;
    const data = readJson(full);
    const strings = data ? collectConfigStrings(data) : [{ value: readText(full), keyPath: '(raw)' }];
    for (const s of strings) {
      for (const p of CONFIG_RISK_PATTERNS) {
        if (p.pattern.test(s.value)) {
          findings.push({ file, key: s.keyPath, type: 'config-risk', id: p.id, message: p.message });
        }
      }
    }
  }
  return { status: findings.length === 0 ? 'PASS' : 'FAIL', findings: findings.length, details: findings.slice(0, 100) };
}

function runSecurityScan(root) {
  const secrets = runSecretScan(root);
  const publicLeaks = runPublicLeakScan(root);
  const configRisks = runConfigRiskScan(root);
  const details = [
    ...(secrets.details || []),
    ...(publicLeaks.details || []),
    ...(configRisks.details || []),
  ];
  return {
    status: details.length === 0 ? 'PASS' : 'FAIL',
    findings: details.length,
    details,
    sections: { secrets, public_leaks: publicLeaks, config_risks: configRisks },
  };
}

function diffCheck(root) {
  const stat = spawnSync('git', ['diff', '--stat'], { cwd: root, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const files = String(status.stdout || '').split('\n').filter(Boolean).length;
  return { status: 'PASS', files, summary: String(stat.stdout || '').trim() };
}

function cleanTreeCheck(root) {
  const res = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) return { status: 'SKIP', command: 'git status --porcelain', reason: 'not a git repository' };
  const files = String(res.stdout || '').split('\n').filter(Boolean);
  return { status: files.length === 0 ? 'PASS' : 'FAIL', command: 'git status --porcelain', files: files.length, dirty: files.slice(0, 50) };
}

function upstreamCheck(root) {
  const up = spawnSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: root, encoding: 'utf8' });
  if (up.status !== 0) return { status: 'FAIL', command: 'git rev-parse @{u}', reason: 'no upstream configured' };
  const local = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const remote = spawnSync('git', ['rev-parse', '@{u}'], { cwd: root, encoding: 'utf8' });
  const same = local.status === 0 && remote.status === 0 && local.stdout.trim() === remote.stdout.trim();
  return { status: same ? 'PASS' : 'FAIL', command: 'git rev-parse HEAD && git rev-parse @{u}', upstream: up.stdout.trim() };
}

function makeEvidence(root, risk) {
  const started = new Date().toISOString();
  const commands = detectCommands(root);
  const checks = {};
  for (const name of ALL_CHECKS) checks[name] = { status: 'SKIP', command: '', reason: 'not required or not configured' };
  const required = RISK_CHECKS[risk] || RISK_CHECKS.medium;
  for (const check of required) {
    if (check === 'security') checks.security = runSecurityScan(root);
    else if (check === 'diff') checks.diff = diffCheck(root);
    else if (check === 'clean_tree') checks.clean_tree = cleanTreeCheck(root);
    else if (check === 'upstream') checks.upstream = upstreamCheck(root);
    else if (['build', 'types', 'lint', 'tests', 'coverage', 'e2e', 'runtime'].includes(check)) checks[check] = runCommand(root, commands[check]);
    else checks[check] = { status: 'SKIP', command: '', reason: `${check} requires agent/human review` };
  }
  const failed = Object.values(checks).some(c => c.status === 'FAIL');
  return {
    schema_version: '1.0',
    task_id: process.env.SHK_TASK_ID || path.basename(root),
    risk,
    stage: 'VERIFY',
    started_at: started,
    completed_at: new Date().toISOString(),
    checks,
    overall: failed ? 'NOT_READY' : 'READY',
  };
}

function evidenceMarkdown(e) {
  const lines = [];
  lines.push('# SHK Verification Report');
  lines.push('');
  lines.push(`- risk: ${e.risk}`);
  lines.push(`- overall: ${e.overall}`);
  lines.push(`- completed_at: ${e.completed_at}`);
  lines.push('');
  lines.push('| Check | Status | Command / Detail |');
  lines.push('|---|---|---|');
  for (const [name, c] of Object.entries(e.checks || {})) {
    const detail = c.command || c.reason || (c.findings !== undefined ? `${c.findings} findings` : c.files !== undefined ? `${c.files} files` : '');
    lines.push(`| ${name} | ${c.status} | ${String(detail).replace(/\|/g, '/')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeEvidence(root, evidence) {
  const h = path.join(root, '.harness');
  ensureDir(h);
  ensureDir(path.join(root, 'docs'));
  writeJson(path.join(h, 'verify-evidence.json'), evidence);
  const md = evidenceMarkdown(evidence);
  fs.writeFileSync(path.join(h, 'verify-evidence.md'), md, 'utf8');
  fs.writeFileSync(path.join(root, 'docs/verification-report.md'), md, 'utf8');
}

function cmdVerify(args, root) {
  const riskIdx = args.indexOf('--risk');
  const risk = riskIdx >= 0 ? args[riskIdx + 1] : 'medium';
  if (!RISK_ORDER[risk]) throw new Error(`invalid risk: ${risk}`);
  const evidence = makeEvidence(root, risk);
  if (args.includes('--write-evidence')) writeEvidence(root, evidence);
  console.log(evidenceMarkdown(evidence));
  return evidence.overall === 'READY' ? 0 : 1;
}

function latestEvidence(root) { return readJson(path.join(root, '.harness/verify-evidence.json')); }
function stageData(root) { return readJson(path.join(root, '.harness/current-stage.json')); }

function settingsHasWiring(settings, wiring) {
  const entries = settings && settings.hooks && settings.hooks[wiring.event];
  if (!Array.isArray(entries)) return false;
  return entries.some(entry => {
    if (wiring.matcher !== null && entry.matcher !== wiring.matcher) return false;
    return Array.isArray(entry.hooks) && entry.hooks.some(h => String(h.command || '').includes(`scripts/hooks/${wiring.script}`));
  });
}

function hookWiringCheck(root) {
  const required = readJson(path.join(root, 'tests/required-wiring.json'));
  const settingsPath = exists(path.join(root, '.claude/settings.json'))
    ? path.join(root, '.claude/settings.json')
    : path.join(root, 'templates/settings-json.tmpl');
  const settings = readJson(settingsPath);
  if (!required || !Array.isArray(required.wirings)) return { status: 'WARN', message: 'required wiring manifest missing' };
  if (!settings) return { status: 'WARN', message: '.claude/settings.json or templates/settings-json.tmpl missing' };
  const missing = required.wirings.filter(w => !settingsHasWiring(settings, w));
  return {
    status: missing.length === 0 ? 'PASS' : 'FAIL',
    message: missing.length === 0 ? `wiring matches ${rel(root, settingsPath)}` : `${missing.length} required hook wirings missing`,
    missing: missing.slice(0, 50),
  };
}

function codexHasEntryBannerWiring(codexHooks) {
  const entries = codexHooks && codexHooks.hooks && codexHooks.hooks.UserPromptSubmit;
  if (!Array.isArray(entries)) return false;
  return entries.some(entry => {
    return Array.isArray(entry.hooks) && entry.hooks.some(h => String(h.command || '').includes('scripts/hooks/harness-entry-banner.js'));
  });
}

function codexEntryBannerCheck(root) {
  const codexPath = path.join(root, '.codex/hooks.json');
  const scriptPath = path.join(root, 'scripts/hooks/harness-entry-banner.js');
  const evidencePath = path.join(root, '.harness/entry-banner.json');
  const codexHooks = readJson(codexPath);
  const evidence = readJson(evidencePath);
  const userPromptSubmitWired = codexHasEntryBannerWiring(codexHooks);
  const entryBannerScriptExists = exists(scriptPath);
  let entryBannerRecent = false;
  let entryBannerAgeSeconds = null;
  if (evidence && evidence.t && evidence.emitted) {
    const t = new Date(evidence.t).getTime();
    if (!Number.isNaN(t)) {
      entryBannerAgeSeconds = Math.max(0, Math.round((Date.now() - t) / 1000));
      entryBannerRecent = entryBannerAgeSeconds <= 24 * 60 * 60;
    }
  }

  let status = 'PASS';
  const missing = [];
  if (!codexHooks) missing.push('.codex/hooks.json');
  if (!userPromptSubmitWired) missing.push('UserPromptSubmit -> scripts/hooks/harness-entry-banner.js');
  if (!entryBannerScriptExists) missing.push('scripts/hooks/harness-entry-banner.js');
  if (!entryBannerRecent) missing.push('.harness/entry-banner.json recent emitted=true evidence');

  if (!codexHooks) status = 'WARN';
  else if (!userPromptSubmitWired || !entryBannerScriptExists) status = 'FAIL';
  else if (!entryBannerRecent) status = 'WARN';

  const message = status === 'PASS'
    ? 'Codex UserPromptSubmit banner wiring observed recently'
    : `Codex entry banner check incomplete: ${missing.join(', ')}`;
  return {
    status,
    message,
    user_prompt_submit_wired: userPromptSubmitWired,
    entry_banner_script_exists: entryBannerScriptExists,
    entry_banner_recent: entryBannerRecent,
    entry_banner_age_seconds: entryBannerAgeSeconds,
    codex_hooks_path: rel(root, codexPath),
    entry_banner_path: rel(root, evidencePath),
    missing,
  };
}

function doctorReport(root) {
  const checks = [];
  const add = (id, status, message, data = {}) => checks.push({ id, status, message, ...data });
  const stage = stageData(root);
  let stageSince = null;
  if (!stage) add('stage-state', 'WARN', '.harness/current-stage.json missing or invalid');
  else {
    stageSince = stage.since ? new Date(stage.since) : null;
    if (!stage.stage) add('stage-state', 'FAIL', 'stage field missing');
    else if (stageSince && Number.isNaN(stageSince.getTime())) add('stage-state', 'FAIL', `invalid since=${stage.since}`, { stage: stage.stage });
    else add('stage-state', 'PASS', `stage=${stage.stage}`, { stage: stage.stage, since: stage.since });
  }

  const wiring = hookWiringCheck(root);
  add('hook-wiring', wiring.status, wiring.message, wiring.missing ? { missing: wiring.missing } : {});

  const codexEntry = codexEntryBannerCheck(root);
  add('codex-entry-banner', codexEntry.status, codexEntry.message, {
    user_prompt_submit_wired: codexEntry.user_prompt_submit_wired,
    entry_banner_script_exists: codexEntry.entry_banner_script_exists,
    entry_banner_recent: codexEntry.entry_banner_recent,
    entry_banner_age_seconds: codexEntry.entry_banner_age_seconds,
    codex_hooks_path: codexEntry.codex_hooks_path,
    entry_banner_path: codexEntry.entry_banner_path,
    missing: codexEntry.missing,
  });

  const evidence = latestEvidence(root);
  if (!evidence) add('verify-evidence', 'WARN', '.harness/verify-evidence.json missing');
  else if (evidence.overall !== 'READY') add('verify-evidence', 'FAIL', `overall=${evidence.overall}`, { risk: evidence.risk });
  else {
    let evidenceFresh = true;
    if (stageSince && !Number.isNaN(stageSince.getTime())) {
      try { evidenceFresh = fs.statSync(path.join(root, '.harness/verify-evidence.json')).mtime >= stageSince; } catch { evidenceFresh = false; }
    }
    add('verify-evidence', evidenceFresh ? 'PASS' : 'FAIL', evidenceFresh ? `READY risk=${evidence.risk}` : 'READY evidence is older than current stage since', { risk: evidence.risk });
  }

  const obs = readText(path.join(root, '.harness/observations.jsonl'));
  const pre = readText(path.join(root, '.harness/pretool-observations.jsonl'));
  if (/"tool"\s*:\s*"Bash"/.test(obs) && !/"hook_event_name"\s*:\s*"PreToolUse"/.test(pre)) {
    add('pretool-enforce-observed', 'FAIL', 'PostToolUse Bash observations exist but no PreToolUse stage-guard observations were recorded; blocking hooks may not be enforcing');
  } else if (/"hook_event_name"\s*:\s*"PreToolUse"/.test(pre)) {
    add('pretool-enforce-observed', 'PASS', 'PreToolUse stage-guard observations recorded');
  } else {
    add('pretool-enforce-observed', 'WARN', 'No Bash observations yet; run a small blocked-command probe to confirm enforcement');
  }

  const secret = runSecretScan(root);
  add('secret-scan', secret.status, secret.status === 'PASS' ? 'no generic secret patterns found' : `${secret.findings} secret findings`, { findings: secret.details || [] });

  const leak = runPublicLeakScan(root);
  add('public-leak-scan', leak.status, leak.configured ? (leak.status === 'PASS' ? 'no configured public leak patterns found' : `${leak.findings} configured public leak findings`) : 'no public leak pattern file configured', { findings: leak.details || [] });

  const configRisk = runConfigRiskScan(root);
  add('config-risk-scan', configRisk.status, configRisk.status === 'PASS' ? 'no high-risk hook/MCP config found' : `${configRisk.findings} high-risk config findings`, { findings: configRisk.details || [] });

  const overall = checks.some(c => c.status === 'FAIL') ? 'FAIL' : checks.some(c => c.status === 'WARN') ? 'WARN' : 'PASS';
  return { schema_version: '1.0', root, overall, checks };
}

function printDoctor(report, format) {
  if (format === 'json') { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`SHK Doctor: ${report.overall}`);
  for (const c of report.checks) console.log(`- [${c.status}] ${c.id}: ${c.message}`);
}

function cmdDoctor(args, root) {
  const fmtIdx = args.indexOf('--format');
  const fmt = fmtIdx >= 0 ? args[fmtIdx + 1] : 'human';
  const report = doctorReport(root);
  printDoctor(report, fmt);
  return report.overall === 'FAIL' ? 1 : 0;
}

function cmdSecurity(args, root) {
  const fmtIdx = args.indexOf('--format');
  const fmt = fmtIdx >= 0 ? args[fmtIdx + 1] : 'human';
  const sec = runSecurityScan(root);
  if (fmt === 'json') console.log(JSON.stringify(sec, null, 2));
  else {
    console.log(`Security Scan: ${sec.status} (${sec.findings} findings)`);
    for (const [name, section] of Object.entries(sec.sections || {})) {
      console.log(`- ${name}: ${section.status} (${section.findings} findings)`);
    }
    for (const f of sec.details || []) console.log(`  - ${f.file || ''}${f.line ? ':' + f.line : ''} ${f.type || ''} ${f.id || ''}`.trim());
  }
  return sec.status === 'PASS' ? 0 : 1;
}

function cmdTestInfra(root) {
  const commands = detectCommands(root);
  const h = {
    H1: !!commands.tests,
    H2: !!commands.tests,
    H3: true,
    H4: !!commands.tests,
    H5: !!commands.coverage,
    H6: false,
  };
  const blockerPass = h.H1 && h.H2 && h.H4;
  const passCount = Object.values(h).filter(Boolean).length;
  const tier = !blockerPass || passCount <= 3 ? 0 : passCount < 6 ? 1 : 2;
  const data = { schema_version: '1.0', tier, checks: h, commands };
  writeJson(path.join(root, '.harness/infra-tier.json'), data);
  writeJson(path.join(root, '.harness/test-capability.json'), { schema_version: '1.0', commands });
  console.log(`Infra Tier: ${tier}`);
  return tier === 0 ? 1 : 0;
}

function cmdE2E(root) {
  const markers = [];
  const add = (file, meaning) => { if (exists(path.join(root, file))) markers.push({ file, meaning }); };
  add('docker-compose.yml', 'docker compose'); add('compose.yml', 'docker compose'); add('Dockerfile', 'docker build'); add('Makefile', 'make workflow');
  add('playwright.config.js', 'Playwright'); add('playwright.config.ts', 'Playwright'); add('cypress.config.js', 'Cypress'); add('cypress.config.ts', 'Cypress');
  add('.env.sample', 'environment sample'); add('.env.example', 'environment sample'); add('db/migrations', 'database migrations'); add('prisma/migrations', 'database migrations');
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg && pkg.scripts) {
    for (const k of Object.keys(pkg.scripts)) if (/e2e|test:e2e/.test(k)) markers.push({ file: `package.json#${k}`, meaning: 'npm e2e script' });
  }
  const md = ['# E2E Quickstart', '', '> Auto-generated by `shk e2e detect`.', '', '## Detected markers', ''];
  if (markers.length === 0) md.push('- none'); else for (const m of markers) md.push(`- ${m.file}: ${m.meaning}`);
  md.push('', '## Suggested next step', '', 'Replace this generated section with the first command sequence that actually passes in this project.', '');
  ensureDir(path.join(root, '.harness'));
  fs.writeFileSync(path.join(root, '.harness/e2e-quickstart.md'), md.join('\n'), 'utf8');
  console.log(`E2E markers: ${markers.length}`);
  return 0;
}

function expandProfile(name, map = loadManifest().profiles, seen = new Set()) {
  if (!map[name]) throw new Error(`unknown profile: ${name}`);
  const out = [];
  for (const item of map[name]) {
    if (map[item]) out.push(...expandProfile(item, map, seen));
    else if (!seen.has(item)) { seen.add(item); out.push(item); }
  }
  return out;
}

function buildInstallPlan(root, profile) {
  const manifest = loadManifest();
  const components = expandProfile(profile, manifest.profiles);
  const plan = [];
  for (const name of components) {
    const c = manifest.components && manifest.components[name] || {};
    if (name === 'codex-hooks' || c.kind === 'config') {
      const sourceSettings = exists(path.join(root, '.claude/settings.json'))
        ? '.claude/settings.json'
        : exists(path.join(root, 'templates/settings-json.tmpl'))
          ? 'templates/settings-json.tmpl'
          : '';
      const hasCodex = exists(path.join(root, '.codex/hooks.json'));
      plan.push({
        component: name,
        kind: c.kind || 'config',
        action: sourceSettings && !hasCodex ? 'add' : 'skip',
        reason: sourceSettings ? (hasCodex ? 'codex hooks already exist' : `codex hooks missing; source=${sourceSettings}`) : 'no Claude settings source',
        source: sourceSettings,
        target: '.codex/hooks.json',
      });
    } else if (c.script) {
      const src = path.join(KIT_ROOT, c.script);
      const dst = path.join(root, c.script);
      let action = 'skip';
      let reason = 'up-to-date';
      if (!exists(src)) { action = 'conflict'; reason = `source missing: ${c.script}`; }
      else if (!exists(dst)) { action = 'add'; reason = 'missing'; }
      else if (readText(src) !== readText(dst)) { action = 'update'; reason = 'content differs'; }
      plan.push({ component: name, kind: c.kind || 'file', action, reason, source: c.script, target: c.script });
    } else {
      plan.push({ component: name, kind: c.kind || 'virtual', action: 'skip', reason: 'virtual/manual component' });
    }
  }
  return plan;
}

function printInstallPlan(profile, plan, dryRun) {
  console.log(`${dryRun ? 'DRY-RUN ' : ''}profile=${profile}`);
  for (const label of ['add', 'update', 'skip', 'conflict']) {
    const items = plan.filter(p => p.action === label);
    console.log(`${label}: ${items.length}`);
    for (const p of items) console.log(`- ${p.component} (${p.kind}): ${p.reason}${p.target ? ` -> ${p.target}` : ''}`);
  }
}

function applyInstallPlan(root, plan, options = {}) {
  let applied = 0;
  for (const p of plan) {
    if (p.action === 'add' || (p.action === 'update' && options.force)) {
      if (p.component === 'codex-hooks') {
        if (!p.source || !p.target) continue;
        const input = path.join(root, p.source);
        const output = path.join(root, p.target);
        ensureDir(path.dirname(output));
        const res = spawnSync(process.execPath, [path.join(KIT_ROOT, 'scripts/generate-codex-hooks.js'), '--input', input, '--output', output], {
          cwd: root,
          encoding: 'utf8',
        });
        if (res.status !== 0) throw new Error(res.stderr || res.stdout || 'failed to generate Codex hooks');
        applied++;
        continue;
      }
      if (!p.source || !p.target) continue;
      const src = path.join(KIT_ROOT, p.source);
      const dst = path.join(root, p.target);
      ensureDir(path.dirname(dst));
      fs.copyFileSync(src, dst);
      applied++;
    }
  }
  return applied;
}

function cmdInstall(args, root, mode) {
  const idx = args.indexOf('--profile');
  const profile = idx >= 0 ? args[idx + 1] : 'core';
  const dry = args.includes('--dry-run');
  const force = args.includes('--force');
  const plan = buildInstallPlan(root, profile);
  printInstallPlan(profile, plan, dry);
  if (!dry) {
    const applied = applyInstallPlan(root, plan, { force: mode === 'repair' && force });
    console.log(`applied: ${applied}`);
    const conflicts = plan.filter(p => p.action === 'conflict' || (p.action === 'update' && !(mode === 'repair' && force)));
    if (conflicts.length > 0) console.log(`conflicts: ${conflicts.length} (use repair --force to overwrite update items)`);
  }
  return plan.some(p => p.action === 'conflict') ? 1 : 0;
}

function listSkills(root) {
  const dir = path.join(root, 'skills');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter(n => exists(path.join(dir, n, 'SKILL.md'))).sort();
}
function cmdSkills(args, root) {
  const sub = args[0];
  const skills = listSkills(root);
  if (sub === 'list') { skills.forEach(s => console.log(s)); return 0; }
  if (sub === 'explain') {
    const name = args[1];
    const file = path.join(root, 'skills', name || '', 'SKILL.md');
    if (!name || !exists(file)) { console.error(`skill not found: ${name || ''}`); return 1; }
    console.log(fs.readFileSync(file, 'utf8').split('\n').slice(0, 40).join('\n'));
    return 0;
  }
  usage(); return 1;
}
function cmdConsult(args) {
  const q = args.join(' ');
  const rec = [];
  if (/review|审查|PR/i.test(q)) rec.push('skill:auto-harness-qa', 'skill:auto-harness-review', 'profile:core');
  if (/泄漏|secret|security|安全/i.test(q)) rec.push('command:shk doctor', 'command:shk security scan', 'profile:full');
  if (/test|测试|准出|verify/i.test(q)) rec.push('command:shk verify --risk medium --write-evidence', 'verification:medium');
  if (/高风险|release|发布/i.test(q)) rec.push('skill:auto-harness-santa', 'command:shk verify --risk release --write-evidence', 'verification:release');
  console.log('Recommendations:');
  [...new Set(rec.length ? rec : ['skill:harness-start', 'command:shk verify --risk low --write-evidence', 'profile:minimal'])].forEach(x => console.log(`- ${x}`));
  return 0;
}
function cmdLane(args, root) {
  const sub = args[0];
  const lanesDir = path.join(root, '.claude/worktrees');
  if (sub === 'create') {
    const name = args[1];
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) { console.error('lane name must match [A-Za-z0-9._-]+'); return 1; }
    const dst = path.join(lanesDir, name);
    if (exists(dst)) { console.error(`lane already exists: ${rel(root, dst)}`); return 1; }
    ensureDir(lanesDir);
    const branch = `shk/lane-${name}`;
    const res = spawnSync('git', ['worktree', 'add', '-b', branch, dst, 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (res.status !== 0) { process.stderr.write(res.stderr || res.stdout || 'git worktree add failed\n'); return res.status || 1; }
    ensureDir(path.join(dst, '.harness'));
    console.log(`created lane ${name}: ${rel(root, dst)} (${branch})`);
    return 0;
  }
  if (sub === 'list') {
    if (!exists(lanesDir)) { console.log('No lanes'); return 0; }
    fs.readdirSync(lanesDir).forEach(n => console.log(n)); return 0;
  }
  if (sub === 'compare') {
    if (!exists(lanesDir)) { console.log('No lanes'); return 0; }
    const rows = fs.readdirSync(lanesDir).map(n => {
      const laneRoot = path.join(lanesDir, n);
      const e = readJson(path.join(laneRoot, '.harness/verify-evidence.json'));
      const diff = spawnSync('git', ['-C', laneRoot, 'diff', '--stat'], { encoding: 'utf8' });
      const files = String(diff.stdout || '').split('\n').filter(l => /\|/.test(l)).length;
      return { lane: n, overall: e && e.overall || 'NO_EVIDENCE', risk: e && e.risk || '-', files };
    });
    console.log('| Lane | Evidence | Risk | Diff files |');
    console.log('|---|---|---|---|');
    rows.forEach(r => console.log(`| ${r.lane} | ${r.overall} | ${r.risk} | ${r.files} |`));
    const ready = rows.filter(r => r.overall === 'READY').sort((a, b) => a.files - b.files)[0];
    if (ready) console.log(`Recommended promote lane: ${ready.lane}`);
    return 0;
  }
  console.error('lane supports create|list|compare'); return 1;
}
function cmdBenchmark(args) {
  const planIdx = args.indexOf('--plan');
  console.log(`Benchmark plan: ${planIdx >= 0 ? args[planIdx + 1] : '(missing)'}`);
  console.log('MVP records benchmark intent; use worktree lanes for execution.');
  return planIdx >= 0 ? 0 : 1;
}
function cmdQa(root) {
  const e = latestEvidence(root);
  if (!e) { console.error('No .harness/verify-evidence.json'); return 1; }
  console.log(evidenceMarkdown(e)); return e.overall === 'READY' ? 0 : 1;
}
function cmdStatus(root) { return cmdDoctor(['--format', 'human'], root); }

function main() {
  const args = process.argv.slice(2);
  const root = projectRoot();
  try {
    const [cmd, sub, ...rest] = args;
    if (!cmd || cmd === '--help' || cmd === '-h') { usage(); return 0; }
    if (cmd === 'verify') return cmdVerify(args.slice(1), root);
    if (cmd === 'doctor') return cmdDoctor(args.slice(1), root);
    if (cmd === 'status') return cmdStatus(root);
    if (cmd === 'security' && sub === 'scan') return cmdSecurity(rest, root);
    if (cmd === 'test-infra' && sub === 'assess') return cmdTestInfra(root);
    if (cmd === 'e2e' && sub === 'detect') return cmdE2E(root);
    if (cmd === 'qa' && sub === 'report') return cmdQa(root);
    if (cmd === 'install') return cmdInstall(args.slice(1), root, 'install');
    if (cmd === 'repair') return cmdInstall(args.slice(1), root, 'repair');
    if (cmd === 'skills') return cmdSkills(args.slice(1), root);
    if (cmd === 'consult') return cmdConsult(args.slice(1));
    if (cmd === 'lane') return cmdLane(args.slice(1), root);
    if (cmd === 'benchmark' && sub === 'run') return cmdBenchmark(rest);
    usage(); return 1;
  } catch (err) {
    console.error(`[shk] ${err.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());
module.exports = {
  projectRoot,
  makeEvidence,
  doctorReport,
  expandProfile,
  runSecurityScan,
  runSecretScan,
  runPublicLeakScan,
  runConfigRiskScan,
  codexEntryBannerCheck,
  buildInstallPlan,
};

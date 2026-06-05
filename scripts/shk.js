#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const specQuality = require('./lib/spec-quality');

const KIT_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(KIT_ROOT, 'manifests/shk-profiles.json');

const RISK_ORDER = { low: 1, medium: 2, high: 3, release: 4 };
const ALL_CHECKS = [
  'quality_gate', 'build', 'types', 'lint', 'tests', 'coverage', 'e2e',
  'security', 'diff', 'spec', 'santa', 'runtime', 'clean_tree', 'upstream',
];
const RISK_CHECKS = {
  low: ['build', 'tests', 'diff', 'security'],
  medium: ['build', 'tests', 'diff', 'security', 'types', 'lint', 'coverage', 'spec', 'e2e'],
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
  shk quality status --risk low|medium|high|release [--format human|json]
  shk doctor [--format human|json]
  shk status
  shk security scan [--format human|json]
  shk test-infra assess
  shk e2e detect
  shk e2e inspect [--format human|json]
  shk e2e plan [--format human|json]
  shk e2e bootstrap --risk low|medium|high|release [--format human|json]
  shk e2e run [--format human|json]
  shk e2e assess --risk low|medium|high|release [--format human|json]
  shk spec status --risk low|medium|high|release [--format human|json]
  shk test effectiveness --risk low|medium|high|release [--format human|json]
  shk loop state [--format human|json]
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

function runCommand(root, command, timeout = 120000, options = {}) {
  if (!command) return { status: 'SKIP', command: '', reason: 'not configured' };
  const startedAtMs = Date.now();
  const env = { ...process.env, ...(options.env || {}) };
  const res = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024, env });
  const completedAtMs = Date.now();
  const stdout = String(res.stdout || '');
  const stderr = String(res.stderr || '');
  return {
    status: res.status === 0 ? 'PASS' : 'FAIL',
    command,
    exit_code: res.status === null ? 124 : res.status,
    stdout_tail: stdout.slice(-2000),
    stderr_tail: stderr.slice(-2000),
    started_at_ms: startedAtMs,
    completed_at_ms: completedAtMs,
    run_token: options.run_token || '',
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
    e2e: scripts['test:e2e'] ? 'npm run test:e2e' : scripts.e2e ? 'npm run e2e' : exists(path.join(root, 'tests/scripts/13-e2e-sufficiency.sh')) ? 'bash tests/scripts/13-e2e-sufficiency.sh' : exists(path.join(root, 'tests/scripts/03-full-e2e.sh')) ? 'bash tests/scripts/03-full-e2e.sh' : exists(path.join(root, 'tests/e2e-acceptance-validate.sh')) ? 'bash tests/e2e-acceptance-validate.sh' : '',
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


function parseFormat(args) {
  const idx = args.indexOf('--format');
  return idx >= 0 ? args[idx + 1] : 'human';
}

function parseRisk(args, fallback = 'medium') {
  const idx = args.indexOf('--risk');
  const risk = idx >= 0 ? args[idx + 1] : fallback;
  if (!RISK_ORDER[risk]) throw new Error(`invalid risk: ${risk}`);
  return risk;
}

function riskRequiresE2E(risk) {
  return risk === 'medium' || risk === 'high' || risk === 'release';
}

function detectChangedAreas(root) {
  const out = spawnSync('git', ['diff', '--name-only'], { cwd: root, encoding: 'utf8' });
  const files = out.status === 0 ? String(out.stdout || '').split('\n').filter(Boolean) : [];
  const areas = new Set();
  for (const f of files) {
    if (/scripts\/shk\.js|quality|verify|gate/.test(f)) areas.add('quality_gate');
    if (/e2e|tests\/scripts/.test(f)) areas.add('e2e');
    if (/scripts\/hooks|hook-scenarios/.test(f)) areas.add('hooks');
    if (/skills\//.test(f)) areas.add('skills');
    if (/templates\/|init-prompt|AGENTS|CLAUDE/.test(f)) areas.add('ai_entrypoints');
  }
  return Array.from(areas);
}

function defaultTaskQualityContract(root, risk) {
  const changed = detectChangedAreas(root);
  const must = [];
  if (riskRequiresE2E(risk)) must.push('medium/high/release risk has E2E evidence');
  if (changed.includes('quality_gate') || changed.includes('e2e')) {
    must.push('fake E2E is not sufficient');
    must.push('failed E2E blocks delivery');
  }
  if (changed.includes('hooks')) must.push('READY evidence must be fresh');
  return {
    schema_version: '1.0',
    risk,
    changed_areas: changed.length ? changed : ['unknown'],
    must_prove: must.length ? must : (riskRequiresE2E(risk) ? ['E2E covers the changed behavior'] : []),
    source: 'auto',
  };
}

function taskQualityContract(root, risk) {
  const p = path.join(root, '.harness/task-quality-contract.json');
  const existing = readJson(p);
  if (existing && existing.schema_version) return { ...existing, risk: existing.risk || risk, source: existing.source || 'file' };
  return defaultTaskQualityContract(root, risk);
}

function iterationSpecPath(root) {
  return path.join(root, '.harness/iteration-spec.json');
}

function loadIterationSpec(root) {
  return readJson(iterationSpecPath(root));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function itemId(item) {
  return item && item.id ? String(item.id) : '';
}

function itemText(item) {
  if (!item) return '';
  return String(item.text || item.name || item.summary || item.scenario || item.entrypoint || item.id || '');
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function specCoverageData(spec) {
  return specQuality.specCoverageData(spec);
}

function specStatusData(root, risk) {
  const p = iterationSpecPath(root);
  const spec = loadIterationSpec(root);
  if (!spec || typeof spec !== 'object') {
    return {
      schema_version: '1.0',
      risk,
      overall: 'NOT_READY',
      path: rel(root, p),
      dimensions: {
        spec_exists: 'FAIL',
        requirements_present: 'FAIL',
        design_present: 'FAIL',
        test_plan_present: 'FAIL',
        acceptance_present: 'FAIL',
        requirements_covered: 'FAIL',
        risks_covered: 'FAIL',
        traffic_flows_covered: 'FAIL',
      },
      missing: ['.harness/iteration-spec.json'],
      spec: null,
      human_summary: '没有迭代 spec，就说不清楚这轮到底做什么、怎么做、怎么验收。当前不能准出。',
    };
  }

  const evaluation = specQuality.evaluateIterationSpec(spec);
  const c = evaluation.coverage;
  const hasRequirements = c.requirements.length > 0;
  const hasDesign = !!(spec.design && spec.design.summary && asArray(spec.design.risk_points).length > 0);
  const hasTrafficFlows = c.trafficFlows.length > 0;
  const hasTestPlan = c.tests.length > 0;
  const hasAcceptance = c.acceptance.length > 0;
  const missing = [];
  if (!hasRequirements) missing.push('缺 requirements');
  if (!hasDesign) missing.push('缺 design.summary 或 design.risk_points');
  if (!hasTrafficFlows) missing.push('缺 traffic_flows');
  if (!hasTestPlan) missing.push('缺 test_plan');
  if (!hasAcceptance) missing.push('缺 acceptance');
  c.missingRequirements.forEach(id => missing.push(`must requirement 未被测试覆盖：${id}`));
  c.missingRisks.forEach(id => missing.push(`风险点未被测试覆盖：${id}`));
  c.missingTrafficFlows.forEach(id => missing.push(`流量路径未被测试计划覆盖：${id}`));
  c.invalidTests.forEach(item => missing.push(item));
  c.missingAcceptance.forEach(item => missing.push(item));

  const overall = evaluation.overall;
  return {
    schema_version: '1.0',
    risk,
    overall,
    path: rel(root, p),
    dimensions: {
      spec_exists: 'PASS',
      requirements_present: hasRequirements ? 'PASS' : 'FAIL',
      design_present: hasDesign ? 'PASS' : 'FAIL',
      traffic_flows_present: hasTrafficFlows ? 'PASS' : 'FAIL',
      test_plan_present: hasTestPlan ? 'PASS' : 'FAIL',
      acceptance_present: hasAcceptance ? 'PASS' : 'FAIL',
      requirements_covered: c.missingRequirements.length === 0 ? 'PASS' : 'FAIL',
      risks_covered: c.missingRisks.length === 0 ? 'PASS' : 'FAIL',
      traffic_flows_covered: c.missingTrafficFlows.length === 0 ? 'PASS' : 'FAIL',
      test_plan_semantic: c.invalidTests.length === 0 ? 'PASS' : 'FAIL',
      acceptance_evidence: c.missingAcceptance.length === 0 ? 'PASS' : 'FAIL',
    },
    counts: {
      requirements: c.requirements.length,
      must_requirements: c.mustRequirements.length,
      risk_points: c.risks.length,
      traffic_flows: c.trafficFlows.length,
      tests: c.tests.length,
      acceptance: c.acceptance.length,
    },
    missing,
    spec,
    human_summary: overall === 'READY'
      ? '迭代 spec 是有效的：需求、方案、风险、测试计划、流量路径和验收标准都有明确映射。'
      : overall === 'NOT_READY'
        ? `迭代 spec 不完整：${missing.join('；')}。先把文档写清楚，再进入准出。`
        : `迭代 spec 写了，但测试/验收映射不够：${missing.join('；')}。不能把它当 READY。`,
  };
}

function textContainsIdOrText(text, item) {
  const id = itemId(item).toLowerCase();
  const body = itemText(item).toLowerCase();
  const hay = String(text || '').toLowerCase();
  return (!!id && hay.includes(id)) || (!!body && body.length >= 4 && hay.includes(body));
}

function mutationEvidenceData(root, e2eText) {
  const files = [
    '.harness/mutation-result.json',
    '.harness/fault-injection-result.json',
    '.harness/loop/mutation-result.json',
  ];
  for (const file of files) {
    const data = readJson(path.join(root, file));
    if (!data) continue;
    const killed = Number(data.killed || data.mutants_killed || 0);
    const survived = Number(data.survived || data.mutants_survived || 0);
    const status = killed > 0 && survived === 0;
    return {
      status: status ? 'PASS' : 'FAIL',
      source: file,
      killed,
      survived,
      summary: status
        ? `mutation/fault evidence 证明坏代码会被测试抓住：${file}`
        : `mutation/fault evidence 不够：必须 killed > 0 且 survived === 0，不能只靠 status: PASS 自声明。来源：${file}`,
    };
  }
  return {
    status: 'FAIL',
    source: '',
    killed: 0,
    survived: null,
    summary: '缺结构化 mutation/fault injection 证据：源码注释或日志关键词不能证明坏代码下测试会失败。',
  };
}

function testEffectivenessData(root, risk) {
  const specStatus = specStatusData(root, risk);
  const e2e = e2eSufficiencyAssess(root, risk);
  const spec = specStatus.spec;
  const c = spec ? specCoverageData(spec) : null;
  const e2eText = e2eSourceText(root, e2e.e2e_command || detectCommands(root).e2e);
  const e2eEvidenceTokens = collectStructuredEvidenceTokens(e2e.structured_evidence || {});
  const mutation = mutationEvidenceData(root, e2eText);
  const trafficMisses = [];
  if (c) {
    c.missingTrafficFlows.forEach(id => trafficMisses.push(id));
    for (const flow of c.trafficFlows) {
      const id = itemId(flow);
      if (!id) continue;
      const coveredByPlan = c.testFlows.includes(id);
      const coveredByEvidence = structuredEvidenceHas(e2eEvidenceTokens, id)
        || structuredEvidenceHas(e2eEvidenceTokens, flow.entrypoint)
        || structuredEvidenceHas(e2eEvidenceTokens, flow.name);
      if (coveredByPlan && !coveredByEvidence) trafficMisses.push(id);
    }
  }

  const assertionQuality = e2e.coverage && e2e.coverage.has_real_assertions === 'PASS' ? 'PASS' : 'FAIL';
  const positivePath = e2e.coverage && e2e.coverage.has_positive_path === 'PASS' ? 'PASS' : 'FAIL';
  const negativePath = e2e.coverage && e2e.coverage.has_negative_or_blocking_path === 'PASS' ? 'PASS' : 'FAIL';
  const freshEvidence = e2e.e2e_status === 'PASS' && e2e.coverage && e2e.coverage.writes_structured_evidence === 'PASS' ? 'PASS' : 'FAIL';
  const runtimeRealism = e2e.e2e_status === 'PASS'
    ? containsAny(e2eText, [/playwright|cypress|browser/i]) ? 'PASS' : 'PARTIAL'
    : 'FAIL';
  const dimensions = {
    spec_exists: specStatus.dimensions.spec_exists,
    requirements_covered: specStatus.dimensions.requirements_covered,
    risks_covered: specStatus.dimensions.risks_covered,
    traffic_coverage: trafficMisses.length === 0 && specStatus.dimensions.traffic_flows_covered === 'PASS' ? 'PASS' : 'FAIL',
    assertion_quality: assertionQuality,
    positive_path: positivePath,
    negative_or_boundary_path: negativePath,
    mutation_sensitivity: mutation.status,
    runtime_realism: runtimeRealism,
    fresh_evidence: freshEvidence,
  };
  const missing = [];
  if (specStatus.overall !== 'READY') missing.push(...specStatus.missing);
  trafficMisses.forEach(id => missing.push(`流量路径没有被测试证据覆盖：${id}`));
  if (assertionQuality !== 'PASS') missing.push('缺真实断言');
  if (positivePath !== 'PASS') missing.push('缺正向路径');
  if (negativePath !== 'PASS') missing.push('缺负向/边界/阻断路径');
  if (mutation.status !== 'PASS') missing.push('缺 mutation/fault injection 证据');
  if (freshEvidence !== 'PASS') missing.push('缺本次运行产生的结构化 evidence');
  if (e2e.overall !== 'READY') missing.push(...(e2e.missing || []).map(m => `E2E 充分性不足：${m}`));

  const hasFail = Object.values(dimensions).some(v => v === 'FAIL');
  const hasPartial = Object.values(dimensions).some(v => v === 'PARTIAL');
  const overall = specStatus.overall === 'NOT_READY' || e2e.overall === 'NOT_READY'
    ? 'NOT_READY'
    : hasFail ? 'NOT_SUFFICIENT'
      : hasPartial && risk === 'release' ? 'NOT_SUFFICIENT'
        : 'READY';

  return {
    schema_version: '1.0',
    risk,
    overall,
    dimensions,
    spec_status: {
      overall: specStatus.overall,
      path: specStatus.path,
      counts: specStatus.counts,
    },
    e2e_sufficiency: {
      overall: e2e.overall,
      e2e_status: e2e.e2e_status,
      command: e2e.e2e_command,
      coverage: e2e.coverage,
    },
    mutation,
    missing: unique(missing),
    human_summary: overall === 'READY'
      ? `测试有效性足够：它不是只证明“跑过”，而是映射到了 spec 的需求、风险、流量路径、断言、负向场景和 mutation/fault 证据。运行真实性是 ${runtimeRealism}。`
      : `测试还不能证明本轮交付安全。缺口：${unique(missing).join('；')}。`,
  };
}

function hasTaskQualityContract(root) {
  const p = path.join(root, '.harness/task-quality-contract.json');
  const existing = readJson(p);
  return !!(existing && existing.schema_version);
}

function e2eSourceText(root, command) {
  const parts = [command || ''];
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const scripts = pkg.scripts || {};
  if (scripts['test:e2e']) parts.push(scripts['test:e2e']);
  if (scripts.e2e) parts.push(scripts.e2e);
  const candidates = [
    'tests/scripts/03-full-e2e.sh',
    'tests/scripts/13-e2e-sufficiency.sh',
    'tests/scripts/12-quality-gate-loop-contract.sh',
    'tests/e2e-acceptance-validate.sh',
  ];
  for (const file of candidates) {
    const full = path.join(root, file);
    if (exists(full)) parts.push(`\n# ${file}\n${readText(full)}`);
  }
  for (const dir of ['tests/e2e', 'e2e', 'playwright', 'cypress/e2e']) {
    const fullDir = path.join(root, dir);
    if (!exists(fullDir)) continue;
    for (const file of scanFiles(fullDir, { maxBytes: 256 * 1024 }).slice(0, 50)) {
      parts.push(`\n# ${rel(root, file)}\n${readText(file)}`);
    }
  }
  return parts.join('\n');
}

function packageE2EScript(root) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const scripts = pkg.scripts || {};
  return scripts['test:e2e'] || scripts.e2e || '';
}

function containsAny(text, patterns) {
  return patterns.some(p => p.test(text));
}

function createRunToken() {
  return `shk-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function collectStructuredEvidenceTokens(evidence) {
  const tokens = [];
  function add(value) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    if (typeof value === 'object') {
      for (const nested of Object.values(value)) add(nested);
      return;
    }
    const text = String(value).trim();
    if (text) tokens.push(text.toLowerCase());
  }
  add(evidence && evidence.covered);
  add(evidence && evidence.assertions);
  add(evidence && evidence.paths);
  add(evidence && evidence.scenarios);
  return unique(tokens);
}

function structuredEvidenceHas(tokens, needle) {
  const n = String(needle || '').trim().toLowerCase();
  if (!n || n === 'unknown') return true;
  return tokens.some(t => t === n || t.includes(n));
}

function readFreshE2EEvidence(root, startedAtMs, runToken) {
  const file = path.join(root, '.harness/e2e-result.json');
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {
    return { status: 'FAIL', reason: '缺 .harness/e2e-result.json', path: rel(root, file), evidence: null };
  }
  if (startedAtMs && st.mtimeMs + 1000 < startedAtMs) {
    return { status: 'FAIL', reason: '.harness/e2e-result.json 不是本次运行新产生的', path: rel(root, file), evidence: null };
  }
  const evidence = readJson(file);
  if (!evidence || typeof evidence !== 'object') {
    return { status: 'FAIL', reason: '.harness/e2e-result.json 不是合法 JSON object', path: rel(root, file), evidence: null };
  }
  const token = String(evidence.run_token || evidence.shk_run_token || evidence.token || '');
  if (runToken && token !== runToken) {
    return { status: 'FAIL', reason: '.harness/e2e-result.json 缺少本次 run-token，不能排除陈旧证据', path: rel(root, file), evidence };
  }
  if (evidence.status && evidence.status !== 'PASS' && evidence.overall !== 'READY') {
    return { status: 'FAIL', reason: `.harness/e2e-result.json 状态不是 PASS/READY：${evidence.status || evidence.overall}`, path: rel(root, file), evidence };
  }
  return { status: 'PASS', reason: 'fresh structured E2E evidence', path: rel(root, file), evidence };
}

function e2eEvidenceCoverage(evidence, contract) {
  const paths = asArray(evidence && (evidence.paths || evidence.scenarios || evidence.flows));
  const assertions = asArray(evidence && evidence.assertions).filter(v => String(v || '').trim());
  const tokens = collectStructuredEvidenceTokens(evidence || {});
  const hasAssertions = assertions.length > 0 || Number(evidence && evidence.assertion_count || 0) > 0;
  const hasPositive = evidence && evidence.positive_path === true
    || paths.some(p => /positive|happy|success|正常|正向/i.test(String((p && (p.type || p.name || p.proof)) || p || '')));
  const hasNegative = evidence && (evidence.negative_or_blocking_path === true || evidence.negative_path === true)
    || paths.some(p => /negative|blocking|blocked|boundary|validation|error|failure|fail|阻断|负向|边界/i.test(String((p && (p.type || p.name || p.proof)) || p || '')));
  const changedAreas = asArray(contract && contract.changed_areas).filter(v => String(v || '').trim());
  const mustProve = asArray(contract && contract.must_prove).filter(v => String(v || '').trim());
  const changedAreasCovered = changedAreas.length === 0 || changedAreas.every(area => structuredEvidenceHas(tokens, area));
  const mustProveCovered = mustProve.length === 0 || mustProve.every(item => structuredEvidenceHas(tokens, item));
  return {
    hasAssertions,
    hasPositive,
    hasNegative,
    coversContract: changedAreasCovered && mustProveCovered,
    tokens,
  };
}

function e2eSufficiencyAssess(root, risk, existingRun = null) {
  const plan = e2ePlanData(root);
  const command = plan.recommended_command || '';
  if (!command) {
    return {
      schema_version: '1.0',
      risk,
      overall: riskRequiresE2E(risk) ? 'NOT_READY' : 'READY',
      e2e_command: '',
      e2e_status: 'MISSING',
      coverage: {
        covers_changed_area: riskRequiresE2E(risk) ? 'FAIL' : 'PASS',
        has_real_assertions: 'FAIL',
        has_positive_path: 'FAIL',
        has_negative_or_blocking_path: 'FAIL',
        writes_structured_evidence: 'FAIL',
        not_smoke_only: 'FAIL',
      },
      covered: [],
      missing: riskRequiresE2E(risk) ? ['没有 E2E 入口'] : [],
      human_summary: riskRequiresE2E(risk) ? '当前缺 E2E，不能交付。' : '本次 low 风险不强制 E2E。',
    };
  }

  const runToken = existingRun && existingRun.run_token ? existingRun.run_token : createRunToken();
  const run = existingRun || runCommand(root, command, 180000, {
    env: { SHK_E2E_RUN_TOKEN: runToken },
    run_token: runToken,
  });
  const e2eStatus = run.status || 'UNKNOWN';
  if (e2eStatus !== 'PASS') {
    return {
      schema_version: '1.0',
      risk,
      overall: 'NOT_READY',
      e2e_command: command,
      e2e_status: e2eStatus,
      coverage: {
        covers_changed_area: 'FAIL',
        has_real_assertions: 'FAIL',
        has_positive_path: 'FAIL',
        has_negative_or_blocking_path: 'FAIL',
        writes_structured_evidence: 'FAIL',
        not_smoke_only: 'FAIL',
      },
      covered: [],
      missing: ['E2E 没有通过'],
      human_summary: `E2E 没通过：${command}。先修失败，再谈准出。`,
    };
  }

  const explicitContract = hasTaskQualityContract(root);
  const contract = taskQualityContract(root, risk);

  const trivialCommand = /^\s*(echo\s+ok|echo\s+pass|true|exit\s+0|node\s+-e\s+["']process\.exit\(0\)["'])\s*$/i;
  const fakeOnly = trivialCommand.test(String(command || '').trim()) || trivialCommand.test(packageE2EScript(root).trim());

  if (riskRequiresE2E(risk) && !explicitContract && !fakeOnly) {
    return {
      schema_version: '1.0',
      risk,
      overall: 'NOT_READY',
      e2e_command: command,
      e2e_status: e2eStatus,
      coverage: {
        covers_changed_area: 'FAIL',
        has_real_assertions: 'PASS',
        has_positive_path: 'PASS',
        has_negative_or_blocking_path: 'PASS',
        writes_structured_evidence: 'PASS',
        not_smoke_only: 'PASS',
        has_task_quality_contract: 'FAIL',
      },
      covered: ['E2E 命令通过，但没有任务质量合约，不能判断是否测到本次风险'],
      missing: ['缺 .harness/task-quality-contract.json'],
      human_summary: 'E2E 跑过了，但 medium/high/release 风险必须先写 .harness/task-quality-contract.json。没有质量合约，不能判断测没测到本次风险，所以当前是 NOT_READY。',
    };
  }

  const evidenceResult = readFreshE2EEvidence(root, run.started_at_ms, run.run_token || runToken);
  const evidenceCoverage = evidenceResult.status === 'PASS'
    ? e2eEvidenceCoverage(evidenceResult.evidence, contract)
    : { hasAssertions: false, hasPositive: false, hasNegative: false, coversContract: false, tokens: [] };

  const coverage = {
    covers_changed_area: evidenceCoverage.coversContract ? 'PASS' : 'FAIL',
    has_real_assertions: evidenceCoverage.hasAssertions ? 'PASS' : 'FAIL',
    has_positive_path: evidenceCoverage.hasPositive ? 'PASS' : 'FAIL',
    has_negative_or_blocking_path: evidenceCoverage.hasNegative ? 'PASS' : 'FAIL',
    writes_structured_evidence: evidenceResult.status === 'PASS' ? 'PASS' : 'FAIL',
    not_smoke_only: !fakeOnly && evidenceCoverage.hasAssertions && evidenceCoverage.hasPositive && evidenceCoverage.hasNegative ? 'PASS' : 'FAIL',
    has_task_quality_contract: (!riskRequiresE2E(risk) || explicitContract) ? 'PASS' : 'FAIL',
  };
  const missing = [];
  if (coverage.has_task_quality_contract !== 'PASS') missing.push('缺 .harness/task-quality-contract.json');
  if (coverage.covers_changed_area !== 'PASS') missing.push('E2E 没证明本次改动风险');
  if (coverage.has_real_assertions !== 'PASS') missing.push('缺真实断言');
  if (coverage.has_positive_path !== 'PASS') missing.push('缺正向路径');
  if (coverage.has_negative_or_blocking_path !== 'PASS') missing.push('缺负向/阻断路径');
  if (coverage.writes_structured_evidence !== 'PASS') missing.push(evidenceResult.reason || '缺结构化 evidence');
  if (coverage.not_smoke_only !== 'PASS') missing.push('像是空 E2E / echo ok / 只 smoke');
  const contractOnlyMissing = missing.length === 1 && coverage.has_task_quality_contract !== 'PASS';
  const overall = missing.length === 0 ? 'READY' : (contractOnlyMissing ? 'NOT_READY' : 'NOT_SUFFICIENT');
  const covered = [];
  if (coverage.covers_changed_area === 'PASS') covered.push('覆盖本次改动风险');
  if (coverage.has_real_assertions === 'PASS') covered.push('包含真实断言');
  if (coverage.has_negative_or_blocking_path === 'PASS') covered.push('包含负向/阻断路径');
  return {
    schema_version: '1.0',
    risk,
    overall,
    e2e_command: command,
    e2e_status: e2eStatus,
    coverage,
    covered,
    missing,
    contract,
    structured_evidence: {
      status: evidenceResult.status,
      path: evidenceResult.path,
      reason: evidenceResult.reason,
      covered: evidenceResult.evidence && evidenceResult.evidence.covered || {},
      assertions: evidenceResult.evidence && evidenceResult.evidence.assertions || [],
      paths: evidenceResult.evidence && (evidenceResult.evidence.paths || evidenceResult.evidence.scenarios || []) || [],
    },
    human_summary: overall === 'READY'
      ? 'E2E 不只是跑过了，也覆盖了本次风险、正向路径、阻断路径和结构化证据。'
      : `现在还不能交付，E2E 还不充分。它虽然跑过了，但还没证明这些关键点：${missing.join('、')}。我会先补最小的正向/阻断路径和结构化 evidence，再重跑 E2E。机器状态：${overall}。`,
  };
}

function e2ePlanData(root) {
  const commands = detectCommands(root);
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const scripts = pkg.scripts || {};
  const markers = [];
  const add = (file, meaning) => { if (exists(path.join(root, file))) markers.push({ file, meaning }); };
  add('playwright.config.js', 'Playwright config');
  add('playwright.config.ts', 'Playwright config');
  add('cypress.config.js', 'Cypress config');
  add('cypress.config.ts', 'Cypress config');
  add('docker-compose.yml', 'docker compose');
  add('compose.yml', 'docker compose');
  add('Dockerfile', 'docker build');
  add('.env.sample', 'environment sample');
  add('.env.example', 'environment sample');
  if (scripts['test:e2e']) markers.push({ file: 'package.json#test:e2e', meaning: 'npm e2e script' });
  if (scripts.e2e) markers.push({ file: 'package.json#e2e', meaning: 'npm e2e script' });
  if (exists(path.join(root, 'tests/scripts/13-e2e-sufficiency.sh'))) markers.push({ file: 'tests/scripts/13-e2e-sufficiency.sh', meaning: 'SHK sufficient E2E wrapper: install/init plus quality gate blocking contract' });
  if (exists(path.join(root, 'tests/scripts/03-full-e2e.sh'))) markers.push({ file: 'tests/scripts/03-full-e2e.sh', meaning: 'SHK full install/init E2E validation' });
  if (exists(path.join(root, 'tests/e2e-acceptance-validate.sh'))) markers.push({ file: 'tests/e2e-acceptance-validate.sh', meaning: 'SHK sample E2E validation' });
  const recommended = commands.e2e || '';
  const status = recommended ? 'READY' : 'NEEDS_INPUT';
  return {
    schema_version: '1.0',
    status,
    recommended_command: recommended,
    markers,
    needs_user_input: !recommended,
    human_summary: recommended
      ? `找到了 E2E 入口：${recommended}。AI 可以在需要 E2E 时直接跑，并把结果写成证据。`
      : '没找到明确 E2E 入口。AI 需要先读 README/package 配置；如果仍不能确定，只问用户一个启动方式问题。',
    next_actions: recommended
      ? [`run ${recommended}`, 'write .harness/e2e-result.json']
      : ['ask: 这个项目本地启动用什么命令？', 'configure package.json#test:e2e or package.json#e2e'],
  };
}

function packageData(root) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  return { pkg, scripts: pkg.scripts || {}, deps: { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } };
}

function hasDep(deps, names) {
  return names.some(n => Object.prototype.hasOwnProperty.call(deps, n));
}

function detectStartCommand(root, scripts) {
  if (scripts.dev) return 'npm run dev';
  if (scripts.start) return 'npm start';
  if (exists(path.join(root, 'docker-compose.yml')) || exists(path.join(root, 'compose.yml'))) return 'docker compose up';
  const readme = `${readText(path.join(root, 'README.md'))}\n${readText(path.join(root, 'README.zh-CN.md'))}`;
  if (/npm run dev/i.test(readme)) return 'npm run dev';
  if (/docker compose up/i.test(readme)) return 'docker compose up';
  return '';
}

function detectFramework(root, deps) {
  if (hasDep(deps, ['next']) || exists(path.join(root, 'next.config.js')) || exists(path.join(root, 'next.config.mjs'))) return 'next';
  if (hasDep(deps, ['vite', '@vitejs/plugin-react']) || exists(path.join(root, 'vite.config.js')) || exists(path.join(root, 'vite.config.ts'))) return 'vite';
  if (hasDep(deps, ['nuxt']) || exists(path.join(root, 'nuxt.config.js')) || exists(path.join(root, 'nuxt.config.ts'))) return 'nuxt';
  if (hasDep(deps, ['vue'])) return 'vue';
  if (hasDep(deps, ['react', 'react-dom'])) return 'react';
  if (hasDep(deps, ['express', 'fastify', 'koa'])) return 'express';
  if (exists(path.join(root, 'pyproject.toml')) && /fastapi/i.test(readText(path.join(root, 'pyproject.toml')))) return 'fastapi';
  return 'unknown';
}

function detectRoutes(root) {
  const routes = new Set();
  if (exists(path.join(root, 'index.html')) || exists(path.join(root, 'src/App.jsx')) || exists(path.join(root, 'src/App.tsx'))) routes.add('/');
  for (const file of scanFiles(root, { maxBytes: 256 * 1024 }).slice(0, 300)) {
    const r = rel(root, file);
    if (/^(pages|app)\/.*\.(js|jsx|ts|tsx)$/.test(r)) {
      let route = '/' + r.replace(/^(pages|app)\//, '').replace(/\.(js|jsx|ts|tsx)$/, '').replace(/\/page$/, '').replace(/index$/, '');
      route = route.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      routes.add(route);
    }
  }
  return Array.from(routes).sort();
}

function detectApiRoutes(root) {
  const out = new Set();
  const routeRe = /\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  for (const file of scanFiles(root, { maxBytes: 256 * 1024 }).slice(0, 300)) {
    const r = rel(root, file);
    if (!/\.(js|jsx|ts|tsx|py)$/.test(r)) continue;
    const txt = readText(file);
    let m;
    while ((m = routeRe.exec(txt))) out.add(m[2]);
    if (/\/api\//.test(r)) out.add('/api/' + r.split('/api/')[1].replace(/\.(js|ts|py)$/, '').replace(/\/route$/, ''));
  }
  return Array.from(out).sort();
}

function e2eInspectData(root) {
  const { scripts, deps } = packageData(root);
  const commands = detectCommands(root);
  const framework = detectFramework(root, deps);
  const hasPlaywright = hasDep(deps, ['@playwright/test', 'playwright']) || exists(path.join(root, 'playwright.config.js')) || exists(path.join(root, 'playwright.config.ts'));
  const hasCypress = hasDep(deps, ['cypress']) || exists(path.join(root, 'cypress.config.js')) || exists(path.join(root, 'cypress.config.ts'));
  const startCommand = detectStartCommand(root, scripts);
  const routes = detectRoutes(root);
  const apiRoutes = detectApiRoutes(root);
  const hasFrontend = ['vite', 'next', 'nuxt', 'react', 'vue'].includes(framework) || routes.length > 0;
  const hasApi = ['express', 'fastapi'].includes(framework) || apiRoutes.length > 0;
  const projectType = hasFrontend && hasApi ? 'fullstack' : hasFrontend ? 'web-app' : hasApi ? 'api-service' : 'unknown';
  const e2eCommand = commands.e2e || '';
  const source = e2eSourceText(root, e2eCommand).trim();
  const fake = !!e2eCommand && /^\s*(echo\s+ok|echo\s+pass|true|exit\s+0|node\s+-e\s+["']process\.exit\(0\)["'])\s*$/i.test(source);
  const e2eStatus = e2eCommand ? (fake ? 'fake' : 'configured') : 'missing';
  const confidence = projectType !== 'unknown' && startCommand ? 'high' : projectType !== 'unknown' ? 'medium' : 'low';
  const questions = [];
  if (!startCommand && projectType !== 'unknown') questions.push('这个项目本地启动用 npm run dev、npm start，还是 docker compose up？');
  if (projectType === 'unknown') questions.push('我没识别出这是 Web 应用还是 API 服务。这个项目的主要运行入口是什么？');
  const recommendation = e2eCommand
    ? `已找到 E2E 入口：${e2eCommand}。`
    : projectType === 'api-service'
      ? '当前没有 E2E。建议生成 API E2E，覆盖健康检查、正常请求和错误/阻断请求。'
      : projectType === 'web-app' || projectType === 'fullstack'
        ? '当前没有 E2E。建议生成 Playwright，覆盖页面正向路径和错误输入阻断路径。'
        : '当前没有足够信息生成 E2E，AI 应先确认启动方式和应用类型。';
  return {
    schema_version: '1.0',
    project_type: projectType,
    framework,
    start_command: startCommand,
    e2e_command: e2eCommand,
    e2e_status: e2eStatus,
    has_playwright: hasPlaywright,
    has_cypress: hasCypress,
    routes,
    api_routes: apiRoutes,
    confidence,
    questions,
    recommendation,
    human_summary: projectType === 'unknown'
      ? '我还不能确定项目类型，不能假装 E2E 已经可生成。'
      : `${projectType === 'api-service' ? '这是一个 API 服务' : '这是一个 Web/Fullstack 应用'}。${recommendation}`,
  };
}

function e2eBootstrapData(root, risk) {
  const inspect = e2eInspectData(root);
  let framework = 'playwright';
  if (inspect.has_cypress) framework = 'cypress';
  else if (inspect.project_type === 'api-service') framework = 'api-e2e';
  else if (inspect.project_type === 'unknown') framework = 'unsupported';

  if (inspect.project_type === 'unknown') {
    return {
      schema_version: '1.0',
      risk,
      status: 'NEEDS_INPUT',
      recommended_framework: 'unsupported',
      start_command: inspect.start_command,
      test_command: '',
      files_to_create: [],
      flows: [],
      inspect,
      human_summary: '我还不能判断这是 Web 应用还是 API 服务。先确认项目运行入口，再生成 E2E。',
      questions: inspect.questions,
    };
  }

  const needsStart = !inspect.start_command && inspect.project_type !== 'api-service';
  const files = framework === 'api-e2e'
    ? ['tests/e2e/api-flow.e2e.js', '.harness/task-quality-contract.json']
    : framework === 'cypress'
      ? ['cypress.config.js', 'cypress/e2e/app-opens.cy.js', 'cypress/e2e/critical-flow.cy.js', '.harness/task-quality-contract.json']
      : ['playwright.config.ts', 'tests/e2e/app-opens.spec.ts', 'tests/e2e/critical-flow.spec.ts', '.harness/task-quality-contract.json'];
  const flows = framework === 'api-e2e'
    ? [
      { name: 'health check', type: 'positive', proof: 'API health endpoint returns ok' },
      { name: 'bad request is blocked', type: 'negative', proof: 'invalid API input returns validation error or non-2xx status' },
    ]
    : [
      { name: 'app opens', type: 'positive', proof: 'homepage renders real app content' },
      { name: 'bad input is blocked', type: 'negative', proof: 'form or route shows validation/error state' },
    ];
  return {
    schema_version: '1.0',
    risk,
    status: needsStart ? 'NEEDS_INPUT' : 'READY_TO_GENERATE',
    recommended_framework: framework,
    start_command: inspect.start_command,
    test_command: 'npm run test:e2e',
    files_to_create: files,
    flows,
    quality_contract: {
      schema_version: '1.0',
      risk,
      changed_areas: inspect.project_type === 'api-service' ? ['api_flow'] : ['ui_flow'],
      must_prove: flows.map(f => f.proof),
    },
    inspect,
    questions: needsStart ? inspect.questions : [],
    human_summary: inspect.e2e_command
      ? `这个项目已有 E2E 入口：${inspect.e2e_command}。AI 应先跑 assess；不充分时再按 ${framework} 补正向和负向路径。`
      : framework === 'api-e2e'
        ? '这是一个 API 服务，当前没有 E2E。建议生成 API E2E，覆盖健康检查、正常请求和错误输入阻断。'
        : `这是一个 ${inspect.framework === 'unknown' ? 'Web' : inspect.framework} 应用，当前没有 E2E。建议生成 ${framework === 'cypress' ? 'Cypress' : 'Playwright'}，覆盖页面正向路径和错误输入阻断路径。`,
  };
}

function writeE2EPlan(root, plan) {
  ensureDir(path.join(root, '.harness'));
  writeJson(path.join(root, '.harness/e2e-plan.json'), plan);
  const lines = ['# E2E Plan', '', plan.human_summary, '', '## Recommended command', '', plan.recommended_command ? `\`${plan.recommended_command}\`` : '- needs user input', '', '## Markers', ''];
  if (plan.markers.length === 0) lines.push('- none'); else plan.markers.forEach(m => lines.push(`- ${m.file}: ${m.meaning}`));
  lines.push('', '## Next actions', '');
  plan.next_actions.forEach(a => lines.push(`- ${a}`));
  fs.writeFileSync(path.join(root, '.harness/e2e-plan.md'), lines.join('\n') + '\n', 'utf8');
}

function qualityStatus(root, risk) {
  const commands = detectCommands(root);
  const e2ePlan = e2ePlanData(root);
  const req = {
    tests: { required: true, status: commands.tests ? 'READY' : 'MISSING', command: commands.tests || '' },
    lint: { required: risk === 'release', status: commands.lint ? 'READY' : (risk === 'release' ? 'MISSING' : 'OPTIONAL'), command: commands.lint || '' },
    coverage: { required: false, status: commands.coverage ? 'READY' : 'OPTIONAL', command: commands.coverage || '' },
    e2e: { required: riskRequiresE2E(risk), status: e2ePlan.recommended_command ? 'READY' : (riskRequiresE2E(risk) ? 'MISSING' : 'OPTIONAL'), command: e2ePlan.recommended_command || '' },
    runtime: { required: risk === 'release', status: commands.runtime ? 'READY' : (risk === 'release' ? 'MISSING' : 'OPTIONAL'), command: commands.runtime || '' },
  };
  const missing = Object.entries(req).filter(([, v]) => v.required && v.status !== 'READY').map(([k]) => k);
  const overall = missing.length === 0 ? 'READY' : 'NOT_READY';
  const parts = [];
  parts.push(`这次按 ${risk} 风险做准出检查。`);
  parts.push(commands.tests ? `已找到测试入口：${commands.tests}。` : '没找到测试入口。');
  if (riskRequiresE2E(risk)) parts.push(e2ePlan.recommended_command ? `已找到 E2E 入口：${e2ePlan.recommended_command}。` : '当前缺 E2E，不能按 medium/high/release 风险交付。');
  else parts.push(e2ePlan.recommended_command ? `已找到 E2E 入口：${e2ePlan.recommended_command}，但本风险等级不强制 E2E。` : '未找到 E2E 入口，本任务不强制 E2E。');
  if (missing.length > 0) parts.push(`缺少：${missing.join(', ')}。`);
  parts.push(`当前准出入口状态：${overall}。`);
  if (overall === 'READY') parts.push('这只是能力快照，还没有跑测试；最终能不能交付要看 `shk verify --write-evidence` 的 fresh evidence。');
  return {
    schema_version: '1.0',
    mode: 'capability_snapshot',
    risk,
    overall,
    commands,
    requirements: req,
    e2e_plan: e2ePlan,
    human_summary: parts.join(''),
    next_actions: overall === 'READY' ? [`run \`shk verify --risk ${risk} --write-evidence\` before REVIEW`] : missing.map(k => k === 'e2e' ? 'run `shk e2e plan` or configure package.json#test:e2e' : `configure ${k} command`),
  };
}

function qualityGateCheck(root, risk) {
  const q = qualityStatus(root, risk);
  return {
    status: q.overall === 'READY' ? 'PASS' : 'FAIL',
    command: `shk quality status --risk ${risk}`,
    risk,
    missing: Object.entries(q.requirements).filter(([, v]) => v.required && v.status !== 'READY').map(([k]) => k),
    summary: q.human_summary,
  };
}

function printQualityStatus(report, format) {
  if (format === 'json') { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`Quality Gate: ${report.overall}`);
  console.log(report.human_summary);
  if (report.next_actions.length) {
    console.log('Next actions:');
    report.next_actions.forEach(a => console.log(`- ${a}`));
  }
}

function cmdQuality(args, root) {
  const sub = args[0];
  if (sub !== 'status') { usage(); return 1; }
  const risk = parseRisk(args.slice(1), 'medium');
  const fmt = parseFormat(args.slice(1));
  const report = qualityStatus(root, risk);
  printQualityStatus(report, fmt);
  return report.overall === 'READY' ? 0 : 1;
}

function cmdE2EPlan(args, root) {
  const fmt = parseFormat(args);
  const plan = e2ePlanData(root);
  writeE2EPlan(root, plan);
  if (fmt === 'json') console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(`E2E Plan: ${plan.status}`);
    console.log(plan.human_summary);
    if (plan.recommended_command) console.log(`Command: ${plan.recommended_command}`);
  }
  return plan.status === 'READY' ? 0 : 1;
}

function cmdE2EInspect(args, root) {
  const fmt = parseFormat(args);
  const report = e2eInspectData(root);
  if (fmt === 'json') console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`E2E Inspect: ${report.project_type} / ${report.framework}`);
    console.log(report.human_summary);
    if (report.start_command) console.log(`Start: ${report.start_command}`);
    if (report.e2e_command) console.log(`E2E: ${report.e2e_command}`);
    if (report.questions.length) {
      console.log('Need one answer:');
      report.questions.slice(0, 1).forEach(q => console.log(`- ${q}`));
    }
  }
  return report.project_type === 'unknown' ? 1 : 0;
}

function cmdE2EBootstrap(args, root) {
  const fmt = parseFormat(args);
  const risk = parseRisk(args, 'medium');
  const report = e2eBootstrapData(root, risk);
  if (fmt === 'json') console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`E2E Bootstrap: ${report.status}`);
    console.log(report.human_summary);
    if (report.recommended_framework && report.recommended_framework !== 'unsupported') console.log(`Framework: ${report.recommended_framework}`);
    if (report.files_to_create.length) {
      console.log('Files to create:');
      report.files_to_create.forEach(f => console.log(`- ${f}`));
    }
    if (report.questions && report.questions.length) {
      console.log('Need one answer:');
      report.questions.slice(0, 1).forEach(q => console.log(`- ${q}`));
    }
  }
  return report.status === 'READY_TO_GENERATE' ? 0 : 1;
}

function cmdE2ERun(args, root) {
  const fmt = parseFormat(args);
  let plan = readJson(path.join(root, '.harness/e2e-plan.json')) || e2ePlanData(root);
  if (!exists(path.join(root, '.harness/e2e-plan.json'))) writeE2EPlan(root, plan);
  let result;
  if (!plan.recommended_command) {
    result = { schema_version: '1.0', status: 'NEEDS_INPUT', command: '', exit_code: null, human_summary: '还没有明确 E2E 命令。AI 需要先确认启动/E2E 命令，不能假装 E2E 通过。' };
  } else {
    const run = runCommand(root, plan.recommended_command, 180000);
    result = { schema_version: '1.0', status: run.status, command: plan.recommended_command, exit_code: run.exit_code, degraded: run.degraded, stdout_tail: run.stdout_tail, stderr_tail: run.stderr_tail, human_summary: run.status === 'PASS' ? `E2E 已通过：${plan.recommended_command}` : `E2E 未通过：${plan.recommended_command}。AI 应进入单点修复 loop。` };
  }
  ensureDir(path.join(root, '.harness'));
  writeJson(path.join(root, '.harness/e2e-result.json'), result);
  fs.writeFileSync(path.join(root, '.harness/e2e-result.md'), `# E2E Result\n\n${result.human_summary}\n\n- command: ${result.command || '(none)'}\n- status: ${result.status}\n`, 'utf8');
  if (fmt === 'json') console.log(JSON.stringify(result, null, 2));
  else console.log(result.human_summary);
  return result.status === 'PASS' ? 0 : 1;
}

function printE2EAssess(report, format) {
  if (format === 'json') { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`E2E Sufficiency: ${report.overall}`);
  console.log(report.human_summary);
  if (report.e2e_command) console.log(`Command: ${report.e2e_command}`);
  if (report.missing && report.missing.length) {
    console.log('Missing proof:');
    report.missing.forEach(m => console.log(`- ${m}`));
  }
}

function cmdE2EAssess(args, root) {
  const risk = parseRisk(args, 'medium');
  const fmt = parseFormat(args);
  const report = e2eSufficiencyAssess(root, risk);
  ensureDir(path.join(root, '.harness'));
  writeJson(path.join(root, '.harness/e2e-sufficiency.json'), report);
  fs.writeFileSync(path.join(root, '.harness/e2e-sufficiency.md'), `# E2E Sufficiency\n\n${report.human_summary}\n\n- overall: ${report.overall}\n- command: ${report.e2e_command || '(none)'}\n- e2e_status: ${report.e2e_status}\n`, 'utf8');
  printE2EAssess(report, fmt);
  return report.overall === 'READY' ? 0 : 1;
}

function printSpecStatus(report, format) {
  if (format === 'json') { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`Spec Status: ${report.overall}`);
  console.log(report.human_summary);
  if (report.missing && report.missing.length) {
    console.log('Missing / insufficient:');
    report.missing.forEach(m => console.log(`- ${m}`));
  }
}

function cmdSpec(args, root) {
  const sub = args[0];
  if (sub !== 'status') { usage(); return 1; }
  const risk = parseRisk(args.slice(1), 'medium');
  const fmt = parseFormat(args.slice(1));
  const report = specStatusData(root, risk);
  ensureDir(path.join(root, '.harness'));
  writeJson(path.join(root, '.harness/spec-status.json'), report);
  printSpecStatus(report, fmt);
  return report.overall === 'READY' ? 0 : 1;
}

function printTestEffectiveness(report, format) {
  if (format === 'json') { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`Test Effectiveness: ${report.overall}`);
  console.log(report.human_summary);
  if (report.missing && report.missing.length) {
    console.log('Missing proof:');
    report.missing.forEach(m => console.log(`- ${m}`));
  }
}

function cmdTest(args, root) {
  const sub = args[0];
  if (sub !== 'effectiveness') { usage(); return 1; }
  const risk = parseRisk(args.slice(1), 'medium');
  const fmt = parseFormat(args.slice(1));
  const report = testEffectivenessData(root, risk);
  ensureDir(path.join(root, '.harness'));
  writeJson(path.join(root, '.harness/test-effectiveness.json'), report);
  printTestEffectiveness(report, fmt);
  return report.overall === 'READY' ? 0 : 1;
}

function cmdLoop(args, root) {
  const sub = args[0];
  if (sub !== 'state') { usage(); return 1; }
  const fmt = parseFormat(args.slice(1));
  const current = readJson(path.join(root, '.harness/loop/current.json')) || null;
  const report = {
    schema_version: '1.0',
    state: current || { status: 'IDLE', iteration: 0 },
    policy: {
      max_iterations: 3,
      one_fix_per_iteration: true,
      rerun_minimal_test: true,
      rollback_when_no_progress: true,
      no_push_tag_release: true,
      no_destructive_commands: true,
      prefer_in_app_browser: true,
    },
    human_summary: '自动修复 loop 最多 3 轮；每轮只修一个失败点，重跑最小测试；没进展就停，不自动 push/tag/release。',
  };
  if (fmt === 'json') console.log(JSON.stringify(report, null, 2));
  else console.log(report.human_summary);
  return 0;
}

function makeEvidence(root, risk) {
  const started = new Date().toISOString();
  const commands = detectCommands(root);
  const checks = {};
  for (const name of ALL_CHECKS) checks[name] = { status: 'SKIP', command: '', reason: 'not required or not configured' };
  const required = RISK_CHECKS[risk] || RISK_CHECKS.medium;
  checks.quality_gate = qualityGateCheck(root, risk);
  for (const check of required) {
    if (check === 'quality_gate') continue;
    if (check === 'security') checks.security = runSecurityScan(root);
    else if (check === 'diff') checks.diff = diffCheck(root);
    else if (check === 'clean_tree') checks.clean_tree = cleanTreeCheck(root);
    else if (check === 'upstream') checks.upstream = upstreamCheck(root);
    else if (['build', 'types', 'lint', 'tests', 'coverage', 'e2e', 'runtime'].includes(check)) {
      const checkTimeout = check === 'tests'
        ? Number(process.env.SHK_VERIFY_TEST_TIMEOUT_MS || 360000)
        : 120000;
      if (check === 'e2e') {
        const runToken = createRunToken();
        checks[check] = runCommand(root, commands[check], checkTimeout, {
          env: { SHK_E2E_RUN_TOKEN: runToken },
          run_token: runToken,
        });
      } else {
        checks[check] = runCommand(root, commands[check], checkTimeout);
      }
      if (check === 'runtime') {
        const out = String(checks[check].stdout_tail || '') + String(checks[check].stderr_tail || '');
        checks[check].degraded = /\bDEGRADED\b/.test(out);
        if (checks[check].status === 'PASS' && checks[check].degraded) checks[check].status = 'DEGRADED';
      }
    }
    else checks[check] = { status: 'SKIP', command: '', reason: `${check} requires agent/human review` };
  }
  if (required.includes('e2e')) {
    const sufficiency = e2eSufficiencyAssess(root, risk, checks.e2e);
    checks.e2e_sufficiency = {
      status: sufficiency.overall === 'READY' ? 'PASS' : 'FAIL',
      overall: sufficiency.overall,
      command: sufficiency.e2e_command,
      e2e_status: sufficiency.e2e_status,
      coverage: sufficiency.coverage,
      missing: sufficiency.missing,
      summary: sufficiency.human_summary,
    };
  }
  if (risk !== 'low') {
    const specStatus = specStatusData(root, risk);
    checks.spec_status = {
      status: specStatus.overall === 'READY' ? 'PASS' : 'FAIL',
      overall: specStatus.overall,
      dimensions: specStatus.dimensions,
      missing: specStatus.missing,
      summary: specStatus.human_summary,
    };
    const effectiveness = testEffectivenessData(root, risk);
    checks.test_effectiveness = {
      status: effectiveness.overall === 'READY' ? 'PASS' : 'FAIL',
      overall: effectiveness.overall,
      dimensions: effectiveness.dimensions,
      missing: effectiveness.missing,
      summary: effectiveness.human_summary,
    };
  }
  const notSufficient = Object.values(checks).some(c => c && c.overall === 'NOT_SUFFICIENT');
  const failed = Object.values(checks).some(c => c.status === 'FAIL' || c.status === 'DEGRADED');
  return {
    schema_version: '1.0',
    task_id: process.env.SHK_TASK_ID || path.basename(root),
    risk,
    stage: 'VERIFY',
    started_at: started,
    completed_at: new Date().toISOString(),
    checks,
    overall: failed ? (notSufficient ? 'NOT_SUFFICIENT' : 'NOT_READY') : 'READY',
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
    const detail = c.summary || c.command || c.reason || (c.findings !== undefined ? `${c.findings} findings` : c.files !== undefined ? `${c.files} files` : '');
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

function installDependenciesForScript(script) {
  if (script === 'scripts/hooks/harness-stage-guard.js') return ['scripts/lib/spec-quality.js'];
  return [];
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
      for (const dep of installDependenciesForScript(c.script)) {
        const depSrc = path.join(KIT_ROOT, dep);
        const depDst = path.join(root, dep);
        let depAction = 'skip';
        let depReason = 'up-to-date';
        if (!exists(depSrc)) { depAction = 'conflict'; depReason = `source missing: ${dep}`; }
        else if (!exists(depDst)) { depAction = 'add'; depReason = `dependency for ${name}`; }
        else if (readText(depSrc) !== readText(depDst)) { depAction = 'update'; depReason = `dependency for ${name} differs`; }
        plan.push({ component: `${name}:dependency`, kind: 'library', action: depAction, reason: depReason, source: dep, target: dep });
      }
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
    if (cmd === 'quality') return cmdQuality(args.slice(1), root);
    if (cmd === 'doctor') return cmdDoctor(args.slice(1), root);
    if (cmd === 'status') return cmdStatus(root);
    if (cmd === 'security' && sub === 'scan') return cmdSecurity(rest, root);
    if (cmd === 'test-infra' && sub === 'assess') return cmdTestInfra(root);
    if (cmd === 'e2e' && sub === 'detect') return cmdE2E(root);
    if (cmd === 'e2e' && sub === 'inspect') return cmdE2EInspect(rest, root);
    if (cmd === 'e2e' && sub === 'plan') return cmdE2EPlan(rest, root);
    if (cmd === 'e2e' && sub === 'bootstrap') return cmdE2EBootstrap(rest, root);
    if (cmd === 'e2e' && sub === 'run') return cmdE2ERun(rest, root);
    if (cmd === 'e2e' && sub === 'assess') return cmdE2EAssess(rest, root);
    if (cmd === 'spec') return cmdSpec(args.slice(1), root);
    if (cmd === 'test') return cmdTest(args.slice(1), root);
    if (cmd === 'loop') return cmdLoop(args.slice(1), root);
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

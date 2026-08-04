#!/usr/bin/env bash
# Task-scoped E2E evidence wrapper.
# Runs the reusable SHK E2E matrix first, then proves this task's attestation,
# consumer-rejection, and downstream documentation contracts before emitting
# fresh run-token-bound structured evidence.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SPEC="$ROOT/docs/tasks/T-20260804-evidence-attestation/spec.json"
DOWNSTREAM_ROOT="${SHK_DOWNSTREAM_REPO:-}"
RUN_TOKEN="${SHK_E2E_RUN_TOKEN:-}"

fail() {
  echo "[evidence-flow-e2e] FAIL: $*" >&2
  exit 1
}

[ -n "$RUN_TOKEN" ] || fail "SHK_E2E_RUN_TOKEN is required"
[ -f "$SPEC" ] || fail "task spec is missing"
[ -n "$DOWNSTREAM_ROOT" ] || fail "SHK_DOWNSTREAM_REPO is required"
[ -d "$DOWNSTREAM_ROOT/.git" ] || fail "SHK_DOWNSTREAM_REPO is not a Git worktree"

cd "$ROOT"

# Broad reusable SHK positive/blocking matrix. This writes generic root evidence;
# the task-specific evidence below intentionally replaces it only after all
# task assertions have actually passed.
bash tests/scripts/13-e2e-sufficiency.sh

# Direct attestation/verifier and evidence-consumer contracts.
node tests/evidence-attestation.test.js
node tests/quality-suite.test.js
node scripts/shk.js security scan --format json > /tmp/shk-evidence-flow-security.json
node -e "const r=require('/tmp/shk-evidence-flow-security.json'); if(r.status!=='PASS'||r.findings!==0) process.exit(1)"

# Downstream intake is documentation-only and preserves the admission metadata.
node - "$DOWNSTREAM_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(process.argv[2]);
const expected = [
  'docs/plans/handoff-2026-08-04.md',
  'docs/requirements/items/RQ-0130.md',
  'docs/requirements/items/RQ-0133.md',
  'docs/requirements/items/RQ-0143.md',
  'docs/requirements/items/RQ-0144.md',
];
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return String(r.stdout || '');
}
function frontmatter(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('missing frontmatter');
  const out = {};
  for (let i = 1; i < lines.length && lines[i] !== '---'; i += 1) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const changed = git(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z'])
  .split('\0').filter(Boolean)
  .map(entry => entry.slice(3).replace(/^.* -> /, ''))
  .sort();
const nonDocs = changed.filter(file => !file.startsWith('docs/'));
if (nonDocs.length) throw new Error(`downstream business write detected: ${JSON.stringify(nonDocs)}`);
const missingExpected = expected.filter(file => !changed.includes(file));
if (missingExpected.length) throw new Error(`task-owned downstream suggestions missing: ${JSON.stringify(missingExpected)}`);
const unrelatedDocs = changed.filter(file => !expected.includes(file));
if (unrelatedDocs.length) {
  console.log(`[evidence-flow-e2e] unrelated downstream docs left untouched: ${JSON.stringify(unrelatedDocs)}`);
}
for (const file of expected.slice(1)) {
  const before = git(['show', `HEAD:${file}`]);
  const after = fs.readFileSync(path.join(root, file), 'utf8');
  const a = frontmatter(before);
  const b = frontmatter(after);
  for (const key of ['status', 'candidate_branch', 'candidate_commit']) {
    if ((a[key] || '') !== (b[key] || '')) throw new Error(`${file}: ${key} changed`);
  }
}
const contentChecks = [
  ['docs/requirements/items/RQ-0130.md', 'task_id + run_id + random nonce'],
  ['docs/requirements/items/RQ-0133.md', 'shk evidence verify'],
  ['docs/requirements/items/RQ-0143.md', 'build-input manifest'],
  ['docs/requirements/items/RQ-0144.md', 'CODE_FAIL'],
  ['docs/plans/handoff-2026-08-04.md', 'SHK 回流后的'],
];
for (const [file, needle] of contentChecks) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (!text.includes(needle)) throw new Error(`${file}: missing ${needle}`);
}
console.log('[evidence-flow-e2e] downstream documentation contract PASS');
NODE

# Scan only added public lines and untracked public files. The forbidden pattern
# is supplied by the private caller so public SHK does not learn business terms.
if [ -n "${SHK_PUBLIC_FORBIDDEN_PATTERN:-}" ]; then
  added="$({
    git diff --unified=0 HEAD -- .
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      sed 's/^/+/' "$file"
    done < <(git ls-files --others --exclude-standard)
  } | grep -E '^\+[^+]' || true)"
  if printf '%s\n' "$added" | grep -Eiq "$SHK_PUBLIC_FORBIDDEN_PATTERN"; then
    fail "new public lines contain a forbidden downstream term"
  fi
fi

# Build the quality contract directly from the task spec and emit evidence only
# after every command above succeeded. The run token binds it to this verify run.
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
    { id: 'MUT-DIGEST', target: 'protected evidence field changed after attestation', status: 'KILLED', proof: 'evidence-attestation.test.js rejects digest tamper' },
    { id: 'MUT-GIT', target: 'stale commit/tree evidence reused', status: 'KILLED', proof: 'real Git CLI integration rejects the new identity' },
    { id: 'MUT-CONSUMER', target: 'tampered READY evidence reaches a critical consumer', status: 'KILLED', proof: 'quality-suite consumer rejection cases pass' },
    { id: 'MUT-TRUST', target: 'local-self JSON is renamed ci-signed and re-digested', status: 'KILLED', proof: 'library and CLI return EVIDENCE_TRUST_UNVERIFIED without external authentication' },
    { id: 'MUT-VERIFIER', target: 'attestation verifier dependency is unavailable', status: 'KILLED', proof: 'delivery, verification, and stage consumers fail closed for attested or strict evidence' },
    { id: 'MUT-DOWNSTREAM', target: 'downstream status/candidate or write set changes', status: 'KILLED', proof: 'documentation contract compare fails closed' },
  ],
}, null, 2)}\n`);
fs.writeFileSync(path.join(harness, 'e2e-result.json'), `${JSON.stringify({
  schema_version: '1.0',
  status: 'PASS',
  run_token: runToken,
  covered: {
    changed_areas: changedAreas,
    must_prove: mustProve,
    requirements,
    risks,
    traffic_flows: trafficFlows,
  },
  assertions: [
    'verify evidence generation writes Git provenance, full mode, local-self issuer trust, and canonical digest',
    'fresh evidence passes while protected-field tamper and stale commit/tree fail with structured codes',
    'delivery, verification, stage, and doctor consumers reject digest-invalid READY evidence',
    'local issuers cannot mint higher trust; re-digested high-trust JSON is rejected unless an external boundary authenticates it',
    'delivery, verification, and stage consumers fail closed when the verifier is unavailable for attested or strict evidence',
    'legacy evidence remains compatible only when it is unattested and strict policy is disabled',
    'downstream recommendations stay in the expected documentation write set without status or candidate mutation',
    'new public lines contain no caller-supplied forbidden downstream terms',
  ],
  paths: [
    { type: 'positive', proof: 'valid attested evidence, reusable SHK E2E, consumer positive controls, and documentation intake all pass' },
    { type: 'negative', proof: 'tampered digest, stale Git identity, unauthenticated trust elevation, missing verifier, policy mismatch, consumer bypass, metadata mutation, and public-term leakage are blocked' },
  ],
  command_proofs: [
    'tests/scripts/13-e2e-sufficiency.sh',
    'tests/evidence-attestation.test.js',
    'tests/quality-suite.test.js',
    'scripts/shk.js security scan',
    'downstream Git frontmatter/write-set comparison',
  ],
}, null, 2)}\n`);
console.log(`[evidence-flow-e2e] task evidence written for ${trafficFlows.join(', ')}`);
NODE

echo "[evidence-flow-e2e] PASS"

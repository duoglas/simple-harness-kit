#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const policy = require('../scripts/lib/verification-policy');
const attestation = require('../scripts/lib/evidence-attestation');

function run(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); console.error(err.stack || err); process.exit(1); }
}

function identity(overrides = {}) {
  return {
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    candidate_digest: `sha256:${'c'.repeat(64)}`,
    test_manifest_digest: `sha256:${'d'.repeat(64)}`,
    runner_digest: `sha256:${'e'.repeat(64)}`,
    verdict_digest: `sha256:${'f'.repeat(64)}`,
    scheduler_digest: `sha256:${'1'.repeat(64)}`,
    ...overrides,
  };
}

function fullEvidence(candidate = identity(), overrides = {}) {
  const evidence = {
    schema_version: '1.0',
    overall: 'READY',
    checks: {
      tests: { status: 'PASS', command: 'run tests' },
      coord: { status: 'PASS', command: 'run coord' },
    },
    provenance: { mode: 'full', git: {
      available: true,
      commit: candidate.commit,
      tree: candidate.tree,
      dirty: false,
      candidate_digest: candidate.candidate_digest,
    }, verification: {
      test_manifest_digest: candidate.test_manifest_digest,
      runner_digest: candidate.runner_digest,
      verdict_digest: candidate.verdict_digest,
      scheduler_digest: candidate.scheduler_digest,
    } },
    ...overrides,
  };
  return attestation.attestEvidence(evidence, {
    issuer: { type: 'test', name: 'verification-policy' },
    trust_level: 'local-self',
  });
}

run('exact trusted full candidate is reusable', () => {
  const candidate = identity();
  const result = policy.evaluateFullAdmission({
    phase: 'integration', candidate, baseline: fullEvidence(candidate),
  });
  assert.strictEqual(result.action, 'REUSE');
  assert.strictEqual(result.status, 'PASS');
  assert.ok(result.reason_codes.includes('EXACT_FULL_BASELINE'));
});

run('candidate rewrite and manifest drift invalidate old evidence', () => {
  const before = identity();
  const rewritten = identity({ commit: '9'.repeat(40) });
  const result = policy.verifyCandidateContinuity({
    candidate: rewritten,
    artifacts: [{ kind: 'review', identity: before }, { kind: 'evidence', identity: before }],
  });
  assert.strictEqual(result.status, 'STALE');
  assert.deepStrictEqual(result.artifacts.map(x => x.status), ['STALE', 'STALE']);
  assert.ok(result.artifacts.every(x => x.changed_fields.includes('commit')));

  const manifestChanged = identity({ test_manifest_digest: `sha256:${'8'.repeat(64)}` });
  const admission = policy.evaluateFullAdmission({
    phase: 'integration', candidate: manifestChanged, baseline: fullEvidence(before),
  });
  assert.strictEqual(admission.action, 'REJECT');
  assert.ok(admission.reason_codes.includes('BASELINE_IDENTITY_MISMATCH'));
});

run('tampered partial or cached baseline cannot suppress a full run', () => {
  const candidate = identity();
  const tampered = fullEvidence(candidate);
  tampered.overall = 'NOT_READY';
  let result = policy.evaluateFullAdmission({ phase: 'integration', candidate, baseline: tampered });
  assert.strictEqual(result.action, 'REJECT');
  assert.ok(result.reason_codes.includes('BASELINE_ATTESTATION_INVALID'));

  result = policy.evaluateFullAdmission({
    phase: 'integration', candidate,
    baseline: fullEvidence(candidate, { incremental: { cached: ['tests'] } }),
  });
  assert.strictEqual(result.action, 'REJECT');
  assert.ok(result.reason_codes.includes('BASELINE_NOT_FULLY_EXECUTED'));

  const hiddenCachedCheck = fullEvidence(candidate);
  hiddenCachedCheck.checks.tests.cached = true;
  const reattested = attestation.attestEvidence(hiddenCachedCheck, {
    issuer: { type: 'test', name: 'verification-policy' },
    trust_level: 'local-self',
  });
  result = policy.evaluateFullAdmission({ phase: 'integration', candidate, baseline: reattested });
  assert.strictEqual(result.action, 'REJECT');
  assert.ok(result.reason_codes.includes('BASELINE_NOT_FULLY_EXECUTED'));
});

run('final admission runs changed candidate but integration refuses it', () => {
  const baselineCandidate = identity();
  const current = identity({ commit: '7'.repeat(40), tree: '6'.repeat(40) });
  const final = policy.evaluateFullAdmission({
    phase: 'final', candidate: current, baseline: fullEvidence(baselineCandidate),
    prerequisites: { candidate_frozen: true, review_complete: true },
    policy: { require_frozen_candidate: true, require_review: true },
  });
  assert.strictEqual(final.action, 'RUN');
  const integration = policy.evaluateFullAdmission({
    phase: 'integration', candidate: current, baseline: fullEvidence(baselineCandidate),
  });
  assert.strictEqual(integration.action, 'REJECT');
});

run('focused compatibility permits candidate drift but rejects manifest drift', () => {
  const before = identity();
  const changedCandidate = identity({
    commit: '7'.repeat(40),
    tree: '6'.repeat(40),
    candidate_digest: `sha256:${'5'.repeat(64)}`,
  });
  let result = policy.baselineAssessment(fullEvidence(before), changedCandidate, {
    identity_fields: ['test_manifest_digest', 'runner_digest', 'verdict_digest', 'scheduler_digest'],
  });
  assert.strictEqual(result.status, 'VALID');

  result = policy.baselineAssessment(fullEvidence(before), {
    ...changedCandidate,
    test_manifest_digest: `sha256:${'4'.repeat(64)}`,
  }, { identity_fields: ['test_manifest_digest'] });
  assert.strictEqual(result.status, 'INVALID');
  assert.ok(result.reason_codes.includes('BASELINE_IDENTITY_MISMATCH'));
});

run('reviewer defaults to evidence audit plus risk probes', () => {
  const candidate = identity();
  const normal = policy.evaluateReviewerPolicy({
    candidate, evidence: fullEvidence(candidate), changed_areas: ['feature'], risk_probes: ['race probe'],
  });
  assert.strictEqual(normal.action, 'AUDIT_AND_PROBE');
  assert.deepStrictEqual(normal.required_probes, ['race probe']);

  const sensitive = policy.evaluateReviewerPolicy({
    candidate, evidence: fullEvidence(candidate), changed_areas: ['runner'], risk_probes: [],
  });
  assert.strictEqual(sensitive.action, 'FULL_REBUILD');
  assert.ok(sensitive.reason_codes.includes('VERIFICATION_CONTROL_CHANGED'));
});

run('suite inclusion is transitive and de-duplicates selected suites', () => {
  const plan = policy.resolveSuitePlan({
    selected: ['full', 'coord', 'static'],
    suite_includes: { full: ['coord'], coord: ['static'], static: [] },
    known_suites: ['full', 'coord', 'static'],
  });
  assert.deepStrictEqual(plan.execute, ['full']);
  assert.strictEqual(plan.included_by.coord, 'full');
  assert.strictEqual(plan.included_by.static, 'full');
  const projected = policy.projectSuiteResults(plan, { full: { status: 'FAIL', command: 'run full' } });
  assert.strictEqual(projected.coord.status, 'FAIL');
  assert.strictEqual(projected.static.status, 'FAIL');
  assert.strictEqual(projected.coord.inherited, true);
  const reversed = policy.resolveSuitePlan({
    selected: ['static', 'coord', 'full'],
    suite_includes: { full: ['coord'], coord: ['static'], static: [] },
    known_suites: ['full', 'coord', 'static'],
  });
  assert.deepStrictEqual(reversed.execute, ['full']);
  assert.strictEqual(reversed.included_by.static, 'full');
});

run('suite inclusion rejects cycles and unknown references', () => {
  assert.throws(() => policy.resolveSuitePlan({
    selected: ['full'], suite_includes: { full: ['coord'], coord: ['full'] }, known_suites: ['full', 'coord'],
  }), /SUITE_INCLUDE_CYCLE/);
  assert.throws(() => policy.resolveSuitePlan({
    selected: ['full'], suite_includes: { full: ['missing'] }, known_suites: ['full'],
  }), /SUITE_UNKNOWN_REFERENCE/);
  assert.throws(() => policy.resolveSuitePlan({
    selected: ['full'], suite_includes: { hidden: ['full'] }, known_suites: ['full'],
  }), /SUITE_UNKNOWN_REFERENCE/);
  assert.throws(() => policy.resolveSuitePlan({
    selected: ['left', 'right', 'shared'],
    suite_includes: { left: ['shared'], right: ['shared'] },
    known_suites: ['left', 'right', 'shared'],
  }), /SUITE_OWNER_AMBIGUOUS/);
  assert.throws(() => policy.resolveSuitePlan({
    selected: ['left', 'right'],
    suite_includes: { left: ['shared'], right: ['shared'] },
    known_suites: ['left', 'right', 'shared'],
  }), /SUITE_OWNER_AMBIGUOUS/);
});

run('completion blocks placeholders but allows complete and draft controls', () => {
  const configured = {
    completed_states: ['shipped'],
    required_fields: ['requirements.*.text', 'design.summary'],
    placeholder_patterns: ['\\bTODO\\b', '\\bTBD\\b', '（补充）', '待补充'],
  };
  let result = policy.evaluateRequirementCompleteness({
    state: 'shipped',
    document: { requirements: [{ text: '（补充）' }], design: { summary: 'real design' } },
    policy: configured,
  });
  assert.strictEqual(result.allowed, false);
  assert.ok(result.failures.some(x => x.code === 'REQUIRED_CONTENT_PLACEHOLDER'));

  result = policy.evaluateRequirementCompleteness({
    state: 'draft', document: { requirements: [{ text: 'TODO' }], design: { summary: 'TBD' } }, policy: configured,
  });
  assert.strictEqual(result.allowed, true);

  result = policy.evaluateRequirementCompleteness({
    state: 'shipped',
    document: { requirements: [{ text: 'Integrate Todoist without placeholder semantics.' }], design: { summary: 'Complete design.' } },
    policy: configured,
  });
  assert.strictEqual(result.allowed, true);
});

run('markdown required sections reject empty or placeholder content', () => {
  const result = policy.evaluateRequirementCompleteness({
    state: 'done',
    document: '# Request\n\n## Background\nTBD\n\n## Acceptance\n- observable result\n',
    policy: { completed_states: ['done'], required_sections: ['Background', 'Acceptance'] },
  });
  assert.strictEqual(result.allowed, false);
  assert.ok(result.failures.some(x => x.path === 'section:Background'));
});

run('task close fails before mutating shipped task with placeholder plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-policy-close-'));
  const taskId = 'T-20260807-placeholder';
  fs.mkdirSync(path.join(dir, '.git'));
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness', 'CURRENT'), `${taskId}\n`);
  const taskDir = path.join(dir, 'docs', 'tasks', taskId);
  fs.mkdirSync(path.join(taskDir, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(taskDir, 'review'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id: taskId, title: 'placeholder', status: 'open', risk: 'high', stage: 'REVIEW' }));
  fs.writeFileSync(path.join(taskDir, 'spec.json'), JSON.stringify({ requirements: [{ text: 'real requirement' }], design: { summary: 'real design' } }));
  fs.writeFileSync(path.join(taskDir, 'plan.md'), '# Plan\n\n## 目标\n（补充）\n\n## 验收标准\nreal acceptance\n');
  fs.writeFileSync(path.join(taskDir, 'findings.md'), '# Findings\n');
  const cli = path.resolve(__dirname, '..', 'scripts', 'shk.js');
  const result = spawnSync('node', [cli, 'task', 'close', '--outcome', 'shipped'], { cwd: dir, encoding: 'utf8' });
  assert.notStrictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /REQUIRED_CONTENT_PLACEHOLDER/);
  let task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
  assert.strictEqual(task.status, 'open');

  fs.unlinkSync(path.join(taskDir, 'plan.md'));
  const missingPlan = spawnSync('node', [cli, 'task', 'close', '--outcome', 'shipped'], { cwd: dir, encoding: 'utf8' });
  assert.notStrictEqual(missingPlan.status, 0, missingPlan.stdout + missingPlan.stderr);
  assert.match(missingPlan.stderr, /REQUIRED_CONTENT_MISSING/);
  task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
  assert.strictEqual(task.status, 'open');
});

console.log('12/12 verification policy tests passed');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const policy = require('../scripts/lib/verification-policy');
const attestation = require('../scripts/lib/evidence-attestation');
const cliApi = require('../scripts/shk');
const contractApi = require('../scripts/lib/verification-contract');

let testsRun = 0;
let testsFailed = 0;

function run(name, fn) {
  testsRun++;
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { testsFailed++; console.error(`FAIL ${name}`); console.error(err.stack || err); process.exitCode = 1; }
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

run('risk admission requires the requested scope and actual check results', () => {
  const candidate = identity();
  const scope = { risk: 'release', risk_checks: { low: ['tests'], release: ['tests', 'runtime', 'santa'] }, evaluate_checks: cliApi.computeEvidenceOverall };
  for (const phase of ['final', 'integration']) {
    const result = policy.evaluateFullAdmission({ phase, candidate, baseline: fullEvidence(candidate, { risk: 'low' }), policy: scope });
    assert.strictEqual(result.action, phase === 'final' ? 'RUN' : 'REJECT');
    assert.ok(result.reason_codes.includes('BASELINE_RISK_MISMATCH'));
    assert.ok(result.reason_codes.includes('BASELINE_REQUIRED_CHECK_MISSING'));
  }
  for (const status of ['SKIP', 'WARN', 'DEGRADED', 'FAIL']) {
    const baseline = fullEvidence(candidate, { risk: 'release', checks: { tests: { status: 'PASS' }, runtime: { status }, santa: { status: 'SKIP', agent_review_required: true } } });
    const result = policy.evaluateFullAdmission({ phase: 'integration', candidate, baseline, policy: scope });
    assert.strictEqual(result.action, 'REJECT', status);
    assert.ok(result.reason_codes.includes('BASELINE_CHECKS_NOT_READY'));
  }
  const baseline = fullEvidence(candidate, { risk: 'release', checks: { tests: { status: 'PASS' }, runtime: { status: 'PASS' }, santa: { status: 'SKIP', agent_review_required: true } } });
  assert.strictEqual(policy.evaluateFullAdmission({ phase: 'integration', candidate, baseline, policy: scope }).action, 'REUSE');
  assert.strictEqual(policy.evaluateFullAdmission({ phase: 'integration', candidate, baseline: fullEvidence(candidate), policy: { risk: 'release' } }).action, 'REJECT');
});

run('exact identity binds present control digests and fails closed when missing', () => {
  for (const field of ['runner_digest', 'verdict_digest', 'scheduler_digest']) {
    for (const value of [null, `sha256:${'2'.repeat(64)}`]) {
      const result = policy.evaluateFullAdmission({ phase: 'integration', candidate: identity({ [field]: value }), baseline: fullEvidence() });
      assert.strictEqual(result.action, 'REJECT', field);
      assert.ok(result.reason_codes.includes('BASELINE_IDENTITY_MISMATCH'));
    }
  }
});

run('review and frozen prerequisites apply to exact reuse in both phases', () => {
  for (const phase of ['final', 'integration']) {
    for (const [requirement, reason] of [['require_review', 'REVIEW_NOT_COMPLETE'], ['require_frozen_candidate', 'CANDIDATE_NOT_FROZEN']]) {
      const result = policy.evaluateFullAdmission({ phase, candidate: identity(), baseline: fullEvidence(), policy: { [requirement]: true } });
      assert.strictEqual(result.action, 'REJECT');
      assert.ok(result.reason_codes.includes(reason));
    }
  }
  assert.strictEqual(policy.evaluateFullAdmission({ phase: 'integration', candidate: identity(), baseline: fullEvidence(), policy: { require_review: true, require_frozen_candidate: true }, prerequisites: { review_complete: true, candidate_frozen: true } }).action, 'REUSE');
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

run('wildcard requirements validate every branch including missing and empty children', () => {
  const configured = { required_fields: ['requirements.*.text', 'design.summary'] };
  for (const requirements of [[{ text: 'Implemented requirement' }, {}], [{}, { text: 'Implemented requirement' }], [], [{}], [null], [{ text: '' }]]) {
    const document = { requirements, design: { summary: 'Concrete design' } };
    const result = policy.evaluateRequirementCompleteness({ state: 'shipped', document, policy: configured });
    assert.strictEqual(result.allowed, false, JSON.stringify(requirements));
    assert.ok(result.failures.some(f => f.code === 'REQUIRED_CONTENT_MISSING'));
    if (requirements.length > 1) assert.ok(result.failures.some(f => f.path === `requirements[${requirements[0].text ? 1 : 0}].text`));
    assert.strictEqual(policy.evaluateRequirementCompleteness({ state: 'draft', document, policy: configured }).allowed, true);
  }
  for (const groups of [{ first: { items: [{ text: 'Valid' }] }, second: {} }, { first: { items: [{ text: 'Valid' }] }, second: { items: [] } }]) {
    const result = policy.evaluateRequirementCompleteness({ state: 'done', document: { groups }, policy: { required_fields: ['groups.*.items.*.text'] } });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.failures.some(f => f.path.startsWith('groups.second.items')));
  }
});

function withCliFixture(fn, verificationPolicy = {}, objectFormat = 'sha1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-policy-admission-'));
  const cli = path.resolve(__dirname, '..', 'scripts', 'shk.js');
  const exec = (command, args) => spawnSync(command, args, { cwd: dir, encoding: 'utf8', timeout: 30000 });
  const git = (...args) => {
    const result = exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Policy Test', '-c', 'user.email=policy@example.invalid', ...args]);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  try {
    fs.mkdirSync(path.join(dir, '.harness'));
    fs.mkdirSync(path.join(dir, 'controls'));
    fs.writeFileSync(path.join(dir, '.gitignore'), '.harness/\ncontrols/\ndocs/verification-report.md\n');
    fs.writeFileSync(path.join(dir, 'fixture-check.js'), "const fs = require('fs'); require('assert').strictEqual(2 + 2, 4); fs.appendFileSync('.harness/executions.log', 'run\\n');\n");
    const commands = Object.fromEntries(['build', 'tests', 'types', 'lint', 'coverage', 'e2e', 'runtime', 'runtime_selftest', 'dogfood_oss', 'upstream_dogfood', 'browser_e2e_dogfood'].map(name => [name, 'node fixture-check.js']));
    const config = { commands, verification_policy: verificationPolicy };
    const writeConfig = () => fs.writeFileSync(path.join(dir, '.harness/config.json'), JSON.stringify(config));
    writeConfig();
    git('init', '-q', `--object-format=${objectFormat}`);
    git('add', '.gitignore', 'fixture-check.js');
    git('commit', '-qm', 'test fixture');
    const verify = (...args) => exec(process.execPath, [cli, 'verify', ...args]);
    const executions = () => fs.readFileSync(path.join(dir, '.harness/executions.log'), 'utf8').split('\n').filter(Boolean).length;
    fn({ dir, config, writeConfig, verify, executions, git });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const objectFormat of ['sha1', 'sha256']) {
  run(`focused baseline discovers actual source changes despite tree replacement (${objectFormat})`, () => {
    withCliFixture(({ dir, verify, git }) => {
      fs.writeFileSync(path.join(dir, 'src.js'), 'module.exports = true;\n');
      fs.writeFileSync(path.join(dir, 'fixture-check.js'), "if (!require('./src')) process.exit(7);\n");
      git('add', 'src.js', 'fixture-check.js');
      git('commit', '-qm', 'passing source');
      const baselineCommit = git('rev-parse', 'HEAD').stdout.trim();
      const baselineTree = git('rev-parse', 'HEAD^{tree}').stdout.trim();
      const initial = verify('--risk', 'low', '--write-evidence');
      assert.strictEqual(initial.status, 0, initial.stdout + initial.stderr);
      const evidence = () => JSON.parse(fs.readFileSync(path.join(dir, '.harness/verify-evidence.json'), 'utf8'));
      const focused = () => {
        fs.rmSync(path.join(dir, '.harness/verify-cache.json'), { force: true });
        return verify('--risk', 'low', '--phase', 'focused', '--write-evidence');
      };
      fs.writeFileSync(path.join(dir, 'guide.md'), '# Documentation update\n');
      git('add', 'guide.md');
      git('commit', '-qm', 'documentation only');
      focused();
      assert.strictEqual(evidence().checks.tests.status, 'PASS');
      assert.strictEqual(evidence().checks.tests.cached_from_baseline, true, 'ordinary docs-only reuse remains valid');

      fs.writeFileSync(path.join(dir, 'src.js'), 'module.exports = false;\n');
      git('add', 'src.js');
      git('commit', '-qm', 'failing source');
      assert.notStrictEqual(focused().status, 0, 'ordinary changed source must execute and fail');
      assert.strictEqual(evidence().checks.tests.status, 'FAIL');
      assert.ok(!evidence().checks.tests.cached);
      const changedTree = git('rev-parse', 'HEAD^{tree}').stdout.trim();
      git('update-ref', `refs/replace/${baselineTree}`, changedTree);
      assert.strictEqual(git('diff', '--name-only', baselineCommit, '--', 'src.js').stdout.trim(), '', 'replacement view hides the source change');
      assert.strictEqual(git('--no-replace-objects', 'diff', '--name-only', baselineCommit, '--', 'src.js').stdout.trim(), 'src.js');
      const replaced = focused();
      assert.notStrictEqual(replaced.status, 0, replaced.stdout + replaced.stderr);
      assert.strictEqual(evidence().checks.tests.status, 'FAIL');
      assert.ok(!evidence().checks.tests.cached, 'replacement must not produce CACHED PASS');
      assert.ok(evidence().incremental.changed_files > 0);
    }, {}, objectFormat);
  });

  run(`focused baseline ancestry uses actual commit parents (${objectFormat})`, () => {
    withCliFixture(({ dir, config, verify, git }) => {
      const initial = verify('--risk', 'low', '--write-evidence');
      assert.strictEqual(initial.status, 0, initial.stdout + initial.stderr);
      const baselineCommit = git('rev-parse', 'HEAD').stdout.trim();
      const tree = git('rev-parse', 'HEAD^{tree}').stdout.trim();
      const assessment = () => cliApi.trustedBaseline(dir, config, cliApi.verificationIdentity(dir, config, 'low'), 'low');
      assert.strictEqual(assessment().focused_assessment.status, 'VALID');
      const unrelated = git('commit-tree', tree, '-m', 'unrelated root').stdout.trim();
      const descendant = git('commit-tree', tree, '-p', baselineCommit, '-m', 'actual descendant').stdout.trim();
      git('update-ref', 'HEAD', descendant);
      assert.strictEqual(assessment().focused_assessment.status, 'VALID', 'ordinary descendant remains eligible');
      git('update-ref', 'HEAD', unrelated);
      assert.ok(assessment().focused_assessment.reason_codes.includes('BASELINE_NOT_ANCESTOR'));
      git('update-ref', `refs/replace/${unrelated}`, descendant);
      git('merge-base', '--is-ancestor', baselineCommit, 'HEAD');
      const raw = spawnSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', baselineCommit, 'HEAD'], { cwd: dir });
      assert.strictEqual(raw.status, 1, 'actual commit graph remains unrelated');
      const replaced = assessment();
      assert.strictEqual(replaced.cache_seed, null);
      assert.ok(replaced.focused_assessment.reason_codes.includes('BASELINE_NOT_ANCESTOR'));
    }, {}, objectFormat);
  });

  run(`focused baseline commit availability ignores replacement object type (${objectFormat})`, () => {
    withCliFixture(({ dir, config, verify, git }) => {
      const initial = verify('--risk', 'low', '--write-evidence');
      assert.strictEqual(initial.status, 0, initial.stdout + initial.stderr);
      const actual = git('rev-parse', 'HEAD').stdout.trim();
      const tree = git('rev-parse', 'HEAD^{tree}').stdout.trim();
      git('update-ref', `refs/replace/${actual}`, tree);
      const replaced = spawnSync('git', ['cat-file', '-e', `${actual}^{commit}`], { cwd: dir });
      assert.notStrictEqual(replaced.status, 0, 'replacement changes the apparent object type');
      git('--no-replace-objects', 'cat-file', '-e', `${actual}^{commit}`);
      const assessment = () => cliApi.trustedBaseline(dir, config, cliApi.verificationIdentity(dir, config, 'low'), 'low');
      assert.strictEqual(assessment().focused_assessment.status, 'VALID', 'actual baseline commit is still available');
      assert.ok(assessment().cache_seed);

      const missing = '1'.repeat(actual.length);
      const baselinePath = path.join(dir, '.harness/verification-baseline.json');
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      baseline.provenance.git.commit = missing;
      fs.writeFileSync(baselinePath, JSON.stringify(attestation.attestEvidence(baseline, {
        issuer: { type: 'test', name: 'missing-baseline-object' }, trust_level: 'local-self',
      })));
      const raw = spawnSync('git', ['--no-replace-objects', 'cat-file', '-e', `${missing}^{commit}`], { cwd: dir });
      assert.notStrictEqual(raw.status, 0, 'actual commit object is absent');
      const result = assessment();
      assert.strictEqual(result.cache_seed, null);
      assert.ok(result.focused_assessment.reason_codes.includes('BASELINE_COMMIT_UNAVAILABLE'), JSON.stringify(result.focused_assessment));
    }, {}, objectFormat);
  });
}

run('CLI keeps ordinary full execution and exact same-risk reuse but refuses risk upgrade', () => {
  withCliFixture(({ dir, config, verify, executions }) => {
    const initial = verify('--risk', 'low', '--write-evidence');
    assert.strictEqual(initial.status, 0, initial.stdout + initial.stderr);
    const ran = executions();
    for (const phase of ['final', 'integration']) {
      const result = verify('--risk', 'low', '--phase', phase);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Full admission: REUSE/);
      assert.strictEqual(executions(), ran);
    }
    const integration = verify('--risk', 'release', '--phase', 'integration');
    assert.notStrictEqual(integration.status, 0, integration.stdout + integration.stderr);
    assert.match(integration.stderr, /BASELINE_(RISK_MISMATCH|REQUIRED_CHECK_MISSING|CHECKS_NOT_READY)/);
    assert.strictEqual(executions(), ran);
    const final = verify('--risk', 'release', '--phase', 'final');
    assert.doesNotMatch(final.stdout, /Full admission: REUSE/);
    assert.ok(executions() > ran, 'final must execute the requested checks');
    const afterFinal = executions();
    const ordinary = verify('--risk', 'low');
    assert.strictEqual(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
    assert.ok(executions() > afterFinal, 'no-phase verify must keep executing');
    assert.notStrictEqual(cliApi.verificationIdentity(dir, config, 'low').test_manifest_digest, cliApi.verificationIdentity(dir, config, 'release').test_manifest_digest);
  });
});

run('CLI exact admission binds configured ignored controls and rejects unavailable inputs', () => {
  for (const area of ['runner', 'verdict', 'scheduler']) {
    withCliFixture(({ dir, config, verify }) => {
      const control = path.join(dir, 'controls', `${area}.txt`);
      fs.writeFileSync(control, 'first version\n');
      const initial = verify('--risk', 'low', '--write-evidence');
      assert.strictEqual(initial.status, 0, initial.stdout + initial.stderr);
      assert.match(verify('--risk', 'low', '--phase', 'integration').stdout, /Full admission: REUSE/);
      fs.writeFileSync(control, 'changed version\n');
      const drifted = verify('--risk', 'low', '--phase', 'integration');
      assert.notStrictEqual(drifted.status, 0, drifted.stdout + drifted.stderr);
      assert.match(drifted.stderr, /BASELINE_IDENTITY_MISMATCH/);
      fs.unlinkSync(control);
      assert.strictEqual(cliApi.verificationIdentity(dir, config, 'low')[`${area}_digest`], null);
      const missing = verify('--risk', 'low', '--phase', 'integration');
      assert.notStrictEqual(missing.status, 0, missing.stdout + missing.stderr);
      const refreshed = verify('--risk', 'low', '--write-evidence');
      assert.strictEqual(refreshed.status, 0, refreshed.stdout + refreshed.stderr);
      assert.notStrictEqual(verify('--risk', 'low', '--phase', 'integration').status, 0, 'repeated missing inputs cannot become reusable');
    }, { identity_inputs: { [area]: [`controls/${area}.txt`] }, full_admission: { identity_fields: ['commit'] } });
  }
});

run('CLI checks signed READY baseline contents under the current risk semantics', () => {
  withCliFixture(({ dir, config, verify, executions }) => {
    const initial = verify('--risk', 'low', '--write-evidence');
    assert.strictEqual(initial.status, 0, initial.stdout + initial.stderr);
    const baselinePath = path.join(dir, '.harness/verification-baseline.json');
    const original = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const writeBaseline = evidence => fs.writeFileSync(baselinePath, JSON.stringify(attestation.attestEvidence(evidence, { issuer: { type: 'test', name: 'admission-fixture' }, trust_level: 'local-self' })));
    const ran = executions();
    for (const mutate of [e => { delete e.checks.tests; }, e => { e.checks.tests.status = 'FAIL'; }, e => { e.checks.tests.status = 'UNKNOWN'; }, e => { e.checks.quality_gate.status = 'SKIP'; }]) {
      const evidence = JSON.parse(JSON.stringify(original));
      mutate(evidence);
      writeBaseline(evidence);
      const result = verify('--risk', 'low', '--phase', 'integration');
      assert.notStrictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /BASELINE_(REQUIRED_CHECK_MISSING|CHECKS_NOT_READY)/);
      assert.strictEqual(executions(), ran);
    }
    // Synthetic attested policy input: no release workload is run by this test.
    const release = JSON.parse(JSON.stringify(original));
    release.risk = 'release';
    release.provenance.verification = cliApi.verificationIdentity(dir, config, 'release');
    const releaseContract = contractApi.readContract(dir, 'release', config);
    release.provenance.applicability = { contract: releaseContract, digest: contractApi.digest(releaseContract) };
    for (const check of Object.values(release.checks)) check.status = 'PASS';
    release.checks.quality_gate.risk = 'release';
    for (const name of ['e2e_sufficiency', 'spec_status', 'test_effectiveness']) release.checks[name] = { status: 'PASS' };
    release.checks.santa = { status: 'SKIP', agent_review_required: true };
    writeBaseline(release);
    const allowed = verify('--risk', 'release', '--phase', 'integration');
    assert.strictEqual(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.match(allowed.stdout, /Full admission: REUSE/);
    for (const status of ['SKIP', 'WARN', 'DEGRADED', 'FAIL']) {
      const evidence = JSON.parse(JSON.stringify(release));
      evidence.checks.runtime.status = status;
      writeBaseline(evidence);
      const result = verify('--risk', 'release', '--phase', 'integration');
      assert.notStrictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /BASELINE_CHECKS_NOT_READY/);
      assert.strictEqual(executions(), ran);
    }
    delete release.checks.e2e_sufficiency;
    writeBaseline(release);
    const missingProof = verify('--risk', 'release', '--phase', 'integration');
    assert.notStrictEqual(missingProof.status, 0, missingProof.stdout + missingProof.stderr);
    assert.match(missingProof.stderr, /BASELINE_REQUIRED_CHECK_MISSING/);
  });
});

run('CLI exact reuse cannot bypass review or freeze prerequisites', () => {
  for (const [required, prerequisite, reason] of [['require_review', 'review_complete', 'REVIEW_NOT_COMPLETE'], ['require_frozen_candidate', 'candidate_frozen', 'CANDIDATE_NOT_FROZEN']]) {
    withCliFixture(({ config, writeConfig, verify, executions }) => {
      const initial = verify('--risk', 'low', '--write-evidence');
      assert.strictEqual(initial.status, 0, initial.stdout + initial.stderr);
      const ran = executions();
      for (const phase of ['final', 'integration']) {
        const result = verify('--risk', 'low', '--phase', phase);
        assert.notStrictEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, new RegExp(reason));
        assert.strictEqual(executions(), ran);
      }
      config.verification_policy.full_admission.prerequisites = { [prerequisite]: true };
      writeConfig();
      const allowed = verify('--risk', 'low', '--phase', 'integration');
      assert.strictEqual(allowed.status, 0, allowed.stdout + allowed.stderr);
      assert.match(allowed.stdout, /Full admission: REUSE/);
    }, { full_admission: { [required]: true } });
  }
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

console.log(`${testsRun - testsFailed}/${testsRun} verification policy tests passed`);

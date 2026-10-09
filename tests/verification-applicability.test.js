#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const KIT = path.resolve(__dirname, '..');
const SHK = path.join(KIT, 'scripts/shk.js');
const cli = require(SHK);
const attestation = require('../scripts/lib/evidence-attestation');
const contractApi = require('../scripts/lib/verification-contract');
const policy = require('../scripts/lib/verification-policy');
const verifyCache = require('../scripts/lib/verify-cache');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}
function config(declarations = { build: { status: 'NOT_APPLICABLE', reason: 'This fixture runs source files directly and has no build step.' } }) {
  return { commands: { tests: 'node -e "process.exit(0)"' }, verification_policy: { applicability: declarations } };
}
function withRepo(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shk-applicability-')));
  try {
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'SHK contract fixture']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    write(root, 'README.md', '# Applicability fixture\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-qm', 'fixture']);
    fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n.harness/\ndocs/\npackage.json\n');
    write(root, '.harness/config.json', config());
    fn(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function run(root, script, args = [], input, environment = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: 'utf8', input: input && JSON.stringify(input),
    env: { ...process.env, HARNESS_GUARD_MODE: 'strict', HARNESS_SKIP_GATE: '0', ...environment },
  });
}
function verify(root, args = []) {
  const result = run(root, SHK, ['verify', '--risk', 'low', '--write-evidence', ...args]);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(fs.readFileSync(path.join(root, '.harness/verify-evidence.json'), 'utf8'));
}

function testExplicitApplicabilityProducesDistinctEvidence() {
  withRepo(root => {
    const evidence = verify(root);
    assert.strictEqual(evidence.checks.build.status, 'NOT_APPLICABLE');
    assert.ok(evidence.limitations.some(item => item.check === 'build' && item.status === 'NOT_APPLICABLE' && item.claims_ready === false));
    assert.ok(evidence.provenance.applicability);
    assert.match(fs.readFileSync(path.join(root, '.harness/verify-evidence.md'), 'utf8'), /NOT_APPLICABLE/);
  });
}

function testUnboundNotApplicableEvidenceIsRejected() {
  withRepo(root => {
    const evidence = attestation.attestEvidence({
      schema_version: '1.0', risk: 'low', overall: 'READY',
      checks: { build: { status: 'NOT_APPLICABLE', reason: 'No build exists.' } },
      provenance: { git: attestation.readGitIdentity(root), mode: 'full' },
    });
    const result = attestation.verifyEvidence(evidence, { require_attestation: true, project_root: root });
    assert.strictEqual(result.status, 'FAIL', JSON.stringify(result));
    assert.ok(result.failures.some(item => item.code.startsWith('APPLICABILITY_')));
  });
}

function testApplicabilityValidationAndReleaseScope() {
  const valid = Object.fromEntries(contractApi.OPTIONAL_CHECKS.map(name => [name,
    { status: 'NOT_APPLICABLE', reason: `No ${name} tool is configured for this fixture; no ${name} proof is claimed.` }]));
  const resolve = (declarations, commands = {}, detected = {}) => contractApi.resolveContract({
    config: { commands, verification_policy: { applicability: declarations } },
    detected_commands: { build: '', types: '', lint: '', coverage: '', ...detected }, risk: 'release',
  });
  const contract = resolve(valid);
  const checks = Object.fromEntries([...contract.scope.required_checks, ...contract.scope.proof_checks].map(name => [name, { status: 'PASS' }]));
  for (const [name, declaration] of Object.entries(valid)) checks[name] = { ...declaration, command: '' };
  assert.strictEqual(cli.computeEvidenceOverall(checks, 'release', contract), 'READY');
  assert.strictEqual(cli.computeEvidenceOverall(checks, 'release'), 'NOT_READY', 'N/A without the current contract is not a valid exception');
  for (const declaration of [null, [], 'NOT_APPLICABLE', { build: {} }, { build: { status: 'PASS', reason: 'No compiler.' } },
    { build: { status: 'NOT_APPLICABLE', reason: '' } }, { build: { status: 'NOT_APPLICABLE', reason: 'TBD' } },
    { build: { status: 'NOT_APPLICABLE', reason: '待补充' } }, { build: { status: 'NOT_APPLICABLE', reason: 'N/A' } },
    { build: { status: 'NOT_APPLICABLE', reason: '...' } }, { build: { status: 'NOT_APPLICABLE', reason: '<reason>' } },
    { build: { status: 'NOT_APPLICABLE', reason: 'No build tool.', extra: true } }]) {
    assert.throws(() => resolve(declaration), /APPLICABILITY_CONTRACT_INVALID/);
  }
  for (const name of ['unknown', 'tests', 'runtime', 'runtime_selftest', 'security', 'e2e', 'spec', 'browser_e2e_dogfood', 'dogfood_oss']) {
    assert.throws(() => resolve({ [name]: valid.build }), /cannot be declared NOT_APPLICABLE/);
  }
  assert.throws(() => resolve(valid, { build: 'node build.js' }), /detected or configured command/);
  assert.throws(() => resolve(valid, {}, { types: 'npm run typecheck' }), /detected or configured command/);
  assert.throws(() => contractApi.resolveContract({ config: { verification_policy: { applicability: valid, suite_includes: { tests: ['types'] } } } }), /cannot provide or inherit/);
  const skip = { ...checks, coverage: { status: 'SKIP', reason: 'not configured' } };
  assert.strictEqual(cli.computeEvidenceOverall(skip, 'release', contract), 'NOT_READY', 'coverage SKIP remains blocking');
}

function testCapabilitySnapshotAndMissingCommands() {
  withRepo(root => {
    const declared = Object.fromEntries(contractApi.OPTIONAL_CHECKS.map(name => [name, {
      status: 'NOT_APPLICABLE', reason: `This fixture has no configured ${name} tool and makes no ${name} claim.`,
    }]));
    const cfg = config(declared);
    cfg.commands.e2e = 'node fixture-e2e.js';
    cfg.commands.runtime = 'node fixture-runtime.js';
    write(root, '.harness/config.json', cfg);
    let result = run(root, SHK, ['quality', 'status', '--risk', 'release', '--format', 'json']);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    for (const name of contractApi.OPTIONAL_CHECKS) assert.strictEqual(JSON.parse(result.stdout).requirements[name].status, 'NOT_APPLICABLE');
    delete cfg.verification_policy.applicability;
    write(root, '.harness/config.json', cfg);
    result = run(root, SHK, ['quality', 'status', '--risk', 'release', '--format', 'json']);
    assert.strictEqual(result.status, 1, result.stdout);
    const snapshot = JSON.parse(result.stdout);
    assert.strictEqual(snapshot.overall, 'NOT_READY');
    for (const name of contractApi.OPTIONAL_CHECKS) {
      assert.strictEqual(snapshot.requirements[name].status, 'MISSING');
      assert.strictEqual(snapshot.requirements[name].required, true);
    }
    cfg.verification_policy.applicability = declared;
    write(root, '.harness/config.json', cfg);
    write(root, 'package.json', { scripts: { build: 'node build.js' } });
    result = run(root, SHK, ['verify', '--risk', 'low']);
    assert.strictEqual(result.status, 1, result.stdout);
    assert.match(result.stderr, /APPLICABILITY_CONTRACT_INVALID/);
  });
}

function prepareConsumers(root) {
  write(root, '.harness/current-stage.json', { stage: 'REVIEW', since: '2020-01-01T00:00:00Z', task: 'applicability review' });
  write(root, '.harness/stage-history.jsonl', `${JSON.stringify({ stage: 'EXECUTE', t: new Date().toISOString() })}\n${JSON.stringify({ stage: 'VERIFY', t: new Date().toISOString() })}\n`);
}
function consumerResults(root, environment = {}) {
  const verification = run(root, path.join(KIT, 'scripts/hooks/verification-gate.js'), [], { tool_input: { command: 'git push origin HEAD' } }, environment);
  const delivery = run(root, path.join(KIT, 'scripts/hooks/delivery-gate.js'), [], { last_assistant_message: '修改完成，请验收。' }, environment);
  const stage = run(root, path.join(KIT, 'scripts/hooks/harness-stage-guard.js'), [], {
    hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {
      file_path: path.join(root, '.harness/current-stage.json'),
      content: JSON.stringify({ stage: 'REVIEW', since: 'now', task: 'applicability review' }),
    },
  }, environment);
  const evidenceCli = run(root, SHK, ['evidence', 'verify', '--format', 'json'], undefined, environment);
  const doctor = cli.doctorReport(root).checks.find(check => check.id === 'verify-evidence');
  return { verification, delivery, stage, evidenceCli, doctor };
}
function testEveryConsumerRejectsCurrentContractDrift() {
  withRepo(root => {
    const evidence = verify(root);
    prepareConsumers(root);
    let results = consumerResults(root);
    assert.strictEqual(results.verification.status, 0, results.verification.stderr);
    assert.strictEqual(results.delivery.status, 0, results.delivery.stderr);
    assert.strictEqual(results.evidenceCli.status, 0, results.evidenceCli.stdout);
    assert.strictEqual(results.doctor.status, 'PASS', JSON.stringify(results.doctor));
    assert.ok(!results.stage.stdout.includes('"deny"'), results.stage.stdout || results.stage.stderr);
    for (const mutate of [
      cfg => { cfg.verification_policy.applicability.build.reason = 'The build tool is intentionally absent in this new contract.'; },
      cfg => { delete cfg.verification_policy.applicability; },
      cfg => { cfg.commands.build = 'node build.js'; },
      cfg => { cfg.commands.tests = 'node another-test.js'; },
      cfg => { cfg.check_inputs = { tests: ['docs'] }; },
      () => { write(root, 'package.json', { scripts: { build: 'node build.js' } }); },
    ]) {
      const cfg = config();
      mutate(cfg);
      write(root, '.harness/config.json', cfg);
      assert.deepStrictEqual(attestation.readGitIdentity(root), evidence.provenance.git, 'probe must change the contract without changing Git candidate identity');
      results = consumerResults(root);
      for (const name of ['verification', 'delivery']) {
        assert.strictEqual(results[name].status, 2, `${name}: ${results[name].stderr}`);
        assert.match(results[name].stderr, /APPLICABILITY_/);
      }
      assert.match(results.stage.stdout + results.stage.stderr, /APPLICABILITY_/);
      assert.strictEqual(results.evidenceCli.status, 1, results.evidenceCli.stdout);
      assert.match(results.evidenceCli.stdout, /APPLICABILITY_/);
      assert.strictEqual(results.doctor.status, 'FAIL', JSON.stringify(results.doctor));
      assert.match(results.doctor.message, /APPLICABILITY_/);
      const baseline = policy.baselineIntegrityAssessment(evidence, { project_root: root });
      assert.strictEqual(baseline.status, 'INVALID', JSON.stringify(baseline));
      assert.ok(baseline.evidence_verification.failures.some(item => item.code.startsWith('APPLICABILITY_')));
    }
  });
}

function testMalformedOrForgedExceptionsAndMissingVerifierFailClosed() {
  withRepo(root => {
    const evidence = verify(root);
    prepareConsumers(root);
    for (const mutate of [
      copy => { delete copy.provenance.applicability; },
      copy => { copy.checks.runtime = { status: 'NOT_APPLICABLE', command: '', reason: evidence.checks.build.reason }; },
      copy => { delete copy.checks.tests; },
      copy => { copy.checks.build.cached = true; },
      copy => { copy.checks.build.inherited = true; copy.checks.build.included_by = 'tests'; },
      copy => { copy.checks.build.included_by = 'tests'; },
      copy => { copy.checks.build.inherited_from = 'tests'; },
      copy => { copy.checks.build.reason = 'TBD'; },
      copy => { copy.limitations = []; },
    ]) {
      const copy = JSON.parse(JSON.stringify(evidence));
      mutate(copy);
      const signed = attestation.attestEvidence(copy);
      assert.strictEqual(attestation.verifyEvidence(signed, { project_root: root }).status, 'FAIL');
    }
    const unsigned = { ...evidence };
    delete unsigned.attestation;
    assert.strictEqual(attestation.verifyEvidence(unsigned, { allow_legacy: true, project_root: root }).status, 'FAIL');
    const preload = path.join(root, '.harness/block-contract.js');
    write(root, '.harness/block-contract.js', "const Module = require('module'); const load = Module._load; Module._load = function(name, ...args) { if (name.endsWith('/verification-contract')) throw new Error('injected missing contract verifier'); return load.call(this, name, ...args); };\n");
    for (const name of ['verification-gate.js', 'delivery-gate.js', 'harness-stage-guard.js']) {
      const input = name === 'verification-gate.js' ? { tool_input: { command: 'git push origin HEAD' } }
        : name === 'delivery-gate.js' ? { last_assistant_message: '修改完成，请验收。' }
          : { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, '.harness/current-stage.json'), content: JSON.stringify({ stage: 'REVIEW', since: 'now' }) } };
      const result = run(root, path.join(KIT, 'scripts/hooks', name), [], input, { NODE_OPTIONS: `--require=${preload}` });
      assert.match(result.stdout + result.stderr, /APPLICABILITY_VERIFIER_UNAVAILABLE/, name);
    }
  });
}

function testCacheAndBaselineDoNotMixPassWithNotApplicable() {
  withRepo(root => {
    const cfg = config({});
    cfg.commands.build = `node -e "const f=require('fs'),p='.harness/build-count';f.writeFileSync(p,String(Number(f.existsSync(p)?f.readFileSync(p):0)+1))"`;
    write(root, '.harness/config.json', cfg);
    let evidence = verify(root, ['--round', '1']);
    assert.strictEqual(evidence.checks.build.status, 'PASS');
    write(root, '.harness/config.json', config());
    evidence = verify(root, ['--round', '2']);
    assert.strictEqual(evidence.checks.build.status, 'NOT_APPLICABLE');
    assert.ok(!evidence.checks.build.cached);
    write(root, '.harness/config.json', cfg);
    evidence = verify(root, ['--round', '3']);
    assert.strictEqual(evidence.checks.build.status, 'PASS');
    assert.ok(!evidence.checks.build.cached);
    assert.strictEqual(fs.readFileSync(path.join(root, '.harness/build-count'), 'utf8'), '2');
    write(root, '.harness/config.json', config());
    evidence = verify(root);
    const current = cli.verificationIdentity(root, config(), 'low');
    assert.strictEqual(cli.trustedBaseline(root, config(), current, 'low').assessment.status, 'VALID');
    for (const phase of ['final', 'integration']) {
      const result = run(root, SHK, ['verify', '--risk', 'low', '--phase', phase]);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Full admission: REUSE/);
    }
    const focused = run(root, SHK, ['verify', '--risk', 'low', '--phase', 'focused', '--write-evidence']);
    assert.ok([0, 1].includes(focused.status), focused.stderr);
    const focusedEvidence = JSON.parse(fs.readFileSync(path.join(root, '.harness/verify-evidence.json'), 'utf8'));
    assert.strictEqual(focusedEvidence.checks.build.status, 'NOT_APPLICABLE');
    assert.ok(!focusedEvidence.checks.build.cached);
  });
}

function testEvidenceWithoutExceptionsRetainsLegacyCompatibility() {
  const evidence = { schema_version: '1.0', risk: 'low', overall: 'READY', checks: { tests: { status: 'PASS' } } };
  assert.strictEqual(attestation.verifyEvidence(evidence, { allow_legacy: true }).status, 'PASS');
  assert.strictEqual(attestation.verifyEvidence(attestation.attestEvidence(evidence), {}).status, 'PASS');
}

function testCompleteIgnoredSpecIsBoundToEvidenceAndBaseline() {
  withRepo(root => {
    const spec = JSON.parse(fs.readFileSync(path.join(KIT, 'docs/tasks/T-20260930-release-admission-fix/spec.json'), 'utf8'));
    write(root, '.harness/iteration-spec.json', spec);
    const evidence = verify(root);
    const originalDigest = contractApi.digest(contractApi.readContract(root, 'low'));
    const valid = run(root, SHK, ['spec', 'status', '--risk', 'high', '--format', 'json']);
    assert.strictEqual(valid.status, 0, valid.stdout || valid.stderr);
    for (const field of ['requirements', 'design', 'acceptance', 'traffic_flows', 'tasks', 'irreversible_actions']) {
      const changed = JSON.parse(JSON.stringify(spec));
      changed[field] = field === 'design' ? {} : [];
      write(root, '.harness/iteration-spec.json', changed);
      assert.deepStrictEqual(attestation.readGitIdentity(root), evidence.provenance.git, 'ignored spec drift must not rely on Git candidate drift');
      assert.notStrictEqual(contractApi.digest(contractApi.readContract(root, 'low')), originalDigest, `${field} must change the protected contract`);
      assert.strictEqual(attestation.verifyEvidence(evidence, { project_root: root }).status, 'FAIL', field);
      assert.strictEqual(policy.baselineIntegrityAssessment(evidence, { project_root: root }).status, 'INVALID', field);
    }
    write(root, '.harness/iteration-spec.json', spec);
    assert.strictEqual(attestation.verifyEvidence(evidence, { project_root: root }).status, 'PASS');
  });
}

function testCapabilitySnapshotCannotAuthorizeStaleEvidenceAndFreshRunRecovers() {
  withRepo(root => {
    verify(root);
    const changed = config();
    changed.verification_policy.applicability.build.reason = 'Source distribution has no compilation stage; this is the revised release contract.';
    write(root, '.harness/config.json', changed);
    const snapshot = run(root, SHK, ['quality', 'status', '--risk', 'low', '--format', 'json']);
    assert.strictEqual(snapshot.status, 0, snapshot.stderr);
    assert.strictEqual(JSON.parse(snapshot.stdout).mode, 'capability_snapshot');
    assert.strictEqual(run(root, SHK, ['evidence', 'verify', '--format', 'json']).status, 1, 'capability readiness cannot make old proof current');
    const fresh = verify(root);
    assert.strictEqual(fresh.checks.build.reason, changed.verification_policy.applicability.build.reason);
    assert.strictEqual(run(root, SHK, ['evidence', 'verify', '--format', 'json']).status, 0, 'stale evidence must not deadlock fresh verification');
  });
}

function testInstallAndUpgradeCarryApplicabilityVerifier() {
  withRepo(root => {
    const installed = run(root, SHK, ['install', '--profile', 'core']);
    assert.strictEqual(installed.status, 0, installed.stderr || installed.stdout);
    for (const name of ['verification-contract', 'evidence-attestation', 'task-ledger']) {
      assert.ok(fs.existsSync(path.join(root, `scripts/lib/${name}.js`)), `installer omitted ${name}`);
    }
    const sourceContract = path.join(KIT, 'scripts/lib/verification-contract.js');
    const targetContract = path.join(root, 'scripts/lib/verification-contract.js');
    const evidence = verify(root);
    assert.strictEqual(require(path.join(root, 'scripts/lib/evidence-attestation')).verifyEvidence(evidence, { project_root: root }).status, 'PASS');
    fs.rmSync(targetContract);
    const upgraded = spawnSync('bash', [path.join(KIT, 'update.sh'), '--hooks-only', root], {
      cwd: root, encoding: 'utf8', env: { ...process.env, SHK_SKIP_CODEX_TRUST: '1' },
    });
    assert.strictEqual(upgraded.status, 0, upgraded.stderr || upgraded.stdout);
    assert.strictEqual(fs.readFileSync(targetContract, 'utf8'), fs.readFileSync(sourceContract, 'utf8'));
  });
}

function testAllPassContractEvidenceRejectsDriftAndMissingVerifier() {
  withRepo(root => {
    const cfg = config({});
    cfg.commands.build = 'node -e "process.exit(0)"';
    write(root, '.harness/config.json', cfg);
    write(root, '.harness/iteration-spec.json', { requirements: ['original'], design: { value: 1 }, acceptance: ['original'] });
    const evidence = verify(root);
    assert.strictEqual(evidence.overall, 'READY');
    assert.ok(!contractApi.hasNotApplicable(evidence));
    prepareConsumers(root);
    assert.strictEqual(consumerResults(root).doctor.status, 'PASS');
    for (const field of ['requirements', 'design', 'acceptance']) {
      write(root, '.harness/iteration-spec.json', { requirements: ['original'], design: { value: 1 }, acceptance: ['original'], [field]: [] });
      assert.deepStrictEqual(attestation.readGitIdentity(root), evidence.provenance.git);
      assert.strictEqual(attestation.verifyEvidence(evidence, { project_root: root }).status, 'FAIL', field);
      assert.strictEqual(policy.baselineIntegrityAssessment(evidence, { project_root: root }).status, 'INVALID', field);
      const results = consumerResults(root);
      for (const name of ['verification', 'delivery']) assert.strictEqual(results[name].status, 2, name);
      assert.match(results.stage.stdout + results.stage.stderr, /APPLICABILITY_/);
      assert.strictEqual(results.evidenceCli.status, 1);
      assert.strictEqual(results.doctor.status, 'FAIL');
    }
    const preload = path.join(root, '.harness/block-contract.js');
    write(root, '.harness/block-contract.js', "const M=require('module'),load=M._load;M._load=function(n,...a){if(n.endsWith('/verification-contract'))throw Error('missing verifier');return load.call(this,n,...a)}");
    const result = run(root, path.join(KIT, 'scripts/hooks/verification-gate.js'), [], { tool_input: { command: 'git push origin HEAD' } }, { NODE_OPTIONS: `--require=${preload}` });
    assert.match(result.stderr, /APPLICABILITY_VERIFIER_UNAVAILABLE/);
  });
}

function testContractEvidenceCannotBecomeLegacyWhenVerifierIsMissing() {
  withRepo(root => {
    const cfg = config({});
    cfg.commands.build = 'node -e "process.exit(0)"';
    write(root, '.harness/config.json', cfg);
    const evidence = verify(root);
    assert.ok(!contractApi.hasNotApplicable(evidence));
    prepareConsumers(root);
    const preload = path.join(root, '.harness/block-attestation.js');
    write(root, '.harness/block-attestation.js', "const M=require('module'),load=M._load;M._load=function(n,...a){if(/(?:^|\\/)evidence-attestation(?:\\.js)?$/.test(n))throw Object.assign(Error('injected missing attestation verifier'),{code:'MODULE_NOT_FOUND'});return load.call(this,n,...a)}");
    const inputs = {
      'verification-gate.js': { tool_input: { command: 'git commit -m contract-proof' } },
      'delivery-gate.js': { last_assistant_message: '修改完成，请验收。' },
      'harness-stage-guard.js': { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {
        file_path: path.join(root, '.harness/current-stage.json'),
        content: JSON.stringify({ stage: 'REVIEW', since: 'now', task: 'contract proof' }),
      } },
    };
    const failures = [];
    for (const variant of ['attested', 'unsigned-contract', 'null-contract', 'legacy-git-identity', 'legacy-controls', 'legacy']) {
      write(root, '.harness/config.json', cfg);
      const copy = JSON.parse(JSON.stringify(evidence));
      if (variant !== 'attested') delete copy.attestation;
      if (variant === 'null-contract') copy.provenance.applicability = null;
      if (variant.startsWith('legacy')) delete copy.provenance;
      if (variant === 'legacy-git-identity') copy.git_identity = attestation.readGitIdentity(root);
      if (variant === 'legacy-controls') {
        write(root, '.harness/control.js', 'configured control\n');
        write(root, '.harness/config.json', { ...cfg, verification_policy: {
          ...cfg.verification_policy, identity_inputs: { runner: ['.harness/control.js'] },
        } });
      }
      write(root, '.harness/verify-evidence.json', copy);
      for (const [name, input] of Object.entries(inputs)) {
        const result = run(root, path.join(KIT, 'scripts/hooks', name), [], input, { NODE_OPTIONS: `--require=${preload}` });
        const output = result.stdout + result.stderr;
        if (variant === 'legacy') {
          if (result.status !== 0 || /"deny"|VERIFIER_UNAVAILABLE/.test(output)) failures.push(`${name} ${variant}: ${result.status} ${output}`);
        } else if (!/ATTESTATION_VERIFIER_UNAVAILABLE/.test(output)
            || (name !== 'harness-stage-guard.js' && result.status !== 2)
            || (name === 'harness-stage-guard.js' && !/"deny"/.test(output))) {
          failures.push(`${name} ${variant}: ${result.status} ${output}`);
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testLegacyProvenanceIdentityRequiresCurrentGitAndVerifier() {
  withRepo(root => {
    const cfg = config({});
    cfg.commands.build = 'node -e "process.exit(0)"';
    write(root, '.harness/config.json', cfg);
    let evidence = verify(root);
    prepareConsumers(root);
    const preload = path.join(root, '.harness/block-legacy-attestation.js');
    write(root, '.harness/block-legacy-attestation.js', "const M=require('module'),load=M._load;M._load=function(n,...a){if(/(?:^|\\/)evidence-attestation(?:\\.js)?$/.test(n))throw Object.assign(Error('injected missing attestation verifier'),{code:'MODULE_NOT_FOUND'});return load.call(this,n,...a)}");
    const inputs = {
      'verification-gate.js': { tool_input: { command: 'git push origin HEAD' } },
      'delivery-gate.js': { last_assistant_message: '修改完成，请验收。' },
      'harness-stage-guard.js': { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {
        file_path: path.join(root, '.harness/current-stage.json'),
        content: JSON.stringify({ stage: 'REVIEW', since: 'now', task: 'legacy identity proof' }),
      } },
    };
    const failures = [];
    const check = (state, current) => {
      for (const format of ['provenance-git', 'both-identities', 'unprotected-legacy']) {
        const copy = JSON.parse(JSON.stringify(evidence));
        delete copy.attestation;
        delete copy.provenance.applicability;
        if (format === 'both-identities') copy.git_identity = copy.provenance.git;
        if (format === 'unprotected-legacy') delete copy.provenance.git;
        write(root, '.harness/verify-evidence.json', copy);
        for (const missingVerifier of [false, true]) {
          const environment = missingVerifier ? { NODE_OPTIONS: `--require=${preload}` } : {};
          const allowed = format === 'unprotected-legacy' || (current && !missingVerifier);
          for (const [name, input] of Object.entries(inputs)) {
            // Push needs the verifier's Git reader even before evidence is inspected.
            // Commit reaches the legacy fallback and isolates missing-module handling.
            const hookInput = missingVerifier && name === 'verification-gate.js'
              ? { tool_input: { command: 'git commit -m legacy-proof' } } : input;
            const result = run(root, path.join(KIT, 'scripts/hooks', name), [], hookInput, environment);
            const output = result.stdout + result.stderr;
            const label = `${name} ${format} ${state} verifier=${missingVerifier ? 'missing' : 'present'}`;
            if (allowed) {
              if (result.status !== 0 || /"deny"|MISMATCH|VERIFIER_UNAVAILABLE/.test(output)) failures.push(`${label}: ${result.status} ${output}`);
            } else {
              const reason = missingVerifier ? /ATTESTATION_VERIFIER_UNAVAILABLE/ : /GIT_(?:COMMIT|TREE|CANDIDATE)_MISMATCH/;
              if (!reason.test(output)
                  || (name !== 'harness-stage-guard.js' && result.status !== 2)
                  || (name === 'harness-stage-guard.js' && !/"deny"/.test(output))) failures.push(`${label}: ${result.status} ${output}`);
            }
          }
        }
      }
    };
    check('current', true);
    write(root, 'README.md', '# changed legacy candidate\n');
    check('unstaged-change', false);
    git(root, ['add', 'README.md']);
    check('staged-change', false);
    git(root, ['commit', '-qm', 'changed legacy candidate']);
    check('changed-commit-and-tree', false);
    evidence = verify(root);
    check('fresh-after-change', true);
    git(root, ['commit', '--allow-empty', '-qm', 'same tree different commit']);
    check('changed-commit-only', false);
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testMalformedLegacyIdentityCannotBecomeUnprotectedEvidence() {
  withRepo(root => {
    const cfg = config({});
    cfg.commands.build = 'node -e "process.exit(0)"';
    write(root, '.harness/config.json', cfg);
    const legacy = verify(root);
    delete legacy.attestation;
    delete legacy.provenance.applicability;
    delete legacy.provenance.git;
    prepareConsumers(root);
    const preload = path.join(root, '.harness/block-malformed-attestation.js');
    write(root, '.harness/block-malformed-attestation.js', "const M=require('module'),load=M._load;M._load=function(n,...a){if(/(?:^|\\/)evidence-attestation(?:\\.js)?$/.test(n))throw Object.assign(Error('injected missing attestation verifier'),{code:'MODULE_NOT_FOUND'});return load.call(this,n,...a)}");
    const inputs = {
      'verification-gate.js': { tool_input: { command: 'git commit -m legacy-proof' } },
      'delivery-gate.js': { last_assistant_message: '修改完成，请验收。' },
      'harness-stage-guard.js': { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {
        file_path: path.join(root, '.harness/current-stage.json'),
        content: JSON.stringify({ stage: 'REVIEW', since: 'now', task: 'malformed legacy identity' }),
      } },
    };
    const variants = [{ name: 'unprotected-legacy', evidence: legacy }];
    for (const field of ['provenance.git', 'git_identity']) {
      for (const value of [null, false, '', {}]) {
        const copy = JSON.parse(JSON.stringify(legacy));
        if (field === 'provenance.git') copy.provenance.git = value;
        else copy.git_identity = value;
        variants.push({ name: `${field}=${JSON.stringify(value)}`, evidence: copy });
      }
    }
    const failures = [];
    for (const variant of variants) {
      write(root, '.harness/verify-evidence.json', variant.evidence);
      for (const missingVerifier of [false, true]) {
        const environment = missingVerifier ? { NODE_OPTIONS: `--require=${preload}` } : {};
        for (const [name, input] of Object.entries(inputs)) {
          const result = run(root, path.join(KIT, 'scripts/hooks', name), [], input, environment);
          const output = result.stdout + result.stderr;
          const label = `${name} ${variant.name} verifier=${missingVerifier ? 'missing' : 'present'}`;
          if (variant.name === 'unprotected-legacy') {
            if (result.status !== 0 || /"deny"|MISMATCH|VERIFIER_UNAVAILABLE/.test(output)) failures.push(`${label}: ${result.status} ${output}`);
          } else {
            const reason = missingVerifier ? /ATTESTATION_VERIFIER_UNAVAILABLE/ : /GIT_COMMIT_MISMATCH/;
            if (!reason.test(output)
                || (name !== 'harness-stage-guard.js' && result.status !== 2)
                || (name === 'harness-stage-guard.js' && !/"deny"/.test(output))) failures.push(`${label}: ${result.status} ${output}`);
          }
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testIncrementalCacheBindsControlContentsAndReadFailures() {
  withRepo(root => {
    for (const area of ['runner', 'verdict', 'scheduler']) {
      const cfg = config();
      cfg.verification_policy.identity_inputs = { [area]: [`.harness/${area}.txt`] };
      const control = path.join(root, `.harness/${area}.txt`);
      write(root, `.harness/${area}.txt`, 'v1');
      write(root, '.harness/config.json', cfg);
      const digest = cli.verificationIdentity(root, cfg, 'low').test_manifest_digest;
      const context = () => verifyCache.createContext(root, { config: cfg, contract_digest: digest });
      let cache = context();
      cache.record('tests', { status: 'PASS', command: cfg.commands.tests });
      cache.persist();
      assert.strictEqual(context().shouldRun('tests'), false, `${area} unchanged positive control`);
      write(root, `.harness/${area}.txt`, 'v2');
      assert.strictEqual(context().shouldRun('tests'), true, `${area} changed`);
      write(root, `.harness/${area}.txt`, 'v1');
      const originalRead = fs.readFileSync;
      try {
        fs.readFileSync = function(file, ...args) {
          if (String(file) === control) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          return originalRead.call(this, file, ...args);
        };
        assert.strictEqual(context().shouldRun('tests'), true, `${area} unreadable`);
      } finally { fs.readFileSync = originalRead; }
      fs.rmSync(control);
      assert.strictEqual(context().shouldRun('tests'), true, `${area} missing`);
    }
  });
}

function testReleaseDoctorDoesNotConsumePreviousEvidence() {
  withRepo(root => {
    const original = verify(root);
    prepareConsumers(root);
    const changed = config();
    changed.verification_policy.applicability.build.reason = 'Updated source-only project contract without a compiler.';
    write(root, '.harness/config.json', changed);
    assert.strictEqual(cli.doctorReport(root).checks.find(c => c.id === 'verify-evidence').status, 'FAIL');
    const first = cli.makeEvidence(root, 'release');
    assert.strictEqual(first.checks.doctor.scope, 'environment');
    assert.ok(!first.checks.doctor.checks.some(c => c.id === 'verify-evidence'), 'new release verification must not depend on previous proof');
    write(root, '.harness/verify-evidence.json', attestation.attestEvidence(first));
    const second = cli.makeEvidence(root, 'release');
    assert.deepStrictEqual(second.checks.doctor, first.checks.doctor, 'previous failed run cannot poison the next doctor');
    fs.rmSync(path.join(root, '.harness/verify-evidence.json'));
    const initial = cli.makeEvidence(root, 'release');
    assert.deepStrictEqual(initial.checks.doctor, first.checks.doctor, 'first release needs no previous evidence');
    assert.notStrictEqual(initial.checks.doctor.status, 'PASS', 'missing runtime wiring must still block');
    assert.strictEqual(initial.overall, 'NOT_READY');
    write(root, '.harness/verify-evidence.json', original);
    assert.strictEqual(cli.doctorReport(root).checks.find(c => c.id === 'verify-evidence').status, 'FAIL', 'standalone doctor still validates proof');
  });
}

function testEveryReaderBindsControlContents() {
  for (const exceptions of [true, false]) for (const area of ['runner', 'verdict', 'scheduler']) withRepo(root => {
    const cfg = exceptions ? config() : config({});
    if (!exceptions) cfg.commands.build = 'node -e "process.exit(0)"';
    cfg.verification_policy.identity_inputs = { [area]: [`.harness/${area}.txt`] };
    const file = path.join(root, `.harness/${area}.txt`);
    write(root, `.harness/${area}.txt`, 'original');
    write(root, '.harness/config.json', cfg);
    const evidence = verify(root);
    prepareConsumers(root);
    assert.strictEqual(attestation.verifyEvidence(evidence, { project_root: root }).status, 'PASS');
    assert.strictEqual(consumerResults(root).doctor.status, 'PASS');
    const check = environment => {
      assert.deepStrictEqual(attestation.readGitIdentity(root), evidence.provenance.git);
      const validation = attestation.verifyEvidence(evidence, { project_root: root });
      assert.strictEqual(validation.status, 'FAIL', `${area} control drift must be rejected by shared verifier`);
      assert.match(JSON.stringify(validation.failures), /CONTROL_IDENTITY/);
      const results = consumerResults(root, environment);
      for (const name of ['verification', 'delivery']) {
        assert.strictEqual(results[name].status, 2, `${area}: ${name}`);
        assert.match(results[name].stderr, /CONTROL_IDENTITY/);
      }
      assert.match(results.stage.stdout + results.stage.stderr, /CONTROL_IDENTITY/);
      assert.strictEqual(results.evidenceCli.status, 1);
      assert.match(results.evidenceCli.stdout, /CONTROL_IDENTITY/);
      assert.strictEqual(results.doctor.status, 'FAIL');
      assert.strictEqual(policy.baselineIntegrityAssessment(evidence, { project_root: root }).status, 'INVALID');
    };
    write(root, `.harness/${area}.txt`, 'changed'); check();
    fs.rmSync(file); check();
    write(root, `.harness/${area}.txt`, 'original');
    const preload = path.join(root, '.harness/unreadable-control.js');
    write(root, '.harness/unreadable-control.js', `const fs=require('fs'),read=fs.readFileSync;fs.readFileSync=function(f,...a){if(String(f)===${JSON.stringify(file)})throw Object.assign(Error('probe denied'),{code:'EACCES'});return read.call(this,f,...a)};`);
    const originalRead = fs.readFileSync;
    try {
      fs.readFileSync = function(f, ...args) {
        if (String(f) === file) throw Object.assign(Error('probe denied'), { code: 'EACCES' });
        return originalRead.call(this, f, ...args);
      };
      check({ NODE_OPTIONS: `--require=${preload}` });
    } finally { fs.readFileSync = originalRead; }
    assert.strictEqual(attestation.verifyEvidence(evidence, { project_root: root }).status, 'PASS', 'restored control positive case');
    write(root, `.harness/${area}.txt`, 'updated');
    verify(root);
    assert.strictEqual(consumerResults(root).doctor.status, 'PASS', 'fresh verification recovers');
  });
}

function testControlDeclarationsCannotSilentlyDisableBinding() {
  for (const input of [null, 'runner', [], { runner: 'file.js' }, { runner: [''] }, { runner: ['   '] }, { runner: [null] }, { typo: ['file.js'] }]) {
    assert.throws(() => contractApi.resolveContract({ config: { verification_policy: { identity_inputs: input } }, risk: 'low' }), /CONTRACT_INVALID/);
  }
  withRepo(root => {
    const cfg = config({}); cfg.commands.build = 'node -e "process.exit(0)"';
    cfg.verification_policy.identity_inputs = { runner: ['.harness/runner'] };
    write(root, '.harness/config.json', cfg); write(root, '.harness/runner', 'one');
    const legacy = verify(root);
    delete legacy.provenance.applicability;
    const evidence = attestation.attestEvidence(legacy);
    assert.strictEqual(attestation.verifyEvidence(evidence, { project_root: root }).status, 'PASS');
    write(root, '.harness/runner', 'two');
    assert.strictEqual(attestation.verifyEvidence(evidence, { project_root: root }).status, 'FAIL', 'legacy contract absence cannot remove configured controls');
  });
}

function testDoctorBindsCurrentGitCandidate() {
  withRepo(root => {
    verify(root); prepareConsumers(root);
    const doctor = () => cli.doctorReport(root).checks.find(c => c.id === 'verify-evidence');
    assert.strictEqual(doctor().status, 'PASS');
    write(root, 'README.md', '# changed candidate');
    assert.strictEqual(doctor().status, 'FAIL', 'unstaged current candidate differs');
    assert.match(doctor().message, /GIT_CANDIDATE_MISMATCH/);
    git(root, ['add', 'README.md']);
    assert.strictEqual(doctor().status, 'FAIL', 'staging must not authorize stale proof');
    git(root, ['commit', '-qm', 'new candidate']);
    assert.strictEqual(doctor().status, 'FAIL', 'changed HEAD and tree');
    assert.match(doctor().message, /GIT_COMMIT_MISMATCH/);
    verify(root);
    assert.strictEqual(doctor().status, 'PASS', 'fresh current-candidate proof');
    git(root, ['commit', '--allow-empty', '-qm', 'same tree new commit']);
    assert.strictEqual(doctor().status, 'FAIL', 'same tree does not hide commit drift');
    assert.ok(!cli.doctorReport(root, { environment_only: true }).checks.some(c => c.id === 'verify-evidence'));
    const original = attestation.readGitIdentity;
    try {
      attestation.readGitIdentity = () => ({ available: false });
      assert.match(doctor().message, /GIT_IDENTITY_UNAVAILABLE/);
    } finally { attestation.readGitIdentity = original; }

    const cfg = config({});
    cfg.commands.build = 'node -e "process.exit(0)"';
    write(root, '.harness/config.json', cfg);
    const legacy = verify(root);
    delete legacy.attestation;
    delete legacy.provenance.applicability;
    delete legacy.provenance.git;
    write(root, '.harness/verify-evidence.json', legacy);
    assert.strictEqual(doctor().status, 'PASS', 'genuine legacy evidence without an identity remains compatible');
    const failures = [];
    for (const field of ['provenance.git', 'git_identity']) {
      for (const value of [null, false, '', {}]) {
        const copy = JSON.parse(JSON.stringify(legacy));
        if (field === 'provenance.git') copy.provenance.git = value;
        else copy.git_identity = value;
        write(root, '.harness/verify-evidence.json', copy);
        const result = doctor();
        if (result.status !== 'FAIL' || !/GIT_COMMIT_MISMATCH/.test(result.message)) {
          failures.push(`${field}=${JSON.stringify(value)}: ${JSON.stringify(result)}`);
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testControlIdentityBindsBytesRatherThanDecodedText() {
  withRepo(root => {
    const cfg = config();
    cfg.verification_policy.identity_inputs = { runner: ['.harness/runner.bin'] };
    write(root, '.harness/config.json', cfg);
    const file = path.join(root, '.harness/runner.bin');
    fs.writeFileSync(file, Buffer.from([0x80]));
    const evidence = verify(root);
    fs.writeFileSync(file, Buffer.from([0x81]));
    assert.strictEqual(attestation.verifyEvidence(evidence, { project_root: root }).status, 'FAIL', 'different undecodable bytes must not share control identity');
    fs.writeFileSync(file, Buffer.from([0x80]));
    assert.strictEqual(attestation.verifyEvidence(evidence, { project_root: root }).status, 'PASS');
  });
}

function controlPathFixture(root, kind, area) {
  const good = 'test -f README.md\n';
  let declared;
  let actual;
  let substitute;
  if (kind === 'literal') {
    declared = `.harness/${area}\\control.sh`;
    actual = path.join(root, declared);
    substitute = path.join(root, `.harness/${area}/control.sh`);
  } else {
    const target = path.join(root, `.harness/${area}-physical/child`);
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, path.join(root, `.harness/${area}-link`), 'junction');
    declared = `.harness/${area}-link/../control.sh`;
    actual = path.join(root, `.harness/${area}-physical/control.sh`);
    substitute = path.join(root, '.harness/control.sh');
  }
  for (const file of [actual, substitute]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(actual, good);
  fs.writeFileSync(substitute, 'exit 0 # unrelated substitute\n');
  const cfg = config();
  cfg.verification_policy.identity_inputs = { [area]: [declared] };
  return { declared, actual, substitute, good, cfg };
}

function checkControlPathHelper(kind) {
  for (const area of ['runner', 'verdict', 'scheduler']) withRepo(root => {
    const fixture = controlPathFixture(root, kind, area);
    const { declared, actual, substitute, good, cfg } = fixture;
    const read = () => contractApi.controlIdentity(root, cfg)[`${area}_digest`];
    const expected = contractApi.digest([{ path: declared, content_base64: Buffer.from(good).toString('base64') }]);
    assert.strictEqual(read(), expected, `${kind}/${area} must read the declared physical file`);
    fs.writeFileSync(substitute, 'unrelated changed bytes');
    assert.strictEqual(read(), expected, `${kind}/${area} must ignore substitute bytes`);
    fs.rmSync(substitute);
    assert.strictEqual(read(), expected, `${kind}/${area} must ignore substitute deletion`);
    fs.writeFileSync(actual, Buffer.from([0x80]));
    const first = read();
    fs.writeFileSync(actual, Buffer.from([0x81]));
    assert.notStrictEqual(read(), first, `${kind}/${area} binds undecodable raw bytes`);
    fs.rmSync(actual);
    assert.strictEqual(read(), null, `${kind}/${area} missing declared file fails closed`);
  });
}

function testControlPathLiteralBackslashHelper() { checkControlPathHelper('literal'); }
function testControlPathPhysicalTraversalHelper() { checkControlPathHelper('physical'); }

function testControlPathRootRelativeCompatibility() {
  withRepo(root => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-external-control-'));
    try {
      write(root, '.harness/control.bin', 'local control');
      fs.writeFileSync(path.join(external, 'control.bin'), 'external control');
      const entries = [
        ['.harness/control.bin', 'local control'],
        ['./.harness/control.bin', 'local control'],
        [path.relative(root, path.join(external, 'control.bin')), 'external control'],
        // Preserve the reader's existing root-relative anchoring, not path.resolve semantics.
        [`${path.sep}.harness${path.sep}control.bin`, 'local control'],
      ];
      if (process.platform === 'win32') entries.push(['.harness\\control.bin', 'local control']);
      for (const [declared, contents] of entries) for (const area of ['runner', 'verdict', 'scheduler']) {
        const cfg = config();
        cfg.verification_policy.identity_inputs = { [area]: [declared] };
        assert.strictEqual(contractApi.controlIdentity(root, cfg)[`${area}_digest`],
          contractApi.digest([{ path: declared, content_base64: Buffer.from(contents).toString('base64') }]), `${area}/${declared}`);
      }
    } finally { fs.rmSync(external, { recursive: true, force: true }); }
  });
}

function checkControlPathReaders(kind) {
  const failures = [];
  for (const area of ['runner', 'verdict', 'scheduler']) withRepo(root => {
    const { declared, actual, substitute, good, cfg } = controlPathFixture(root, kind, area);
    cfg.commands.tests = `bash '${declared.replace(/'/g, "'\\''")}'`;
    write(root, '.harness/config.json', cfg);
    const evidence = verify(root);
    prepareConsumers(root);
    const originalEvidence = fs.readFileSync(path.join(root, '.harness/verify-evidence.json'));
    const originalBaseline = fs.readFileSync(path.join(root, '.harness/verification-baseline.json'));
    const originalIndex = fs.readFileSync(path.join(root, '.git/index'));
    const context = () => verifyCache.createContext(root, { config: cfg,
      contract_digest: evidence.provenance.verification.test_manifest_digest });
    const cache = context();
    cache.record('tests', evidence.checks.tests);
    cache.persist();
    const check = (label, accepted, code, environment = {}) => {
      assert.deepStrictEqual(attestation.readGitIdentity(root), evidence.provenance.git, 'control probe must leave candidate identity unchanged');
      const shared = attestation.verifyEvidence(evidence, { project_root: root });
      const baseline = cli.trustedBaseline(root, cfg, cli.verificationIdentity(root, cfg, 'low'), 'low');
      const readers = consumerResults(root, environment);
      const integration = run(root, SHK, ['verify', '--risk', 'low', '--phase', 'integration'], undefined, environment);
      const report = run(root, SHK, ['qa', 'report'], undefined, environment);
      const states = {
        shared: [shared.status === 'PASS', JSON.stringify(shared)],
        baseline: [baseline.assessment.status === 'VALID', JSON.stringify(baseline.assessment)],
        focused: [baseline.cache_seed !== null, JSON.stringify(baseline.focused_assessment)],
        verification: [readers.verification.status === 0, readers.verification.stdout + readers.verification.stderr],
        delivery: [readers.delivery.status === 0, readers.delivery.stdout + readers.delivery.stderr],
        stage: [readers.stage.status === 0 && !/"deny"/.test(readers.stage.stdout), readers.stage.stdout + readers.stage.stderr],
        evidenceCli: [readers.evidenceCli.status === 0, readers.evidenceCli.stdout + readers.evidenceCli.stderr],
        doctor: [readers.doctor.status === 'PASS', JSON.stringify(readers.doctor)],
        integration: [integration.status === 0 && /Full admission: REUSE/.test(integration.stdout), integration.stdout + integration.stderr],
        qa: [report.status === 0, report.stdout + report.stderr],
      };
      for (const [reader, [actualAccepted, output]] of Object.entries(states)) {
        // Admission exposes its own baseline reason codes; consumers expose the control error.
        if (actualAccepted !== accepted || (!accepted && code && reader !== 'integration' && !output.includes(code))) {
          failures.push(`${kind}/${area}/${label}/${reader}: accepted=${actualAccepted} ${output.slice(-700)}`);
        }
      }
      if ((!context().shouldRun('tests')) !== accepted) failures.push(`${kind}/${area}/${label}: incremental cache reused=${!context().shouldRun('tests')}`);
      assert.deepStrictEqual(fs.readFileSync(path.join(root, '.harness/verify-evidence.json')), originalEvidence, 'readers do not re-sign evidence');
      assert.deepStrictEqual(fs.readFileSync(path.join(root, '.harness/verification-baseline.json')), originalBaseline);
      assert.deepStrictEqual(fs.readFileSync(path.join(root, '.git/index')), originalIndex);
    };
    check('fresh', true);
    fs.writeFileSync(substitute, 'different unrelated bytes');
    check('substitute-changed', true);
    fs.writeFileSync(substitute, 'exit 0 # unrelated substitute\n');
    fs.writeFileSync(actual, 'exit 9\n');
    assert.strictEqual(spawnSync('bash', [declared], { cwd: root }).status, 9, 'the declared test command actually changed');
    check('declared-changed', false, 'CONTROL_IDENTITY_MISMATCH');
    fs.rmSync(actual);
    check('declared-deleted', false, 'CONTROL_IDENTITY_UNAVAILABLE');
    fs.writeFileSync(actual, good);
    const preload = path.join(root, '.harness/unreadable-declared-control.js');
    write(root, '.harness/unreadable-declared-control.js', `const fs=require('fs'),read=fs.readFileSync;fs.readFileSync=function(f,...a){let actual;try{actual=fs.realpathSync.native(f)}catch{}if(actual===${JSON.stringify(actual)})throw Object.assign(Error('unreadable declared control'),{code:'EACCES'});return read.call(this,f,...a)};`);
    const originalRead = fs.readFileSync;
    try {
      fs.readFileSync = function(file, ...args) {
        let physical;
        try { physical = fs.realpathSync.native(file); } catch {}
        if (physical === actual) throw Object.assign(Error('unreadable declared control'), { code: 'EACCES' });
        return originalRead.call(this, file, ...args);
      };
      assert.throws(() => fs.readFileSync(`${root}${path.sep}${declared}`), error => error.code === 'EACCES', 'the injected read error targets the actual declared path');
      check('declared-unreadable', false, 'CONTROL_IDENTITY_UNAVAILABLE', { NODE_OPTIONS: `--require=${preload}` });
    } finally { fs.readFileSync = originalRead; }
    check('restored', true);
  });
  assert.deepStrictEqual(failures, [], failures.join('\n'));
}

function testControlPathLiteralBackslashReaders() { checkControlPathReaders('literal'); }
function testControlPathPhysicalTraversalReaders() { checkControlPathReaders('physical'); }

function qaReport(root) {
  const evidencePath = path.join(root, '.harness/verify-evidence.json');
  const evidenceBefore = fs.existsSync(evidencePath) ? fs.readFileSync(evidencePath) : null;
  const indexBefore = fs.readFileSync(path.join(root, '.git/index'));
  const result = run(root, SHK, ['qa', 'report']);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, '.git/index')), indexBefore, 'qa report must not modify the index');
  assert.deepStrictEqual(fs.existsSync(evidencePath) ? fs.readFileSync(evidencePath) : null, evidenceBefore, 'qa report must not rewrite evidence');
  return result;
}

function assertQaRejected(root, code) {
  const verification = run(root, SHK, ['evidence', 'verify', '--current-git', '--format', 'json']);
  assert.strictEqual(verification.status, 1, verification.stdout || verification.stderr);
  assert.ok(JSON.parse(verification.stdout).failures.some(item => item.code === code), verification.stdout);
  const report = qaReport(root);
  assert.strictEqual(report.status, 1, `qa report accepted stale evidence despite ${code}: ${report.stdout}`);
  assert.ok(report.stderr.includes(code), report.stderr);
  assert.ok(!report.stdout.includes('- overall: READY'), 'invalid evidence must not be presented as a current READY report');
}

function testQaReportFreshReady() {
  withRepo(root => {
    verify(root);
    const report = qaReport(root);
    assert.strictEqual(report.status, 0, report.stderr);
    assert.match(report.stdout, /- overall: READY/);
  });
}

function checkQaReportContractDrift(mutation) {
  for (const exceptions of [true, false]) withRepo(root => {
    const cfg = config(exceptions ? undefined : {});
    if (!exceptions) cfg.commands.build = 'node -e "process.exit(0)"';
    const spec = { requirements: ['original'], design: { value: 1 }, acceptance: ['original'] };
    write(root, '.harness/config.json', cfg);
    write(root, '.harness/iteration-spec.json', spec);
    const evidence = verify(root);
    assert.strictEqual(evidence.overall, 'READY');
    assert.strictEqual(run(root, SHK, ['evidence', 'verify', '--format', 'json']).status, 0);
    const fresh = qaReport(root);
    assert.strictEqual(fresh.status, 0, fresh.stderr || fresh.stdout);
    assert.match(fresh.stdout, /- overall: READY/);
    if (mutation === 'ignored-spec') write(root, '.harness/iteration-spec.json', { ...spec, requirements: ['changed'] });
    else write(root, '.harness/config.json', { ...cfg, commands: { ...cfg.commands, tests: 'node -e "process.exit(7)"' } });
    assert.deepStrictEqual(attestation.readGitIdentity(root), evidence.provenance.git, `${mutation} probe must leave Git identity unchanged`);
    assertQaRejected(root, 'APPLICABILITY_CONTRACT_MISMATCH');
    write(root, '.harness/config.json', cfg);
    write(root, '.harness/iteration-spec.json', spec);
    assert.strictEqual(qaReport(root).status, 0, 'restored exact contract accepts the original report');
  });
}

function testQaReportRejectsIgnoredSpecDrift() { checkQaReportContractDrift('ignored-spec'); }
function testQaReportRejectsCommandDrift() { checkQaReportContractDrift('command'); }

function testQaReportBindsCurrentCandidate() {
  withRepo(root => {
    verify(root);
    write(root, 'README.md', '# Changed candidate\n');
    assertQaRejected(root, 'GIT_CANDIDATE_MISMATCH');
    git(root, ['add', 'README.md']);
    assertQaRejected(root, 'GIT_CANDIDATE_MISMATCH');
    git(root, ['commit', '-qm', 'fixture candidate change']);
    assertQaRejected(root, 'GIT_COMMIT_MISMATCH');
    verify(root);
    assert.strictEqual(qaReport(root).status, 0, 'fresh candidate verification recovers');
  });
}

function testQaReportBindsControlsAndAttestation() {
  withRepo(root => {
    const cfg = config();
    cfg.verification_policy.identity_inputs = { runner: ['.harness/runner.txt'] };
    write(root, '.harness/config.json', cfg);
    write(root, '.harness/runner.txt', 'original control');
    const evidence = verify(root);
    write(root, '.harness/runner.txt', 'changed control');
    assertQaRejected(root, 'CONTROL_IDENTITY_MISMATCH');
    fs.rmSync(path.join(root, '.harness/runner.txt'));
    assertQaRejected(root, 'CONTROL_IDENTITY_UNAVAILABLE');
    write(root, '.harness/runner.txt', 'original control');
    assert.strictEqual(qaReport(root).status, 0);
    evidence.checks.tests.summary = 'unattested replacement';
    write(root, '.harness/verify-evidence.json', evidence);
    assertQaRejected(root, 'ATTESTATION_DIGEST_INVALID');
  });
}

function testQaReportPreservesLegacyCompatibilityAndRequiredAttestation() {
  withRepo(root => {
    const cfg = config({});
    write(root, '.harness/config.json', cfg);
    const legacy = { schema_version: '1.0', risk: 'low', overall: 'READY', checks: { tests: { status: 'PASS' } } };
    write(root, '.harness/verify-evidence.json', legacy);
    assert.strictEqual(run(root, SHK, ['evidence', 'verify', '--allow-legacy', '--format', 'json']).status, 0);
    const report = qaReport(root);
    assert.strictEqual(report.status, 0, report.stderr);
    assert.match(report.stdout, /- overall: READY/);
    write(root, '.harness/config.json', { ...cfg, evidence: { require_attestation: true } });
    assertQaRejected(root, 'ATTESTATION_MISSING');
  });
}

function testQaReportPreservesFailedAndMissingReports() {
  withRepo(root => {
    const missing = qaReport(root);
    assert.strictEqual(missing.status, 1);
    assert.match(missing.stderr, /No .*verify-evidence.json/);
    const cfg = config();
    cfg.commands.tests = 'node -e "process.exit(1)"';
    write(root, '.harness/config.json', cfg);
    const failed = run(root, SHK, ['verify', '--risk', 'low', '--write-evidence']);
    assert.strictEqual(failed.status, 1, failed.stderr || failed.stdout);
    const expected = fs.readFileSync(path.join(root, '.harness/verify-evidence.md'), 'utf8').trim();
    write(root, '.harness/config.json', config());
    const report = qaReport(root);
    assert.strictEqual(report.status, 1);
    assert.strictEqual(report.stdout.trim(), expected, 'failed reports retain their diagnostic details even after a contract change');
    assert.match(report.stdout, /- overall: NOT_READY/);
    assert.match(report.stdout, /\| tests \| FAIL \|/);
  });
}

const tests = [testControlPathRootRelativeCompatibility, testControlPathPhysicalTraversalHelper, testControlPathPhysicalTraversalReaders,
  ...(process.platform === 'win32' ? [] : [testControlPathLiteralBackslashHelper, testControlPathLiteralBackslashReaders]),
  testQaReportFreshReady, testQaReportRejectsIgnoredSpecDrift, testQaReportRejectsCommandDrift, testQaReportBindsCurrentCandidate,
  testQaReportBindsControlsAndAttestation, testQaReportPreservesLegacyCompatibilityAndRequiredAttestation,
  testQaReportPreservesFailedAndMissingReports,
  testMalformedLegacyIdentityCannotBecomeUnprotectedEvidence, testLegacyProvenanceIdentityRequiresCurrentGitAndVerifier, testContractEvidenceCannotBecomeLegacyWhenVerifierIsMissing, testControlIdentityBindsBytesRatherThanDecodedText, testEveryReaderBindsControlContents, testControlDeclarationsCannotSilentlyDisableBinding, testDoctorBindsCurrentGitCandidate, testAllPassContractEvidenceRejectsDriftAndMissingVerifier,
  testIncrementalCacheBindsControlContentsAndReadFailures, testReleaseDoctorDoesNotConsumePreviousEvidence, testExplicitApplicabilityProducesDistinctEvidence, testUnboundNotApplicableEvidenceIsRejected,
  testApplicabilityValidationAndReleaseScope, testCapabilitySnapshotAndMissingCommands,
  testEveryConsumerRejectsCurrentContractDrift, testMalformedOrForgedExceptionsAndMissingVerifierFailClosed,
  testCacheAndBaselineDoNotMixPassWithNotApplicable, testEvidenceWithoutExceptionsRetainsLegacyCompatibility,
  testCompleteIgnoredSpecIsBoundToEvidenceAndBaseline,
  testCapabilitySnapshotCannotAuthorizeStaleEvidenceAndFreshRunRecovers,
  testInstallAndUpgradeCarryApplicabilityVerifier];
let passed = 0;
const selectedTests = process.argv.includes('--control-path-only') ? tests.filter(test => test.name.startsWith('testControlPath'))
  : process.argv.includes('--qa-report-only') ? tests.filter(test => test.name.startsWith('testQaReport')) : tests;
for (const test of selectedTests) {
  try { test(); passed += 1; console.log('PASS', test.name); }
  catch (error) { console.error('FAIL', test.name, error.stack || error); process.exitCode = 1; }
}
console.log(`${passed}/${selectedTests.length} applicability tests passed`);

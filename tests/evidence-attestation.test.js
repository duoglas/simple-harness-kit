#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KIT_ROOT = path.resolve(__dirname, '..');
const SHK = path.join(KIT_ROOT, 'scripts/shk.js');
const attestation = require(path.join(KIT_ROOT, 'scripts/lib/evidence-attestation.js'));

function git(dir, args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return String(res.stdout || '').trim();
}

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shk-evidence-')));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'SHK evidence test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function baseEvidence(root, overrides = {}) {
  const identity = attestation.readGitIdentity(root);
  return {
    schema_version: '1.0',
    run_id: 'run-test-1',
    risk: 'high',
    stage: 'VERIFY',
    started_at: '2026-08-04T00:00:00.000Z',
    completed_at: '2026-08-04T00:01:00.000Z',
    checks: { tests: { status: 'PASS' } },
    limitations: [],
    overall: 'READY',
    provenance: {
      git: identity,
      mode: 'full',
    },
    ...overrides,
  };
}

function signed(root, overrides = {}, options = {}) {
  return attestation.attestEvidence(baseEvidence(root, overrides), {
    issuer: { type: 'shk-cli', name: 'unit-test' },
    trust_level: 'local-self',
    ...options,
  });
}

function failureCodes(result) {
  return (result.failures || []).map(item => item.code);
}

function withRepo(fn) {
  const dir = makeRepo();
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function testValidAttestationPasses() {
  withRepo(dir => {
    const evidence = signed(dir);
    const result = attestation.verifyEvidence(evidence, { require_attestation: true });
    assert.strictEqual(result.status, 'PASS', JSON.stringify(result));
    assert.strictEqual(result.attested, true);
    assert.match(evidence.attestation.digest, /^sha256:[a-f0-9]{64}$/);
  });
}

function testProtectedFieldTamperFailsDigest() {
  withRepo(dir => {
    const evidence = signed(dir);
    evidence.checks.tests.status = 'FAIL';
    const result = attestation.verifyEvidence(evidence, { require_attestation: true });
    assert.strictEqual(result.status, 'FAIL');
    assert.ok(failureCodes(result).includes('ATTESTATION_DIGEST_INVALID'), JSON.stringify(result));
  });
}

function testWrongCommitFails() {
  withRepo(dir => {
    const evidence = signed(dir);
    const result = attestation.verifyEvidence(evidence, {
      require_attestation: true,
      expected_commit: '0'.repeat(40),
    });
    assert.ok(failureCodes(result).includes('GIT_COMMIT_MISMATCH'), JSON.stringify(result));
  });
}

function testWrongTreeFails() {
  withRepo(dir => {
    const evidence = signed(dir);
    const result = attestation.verifyEvidence(evidence, {
      require_attestation: true,
      expected_tree: '1'.repeat(40),
    });
    assert.ok(failureCodes(result).includes('GIT_TREE_MISMATCH'), JSON.stringify(result));
  });
}

function testDirtyPolicyFails() {
  withRepo(dir => {
    const identity = attestation.readGitIdentity(dir);
    const evidence = signed(dir, { provenance: { git: { ...identity, dirty: true }, mode: 'full' } });
    const result = attestation.verifyEvidence(evidence, { require_attestation: true, require_clean: true });
    assert.ok(failureCodes(result).includes('EVIDENCE_DIRTY'), JSON.stringify(result));
  });
}

function testIncrementalFailsFullPolicy() {
  withRepo(dir => {
    const identity = attestation.readGitIdentity(dir);
    const evidence = signed(dir, { provenance: { git: identity, mode: 'incremental' } });
    const result = attestation.verifyEvidence(evidence, { require_attestation: true, require_mode: 'full' });
    assert.ok(failureCodes(result).includes('EVIDENCE_MODE_MISMATCH'), JSON.stringify(result));
  });
}

function testInsufficientTrustFails() {
  withRepo(dir => {
    const evidence = signed(dir);
    const result = attestation.verifyEvidence(evidence, { require_attestation: true, min_trust: 'ci-signed' });
    assert.ok(failureCodes(result).includes('EVIDENCE_TRUST_INSUFFICIENT'), JSON.stringify(result));
  });
}

function testLocalIssuerCannotSelfDeclareHigherTrust() {
  withRepo(dir => {
    assert.throws(
      () => signed(dir, {}, { trust_level: 'ci-signed' }),
      /cannot issue unauthenticated trust level: ci-signed/
    );
  });
}

function testRecomputedHighTrustClaimFailsWithoutAuthentication() {
  withRepo(dir => {
    const evidence = signed(dir);
    evidence.attestation.trust_level = 'ci-signed';
    evidence.attestation.digest = attestation.digestEvidence(evidence);
    const result = attestation.verifyEvidence(evidence, {
      require_attestation: true,
      min_trust: 'ci-signed',
    });
    assert.strictEqual(result.status, 'FAIL', JSON.stringify(result));
    assert.ok(failureCodes(result).includes('EVIDENCE_TRUST_UNVERIFIED'), JSON.stringify(result));
    assert.ok(!failureCodes(result).includes('ATTESTATION_DIGEST_INVALID'), JSON.stringify(result));
  });
}

function testAuthenticatedHigherTrustCanSatisfyPolicy() {
  withRepo(dir => {
    const evidence = signed(dir);
    evidence.attestation.trust_level = 'ci-signed';
    evidence.attestation.digest = attestation.digestEvidence(evidence);
    const result = attestation.verifyEvidence(evidence, {
      require_attestation: true,
      min_trust: 'ci-signed',
      authenticated_trust_level: 'ci-signed',
    });
    assert.strictEqual(result.status, 'PASS', JSON.stringify(result));
    assert.ok(result.checks.some(item => item.code === 'EVIDENCE_TRUST_AUTHENTICATED' && item.status === 'PASS'), JSON.stringify(result));
  });
}

function testProtectedScopeIsFixedFormat() {
  withRepo(dir => {
    const evidence = signed(dir);
    evidence.attestation.protected_scope = 'checks-only';
    evidence.attestation.digest = attestation.digestEvidence(evidence);
    const result = attestation.verifyEvidence(evidence, { require_attestation: true });
    assert.strictEqual(result.status, 'FAIL', JSON.stringify(result));
    assert.ok(failureCodes(result).includes('ATTESTATION_UNSUPPORTED'), JSON.stringify(result));
  });
}

function testLegacyBehaviorExplicit() {
  withRepo(dir => {
    const legacy = baseEvidence(dir);
    const compatible = attestation.verifyEvidence(legacy, { allow_legacy: true });
    assert.strictEqual(compatible.status, 'PASS', JSON.stringify(compatible));
    assert.strictEqual(compatible.attested, false);
    assert.strictEqual(compatible.legacy, true);

    const strict = attestation.verifyEvidence(legacy, { require_attestation: true });
    assert.strictEqual(strict.status, 'FAIL');
    assert.ok(failureCodes(strict).includes('ATTESTATION_MISSING'), JSON.stringify(strict));
  });
}

function testLegacyCompatibilityDoesNotBypassOtherPolicies() {
  withRepo(dir => {
    const legacy = baseEvidence(dir, {
      provenance: {
        git: { ...attestation.readGitIdentity(dir), dirty: true },
        mode: 'incremental',
      },
    });
    const result = attestation.verifyEvidence(legacy, {
      allow_legacy: true,
      expected_commit: '0'.repeat(40),
      require_clean: true,
      require_mode: 'full',
      min_trust: 'local-self',
    });
    assert.strictEqual(result.status, 'FAIL', JSON.stringify(result));
    assert.strictEqual(result.legacy, true);
    const codes = failureCodes(result);
    assert.ok(codes.includes('GIT_COMMIT_MISMATCH'), JSON.stringify(result));
    assert.ok(codes.includes('EVIDENCE_DIRTY'), JSON.stringify(result));
    assert.ok(codes.includes('EVIDENCE_MODE_MISMATCH'), JSON.stringify(result));
    assert.ok(codes.includes('EVIDENCE_TRUST_INSUFFICIENT'), JSON.stringify(result));
  });
}

function testCliJsonAndCurrentGit() {
  withRepo(dir => {
    const file = path.join(dir, 'evidence.json');
    fs.writeFileSync(file, `${JSON.stringify(signed(dir), null, 2)}\n`);
    const res = spawnSync(process.execPath, [SHK, 'evidence', 'verify', '--file', file, '--current-git', '--require-clean', '--require-mode', 'full', '--format', 'json'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.strictEqual(res.status, 0, res.stderr || res.stdout);
    const result = JSON.parse(res.stdout);
    assert.strictEqual(result.status, 'PASS', res.stdout);

    fs.writeFileSync(path.join(dir, 'README.md'), '# changed\n');
    git(dir, ['add', 'README.md']);
    git(dir, ['commit', '-q', '-m', 'next']);
    const stale = spawnSync(process.execPath, [SHK, 'evidence', 'verify', '--file', file, '--current-git', '--format', 'json'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.strictEqual(stale.status, 1, stale.stderr || stale.stdout);
    const staleResult = JSON.parse(stale.stdout);
    assert.ok(failureCodes(staleResult).includes('GIT_COMMIT_MISMATCH'), stale.stdout);
    assert.ok(failureCodes(staleResult).includes('GIT_TREE_MISMATCH'), stale.stdout);
  });
}

function testCliRejectsRecomputedUnauthenticatedHighTrust() {
  withRepo(dir => {
    const file = path.join(dir, 'evidence.json');
    const evidence = signed(dir);
    evidence.attestation.trust_level = 'ci-signed';
    evidence.attestation.digest = attestation.digestEvidence(evidence);
    fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
    const res = spawnSync(process.execPath, [SHK, 'evidence', 'verify', '--file', file, '--min-trust', 'ci-signed', '--format', 'json'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.strictEqual(res.status, 1, res.stderr || res.stdout);
    const result = JSON.parse(res.stdout);
    assert.ok(failureCodes(result).includes('EVIDENCE_TRUST_UNVERIFIED'), res.stdout);
  });
}

function testCliRejectsMissingOrUnknownPolicyOptions() {
  withRepo(dir => {
    const file = path.join(dir, 'evidence.json');
    fs.writeFileSync(file, `${JSON.stringify(signed(dir), null, 2)}\n`);
    const missing = spawnSync(process.execPath, [SHK, 'evidence', 'verify', '--file', file, '--min-trust'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.strictEqual(missing.status, 1, missing.stderr || missing.stdout);
    assert.ok(missing.stderr.includes('missing value for evidence verify option: --min-trust'), missing.stderr);

    const unknown = spawnSync(process.execPath, [SHK, 'evidence', 'verify', '--file', file, '--min-trsut', 'ci-signed'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.strictEqual(unknown.status, 1, unknown.stderr || unknown.stdout);
    assert.ok(unknown.stderr.includes('unknown evidence verify option: --min-trsut'), unknown.stderr);
  });
}

const tests = [
  testValidAttestationPasses,
  testProtectedFieldTamperFailsDigest,
  testWrongCommitFails,
  testWrongTreeFails,
  testDirtyPolicyFails,
  testIncrementalFailsFullPolicy,
  testInsufficientTrustFails,
  testLocalIssuerCannotSelfDeclareHigherTrust,
  testRecomputedHighTrustClaimFailsWithoutAuthentication,
  testAuthenticatedHigherTrustCanSatisfyPolicy,
  testProtectedScopeIsFixedFormat,
  testLegacyBehaviorExplicit,
  testLegacyCompatibilityDoesNotBypassOtherPolicies,
  testCliJsonAndCurrentGit,
  testCliRejectsRecomputedUnauthenticatedHighTrust,
  testCliRejectsMissingOrUnknownPolicyOptions,
];

let passed = 0;
for (const test of tests) {
  try {
    test();
    passed += 1;
    console.log('PASS', test.name);
  } catch (err) {
    console.error('FAIL', test.name);
    console.error(err && err.stack || err);
    process.exit(1);
  }
}
console.log(`${passed}/${tests.length} evidence attestation tests passed`);

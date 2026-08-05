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


function testCandidateDigestStableAcrossStaging() {
  withRepo(dir => {
    fs.writeFileSync(path.join(dir, 'README.md'), '# changed\n');
    fs.writeFileSync(path.join(dir, 'new-tool.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const before = attestation.readGitIdentity(dir).candidate_digest;
    git(dir, ['add', 'README.md', 'new-tool.sh']);
    const after = attestation.readGitIdentity(dir).candidate_digest;
    assert.strictEqual(after, before, `candidate digest changed after staging: ${before} -> ${after}`);
  });
}

function testIndexWorktreeSplitIsReportedWithoutBreakingStagingStableDigest() {
  withRepo(dir => {
    fs.writeFileSync(path.join(dir, 'README.md'), '# candidate B\n');
    const beforeStage = attestation.readGitIdentity(dir);
    assert.strictEqual(beforeStage.index_matches_worktree, false);
    assert.deepStrictEqual(beforeStage.index_mismatch_paths, ['README.md']);

    git(dir, ['add', 'README.md']);
    const staged = attestation.readGitIdentity(dir);
    assert.strictEqual(staged.candidate_digest, beforeStage.candidate_digest);
    assert.strictEqual(staged.index_matches_worktree, true);

    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
    const split = attestation.readGitIdentity(dir);
    assert.strictEqual(split.candidate_digest, attestation.candidateDigest(dir, split.commit));
    assert.strictEqual(split.index_matches_worktree, false);
    assert.deepStrictEqual(split.index_mismatch_paths, ['README.md']);
  });
}

function testCandidateDigestChangesWithTrackedAndUntrackedContent() {
  withRepo(dir => {
    const clean = attestation.readGitIdentity(dir).candidate_digest;
    fs.writeFileSync(path.join(dir, 'README.md'), '# tracked change\n');
    const tracked = attestation.readGitIdentity(dir).candidate_digest;
    assert.notStrictEqual(tracked, clean);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'one\n');
    const untracked = attestation.readGitIdentity(dir).candidate_digest;
    assert.notStrictEqual(untracked, tracked);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'two\n');
    const untrackedChanged = attestation.readGitIdentity(dir).candidate_digest;
    assert.notStrictEqual(untrackedChanged, untracked);
  });
}


function testCandidateDigestBindsSubmoduleGitlinkAndRejectsDirtySubmodule() {
  withRepo(dir => {
    const child = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shk-submodule-')));
    try {
      git(child, ['init', '-q']);
      git(child, ['config', 'user.email', 'submodule@example.com']);
      git(child, ['config', 'user.name', 'SHK submodule test']);
      fs.writeFileSync(path.join(child, 'payload.txt'), 'one\n');
      git(child, ['add', 'payload.txt']);
      git(child, ['commit', '-q', '-m', 'one']);
      const one = git(child, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(child, 'payload.txt'), 'two\n');
      git(child, ['commit', '-qam', 'two']);
      const two = git(child, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(child, 'payload.txt'), 'three\n');
      git(child, ['commit', '-qam', 'three']);
      const three = git(child, ['rev-parse', 'HEAD']);

      const added = spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'deps/child'], {
        cwd: dir, encoding: 'utf8'
      });
      assert.strictEqual(added.status, 0, added.stderr || added.stdout);
      git(path.join(dir, 'deps/child'), ['checkout', '-q', one]);
      git(dir, ['add', '.gitmodules', 'deps/child']);
      git(dir, ['commit', '-q', '-m', 'add submodule at one']);
      const digestOne = attestation.readGitIdentity(dir).candidate_digest;

      git(path.join(dir, 'deps/child'), ['checkout', '-q', two]);
      const beforeStage = attestation.readGitIdentity(dir);
      assert.strictEqual(beforeStage.available, false);
      assert.strictEqual(beforeStage.index_matches_worktree, false);
      assert.strictEqual(beforeStage.candidate_digest, null,
        'unstaged gitlink checkout must not produce an authoritative candidate');
      git(dir, ['add', 'deps/child']);
      const stagedTwo = attestation.readGitIdentity(dir);
      assert.strictEqual(stagedTwo.index_matches_worktree, true);
      assert.notStrictEqual(stagedTwo.candidate_digest, digestOne, 'different gitlinks must never share a candidate digest');

      // Exercise the actual index/checkout split directly. The index OID is what
      // Git commits, so a cacheinfo-only change must make identity unavailable.
      git(dir, ['update-index', '--cacheinfo', '160000', three, 'deps/child']);
      const cacheinfoSplit = attestation.readGitIdentity(dir);
      assert.strictEqual(cacheinfoSplit.available, false);
      assert.strictEqual(cacheinfoSplit.index_matches_worktree, false);
      assert.strictEqual(cacheinfoSplit.candidate_digest, null);
      git(dir, ['update-index', '--cacheinfo', '160000', two, 'deps/child']);
      assert.strictEqual(attestation.readGitIdentity(dir).candidate_digest, stagedTwo.candidate_digest);

      git(path.join(dir, 'deps/child'), ['checkout', '-q', three]);
      git(dir, ['add', 'deps/child']);
      const stagedThree = attestation.readGitIdentity(dir);
      assert.strictEqual(stagedThree.index_matches_worktree, true);
      assert.notStrictEqual(stagedThree.candidate_digest, stagedTwo.candidate_digest,
        'two distinct non-baseline gitlink OIDs must never collapse to the same candidate digest');

      fs.writeFileSync(path.join(dir, 'deps/child/payload.txt'), 'dirty worktree\n');
      const dirty = attestation.readGitIdentity(dir);
      assert.strictEqual(dirty.available, false);
      assert.strictEqual(dirty.candidate_digest, null);

      fs.rmSync(path.join(dir, 'deps/child'), { recursive: true, force: true });
      const uninitialized = attestation.readGitIdentity(dir);
      assert.strictEqual(uninitialized.available, false);
      assert.strictEqual(uninitialized.candidate_digest, null);
    } finally {
      fs.rmSync(child, { recursive: true, force: true });
    }
  });
}

function testGeneratedEvidenceDoesNotChangeCandidateDigest() {
  withRepo(dir => {
    fs.writeFileSync(path.join(dir, 'README.md'), '# candidate\n');
    const before = attestation.readGitIdentity(dir).candidate_digest;
    const generated = [
      '.harness/verify-evidence.json',
      '.harness/verify-evidence.md',
      'docs/verification-report.md',
      'docs/tasks/T-test/evidence/verify-evidence.json',
      'docs/tasks/T-test/evidence/verify-evidence.md',
    ];
    for (const rel of generated) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `generated ${rel}\n`);
    }
    const afterCreate = attestation.readGitIdentity(dir).candidate_digest;
    assert.strictEqual(afterCreate, before);
    for (const rel of generated) fs.appendFileSync(path.join(dir, rel), 'updated\n');
    const afterUpdate = attestation.readGitIdentity(dir).candidate_digest;
    assert.strictEqual(afterUpdate, before);
  });
}

function testExpectedCandidateDigestMismatchFails() {
  withRepo(dir => {
    const evidence = signed(dir);
    const result = attestation.verifyEvidence(evidence, {
      require_attestation: true,
      expected_candidate_digest: `sha256:${'0'.repeat(64)}`,
    });
    assert.ok(failureCodes(result).includes('GIT_CANDIDATE_MISMATCH'), JSON.stringify(result));
  });
}

function testCliJsonAndCurrentGit() {
  withRepo(dir => {
    const file = path.join(dir, '.harness', 'verify-evidence.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
  testCandidateDigestStableAcrossStaging,
  testIndexWorktreeSplitIsReportedWithoutBreakingStagingStableDigest,
  testCandidateDigestChangesWithTrackedAndUntrackedContent,
  testCandidateDigestBindsSubmoduleGitlinkAndRejectsDirtySubmodule,
  testGeneratedEvidenceDoesNotChangeCandidateDigest,
  testExpectedCandidateDigestMismatchFails,
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

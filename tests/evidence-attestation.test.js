#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KIT_ROOT = path.resolve(__dirname, '..');
const SHK = path.join(KIT_ROOT, 'scripts/shk.js');
const VERIFY_GATE = path.join(KIT_ROOT, 'scripts/hooks/verification-gate.js');
const attestation = require(path.join(KIT_ROOT, 'scripts/lib/evidence-attestation.js'));

function git(dir, args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return String(res.stdout || '').trim();
}

function installedStandardCredentialHelpers() {
  const helpers = ['cache --timeout=120', 'store --file ~/.fixture-credentials'];
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (execPath.status === 0 && fs.existsSync(path.join(execPath.stdout.trim(), 'git-credential-osxkeychain'))) helpers.unshift('osxkeychain');
  return helpers;
}

function makeRepo(objectFormat) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shk-evidence-')));
  git(dir, ['init', '-q', ...(objectFormat ? [`--object-format=${objectFormat}`] : [])]);
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

function withRepo(fn, objectFormat) {
  const dir = makeRepo(objectFormat);
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
    assert.deepStrictEqual(attestation.readGitIdentity(dir).index_mismatch_paths, ['README.md'],
      'actual generated reports must also stay outside the index/worktree comparison');
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

function prepareDeliveryEvidence(dir) {
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\n.harness/\n');
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness/current-stage.json'), JSON.stringify({
    stage: 'REVIEW', since: '2020-01-01T00:00:00Z', task: 'delivery repository binding',
  }));
  fs.writeFileSync(path.join(dir, '.harness/config.json'), JSON.stringify({ evidence: { require_attestation: true } }));
  fs.writeFileSync(path.join(dir, '.harness/verify-evidence.json'), JSON.stringify(signed(dir, {
    risk: 'release', checks: {
      tests: { status: 'PASS' }, e2e: { status: 'PASS' },
      e2e_sufficiency: { status: 'PASS', overall: 'READY' }, runtime: { status: 'PASS' },
    },
  })));
}

function deliveryGate(dir, command, environment = {}, context = {}) {
  return spawnSync(process.execPath, [VERIFY_GATE], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, HARNESS_GUARD_MODE: 'strict', HARNESS_SKIP_GATE: '0', ...environment },
    input: JSON.stringify({ ...context, tool_input: { ...context.tool_input, command } }),
  });
}

function testVerificationGateBindsActualRepository() {
  withRepo(dir => withRepo(other => {
    fs.writeFileSync(path.join(other, 'README.md'), '# a different repository candidate\n');
    git(other, ['commit', '-qam', 'different candidate']);
    assert.notStrictEqual(git(dir, ['rev-parse', 'HEAD']), git(other, ['rev-parse', 'HEAD']));
    prepareDeliveryEvidence(dir);
    fs.mkdirSync(path.join(dir, 'subdir'));
    const q = value => `'${value.replace(/'/g, "'\\''")}'`;
    for (const command of [
      'git -C . push origin HEAD',
      'git -C subdir -C .. push origin HEAD',
      `git -C ${q(dir)} tag v-context`,
      'git --git-dir=.git --work-tree=. commit -m context',
      'env -C . git push origin HEAD',
      'env --chdir=subdir git -C .. push origin HEAD',
      'command git -c user.name=test push origin HEAD',
      'nohup git push origin HEAD',
    ]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
    const failures = [];
    for (const action of ['commit -m context', 'tag v-context', 'push origin HEAD']) {
      for (const prefix of [
        `git -C ${q(other)}`,
        `git -C${q(other)}`,
        `git --git-dir=${q(path.join(other, '.git'))} --work-tree=${q(other)}`,
        `git --git-dir=${q(path.join(other, '.git'))} --work-tree=${q(dir)}`,
        `env -C ${q(other)} git`,
        `env --chdir=${q(other)} git`,
        `sudo -D ${q(other)} git`,
        'sudo -R / git',
      ]) {
        const command = `${prefix} ${action}`;
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !/GIT_DELIVERY_(?:REPOSITORY|COMMAND)/.test(result.stderr)) {
          failures.push(`${command}: exit=${result.status} ${result.stderr}`);
        }
      }
    }
    for (const command of [
      `cd ${q(other)} && git push origin HEAD`,
      `env -C ${q(other)} sh -c 'git push origin HEAD'`,
      `git -C ${q(path.join(other, 'missing'))} push origin HEAD`,
    ]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2 || !/GIT_DELIVERY_(?:REPOSITORY|COMMAND)/.test(result.stderr)) {
        failures.push(`${command}: exit=${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testVerificationGateRejectsImplicitTagDelivery() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    for (const command of [
      'git push --follow-tags origin HEAD',
      'git -c push.followTags=true push origin HEAD',
    ]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 2, `${command}: ${result.stderr}`);
      assert.match(result.stderr, /GIT_DELIVERY_(?:TARGET_UNBOUND|CONFIG_UNAVAILABLE)/);
    }
    git(dir, ['config', 'push.followTags', 'true']);
    const implicit = deliveryGate(dir, 'git push origin HEAD');
    assert.strictEqual(implicit.status, 2, implicit.stderr);
    assert.match(implicit.stderr, /GIT_DELIVERY_TARGET_UNBOUND/);
    const positional = deliveryGate(dir, 'git push -- --no-follow-tags HEAD');
    assert.strictEqual(positional.status, 2, positional.stderr);
    assert.match(positional.stderr, /GIT_DELIVERY_TARGET_UNBOUND/);
    for (const command of [
      'git push --no-follow-tags origin HEAD',
      'git -c push.followTags=false push origin HEAD',
    ]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
    for (const command of [
      'git -c push.followTags=invalid push origin HEAD',
      'git -cpush.followTags=true push origin HEAD',
    ]) {
      const invalid = deliveryGate(dir, command);
      assert.strictEqual(invalid.status, 2, `${command}: ${invalid.stderr}`);
      assert.match(invalid.stderr, /GIT_DELIVERY_(?:CONFIG_UNAVAILABLE|REPOSITORY_UNBOUND|COMMAND_AMBIGUOUS)/);
    }

    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-git-config-failure-'));
    try {
      const executable = process.platform === 'win32' ? 'git.exe' : 'git';
      const realGit = process.env.PATH.split(path.delimiter).map(item => path.join(item, executable))
        .find(item => fs.existsSync(item) && fs.statSync(item).isFile());
      assert.ok(realGit, 'Git executable must be available for the config-read failure probe');
      fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\n`
        + `const args = process.argv.slice(2);\n`
        + `if (args.includes('config') && args.includes(process.env.SHK_TEST_FAIL_CONFIG)) process.exit(128);\n`
        + `const result = require('child_process').spawnSync(${JSON.stringify(realGit)}, args, {stdio: 'inherit'});\n`
        + `process.exit(result.status === null ? 128 : result.status);\n`, { mode: 0o755 });
      for (const key of ['push.followTags', 'push.recurseSubmodules', 'submodule.recurse']) {
        const unreadable = deliveryGate(dir, 'git push --no-follow-tags origin HEAD', {
          PATH: `${bin}${path.delimiter}${process.env.PATH}`, SHK_TEST_FAIL_CONFIG: key,
        });
        assert.strictEqual(unreadable.status, 2, unreadable.stderr);
        assert.match(unreadable.stderr, /GIT_DELIVERY_CONFIG_UNAVAILABLE/);
      }
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
}

function testVerificationGateRejectsWrappedShellContextChanges() {
  withRepo(dir => withRepo(other => {
    fs.writeFileSync(path.join(other, 'README.md'), '# wrapped context candidate\n');
    git(other, ['commit', '-qam', 'wrapped context candidate']);
    const otherHead = git(other, ['rev-parse', 'HEAD']);
    assert.notStrictEqual(git(dir, ['rev-parse', 'HEAD']), otherHead);
    prepareDeliveryEvidence(dir);
    const q = value => `'${value.replace(/'/g, "'\\''")}'`;
    const vars = `GIT_DIR=${q(path.join(other, '.git'))} GIT_WORK_TREE=${q(other)}`;
    const mutations = [
      `command cd ${q(other)}`,
      `command -p cd ${q(other)}`,
      `builtin cd ${q(other)}`,
      `command builtin cd ${q(other)}`,
      `builtin command cd ${q(other)}`,
      `command command builtin cd ${q(other)}`,
      `builtin builtin command -p cd ${q(other)}`,
      `command -- builtin command -- cd ${q(other)}`,
      `command export ${vars}`,
      `builtin declare -x ${vars}`,
      `command typeset -x ${vars}`,
      `command readonly ${vars}; command export GIT_DIR GIT_WORK_TREE`,
      `command pushd ${q(other)}`,
      `builtin pushd -n ${q(other)}; builtin popd`,
    ];
    const failures = [];
    for (const mutation of mutations) {
      // Execute only the context mutation and a read-only Git query. The
      // delivery strings below go to the hook's stdin and are never executed.
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c',
        `${mutation} && git rev-parse --show-toplevel HEAD`], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, `${mutation}: ${actual.stderr}`);
      assert.deepStrictEqual(actual.stdout.trim().split('\n').slice(-2), [other, otherHead], mutation);
      for (const action of ['commit -m context', 'tag v-context', 'push origin HEAD']) {
        const command = `${mutation} && git ${action}`;
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
          failures.push(`${command}: exit=${result.status} ${result.stderr}`);
        }
      }
    }
    for (const mutation of [
      'builtin unset GIT_DIR', 'command local -x GIT_DIR=other',
      'command builtin declare -x GIT_CONFIG_COUNT=1',
      'builtin command readonly GIT_WORK_TREE=other',
      'command hash -r', 'builtin set -a',
      'builtin printf -v GIT_DIR other',
    ]) {
      const command = `${mutation}; git push origin HEAD`;
      const result = deliveryGate(dir, command);
      if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
        failures.push(`${command}: exit=${result.status} ${result.stderr}`);
      }
    }
    for (const command of [
      'command nice git push origin HEAD',
      'builtin command /usr/bin/g?t push origin HEAD',
    ]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
        failures.push(`${command}: exit=${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    for (const command of [
      'command git -C . push origin HEAD',
      'command -p git -c user.name=test push origin HEAD',
      'builtin command git push origin HEAD',
      'command builtin command git push origin HEAD',
      'builtin builtin command -p git push origin HEAD',
    ]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  }));
}

function testVerificationGateBindsDecodedDeliveryContext() {
  withRepo(dir => withRepo(other => {
    fs.writeFileSync(path.join(other, 'README.md'), '# decoded context candidate\n');
    git(other, ['commit', '-qam', 'decoded context candidate']);
    const otherHead = git(other, ['rev-parse', 'HEAD']);
    assert.notStrictEqual(git(dir, ['rev-parse', 'HEAD']), otherHead);
    prepareDeliveryEvidence(dir);
    const q = value => `'${value.replace(/'/g, "'\\''")}'`;
    const forms = [
      action => `command cd ${q(other)} && g'it' ${action}`,
      action => `builtin cd ${q(other)} && g\\it ${action}`,
      action => `command -p cd ${q(other)} && 'git' ${action}`,
      action => `command cd ${q(other)} && bash -c ${q(`g'it' ${action}`)}`,
      action => `bash -c ${q(`builtin cd ${q(other)} && g'it' ${action}`)}`,
      action => `builtin export GIT_DIR=${q(path.join(other, '.git'))} GIT_WORK_TREE=${q(other)}; g'it' ${action}`,
    ];
    const failures = [];
    for (const form of forms) {
      const query = form('rev-parse --show-toplevel HEAD');
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', query], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, `${query}: ${actual.stderr}`);
      assert.deepStrictEqual(actual.stdout.trim().split('\n').slice(-2), [other, otherHead], query);
      for (const action of ["co''mmit -m decoded", "t\\ag v-decoded", "pu''sh origin HEAD"]) {
        const command = form(action);
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
          failures.push(`${command}: exit=${result.status} ${result.stderr}`);
        }
      }
    }
    for (const command of [
      "g'it' co\\\nmmit -m continued", "g'it' co''mmit>/tmp/shk-decoded-redirection -m test",
      "{ g'it' pu''sh origin HEAD; }",
    ]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
        failures.push(`${command}: exit=${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    for (const command of [
      `command cd ${q(other)} && g'it' status`,
      `builtin cd ${q(other)} && pwd`,
      `bash -c ${q(`command cd ${q(other)} && git status`)}`,
      "command g'it' -C . pu''sh origin HEAD",
    ]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
    const marker = path.join(other, '.git/static-cd-callback-ran');
    const callback = path.join(other, '.git/static-cd-callback.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
    git(other, ['config', 'core.fsmonitor', callback]);
    for (const command of [`command cd ${q(other)} && git status`,
      `bash -c ${q(`cd ${q(other)} && git status`)}`]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 2, `${command}: ${result.stderr}`);
      assert.ok(!fs.existsSync(marker), 'static cd probe executed the destination callback');
    }
    for (const command of [`env cd ${q(other)}; git status`, `nohup cd ${q(other)}; git status`]) {
      assert.strictEqual(deliveryGate(dir, command).status, 2, 'a child-process cd must not be replayed as a parent-shell directory change');
    }
  }));
}

function testVerificationGateRejectsShellStartupContext() {
  withRepo(dir => withRepo(other => {
    fs.writeFileSync(path.join(other, 'README.md'), '# shell startup candidate\n');
    git(other, ['commit', '-qam', 'shell startup candidate']);
    const otherHead = git(other, ['rev-parse', 'HEAD']);
    assert.notStrictEqual(git(dir, ['rev-parse', 'HEAD']), otherHead);
    prepareDeliveryEvidence(dir);
    const q = value => `'${value.replace(/'/g, "'\\''")}'`;
    const startup = path.join(other, 'startup.sh');
    fs.writeFileSync(startup, `cd ${q(other)}\n`);
    const forms = [
      action => `BASH_ENV=${q(startup)} bash -c ${q(`git ${action}`)}`,
      action => `env BASH_ENV=${q(startup)} bash -c ${q(`g'it' ${action}`)}`,
      action => `command env BASH_ENV=${q(startup)} bash -c ${q(`git ${action}`)}`,
    ];
    const failures = [];
    for (const form of forms) {
      const query = form('rev-parse --show-toplevel HEAD');
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', query], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, `${query}: ${actual.stderr}`);
      assert.deepStrictEqual(actual.stdout.trim().split('\n').slice(-2), [other, otherHead], query);
      for (const action of ['commit -m startup', 'tag v-startup', "pu''sh origin HEAD"]) {
        const command = form(action);
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
          failures.push(`${command}: exit=${result.status} ${result.stderr}`);
        }
      }
    }
    for (const environment of [
      { BASH_ENV: startup },
      { 'BASH_FUNC_git%%': `() { command git -C ${q(other)} "$@"; }` },
    ]) {
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', 'git rev-parse --show-toplevel HEAD'], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, ...environment },
      });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.deepStrictEqual(actual.stdout.trim().split('\n').slice(-2), [other, otherHead]);
      for (const command of ['git push origin HEAD', "bash -c 'git push origin HEAD'"]) {
        const result = deliveryGate(dir, command, environment);
        if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
          failures.push(`${Object.keys(environment)} ${command}: exit=${result.status} ${result.stderr}`);
        }
      }
    }
    for (const command of [
      `ZDOTDIR=${q(other)} zsh -c 'git push origin HEAD'`,
      `env ENV=${q(startup)} sh -c 'git push origin HEAD'`,
      `bash --rcfile ${q(startup)} -ic 'git push origin HEAD'`,
      "bash -lc 'git push origin HEAD'", "zsh -c 'git push origin HEAD'",
      "zsh -f +f -c 'git push origin HEAD'", "zsh -f -o rcs -c 'git push origin HEAD'",
      "zsh -f --rcs -c 'git push origin HEAD'",
    ]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
        failures.push(`${command}: exit=${result.status} ${result.stderr}`);
      }
    }
    for (const name of ['ENV', 'ZDOTDIR']) {
      const result = deliveryGate(dir, "sh -c 'git push origin HEAD'", { [name]: startup });
      if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
        failures.push(`inherited ${name}: exit=${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    for (const command of [
      "bash -c 'git push origin HEAD'", "sh -c 'command git -C . push origin HEAD'",
      "bash --noprofile --norc -lc 'git push origin HEAD'", "zsh -f -c 'git push origin HEAD'",
    ]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  }));
}

function testVerificationGateRejectsUnparsedShellDelivery() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const failures = [];
    const commands = [
      "bash <<< 'git push origin HEAD'",
      "bash <<'SCRIPT'\ngit push origin HEAD\nSCRIPT",
      '{git,} push origin HEAD',
      '{gi,x}t push origin HEAD',
      "$'\\x67it' push origin HEAD",
      "git $'\\x70ush' origin HEAD",
      "$'g\\151t' push origin HEAD",
      "$'gi\\'t' push origin HEAD",
      "$\"git\" push origin HEAD",
      "echo 'git push origin HEAD' | bash",
      "printf '%s\\n' 'git push origin HEAD' | sh -s",
      "timeout 10 bash -c 'git push origin HEAD'",
      "nice sh -c 'git push origin HEAD'",
      "xargs -0 sh -c 'git push origin HEAD'",
      "timeout 10 sh -c \"g'it' pu''sh origin HEAD\"",
      "nice bash -c \"\\$'\\x67it' push origin HEAD\"",
      "env -S 'git push origin HEAD'",
      "env --split-string='git push origin HEAD'",
      "env -S'git push origin HEAD'",
      "watch 'git push origin HEAD'",
      "watch $'git push origin HEAD'",
      "watch \"$'\\x67it' push origin HEAD\"",
      "unknown-wrapper $'\\x67it push origin HEAD'",
      "unknown-wrapper \"g'it' pu''sh origin HEAD\"",
    ];
    for (const command of commands) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
        failures.push(`${command}: exit=${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    for (const command of [
      'git push origin HEAD', 'command git -C . push origin HEAD',
      'env -C . git push origin HEAD', "bash -c 'git push origin HEAD'",
      "zsh -f -c 'git push origin HEAD'", "g'it' pu''sh origin HEAD",
      'git status', "bash -c 'git status'", "echo 'git push origin HEAD'",
      "printf '%s\\n' 'git push origin HEAD'", 'node --version',
    ]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  });
}

function testVerificationGateRejectsImplicitSubmoduleDelivery() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const failures = [];
    for (const command of [
      'git -c push.recurseSubmodules=on-demand push origin HEAD',
      'git -c push.recurseSubmodules=only push origin HEAD',
      'git -c submodule.recurse=true push --no-follow-tags origin HEAD',
      'git -c push.recurseSubmodules=invalid push origin HEAD',
      'git -c submodule.recurse=invalid push origin HEAD',
      'git -c push.recurseSubmodules=on-demand -c submodule.recurse=false push origin HEAD',
    ]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2 || !/GIT_DELIVERY_(?:TARGET_UNBOUND|CONFIG_UNAVAILABLE|REPOSITORY_UNBOUND)/.test(result.stderr)) {
        failures.push(`${command}: exit=${result.status} ${result.stderr}`);
      }
    }
    for (const [key, value] of [['push.recurseSubmodules', 'on-demand'], ['submodule.recurse', 'true']]) {
      git(dir, ['config', key, value]);
      const result = deliveryGate(dir, 'git push --no-follow-tags origin HEAD');
      if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_TARGET_UNBOUND')) {
        failures.push(`${key}=${value}: exit=${result.status} ${result.stderr}`);
      }
      git(dir, ['config', '--unset', key]);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    for (const command of [
      'git -c push.recurseSubmodules=no push origin HEAD',
      'git -c push.recurseSubmodules=check push origin HEAD',
      'git -c submodule.recurse=false push origin HEAD',
      'git -c submodule.recurse=true -c push.recurseSubmodules=no push origin HEAD',
      'git push --no-follow-tags origin HEAD',
    ]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  });
}

function testVerificationGateBindsToolInvocationCwd() {
  withRepo(dir => withRepo(other => {
    prepareDeliveryEvidence(dir);
    fs.mkdirSync(path.join(dir, 'nested'));
    const failures = [];
    for (const context of [
      { cwd: other }, { tool_input: { cwd: other } }, { tool_input: { workdir: other } },
      { cwd: dir, tool_input: { workdir: path.relative(dir, other) } },
      { cwd: dir, tool_input: { cwd: dir, workdir: other } },
      { cwd: path.join(dir, 'missing') }, { tool_input: { workdir: '' } },
    ]) {
      for (const action of ['push origin HEAD', 'tag v-cwd', 'commit -m cwd']) {
        const result = deliveryGate(dir, `git ${action}`, {}, context);
        if (result.status !== 2 || !/GIT_DELIVERY_REPOSITORY_(?:MISMATCH|UNBOUND)/.test(result.stderr)) {
          failures.push(`${JSON.stringify(context)} git ${action}: exit=${result.status} ${result.stderr}`);
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    for (const context of [
      { cwd: dir }, { tool_input: { workdir: dir } }, { cwd: path.join(dir, 'nested') },
      { cwd: dir, tool_input: { workdir: 'nested' } },
      { cwd: other, tool_input: { workdir: dir } },
    ]) {
      const result = deliveryGate(dir, 'git push origin HEAD', {}, context);
      assert.strictEqual(result.status, 0, `${JSON.stringify(context)}: ${result.stderr}`);
    }
  }));
}

function testVerificationGateHandlesEnvNamesAndExportedFunctions() {
  withRepo(dir => withRepo(other => {
    prepareDeliveryEvidence(dir);
    const q = value => `'${value.replace(/'/g, "'\\''")}'`;
    const functionValue = action => `BASH_FUNC_git%%=() { command git -C ${q(other)} ${action}; }`;
    const actual = spawnSync('env', [functionValue('rev-parse --show-toplevel'), 'bash', '--noprofile', '--norc', '-c', 'git rev-parse --show-toplevel'], {
      cwd: dir, encoding: 'utf8',
    });
    assert.strictEqual(actual.status, 0, actual.stderr);
    assert.strictEqual(actual.stdout.trim(), other);
    for (const prefix of ['env', 'env --', 'command env']) {
      for (const action of ['push origin HEAD', 'tag v-env', 'commit -m env']) {
        const command = `${prefix} ${q(functionValue(action))} bash -c ${q(`git ${action}`)}`;
        const result = deliveryGate(dir, command);
        assert.strictEqual(result.status, 2, `${command}: ${result.stderr}`);
        assert.match(result.stderr, /GIT_DELIVERY_COMMAND_AMBIGUOUS/);
      }
    }
    for (const command of [
      "env FOO-BAR=1 bash -c 'git push origin HEAD'",
      "env 'name.with.dots=value' bash -c 'git push origin HEAD'",
      "env -- '-name=value' bash -c 'git push origin HEAD'",
      "command env FOO-BAR=1 git push origin HEAD",
    ]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
    fs.rmSync(path.join(dir, '.harness/verify-evidence.json'));
    const noEvidence = deliveryGate(dir, "env FOO-BAR=1 bash -c 'git push origin HEAD'");
    assert.strictEqual(noEvidence.status, 2, noEvidence.stderr);
    assert.match(noEvidence.stderr, /未找到验证报告/);
  }));
}

function testVerificationGateDoesNotTreatTagOptionValuesAsReadOnly() {
  withRepo(dir => {
    fs.appendFileSync(path.join(dir, 'README.md'), 'second candidate\n');
    git(dir, ['commit', '-qam', 'second candidate']);
    prepareDeliveryEvidence(dir);
    const failures = [];
    for (const options of [
      "-m '--list'", "--message '--delete'", "-F '--verify'", "--file '--list'",
      "-u '--list'", "--local-user '--list'", "--cleanup '--list' -m note",
      "-am '--list'", "-em '--list'", "--trailer '--list' -m note", '--message=--list', '-m--list',
    ]) {
      const stale = deliveryGate(dir, `git tag ${options} v-parser HEAD~1`);
      if (stale.status !== 2 || !stale.stderr.includes('GIT_DELIVERY_TARGET_MISMATCH')) {
        failures.push(`${options}: exit=${stale.status} ${stale.stderr}`);
      }
      const current = deliveryGate(dir, `git tag ${options} v-parser HEAD`);
      assert.strictEqual(current.status, 0, `${options}: ${current.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    for (const option of ['--mess', '--loc', '--trai']) {
      const result = deliveryGate(dir, `git tag ${option} '--list' v-parser HEAD~1`);
      assert.strictEqual(result.status, 2, `${option}: ${result.stderr}`);
    }
    fs.rmSync(path.join(dir, '.harness/verify-evidence.json'));
    for (const command of ['git tag', 'git tag --list', 'git tag -n1', "git tag --list 'v*'", 'git tag --contains HEAD']) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  });
}

function testVerificationGateRejectsOptionsAfterShellCommandFlag() {
  withRepo(dir => withRepo(other => {
    prepareDeliveryEvidence(dir);
    const q = value => `'${value.replace(/'/g, "'\\''")}'`;
    const forms = [
      script => `bash -c -e ${q(script)}`,
      script => `bash -c +e ${q(script)}`,
      script => `bash -c -x ${q(script)}`,
      script => `sh -c -e ${q(script)}`,
      script => `bash -c -- ${q(script)}`,
      script => `bash -c -o errexit ${q(script)}`,
      script => `zsh -fc -e ${q(script)}`,
      script => `command env FOO-BAR=1 bash -c -e ${q(script)}`,
    ];
    const failures = [];
    for (const form of forms) {
      const query = form(`git -C ${q(other)} rev-parse --show-toplevel`);
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', query], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, `${query}: ${actual.stderr}`);
      assert.strictEqual(actual.stdout.trim(), other);
      for (const command of ['git push origin HEAD', 'git tag v-shell-flags', 'git commit -m shell-flags']) {
        const result = deliveryGate(dir, form(command));
        if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
          failures.push(`${form(command)}: exit=${result.status} ${result.stderr}`);
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    for (const command of [
      "bash -ec 'git push origin HEAD'", "bash -e -c 'git push origin HEAD'",
      "bash -c 'git push origin HEAD' -- -e", "zsh -fc 'git push origin HEAD'",
      "bash -c 'git status'",
    ]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  }));
}

function testVerificationGateTreatsTagDisplayOptionsAsCreationModifiers() {
  withRepo(dir => {
    fs.appendFileSync(path.join(dir, 'README.md'), 'new tag candidate\n');
    git(dir, ['commit', '-qam', 'new tag candidate']);
    prepareDeliveryEvidence(dir);
    const failures = [];
    for (const options of ['--sort=refname', '--sort refname', '--format=x', '--format x', '--column', '--column=always',
      "--sort refname --format=x --column -m '--list'", "--sort '--list' --format '--list'"]) {
      const stale = deliveryGate(dir, `git tag ${options} v-display HEAD~1`);
      if (stale.status !== 2 || !stale.stderr.includes('GIT_DELIVERY_TARGET_MISMATCH')) {
        failures.push(`${options}: exit=${stale.status} ${stale.stderr}`);
      }
      const current = deliveryGate(dir, `git tag ${options} v-display HEAD`);
      assert.strictEqual(current.status, 0, `${options}: ${current.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    fs.rmSync(path.join(dir, '.harness/verify-evidence.json'));
    for (const command of ['git tag --sort=refname', 'git tag --sort refname', 'git tag --format x', 'git tag --column',
      "git tag --list --sort refname --format=x 'v*'", "git tag --contains HEAD 'v*'", 'git tag -n1']) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  });
}

function testVerificationGateRejectsUnboundPlumbingDelivery() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const commands = [
      ['send-pack', '../bare.git HEAD:refs/heads/master'],
      ['receive-pack', '../bare.git'], ['http-push', 'https://example.com/repo.git HEAD:refs/heads/master'],
      ['update-ref', 'refs/tags/v-plumbing HEAD'], ['update-ref', 'refs/heads/new HEAD'],
      ['update-ref', '--stdin'], ['fast-import', '--quiet'],
      ['symbolic-ref', 'refs/tags/v-plumbing refs/heads/master'], ['symbolic-ref', '--delete refs/tags/v-plumbing'],
      ['symbolic-ref', '$refs'], ['symbolic-ref', 'refs/*'],
    ];
    const failures = [];
    for (const [subcommand, args] of commands) {
      for (const prefix of [`git ${subcommand}`, `git-${subcommand}`, `/usr/libexec/git-core/git-${subcommand}`,
        `command env FOO-BAR=1 git ${subcommand}`, `timeout 10 git-${subcommand}`]) {
        const command = `${prefix} ${args}`;
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
          failures.push(`${command}: exit=${result.status} ${result.stderr}`);
        }
      }
    }
    for (const command of ['git-push origin HEAD', '/usr/libexec/git-core/git-tag v-helper HEAD',
      'git-commit -m helper', 'command git-merge other', 'timeout 10 git-push origin HEAD',
      '/usr/libexec/git-core/git-pu?h origin HEAD', 'timeout 10 git-upd*te-ref refs/tags/v-helper HEAD',
      "watch 'git-send-pack ../bare.git HEAD:refs/heads/main'"]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
        failures.push(`${command}: exit=${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    fs.rmSync(path.join(dir, '.harness/verify-evidence.json'));
    for (const command of ['git status', 'git show-ref', 'git symbolic-ref HEAD', 'git symbolic-ref --short HEAD',
      'git-symbolic-ref HEAD', 'git rev-parse HEAD']) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  });
}

function testVerificationGateRejectsExtglobExecutables() {
  withRepo(dir => withRepo(other => {
    const executable = process.platform === 'win32' ? 'git.exe' : 'git';
    const realGit = process.env.PATH.split(path.delimiter).map(item => path.join(item, executable))
      .find(item => fs.existsSync(item) && fs.statSync(item).isFile());
    assert.ok(realGit);
    const helper = path.join(dir, '.harness/extglob');
    fs.mkdirSync(helper, { recursive: true });
    fs.symlinkSync(realGit, path.join(helper, 'git'));
    prepareDeliveryEvidence(dir);
    const q = value => `'${value.replace(/'/g, "'\\''")}'`;
    const failures = [];
    for (const pattern of ['g@(it)', '@(git)', 'g+(it)', 'g!(xx)', 'g?(it)', 'g*(it)']) {
      const command = `${q(helper)}/${pattern} -C ${q(other)} rev-parse --show-toplevel`;
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-O', 'extglob', '-c', command], {
        cwd: dir, encoding: 'utf8',
      });
      assert.strictEqual(actual.status, 0, `${command}: ${actual.stderr}`);
      assert.strictEqual(actual.stdout.trim(), other);
      for (const script of [
        `${q(helper)}/${pattern} -C ${q(other)} push origin HEAD`,
        `${pattern} push origin HEAD`,
      ]) {
        for (const input of [script, `bash -O extglob -c ${q(script)}`]) {
          const result = deliveryGate(dir, input);
          if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS')) {
            failures.push(`${input}: exit=${result.status} ${result.stderr}`);
          }
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    for (const command of ["bash -O extglob -c 'git push origin HEAD'", "echo 'g@(it)'", 'git status']) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  }));
}

function testVerificationGatePreservesEmptyArguments() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    for (const command of ["git -C '' push origin HEAD", 'git -C "" commit -m empty-cwd',
      "command git -C '' push origin HEAD", "bash -c \"git -C '' push origin HEAD\"", "env MARK='' git -C '' push origin HEAD"]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
    fs.rmSync(path.join(dir, '.harness/verify-evidence.json'));
    for (const command of ["git -C '' push", "git -C '' commit", "command git -C '' commit",
      "bash -c \"git -C '' push origin HEAD\"", "env MARK='' git -C '' commit -m test"]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 2, `${command}: ${result.stderr}`);
    }
  });
}

function testVerificationGateRejectsShellExecutionEnvironment() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const failures = [];
    for (const name of ['PS4', 'SHELLOPTS', 'BASHOPTS', 'PROMPT_COMMAND', 'PS0', 'PS1', 'PS2', 'PROMPT', 'RPROMPT']) {
      for (const command of [`env ${name}='unverified' bash -c ':'`, `${name}='unverified' bash -c ':'`,
        `export ${name}='unverified'; bash -c ':'`, `${name}='unverified'; set -x; :`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
      const inherited = deliveryGate(dir, "bash -c ':'", { [name]: 'unverified' });
      if (inherited.status !== 2) failures.push(`inherited ${name}: ${inherited.status} ${inherited.stderr}`);
    }
    const exploit = deliveryGate(dir, "env PS4='$(git push origin HEAD)' SHELLOPTS=xtrace bash -c ':'");
    if (exploit.status !== 2) failures.push(`PS4 exploit: ${exploit.status} ${exploit.stderr}`);
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    assert.strictEqual(deliveryGate(dir, "env LANG=C bash -c 'git status'").status, 0);
  });
}

function testVerificationGateRejectsExecutableGitConfiguration() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const callback = path.join(dir, '.harness/callback.sh');
    const marker = path.join(dir, '.harness/callback-ran');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
    const failures = [];
    const cases = [
      ['core.fsmonitor', callback, 'status'], ['core.pager', callback, 'log'], ['diff.external', callback, 'diff'],
      ['diff.test.textconv', callback, 'show'], ['filter.test.clean', callback, 'add README.md'],
      ['filter.test.process', callback, 'status'], ['core.sshCommand', callback, 'push origin HEAD'],
      ['gpg.program', callback, 'commit -S -m test'], ['credential.helper', `!${callback}`, 'push origin HEAD'],
      ['core.hooksPath', path.join(dir, '.harness/hooks'), 'commit -m test'],
    ];
    for (const [key, value, action] of cases) {
      const command = `git -c '${key}=${value}' ${action}`;
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
      assert.ok(!fs.existsSync(marker), 'gate introspection executed a supplied callback');
    }
    const envConfig = deliveryGate(dir, 'git --config-env=core.fsmonitor=SHK_MONITOR status', { SHK_MONITOR: callback });
    if (envConfig.status !== 2) failures.push(`--config-env: ${envConfig.status}`);
    for (const command of [`git push --receive-pack='${callback}' origin HEAD`, `git push --exec='${callback}' origin HEAD`,
      `git fetch --no-tags 'ext::${callback}' HEAD`, 'git fetch --no-tags custom-helper://example/repo HEAD',
      `git config core.fsmonitor '${callback}'; git status`]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
      assert.ok(!fs.existsSync(marker), 'gate introspection executed an explicit callback');
    }
    for (const [key, value, action] of cases) {
      git(dir, ['config', key, value]);
      const result = deliveryGate(dir, `git ${action}`, key === 'core.pager' ? { GIT_PAGER: undefined } : {});
      if (result.status !== 2) failures.push(`ambient ${key}: ${result.status} ${result.stderr}`);
      assert.ok(!fs.existsSync(marker), 'gate introspection executed an ambient callback');
      git(dir, ['config', '--unset-all', key]);
    }
    git(dir, ['config', 'core.pager', callback]);
    assert.strictEqual(deliveryGate(dir, 'git --paginate status', { GIT_PAGER: undefined }).status, 2, 'forced pager must not bypass callback inspection');
    git(dir, ['config', '--unset-all', 'core.pager']);
    fs.writeFileSync(path.join(dir, '.git/hooks/pre-push'), `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
    const hook = deliveryGate(dir, 'git push origin HEAD');
    if (hook.status !== 2) failures.push(`ambient default hook: ${hook.status}`);
    fs.rmSync(path.join(dir, '.git/hooks/pre-push'));
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    for (const command of ['git -c user.name=fixture status', 'git -c color.ui=false diff --stat',
      'git -c core.fsmonitor=false status', 'git --no-pager log -1 --oneline']) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
    const installedGh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/opt/local/bin/gh'].find(file => fs.existsSync(file));
    for (const helper of [...installedStandardCredentialHelpers(), ...(installedGh ? [`!${installedGh} auth git-credential`] : [])]) {
      git(dir, ['config', 'credential.helper', helper]);
      const result = deliveryGate(dir, 'git push origin HEAD');
      assert.strictEqual(result.status, 0, `${helper}: ${result.stderr}`);
    }
    git(dir, ['config', 'credential.helper', `!${callback}`]);
    assert.strictEqual(deliveryGate(dir, 'git status').status, 0, 'read-only status cannot invoke a credential helper');
    git(dir, ['config', '--unset-all', 'credential.helper']);
  });
}

function testVerificationGateRejectsUnboundGitExtensions() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    for (const command of ['git subtree push --prefix=src origin main', 'git-subtree push --prefix=src origin main',
      'git custom-extension arg', 'git-custom-extension arg', 'command env LANG=C git-subtree push origin main']) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 2, `${command}: ${result.stderr}`);
    }
    for (const command of ['git status', 'git diff --stat', 'git log -1 --oneline', 'git add -n README.md',
      'git branch --show-current', 'git show-ref', 'git version']) {
      assert.strictEqual(deliveryGate(dir, command).status, 0, command);
    }
  });
}

function testVerificationGateRequiresReleaseForActualTagReferences() {
  withRepo(dir => {
    git(dir, ['update-ref', 'refs/tags/v-reference', 'HEAD']);
    prepareDeliveryEvidence(dir);
    const tagCommands = ['git push origin HEAD:refs/tags/v-remote', 'git push origin refs/tags/v-reference',
      'git push origin v-reference', 'git push origin v-reference:refs/heads/mirror'];
    const writeEvidence = (risk, checks) => fs.writeFileSync(path.join(dir, '.harness/verify-evidence.json'), JSON.stringify(signed(dir, { risk, checks })));
    writeEvidence('low', { tests: { status: 'PASS' } });
    for (const command of tagCommands) assert.strictEqual(deliveryGate(dir, command).status, 2, command);
    assert.strictEqual(deliveryGate(dir, 'git push origin HEAD:refs/heads/normal').status, 0);
    writeEvidence('release', { tests: { status: 'PASS' } });
    for (const command of tagCommands) assert.strictEqual(deliveryGate(dir, command).status, 2, command);
    prepareDeliveryEvidence(dir);
    for (const command of tagCommands) assert.strictEqual(deliveryGate(dir, command).status, 0, command);
    for (const command of ['git fetch . HEAD:refs/tags/v-fetched', 'git fetch --tags origin',
      'git fetch --no-tags . HEAD:refs/tags/v-fetched', 'git fetch origin', 'git remote update', 'git remote add -f fixture .']) {
      assert.strictEqual(deliveryGate(dir, command).status, 2, command);
    }
    git(dir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    for (const command of ['git fetch --no-tags --no-recurse-submodules origin', 'git fetch --no-tags --no-recurse-submodules origin HEAD',
      "git fetch --no-tags --no-recurse-submodules origin '+refs/heads/*:refs/remotes/origin/*'"]) {
      assert.strictEqual(deliveryGate(dir, command).status, 0, command);
    }
    git(dir, ['config', 'remote.origin.tagOpt', '--no-tags']);
    assert.strictEqual(deliveryGate(dir, 'git fetch --no-recurse-submodules origin').status, 0);
  });
}

function testGitIdentityProbesDoNotRunCallbacks() {
  withRepo(dir => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-git-callback-'));
    try {
      const marker = path.join(probe, 'ran');
      const callback = path.join(probe, 'callback.sh');
      fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
      git(dir, ['config', 'core.fsmonitor', callback]);
      git(dir, ['status', '--porcelain']);
      assert.ok(fs.existsSync(marker), 'plain Git status must prove the fixture callback is executable');
      fs.rmSync(marker);
      assert.strictEqual(attestation.readGitIdentity(dir).available, true);
      assert.ok(!fs.existsSync(marker), 'shared identity read executed fsmonitor');
      git(dir, ['config', '--unset', 'core.fsmonitor']);
      fs.appendFileSync(path.join(dir, 'README.md'), 'modified\n');
      git(dir, ['config', 'diff.external', callback]);
      git(dir, ['diff']);
      assert.ok(fs.existsSync(marker), 'plain Git diff must prove the fixture callback is executable');
      fs.rmSync(marker);
      assert.strictEqual(attestation.readGitIdentity(dir).available, true);
      assert.ok(!fs.existsSync(marker), 'shared identity read executed external diff');
    } finally { fs.rmSync(probe, { recursive: true, force: true }); }
  });
}

function testGitIdentityProbesDisableHooks() {
  withRepo(dir => {
    const marker = path.join(dir, '.git/callback-ran');
    const hook = path.join(dir, '.git/hooks/post-index-change');
    const readme = path.join(dir, 'README.md');
    fs.writeFileSync(hook, `#!/bin/sh\nprintf hook >> '${marker}'\n`, { mode: 0o755 });
    const touch = offset => { const time = new Date(Date.now() + offset); fs.utimesSync(readme, time, time); };
    touch(5000);
    git(dir, ['status', '--porcelain']);
    assert.ok(fs.existsSync(marker), 'plain Git status must prove post-index-change is executable');
    fs.rmSync(marker);
    touch(10000);
    assert.strictEqual(attestation.readGitIdentity(dir).available, true);
    assert.ok(!fs.existsSync(marker), 'shared identity read executed post-index-change hook');
    fs.rmSync(hook);
  });
}

function testGitIdentityProbesRejectFilters() {
  withRepo(dir => {
    const marker = path.join(dir, '.git/callback-ran');
    const readme = path.join(dir, 'README.md');
    const callback = path.join(dir, '.git/filter.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf filter >> '${marker}'\ncat\n`, { mode: 0o755 });
    git(dir, ['config', 'filter.fixture.clean', callback]);
    fs.writeFileSync(path.join(dir, '.git/info/attributes'), 'README.md filter=fixture\n');
    fs.appendFileSync(readme, 'modified\n');
    git(dir, ['diff']);
    assert.ok(fs.existsSync(marker), 'plain Git diff must prove clean filter is executable');
    fs.rmSync(marker);
    assert.strictEqual(attestation.readGitIdentity(dir).available, false, 'active clean filter must fail closed');
    assert.ok(!fs.existsSync(marker), 'shared identity read executed a clean filter');
    git(dir, ['config', '--unset', 'filter.fixture.clean']);
    git(dir, ['config', 'filter.fixture.process', callback]);
    assert.strictEqual(attestation.readGitIdentity(dir).available, false, 'active process filter must fail closed');
    assert.ok(!fs.existsSync(marker), 'shared identity read executed a process filter');
  });
}

function testGitIdentityProbesRejectSubmoduleFilters() {
  withRepo(dir => withRepo(remote => {
    git(dir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', remote, 'deps/child']);
    git(dir, ['commit', '-qam', 'add child']);
    assert.strictEqual(attestation.readGitIdentity(dir).available, true, 'ordinary populated submodule remains supported');
    const child = path.join(dir, 'deps/child');
    const marker = path.join(dir, '.git/child-filter-ran');
    const callback = path.join(dir, '.git/child-filter.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf child >> '${marker}'\ncat\n`, { mode: 0o755 });
    const attributes = path.resolve(child, git(child, ['rev-parse', '--git-path', 'info/attributes']));
    fs.writeFileSync(attributes, 'README.md filter=fixture\n');
    git(child, ['config', 'filter.fixture.clean', callback]);
    fs.writeFileSync(path.join(child, 'README.md'), '# fixturE\n');
    git(dir, ['status', '--porcelain']);
    assert.ok(fs.existsSync(marker), 'plain parent status must prove the child filter is executable');
    fs.rmSync(marker);
    assert.strictEqual(attestation.readGitIdentity(dir).available, false);
    assert.ok(!fs.existsSync(marker), 'shared parent identity read executed a child clean filter');
    git(child, ['config', '--unset', 'filter.fixture.clean']);
    git(child, ['config', 'filter.fixture.process', callback]);
    assert.strictEqual(attestation.readGitIdentity(dir).available, false);
    assert.ok(!fs.existsSync(marker), 'shared parent identity read executed a child process filter');
    git(child, ['config', '--unset', 'filter.fixture.process']);
    fs.writeFileSync(path.join(child, 'README.md'), '# fixture\n');
    assert.strictEqual(attestation.readGitIdentity(dir).available, true, 'removing callbacks restores normal gitlink identity');
  }));
}

function testGitCallbacksPreserveCaseSensitiveSubsections() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const marker = path.join(dir, '.git/case-filter-ran');
    const callback = path.join(dir, '.git/case-filter.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf case >> '${marker}'\ncat\n`, { mode: 0o755 });
    git(dir, ['config', 'filter.A.clean', callback]);
    git(dir, ['config', 'filter.a.clean', '']);
    fs.writeFileSync(path.join(dir, '.git/info/attributes'), 'README.md filter=A\n');
    fs.appendFileSync(path.join(dir, 'README.md'), 'modified\n');
    git(dir, ['diff']);
    assert.ok(fs.existsSync(marker), 'Git must keep filter.A separate from filter.a');
    fs.rmSync(marker);
    const failures = [];
    const result = deliveryGate(dir, 'git status');
    if (result.status !== 2) failures.push('gate overwrote the active case-sensitive filter');
    assert.ok(!fs.existsSync(marker), 'gate probe executed the case-sensitive filter');
    if (attestation.readGitIdentity(dir).available !== false) failures.push('reader overwrote the active case-sensitive filter');
    if (fs.existsSync(marker)) failures.push('identity probe executed the case-sensitive filter');
    assert.deepStrictEqual(failures, []);
  });
}

function testGitCallbackCapabilitiesCoverContentAndSignatureReaders() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const marker = path.join(dir, '.git/reader-callback-ran');
    const callback = path.join(dir, '.git/reader-callback.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\ncat "$1"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '.git/info/attributes'), 'README.md diff=fixture\n');
    git(dir, ['config', 'diff.fixture.textconv', callback]);
    const failures = [];
    for (const args of [['cat-file', '--textconv', 'HEAD:README.md'], ['blame', 'README.md'], ['grep', '--textconv', 'fixture']]) {
      git(dir, args);
      assert.ok(fs.existsSync(marker), `plain git ${args[0]} must execute the textconv fixture`);
      fs.rmSync(marker);
      const result = deliveryGate(dir, `git ${args.join(' ')}`);
      if (result.status !== 2) failures.push(`${args.join(' ')}: ${result.status} ${result.stderr}`);
      assert.ok(!fs.existsSync(marker), 'gate executed a textconv callback');
    }
    git(dir, ['config', '--unset', 'diff.fixture.textconv']);
    git(dir, ['config', 'gpg.program', callback]);
    for (const command of ['git tag -v signed-fixture', 'git tag --verify signed-fixture',
      'git tag -sm message signed-fixture', 'git tag -asm message signed-fixture']) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    for (const boolean of ['true', 'yes', '1', 'on', 'TRUE']) {
      git(dir, ['config', 'tag.gpgSign', boolean]);
      if (deliveryGate(dir, 'git tag -m message signed-fixture').status !== 2) failures.push(`tag.gpgSign=${boolean}`);
      git(dir, ['config', 'log.showSignature', boolean]);
      if (deliveryGate(dir, 'git log -1 HEAD').status !== 2) failures.push(`log.showSignature=${boolean}`);
    }
    assert.ok(!fs.existsSync(marker), 'gate executed a signature callback');
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitCallbackVariantsBindEditorsAndExplicitPrograms() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const callback = path.join(dir, '.git/editor.sh');
    const marker = path.join(dir, '.git/editor-ran');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
    git(dir, ['config', 'core.editor', callback]);
    const failures = [];
    for (const command of ['git branch --edit-description', 'git commit -m message --edit',
      'git commit --edit -m message', 'git commit -em message', 'git tag -am message --edit v-editor',
      `git grep -O${callback} fixture`, `git grep --open-files-in-pager=${callback} fixture`,
      `git --exec-path=${path.join(dir, '.git')} ls-remote https://example.invalid/repo`,
      'git add -p README.md', 'git restore --patch README.md', 'git commit -m message --ed',
      'git commit -p -m message', 'git commit --interactive -m message',
      `git grep --open-files-in-page=${callback} fixture`]) {
      const result = deliveryGate(dir, command, { GIT_EDITOR: undefined });
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    for (const command of ['git tag -l', "git tag '--list=v*'", 'git tag v-lightweight',
      'git commit -m --edit', 'git commit -m message --no-edit', 'git tag -am --edit v-message',
      'git commit -i -m message',
      'git grep -e --open-files-in-pager README.md']) {
      const result = deliveryGate(dir, command);
      if (result.status !== 0) failures.push(`positive ${command}: ${result.status} ${result.stderr}`);
    }
    assert.ok(!fs.existsSync(marker), 'gate executed an editor or explicit program');
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitEffectiveCallbackEnvironmentAndPagerPrecedence() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const failures = [];
    for (const command of [
      "env -u GIT_PAGER PAGER='callback' git -p rev-parse HEAD",
      "PAGER='callback' env -u GIT_PAGER git -p rev-parse HEAD",
      "env -u GIT_EDITOR -u VISUAL EDITOR='callback' git commit",
      "TERM=xterm VISUAL='callback' env -u GIT_EDITOR git commit",
      "env SSH_ASKPASS='callback' git push origin HEAD",
      "SSH_ASKPASS='callback' git ls-remote origin",
      "env -u GIT_PAGER PAGER='callback' bash -c 'git -p rev-parse HEAD'",
      "EDITOR='callback' bash -c 'env -u GIT_EDITOR -u VISUAL git commit'",
      'unset GIT_PAGER; export PAGER=callback; git -p rev-parse HEAD',
      "unset GIT_PAGER; export PAGER=callback; bash -c 'git -p rev-parse HEAD'",
      "bash -c 'unset GIT_PAGER; export PAGER=callback; git -p rev-parse HEAD'",
      'EDITOR=callback; git commit --edit -m message',
    ]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    for (const command of ['git log -1 --oneline', 'git diff --stat', 'git show --stat HEAD',
      'git branch', 'git tag -l', "env PAGER='callback' GIT_PAGER=cat git -p log -1",
      'GIT_EDITOR=true EDITOR=callback git commit --edit -m message',
      'TERM=dumb VISUAL=callback EDITOR=true env -u GIT_EDITOR git commit --edit -m message']) {
      const result = deliveryGate(dir, command, { GIT_PAGER: 'cat', PAGER: 'less', GIT_EDITOR: 'true' });
      if (result.status !== 0) failures.push(`priority ${command}: ${result.status} ${result.stderr}`);
    }
    for (const pager of ['less', 'less -FRX', 'cat']) {
      git(dir, ['config', 'core.pager', pager]);
      const result = deliveryGate(dir, 'git log -1', { GIT_PAGER: undefined, PAGER: 'callback' });
      if (result.status !== 0) failures.push(`core.pager=${pager}: ${result.status} ${result.stderr}`);
    }
    git(dir, ['config', '--unset', 'core.pager']);
    const less = deliveryGate(dir, 'git diff', { GIT_PAGER: undefined, PAGER: 'less -FRX' });
    if (less.status !== 0) failures.push(`PAGER=less -FRX: ${less.stderr}`);
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitFetchExpandsEffectiveRemoteAndConfiguredMappings() {
  withRepo(dir => withRepo(remote => {
    prepareDeliveryEvidence(dir);
    const branch = git(dir, ['symbolic-ref', '--short', 'HEAD']);
    const sourceBranch = git(remote, ['symbolic-ref', '--short', 'HEAD']);
    git(dir, ['remote', 'add', 'audit', remote]);
    git(dir, ['config', 'remote.audit.fetch', `refs/heads/${sourceBranch}:refs/tags/mapped-fetch`]);
    git(dir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    git(dir, ['config', 'remote.origin.tagOpt', '--no-tags']);
    git(dir, ['config', `branch.${branch}.remote`, 'audit']);
    const dry = spawnSync('git', ['fetch', '--dry-run', '--no-tags', '--no-recurse-submodules', 'audit', sourceBranch], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(dry.status, 0, dry.stderr);
    assert.match(dry.stderr, /mapped-fetch/, 'Git must prove the explicit source still selects the configured tag destination');
    assert.ok(!fs.existsSync(path.join(dir, '.git/refs/tags/mapped-fetch')), dry.stderr);
    const failures = [];
    for (const command of ['git fetch --no-tags --no-recurse-submodules',
      `git fetch --no-tags --no-recurse-submodules audit ${sourceBranch}`,
      'git fetch --no-tags --no-recurse-submodules audit HEAD']) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    git(dir, ['config', 'remote.audit.fetch', '+refs/heads/*:refs/remotes/audit/*']);
    git(dir, ['config', 'remote.audit.tagOpt', '--no-tags']);
    for (const boolean of ['true', 'yes', '1', 'on']) {
      git(dir, ['config', 'fetch.all', boolean]);
      if (deliveryGate(dir, 'git fetch --no-tags --no-recurse-submodules').status !== 2) failures.push(`fetch.all=${boolean}`);
      git(dir, ['config', '--unset', 'fetch.all']);
      git(dir, ['config', 'fetch.recurseSubmodules', boolean]);
      if (deliveryGate(dir, 'git fetch --no-tags audit').status !== 2) failures.push(`fetch.recurseSubmodules=${boolean}`);
    }
    git(dir, ['config', '--unset', 'fetch.recurseSubmodules']);
    if (deliveryGate(dir, 'git fetch --no-tags audit').status !== 2) failures.push('default recursive on-demand fetch');
    for (const command of ['git fetch --no-tags --no-recurse-submodules audit',
      'git fetch --no-tags --no-recurse-submodules', 'git fetch --no-recurse-submodules',
      'git fetch --no-tags --recurse-submodules=no audit',
      `git fetch --no-tags --no-recurse-submodules audit ${sourceBranch}`]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 0) failures.push(`positive ${command}: ${result.status} ${result.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testGitDoubleQuotedBackslashesBindTheActualRepository() {
  withRepo(original => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-quoted-repository-'));
    try {
      const a = path.join(parent, 'repoq');
      const b = path.join(parent, 'repo\\q');
      fs.cpSync(original, a, { recursive: true }); fs.cpSync(original, b, { recursive: true });
      prepareDeliveryEvidence(a); prepareDeliveryEvidence(b);
      const spelling = `"${b}"`;
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', `git -C ${spelling} rev-parse --show-toplevel`], { cwd: a, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.strictEqual(fs.realpathSync(actual.stdout.trim()), fs.realpathSync(b));
      assert.strictEqual(deliveryGate(a, `git -C ${spelling} push origin HEAD`).status, 2, 'A evidence must not authorize the actual B directory');
      for (const command of [`git -C ${spelling} push origin HEAD`, `git -C "${b.replace(/\\/g, '\\\\')}" push origin HEAD`]) {
        const result = deliveryGate(b, command);
        assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
      }
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
}

function testGitReflogAndStashDisplayCallbacks() {
  withRepo(dir => {
    fs.appendFileSync(path.join(dir, 'README.md'), 'second commit\n'); git(dir, ['commit', '-qam', 'second']);
    fs.appendFileSync(path.join(dir, 'README.md'), 'stashed patch\n'); git(dir, ['stash', 'push', '-qm', 'fixture']);
    prepareDeliveryEvidence(dir);
    const marker = path.join(dir, '.git/display-callback-ran');
    const callback = path.join(dir, '.git/display.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
    const commands = ['git reflog show --ext-diff -p -1', 'git reflog --ext-diff -p -1', 'git stash show --ext-diff -p', 'git stash list --ext-diff -p'];
    git(dir, ['config', 'diff.external', callback]);
    const failures = [];
    for (const command of commands) {
      git(dir, command.split(' ').slice(1));
      assert.ok(fs.existsSync(marker), `${command} must prove the display callback executes`);
      fs.rmSync(marker);
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
      assert.ok(!fs.existsSync(marker));
    }
    git(dir, ['config', '--unset', 'diff.external']);
    git(dir, ['config', 'gpg.program', callback]);
    if (deliveryGate(dir, 'git reflog show --show-signature -1').status !== 2) failures.push('reflog signature callback');
    git(dir, ['config', '--unset', 'gpg.program']);
    for (const command of ['git stash show -p', 'git stash show --patch', 'git stash show --stat', 'git stash list -p', 'git reflog show -p -1']) {
      const result = deliveryGate(dir, command);
      if (result.status !== 0) failures.push(`positive ${command}: ${result.status} ${result.stderr}`);
    }
    assert.strictEqual(deliveryGate(dir, 'git stash push -p').status, 2, 'stash push remains interactive');
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitFetchRejectsEffectivePruneTags() {
  withRepo(dir => withRepo(remote => {
    prepareDeliveryEvidence(dir); git(remote, ['tag', 'v-pruned-reference']);
    git(dir, ['remote', 'add', 'audit', remote]);
    const command = 'git fetch --no-tags --no-recurse-submodules audit';
    const failures = [];
    for (const key of ['fetch.pruneTags', 'remote.audit.pruneTags']) {
      git(dir, ['config', key, 'yes']);
      for (const prune of ['true', 'false']) {
        git(dir, ['config', 'fetch.prune', prune]);
        for (const options of [[], ['--no-prune']]) {
          const dry = spawnSync('git', ['fetch', '--dry-run', '--no-tags', '--no-recurse-submodules', 'audit', ...options], { cwd: dir, encoding: 'utf8' });
          assert.strictEqual(dry.status, 0, dry.stderr); assert.match(dry.stderr, /v-pruned-reference/);
          if (deliveryGate(dir, `${command} ${options.join(' ')}`).status !== 2) failures.push(`${key} prune=${prune} ${options}`);
        }
        const result = deliveryGate(dir, `${command} --no-prune-tags`);
        if (result.status !== 0) failures.push(`${key} --no-prune-tags: ${result.stderr}`);
        const safe = spawnSync('git', ['fetch', '--dry-run', '--no-tags', '--no-recurse-submodules', 'audit', '--no-prune-tags'], { cwd: dir, encoding: 'utf8' });
        assert.strictEqual(safe.status, 0, safe.stderr); assert.doesNotMatch(safe.stderr, /v-pruned-reference/);
      }
      git(dir, ['config', '--unset', key]);
    }
    git(dir, ['config', 'fetch.pruneTags', 'true']); git(dir, ['config', 'remote.audit.pruneTags', 'false']);
    assert.strictEqual(deliveryGate(dir, command).status, 0, 'remote false overrides global pruneTags');
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testGitProtectedUploadPackAndAlternateRefsCallbacks() {
  withRepo(dir => withRepo(remote => {
    fs.appendFileSync(path.join(remote, 'README.md'), 'new object to transfer\n');
    git(remote, ['commit', '-qam', 'remote object']);
    prepareDeliveryEvidence(dir);
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-protected-callback-'));
    try {
      const marker = path.join(probe, 'ran');
      const callback = path.join(probe, 'upload-pack.sh');
      const globalConfig = path.join(probe, 'global');
      fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\nshift\nexec git "$@"\n`, { mode: 0o755 });
      git(dir, ['config', '--file', globalConfig, 'uploadpack.packObjectsHook', callback]);
      git(dir, ['config', 'uploadpack.packObjectsHook', '']);
      const environment = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
      const cloneTarget = path.join(probe, 'clone');
      const actual = spawnSync('git', ['clone', '-q', '--no-local', remote, cloneTarget], { cwd: dir, encoding: 'utf8', env: environment });
      assert.strictEqual(actual.status, 0, actual.stderr); assert.ok(fs.existsSync(marker)); fs.rmSync(marker);
      git(dir, ['remote', 'add', 'audit', remote]);
      const failures = [];
      for (const command of [`git clone --no-local '${remote}' '${cloneTarget}-next'`, 'git fetch --no-tags --no-recurse-submodules audit']) {
        const result = deliveryGate(dir, command, environment);
        if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
        assert.ok(!fs.existsSync(marker));
      }
      const fetched = spawnSync('git', ['fetch', '--no-tags', '--no-recurse-submodules', 'audit'], { cwd: dir, encoding: 'utf8', env: environment });
      assert.strictEqual(fetched.status, 0, fetched.stderr); assert.ok(fs.existsSync(marker)); fs.rmSync(marker);
      git(dir, ['config', '--unset', 'uploadpack.packObjectsHook']); fs.writeFileSync(globalConfig, '');
      assert.strictEqual(deliveryGate(dir, 'git fetch --no-tags --no-recurse-submodules audit', environment).status, 0);
      fs.mkdirSync(path.join(dir, '.git/objects/info'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git/objects/info/alternates'), `${path.join(remote, '.git/objects')}\n`);
      fs.writeFileSync(callback, `#!/bin/sh\nprintf alternate >> '${marker}'\n`, { mode: 0o755 });
      git(dir, ['config', 'core.alternateRefsCommand', callback]);
      git(dir, ['rev-list', '--alternate-refs', '--all']);
      assert.ok(fs.existsSync(marker)); fs.rmSync(marker);
      if (deliveryGate(dir, 'git rev-list --alternate-refs --all').status !== 2) failures.push('alternate refs callback');
      assert.ok(!fs.existsSync(marker));
      git(dir, ['config', '--unset', 'core.alternateRefsCommand']);
      assert.strictEqual(deliveryGate(dir, 'git rev-list --alternate-refs --all').status, 0);
      assert.deepStrictEqual(failures, [], failures.join('\n'));
    } finally { fs.rmSync(probe, { recursive: true, force: true }); }
  }));
}

function testGitAutomaticMaintenanceCallback() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const marker = path.join(dir, '.git/auto-gc-ran');
    fs.writeFileSync(path.join(dir, '.git/hooks/pre-auto-gc'), `#!/bin/sh\nprintf ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    git(dir, ['config', 'gc.auto', '1']); git(dir, ['config', 'gc.autoDetach', 'false']);
    let objects = 0;
    for (let i = 0; objects < 5; i += 1) {
      const value = `loose maintenance fixture ${i}\n`;
      const hash = require('crypto').createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0${value}`).digest('hex');
      if (!hash.startsWith('17')) continue;
      const write = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, encoding: 'utf8', input: value });
      assert.strictEqual(write.status, 0, write.stderr); objects += 1;
    }
    git(dir, ['fetch', '--no-tags', '--no-recurse-submodules', '.']);
    assert.ok(fs.existsSync(marker), 'actual fetch must execute pre-auto-gc'); fs.rmSync(marker);
    const failures = [];
    for (const command of ['git fetch --no-tags --no-recurse-submodules .', 'git commit -m fixture']) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
      assert.ok(!fs.existsSync(marker));
    }
    const disabled = 'git fetch --no-tags --no-recurse-submodules --no-auto-maintenance .';
    assert.strictEqual(deliveryGate(dir, disabled).status, 0);
    git(dir, disabled.split(' ').slice(1)); assert.ok(!fs.existsSync(marker));
    git(dir, ['config', 'gc.auto', '0']);
    assert.strictEqual(deliveryGate(dir, 'git fetch --no-tags --no-recurse-submodules .').status, 0);
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitCredentialHelperRequiresInstalledIdentity() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const fake = path.join(dir, '.git/credential-fixture/gh'); const marker = path.join(dir, '.git/helper-ran');
    fs.mkdirSync(path.dirname(fake));
    fs.writeFileSync(fake, `#!/bin/sh\nprintf ran >> '${marker}'\nprintf 'username=fixture\\npassword=fixture\\n'\n`, { mode: 0o755 });
    git(dir, ['config', 'credential.helper', '']); git(dir, ['config', '--add', 'credential.helper', `!${fake} auth git-credential`]);
    const fill = spawnSync('git', ['credential', 'fill'], { cwd: dir, encoding: 'utf8', input: 'protocol=https\nhost=fixture.invalid\n\n', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    assert.strictEqual(fill.status, 0, fill.stderr); assert.ok(fs.existsSync(marker)); fs.rmSync(marker);
    assert.strictEqual(deliveryGate(dir, 'git ls-remote https://fixture.invalid/repo').status, 2);
    assert.ok(!fs.existsSync(marker));
    git(dir, ['config', '--unset-all', 'credential.helper']);
    const installedGh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/opt/local/bin/gh'].find(file => fs.existsSync(file));
    for (const helper of [...installedStandardCredentialHelpers(), ...(installedGh ? [`!${installedGh} auth git-credential`] : [])]) {
      git(dir, ['config', 'credential.helper', helper]);
      const result = deliveryGate(dir, 'git ls-remote https://fixture.invalid/repo');
      assert.strictEqual(result.status, 0, `${helper}: ${result.stderr}`);
    }
  });
}

function testGitCommitMustUseTheWholeVerifiedIndex() {
  withRepo(dir => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old-a\n'); fs.writeFileSync(path.join(dir, 'b.txt'), 'old-b\n');
    git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'two tracked files']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'new-a\n'); fs.writeFileSync(path.join(dir, 'b.txt'), 'new-b\n');
    git(dir, ['add', '.']); prepareDeliveryEvidence(dir);
    assert.strictEqual(attestation.readGitIdentity(dir).index_matches_worktree, true);
    fs.writeFileSync(path.join(dir, '.git/pathspec'), 'a.txt\n');
    const failures = [];
    for (const command of ['git commit --only a.txt -m partial', 'git commit -o a.txt -m partial',
      'git commit a.txt -m partial', 'git commit -m partial -- a.txt',
      'git commit --include a.txt -m partial', 'git commit --pathspec-from-file=.git/pathspec -m partial']) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    for (const command of ['git commit -m whole', 'git commit -am whole', 'git commit -m --only']) {
      const result = deliveryGate(dir, command); assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
    git(dir, ['commit', '--only', 'a.txt', '-qm', 'actual partial tree']);
    assert.strictEqual(git(dir, ['show', 'HEAD:b.txt']), 'old-b');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'new-b\n');
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitCloneRejectsAllTemplateDeclarations() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-clone-template-'));
    try {
      const template = path.join(probe, 'template');
      const marker = path.join(probe, 'callback-ran');
      const globalConfig = path.join(probe, 'global-config');
      fs.mkdirSync(path.join(template, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(template, 'hooks/post-checkout'), `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
      git(dir, ['config', '--file', globalConfig, 'init.templateDir', template]);
      const environment = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: undefined };
      const failures = [];
      for (const shadow of [false, true]) {
        if (shadow) git(dir, ['config', 'init.templateDir', '']);
        const target = path.join(probe, shadow ? 'shadow-clone' : 'global-clone');
        const actual = spawnSync('git', ['clone', '-q', '.', target], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...environment } });
        assert.strictEqual(actual.status, 0, actual.stderr);
        assert.ok(fs.existsSync(marker), 'global init.templateDir must execute post-checkout even with a local empty override');
        fs.rmSync(marker);
        const result = deliveryGate(dir, `git clone . '${target}-next'`, environment);
        if (result.status !== 2) failures.push(`${shadow ? 'local empty shadow' : 'global template'}: ${result.status} ${result.stderr}`);
        assert.ok(!fs.existsSync(marker), 'gate executed a configured template hook');
      }
      git(dir, ['config', '--unset', 'init.templateDir']);
      fs.writeFileSync(globalConfig, '');
      const inherited = deliveryGate(dir, `git clone . '${path.join(probe, 'environment-clone')}'`, { ...environment, GIT_TEMPLATE_DIR: template });
      if (inherited.status !== 2) failures.push(`inherited GIT_TEMPLATE_DIR: ${inherited.status} ${inherited.stderr}`);
      const normalTarget = path.join(probe, 'ordinary-clone');
      const normal = deliveryGate(dir, `git clone . '${normalTarget}'`, environment);
      assert.strictEqual(normal.status, 0, normal.stderr);
      const actual = spawnSync('git', ['clone', '-q', '.', normalTarget], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...environment } });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(fs.existsSync(path.join(normalTarget, 'README.md')), 'ordinary local clone remains usable');
      assert.ok(!fs.existsSync(marker), 'ordinary clone must not execute the removed custom template');
      assert.deepStrictEqual(failures, [], failures.join('\n'));
    } finally { fs.rmSync(probe, { recursive: true, force: true }); }
  });
}

function testGitOrdinaryCommandProfilesRemainAvailable() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    for (const command of ['git rm --cached README.md', 'git mv README.md renamed.md',
      'git rev-list --count HEAD', 'git worktree list --porcelain', 'git submodule status --recursive',
      'git apply --check fixture.patch', 'git log --oneline -1', 'git diff --stat', 'git tag --list']) {
      const result = deliveryGate(dir, command, { GIT_PAGER: 'cat', PAGER: 'less', GIT_EDITOR: 'true' });
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  });
}

function testGitQuotedOperatorsCannotHideCallbacks() {
  withRepo(dir => {
    fs.writeFileSync(path.join(dir, 'README.md'), ';\n|\n(\n)\n&\n');
    git(dir, ['commit', '-qam', 'operator patterns']);
    const callback = path.join(dir, '.git/operator-pager.sh'); const marker = path.join(dir, '.git/operator-pager-ran');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
    const failures = [];
    for (const command of [
      `git grep '(' -F -e ';' ')' '--open-files-in-pager=${callback}' -- README.md`,
      `git grep '(' -F -e '|' ')' '--open-files-in-pager=${callback}' -- README.md`,
      `git grep \\( -F -e \\; \\) '--open-files-in-pager=${callback}' -- README.md`,
    ]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
      assert.ok(!fs.existsSync(marker), 'hook inspection must not run the pager');
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', command], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr); assert.ok(fs.existsSync(marker)); fs.rmSync(marker);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitQuotedOperatorPathsCannotSelectPartialCommits() {
  withRepo(dir => {
    fs.rmSync(path.join(dir, 'README.md'));
    for (const name of [';', '(', ')', '|', 'other.txt']) fs.writeFileSync(path.join(dir, name), 'old\n');
    git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'operator filenames']);
    for (const name of [';', '(', ')', '|', 'other.txt']) fs.writeFileSync(path.join(dir, name), 'new\n');
    git(dir, ['add', '-A']); prepareDeliveryEvidence(dir);
    const verifiedTree = git(dir, ['write-tree']); const failures = [];
    for (const name of [';', '(', ')', '|']) {
      for (const spelling of [`'${name}'`, `\\${name}`]) {
        const result = deliveryGate(dir, `git commit -m partial -- ${spelling}`);
        if (result.status !== 2) failures.push(`${spelling}: ${result.status} ${result.stderr}`);
      }
    }
    const literalMessage = deliveryGate(dir, "git commit -m ';'");
    if (literalMessage.status !== 0) failures.push(`literal operator message: ${literalMessage.status} ${literalMessage.stderr}`);
    const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', "git commit -m partial -- ';'"], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(actual.status, 0, actual.stderr);
    assert.notStrictEqual(git(dir, ['rev-parse', 'HEAD^{tree}']), verifiedTree);
    assert.strictEqual(git(dir, ['show', 'HEAD:other.txt']), 'old');
    assert.strictEqual(git(dir, ['show', 'HEAD:;']), 'new');
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitCommentsCannotSpoofDryRun() {
  const failures = [];
  for (const mutation of ['git rm -f README.md', 'git add -f hidden.txt']) {
    withRepo(dir => {
      fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\nhidden.txt\n');
      fs.writeFileSync(path.join(dir, 'hidden.txt'), 'outside the original candidate\n');
      prepareDeliveryEvidence(dir);
      const originalTree = git(dir, ['rev-parse', 'HEAD^{tree}']);
      for (const fakeOption of ['--dry-run', '-n']) {
        const command = `${mutation} # ${fakeOption}\ngit commit -m changed`;
        const result = deliveryGate(dir, command);
        if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', `${mutation} # --dry-run\ngit commit -m changed`], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.notStrictEqual(git(dir, ['rev-parse', 'HEAD^{tree}']), originalTree, 'comment text does not disable the real mutation');
    });
  }
  assert.deepStrictEqual(failures, [], failures.join('\n'));
}

function testGitLiteralOperatorsAndShellCommentsRemainAvailable() {
  withRepo(dir => {
    fs.writeFileSync(path.join(dir, 'README.md'), ';\n(\n)\n|\n&\n{\n}\n<\n>\n#\na#b\n# --dry-run\n');
    git(dir, ['commit', '-qam', 'literal shell characters']);
    const commands = ["git grep -F -e '#'", 'git grep -F -e \\#', 'git grep -F -e a#b',
      "git grep -F -e ''#", "git grep -F -e '# --dry-run'",
      "git status --short # --dry-run $(git push origin HEAD) 'unterminated\ngit status --short",
      "# git push origin HEAD >output\ngit status --short",
      "printf '%s\\n' \"$(git rev-parse --short HEAD # ignored ) ' quote\n)\"",
    ];
    for (const operator of [';', '(', ')', '|', '&', '{', '}', '<', '>']) {
      commands.push(`git grep -F -e '${operator}'`, `git grep -F -e \\${operator}`);
    }
    const failures = [];
    for (const command of commands) {
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', command], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, `${command}: ${actual.stderr}`);
      const result = deliveryGate(dir, command);
      if (result.status !== 0) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitRejectsZshExecutableExpansion() {
  withRepo(dir => {
    const shellProbe = spawnSync('zsh', ['-fc', 'whence -p git'], { cwd: dir, encoding: 'utf8' });
    const hasZsh = !shellProbe.error && shellProbe.status === 0;
    const gitProgram = hasZsh ? fs.realpathSync(shellProbe.stdout.trim()) : '/usr/bin/git';
    if (!hasZsh) console.log('INFO optional zsh unavailable; executable expansion gate checks still run');
    const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
    const failures = [];
    const executableForms = ['=git', `${quote(gitProgram)}(x)`, `${quote(gitProgram)}(N)`, `${quote(gitProgram)}(xN)`];
    for (const executable of executableForms) {
      for (const prefix of ['', 'command ', 'env LANG=C ']) {
        const safeCommand = `${prefix}${executable} rev-parse --show-toplevel`;
        const delivery = `${prefix}${executable} push origin HEAD`;
        if (hasZsh) {
          const actual = spawnSync('zsh', ['-fc', safeCommand], { cwd: dir, encoding: 'utf8' });
          assert.strictEqual(actual.status, 0, `${safeCommand}: ${actual.stderr}`);
          assert.strictEqual(fs.realpathSync(actual.stdout.trim()), dir);
        }
        for (const command of [delivery, `zsh -fc ${quote(delivery)}`, `env LANG=C zsh -fc ${quote(delivery)}`]) {
          const result = deliveryGate(dir, command);
          if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
        }
      }
    }
    assert.strictEqual(deliveryGate(dir, 'git push origin HEAD').status, 2, 'ordinary delivery needs evidence');
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testZshExpansionFixPreservesSubshellsAndLiterals() {
  withRepo(dir => {
    const shellProbe = spawnSync('zsh', ['-fc', ':'], { cwd: dir, encoding: 'utf8' });
    const hasZsh = !shellProbe.error && shellProbe.status === 0;
    const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
    const commands = ['(git status --short)', '(git rev-parse --show-toplevel)', 'git status --short && (git status --short)',
      "git rev-parse --sq-quote '=git' '/usr/bin/git(x)' '/usr/bin/git(N)'",
      'git rev-parse --sq-quote "=git" "/usr/bin/git(x)"',
      String.raw`git rev-parse --sq-quote \=git /usr/bin/git\(x\)`];
    for (const command of commands) {
      for (const spelling of [command, `zsh -fc ${quote(command)}`]) {
        const result = deliveryGate(dir, spelling);
        assert.strictEqual(result.status, 0, `${spelling}: ${result.stderr}`);
        if (hasZsh) {
          const actual = spawnSync('zsh', ['-fc', spelling], { cwd: dir, encoding: 'utf8' });
          assert.strictEqual(actual.status, 0, `${spelling}: ${actual.stderr}`);
        }
      }
    }
    prepareDeliveryEvidence(dir);
    for (const command of ['(git push origin HEAD)', 'git status --short && (git push origin HEAD)',
      "zsh -fc '(git push origin HEAD)'"]) {
      const result = deliveryGate(dir, command);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  });
}

function testGitArgumentsRejectActualShellExpansions() {
  withRepo(dir => {
    const bin = path.join(dir, '.git/expansion-bin'); fs.mkdirSync(bin);
    const callback = path.join(bin, 'shk-expansion-marker'); const marker = path.join(dir, '.git/expansion-ran');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '-Oshk-expansion-marker'), 'glob fixture\n');
    const environment = { ...process.env, PAGER_ARG: `-O${callback}`, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const failures = [];
    for (const command of [`git grep $'-O${callback}' -e fixture`, `git grep $"-O${callback}" -e fixture`,
      'git grep "$PAGER_ARG" -e fixture', 'git grep $PAGER_ARG -e fixture',
      'git grep ?O* -e fixture', 'git grep [-]O* -e fixture']) {
      const result = deliveryGate(dir, command, environment);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
      assert.ok(!fs.existsSync(marker), 'inspection must not invoke the callback');
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', command], { cwd: dir, encoding: 'utf8', env: environment });
      assert.strictEqual(actual.status, 0, actual.stderr); assert.ok(fs.existsSync(marker), command); fs.rmSync(marker);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitLiteralArgumentsPreserveQuoteAndEscapeSemantics() {
  withRepo(dir => {
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n$PAGER_ARG\n*\nC:\\\n');
    git(dir, ['add', 'README.md']); git(dir, ['commit', '-qm', 'literal fixture']);
    const failures = [];
    for (const command of ["git grep -F -e '$PAGER_ARG'", 'git grep -F -e \\$PAGER_ARG',
      "git grep -F -e '*'", 'git grep -F -e "*"', 'git grep -F -e \\*',
      "git grep -F -e 'C:\\'", "git rev-parse --sq-quote 'Windows C:\\'",
      String.raw`printf '%s\n' "$(git rev-parse --sq-quote 'Windows C:\')"`,
      String.raw`bash -c 'git grep -F -e "\$PAGER_ARG"'`]) {
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', command], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, `${command}: ${actual.stderr}`);
      const result = deliveryGate(dir, command);
      if (result.status !== 0) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitGlobCannotSelectAnUnverifiedPartialCommit() {
  withRepo(dir => {
    fs.rmSync(path.join(dir, 'README.md'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old-a\n'); fs.writeFileSync(path.join(dir, 'b.txt'), 'old-b\n');
    git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'two visible files']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'new-a\n'); fs.writeFileSync(path.join(dir, 'b.txt'), 'new-b\n');
    git(dir, ['add', '.']); prepareDeliveryEvidence(dir);
    const verifiedTree = git(dir, ['write-tree']);
    const gate = deliveryGate(dir, 'git commit -m *');
    assert.strictEqual(deliveryGate(dir, "git commit -m '*' ").status, 0, 'quoted message is literal and keeps the whole index');
    const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', 'git commit -m *'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(actual.status, 0, actual.stderr);
    assert.notStrictEqual(git(dir, ['rev-parse', 'HEAD^{tree}']), verifiedTree);
    assert.strictEqual(git(dir, ['show', 'HEAD:a.txt']), 'old-a');
    assert.strictEqual(git(dir, ['show', 'HEAD:b.txt']), 'new-b');
    assert.strictEqual(gate.status, 2, `glob produced a partial commit: ${gate.stderr}`);
  });
}

function testGitCandidateMutationsCannotShareDeliveryEvidence() {
  withRepo(dir => {
    const firstCommit = git(dir, ['rev-parse', 'HEAD']);
    fs.appendFileSync(path.join(dir, 'README.md'), 'second commit\n'); git(dir, ['commit', '-qam', 'second']);
    const verifiedCommit = git(dir, ['rev-parse', 'HEAD']);
    const originalIndex = git(dir, ['write-tree']);
    fs.appendFileSync(path.join(dir, 'README.md'), 'dry-run override fixture\n');
    git(dir, ['add', '--dry-run', '--no-dry-run', 'README.md']);
    assert.notStrictEqual(git(dir, ['write-tree']), originalIndex, 'the final --no-dry-run really updates the index');
    git(dir, ['reset', '--hard', 'HEAD']);
    git(dir, ['branch', 'publishing', 'HEAD']);
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-mutation-delivery-'));
    try {
      git(remote, ['init', '--bare', '-q']); git(dir, ['remote', 'add', 'audit', remote]);
      prepareDeliveryEvidence(dir);
      const push = 'git push audit HEAD:refs/heads/verified';
      const failures = [];
      for (const mutation of ['git checkout --detach HEAD~1', 'git switch --detach HEAD~1', 'git reset --hard HEAD~1',
        'git restore --source=HEAD~1 README.md', 'git restore --staged --source=HEAD~1 README.md',
        'git add README.md', 'git add --dry-run --no-dry-run README.md', 'git rm --cached README.md', 'git mv README.md moved.md',
        'git branch -f publishing HEAD~1', 'git stash push', 'git stash pop',
        'git tag -d local-reference', 'git fetch --no-tags --no-recurse-submodules audit']) {
        const standalone = deliveryGate(dir, mutation);
        assert.strictEqual(standalone.status, 0, `${mutation}: ${standalone.stderr}`);
        for (const command of [`${mutation} && ${push}`, `${push}; ${mutation}`, `bash -c '${mutation}' && ${push}`]) {
          const result = deliveryGate(dir, command);
          if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
        }
      }
      for (const inspection of ['git status --short', 'git diff --stat', 'git branch --show-current',
        'git branch --list', 'git stash list', 'git add --dry-run README.md', 'git add --no-dry-run --dry-run README.md',
        'git rm --dry-run README.md', 'git clean --dry-run']) {
        const command = `${inspection} && ${push}`;
        const result = deliveryGate(dir, command);
        assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
        const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', command], { cwd: dir, encoding: 'utf8' });
        assert.strictEqual(actual.status, 0, actual.stderr);
        assert.strictEqual(git(remote, ['rev-parse', 'refs/heads/verified']), verifiedCommit);
      }
      const refChange = 'git branch -f publishing HEAD~1 && git push audit publishing:refs/heads/ref-changed';
      if (deliveryGate(dir, refChange).status !== 2) failures.push('branch rewrite reused the pre-command source reference');
      const actualRef = spawnSync('bash', ['--noprofile', '--norc', '-c', refChange], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actualRef.status, 0, actualRef.stderr);
      assert.strictEqual(git(remote, ['rev-parse', 'refs/heads/ref-changed']), firstCommit);
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', 'git checkout --detach HEAD~1 && git push audit HEAD:refs/heads/changed'], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.strictEqual(git(remote, ['rev-parse', 'refs/heads/changed']), firstCommit);
      assert.notStrictEqual(firstCommit, verifiedCommit, 'the delivered object differs from the authorized pre-command HEAD');
      assert.deepStrictEqual(failures, [], failures.join('\n'));
    } finally { fs.rmSync(remote, { recursive: true, force: true }); }
  });
}

function testGitPushBindsConfiguredDestinations() {
  withRepo(dir => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-push-mapping-'));
    git(remote, ['init', '--bare', '-q']);
    try {
    prepareDeliveryEvidence(dir);
    const branch = git(dir, ['symbolic-ref', '--short', 'HEAD']);
    git(dir, ['remote', 'add', 'audit', remote]);
    const writeRisk = risk => fs.writeFileSync(path.join(dir, '.harness/verify-evidence.json'), JSON.stringify(signed(dir, {
      risk, checks: { tests: { status: 'PASS' }, e2e: { status: 'PASS' }, e2e_sufficiency: { status: 'PASS', overall: 'READY' }, runtime: { status: 'PASS' } },
    })));
    const command = `git push --dry-run audit ${branch}`;
    const failures = [];
    for (const mode of ['remote', 'upstream']) {
      if (mode === 'remote') git(dir, ['config', 'remote.audit.push', `refs/heads/${branch}:refs/tags/mapped-${mode}`]);
      else {
        git(dir, ['config', 'push.default', 'upstream']);
        git(dir, ['config', `branch.${branch}.remote`, 'audit']);
        git(dir, ['config', `branch.${branch}.merge`, `refs/tags/mapped-${mode}`]);
      }
      const dry = spawnSync('git', ['push', '--dry-run', '--porcelain', 'audit', branch], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, new RegExp(`refs/tags/mapped-${mode}.*\\[new tag\\]`), dry.stdout);
      writeRisk('medium');
      if (deliveryGate(dir, command).status !== 2) failures.push(`${mode} tag mapping accepted medium evidence`);
      writeRisk('release');
      const admitted = deliveryGate(dir, command);
      if (admitted.status !== 0) failures.push(`${mode} bound tag mapping rejected release evidence: ${admitted.stderr}`);
      if (mode === 'remote') git(dir, ['config', '--unset-all', 'remote.audit.push']);
    }
    git(dir, ['config', 'push.default', 'current']);
    git(dir, ['config', 'remote.audit.push', `refs/heads/${branch}:refs/heads/mapped-branch`]);
    writeRisk('medium');
    assert.strictEqual(deliveryGate(dir, command).status, 0, 'one configured branch destination is bindable');
    git(dir, ['config', '--add', 'remote.audit.push', `refs/heads/${branch}:refs/tags/second-target`]);
    if (deliveryGate(dir, command).status !== 2) failures.push('multiple matching destinations are unbound');
    assert.strictEqual(deliveryGate(dir, `git push --dry-run audit ${branch}:refs/heads/explicit`).status, 0, 'explicit destination overrides configured maps');
    git(dir, ['config', '--unset-all', 'remote.audit.push']);
    assert.strictEqual(deliveryGate(dir, command).status, 0, 'ordinary source-only branch push stays available');
    for (const source of [branch, `heads/${branch}`]) {
      git(dir, ['config', 'remote.audit.push', `${source}:refs/tags/ignored-shorthand`]);
      const dry = spawnSync('git', ['push', '--dry-run', '--porcelain', 'audit', branch], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(dry.status, 0, dry.stderr); assert.doesNotMatch(dry.stdout, /refs\/tags\/ignored-shorthand/);
      const admitted = deliveryGate(dir, command);
      assert.strictEqual(admitted.status, 0, `shorthand mapping does not rewrite source-only push: ${admitted.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    } finally { fs.rmSync(remote, { recursive: true, force: true }); }
  });
}

function testGitFixupBindsEditorsAndWholeIndex() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const marker = path.join(dir, '.git/fixup-editor-ran');
    const callback = path.join(dir, '.git/fixup-editor.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    const failures = [];
    for (const mode of ['amend', 'reword']) {
      const args = ['commit', '--allow-empty', `--fixup=${mode}:HEAD`];
      const actual = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: callback } });
      assert.notStrictEqual(actual.status, 0); assert.ok(fs.existsSync(marker), actual.stderr); fs.rmSync(marker);
      const rejected = deliveryGate(dir, `git ${args.join(' ')}`, { GIT_EDITOR: callback });
      if (rejected.status !== 2) failures.push(`${mode} editor admitted`);
      assert.ok(!fs.existsSync(marker), 'inspection must not invoke the editor');
    }
    fs.appendFileSync(path.join(dir, 'README.md'), 'staged for complete commit\n'); git(dir, ['add', 'README.md']);
    prepareDeliveryEvidence(dir);
    const originalTree = git(dir, ['rev-parse', 'HEAD^{tree}']);
    const verifiedTree = git(dir, ['write-tree']);
    const implicitOnly = 'git commit --fixup=reword:HEAD --no-edit';
    if (deliveryGate(dir, implicitOnly).status !== 2) failures.push('reword implicit --only admitted');
    for (const command of ['git commit --fixup=HEAD', 'git commit --fixup=amend:HEAD --no-edit']) {
      const admitted = deliveryGate(dir, command, { GIT_EDITOR: callback });
      assert.strictEqual(admitted.status, 0, `${command}: ${admitted.stderr}`);
    }
    git(dir, ['commit', '--fixup=reword:HEAD', '--no-edit']);
    assert.strictEqual(git(dir, ['rev-parse', 'HEAD^{tree}']), originalTree);
    assert.notStrictEqual(originalTree, verifiedTree, 'reword must prove that Git ignores the verified staged tree');
    git(dir, ['commit', '--fixup=amend:HEAD', '--no-edit']);
    assert.strictEqual(git(dir, ['rev-parse', 'HEAD^{tree}']), verifiedTree, 'non-editing amend fixup keeps the whole verified index');
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitSigningConfigurationAndDisablePrecedence() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-signed-push-'));
    try {
      git(bare, ['init', '--bare', '-q']); git(bare, ['config', 'receive.certNonceSeed', 'fixture-seed']);
      git(dir, ['remote', 'add', 'audit', `file://${bare}`]);
      const marker = path.join(dir, '.git/signer-ran'); const callback = path.join(dir, '.git/signer.sh');
      fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
      git(dir, ['config', 'gpg.program', callback]); git(dir, ['config', 'tag.forceSignAnnotated', 'true']);
      const failures = [];
      for (const args of [['tag', '-m', 'fixture', 'signed-default'], ['tag', '--no-sign', '-m', 'fixture', 'signed-forced']]) {
        const actual = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
        assert.notStrictEqual(actual.status, 0); assert.ok(fs.existsSync(marker), actual.stderr); fs.rmSync(marker);
        if (deliveryGate(dir, `git ${args.join(' ')}`).status !== 2) failures.push(`${args.join(' ')} signer admitted`);
      }
      for (const args of [['tag', '--no-sign', 'unsigned-lightweight'], ['-c', 'tag.forceSignAnnotated=false', 'tag', '--no-sign', '-m', 'fixture', 'unsigned-annotated']]) {
        const admitted = deliveryGate(dir, `git ${args.join(' ')}`);
        if (admitted.status !== 0) failures.push(`${args.join(' ')} unsigned positive: ${admitted.stderr}`);
        git(dir, args); assert.ok(!fs.existsSync(marker));
      }
      git(dir, ['config', '--unset', 'tag.forceSignAnnotated']);
      const branch = git(dir, ['symbolic-ref', '--short', 'HEAD']);
      for (const mode of ['true', 'if-asked']) {
        git(dir, ['config', 'push.gpgSign', mode]);
        const args = ['push', 'audit', branch];
        const actual = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
        assert.notStrictEqual(actual.status, 0); assert.ok(fs.existsSync(marker), actual.stderr); fs.rmSync(marker);
        if (deliveryGate(dir, `git ${args.join(' ')}`).status !== 2) failures.push(`push.gpgSign=${mode} signer admitted`);
      }
      for (const options of [['--no-signed'], ['--signed=false'], ['--signed', '--no-signed'], ['--no-signed', '--signed=false']]) {
        const args = ['push', '--dry-run', ...options, 'audit', branch];
        const admitted = deliveryGate(dir, `git ${args.join(' ')}`);
        if (admitted.status !== 0) failures.push(`${options.join(' ')} unsigned positive: ${admitted.stderr}`);
        git(dir, args); assert.ok(!fs.existsSync(marker));
      }
      for (const options of [['--signed=false', '--signed'], ['--no-signed', '--signed=if-asked']]) {
        if (deliveryGate(dir, `git push ${options.join(' ')} audit ${branch}`).status !== 2) failures.push(`${options.join(' ')} signing precedence`);
      }
      assert.ok(!fs.existsSync(marker), 'inspection executed signer');
      assert.deepStrictEqual(failures, [], failures.join('\n'));
    } finally { fs.rmSync(bare, { recursive: true, force: true }); }
  });
}

function testGitConfigSubcommandsKeepQueriesAndBlockEditing() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const subcommandProbe = spawnSync('git', ['config', 'get', 'user.name'], { cwd: dir, encoding: 'utf8' });
    const supportsSubcommands = subcommandProbe.status === 0;
    if (!supportsSubcommands) console.log('INFO Git config subcommands unavailable; legacy editor/query execution and all gate checks remain required');
    const marker = path.join(dir, '.git/config-editor-ran'); const callback = path.join(dir, '.git/config-editor.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
    for (const args of [['config', 'edit'], ['config', '--ed', 'user.name']]) {
      if (args[1] === 'edit' && !supportsSubcommands) continue;
      const actual = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: callback } });
      assert.strictEqual(actual.status, 0, actual.stderr); assert.ok(fs.existsSync(marker)); fs.rmSync(marker);
    }
    const failures = [];
    for (const command of ['git config edit', 'git config --ed user.name', 'git config edit -f .git/fixture-config', 'git config --local edit', 'git config -e', 'git config set core.editor callback']) {
      if (deliveryGate(dir, command, { GIT_EDITOR: callback }).status !== 2) failures.push(command);
    }
    for (const args of [['config', 'get', 'user.name'], ['config', 'get', '--local', '--all', 'user.name'],
      ['config', 'get', '--regexp', 'user.name'], ['config', 'get', '-f', '.git/config', 'user.name'],
      ['config', 'get', '--file', '.git/config', '-t', 'bool', 'commit.gpgSign'],
      ['config', 'get', '--type', 'bool', 'commit.gpgSign'],
      ['config', 'list'], ['config', '--get', 'user.name'], ['config', 'user.name']]) {
      if (supportsSubcommands || !['get', 'list'].includes(args[1])) git(dir, args);
      const result = deliveryGate(dir, `git ${args.join(' ')}`, { GIT_EDITOR: callback });
      if (result.status !== 0) failures.push(`query ${args.join(' ')}: ${result.stderr}`);
    }
    assert.ok(!fs.existsSync(marker));
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitCredentialHelperBindsAliasAndExecutable() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const marker = path.join(dir, '.git/helper-alias-ran'); const callback = path.join(dir, '.git/helper-alias.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\nprintf 'username=fixture\\npassword=fixture\\n'\n`, { mode: 0o755 });
    const bin = path.join(dir, '.git/helper-bin'); fs.mkdirSync(bin);
    const gitExecutable = String(process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, 'git'))
      .find(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
    assert.ok(gitExecutable, 'actual Git executable must be available');
    fs.symlinkSync(fs.realpathSync(gitExecutable), path.join(bin, 'git'));
    // Isolate helper resolution so an installed manager cannot prompt or
    // contact a credential service during these offline callback probes.
    const environment = { ...process.env, PATH: bin, GIT_EXEC_PATH: bin, GIT_TERMINAL_PROMPT: '0' };
    git(dir, ['config', 'credential.helper', '']); git(dir, ['config', '--add', 'credential.helper', 'manager']);
    git(dir, ['config', 'alias.credential-manager', `!${callback}`]);
    const actual = spawnSync('git', ['credential', 'fill'], { cwd: dir, encoding: 'utf8', input: 'protocol=https\nhost=fixture.invalid\n\n', env: environment });
    assert.strictEqual(actual.status, 0, actual.stderr); assert.ok(fs.existsSync(marker)); fs.rmSync(marker);
    const failures = [];
    if (deliveryGate(dir, 'git ls-remote https://fixture.invalid/repo', environment).status !== 2) failures.push('credential-manager alias admitted');
    git(dir, ['config', '--unset', 'alias.credential-manager']);
    fs.copyFileSync(callback, path.join(bin, 'git-credential-manager'));
    const resolved = spawnSync('git', ['credential', 'fill'], { cwd: dir, encoding: 'utf8', input: 'protocol=https\nhost=fixture.invalid\n\n', env: environment });
    assert.strictEqual(resolved.status, 0, resolved.stderr); assert.ok(fs.existsSync(marker)); fs.rmSync(marker);
    if (deliveryGate(dir, 'git ls-remote https://fixture.invalid/repo', environment).status !== 2) failures.push('arbitrary manager executable admitted');
    for (const helper of installedStandardCredentialHelpers()) {
      git(dir, ['config', '--unset-all', 'credential.helper']); git(dir, ['config', 'credential.helper', helper]);
      const admitted = deliveryGate(dir, 'git ls-remote https://fixture.invalid/repo');
      assert.strictEqual(admitted.status, 0, `${helper}: ${admitted.stderr}`);
    }
    assert.ok(!fs.existsSync(marker));
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitFetchShortNoTagsMatchesLongForm() {
  withRepo(dir => withRepo(remote => {
    prepareDeliveryEvidence(dir); git(dir, ['remote', 'add', 'audit', remote]);
    git(remote, ['tag', 'remote-fixture-tag']);
    const failures = [];
    for (const option of ['--no-tags', '-n', '-nv']) {
      const args = ['fetch', '--dry-run', '--no-recurse-submodules', option, 'audit'];
      const dry = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(dry.status, 0, dry.stderr); assert.doesNotMatch(dry.stderr, /new tag/);
      const admitted = deliveryGate(dir, `git ${args.join(' ')}`);
      if (admitted.status !== 0) failures.push(`${option}: ${admitted.stderr}`);
    }
    git(dir, ['config', 'fetch.pruneTags', 'true']);
    for (const option of ['--no-tags', '-n', '-nv']) assert.strictEqual(deliveryGate(dir, `git fetch --no-recurse-submodules ${option} audit`).status, 2);
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

// VH-46: actual callback entrypoints, distinct from shell-expansion regressions.
function testGitPopulatedSubmoduleCallbackConfiguration() {
  withRepo(dir => withRepo(remote => {
    git(dir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', remote, 'deps/child']);
    const child = path.join(dir, 'deps/child');
    git(child, ['config', 'user.name', 'SHK child fixture']);
    git(child, ['config', 'user.email', 'child@example.com']);
    git(child, ['config', 'commit.gpgsign', 'false']);
    git(child, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', remote, 'deps/grandchild']);
    git(child, ['commit', '-qam', 'nested child']);
    git(dir, ['add', '.gitmodules', 'deps/child']);
    git(dir, ['commit', '-qm', 'populated children']);
    prepareDeliveryEvidence(dir);
    const marker = path.join(dir, '.git/submodule-callback-ran');
    const callback = path.join(dir, '.git/submodule-monitor.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
    const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
    const subdirectory = path.join(dir, 'ordinary-subdirectory');
    fs.mkdirSync(subdirectory);
    const prefixes = [[], ['-C', dir], ['--git-dir', path.join(dir, '.git'), '--work-tree', dir],
      ['-C', subdirectory], ['--literal-pathspecs', '-C', subdirectory]];
    const failures = [];
    for (const location of [child, path.join(child, 'deps/grandchild')]) {
      git(location, ['config', 'core.fsmonitor', callback]);
      for (const prefix of prefixes) {
        for (const args of [['status', '--short'], ['diff', '--stat']]) {
          const argv = [...prefix, ...args];
          const command = `git ${argv.map(quote).join(' ')}`;
          const actual = spawnSync('git', argv, { cwd: dir, encoding: 'utf8' });
          assert.strictEqual(actual.status, 0, actual.stderr);
          assert.ok(fs.existsSync(marker), `actual ${command} did not execute child callback`);
          fs.rmSync(marker);
          const result = deliveryGate(dir, command);
          if (result.status !== 2) failures.push(`${location} ${command}: ${result.status} ${result.stderr}`);
          assert.ok(!fs.existsSync(marker), 'callback must not execute during gate inspection');
          const disabledArgs = [...prefix, '-c', 'core.fsmonitor=false', ...args];
          const disabled = spawnSync('git', disabledArgs, { cwd: dir, encoding: 'utf8' });
          assert.strictEqual(disabled.status, 0, disabled.stderr);
          assert.ok(!fs.existsSync(marker), 'Git -c disable must actually propagate into children');
          const admitted = deliveryGate(dir, `git ${disabledArgs.map(quote).join(' ')}`);
          if (admitted.status !== 0) failures.push(`disabled child positive: ${admitted.status} ${admitted.stderr}`);
        }
      }
      git(location, ['config', '--unset', 'core.fsmonitor']);
    }
    for (const command of ['git status --short', 'git diff --stat', 'git submodule status --recursive']) {
      assert.strictEqual(deliveryGate(dir, command).status, 0, command);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testGitInheritedExecPathCannotReplaceHelpers() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const bin = path.join(dir, '.git/untrusted-git-core');
    fs.mkdirSync(bin);
    const marker = path.join(dir, '.git/exec-path-marker');
    fs.writeFileSync(path.join(bin, 'git-submodule'), `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
    const environment = { ...process.env, GIT_EXEC_PATH: bin };
    const actual = spawnSync('git', ['submodule', 'status'], { cwd: dir, encoding: 'utf8', env: environment });
    assert.strictEqual(actual.status, 0, actual.stderr);
    assert.ok(fs.existsSync(marker), 'fixture must prove inherited exec-path selects the external helper');
    fs.rmSync(marker);
    const result = deliveryGate(dir, 'git submodule status', { GIT_EXEC_PATH: bin });
    assert.strictEqual(result.status, 2, result.stderr);
    assert.ok(!fs.existsSync(marker), 'gate itself must not invoke the substituted helper');
    const unset = deliveryGate(dir, 'env -u GIT_EXEC_PATH git submodule status', { GIT_EXEC_PATH: bin });
    assert.strictEqual(unset.status, 0, unset.stderr);
    assert.strictEqual(deliveryGate(dir, 'git submodule status', { GIT_EXEC_PATH: undefined }).status, 0);
  });
}

function testGitCommitTrailerProgramsRequireCallbackBinding() {
  withRepo(dir => {
    const marker = path.join(dir, '.git/trailer-callback-ran');
    const callback = path.join(dir, '.git/trailer-callback.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\nprintf fixture\n`, { mode: 0o755 });
    const failures = [];
    for (const key of ['trailer.X.cmd', 'trailer.X.command']) {
      git(dir, ['config', key, callback]);
      for (const trailer of [false, true]) {
        prepareDeliveryEvidence(dir);
        const args = ['commit', '--allow-empty', '-m', 'trailer-fixture', ...(trailer ? ['--trailer', 'X: value'] : [])];
        const result = deliveryGate(dir, `git ${args.map(value => JSON.stringify(value)).join(' ')}`);
        if (result.status !== (trailer ? 2 : 0)) failures.push(`${key} trailer=${trailer}: ${result.status} ${result.stderr}`);
        assert.ok(!fs.existsSync(marker), 'gate introspection executed trailer callback');
        git(dir, args);
        assert.strictEqual(fs.existsSync(marker), trailer, 'real Git callback reachability must match --trailer');
        if (trailer) fs.rmSync(marker);
      }
      git(dir, ['config', '--unset', key]);
      prepareDeliveryEvidence(dir);
      const positive = deliveryGate(dir, 'git commit --allow-empty -m ordinary --trailer "X: value"');
      if (positive.status !== 0) failures.push(`ordinary trailer positive: ${positive.stderr}`);
      git(dir, ['commit', '--allow-empty', '-m', 'ordinary', '--trailer', 'X: value']);
      assert.ok(!fs.existsSync(marker));
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitTagTrailerProgramsRequireCallbackBinding() {
  withRepo(dir => {
    const marker = path.join(dir, '.git/tag-trailer-callback-ran');
    const callback = path.join(dir, '.git/tag-trailer-callback.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\nprintf fixture\n`, { mode: 0o755 });
    const failures = [];
    let tagNumber = 0;
    for (const key of ['trailer.X.cmd', 'trailer.X.command']) {
      git(dir, ['config', key, callback]);
      for (const mode of ['configured-callback', 'plain-tag', 'ordinary-trailer']) {
        if (mode === 'ordinary-trailer') git(dir, ['config', '--unset', key]);
        prepareDeliveryEvidence(dir);
        const args = ['tag', '-a', '-m', 'trailer-fixture',
          ...(mode === 'plain-tag' ? [] : ['--trailer', 'X: value']), `fixture-${++tagNumber}`];
        const result = deliveryGate(dir, `git ${args.map(value => JSON.stringify(value)).join(' ')}`);
        const denied = mode === 'configured-callback';
        if (result.status !== (denied ? 2 : 0) || (denied && !/unverified callback trailer\.X\./.test(result.stderr))) {
          failures.push(`${key} ${mode}: ${result.status} ${result.stderr}`);
        }
        assert.ok(!fs.existsSync(marker), 'gate inspection must not execute tag trailer programs');
        git(dir, args);
        assert.strictEqual(fs.existsSync(marker), denied, 'real Git tag must demonstrate trailer callback reachability');
        if (denied) fs.rmSync(marker);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitSignatureDisplayDisableMatchesRealGit() {
  withRepo(dir => {
    const raw = git(dir, ['cat-file', '-p', 'HEAD']);
    const signedCommit = raw.replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n fixture\n -----END PGP SIGNATURE-----\n\n') + '\n';
    const hashed = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: dir, encoding: 'utf8', input: signedCommit });
    assert.strictEqual(hashed.status, 0, hashed.stderr);
    git(dir, ['update-ref', 'HEAD', hashed.stdout.trim()]);
    prepareDeliveryEvidence(dir);
    const marker = path.join(dir, '.git/signature-display-ran');
    const callback = path.join(dir, '.git/signature-display.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    git(dir, ['config', 'gpg.program', callback]);
    git(dir, ['config', 'log.showSignature', 'true']);
    const failures = [];
    for (const sub of ['log', 'show', 'rev-list']) {
      const base = [sub, '--no-walk', '--format=%H'];
      for (const options of [['--no-show-signature'], ['--show-signature', '--no-show-signature']]) {
        const args = [...base, ...options, 'HEAD'];
        const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
        assert.strictEqual(actual.status, 0, actual.stderr);
        assert.ok(!fs.existsSync(marker), `${args.join(' ')} must not verify signatures`);
        const result = deliveryGate(dir, `git ${args.join(' ')}`);
        if (result.status !== 0) failures.push(`signature-disabled ${sub}: ${result.status} ${result.stderr}`);
      }
      if (sub !== 'rev-list') {
        const args = [...base, '--no-show-signature', '--show-signature', 'HEAD'];
        spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
        assert.ok(fs.existsSync(marker), `${sub} explicit re-enable must invoke signature program`);
        fs.rmSync(marker);
        assert.strictEqual(deliveryGate(dir, `git ${args.join(' ')}`).status, 2);
        const formatted = [sub, '--no-show-signature', '--format=%G?', '--no-walk', 'HEAD'];
        spawnSync('git', ['--no-pager', ...formatted], { cwd: dir, encoding: 'utf8' });
        assert.ok(fs.existsSync(marker), 'signature formatting remains active when display is disabled');
        fs.rmSync(marker);
        const formattingResult = deliveryGate(dir, `git ${formatted.map(value => JSON.stringify(value)).join(' ')}`);
        assert.strictEqual(formattingResult.status, 2);
        assert.match(formattingResult.stderr, /gpg\.program/, 'quoted signature formatter must reach callback classification');
      }
      git(dir, ['config', 'log.showSignature', 'false']);
      const unsigned = spawnSync('git', ['--no-pager', ...base, 'HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(unsigned.status, 0, unsigned.stderr);
      assert.ok(!fs.existsSync(marker), 'ordinary display without signature checking must not invoke gpg');
      const ordinary = deliveryGate(dir, `git ${[...base, 'HEAD'].join(' ')}`);
      if (ordinary.status !== 0) failures.push(`ordinary unsigned ${sub}: ${ordinary.stderr}`);
      git(dir, ['config', 'log.showSignature', 'true']);
    }
    git(dir, ['config', 'format.pretty', 'fixture-signature']);
    git(dir, ['config', 'pretty.fixture-signature', 'format:%G?']);
    const aliasArgs = ['log', '--no-show-signature', '--no-walk', 'HEAD'];
    spawnSync('git', ['--no-pager', ...aliasArgs], { cwd: dir, encoding: 'utf8' });
    assert.ok(fs.existsSync(marker), 'configured signature formatter must remain protected');
    fs.rmSync(marker);
    assert.strictEqual(deliveryGate(dir, `git ${aliasArgs.join(' ')}`).status, 2);
    assert.strictEqual(deliveryGate(dir, 'git log --no-show-signature --no-walk --format=%H HEAD').status, 0);
    assert.ok(!fs.existsSync(marker), 'gate invoked a signature callback');
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitConfigurationFileOverrideCannotHideCallbacks() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const marker = path.join(dir, '.git/override-callback-ran');
    const callback = path.join(dir, '.git/override-callback.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf callback >> '${marker}'\n`, { mode: 0o755 });
    const failures = [];
    for (const override of ['/dev/null', path.join(dir, '.git/empty-config')]) {
      if (override !== '/dev/null') fs.writeFileSync(override, '');
      const environment = { ...process.env, GIT_CONFIG: override };
      git(dir, ['config', 'core.fsmonitor', callback]);
      const config = spawnSync('git', ['config', '--get', 'core.fsmonitor'], { cwd: dir, encoding: 'utf8', env: environment });
      assert.strictEqual(config.status, 1, 'config-only file override must hide the real callback');
      const actual = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', env: environment });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(fs.existsSync(marker), 'actual Git must still consume the repository callback');
      fs.rmSync(marker);
      const result = deliveryGate(dir, 'git status --porcelain', { GIT_CONFIG: override });
      if (result.status !== 2) failures.push(`${override}: ${result.status} ${result.stderr}`);
      assert.ok(!fs.existsSync(marker), 'classification must not invoke the hidden callback');
      git(dir, ['config', '--unset', 'core.fsmonitor']);
    }
    for (const command of ['GIT_CONFIG=/dev/null git status', 'env GIT_CONFIG=/dev/null git status', 'env -u GIT_CONFIG git status']) {
      assert.strictEqual(deliveryGate(dir, command, { GIT_CONFIG: '/dev/null' }).status, 2, command);
    }
    assert.strictEqual(deliveryGate(dir, 'git status', { GIT_CONFIG: undefined }).status, 0);
    assert.strictEqual(deliveryGate(dir, 'git status', {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'color.ui', GIT_CONFIG_VALUE_0: 'never', GIT_CONFIG: undefined,
    }).status, 0, 'ordinary inherited Git configuration remains supported');
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitConfigurationFileOverrideCannotHideTargets() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    git(dir, ['remote', 'add', 'audit', '.']);
    git(dir, ['config', 'push.followTags', 'true']);
    const follow = 'git push audit HEAD:refs/heads/verified';
    const failures = [];
    assert.strictEqual(deliveryGate(dir, follow).status, 2);
    for (const command of [follow, 'git -c push.followTags=true push audit HEAD:refs/heads/verified']) {
      const result = deliveryGate(dir, command, { GIT_CONFIG: '/dev/null' });
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    git(dir, ['config', '--unset', 'push.followTags']);
    git(dir, ['config', 'remote.audit.fetch', '+refs/heads/*:refs/tags/mapped/*']);
    const fetch = 'git fetch --dry-run --no-tags --no-recurse-submodules audit';
    assert.strictEqual(deliveryGate(dir, fetch).status, 2);
    const mapped = deliveryGate(dir, fetch, { GIT_CONFIG: '/dev/null' });
    if (mapped.status !== 2) failures.push(`hidden fetch mapping: ${mapped.status} ${mapped.stderr}`);
    const actual = spawnSync('git', ['remote', 'get-url', 'audit'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG: '/dev/null' },
    });
    assert.strictEqual(actual.status, 0, actual.stderr);
    assert.strictEqual(actual.stdout.trim(), '.', 'non-config Git still sees the real remote');
    git(dir, ['config', 'remote.audit.fetch', '+refs/heads/*:refs/remotes/audit/*']);
    assert.strictEqual(deliveryGate(dir, fetch).status, 0);
    assert.strictEqual(deliveryGate(dir, 'git push --no-follow-tags audit HEAD:refs/heads/verified').status, 0);
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitIdentityRejectsConfigurationFileOverrides() {
  withRepo(dir => {
    const marker = path.join(dir, '.git/override-filter-ran');
    const callback = path.join(dir, '.git/override-filter.sh');
    fs.writeFileSync(callback, `#!/bin/sh\nprintf filter >> '${marker}'\ncat\n`, { mode: 0o755 });
    git(dir, ['config', 'filter.fixture.clean', callback]);
    fs.writeFileSync(path.join(dir, '.git/info/attributes'), 'README.md filter=fixture\n');
    fs.appendFileSync(path.join(dir, 'README.md'), 'unverified filter input\n');
    const actual = spawnSync('git', ['diff'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG: '/dev/null' },
    });
    assert.strictEqual(actual.status, 0, actual.stderr);
    assert.ok(fs.existsSync(marker), 'ordinary diff must prove the hidden clean filter is executable');
    fs.rmSync(marker);
    const previous = process.env.GIT_CONFIG;
    let identity;
    try {
      process.env.GIT_CONFIG = '/dev/null';
      identity = attestation.readGitIdentity(dir);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG;
      else process.env.GIT_CONFIG = previous;
    }
    const callbackRan = fs.existsSync(marker);
    assert.deepStrictEqual({ available: identity.available, callbackRan }, { available: false, callbackRan: false });
    git(dir, ['config', '--unset', 'filter.fixture.clean']);
    assert.strictEqual(attestation.readGitIdentity(dir).available, true);
  });
}

function applyFixture(dir) {
  const patch = '.git/candidate.patch';
  fs.writeFileSync(path.join(dir, 'README.md'), '# changed candidate\n');
  fs.writeFileSync(path.join(dir, patch), git(dir, ['diff']) + '\n');
  git(dir, ['checkout', '--', 'README.md']);
  prepareDeliveryEvidence(dir);
  return patch;
}

function testGitApplyWritingOptionsInvalidateDeliveryEvidence() {
  withRepo(dir => {
    const patch = applyFixture(dir);
    const failures = [];
    const variants = [
      '--stat --apply', '--apply --stat', '--check --apply', '--apply --check',
      '--numstat --apply', '--summary --apply', '--stat --no-apply --apply',
      '--stat --no-stat', '--check --no-check', '--numstat --no-numstat', '--summary --no-summary',
      '--no-apply', '--apply --no-apply',
    ];
    for (const mode of ['', '--index', '--cached']) {
      for (const options of variants) {
        const args = ['apply', ...options.split(' '), ...mode.split(' ').filter(Boolean), patch];
        const command = `git ${args.join(' ')} && git commit --allow-empty -m changed`;
        const gate = deliveryGate(dir, command);
        if (gate.status !== 2) failures.push(`${command}: ${gate.status} ${gate.stderr}`);
        const actual = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
        assert.strictEqual(actual.status, 0, actual.stderr);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').includes('changed'), mode !== '--cached', command);
        assert.strictEqual(git(dir, ['show', ':README.md']).includes('changed'), mode !== '', command);
        git(dir, ['reset', '--hard', '-q', 'HEAD']);
      }
    }
    for (const command of [
      `bash -c 'git apply --stat --apply --index ${patch}' && git commit -m changed`,
      `git apply --stat --no-st --index ${patch} && git commit -m changed`,
    ]) assert.strictEqual(deliveryGate(dir, command).status, 2, command);
    const before = git(dir, ['rev-parse', 'HEAD^{tree}']);
    git(dir, ['apply', '--stat', '--apply', '--index', patch]);
    git(dir, ['commit', '-qm', 'disposable changed candidate']);
    assert.notStrictEqual(git(dir, ['rev-parse', 'HEAD^{tree}']), before, 'actual commit consumes the post-apply tree');
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitApplyReportsRemainReadOnly() {
  withRepo(dir => {
    const patch = applyFixture(dir);
    const before = git(dir, ['write-tree']);
    for (const mode of ['', '--index', '--cached']) {
      for (const options of ['--stat', '--numstat', '--summary', '--check', '--stat --apply --no-apply',
        '--apply --no-apply --check', '--stat --check --no-stat', '--no-stat --stat']) {
        const args = ['apply', ...options.split(' '), ...mode.split(' ').filter(Boolean), patch];
        const command = `git ${args.join(' ')} && git commit --allow-empty -m unchanged`;
        const result = deliveryGate(dir, command);
        assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
        const actual = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
        assert.strictEqual(actual.status, 0, actual.stderr);
        assert.strictEqual(git(dir, ['write-tree']), before);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# fixture\n');
      }
    }
  });
}

function testGitStandaloneApplyRemainsAvailable() {
  withRepo(dir => {
    const patch = applyFixture(dir);
    for (const mode of ['', '--index', '--cached']) {
      const args = ['apply', ...mode.split(' ').filter(Boolean), patch];
      const command = `git ${args.join(' ')}`;
      const gate = deliveryGate(dir, command);
      assert.strictEqual(gate.status, 0, `${command}: ${gate.stderr}`);
      const actual = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').includes('changed'), mode !== '--cached');
      assert.strictEqual(git(dir, ['show', ':README.md']).includes('changed'), mode !== '');
      git(dir, ['reset', '--hard', '-q', 'HEAD']);
    }
  });
}

function testGitApplyAuxiliaryIndexOutputIsNotReadOnly() {
  withRepo(dir => {
    const patch = applyFixture(dir);
    const output = '.git/report-index';
    const command = `git apply --stat --build-fake-ancestor ${output} ${patch}`;
    const result = deliveryGate(dir, `${command} && git commit --allow-empty -m unchanged`);
    const actual = spawnSync('git', ['apply', '--stat', '--build-fake-ancestor', output, patch], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(actual.status, 0, actual.stderr);
    assert.ok(fs.statSync(path.join(dir, output)).size > 0, 'reporting apply still creates its auxiliary index');
    assert.strictEqual(result.status, 2, result.stderr);
    assert.strictEqual(deliveryGate(dir, command).status, 2, 'auxiliary index output is outside supported standalone apply');
  });
}

function testGitIdentityRemainsBoundToRawObjects() {
  for (const format of ['sha1', 'sha256']) withRepo(dir => {
    const original = git(dir, ['rev-parse', 'HEAD']);
    const originalTree = git(dir, ['rev-parse', 'HEAD^{tree}']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# second fixture version\n');
    git(dir, ['commit', '-qam', 'second version']);
    const current = git(dir, ['rev-parse', 'HEAD']);
    const currentTree = git(dir, ['rev-parse', 'HEAD^{tree}']);
    const cleanIdentity = attestation.readGitIdentity(dir);
    assert.strictEqual(cleanIdentity.available, true);
    assert.strictEqual(cleanIdentity.dirty, false);
    assert.strictEqual(cleanIdentity.tree, currentTree);
    for (const [from, to] of [[current, original], [currentTree, originalTree]]) {
      git(dir, ['replace', from, to]);
      try {
        assert.notStrictEqual(git(dir, ['show', 'HEAD:README.md']), '# second fixture version',
          'fixture must provide a different local object view');
        assert.deepStrictEqual(attestation.readGitIdentity(dir), cleanIdentity,
          `${format}: local object views must not change the identity of the actual current tree`);
      } finally { git(dir, ['replace', '-d', from]); }
    }
    git(dir, ['checkout', '-q', '--detach', original]);
    const originalIdentity = attestation.readGitIdentity(dir);
    git(dir, ['replace', original, current]);
    try {
      assert.deepStrictEqual(attestation.readGitIdentity(dir), originalIdentity,
        `${format}: a genuine original tree must remain valid under a replacement view`);
    } finally { git(dir, ['replace', '-d', original]); }
    assert.deepStrictEqual(attestation.readGitIdentity(dir), originalIdentity);
  }, format);
}

function testGitAnnotatedTargetsUseRawObjects() {
  for (const format of ['sha1', 'sha256']) withRepo(dir => {
    git(dir, ['tag', '-a', 'previous-version', '-m', 'previous']);
    const previousTag = git(dir, ['rev-parse', 'previous-version']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# current fixture version\n');
    git(dir, ['commit', '-qam', 'current version']);
    git(dir, ['tag', '-a', 'current-version', '-m', 'current']);
    const currentTag = git(dir, ['rev-parse', 'current-version']);
    prepareDeliveryEvidence(dir);
    const currentTarget = 'git tag reviewed-version current-version';
    const previousTarget = 'git tag reviewed-version previous-version';
    assert.strictEqual(deliveryGate(dir, currentTarget).status, 0, `${format}: current target control`);
    assert.strictEqual(deliveryGate(dir, previousTarget).status, 2, `${format}: old target control`);
    git(dir, ['replace', previousTag, currentTag]);
    try {
      assert.strictEqual(deliveryGate(dir, previousTarget).status, 2,
        `${format}: target comparison must use the original annotated object`);
    } finally { git(dir, ['replace', '-d', previousTag]); }
    git(dir, ['replace', currentTag, previousTag]);
    try {
      assert.strictEqual(deliveryGate(dir, currentTarget).status, 0,
        `${format}: valid original target must retain its normal classification`);
    } finally { git(dir, ['replace', '-d', currentTag]); }
  }, format);
}

function testGitUnquotedTildeCannotBindLiteralRepository() {
  withRepo(dir => withRepo(other => {
    fs.symlinkSync(dir, path.join(dir, '~'));
    fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\n/~\n');
    prepareDeliveryEvidence(dir);
    const environment = { ...process.env, HOME: other };
    const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
    const shellModes = [['bash', ['--noprofile', '--norc', '-c']], ['zsh', ['-fc']]];
    const failures = [];
    assert.strictEqual(deliveryGate(dir, `git -C ${quote(other)} push origin HEAD`, environment).status, 2);
    assert.strictEqual(deliveryGate(dir, "git -C '~' push origin HEAD", environment).status, 0,
      'fresh evidence must authorize the actual literal repository');
    for (const [shell, flags] of shellModes) {
      const probe = spawnSync(shell, [...flags, "printf '%s' ready"], { cwd: dir, encoding: 'utf8', env: environment });
      if (probe.error && probe.error.code === 'ENOENT') {
        console.log(`INFO optional ${shell} unavailable; tilde gate regressions still run`);
        continue;
      }
      assert.strictEqual(probe.status, 0, probe.stderr);
      for (const spelling of ['~', '~/', '~/.git/..']) {
        for (const wrapper of ['', 'command ', 'env LANG=C ']) {
          const safe = `${wrapper}git -C ${spelling} rev-parse --show-toplevel`;
          const actual = spawnSync(shell, [...flags, safe], { cwd: dir, encoding: 'utf8', env: environment });
          assert.strictEqual(actual.status, 0, `${shell} ${safe}: ${actual.stderr}`);
          assert.strictEqual(fs.realpathSync(actual.stdout.trim()), other, 'shell selects HOME, not the literal symlink');
          const delivery = `${wrapper}git -C ${spelling} push origin HEAD`;
          for (const command of [delivery, `${shell} ${flags.join(' ')} ${quote(delivery)}`]) {
            const result = deliveryGate(dir, command, environment);
            if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
          }
        }
      }
      if (shell === 'zsh') {
        for (const spelling of ['""~', "''~"]) {
          const safe = `git -C ${spelling} rev-parse --show-toplevel`;
          const actual = spawnSync(shell, [...flags, safe], { cwd: dir, encoding: 'utf8', env: environment });
          assert.strictEqual(actual.status, 0, actual.stderr);
          assert.strictEqual(fs.realpathSync(actual.stdout.trim()), other, 'empty quoting does not prevent Zsh tilde expansion');
          const result = deliveryGate(dir, `git -C ${spelling} push origin HEAD`, environment);
          if (result.status !== 2) failures.push(`empty-quote ${spelling}: ${result.status} ${result.stderr}`);
        }
      }
    }
    for (const spelling of ['~+', '~-', '~root', '~missing-user']) {
      const result = deliveryGate(dir, `git rev-parse --sq-quote ${spelling}`, environment);
      if (result.status !== 2) failures.push(`named/directory tilde ${spelling}: ${result.status} ${result.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testGitTildeAssignmentWordsCannotHideExpansion() {
  withRepo(dir => {
    const taskHome = path.join(dir, '.git/task-home');
    fs.mkdirSync(taskHome);
    const environment = { ...process.env, HOME: taskHome };
    const failures = [];
    for (const spelling of ['SHK_PATH=~', 'SHK_PATH=~/child', 'SHK_PATH=literal:~', 'SHK_PATH="literal\n":~']) {
      const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', `printf '%s' ${spelling}`], {
        cwd: dir, encoding: 'utf8', env: environment,
      });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(actual.stdout.includes(taskHome), 'Bash expands tilde within assignment-shaped argument words');
      for (const command of [`git rev-parse --sq-quote ${spelling}`, `${spelling} git rev-parse --show-toplevel`,
        `env ${spelling} git rev-parse --show-toplevel`]) {
        const result = deliveryGate(dir, command, environment);
        if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitTildeLiteralsAndOrdinaryPathsRemainAvailable() {
  withRepo(dir => withRepo(other => {
    fs.symlinkSync(dir, path.join(dir, '~'));
    fs.symlinkSync(dir, path.join(dir, '.git/literal~'));
    fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\n/~\n');
    prepareDeliveryEvidence(dir);
    const environment = { ...process.env, HOME: other };
    const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
    for (const [shell, flags] of [['bash', ['--noprofile', '--norc', '-c']], ['zsh', ['-fc']]]) {
      const probe = spawnSync(shell, [...flags, "printf '%s' ready"], { cwd: dir, encoding: 'utf8', env: environment });
      const shellAvailable = !probe.error || probe.error.code !== 'ENOENT';
      if (shellAvailable) assert.strictEqual(probe.status, 0, probe.stderr);
      for (const spelling of ["'~'", '"~"', String.raw`\~`, './~', '.git/literal~']) {
        for (const wrapper of ['', 'command ', 'env LANG=C ']) {
          const safe = `${wrapper}git -C ${spelling} rev-parse --show-toplevel`;
          const delivery = `${wrapper}git -C ${spelling} push origin HEAD`;
          if (shellAvailable) {
            const actual = spawnSync(shell, [...flags, safe], { cwd: dir, encoding: 'utf8', env: environment });
            assert.strictEqual(actual.status, 0, `${safe}: ${actual.stderr}`);
            assert.strictEqual(fs.realpathSync(actual.stdout.trim()), dir);
          }
          for (const command of [delivery, `${shell} ${flags.join(' ')} ${quote(delivery)}`]) {
            const result = deliveryGate(dir, command, environment);
            assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
          }
        }
      }
      for (const command of [
        "git rev-parse --sq-quote HEAD~1 path/~ file~ 'SHK_PATH=~'",
        'git rev-parse --sq-quote "SHK_PATH=~" SHK_PATH=\\~',
      ]) {
        const result = deliveryGate(dir, command, environment);
        assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
        if (shellAvailable) {
          const actual = spawnSync(shell, [...flags, command], { cwd: dir, encoding: 'utf8', env: environment });
          assert.strictEqual(actual.status, 0, actual.stderr);
          assert.ok(!actual.stdout.includes(other), 'quoted and escaped tildes remain literal');
        }
      }
    }
  }));
}

function testGitViewerOutputCannotShareDeliveryEvidence() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const original = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    const failures = [];
    for (const base of [['diff', 'HEAD'], ['log', '-1'], ['show', 'HEAD'], ['reflog', 'show', '-1'],
      ['rev-list', 'HEAD'], ['blame', 'README.md'], ['shortlog', 'HEAD']]) {
      for (const output of [['--output', 'README.md'], ['--output=README.md']]) {
        const args = [...base, ...output];
        const command = `git ${args.join(' ')}`;
        const standalone = deliveryGate(dir, command);
        assert.strictEqual(standalone.status, 0, `${command}: ${standalone.stderr}`);
        const combined = deliveryGate(dir, `${command} && git commit -am output-candidate`);
        if (combined.status !== 2) failures.push(`${command}: ${combined.status} ${combined.stderr}`);
        const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
        assert.strictEqual(actual.status, 0, `${command}: ${actual.stderr}`);
        assert.notStrictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original,
          `${command} actually rewrites the previously verified source`);
        fs.writeFileSync(path.join(dir, 'README.md'), original);
      }
    }
    for (const command of [
      "bash -c 'git diff --output=README.md HEAD' && git commit -am nested-output",
      'git log -1 --output=README.md; git tag v-output',
      'git push origin HEAD; git show HEAD --output=README.md',
      'printf "%s" "$(git diff --output=README.md HEAD)" && git commit -am substitution-output',
      'git stash list --output=README.md && git commit -am stash-output',
      'git stash show --output=README.md && git commit -am stash-output',
    ]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitOutputOptionsCannotBeHiddenOrCancelled() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const original = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    const failures = [];
    for (const sub of ['diff', 'log', 'show']) {
      for (const flag of ['--abbrev', '--pretty', ...(sub === 'diff' ? ['-U'] : [])]) {
        const args = [sub, flag, '--output=README.md'];
        const command = `git ${args.join(' ')}`;
        const standalone = deliveryGate(dir, command);
        assert.strictEqual(standalone.status, 0, `${command}: ${standalone.stderr}`);
        const result = deliveryGate(dir, `${command} && git commit -am option-output`);
        if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
        const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
        assert.strictEqual(actual.status, 0, actual.stderr);
        assert.notStrictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original);
        fs.writeFileSync(path.join(dir, 'README.md'), original);
      }
      for (const options of [['--format', '--output=README.md'], ['--message', '--output=README.md'],
        ['--output=README.md', '--no-output']]) {
        const args = [sub, ...options];
        const command = `git ${args.join(' ')}`;
        const result = deliveryGate(dir, `${command}; git commit -am failed-output`);
        if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
        const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
        assert.notStrictEqual(actual.status, 0, 'the unsupported option must really fail');
        assert.notStrictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original,
          'Git can truncate output before rejecting another option');
        fs.writeFileSync(path.join(dir, 'README.md'), original);
      }
      for (const option of ['--out=README.md', '--out README.md', '--output-file=README.md']) {
        const result = deliveryGate(dir, `git ${sub} ${option}; git commit -am unknown-output`);
        if (result.status !== 2) failures.push(`${sub} ${option}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitReadOnlyViewerOptionsRemainAvailable() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const original = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    for (const args of [
      ['diff', 'HEAD'], ['log', '-1'], ['show', 'HEAD'], ['reflog', 'show', '-1'],
      ['rev-list', 'HEAD'], ['blame', 'README.md'], ['shortlog', 'HEAD'],
      ['diff', '--abbrev', '--pretty', 'HEAD'], ['log', '--abbrev', '--pretty', '-1'],
      ['show', '--abbrev', '--pretty', 'HEAD'],
      ['diff', '-U', 'HEAD'],
      ['diff', '-S', '--output=README.md', 'HEAD'], ['diff', '-G', '--output=README.md', 'HEAD'],
      ['log', '-S', '--output=README.md', '-1'], ['log', '-G', '--output=README.md', '-1'],
      ['show', '-S', '--output=README.md', 'HEAD'], ['show', '-G', '--output=README.md', 'HEAD'],
      ['diff', '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ', 'HEAD'],
      ['log', '--grep', '--output=README.md', '-1'],
      ['log', '--author', '--output=README.md', '-1'],
      ['show', '--format=format:--output=README.md', 'HEAD'],
      ['diff', '--', '--output=README.md'],
    ]) {
      const command = 'git ' + args.map(value => `'${value.replace(/'/g, "'\\''")}'`).join(' ');
      const result = deliveryGate(dir, `${command} && git commit --allow-empty -m unchanged`);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, `${command}: ${actual.stderr}`);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original);
    }
  });
}

function prepareStashViewerFixture(dir) {
  const original = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  fs.appendFileSync(path.join(dir, 'README.md'), 'stored fixture change\n');
  git(dir, ['stash', 'push', '-qm', 'viewer fixture']);
  prepareDeliveryEvidence(dir);
  return original;
}

function testGitStashViewerFlagsCannotHideOutput() {
  withRepo(dir => {
    const original = prepareStashViewerFixture(dir);
    const before = attestation.readGitIdentity(dir).candidate_digest;
    const failures = [];
    const variants = [];
    for (const mode of ['show', 'list']) {
      for (const flags of [[], ['-m'], ['-pm']]) {
        for (const output of mode === 'show' ? [['--output=README.md']] : [['--output=README.md'], ['--output', 'README.md']]) {
          variants.push(['stash', mode, ...flags, ...output]);
        }
      }
    }
    variants.push(['stash', 'list', '--', '--output=README.md']);
    variants.push(['stash', 'list', '-m', '--', '--output=README.md']);
    for (const args of variants) {
      const command = `git ${args.join(' ')}`;
      const standalone = deliveryGate(dir, command);
      assert.strictEqual(standalone.status, 0, `${command}: ${standalone.stderr}`);
      const result = deliveryGate(dir, `${command}; git push origin HEAD:refs/heads/main`);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      if (!args.includes('-pm')) assert.strictEqual(actual.status, 0, actual.stderr);
      else assert.notStrictEqual(actual.status, 0, 'invalid cluster can still truncate output before failing');
      assert.notStrictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original, command);
      assert.notStrictEqual(attestation.readGitIdentity(dir).candidate_digest, before,
        'the output changes the exact candidate authorized before execution');
      fs.writeFileSync(path.join(dir, 'README.md'), original);
    }
    for (const command of [
      "bash -c 'git stash show -m --output=README.md' && git push origin HEAD:refs/heads/main",
      "bash -c 'git stash list -m --output=README.md' && git push origin HEAD:refs/heads/main",
    ]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitStashReadOnlyFlagsAndDelimitersRemainAvailable() {
  withRepo(dir => {
    const original = prepareStashViewerFixture(dir);
    for (const args of [
      ['stash', 'show', '-p'], ['stash', 'show', '-m'],
      ['stash', 'list', '-p'], ['stash', 'list', '-m'],
      ['stash', 'show', '-S', '--output=README.md'], ['stash', 'show', '-G', '--output=README.md'],
      ['stash', 'list', '-S', '--output=README.md'], ['stash', 'list', '-G', '--output=README.md'],
      ['stash', 'show', '--', '--output=README.md'],
      ['stash', 'list', '--', '--', '--output=README.md'],
      ['stash', 'list', '--', '-S', '--output=README.md'],
    ]) {
      const command = `git ${args.join(' ')}`;
      const result = deliveryGate(dir, `${command} && git push origin HEAD:refs/heads/main`);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original);
    }
  });
}

function testGitStashMutationMessagesRemainLiteral() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const original = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    const failures = [];
    for (const args of [
      ['stash', 'push', '-m', '--output=README.md'], ['stash', 'push', '--message', '--output=README.md'],
      ['stash', 'save', '-m', '--output=README.md'], ['stash', 'save', '--message', '--output=README.md'],
      ['stash', '-m', 'show'], ['stash', '-m', 'list'],
    ]) {
      const command = `git ${args.join(' ')}`;
      const standalone = deliveryGate(dir, command);
      if (standalone.status !== 0) failures.push(`${command}: ${standalone.status} ${standalone.stderr}`);
      assert.strictEqual(deliveryGate(dir, `${command} && git push origin HEAD:refs/heads/main`).status, 2,
        'a local stash mutation still cannot share pre-command delivery evidence');
      fs.writeFileSync(path.join(dir, 'README.md'), `${original}stash message fixture\n`);
      const actual = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original);
      assert.ok(git(dir, ['log', '-g', '-1', '--format=%gs', 'refs/stash']).endsWith(args[args.length - 1]),
        'Git preserves the option-looking value or display name as a stash message');
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitViewerShortClustersCannotHideOutput() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const original = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    const failures = [];
    for (const args of [
      ['log', '-xn', '--output=README.md'], ['log', '-pn', '--output=README.md'],
      ['show', '-sn', '--output=README.md'], ['rev-list', '-xn', '--output=README.md', 'HEAD'],
      ['diff', '-xS', '--output=README.md'], ['log', '-xS', '--output=README.md'],
      ['show', '-xL', '--output=README.md'],
    ]) {
      const command = `git ${args.join(' ')}`;
      for (const spelling of [command, `${command}; git commit -am changed-output`]) {
        const result = deliveryGate(dir, spelling);
        if (result.status !== 2) failures.push(`${spelling}: ${result.status} ${result.stderr}`);
      }
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.notStrictEqual(actual.status, 0, 'Git really rejects the short option cluster');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '',
        'the rejected cluster does not prevent earlier output truncation');
      fs.writeFileSync(path.join(dir, 'README.md'), original);
    }
    for (const args of [
      ['log', '-n', '1'],
      ['diff', '-S', '--output=README.md'], ['diff', '-G', '--output=README.md'],
      ['log', '-S', '--output=README.md'], ['log', '-G', '--output=README.md'],
      ['show', '-S', '--output=README.md'], ['show', '-G', '--output=README.md'],
    ]) {
      const command = `git ${args.join(' ')}`;
      const gate = deliveryGate(dir, `${command} && git commit --allow-empty -m unchanged`);
      assert.strictEqual(gate.status, 0, `${command}: ${gate.stderr}`);
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original);
    }
    for (const command of ['git commit -qm fixture', 'git tag -am fixture v-short-cluster-control']) {
      assert.strictEqual(deliveryGate(dir, command).status, 0, 'existing commit/tag clusters remain valid');
    }
    const output = 'git log -n1 --output=README.md';
    assert.strictEqual(deliveryGate(dir, output).status, 0);
    assert.strictEqual(deliveryGate(dir, `${output}; git commit -am changed-output`).status, 2);
    const actual = spawnSync('git', ['log', '-n1', '--output=README.md'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(actual.status, 0, actual.stderr);
    assert.notStrictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original);
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitReflogAndUpstreamLiteralsRemainAvailable() {
  withRepo(dir => {
    git(dir, ['commit', '--allow-empty', '-qm', 'reflog fixture']);
    const branch = git(dir, ['branch', '--show-current']);
    git(dir, ['config', `branch.${branch}.remote`, '.']);
    git(dir, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
    const original = prepareStashViewerFixture(dir);
    const failures = [];
    for (const command of [
      'git stash show -p stash@{0}', 'git log -1 HEAD@{1}',
      'git rev-parse HEAD @{u}', 'git reflog show stash@{0}',
      'git rev-parse @{upstream}', 'git log -1 HEAD@{yesterday}',
      "git stash show -p 'stash@{0}'", 'git rev-parse "@{u}"',
    ]) {
      for (const [shell, flags] of [['bash', ['--noprofile', '--norc', '-c']], ['zsh', ['-fc']]]) {
        const actual = spawnSync(shell, [...flags, command], { cwd: dir, encoding: 'utf8' });
        if (actual.error && actual.error.code === 'ENOENT' && shell === 'zsh') continue;
        assert.strictEqual(actual.status, 0, `${shell}: ${command}: ${actual.stderr}`);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original);
      }
      for (const spelling of [command, `${command} && git commit --allow-empty -m literal-ref`]) {
        const result = deliveryGate(dir, spelling);
        if (result.status !== 0) failures.push(`${spelling}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitReflogLiteralsDoNotEnableShellExpansion() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    for (const word of ['HEAD@{0,1}', 'HEAD@{0..1}', 'HEAD@{{0,1}}']) {
      for (const [shell, flags] of [['bash', ['--noprofile', '--norc', '-c']], ['zsh', ['-fc']]]) {
        const actual = spawnSync(shell, [...flags, `printf '<%s>\n' ${word}`], { cwd: dir, encoding: 'utf8' });
        if (actual.error && actual.error.code === 'ENOENT' && shell === 'zsh') continue;
        assert.strictEqual(actual.status, 0, actual.stderr);
        assert.strictEqual(actual.stdout.trim().split('\n').length, 2, 'brace expansion creates multiple shell words');
      }
    }
    for (const command of [
      'git rev-parse HEAD@{0,1}', 'git rev-parse HEAD@{0..1}',
      'git rev-parse HEAD@{{0,1}}', 'git rev-parse HEAD@{0}{a,b}',
      'git rev-parse HEAD@{0}*', 'git rev-parse $HOME@{u}',
      '{ git status --short; }',
    ]) {
      const result = deliveryGate(dir, `${command}; git commit --allow-empty -m expansion`);
      assert.strictEqual(result.status, 2, `${command}: ${result.stderr}`);
    }
    for (const command of ["git rev-parse --sq-quote 'HEAD@{0,1}'", 'git rev-parse --sq-quote "HEAD@{0..1}"']) {
      const result = deliveryGate(dir, `${command}; git commit --allow-empty -m literal-brace`);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
    }
  });
}

function testGitBlameOutputAfterFilenameCannotShareEvidence() {
  withRepo(dir => {
    fs.writeFileSync(path.join(dir, '--output=README.md'), 'literal option filename\n');
    git(dir, ['add', '--', '--output=README.md']);
    git(dir, ['commit', '-qm', 'literal blame path fixture']);
    prepareDeliveryEvidence(dir);
    const original = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    const before = attestation.readGitIdentity(dir).candidate_digest;
    const failures = [];
    for (const args of [
      ['blame', '--', 'README.md', '--output=README.md'],
      ['blame', '--', '--', '--output=README.md'],
      ['blame', '--', 'missing.md', '--output=README.md'],
      ['blame', '--', '--output=README.md', '--output=README.md'],
    ]) {
      const command = `git ${args.join(' ')}`;
      const standalone = deliveryGate(dir, command);
      assert.strictEqual(standalone.status, 0, `${command}: ${standalone.stderr}`);
      for (const delivery of ['git commit -am changed-output', 'git push origin HEAD:refs/heads/main']) {
        const result = deliveryGate(dir, `${command}; ${delivery}`);
        if (result.status !== 2) failures.push(`${command}; ${delivery}: ${result.status} ${result.stderr}`);
      }
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      if (args[args.indexOf('--') + 1] === '--' || args.includes('missing.md')) assert.notStrictEqual(actual.status, 0,
        'missing filename fails after the output is truncated');
      else assert.strictEqual(actual.status, 0, `${command}: ${actual.stderr}`);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '', command);
      assert.notStrictEqual(attestation.readGitIdentity(dir).candidate_digest, before,
        'blame output changes the candidate that was authorized before execution');
      fs.writeFileSync(path.join(dir, 'README.md'), original);
    }
    const nested = "bash -c 'git blame -- README.md --output=README.md'; git commit -am nested-blame";
    const result = deliveryGate(dir, nested);
    if (result.status !== 2) failures.push(`${nested}: ${result.status} ${result.stderr}`);
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitBlameDelimiterFilenameRemainsLiteral() {
  withRepo(dir => {
    const filenames = ['--output=README.md', '--output', '--', '-w'];
    for (const filename of filenames) fs.writeFileSync(path.join(dir, filename), `literal path ${filename}\n`);
    git(dir, ['add', '--', ...filenames]);
    git(dir, ['commit', '-qm', 'blame literal filename fixture']);
    prepareDeliveryEvidence(dir);
    const before = attestation.readGitIdentity(dir).candidate_digest;
    for (const args of [
      ['blame', '--', 'README.md'], ['blame', 'HEAD', '--', 'README.md'],
      ...filenames.map(filename => ['blame', '--', filename]),
      ['blame', '--', './--output=README.md'],
      ['blame', '--', '--output=README.md', '--'],
    ]) {
      const command = `git ${args.join(' ')}`;
      const result = deliveryGate(dir, `${command} && git commit --allow-empty -m literal-path`);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, `${command}: ${actual.stderr}`);
      assert.strictEqual(attestation.readGitIdentity(dir).candidate_digest, before,
        'filename positions remain literal and do not write output');
    }
  });
}

function testGitShortlogCommitterCannotHideOutput() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const original = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    const before = attestation.readGitIdentity(dir).candidate_digest;
    const failures = [];
    for (const flag of ['--committer', '-c', '--no-committer', '-ensc']) {
      for (const output of [['--output=README.md'], ['--output', 'README.md']]) {
        const args = ['shortlog', flag, ...output, 'HEAD'];
        const command = `git ${args.join(' ')}`;
        const standalone = deliveryGate(dir, command);
        assert.strictEqual(standalone.status, 0, `${command}: ${standalone.stderr}`);
        const result = deliveryGate(dir, `${command} && git commit -am shortlog-output`);
        if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
        const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
        assert.strictEqual(actual.status, 0, `${command}: ${actual.stderr}`);
        assert.notStrictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original);
        assert.notStrictEqual(attestation.readGitIdentity(dir).candidate_digest, before,
          'shortlog output changes the previously verified candidate');
        fs.writeFileSync(path.join(dir, 'README.md'), original);
      }
    }
    for (const command of [
      'git shortlog --committer --output=README.md HEAD; git push origin HEAD:refs/heads/main',
      "bash -c 'git shortlog --committer --output=README.md HEAD'; git commit -am nested-output",
    ]) {
      const result = deliveryGate(dir, command);
      if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitShortlogBooleanOptionsRemainAvailable() {
  withRepo(dir => {
    git(dir, ['config', 'user.name', 'SHK committer']);
    git(dir, ['commit', '--allow-empty', '--author=Different Author <author@example.com>', '-qm', 'committer fixture']);
    prepareDeliveryEvidence(dir);
    const before = attestation.readGitIdentity(dir).candidate_digest;
    const failures = [];
    const grouped = git(dir, ['shortlog', '--committer', 'HEAD']);
    assert.strictEqual(grouped, git(dir, ['shortlog', '-c', 'HEAD']));
    assert.ok(grouped.includes('SHK committer') && !grouped.includes('Different Author'),
      'the long and short boolean options group by committer instead of author');
    for (const flag of ['--committer', '-c', '--no-committer', '-e', '--email', '-s', '--summary',
      '-n', '--numbered', '-w', '-w80,4,8', '-ensc']) {
      for (const args of [['shortlog', flag, 'HEAD'], ['shortlog', 'HEAD', flag]]) {
        const command = `git ${args.join(' ')}`;
        const result = deliveryGate(dir, `${command} && git commit --allow-empty -m unchanged`);
        if (result.status !== 0) failures.push(`${command}: ${result.status} ${result.stderr}`);
        const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
        assert.strictEqual(actual.status, 0, `${command}: ${actual.stderr}`);
        assert.strictEqual(attestation.readGitIdentity(dir).candidate_digest, before);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitRevisionCommitterPatternsRemainLiteral() {
  withRepo(dir => {
    prepareStashViewerFixture(dir);
    const before = attestation.readGitIdentity(dir).candidate_digest;
    const commands = [];
    for (const base of [['log'], ['show'], ['rev-list'], ['reflog', 'show'], ['stash', 'list']]) {
      for (const pattern of ['--output=README.md', '--output', 'SHK evidence test']) {
        commands.push([...base, '--committer', pattern, 'HEAD']);
      }
    }
    for (const flag of ['--author', '--grep']) {
      for (const pattern of ['--output=README.md', '--output']) commands.push(['shortlog', flag, pattern, 'HEAD']);
    }
    for (const args of commands) {
      const command = 'git ' + args.map(value => `'${value.replace(/'/g, "'\\''")}'`).join(' ');
      const result = deliveryGate(dir, `${command} && git commit --allow-empty -m literal-pattern`);
      assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, `${command}: ${actual.stderr}`);
      assert.strictEqual(attestation.readGitIdentity(dir).candidate_digest, before,
        'revision filters consume their literal values without writing output');
    }
  });
}

function envLongChdirProgram(dir) {
  // BSD env supports -C but not --chdir. Long-form hook controls always run;
  // actual long-form probes use GNU env only when it is already available.
  for (const program of ['env', '/opt/homebrew/opt/coreutils/libexec/gnubin/env',
    '/usr/local/opt/coreutils/libexec/gnubin/env']) {
    const result = spawnSync(program, ['--chdir=.', 'git', 'rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
    if (result.status === 0) return program;
  }
  return null;
}

function testEnvDirectoryLiteralTildesRemainAvailable() {
  withRepo(dir => withRepo(other => {
    fs.symlinkSync(dir, path.join(dir, '~'));
    fs.symlinkSync(dir, path.join(dir, '.git/literal~'));
    fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\n/~\n');
    prepareDeliveryEvidence(dir);
    const environment = { ...process.env, HOME: other };
    const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
    const longEnv = envLongChdirProgram(dir);
    const failures = [];
    for (const [shell, flags] of [['bash', ['--noprofile', '--norc', '-c']], ['zsh', ['-fc']]]) {
      const available = spawnSync(shell, [...flags, 'true'], { cwd: dir, encoding: 'utf8' });
      const hasShell = !(available.error && available.error.code === 'ENOENT');
      for (const prefix of [
        "env -C '~'", 'env -C "~"', String.raw`env -C \~`,
        'env -C ./~', 'env -C .git/literal~', 'env -C~',
        "env --chdir '~'", 'env --chdir=~', 'env --chdir=./~', 'env --chdir=.git/literal~',
      ]) {
        const actualPrefix = prefix.includes('--chdir')
          ? longEnv && prefix.replace(/^env /, `${quote(longEnv)} `) : prefix;
        if (hasShell && actualPrefix) {
          const actual = spawnSync(shell, [...flags, `${actualPrefix} git rev-parse --show-toplevel`], {
            cwd: dir, encoding: 'utf8', env: environment,
          });
          assert.strictEqual(actual.status, 0, `${shell} ${actualPrefix}: ${actual.stderr}`);
          assert.strictEqual(fs.realpathSync(actual.stdout.trim()), dir,
            'quoted, escaped and internal tildes select the literal directory');
        }
        const delivery = `${prefix} git commit --allow-empty -m literal-directory`;
        for (const command of [delivery, `${shell} ${flags.join(' ')} ${quote(delivery)}`]) {
          const result = deliveryGate(dir, command, environment);
          if (result.status !== 0) failures.push(`${command}: ${result.status} ${result.stderr}`);
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testEnvDirectoryExpansionAndWrongRepositoryRemainRejected() {
  withRepo(dir => withRepo(other => {
    fs.symlinkSync(dir, path.join(dir, '~'));
    fs.symlinkSync(other, path.join(dir, '.git/other~'));
    fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\n/~\n');
    prepareDeliveryEvidence(dir);
    const environment = { ...process.env, HOME: other };
    const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
    const longEnv = envLongChdirProgram(dir);
    for (const [shell, flags] of [['bash', ['--noprofile', '--norc', '-c']], ['zsh', ['-fc']]]) {
      const available = spawnSync(shell, [...flags, 'true'], { cwd: dir, encoding: 'utf8' });
      const hasShell = !(available.error && available.error.code === 'ENOENT');
      const expanded = ['env -C ~', 'env -C ~/', 'env --chdir ~', 'env --chdir ~/.git/..'];
      const staticOther = ['env -C .git/other~', 'env --chdir=.git/other~',
        `env -C ${quote(other)}`, `env --chdir ${quote(other)}`];
      const emptyQuoted = shell === 'zsh' ? ['env -C ""~', "env -C ''~", 'env --chdir ""~', "env --chdir ''~"] : [];
      for (const prefix of [...expanded, ...staticOther, ...emptyQuoted]) {
        const actualPrefix = prefix.includes('--chdir')
          ? longEnv && prefix.replace(/^env /, `${quote(longEnv)} `) : prefix;
        if (hasShell && actualPrefix) {
          const actual = spawnSync(shell, [...flags, `${actualPrefix} git rev-parse --show-toplevel`], {
            cwd: dir, encoding: 'utf8', env: environment,
          });
          assert.strictEqual(actual.status, 0, `${shell} ${actualPrefix}: ${actual.stderr}`);
          assert.strictEqual(fs.realpathSync(actual.stdout.trim()), other,
            'the real wrapper selects the other repository');
        }
        const delivery = `${prefix} git commit --allow-empty -m wrong-directory`;
        for (const command of [delivery, `${shell} ${flags.join(' ')} ${quote(delivery)}`]) {
          const result = deliveryGate(dir, command, environment);
          assert.strictEqual(result.status, 2, `${command}: ${result.stderr}`);
          if (staticOther.includes(prefix) && !prefix.includes('other~')) {
            assert.match(result.stderr, /GIT_DELIVERY_REPOSITORY_MISMATCH/);
          }
        }
      }
    }
  }));
}

function prepareEnvPhysicalDirectoryFixture(dir, other) {
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.mkdirSync(path.join(dir, path.basename(other)));
  fs.mkdirSync(path.join(other, 'sub'));
  fs.symlinkSync(path.join(other, 'sub'), path.join(dir, 'link'));
  fs.symlinkSync(path.join(dir, 'sub'), path.join(dir, 'same-link'));
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\n/link\n/same-link\n');
  prepareDeliveryEvidence(dir);
}

function checkActualEnvRepository(dir, controls, expected) {
  const program = controls.some(arg => arg.startsWith('--chdir')) ? envLongChdirProgram(dir) : 'env';
  if (!program) return; // Long-form hook checks still run on BSD-only systems.
  const args = controls.map(arg => arg === 'env' ? program : arg);
  const actual = spawnSync(program, [...args, 'git', 'rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(actual.status, 0, `${program} ${controls.join(' ')}: ${actual.stderr}`);
  assert.strictEqual(fs.realpathSync(actual.stdout.trim()), expected);
}

function testEnvRepeatedDirectoryOptionsAreRejected() {
  withRepo(dir => withRepo(other => {
    prepareEnvPhysicalDirectoryFixture(dir, other);
    const relative = path.relative(dir, other);
    const failures = [];
    for (const controls of [
      ['-C', 'sub', '-C', relative], ['-Csub', `-C${relative}`],
      ['--chdir', 'sub', `--chdir=${relative}`], ['-C', 'sub', '--chdir', relative],
      ['-C', 'sub', '-C', '.'],
    ]) {
      checkActualEnvRepository(dir, controls, controls[controls.length - 1] === '.' ? dir : other);
      const prefix = 'env ' + controls.map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
      for (const action of ['commit --allow-empty -m repeated-directory', 'push origin HEAD:refs/heads/main']) {
        const result = deliveryGate(dir, `${prefix} git ${action}`);
        if (result.status !== 2) failures.push(`${prefix} git ${action}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testEnvSymlinkParentCannotBindLiteralRepository() {
  withRepo(dir => withRepo(other => {
    prepareEnvPhysicalDirectoryFixture(dir, other);
    const physicalPath = `${dir}/link/..`;
    assert.strictEqual(fs.realpathSync.native(physicalPath), other, 'native realpath preserves symlink/.. order');
    const failures = [];
    for (const controls of [
      ['-C', 'link/..'], ['-Clink/..'], ['--chdir', 'link/..'], ['--chdir=link/..'],
      ['-C', physicalPath], [`--chdir=${physicalPath}`],
    ]) {
      checkActualEnvRepository(dir, controls, other);
      const prefix = 'env ' + controls.map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
      for (const action of ['commit --allow-empty -m physical-directory', 'push origin HEAD:refs/heads/main']) {
        const result = deliveryGate(dir, `${prefix} git ${action}`);
        if (result.status !== 2 || !/GIT_DELIVERY_REPOSITORY_MISMATCH/.test(result.stderr)) {
          failures.push(`${prefix} git ${action}: ${result.status} ${result.stderr}`);
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testEnvSingleAndNestedPhysicalDirectoriesRemainAvailable() {
  withRepo(dir => withRepo(other => {
    prepareEnvPhysicalDirectoryFixture(dir, other);
    for (const controls of [
      ['-C', 'sub'], ['-C', 'sub/..'], ['-C', `../${path.basename(dir)}/sub/..`],
      ['-C', 'same-link/..'], ['--chdir=same-link/..'],
      ['-C', 'sub', 'env', '-C', `../${path.basename(other)}`],
      ['--chdir=sub', 'env', '--chdir=..'],
    ]) {
      checkActualEnvRepository(dir, controls, dir);
      const prefix = 'env ' + controls.map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
      for (const action of ['commit --allow-empty -m bound-directory', 'push origin HEAD:refs/heads/main']) {
        const result = deliveryGate(dir, `${prefix} git ${action}`);
        assert.strictEqual(result.status, 0, `${prefix} git ${action}: ${result.stderr}`);
      }
    }
  }));
}

function testGitShortlogSignatureFormatsRequireCallbackBinding() {
  withRepo(dir => {
    git(dir, ['config', 'pretty.fixture-signature', 'format:%G?']);
    git(dir, ['config', 'pretty.fixture-chain', 'fixture-signature']);
    prepareDeliveryEvidence(dir);
    const variants = [
      ['--format=%G?'], ['--pretty=%G?'], ['--format=fixture-signature'],
      ['--pretty=fixture-signature'], ['--format=fixture-chain'],
      ['--no-show-signature', '--format=%G?'], ['--format=%s', '--format=%G?'],
    ];
    assert.ok(!git(dir, ['cat-file', '-p', 'HEAD']).includes('\ngpgsig '), 'actual format probes use unsigned objects');
    for (const options of variants) {
      const actual = spawnSync('git', ['--no-pager', 'shortlog', ...options, 'HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.match(actual.stdout, /^\s+N$/m, 'shortlog interprets the signature placeholder');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-signature-program')]);
    const failures = [];
    for (const options of variants) {
      const viewer = 'git shortlog ' + options.map(arg => `'${arg}'`).join(' ') + ' HEAD';
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !/gpg\.program/.test(result.stderr)) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitShortlogOrdinaryFormatsIgnoreLogDefaults() {
  withRepo(dir => {
    git(dir, ['config', 'pretty.fixture-signature', 'format:%G?']);
    git(dir, ['config', 'format.pretty', 'fixture-signature']);
    // Unlike log, shortlog does not even parse this log-only boolean config.
    git(dir, ['config', 'log.showSignature', 'invalid']);
    prepareDeliveryEvidence(dir);
    const variants = [[], ['--format=%s'], ['--format=%%G?'], ['--no-show-signature'], ['--pretty'],
      ['--format=fixture-signature', '--format=%s'], ['--pretty=fixture-signature', '--format=%s']];
    for (const options of variants) {
      const actual = spawnSync('git', ['--no-pager', 'shortlog', ...options, 'HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(actual.stdout.includes(options.includes('--format=%%G?') ? '%G?' : 'init'), actual.stdout);
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-signature-program')]);
    for (const options of variants) {
      const viewer = 'git shortlog ' + options.map(arg => `'${arg}'`).join(' ') + ' HEAD';
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
      }
    }
  });
}

function testGitAndEnvQuotedDirectoryCharactersRemainLiteral() {
  withRepo(dir => {
    for (const name of ['dollar$X', 'star*']) fs.symlinkSync(dir, path.join(dir, '.git', name));
    prepareDeliveryEvidence(dir);
    const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
    const failures = [];
    for (const [shell, flags] of [['bash', ['--noprofile', '--norc', '-c']], ['zsh', ['-fc']]]) {
      const probe = spawnSync(shell, [...flags, 'true'], { cwd: dir, encoding: 'utf8' });
      const available = !(probe.error && probe.error.code === 'ENOENT');
      for (const spelling of ["'.git/dollar$X'", String.raw`.git/dollar\$X`, String.raw`".git/dollar\$X"`,
        "'.git/star*'", String.raw`.git/star\*`]) {
        for (const prefix of [`git -C ${spelling}`, `env -C ${spelling} git`]) {
          if (available) {
            const actual = spawnSync(shell, [...flags, `${prefix} rev-parse --show-toplevel`], { cwd: dir, encoding: 'utf8' });
            assert.strictEqual(actual.status, 0, `${shell} ${prefix}: ${actual.stderr}`);
            assert.strictEqual(fs.realpathSync(actual.stdout.trim()), dir);
          }
          const delivery = `${prefix} commit --allow-empty -m literal-directory`;
          for (const command of [delivery, `${shell} ${flags.join(' ')} ${quote(delivery)}`]) {
            const result = deliveryGate(dir, command);
            if (result.status !== 0) failures.push(`${command}: ${result.status} ${result.stderr}`);
          }
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitAndEnvActualDirectoryExpansionRemainsRejected() {
  withRepo(dir => withRepo(other => {
    for (const name of ['glob-other', 'other$X', 'other*']) fs.symlinkSync(other, path.join(dir, '.git', name));
    prepareDeliveryEvidence(dir);
    const environment = { ...process.env, SHK_TARGET: other };
    const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
    for (const [shell, flags] of [['bash', ['--noprofile', '--norc', '-c']], ['zsh', ['-fc']]]) {
      const probe = spawnSync(shell, [...flags, 'true'], { cwd: dir, encoding: 'utf8' });
      const available = !(probe.error && probe.error.code === 'ENOENT');
      for (const spelling of ['$SHK_TARGET', '"$SHK_TARGET"', '.git/glob*', "'.git/other$X'", "'.git/other*'"]) {
        for (const prefix of [`git -C ${spelling}`, `env -C ${spelling} git`]) {
          if (available) {
            const actual = spawnSync(shell, [...flags, `${prefix} rev-parse --show-toplevel`], {
              cwd: dir, encoding: 'utf8', env: environment,
            });
            assert.strictEqual(actual.status, 0, `${shell} ${prefix}: ${actual.stderr}`);
            assert.strictEqual(fs.realpathSync(actual.stdout.trim()), other);
          }
          const delivery = `${prefix} commit --allow-empty -m expanded-directory`;
          for (const command of [delivery, `${shell} ${flags.join(' ')} ${quote(delivery)}`]) {
            const result = deliveryGate(dir, command, environment);
            assert.strictEqual(result.status, 2, `${command}: ${result.stderr}`);
          }
        }
      }
    }
    for (const spelling of ['<(printf fixture)', '>(printf fixture)']) {
      for (const prefix of [`git -C ${spelling}`, `env -C ${spelling} git`]) {
        assert.strictEqual(deliveryGate(dir, `${prefix} commit --allow-empty -m process-directory`).status, 2,
          'process substitution cannot supply a static directory');
      }
    }
  }));
}

function prepareModernRuntimeCwdFixture(dir, other) {
  prepareEnvPhysicalDirectoryFixture(dir, other);
  fs.symlinkSync(path.join(dir, 'sub'), path.join(other, 'back-to-evidence'));
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\ndocs/\n');
  fs.writeFileSync(path.join(dir, '.harness/config.json'), JSON.stringify({
    evidence: { require_attestation: true },
    commands: { tests: 'node -e "require(\'fs\').accessSync(\'README.md\')"' },
    verification_policy: { applicability: { build: {
      status: 'NOT_APPLICABLE', reason: 'This directory fixture distributes source without a compilation step.',
    } } },
  }));
  const verified = spawnSync(process.execPath, [SHK, 'verify', '--risk', 'low', '--write-evidence'], {
    cwd: dir, encoding: 'utf8',
  });
  assert.strictEqual(verified.status, 0, verified.stderr || verified.stdout);
  const evidence = JSON.parse(fs.readFileSync(path.join(dir, '.harness/verify-evidence.json'), 'utf8'));
  assert.strictEqual(evidence.overall, 'READY');
  assert.ok(evidence.provenance.applicability, 'runtime binding regression uses fresh modern evidence');
  const checked = attestation.verifyEvidence(evidence, { project_root: dir, require_attestation: true });
  assert.strictEqual(checked.status, 'PASS', JSON.stringify(checked));
}

function actualRuntimeRepository(dir, context) {
  const append = (base, value) => path.isAbsolute(value) ? value : `${base}${path.sep}${value}`;
  const base = context.cwd === undefined ? dir : append(dir, context.cwd);
  const tool = context.tool_input || {};
  const override = tool.cwd === undefined ? tool.workdir : tool.cwd;
  const actual = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: override === undefined ? base : append(base, override), encoding: 'utf8',
  });
  assert.strictEqual(actual.status, 0, actual.stderr || String(actual.error));
  return fs.realpathSync.native(actual.stdout.trim());
}

function testRuntimeCwdSymlinkParentsCannotBindAnotherRepository() {
  withRepo(dir => withRepo(other => {
    prepareModernRuntimeCwdFixture(dir, other);
    const contexts = [];
    for (const value of [`${dir}/link/..`, 'link/..']) {
      contexts.push({ cwd: value }, { tool_input: { cwd: value } }, { tool_input: { workdir: value } });
    }
    contexts.push({ cwd: `${dir}/sub`, tool_input: { cwd: '../link/..' } },
      { cwd: `${dir}/sub`, tool_input: { workdir: '../link/..' } },
      { cwd: `${dir}/link/..`, tool_input: { cwd: '.' } },
      { cwd: `${dir}/link/..`, tool_input: { workdir: '.' } });
    const failures = [];
    for (const context of contexts) {
      assert.strictEqual(actualRuntimeRepository(dir, context), other);
      const result = deliveryGate(dir, 'git commit --allow-empty -m physical-runtime', {}, context);
      if (result.status !== 2 || !/GIT_DELIVERY_REPOSITORY_MISMATCH/.test(result.stderr)) {
        failures.push(`${JSON.stringify(context)}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testRuntimeCwdPhysicalOverridesRemainAvailable() {
  withRepo(dir => withRepo(other => {
    prepareModernRuntimeCwdFixture(dir, other);
    const contexts = [];
    for (const value of [dir, '.', `${dir}/same-link/..`, 'same-link/..']) {
      contexts.push({ cwd: value }, { tool_input: { cwd: value } }, { tool_input: { workdir: value } });
    }
    contexts.push({ cwd: `${dir}/sub`, tool_input: { workdir: '..' } },
      { cwd: other, tool_input: { cwd: dir } },
      { cwd: `${dir}/link/..`, tool_input: { cwd: 'back-to-evidence/..' } },
      { cwd: `${dir}/link/..`, tool_input: { workdir: 'back-to-evidence/..' } },
      { cwd: dir, tool_input: { cwd: 'same-link/..', workdir: '.' } },
      { cwd: `${dir}/link/..`, tool_input: { cwd: 'back-to-evidence/..', workdir: dir } });
    const failures = [];
    for (const context of contexts) {
      assert.strictEqual(actualRuntimeRepository(dir, context), dir);
      const result = deliveryGate(dir, 'git commit --allow-empty -m bound-runtime', {}, context);
      if (result.status !== 0) failures.push(`${JSON.stringify(context)}: ${result.status} ${result.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testRuntimeCwdPhysicalConflictsAndInvalidDirectoriesAreRejected() {
  withRepo(dir => withRepo(other => {
    prepareModernRuntimeCwdFixture(dir, other);
    const invalid = [
      { cwd: '' }, { cwd: 0 }, { cwd: null }, { cwd: [] },
      { tool_input: { cwd: '' } }, { tool_input: { cwd: 0 } },
      { tool_input: { workdir: null } }, { tool_input: { workdir: [] } },
      { cwd: `${dir}/README.md` }, { tool_input: { cwd: 'README.md' } },
      { tool_input: { workdir: 'missing' } }, { cwd: `${dir}/missing/..` },
      { cwd: dir, tool_input: { cwd: 'link/..', workdir: '.' } },
      { cwd: dir, tool_input: { cwd: '.', workdir: 'link/..' } },
    ];
    const failures = [];
    for (const context of invalid) {
      const result = deliveryGate(dir, 'git commit --allow-empty -m invalid-runtime', {}, context);
      if (result.status !== 2 || !/GIT_DELIVERY_REPOSITORY_UNBOUND/.test(result.stderr)) {
        failures.push(`${JSON.stringify(context)}: ${result.status} ${result.stderr}`);
      }
    }
    for (const value of [`${dir}/README.md`, `${dir}/missing`, `${dir}/missing/..`]) {
      const actual = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: value, encoding: 'utf8' });
      assert.ok(actual.error || actual.status !== 0, 'the operating system cannot enter this directory');
    }
    assert.strictEqual(actualRuntimeRepository(dir, { cwd: dir, tool_input: { cwd: 'link/..' } }), other);
    assert.strictEqual(actualRuntimeRepository(dir, { cwd: dir, tool_input: { cwd: '.' } }), dir);
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testGitShortlogGroupSignatureFormatsAccumulate() {
  withRepo(dir => {
    git(dir, ['commit', '--allow-empty', '-qm', 'group fixture\n\nReviewed-by: Review Person <review@example.com>']);
    prepareDeliveryEvidence(dir);
    const variants = [
      ['--group=format:%GS'], ['--group', 'format:%G?'],
      ['--group=format:%G?', '--group=author'], ['--group=committer', '--group', 'format:%G?'],
      ['--group=format:%G?', '--group=format:ordinary'], ['--group=format:%G?', '-s'],
      ['--group=format:%G?', '--format=%s'], ['--group=format:%G?', '--no-show-signature'],
      ['--group=format:%G?', '--no-group', '--group=format:%G?'],
      ['--group=format:%G?', '--group=trailer:Reviewed-by'],
    ];
    for (const options of variants) {
      const actual = spawnSync('git', ['--no-pager', 'shortlog', ...options, 'HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      if (!options.includes('--group=format:%GS')) assert.match(actual.stdout, /(?:^N \(|\tN\n)/m,
        'later ordinary grouping or description formatting does not remove the signature group');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-group-signature-program')]);
    const failures = [];
    for (const options of variants) {
      const viewer = 'git shortlog ' + options.map(arg => `'${arg}'`).join(' ') + ' HEAD';
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !/gpg\.program/.test(result.stderr)) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitShortlogOrdinaryGroupsAndResetRemainAvailable() {
  withRepo(dir => {
    git(dir, ['commit', '--allow-empty', '-qm', 'group fixture\n\nReviewed-by: Review Person <review@example.com>']);
    git(dir, ['config', 'pretty.fixture-signature', 'format:%G?']);
    git(dir, ['config', 'pretty.fixture-chain', 'fixture-signature']);
    prepareDeliveryEvidence(dir);
    const variants = [
      ['--group=author'], ['--group', 'committer'], ['--group=trailer:Reviewed-by'],
      ['--group', 'format:%s'], ['--group=format:%%G?'], ['--group=format:fixture-signature'],
      ['--group=format:fixture-chain'], ['--group=trailer:%G?'],
      ['--group=format:%G?', '--no-group'],
      ['--group=format:%G?', '--no-group', '--group=format:ordinary'],
      ['--group=format:%G?', '--no-group', '--group=author'],
    ];
    for (const options of variants) {
      const actual = spawnSync('git', ['--no-pager', 'shortlog', ...options, 'HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(!/^N \(/m.test(actual.stdout), 'ordinary groups and reset do not evaluate a signature group');
      if (options.includes('--group=format:fixture-signature')) assert.ok(actual.stdout.includes('fixture-signature ('),
        'group format text is literal and does not resolve pretty aliases');
      if (options.includes('--group=format:%%G?')) assert.ok(actual.stdout.includes('%G? ('), 'escaped percent remains literal');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-group-signature-program')]);
    for (const options of variants) {
      const viewer = 'git shortlog ' + options.map(arg => `'${arg}'`).join(' ') + ' HEAD';
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
      }
    }
  });
}

function testGitShortlogGroupAbbreviationsRequireCallbackBinding() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const variants = ['g', 'gr', 'gro', 'grou'].flatMap(prefix => [
      [`--${prefix}=format:%GS`], [`--${prefix}`, 'format:%G?'],
      [`--${prefix}=format:%G?`, `--${prefix}=author`],
      ['--group=format:%G?', `--no-${prefix}`, `--${prefix}=format:%G?`],
    ]);
    assert.ok(!git(dir, ['cat-file', '-p', 'HEAD']).includes('\ngpgsig '), 'abbreviation probes use unsigned objects');
    for (const options of variants) {
      const actual = spawnSync('git', ['--no-pager', 'shortlog', ...options, 'HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      if (!options.some(option => option.endsWith('format:%GS'))) assert.match(actual.stdout, /^N \(/m,
        'accepted group abbreviations retain the active signature format');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-group-abbreviation-program')]);
    const failures = [];
    for (const options of variants) {
      const viewer = 'git shortlog ' + options.map(arg => `'${arg}'`).join(' ') + ' HEAD';
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !/gpg\.program/.test(result.stderr)) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitShortlogOrdinaryGroupAbbreviationsAndResetsRemainAvailable() {
  withRepo(dir => {
    prepareDeliveryEvidence(dir);
    const variants = ['g', 'gr', 'gro', 'grou'].flatMap(prefix => [
      [`--${prefix}=author`], [`--${prefix}`, 'committer'],
      ['--group=format:%G?', `--no-${prefix}`],
      ['--group=format:%G?', `--no-${prefix}`, `--${prefix}=format:ordinary`],
    ]);
    for (const options of variants) {
      const actual = spawnSync('git', ['--no-pager', 'shortlog', ...options, 'HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(!/^N \(/m.test(actual.stdout), 'abbreviated reset clears earlier signature groups');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-group-abbreviation-program')]);
    const failures = [];
    for (const options of variants) {
      const viewer = 'git shortlog ' + options.map(arg => `'${arg}'`).join(' ') + ' HEAD';
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 0) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function prepareModifiedSignatureFormatFixture(dir) {
  fs.appendFileSync(path.join(dir, 'README.md'), 'local stash fixture\n');
  git(dir, ['stash', 'push', '-qm', 'format fixture']);
  git(dir, ['config', 'pretty.fixture-modifier', 'format:%+G?']);
  git(dir, ['config', 'pretty.fixture-modifier-chain', 'fixture-modifier']);
  prepareDeliveryEvidence(dir);
}

function testGitModifiedSignatureFormatsRequireCallbackBinding() {
  withRepo(dir => {
    prepareModifiedSignatureFormatFixture(dir);
    const bases = [['log', '-1'], ['show', '-s'], ['rev-list', '-1', 'HEAD'],
      ['reflog', '-1'], ['stash', 'list'], ['shortlog', 'HEAD']];
    const variants = bases.flatMap(base => ['%+G?', '%-GK', '% G?'].map(format => [...base, `--format=${format}`]));
    variants.push(['log', '-1', '--format=%%%+G?'], ['show', '-s', '--pretty=format:% G?'],
      ['log', '-1', '--format=fixture-modifier-chain']);
    for (const args of variants) {
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(!/%[+\- ]G[?K]/.test(actual.stdout), 'Git interprets the modified signature placeholder');
      if (!args.some(arg => arg.includes('%-GK'))) assert.match(actual.stdout, /N/,
        'unsigned objects expose the interpreted signature status');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-modified-signature-program')]);
    const failures = [];
    for (const args of variants) {
      const viewer = 'git ' + args.map(arg => `'${arg}'`).join(' ');
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !/gpg\.program/.test(result.stderr)) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitEscapedAndOrdinaryModifiedFormatsRemainAvailable() {
  withRepo(dir => {
    prepareModifiedSignatureFormatFixture(dir);
    const variants = [
      ['log', '-1', '--format=%%+G?'], ['show', '-s', '--pretty=format:%%-GK'],
      ['rev-list', '-1', 'HEAD', '--format=%% G?'], ['reflog', '-1', '--format=%%%%+G?'],
      ['stash', 'list', '--format=%+an'], ['shortlog', 'HEAD', '--format=%-s'],
      ['log', '-1', '--format=% s'], ['log', '-1', '--format=%++G?'],
      ['log', '-1', '--format=%+-G?'], ['log', '-1', '--format=%\tG?'],
      ['log', '-1', '--format=%x25G?'],
    ];
    for (const args of variants) {
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(!/^\s*N\s*$/m.test(actual.stdout), 'literal percents and ordinary fields do not evaluate a signature');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-modified-signature-program')]);
    for (const args of variants) {
      const viewer = 'git ' + args.map(arg => `'${arg}'`).join(' ');
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
      }
    }
  });
}

function testGitImplicitGroupSignatureFormatsRequireCallbackBinding() {
  withRepo(dir => {
    prepareModifiedSignatureFormatFixture(dir);
    const variants = [
      ['--group=format:%+G?'], ['--group=FORMAT:%G?'], ['--group', 'Format:%-GK'],
      ['--group= format:% G?'], ['--gr', '\tFORMAT:%+G?'], ['--grou=\nFORMAT:%G?'],
      ['--group=\u00a0format:%+G?'], ['--group=format :%+G?'], ['--group=%+G?'],
      ['--group=ordinary% G?'], ['--group=Trailer:%G?'], ['--group= trailer:%G?'],
      ['--group=FORMAT:%+G?', '--group=author'],
      ['--group=FORMAT:%+G?', '--no-gr', '--g', ' Format:% G?'],
    ];
    for (const options of variants) {
      const actual = spawnSync('git', ['--no-pager', 'shortlog', ...options, 'HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      if (!options.some(option => option.includes('%-GK'))) assert.match(actual.stdout, /N \(/,
        'implicit formats and active accumulated groups evaluate signature placeholders');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-implicit-signature-program')]);
    const failures = [];
    for (const options of variants) {
      const viewer = 'git shortlog ' + options.map(arg => `'${arg}'`).join(' ') + ' HEAD';
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !/gpg\.program/.test(result.stderr)) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitImplicitGroupLiteralsAndResetRemainAvailable() {
  withRepo(dir => {
    prepareModifiedSignatureFormatFixture(dir);
    const variants = [
      ['--group=FORMAT:%%+G?'], ['--group= format:%%-GK'], ['--group=%% G?'],
      ['--group=%+an', '--group=committer'], ['--group=trailer:%+G?'],
      ['--group=format:fixture-modifier'], ['--group=format:fixture-modifier-chain'],
      ['--group=FORMAT:%+G?', '--no-gr'],
      ['--group= %+G?', '--no-g', '--g=author'],
      ['--group= Format:% G?', '--no-grou', '--group=trailer:Reviewed-by'],
    ];
    for (const options of variants) {
      const actual = spawnSync('git', ['--no-pager', 'shortlog', ...options, 'HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(!/N \(/.test(actual.stdout), 'escaped formats, exact trailer keys and reset groups do not evaluate signatures');
      if (options.includes('--group=format:fixture-modifier')) assert.match(actual.stdout, /fixture-modifier \(/,
        'explicit group format text does not resolve a pretty alias');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-implicit-signature-program')]);
    for (const options of variants) {
      const viewer = 'git shortlog ' + options.map(arg => `'${arg}'`).join(' ') + ' HEAD';
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        assert.strictEqual(result.status, 0, `${command}: ${result.stderr}`);
      }
    }
  });
}

function preparePrettyAliasResolutionFixture(dir) {
  fs.appendFileSync(path.join(dir, 'README.md'), 'local alias stash\n');
  git(dir, ['stash', 'push', '-qm', 'alias fixture']);
  for (const [name, value] of [
    ['signinfo', 'format:signature=%G?'], ['signinformation', 'format:ordinary=%s'],
    ['chainentry', 'SIG'], ['chainouter', 'ChAiNe'],
    ['dangerz', 'format:signature=%-G?'], ['dangera', 'format:ordinary=%s'],
    ['safez', 'format:ordinary=%s'], ['safea', 'format:signature=%G?'],
    ['ordinarylong', 'format:signature=%G?'], ['ordinary', 'format:ordinary=%s'],
    ['full', 'format:signature=%G?'], ['medium', 'format:signature=%G?'],
    ['sh', 'format:signature=%G?'], ['shortextra', 'format:signature=%G?'],
    ['literalformat', 'format:SIG'], ['literalpercent', '%%G?'], ['builtin-chain', 'SHOR'],
    ['loopone', 'looptwo'], ['looptwo', 'loopone'], ['broken', 'missing-alias'],
  ]) git(dir, ['config', `pretty.${name}`, value]);
  prepareDeliveryEvidence(dir);
}

function testGitPrettyAliasPrefixesAndDefaultsRequireCallbackBinding() {
  withRepo(dir => {
    preparePrettyAliasResolutionFixture(dir);
    const variants = [
      ['log', '-1', '--format=sig'], ['show', '-s', '--pretty=SignInfo'],
      ['rev-list', '-1', 'HEAD', '--format=SIGNINFO'], ['reflog', '-1', '--pretty=SiG'],
      ['stash', 'list', '--format=CHAINO'], ['shortlog', 'HEAD', '--format=sig'],
      ['log', '-1', '--format=CHAINO'], ['log', '-1', '--format=danger'],
      ['log', '-1', '--format=SH'], ['log', '-1', '--format=signinfo'],
      { format: 'SIG', args: ['log', '-1'] }, { format: 'ChAiNo', args: ['show', '-s'] },
    ];
    for (const variant of variants) withPrettyAliasFixtureDefault(dir, variant, args => {
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(actual.stdout.includes('signature=N'), 'actual Git selects the signature alias');
    });
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-pretty-alias-program')]);
    const failures = [];
    for (const variant of variants) withPrettyAliasFixtureDefault(dir, variant, args => {
      const viewer = 'git ' + args.map(arg => `'${arg}'`).join(' ');
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !/gpg\.program/.test(result.stderr)) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    });
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitPrettyAliasSelectionPreservesBuiltinsAndLiteralFormats() {
  withRepo(dir => {
    preparePrettyAliasResolutionFixture(dir);
    const formats = ['full', 'FULL', 'fuller', 'short', 'sho', 'oneline', 'raw', 'medium', 'm',
      'email', 'mboxrd', 'reference', 'ord', 'safe', 'format:sig', 'tformat:SIG', '%s',
      'format:%%G?', 'tformat:%%G?', 'literalformat', 'literalpercent', 'builtin-chain'];
    for (const format of formats) {
      const actual = spawnSync('git', ['--no-pager', 'log', '-1', `--format=${format}`], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(!actual.stdout.includes('signature=N'), 'builtins, shortest/tied ordinary aliases and literal formats avoid signatures');
      if (['ord', 'safe'].includes(format)) assert.ok(actual.stdout.includes('ordinary=init'), actual.stdout);
      if (format === 'literalformat') assert.strictEqual(actual.stdout, 'SIG', 'format: preserves literal intent across aliases');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-pretty-alias-program')]);
    const failures = [];
    for (const format of formats) {
      const viewer = `git log -1 '--format=${format}'`;
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 0) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitPrettyAliasCyclesAndUnusedDefaultsDoNotSelectCallbacks() {
  withRepo(dir => {
    preparePrettyAliasResolutionFixture(dir);
    const variants = [
      ['log', '-1', '--format=LOO'], ['log', '-1', '--format=broken'], ['log', '-1', '--format=missing-alias'],
      { format: 'signinfo', args: ['rev-list', '-1', 'HEAD'] },
      { format: 'SIG', args: ['reflog', '-1'] }, { format: 'SIG', args: ['stash', 'list'] },
      { format: 'SIG', args: ['stash', 'show'] }, { format: 'SIG', args: ['shortlog', 'HEAD'] },
      { format: 'SIG', args: ['log', '-1', '--format=short'] },
      { format: 'SIG', args: ['log', '-1', '--pretty'] },
    ];
    for (const [index, variant] of variants.entries()) withPrettyAliasFixtureDefault(dir, variant, args => {
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, index < 3 ? 128 : 0, actual.stderr);
      if (index < 3) assert.match(actual.stderr, /invalid --pretty format/);
      assert.ok(!actual.stdout.includes('signature=N'), 'cycles/errors and unused defaults cannot evaluate a signature alias');
    });
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-pretty-alias-program')]);
    const failures = [];
    for (const variant of variants) withPrettyAliasFixtureDefault(dir, variant, args => {
      const viewer = 'git ' + args.map(arg => `'${arg}'`).join(' ');
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 0) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    });
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function withPrettyAliasFixtureDefault(dir, variant, check) {
  if (Array.isArray(variant)) return check(variant);
  git(dir, ['config', 'format.pretty', variant.format]);
  try { return check(variant.args); }
  finally { git(dir, ['config', '--unset', 'format.pretty']); }
}

function testGitOnelineOverridesInheritedAndExplicitSignatureFormats() {
  withRepo(dir => {
    preparePrettyAliasResolutionFixture(dir);
    git(dir, ['config', 'format.pretty', 'signinfo']);
    const bases = [['log', '-1'], ['show', '-s'], ['rev-list', '-1', 'HEAD'],
      ['reflog', '-1'], ['stash', 'list'], ['shortlog', 'HEAD']];
    const variants = bases.flatMap(base => [
      [...base, '--format=sig', '--oneline'], [...base, '--pretty=SIGNINFO', '--oneline'],
    ]);
    variants.push(['log', '-1', '--oneline'], ['show', '-s', '--oneline'],
      ['log', '-1', '--oneline', '--pretty'],
      ['log', '-1', '--format=sig', '--oneline', '--format=%s'],
      ['show', '-s', '--pretty=SIGNINFO', '--oneline', '--pretty=short']);
    for (const args of variants) {
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(!actual.stdout.includes('signature=N'), 'oneline or a later ordinary format replaces signature formatting');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-oneline-program')]);
    const failures = [];
    for (const args of variants) {
      const viewer = 'git ' + args.map(arg => `'${arg}'`).join(' ');
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 0) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitSignatureFormatsRestoredAfterOnelineRemainProtected() {
  withRepo(dir => {
    preparePrettyAliasResolutionFixture(dir);
    git(dir, ['config', 'format.pretty', 'signinfo']);
    const bases = [['log', '-1'], ['show', '-s'], ['rev-list', '-1', 'HEAD'],
      ['reflog', '-1'], ['stash', 'list'], ['shortlog', 'HEAD']];
    const variants = bases.flatMap(base => [
      [...base, '--oneline', '--format=sig'], [...base, '--oneline', '--pretty=SIGNINFO'],
    ]);
    variants.push(['log', '-1', '--format=%s', '--oneline', '--format=sig'],
      ['show', '-s', '--pretty=short', '--oneline', '--pretty=SIGNINFO'],
      ['shortlog', 'HEAD', '--group=format:%G?', '--oneline'],
      ['log', '-1', '--oneline', '--format=%%G?', '--pretty=SIG']);
    for (const args of variants) {
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      if (args.includes('--group=format:%G?')) assert.match(actual.stdout, /^N \(/m,
        'oneline changes description formatting without clearing signature groups');
      else assert.ok(actual.stdout.includes('signature=N'), 'later explicit formatting restores the signature alias');
    }
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-oneline-program')]);
    const failures = [];
    for (const args of variants) {
      const viewer = 'git ' + args.map(arg => `'${arg}'`).join(' ');
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !/gpg\.program/.test(result.stderr)) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function prepareEmptyPrettyAliasFixture(dir, declarations) {
  fs.appendFileSync(path.join(dir, 'README.md'), 'local empty-alias stash\n');
  git(dir, ['stash', 'push', '-qm', 'empty-alias fixture']);
  for (const [name, value] of declarations) {
    if (value === null) fs.appendFileSync(path.join(dir, '.git/config'), `\n[pretty]\n ${name}\n`);
    else git(dir, ['config', `pretty.${name}`, value]);
  }
  prepareDeliveryEvidence(dir);
}

function testGitEmptyPrettyAliasTargetsStillRequireCallbackBinding() {
  withRepo(dir => {
    prepareEmptyPrettyAliasFixture(dir, [['q', 'format:signature=%G?'], ['z', ''], ['entry', 'Z'], ['outer', 'ENT']]);
    const variants = [
      ['log', '-1', '--format=z'], ['show', '-s', '--pretty=Z'],
      ['rev-list', '-1', 'HEAD', '--format=z'], ['reflog', '-1', '--pretty=ENTRY'],
      ['stash', 'list', '--format=OUT'], ['shortlog', 'HEAD', '--format=z'],
      ['log', '-1', '--format=outer'], { format: 'z', args: ['log', '-1'] },
      { format: 'OUT', args: ['show', '-s'] }, ['log', '-1', '--oneline', '--format=z'],
      ['log', '-1', '--format=q'],
    ];
    for (const variant of variants) withPrettyAliasFixtureDefault(dir, variant, args => {
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.ok(actual.stdout.includes('signature=N'), 'empty alias targets continue through shortest-prefix selection');
    });
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-empty-alias-program')]);
    const failures = [];
    for (const variant of variants) withPrettyAliasFixtureDefault(dir, variant, args => {
      const viewer = 'git ' + args.map(arg => `'${arg}'`).join(' ');
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 2 || !/gpg\.program/.test(result.stderr)) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    });
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testGitEmptyPrettyFormatsAndNonSignatureAliasTargetsRemainAvailable() {
  const scenarios = [
    {
      declarations: [['q', 'format:signature=%G?'], ['z', ''], ['literal', 'format:']],
      cases: [
        [['log', '-1', '--format='], 0], [['show', '-s', '--pretty='], 0],
        [['log', '-1', '--pretty'], 0], [['log', '-1', '--format=format:z'], 0],
        [['log', '-1', '--format=tformat:z'], 0], [['log', '-1', '--format=literal'], 0],
        [['log', '-1', '--format=z', '--oneline'], 0],
        [{ format: '', args: ['log', '-1'] }, 0],
      ],
    },
    {
      declarations: [['q', 'format:ordinary=%s'], ['z', '']],
      cases: [[['log', '-1', '--format=z'], 0], [['show', '-s', '--pretty=Z'], 0]],
    },
    {
      declarations: [['z', ''], ['q', 'format:signature=%G?'], ['outer', 'z']],
      cases: [[['log', '-1', '--format=z'], 128], [['log', '-1', '--format=outer'], 128]],
    },
    {
      declarations: [['longempty', '']],
      cases: [[['log', '-1', '--format=longempty'], 0], [['show', '-s', '--pretty=LONGEMPTY'], 0]],
    },
    {
      declarations: [['q', 'format:signature=%G?'], ['z', null], ['outer', 'z']],
      cases: [[['log', '-1', '--format=z'], 128], [['show', '-s', '--pretty=Z'], 128],
        [['log', '-1', '--format=outer'], 128], [['log', '-1', '--format='], 0], [['log', '-1', '--pretty'], 0]],
    },
  ];
  for (const scenario of scenarios) withRepo(dir => {
    prepareEmptyPrettyAliasFixture(dir, scenario.declarations);
    for (const [variant, expected] of scenario.cases) withPrettyAliasFixtureDefault(dir, variant, args => {
      const actual = spawnSync('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(actual.status, expected, actual.stderr);
      assert.ok(!actual.stdout.includes('signature=N'), 'explicit empty, ordinary/builtin targets and invalid aliases do not evaluate signatures');
      if (args.includes('--format=') || args.includes('--pretty=')) assert.strictEqual(actual.stdout, '');
      if (expected !== 0) assert.match(actual.stderr, /invalid --pretty format|missing value for 'pretty.z'/);
    });
    git(dir, ['config', 'gpg.program', path.join(dir, '.git/nonexistent-empty-alias-program')]);
    const failures = [];
    for (const [variant] of scenario.cases) withPrettyAliasFixtureDefault(dir, variant, args => {
      const viewer = 'git ' + args.map(arg => `'${arg}'`).join(' ');
      for (const command of [viewer, `${viewer} && git push origin HEAD:refs/heads/main`]) {
        const result = deliveryGate(dir, command);
        if (result.status !== 0) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    });
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function prepareFreshLiteralCandidateEvidence(dir) {
  fs.appendFileSync(path.resolve(dir, git(dir, ['rev-parse', '--git-path', 'info/exclude'])), '\n.harness/\n');
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness/current-stage.json'), JSON.stringify({
    stage: 'REVIEW', since: '2020-01-01T00:00:00Z', task: 'literal candidate binding',
  }));
  fs.writeFileSync(path.join(dir, '.harness/stage-history.jsonl'),
    ['EXECUTE', 'VERIFY'].map(stage => JSON.stringify({ stage, t: new Date().toISOString() })).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, '.harness/config.json'), JSON.stringify({
    evidence: { require_attestation: true },
    commands: { tests: 'node -e "require(\'assert\').strictEqual(require(\'fs\').readFileSync(\'README.md\', \'utf8\'), \'# fixture\\n\')"' },
    verification_policy: { applicability: { build: {
      status: 'NOT_APPLICABLE', reason: 'This source-only fixture has no compilation step.',
    } } },
  }));
  const verified = spawnSync(process.execPath, [SHK, 'verify', '--risk', 'low', '--write-evidence'], {
    cwd: dir, encoding: 'utf8',
  });
  assert.strictEqual(verified.status, 0, verified.stderr || verified.stdout);
  const evidence = JSON.parse(fs.readFileSync(path.join(dir, '.harness/verify-evidence.json'), 'utf8'));
  assert.strictEqual(evidence.overall, 'READY');
  assert.ok(evidence.provenance.applicability, 'use fresh CLI evidence with the protected modern contract');
  const checked = attestation.verifyEvidence(evidence, { project_root: dir, require_attestation: true });
  assert.strictEqual(checked.status, 'PASS', JSON.stringify(checked));
  const positive = deliveryGate(dir, 'git commit --allow-empty -m literal-control');
  assert.strictEqual(positive.status, 0, positive.stderr);
  return evidence;
}

function testLiteralBackslashPathsBindCandidateAndIndex() {
  if (process.platform === 'win32') return; // Backslash is a filename byte on POSIX only.
  withRepo(dir => {
    const names = ['docs\\verification-report.md', '.harness\\verify-evidence.json',
      'docs\\tasks\\T-literal\\evidence\\verify-evidence.md'];
    for (const name of names) fs.writeFileSync(path.join(dir, name), 'verified bytes\n');
    git(dir, ['--literal-pathspecs', 'add', '--', ...names]);
    git(dir, ['commit', '-qm', 'literal filename fixture']);
    prepareFreshLiteralCandidateEvidence(dir);
    const baseline = attestation.readGitIdentity(dir).candidate_digest;
    const failures = [];
    const check = (ok, message) => { if (!ok) failures.push(message); };
    for (const name of names) {
      fs.writeFileSync(path.join(dir, name), 'unverified bytes\n');
      const unstaged = attestation.readGitIdentity(dir);
      check(unstaged.candidate_digest !== baseline, `${name}: unstaged candidate must change`);
      check(unstaged.index_mismatch_paths.includes(name), `${name}: literal path must appear in index mismatch`);
      git(dir, ['--literal-pathspecs', 'add', '--', name]);
      const staged = attestation.readGitIdentity(dir);
      check(staged.candidate_digest === unstaged.candidate_digest, `${name}: staging must keep candidate stable`);
      check(staged.index_matches_worktree === true, `${name}: staged content must match worktree`);
      const stale = deliveryGate(dir, 'git commit -m stale-literal');
      check(stale.status === 2 && /GIT_CANDIDATE_MISMATCH/.test(stale.stderr), `${name}: stale staged proof accepted: ${stale.stderr}`);
      fs.writeFileSync(path.join(dir, name), 'verified bytes\n');
      const split = attestation.readGitIdentity(dir);
      check(split.candidate_digest === baseline, `${name}: restored worktree must match verified candidate`);
      check(split.index_matches_worktree === false && split.index_mismatch_paths.includes(name), `${name}: unverified index must remain visible`);
      const commit = deliveryGate(dir, 'git commit -m index-split');
      check(commit.status === 2 && /GIT_INDEX_CANDIDATE_MISMATCH/.test(commit.stderr), `${name}: split index accepted: ${commit.stderr}`);
      git(dir, ['--literal-pathspecs', 'add', '--', name]);
      const restored = deliveryGate(dir, 'git commit --allow-empty -m restored-literal');
      check(restored.status === 0, `${name}: restored index rejected: ${restored.stderr}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testLiteralBackslashChangesInvalidateProtectedReaders() {
  if (process.platform === 'win32') return;
  withRepo(dir => {
    const name = 'docs\\verification-report.md';
    fs.writeFileSync(path.join(dir, name), 'verified bytes\n');
    git(dir, ['--literal-pathspecs', 'add', '--', name]);
    git(dir, ['commit', '-qm', 'protected reader literal fixture']);
    prepareFreshLiteralCandidateEvidence(dir);
    const evidenceFile = path.join(dir, '.harness/verify-evidence.json');
    const proof = fs.readFileSync(evidenceFile, 'utf8');
    const baseline = attestation.readGitIdentity(dir).candidate_digest;
    const run = (script, args = [], input) => spawnSync(process.execPath, [path.join(KIT_ROOT, script), ...args], {
      cwd: dir, encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input),
      env: { ...process.env, HARNESS_GUARD_MODE: 'strict', HARNESS_SKIP_GATE: '0' },
    });
    const stageInput = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {
      file_path: path.join(dir, '.harness/current-stage.json'),
      content: JSON.stringify({ stage: 'REVIEW', since: 'now', task: 'reader control' }),
    } };
    const readers = [
      ['current Git CLI', () => run('scripts/shk.js', ['evidence', 'verify', '--current-git']), 1, /GIT_CANDIDATE_MISMATCH/],
      ['integration', () => run('scripts/shk.js', ['verify', '--risk', 'low', '--phase', 'integration']), 1, /Full admission rejected/],
      ['QA report', () => run('scripts/shk.js', ['qa', 'report']), 1, /GIT_CANDIDATE_MISMATCH/],
      ['delivery hook', () => run('scripts/hooks/delivery-gate.js', [], { last_assistant_message: '修改完成，请验收。' }), 2, /GIT_CANDIDATE_MISMATCH/],
      ['stage guard', () => run('scripts/hooks/harness-stage-guard.js', [], stageInput), 0, /"permissionDecision":"deny".*GIT_CANDIDATE_MISMATCH/],
      ['commit hook', () => deliveryGate(dir, 'git commit -m literal-reader'), 2, /GIT_CANDIDATE_MISMATCH/],
      ['push hook', () => deliveryGate(dir, 'git push origin HEAD:refs/heads/reviewed'), 2, /GIT_CANDIDATE_MISMATCH/],
    ];
    const doctor = () => require(SHK).doctorReport(dir).checks.find(check => check.id === 'verify-evidence');
    for (const [label, read] of readers) {
      const result = read();
      assert.strictEqual(result.status, 0, `fresh ${label}: ${result.stdout} ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /"permissionDecision":"deny"/, `fresh ${label} must be admitted`);
    }
    assert.strictEqual(doctor().status, 'PASS');
    fs.writeFileSync(path.join(dir, name), 'unverified bytes\n');
    git(dir, ['--literal-pathspecs', 'add', '--', name]);
    const failures = [];
    if (attestation.readGitIdentity(dir).candidate_digest === baseline) failures.push('literal change did not change candidate');
    for (const [label, read, status, message] of readers) {
      const result = read();
      if (result.status !== status || !message.test(`${result.stdout}\n${result.stderr}`)) {
        failures.push(`${label}: ${result.status} ${result.stdout} ${result.stderr}`);
      }
      assert.strictEqual(fs.readFileSync(evidenceFile, 'utf8'), proof, `${label} must not replace the stale proof`);
    }
    const diagnosis = doctor();
    if (diagnosis.status !== 'FAIL' || diagnosis.attestation_code !== 'GIT_CANDIDATE_MISMATCH') {
      failures.push(`doctor: ${JSON.stringify(diagnosis)}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testLiteralDollarPushTargetsRemainAvailable() {
  withRepo(dir => {
    const source = 'reviewed$HOME';
    git(dir, ['check-ref-format', `refs/heads/${source}`]);
    git(dir, ['branch', source]);
    prepareFreshLiteralCandidateEvidence(dir);
    const failures = [];
    const spellings = value => [`'${value}'`, value.replace(/\$/g, '\\$'), `"${value.replace(/\$/g, '\\$')}"`];
    for (const value of ['HEAD:refs/heads/reviewed$HOME', `${source}:refs/heads/reviewed`, 'origin$HOME']) {
      for (const spelling of spellings(value)) {
        // Only run a read-only argv probe; all delivery strings are hook input.
        const argv = spawnSync('bash', ['--noprofile', '--norc', '-c', `git rev-parse --sq-quote ${spelling}`], {
          cwd: dir, encoding: 'utf8',
        });
        assert.strictEqual(argv.status, 0, argv.stderr);
        assert.strictEqual(argv.stdout.trim(), `'${value}'`);
        const command = value.startsWith('origin')
          ? `git push ${spelling} HEAD:refs/heads/reviewed` : `git push origin ${spelling}`;
        const result = deliveryGate(dir, command);
        if (result.status !== 0) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testLiteralDollarTargetsPreserveExpansionBindingAndRiskChecks() {
  withRepo(dir => withRepo(other => {
    const older = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'candidate.txt'), 'second fixture commit\n');
    git(dir, ['add', 'candidate.txt']);
    git(dir, ['commit', '-qm', 'distinct target fixture']);
    git(dir, ['branch', 'old$HOME', older]);
    git(dir, ['branch', 'reviewed$HOME']);
    prepareFreshLiteralCandidateEvidence(dir);
    const cases = [
      ['git push origin HEAD:refs/heads/$SHK_TARGET', /GIT_DELIVERY_COMMAND_AMBIGUOUS/],
      ['git push origin "HEAD:refs/heads/$SHK_TARGET"', /GIT_DELIVERY_COMMAND_AMBIGUOUS/],
      ['git push origin "$(printf HEAD):refs/heads/reviewed"', /GIT_DELIVERY_COMMAND_AMBIGUOUS/],
      ['git tag "$SHK_TARGET" HEAD', /GIT_DELIVERY_COMMAND_AMBIGUOUS/],
      ["git push origin 'missing$HOME:refs/heads/reviewed'", /GIT_DELIVERY_TARGET_UNRESOLVED/],
      ["git push origin 'old$HOME:refs/heads/reviewed'", /GIT_DELIVERY_TARGET_MISMATCH/],
      ["git tag 'v$HOME' HEAD", /evidence=low, required=release/],
      [String.raw`git tag v\$HOME HEAD`, /evidence=low, required=release/],
      ["git tag v-literal 'reviewed$HOME'", /evidence=low, required=release/],
      ["git push origin 'HEAD:refs/tags/v$HOME'", /evidence=low, required=release/],
    ];
    const failures = [];
    for (const [command, message] of cases) {
      const result = deliveryGate(dir, command, { SHK_TARGET: 'reviewed' });
      if (result.status !== 2 || !message.test(result.stderr)) failures.push(`${command}: ${result.status} ${result.stderr}`);
    }
    const wrong = deliveryGate(dir, "git push origin 'HEAD:refs/heads/reviewed$HOME'", {}, { cwd: other });
    if (wrong.status !== 2 || !/GIT_DELIVERY_REPOSITORY_MISMATCH/.test(wrong.stderr)) failures.push(`wrong cwd: ${wrong.status} ${wrong.stderr}`);
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function shellLiteral(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function actualDollarExpansionCases() {
  const cases = [{ shell: 'bash', flags: ['--noprofile', '--norc', '-c'], expression: '$[1]' }];
  const zsh = spawnSync('zsh', ['-fc', 'true'], { encoding: 'utf8' });
  if (!(zsh.error && zsh.error.code === 'ENOENT')) {
    assert.strictEqual(zsh.status, 0, zsh.stderr);
    for (const expression of ['$[1]', '$+SHK_WORD', '$=SHK_WORD', '$~SHK_WORD', '$^SHK_WORD']) {
      cases.push({ shell: 'zsh', flags: ['-fc'], expression });
    }
  }
  return cases;
}

function testDollarExpansionsCannotBindWrongSourceRevision() {
  withRepo(dir => {
    fs.writeFileSync(path.join(dir, 'candidate.txt'), 'verified candidate\n');
    git(dir, ['add', 'candidate.txt']);
    git(dir, ['commit', '-qm', 'good verified candidate']);
    const branch = git(dir, ['branch', '--show-current']);
    const verified = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', '-qb', 'unverified-expansion']);
    fs.writeFileSync(path.join(dir, 'candidate.txt'), 'unverified candidate\n');
    git(dir, ['commit', '-qam', 'evil10 unverified candidate']);
    const unverified = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', '-q', branch]);
    assert.notStrictEqual(verified, unverified);
    prepareFreshLiteralCandidateEvidence(dir);
    const environment = { ...process.env, SHK_WORD: '1' };
    const failures = [];
    for (const { shell, flags, expression } of actualDollarExpansionCases()) {
      const pattern = expression === '$[1]' ? `^evil${expression}0` : `^evil[${expression}]0`;
      const revision = `unverified-expansion^{/^good|${pattern}}`;
      assert.strictEqual(git(dir, ['rev-parse', '--verify', `${revision}^{commit}`]), verified,
        'the unexpanded literal is a valid selector for the verified commit');
      const actual = spawnSync(shell, [...flags, `git rev-parse --verify "${revision}^{commit}"`], {
        cwd: dir, encoding: 'utf8', env: environment,
      });
      assert.strictEqual(actual.status, 0, actual.stderr);
      assert.strictEqual(actual.stdout.trim(), unverified, `${shell} ${expression} selects another commit`);
      for (const command of [`git push origin "${revision}:refs/heads/reviewed"`, `git tag v-expansion "${revision}"`]) {
        for (const spelling of [command, `${shell} ${flags.join(' ')} ${shellLiteral(command)}`]) {
          const result = deliveryGate(dir, spelling, environment);
          if (result.status !== 2 || !/GIT_DELIVERY_COMMAND_AMBIGUOUS/.test(result.stderr)) {
            failures.push(`${spelling}: ${result.status} ${result.stderr}`);
          }
        }
      }
      const literal = deliveryGate(dir, `git push origin ${shellLiteral(`${revision}:refs/heads/reviewed`)}`, environment);
      assert.strictEqual(literal.status, 0, literal.stderr);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testDollarExpansionsCannotBindWrongGitOrEnvDirectory() {
  withRepo(dir => withRepo(other => {
    const cases = actualDollarExpansionCases();
    for (const expression of new Set(cases.map(item => item.expression))) {
      fs.symlinkSync(dir, path.join(dir, '.git', `r${expression}`));
    }
    fs.symlinkSync(other, path.join(dir, '.git/r1'));
    prepareFreshLiteralCandidateEvidence(dir);
    const environment = { ...process.env, SHK_WORD: '1' };
    const failures = [];
    for (const { shell, flags, expression } of cases) {
      for (const prefix of [`git -C ".git/r${expression}"`, `env -C ".git/r${expression}" git`]) {
        const actual = spawnSync(shell, [...flags, `${prefix} rev-parse --show-toplevel`], {
          cwd: dir, encoding: 'utf8', env: environment,
        });
        assert.strictEqual(actual.status, 0, actual.stderr);
        assert.strictEqual(fs.realpathSync(actual.stdout.trim()), other);
        const command = `${prefix} push origin HEAD:refs/heads/reviewed`;
        for (const spelling of [command, `${shell} ${flags.join(' ')} ${shellLiteral(command)}`]) {
          const result = deliveryGate(dir, spelling, environment);
          if (result.status !== 2 || !/GIT_DELIVERY_COMMAND_AMBIGUOUS/.test(result.stderr)) {
            failures.push(`${spelling}: ${result.status} ${result.stderr}`);
          }
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  }));
}

function testDollarExpansionArgumentsKeepNormalAndDoubleQuotedMarkers() {
  withRepo(dir => {
    prepareFreshLiteralCandidateEvidence(dir);
    const environment = { ...process.env, SHK_WORD: '1' };
    const failures = [];
    for (const { shell, flags, expression } of actualDollarExpansionCases()) {
      for (const spelling of [expression, `"${expression}"`]) {
        const actual = spawnSync(shell, [...flags, `git rev-parse --sq-quote ${spelling}`], {
          cwd: dir, encoding: 'utf8', env: environment,
        });
        assert.strictEqual(actual.status, 0, actual.stderr);
        assert.strictEqual(actual.stdout.trim(), "'1'");
        for (const command of [`git rev-parse --sq-quote ${spelling}`, `git push ${spelling} HEAD:refs/heads/reviewed`]) {
          const result = deliveryGate(dir, command, environment);
          if (result.status !== 2 || !/GIT_DELIVERY_COMMAND_AMBIGUOUS/.test(result.stderr)) {
            failures.push(`${shell} ${command}: ${result.status} ${result.stderr}`);
          }
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testDollarExpansionSpellingsPreserveQuotedAndEscapedLiterals() {
  withRepo(dir => {
    const expressions = ['$[1]', '$+SHK_WORD', '$=SHK_WORD', '$~SHK_WORD', '$^SHK_WORD'];
    for (const expression of expressions) fs.symlinkSync(dir, path.join(dir, '.git', `r${expression}`));
    prepareFreshLiteralCandidateEvidence(dir);
    const environment = { ...process.env, SHK_WORD: '1' };
    for (const expression of expressions) {
      const directory = `.git/r${expression}`;
      const spellings = [shellLiteral(directory), directory.replace(/[^A-Za-z0-9_./:-]/g, '\\$&'),
        `"${directory.replace(/[$`"\\]/g, '\\$&')}"`];
      for (const spelling of spellings) {
        const argv = spawnSync('bash', ['--noprofile', '--norc', '-c', `git rev-parse --sq-quote ${spelling}`], {
          cwd: dir, encoding: 'utf8', env: environment,
        });
        assert.strictEqual(argv.status, 0, argv.stderr);
        assert.strictEqual(argv.stdout.trim(), `'${directory}'`);
        for (const prefix of [`git -C ${spelling}`, `env -C ${spelling} git`]) {
          const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', `${prefix} rev-parse --show-toplevel`], {
            cwd: dir, encoding: 'utf8', env: environment,
          });
          assert.strictEqual(actual.status, 0, actual.stderr);
          assert.strictEqual(fs.realpathSync(actual.stdout.trim()), dir);
          const result = deliveryGate(dir, `${prefix} push origin HEAD:refs/heads/reviewed`, environment);
          assert.strictEqual(result.status, 0, `${prefix}: ${result.stderr}`);
        }
      }
    }
  });
}

function testLiteralLeadingAssignmentsPreserveShellQuoting() {
  withRepo(dir => {
    prepareFreshLiteralCandidateEvidence(dir);
    const failures = [];
    for (const assignment of ["FOO='$BAR'", String.raw`FOO="\$BAR"`, String.raw`FOO=\$BAR`]) {
      const prefixes = [`${assignment} git`, `${assignment} command git`, `${assignment} env git`, `env ${assignment} git`];
      const commands = prefixes.map(prefix => ({
        actual: `${prefix} rev-parse --show-toplevel`, protected: `${prefix} push origin HEAD:refs/heads/reviewed`,
      }));
      for (const [shell, flags] of [['bash', '--noprofile --norc -c'], ['zsh', '-fc']]) {
        const probe = spawnSync(shell, shell === 'bash' ? ['--noprofile', '--norc', '-c', 'true'] : ['-fc', 'true']);
        if (probe.error && probe.error.code === 'ENOENT' && shell === 'zsh') continue;
        for (const inside of [false, true]) {
          const wrap = action => inside
            ? `${shell} ${flags} ${shellLiteral(`${assignment} git ${action}`)}`
            : `${assignment} ${shell} ${flags} ${shellLiteral(`git ${action}`)}`;
          commands.push({ actual: wrap('rev-parse --show-toplevel'), protected: wrap('push origin HEAD:refs/heads/reviewed') });
        }
      }
      for (const command of commands) {
        const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', command.actual], { cwd: dir, encoding: 'utf8' });
        assert.strictEqual(actual.status, 0, `${command.actual}: ${actual.stderr}`);
        assert.strictEqual(fs.realpathSync(actual.stdout.trim()), dir);
        const result = deliveryGate(dir, command.protected);
        if (result.status !== 0) failures.push(`${command.protected}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testLeadingAssignmentsRetainExpansionAndContextProtection() {
  withRepo(dir => {
    prepareFreshLiteralCandidateEvidence(dir);
    const assignments = ['FOO=$SHK_WORD', 'FOO="$SHK_WORD"', 'FOO="$(printf 1)"',
      'FOO="$[1]"', 'FOO="$+SHK_WORD"', 'FOO=$=SHK_WORD', 'FOO=$~SHK_WORD', 'FOO=$^SHK_WORD',
      ...['GIT_DIR', 'PATH', 'BASH_ENV', 'ZDOTDIR', 'LD_PRELOAD'].map(name => `${name}='$BAR'`)];
    const failures = [];
    for (const assignment of assignments) {
      for (const command of [
        `${assignment} git push origin HEAD:refs/heads/reviewed`,
        `env ${assignment} git push origin HEAD:refs/heads/reviewed`,
        `${assignment} zsh -fc 'git push origin HEAD:refs/heads/reviewed'`,
      ]) {
        // Unsafe environment assignments and all deliveries are hook input only.
        const result = deliveryGate(dir, command, { SHK_WORD: '1' });
        if (result.status !== 2) failures.push(`${command}: ${result.status} ${result.stderr}`);
      }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function withMatchingRepositoryStorage(fn) {
  withRepo(dir => {
    const proof = prepareFreshLiteralCandidateEvidence(dir);
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shk-inherited-storage-')));
    try {
      fs.cpSync(dir, other, { recursive: true });
      assert.strictEqual(git(dir, ['rev-parse', 'HEAD']), git(other, ['rev-parse', 'HEAD']));
      fn(dir, other, proof);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });
}

function testInheritedRepositoryStorageOverridesFailBeforeGitProbes() {
  withMatchingRepositoryStorage((dir, other) => {
    const commands = ['git commit -m inherited-storage', 'git push origin HEAD:refs/heads/reviewed',
      'command env LANG=C git push origin HEAD:refs/heads/reviewed',
      "bash --noprofile --norc -c 'git push origin HEAD:refs/heads/reviewed'",
      "env LANG=C bash --noprofile --norc -c 'git commit -m inherited-storage'"];
    const failures = [];
    let sequence = 0;
    for (const name of ['GIT_DIR', 'GIT_COMMON_DIR']) {
      for (const value of [path.join(other, '.git'), path.relative(dir, path.join(other, '.git')), '']) {
        const environment = { ...process.env, [name]: value };
        if (value) {
          const actual = spawnSync('git', ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], {
            cwd: dir, encoding: 'utf8', env: environment,
          });
          assert.strictEqual(actual.status, 0, actual.stderr);
          const locations = actual.stdout.trim().split('\n').map(value => fs.realpathSync(path.resolve(dir, value)));
          assert.strictEqual(locations[0], dir, 'worktree remains A while ref storage is redirected');
          assert.strictEqual(locations[2], path.join(other, '.git'));
          assert.strictEqual(locations[1], path.join(name === 'GIT_DIR' ? other : dir, '.git'));
        }
        for (const command of commands) {
          const trace = path.join(dir, '.git', `inherited-gate-${sequence++}.trace`);
          const result = deliveryGate(dir, command, { ...environment, GIT_TRACE: trace });
          if (result.status !== 2 || !result.stderr.includes('GIT_DELIVERY_COMMAND_AMBIGUOUS') || !result.stderr.includes(name)) {
            failures.push(`${name}=${JSON.stringify(value)} ${command}: ${result.status} ${result.stderr}`);
          }
          if (fs.existsSync(trace)) failures.push(`${name} ${command}: Git probe ran before rejection`);
        }
      }
      const explicit = deliveryGate(dir, `env ${name}=${shellLiteral(path.join(other, '.git'))} git push origin HEAD:refs/heads/reviewed`);
      assert.strictEqual(explicit.status, 2, 'explicit repository overrides must remain rejected');
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testInheritedRepositoryStorageInvalidatesSharedIdentityAndCliProof() {
  withMatchingRepositoryStorage((dir, other, proof) => {
    const file = path.join(dir, '.harness/verify-evidence.json');
    const originalProof = fs.readFileSync(file, 'utf8');
    const probe = `const a = require(${JSON.stringify(path.join(KIT_ROOT, 'scripts/lib/evidence-attestation.js'))});`
      + 'console.log(JSON.stringify({ identity: a.readGitIdentity(process.argv[1]), digest: a.candidateDigest(process.argv[1], process.argv[2]) }));';
    const failures = [];
    const cli = (args, env) => spawnSync(process.execPath, [SHK, ...args], { cwd: dir, encoding: 'utf8', env });
    for (const name of ['GIT_DIR', 'GIT_COMMON_DIR']) {
      const environment = { ...process.env, [name]: path.join(other, '.git') };
      const trace = path.join(dir, '.git', `inherited-identity-${name}.trace`);
      const result = spawnSync(process.execPath, ['-e', probe, dir, proof.provenance.git.commit], {
        cwd: dir, encoding: 'utf8', env: { ...environment, GIT_TRACE: trace },
      });
      assert.strictEqual(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      if (observed.identity.available !== false || observed.identity.candidate_digest !== null || observed.digest !== null) {
        failures.push(`${name} identity trusted external storage: ${result.stdout}`);
      }
      if (fs.existsSync(trace)) failures.push(`${name}: shared identity ran a Git probe before rejection`);
      const stale = cli(['evidence', 'verify', '--current-git', '--format', 'json'], environment);
      if (stale.status !== 1 || !stale.stdout.includes('GIT_IDENTITY_UNAVAILABLE')) {
        failures.push(`${name}: existing A proof accepted: ${stale.status} ${stale.stdout} ${stale.stderr}`);
      }
      assert.strictEqual(fs.readFileSync(file, 'utf8'), originalProof, 'verification must not replace A proof');
      const generated = cli(['verify', '--risk', 'low', '--write-evidence'], environment);
      const output = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.notStrictEqual(output.run_id, proof.run_id, 'exercise real fresh CLI generation under the inherited override');
      if (output.provenance.git.available !== false || output.provenance.git.commit !== null
          || output.provenance.git.tree !== null || output.provenance.git.candidate_digest !== null) {
        failures.push(`${name}: fresh CLI produced usable Git identity: exit=${generated.status} ${JSON.stringify(output.provenance.git)}`);
      }
      const generatedCheck = cli(['evidence', 'verify', '--current-git', '--format', 'json'], environment);
      if (generatedCheck.status !== 1 || !generatedCheck.stdout.includes('GIT_IDENTITY_UNAVAILABLE')) {
        failures.push(`${name}: fresh proof was accepted under override: ${generatedCheck.status}`);
      }
      const cleanCheck = cli(['evidence', 'verify', '--current-git', '--format', 'json'], process.env);
      if (cleanCheck.status !== 1) failures.push(`${name}: unavailable fresh identity authorized the ordinary repository`);
      fs.writeFileSync(file, originalProof);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
}

function testOrdinaryAndLinkedWorktreesKeepFreshProtectedDeliveryAvailable() {
  withRepo(dir => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shk-linked-storage-')));
    const linked = path.join(parent, 'linked');
    try {
      git(dir, ['worktree', 'add', '-q', '-b', 'linked-storage-control', linked]);
      assert.ok(fs.statSync(path.join(linked, '.git')).isFile(), 'use a real linked worktree');
      assert.notStrictEqual(git(linked, ['rev-parse', '--absolute-git-dir']), path.join(dir, '.git'));
      assert.strictEqual(fs.realpathSync(path.resolve(linked, git(linked, ['rev-parse', '--git-common-dir']))), path.join(dir, '.git'));
      for (const root of [dir, linked]) {
        prepareFreshLiteralCandidateEvidence(root);
        const current = spawnSync(process.execPath, [SHK, 'evidence', 'verify', '--current-git', '--format', 'json'], {
          cwd: root, encoding: 'utf8',
        });
        assert.strictEqual(current.status, 0, current.stderr || current.stdout);
        assert.strictEqual(JSON.parse(current.stdout).status, 'PASS');
        for (const command of ['git commit --allow-empty -m normal-storage', 'git push origin HEAD:refs/heads/reviewed',
          "FOO='$BAR' command git push origin HEAD:refs/heads/reviewed", 'env LANG=C git push origin HEAD:refs/heads/reviewed',
          "bash --noprofile --norc -c 'git push origin HEAD:refs/heads/reviewed'"]) {
          const admitted = deliveryGate(root, command);
          assert.strictEqual(admitted.status, 0, `${root} ${command}: ${admitted.stderr}`);
        }
      }
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
}

const tests = [
  testInheritedRepositoryStorageOverridesFailBeforeGitProbes,
  testInheritedRepositoryStorageInvalidatesSharedIdentityAndCliProof,
  testOrdinaryAndLinkedWorktreesKeepFreshProtectedDeliveryAvailable,
  testDollarExpansionsCannotBindWrongSourceRevision,
  testDollarExpansionsCannotBindWrongGitOrEnvDirectory,
  testDollarExpansionArgumentsKeepNormalAndDoubleQuotedMarkers,
  testDollarExpansionSpellingsPreserveQuotedAndEscapedLiterals,
  testLiteralLeadingAssignmentsPreserveShellQuoting,
  testLeadingAssignmentsRetainExpansionAndContextProtection,
  testLiteralBackslashPathsBindCandidateAndIndex,
  testLiteralBackslashChangesInvalidateProtectedReaders,
  testLiteralDollarPushTargetsRemainAvailable,
  testLiteralDollarTargetsPreserveExpansionBindingAndRiskChecks,
  testGitEmptyPrettyAliasTargetsStillRequireCallbackBinding,
  testGitEmptyPrettyFormatsAndNonSignatureAliasTargetsRemainAvailable,
  testGitOnelineOverridesInheritedAndExplicitSignatureFormats,
  testGitSignatureFormatsRestoredAfterOnelineRemainProtected,
  testGitPrettyAliasPrefixesAndDefaultsRequireCallbackBinding,
  testGitPrettyAliasSelectionPreservesBuiltinsAndLiteralFormats,
  testGitPrettyAliasCyclesAndUnusedDefaultsDoNotSelectCallbacks,
  testGitModifiedSignatureFormatsRequireCallbackBinding,
  testGitEscapedAndOrdinaryModifiedFormatsRemainAvailable,
  testGitImplicitGroupSignatureFormatsRequireCallbackBinding,
  testGitImplicitGroupLiteralsAndResetRemainAvailable,
  testGitShortlogGroupAbbreviationsRequireCallbackBinding,
  testGitShortlogOrdinaryGroupAbbreviationsAndResetsRemainAvailable,
  testRuntimeCwdSymlinkParentsCannotBindAnotherRepository,
  testRuntimeCwdPhysicalOverridesRemainAvailable,
  testRuntimeCwdPhysicalConflictsAndInvalidDirectoriesAreRejected,
  testGitShortlogGroupSignatureFormatsAccumulate,
  testGitShortlogOrdinaryGroupsAndResetRemainAvailable,
  testGitShortlogSignatureFormatsRequireCallbackBinding,
  testGitShortlogOrdinaryFormatsIgnoreLogDefaults,
  testGitAndEnvQuotedDirectoryCharactersRemainLiteral,
  testGitAndEnvActualDirectoryExpansionRemainsRejected,
  testEnvRepeatedDirectoryOptionsAreRejected,
  testEnvSymlinkParentCannotBindLiteralRepository,
  testEnvSingleAndNestedPhysicalDirectoriesRemainAvailable,
  testEnvDirectoryLiteralTildesRemainAvailable,
  testEnvDirectoryExpansionAndWrongRepositoryRemainRejected,
  testGitShortlogCommitterCannotHideOutput,
  testGitShortlogBooleanOptionsRemainAvailable,
  testGitRevisionCommitterPatternsRemainLiteral,
  testGitReflogAndUpstreamLiteralsRemainAvailable,
  testGitReflogLiteralsDoNotEnableShellExpansion,
  testGitBlameOutputAfterFilenameCannotShareEvidence,
  testGitBlameDelimiterFilenameRemainsLiteral,
  testGitViewerShortClustersCannotHideOutput,
  testGitStashViewerFlagsCannotHideOutput,
  testGitStashReadOnlyFlagsAndDelimitersRemainAvailable,
  testGitStashMutationMessagesRemainLiteral,

  testGitViewerOutputCannotShareDeliveryEvidence,
  testGitOutputOptionsCannotBeHiddenOrCancelled,
  testGitReadOnlyViewerOptionsRemainAvailable,

  testGitUnquotedTildeCannotBindLiteralRepository,
  testGitTildeAssignmentWordsCannotHideExpansion,
  testGitTildeLiteralsAndOrdinaryPathsRemainAvailable,

  testGitIdentityRemainsBoundToRawObjects,
  testGitAnnotatedTargetsUseRawObjects,
  testGitApplyAuxiliaryIndexOutputIsNotReadOnly,
  testGitConfigurationFileOverrideCannotHideCallbacks,
  testGitConfigurationFileOverrideCannotHideTargets,
  testGitIdentityRejectsConfigurationFileOverrides,
  testGitApplyWritingOptionsInvalidateDeliveryEvidence,
  testGitApplyReportsRemainReadOnly,
  testGitStandaloneApplyRemainsAvailable,

  testGitQuotedOperatorsCannotHideCallbacks,
  testGitQuotedOperatorPathsCannotSelectPartialCommits,
  testGitCommentsCannotSpoofDryRun,
  testGitLiteralOperatorsAndShellCommentsRemainAvailable,
  testGitRejectsZshExecutableExpansion,
  testZshExpansionFixPreservesSubshellsAndLiterals,
  testGitPopulatedSubmoduleCallbackConfiguration,
  testGitInheritedExecPathCannotReplaceHelpers,
  testGitCommitTrailerProgramsRequireCallbackBinding,
  testGitTagTrailerProgramsRequireCallbackBinding,
  testGitSignatureDisplayDisableMatchesRealGit,
  testGitArgumentsRejectActualShellExpansions,
  testGitLiteralArgumentsPreserveQuoteAndEscapeSemantics,
  testGitGlobCannotSelectAnUnverifiedPartialCommit,
  testGitCandidateMutationsCannotShareDeliveryEvidence,
  testGitPushBindsConfiguredDestinations,
  testGitFixupBindsEditorsAndWholeIndex,
  testGitSigningConfigurationAndDisablePrecedence,
  testGitConfigSubcommandsKeepQueriesAndBlockEditing,
  testGitCredentialHelperBindsAliasAndExecutable,
  testGitFetchShortNoTagsMatchesLongForm,
  testGitDoubleQuotedBackslashesBindTheActualRepository,
  testGitReflogAndStashDisplayCallbacks,
  testGitFetchRejectsEffectivePruneTags,
  testGitProtectedUploadPackAndAlternateRefsCallbacks,
  testGitAutomaticMaintenanceCallback,
  testGitCredentialHelperRequiresInstalledIdentity,
  testGitCommitMustUseTheWholeVerifiedIndex,
  testGitCloneRejectsAllTemplateDeclarations,
  testGitCallbackCapabilitiesCoverContentAndSignatureReaders,
  testGitCallbackVariantsBindEditorsAndExplicitPrograms,
  testGitEffectiveCallbackEnvironmentAndPagerPrecedence,
  testGitFetchExpandsEffectiveRemoteAndConfiguredMappings,
  testGitOrdinaryCommandProfilesRemainAvailable,
  testGitCallbacksPreserveCaseSensitiveSubsections,
  testGitIdentityProbesRejectSubmoduleFilters,
  testGitIdentityProbesDisableHooks,
  testGitIdentityProbesRejectFilters,
  testVerificationGatePreservesEmptyArguments,
  testVerificationGateRejectsShellExecutionEnvironment,
  testVerificationGateRejectsExecutableGitConfiguration,
  testVerificationGateRejectsUnboundGitExtensions,
  testVerificationGateRequiresReleaseForActualTagReferences,
  testGitIdentityProbesDoNotRunCallbacks,
  testVerificationGateRejectsExtglobExecutables,
  testVerificationGateRejectsOptionsAfterShellCommandFlag,
  testVerificationGateTreatsTagDisplayOptionsAsCreationModifiers,
  testVerificationGateRejectsUnboundPlumbingDelivery,
  testVerificationGateHandlesEnvNamesAndExportedFunctions,
  testVerificationGateDoesNotTreatTagOptionValuesAsReadOnly,
  testVerificationGateBindsToolInvocationCwd,
  testVerificationGateRejectsUnparsedShellDelivery,
  testVerificationGateRejectsImplicitSubmoduleDelivery,
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
  testVerificationGateBindsActualRepository,
  testVerificationGateRejectsImplicitTagDelivery,
  testVerificationGateRejectsWrappedShellContextChanges,
  testVerificationGateBindsDecodedDeliveryContext,
  testVerificationGateRejectsShellStartupContext,
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

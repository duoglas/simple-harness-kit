#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ATTESTATION_SCHEMA_VERSION = '1.0';
const DIGEST_ALGORITHM = 'sha256';
const CANONICALIZATION = 'shk-canonical-json-v1';
const PROTECTED_SCOPE = 'entire-evidence-except-attestation.digest';
const TRUST_ORDER = Object.freeze({
  'local-self': 0,
  'local-controller': 1,
  'ci-signed': 2,
  independent: 3,
});
const MODES = new Set(['full', 'incremental', 'seal']);

function canonicalStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function protectedPayload(evidence) {
  const payload = cloneJson(evidence);
  if (payload.attestation && typeof payload.attestation === 'object') {
    delete payload.attestation.digest;
  }
  return payload;
}

function digestEvidence(evidence) {
  const canonical = canonicalStringify(protectedPayload(evidence));
  return `${DIGEST_ALGORITHM}:${crypto.createHash(DIGEST_ALGORITHM).update(canonical, 'utf8').digest('hex')}`;
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

function readGitIdentity(root) {
  const commit = git(root, ['rev-parse', '--verify', 'HEAD']);
  const tree = git(root, ['rev-parse', '--verify', 'HEAD^{tree}']);
  if (!commit || !tree) {
    return { available: false, commit: null, tree: null, dirty: null };
  }
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  return {
    available: true,
    commit,
    tree,
    dirty: status === null ? null : status.length > 0,
  };
}

function attestEvidence(evidence, options = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new TypeError('evidence must be an object');
  }
  const trustLevel = options.trust_level || 'local-self';
  if (!(trustLevel in TRUST_ORDER)) throw new Error(`invalid trust level: ${trustLevel}`);
  if (trustLevel !== 'local-self') {
    throw new Error(`local attestation issuer cannot issue unauthenticated trust level: ${trustLevel}`);
  }
  const issuer = options.issuer && typeof options.issuer === 'object'
    ? cloneJson(options.issuer)
    : { type: 'shk-cli', name: 'local' };
  const output = cloneJson(evidence);
  output.attestation = {
    schema_version: ATTESTATION_SCHEMA_VERSION,
    algorithm: DIGEST_ALGORITHM,
    canonicalization: CANONICALIZATION,
    protected_scope: PROTECTED_SCOPE,
    issuer,
    trust_level: trustLevel,
    digest: '',
  };
  output.attestation.digest = digestEvidence(output);
  return output;
}

function failure(code, message, data = {}) {
  return { code, message, ...data };
}

function verifyEvidence(evidence, policy = {}) {
  const failures = [];
  const checks = [];
  const addPass = (code, message, data = {}) => checks.push({ code, status: 'PASS', message, ...data });
  const addFailure = (code, message, data = {}) => {
    const item = failure(code, message, data);
    failures.push(item);
    checks.push({ ...item, status: 'FAIL' });
  };

  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    addFailure('EVIDENCE_INVALID', 'evidence must be a JSON object');
    return { schema_version: '1.0', status: 'FAIL', attested: false, legacy: false, checks, failures };
  }

  const att = evidence.attestation;
  const hasAttestation = Boolean(att && typeof att === 'object');
  if (!hasAttestation) {
    if (policy.allow_legacy === true && policy.require_attestation !== true) {
      addPass('LEGACY_EVIDENCE_ALLOWED', 'legacy evidence accepted by explicit compatibility policy');
    } else {
      addFailure('ATTESTATION_MISSING', 'evidence does not contain an attestation');
      return { schema_version: '1.0', status: 'FAIL', attested: false, legacy: true, checks, failures };
    }
  } else {
    if (att.schema_version !== ATTESTATION_SCHEMA_VERSION || att.algorithm !== DIGEST_ALGORITHM || att.canonicalization !== CANONICALIZATION || att.protected_scope !== PROTECTED_SCOPE) {
      addFailure('ATTESTATION_UNSUPPORTED', 'unsupported attestation schema, algorithm, canonicalization, or protected scope', {
        schema_version: att.schema_version || null,
        algorithm: att.algorithm || null,
        canonicalization: att.canonicalization || null,
        protected_scope: att.protected_scope || null,
      });
    } else {
      addPass('ATTESTATION_FORMAT_VALID', 'attestation format is supported');
    }

    let actualDigest = null;
    try { actualDigest = digestEvidence(evidence); } catch (err) {
      addFailure('ATTESTATION_CANONICALIZATION_FAILED', err.message);
    }
    if (actualDigest !== null) {
      if (typeof att.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(att.digest)) {
        addFailure('ATTESTATION_DIGEST_MISSING', 'attestation digest is missing or malformed', { actual: att.digest || null });
      } else if (att.digest !== actualDigest) {
        addFailure('ATTESTATION_DIGEST_INVALID', 'attestation digest does not match the protected evidence payload', {
          expected: att.digest,
          actual: actualDigest,
        });
      } else {
        addPass('ATTESTATION_DIGEST_VALID', 'attestation digest matches the protected evidence payload');
      }
    }
  }

  const provenance = evidence.provenance && typeof evidence.provenance === 'object' ? evidence.provenance : {};
  const gitIdentity = provenance.git && typeof provenance.git === 'object' ? provenance.git : {};

  if (policy.expected_commit !== undefined) {
    if (gitIdentity.commit !== policy.expected_commit) {
      addFailure('GIT_COMMIT_MISMATCH', 'evidence commit does not match the expected commit', {
        expected: policy.expected_commit,
        actual: gitIdentity.commit || null,
      });
    } else addPass('GIT_COMMIT_MATCH', 'evidence commit matches the expected commit', { actual: gitIdentity.commit });
  }
  if (policy.expected_tree !== undefined) {
    if (gitIdentity.tree !== policy.expected_tree) {
      addFailure('GIT_TREE_MISMATCH', 'evidence tree does not match the expected tree', {
        expected: policy.expected_tree,
        actual: gitIdentity.tree || null,
      });
    } else addPass('GIT_TREE_MATCH', 'evidence tree matches the expected tree', { actual: gitIdentity.tree });
  }
  if (policy.require_clean === true) {
    if (gitIdentity.dirty !== false) {
      addFailure('EVIDENCE_DIRTY', 'policy requires evidence generated from a clean Git worktree', { actual: gitIdentity.dirty ?? null });
    } else addPass('EVIDENCE_CLEAN', 'evidence records a clean Git worktree');
  }
  if (policy.require_mode !== undefined) {
    if (!MODES.has(policy.require_mode)) {
      addFailure('POLICY_MODE_INVALID', `unknown required mode: ${policy.require_mode}`);
    } else if (provenance.mode !== policy.require_mode) {
      addFailure('EVIDENCE_MODE_MISMATCH', 'evidence execution mode does not satisfy policy', {
        expected: policy.require_mode,
        actual: provenance.mode || null,
      });
    } else addPass('EVIDENCE_MODE_MATCH', 'evidence execution mode satisfies policy', { actual: provenance.mode });
  }
  const declaredTrust = hasAttestation ? att.trust_level : null;
  let authenticatedTrust = null;
  if (policy.authenticated_trust_level !== undefined) {
    if (!(policy.authenticated_trust_level in TRUST_ORDER)) {
      addFailure('POLICY_AUTHENTICATED_TRUST_INVALID', `unknown authenticated trust level: ${policy.authenticated_trust_level}`);
    } else {
      authenticatedTrust = policy.authenticated_trust_level;
    }
  }
  if (hasAttestation) {
    if (!(declaredTrust in TRUST_ORDER)) {
      addFailure('EVIDENCE_TRUST_INVALID', 'evidence declares an unknown trust level', { actual: declaredTrust || null });
    } else if (declaredTrust !== 'local-self') {
      if (authenticatedTrust === null || TRUST_ORDER[authenticatedTrust] < TRUST_ORDER[declaredTrust]) {
        addFailure('EVIDENCE_TRUST_UNVERIFIED', 'declared trust level has not been authenticated by an external issuer/verifier boundary', {
          declared: declaredTrust,
          authenticated: authenticatedTrust,
        });
      } else {
        addPass('EVIDENCE_TRUST_AUTHENTICATED', 'declared trust level is backed by caller-provided external authentication', {
          declared: declaredTrust,
          authenticated: authenticatedTrust,
        });
      }
    }
  }
  if (policy.min_trust !== undefined) {
    const actualTrust = declaredTrust;
    if (!(policy.min_trust in TRUST_ORDER)) {
      addFailure('POLICY_TRUST_INVALID', `unknown minimum trust level: ${policy.min_trust}`);
    } else if (!(actualTrust in TRUST_ORDER) || TRUST_ORDER[actualTrust] < TRUST_ORDER[policy.min_trust]) {
      addFailure('EVIDENCE_TRUST_INSUFFICIENT', 'evidence trust level is below policy minimum', {
        expected: policy.min_trust,
        actual: actualTrust || null,
      });
    } else addPass('EVIDENCE_TRUST_SUFFICIENT', 'evidence trust level satisfies policy', { actual: actualTrust });
  }

  return {
    schema_version: '1.0',
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    attested: hasAttestation,
    legacy: !hasAttestation,
    trust_level: declaredTrust || null,
    checks,
    failures,
  };
}

function verifyEvidenceFile(filePath, policy = {}) {
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return {
      schema_version: '1.0',
      status: 'FAIL',
      attested: false,
      legacy: false,
      evidence_file: filePath,
      checks: [],
      failures: [failure('EVIDENCE_FILE_INVALID', `cannot read evidence JSON: ${err.message}`)],
    };
  }
  return { ...verifyEvidence(evidence, policy), evidence_file: filePath };
}

function trustLevels() { return Object.keys(TRUST_ORDER); }

module.exports = {
  ATTESTATION_SCHEMA_VERSION,
  DIGEST_ALGORITHM,
  CANONICALIZATION,
  PROTECTED_SCOPE,
  TRUST_ORDER,
  MODES,
  canonicalStringify,
  protectedPayload,
  digestEvidence,
  readGitIdentity,
  attestEvidence,
  verifyEvidence,
  verifyEvidenceFile,
  trustLevels,
};

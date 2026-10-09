'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ledger = require('./task-ledger');

const OPTIONAL_CHECKS = Object.freeze(['build', 'types', 'lint', 'coverage']);
const RISK_CHECKS = Object.freeze({
  low: ['build', 'tests', 'diff', 'security'],
  medium: ['build', 'tests', 'diff', 'security', 'types', 'lint', 'coverage', 'spec', 'e2e'],
  high: ['build', 'tests', 'diff', 'security', 'types', 'lint', 'coverage', 'spec', 'e2e', 'santa'],
  release: ['build', 'tests', 'diff', 'security', 'types', 'lint', 'coverage', 'spec', 'e2e', 'santa',
    'runtime', 'runtime_selftest', 'doctor', 'dogfood_oss', 'upstream_dogfood', 'browser_e2e_dogfood', 'clean_tree', 'upstream'],
});
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return `sha256:${crypto.createHash('sha256').update(canonical(value)).digest('hex')}`; }
function invalid(message) { throw new Error(`APPLICABILITY_CONTRACT_INVALID: ${message}`); }
function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; invalid(`cannot read ${path.basename(file)}: ${error.message}`); }
}
function verificationScope(risk) {
  if (!RISK_CHECKS[risk]) invalid(`unknown risk ${risk}`);
  return { risk, required_checks: RISK_CHECKS[risk],
    proof_checks: risk === 'low' ? ['quality_gate'] : ['quality_gate', 'e2e_sufficiency', 'spec_status', 'test_effectiveness'] };
}

function detectedCommands(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = pkg && pkg.scripts || {};
  const exists = relative => {
    try { return fs.statSync(path.join(root, relative)).isFile(); }
    catch (error) { if (error.code === 'ENOENT') return false; invalid(`cannot inspect ${relative}`); }
  };
  return {
    build: scripts.build ? 'npm run build' : '',
    types: scripts.typecheck ? 'npm run typecheck' : scripts.types ? 'npm run types' : '',
    lint: scripts.lint ? 'npm run lint' : '',
    tests: scripts.test ? 'npm test' : exists('tests/run.js') ? 'node tests/run.js' : '',
    coverage: scripts.coverage ? 'npm run coverage' : '',
    e2e: scripts['test:e2e'] ? 'npm run test:e2e' : scripts.e2e ? 'npm run e2e'
      : exists('tests/scripts/13-e2e-sufficiency.sh') ? 'bash tests/scripts/13-e2e-sufficiency.sh'
        : exists('tests/scripts/03-full-e2e.sh') ? 'bash tests/scripts/03-full-e2e.sh'
          : exists('tests/e2e-acceptance-validate.sh') ? 'bash tests/e2e-acceptance-validate.sh' : '',
    runtime: exists('tests/codex-smoke.sh') ? 'bash tests/codex-smoke.sh' : '',
    runtime_selftest: exists('tests/codex-smoke-selftest.sh') ? 'bash tests/codex-smoke-selftest.sh' : '',
    dogfood_oss: exists('tests/scripts/17-oss-dogfood-validation.sh') ? 'bash tests/scripts/17-oss-dogfood-validation.sh' : '',
    upstream_dogfood: exists('tests/scripts/18-upstream-ci-dogfood.sh') ? 'bash tests/scripts/18-upstream-ci-dogfood.sh' : '',
    browser_e2e_dogfood: exists('tests/scripts/19-browser-e2e-dogfood.sh') ? 'bash tests/scripts/19-browser-e2e-dogfood.sh' : '',
  };
}

function identityInputs(config = {}) {
  const policy = config.verification_policy === undefined ? {} : config.verification_policy;
  if (!object(policy)) invalid('verification_policy must be an object');
  const inputs = policy.identity_inputs === undefined ? {} : policy.identity_inputs;
  if (!object(inputs)) invalid('identity_inputs must be an object');
  for (const [area, files] of Object.entries(inputs)) {
    if (!['runner', 'verdict', 'scheduler'].includes(area) || !Array.isArray(files)
        || files.some(file => typeof file !== 'string' || !file.trim() || file.includes('\0'))) {
      invalid(`identity_inputs.${area} must be an array of nonempty file paths`);
    }
  }
  return inputs;
}

// Pure resolver: every producer and consumer uses the same normalized contract.
function resolveContract({ config = {}, detected_commands = {}, risk, test_plan = [], spec = null } = {}) {
  if (!object(config)) invalid('config must be an object');
  const policy = config.verification_policy === undefined ? {} : config.verification_policy;
  if (!object(policy)) invalid('verification_policy must be an object');
  const supplied = policy.applicability === undefined ? {} : policy.applicability;
  if (!object(supplied)) invalid('applicability must be an object');
  const overrides = config.commands || {};
  if (!object(overrides)) invalid('commands must be an object');
  const commands = {};
  for (const [name, detected] of Object.entries(detected_commands)) {
    commands[name] = typeof overrides[name] === 'string' && overrides[name].trim() ? overrides[name].trim() : detected;
  }
  const declarations = {};
  for (const name of Object.keys(supplied).sort()) {
    const entry = supplied[name];
    if (!OPTIONAL_CHECKS.includes(name)) invalid(`${name} cannot be declared NOT_APPLICABLE`);
    if (!object(entry) || Object.keys(entry).some(key => !['status', 'reason'].includes(key))
        || entry.status !== 'NOT_APPLICABLE' || typeof entry.reason !== 'string') invalid(`invalid declaration for ${name}`);
    const reason = entry.reason.trim().replace(/\s+/g, ' ');
    if (!/[\p{L}\p{N}]/u.test(reason)
        || /\b(?:TODO|TBD)\b|（补充）|\(补充\)|待补充|待完善|待填写|待定|^(?:N\/?A|NOT_APPLICABLE|not applicable|none|reason|placeholder|<reason>|\[reason\]|无|不适用)[.!。]?$/i.test(reason)) {
      invalid(`${name} requires a concrete non-placeholder reason`);
    }
    if (detected_commands[name] || (overrides[name] !== undefined && overrides[name] !== '')) {
      invalid(`${name} has a detected or configured command and cannot be NOT_APPLICABLE`);
    }
    declarations[name] = { status: 'NOT_APPLICABLE', reason };
  }
  const includes = policy.suite_includes || {};
  for (const [parent, children] of Object.entries(includes)) {
    if (declarations[parent] || (Array.isArray(children) && children.some(child => declarations[child]))) {
      invalid('NOT_APPLICABLE checks cannot provide or inherit suite execution');
    }
  }
  return {
    schema_version: '1.0', declarations, commands,
    scope: risk === undefined ? null : verificationScope(risk),
    check_inputs: config.check_inputs || {}, suite_includes: includes,
    // The whole spec participates in proof evaluation. In legacy mode it is
    // ignored by Git, so Git identity alone cannot protect these inputs.
    spec, test_plan, identity_inputs: identityInputs(config),
  };
}

// The same control bytes bind full admission and ordinary incremental caches.
function controlIdentity(root, config = {}) {
  const inputs = identityInputs(config);
  const identity = {};
  for (const area of ['runner', 'verdict', 'scheduler']) {
    const files = Array.isArray(inputs[area]) ? inputs[area] : [];
    if (!files.length) continue;
    const payload = files.map(relPath => {
      // Preserve root-relative anchoring, but let the host filesystem resolve
      // literal characters and symlink/.. traversal instead of normalizing them.
      const file = `${root}${path.sep}${relPath}`;
      try { return { path: relPath, content_base64: fs.readFileSync(file).toString('base64') }; }
      catch { return { path: relPath, missing: true }; }
    });
    identity[`${area}_digest`] = payload.some(file => file.missing) ? null : digest(payload);
  }
  return identity;
}

function readContract(root, risk, config) {
  const current = config === undefined ? readJson(path.join(root, '.harness/config.json')) : config;
  const spec = readJson(ledger.resolveArtifactPath(root, 'spec'), null);
  return resolveContract({ config: current, risk, detected_commands: detectedCommands(root), spec, test_plan: spec && spec.test_plan || [] });
}
function hasNotApplicable(evidence) {
  return Object.values(evidence && evidence.checks || {}).some(check => check && check.status === 'NOT_APPLICABLE');
}
function applicableException(name, check, contract) {
  const declaration = contract && contract.declarations && contract.declarations[name];
  return OPTIONAL_CHECKS.includes(name) && declaration && check && check.status === 'NOT_APPLICABLE'
    && check.reason === declaration.reason && check.command === '' && !check.cached
    && !check.inherited && !check.included_by && !check.inherited_from;
}
function evidenceProblem(evidence, root) {
  const hasExceptions = hasNotApplicable(evidence);
  const hasContract = evidence.provenance && Object.prototype.hasOwnProperty.call(evidence.provenance, 'applicability');
  const fail = message => ({ code: 'APPLICABILITY_EVIDENCE_INVALID', message });
  if (root) {
    let controls;
    try { controls = controlIdentity(root, readJson(path.join(root, '.harness/config.json'))); }
    catch (error) { return { code: 'APPLICABILITY_CONTRACT_INVALID', message: error.message }; }
    const recordedControls = evidence.provenance && evidence.provenance.verification || {};
    for (const field of ['runner_digest', 'verdict_digest', 'scheduler_digest']) {
      if (!(field in controls) && !Object.prototype.hasOwnProperty.call(recordedControls, field)) continue;
      if (!evidence.attestation || !controls[field] || !recordedControls[field]) {
        return { code: 'CONTROL_IDENTITY_UNAVAILABLE', message: `${field} requires readable current controls and attested evidence identity` };
      }
      if (controls[field] !== recordedControls[field]) {
        return { code: 'CONTROL_IDENTITY_MISMATCH', message: `${field} does not match the current control contents` };
      }
    }
  }
  if (!hasExceptions && !hasContract) return null; // legacy still obeys configured control identities
  if (!evidence.attestation || !root) return fail('Contract-bound evidence requires attestation and a current project context');
  if (!Object.prototype.hasOwnProperty.call(RISK_CHECKS, evidence.risk)) return fail('Contract-bound evidence requires a known risk scope');
  let current;
  try { current = readContract(root, evidence.risk); }
  catch (error) { return { code: 'APPLICABILITY_CONTRACT_INVALID', message: error.message }; }
  const recorded = evidence.provenance && evidence.provenance.applicability;
  const currentDigest = digest(current);
  if (!recorded || !object(recorded.contract) || recorded.digest !== currentDigest || digest(recorded.contract) !== currentDigest
      || !evidence.provenance.verification || evidence.provenance.verification.test_manifest_digest !== currentDigest) {
    return { code: 'APPLICABILITY_CONTRACT_MISMATCH', message: 'Evidence does not match the current verification contract' };
  }
  if (!hasExceptions) return null;
  const checks = evidence.checks || {};
  const required = [...current.scope.required_checks, ...current.scope.proof_checks];
  if (required.some(name => !object(checks[name]))) return fail('current risk requires a complete check record');
  if (current.scope.proof_checks.some(name => checks[name].status !== 'PASS')) return fail('critical proof checks must remain PASS');
  for (const [name, check] of Object.entries(checks)) {
    if (!check || check.status !== 'NOT_APPLICABLE') continue;
    if (!applicableException(name, check, current)) return fail(`${name} is not a valid applicability exception`);
    if ((evidence.incremental && evidence.incremental.cached || []).includes(name)) return fail(`${name} cannot be cached NOT_APPLICABLE`);
    if (!(evidence.limitations || []).some(item => item.check === name && item.status === 'NOT_APPLICABLE'
        && item.reason === check.reason && item.claims_ready === false)) return fail(`${name} requires a distinct applicability limitation`);
  }
  for (const name of required) {
    const check = checks[name];
    if (check.status === 'NOT_APPLICABLE') continue;
    const santa = name === 'santa' && check.status === 'SKIP' && check.agent_review_required === true;
    if (!['PASS', 'SKIP', 'WARN'].includes(check.status) || (evidence.risk === 'release' && check.status !== 'PASS' && !santa)) {
      return fail(`${name} does not satisfy the current risk policy`);
    }
  }
  return null;
}

module.exports = { OPTIONAL_CHECKS, RISK_CHECKS, verificationScope, detectedCommands, resolveContract,
  readContract, identityInputs, controlIdentity, digest, hasNotApplicable, applicableException, evidenceProblem };

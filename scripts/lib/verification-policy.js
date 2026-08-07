'use strict';

const evidenceAttestation = require('./evidence-attestation');

const DEFAULT_IDENTITY_FIELDS = Object.freeze([
  'commit',
  'tree',
  'candidate_digest',
  'test_manifest_digest',
]);
const DEFAULT_CONTROL_AREAS = Object.freeze(['runner', 'verdict', 'scheduler', 'test_manifest']);
const DEFAULT_PLACEHOLDER_PATTERNS = Object.freeze([
  '\\bTODO\\b',
  '\\bTBD\\b',
  '（补充）',
  '\\(补充\\)',
  '待补充',
  '待完善',
]);
const DEFAULT_COMPLETED_STATES = Object.freeze(['implemented', 'done', 'completed', 'shipped', 'closed']);

function unique(values) {
  return [...new Set((values || []).filter(v => v !== undefined && v !== null).map(String))];
}

function evidenceIdentity(evidence) {
  const provenance = evidence && evidence.provenance || {};
  const git = provenance.git || {};
  const verification = provenance.verification || {};
  return {
    commit: git.commit || null,
    tree: git.tree || null,
    candidate_digest: git.candidate_digest || null,
    test_manifest_digest: verification.test_manifest_digest || null,
    runner_digest: verification.runner_digest || null,
    verdict_digest: verification.verdict_digest || null,
    scheduler_digest: verification.scheduler_digest || null,
  };
}

function compareIdentity(expected, actual, fields = DEFAULT_IDENTITY_FIELDS) {
  const changed = [];
  const missing = [];
  for (const field of unique(fields)) {
    const left = expected && expected[field];
    const right = actual && actual[field];
    if (left === undefined || left === null || left === '' || right === undefined || right === null || right === '') {
      missing.push(field);
    } else if (left !== right) {
      changed.push(field);
    }
  }
  return {
    status: changed.length === 0 && missing.length === 0 ? 'MATCH' : 'MISMATCH',
    changed_fields: changed,
    missing_fields: missing,
  };
}

function verifyCandidateContinuity({ candidate, artifacts = [], identity_fields = DEFAULT_IDENTITY_FIELDS } = {}) {
  const rows = artifacts.map((artifact, index) => {
    const identity = artifact && (artifact.identity || evidenceIdentity(artifact.evidence));
    const comparison = compareIdentity(candidate, identity, identity_fields);
    return {
      kind: artifact && artifact.kind || `artifact-${index + 1}`,
      status: comparison.status === 'MATCH' ? 'CURRENT' : 'STALE',
      changed_fields: comparison.changed_fields,
      missing_fields: comparison.missing_fields,
    };
  });
  return {
    status: rows.every(row => row.status === 'CURRENT') ? 'CURRENT' : 'STALE',
    candidate: candidate || null,
    artifacts: rows,
  };
}

function baselineIntegrityAssessment(baseline, options = {}) {
  const reasons = [];
  if (!baseline || typeof baseline !== 'object') {
    return { status: 'INVALID', reason_codes: ['BASELINE_MISSING'], identity: null };
  }

  const verification = evidenceAttestation.verifyEvidence(baseline, {
    require_attestation: options.require_attestation !== false,
    min_trust: options.min_trust || 'local-self',
    authenticated_trust_level: options.authenticated_trust_level,
  });
  if (verification.status !== 'PASS') reasons.push('BASELINE_ATTESTATION_INVALID');
  if (baseline.overall !== 'READY') reasons.push('BASELINE_NOT_READY');
  const mode = baseline.provenance && baseline.provenance.mode;
  if (!['full', 'seal'].includes(mode)) reasons.push('BASELINE_MODE_NOT_FULL');
  const incrementalCached = baseline.incremental && Array.isArray(baseline.incremental.cached)
    ? baseline.incremental.cached : [];
  const cachedChecks = Object.entries(baseline.checks || {})
    .filter(([, check]) => check && check.cached)
    .map(([name]) => name);
  const cached = unique([...incrementalCached, ...cachedChecks]);
  if (cached.length > 0) reasons.push('BASELINE_NOT_FULLY_EXECUTED');

  const identity = evidenceIdentity(baseline);
  const requiredIdentity = options.required_identity_fields || DEFAULT_IDENTITY_FIELDS;
  const missingIdentity = unique(requiredIdentity).filter(field => {
    const value = identity[field];
    return value === undefined || value === null || value === '';
  });
  if (missingIdentity.length > 0) reasons.push('BASELINE_IDENTITY_INCOMPLETE');

  return {
    status: reasons.length === 0 ? 'VALID' : 'INVALID',
    reason_codes: unique(reasons),
    identity,
    missing_identity_fields: missingIdentity,
    evidence_verification: verification,
  };
}

function baselineAssessment(baseline, candidate, options = {}) {
  const integrity = baselineIntegrityAssessment(baseline, options);
  if (!integrity.identity) return { ...integrity, comparison: null };
  const reasons = [...integrity.reason_codes];
  const identity = integrity.identity;
  const comparison = compareIdentity(candidate, identity, options.identity_fields || DEFAULT_IDENTITY_FIELDS);
  if (comparison.status !== 'MATCH') reasons.push('BASELINE_IDENTITY_MISMATCH');

  return {
    status: reasons.length === 0 ? 'VALID' : 'INVALID',
    reason_codes: unique(reasons),
    identity,
    comparison,
    missing_identity_fields: integrity.missing_identity_fields,
    evidence_verification: integrity.evidence_verification,
  };
}

function evaluateFullAdmission({ phase = 'final', candidate, baseline, prerequisites = {}, policy = {} } = {}) {
  if (!['final', 'integration'].includes(phase)) {
    return { status: 'FAIL', action: 'REJECT', phase, reason_codes: ['FULL_PHASE_INVALID'] };
  }
  const assessment = baselineAssessment(baseline, candidate, policy);
  if (assessment.status === 'VALID') {
    return {
      status: 'PASS',
      action: 'REUSE',
      phase,
      reason_codes: ['EXACT_FULL_BASELINE'],
      baseline: assessment,
    };
  }
  if (phase === 'integration') {
    return {
      status: 'FAIL',
      action: 'REJECT',
      phase,
      reason_codes: assessment.reason_codes,
      baseline: assessment,
    };
  }

  const reasons = [...assessment.reason_codes];
  if (policy.require_frozen_candidate && prerequisites.candidate_frozen !== true) reasons.push('CANDIDATE_NOT_FROZEN');
  if (policy.require_review && prerequisites.review_complete !== true) reasons.push('REVIEW_NOT_COMPLETE');
  const blocked = reasons.includes('CANDIDATE_NOT_FROZEN') || reasons.includes('REVIEW_NOT_COMPLETE');
  return {
    status: blocked ? 'FAIL' : 'PASS',
    action: blocked ? 'REJECT' : 'RUN',
    phase,
    reason_codes: unique(reasons),
    baseline: assessment,
  };
}

function evaluateReviewerPolicy({ candidate, evidence, changed_areas = [], risk_probes = [], policy = {} } = {}) {
  const assessment = baselineAssessment(evidence, candidate, policy);
  const controlAreas = new Set(policy.control_areas || DEFAULT_CONTROL_AREAS);
  const sensitive = unique(changed_areas).filter(area => controlAreas.has(area));
  const reasons = [];
  if (assessment.status !== 'VALID') reasons.push('EVIDENCE_NOT_AUDITABLE');
  if (sensitive.length > 0) reasons.push('VERIFICATION_CONTROL_CHANGED');
  const rebuild = reasons.length > 0;
  return {
    status: rebuild ? 'REBUILD_REQUIRED' : 'READY_FOR_REVIEW',
    action: rebuild ? 'FULL_REBUILD' : 'AUDIT_AND_PROBE',
    reason_codes: reasons,
    sensitive_areas: sensitive,
    required_probes: unique(risk_probes),
    evidence: assessment,
  };
}

function validateSuiteGraph(graph, knownSuites) {
  const known = new Set(unique(knownSuites));
  for (const [suite, included] of Object.entries(graph)) {
    if (!known.has(suite)) throw new Error(`SUITE_UNKNOWN_REFERENCE: ${suite}`);
    if (!Array.isArray(included)) throw new Error(`SUITE_INCLUDE_INVALID: ${suite} must contain an array`);
    for (const child of included) {
      if (!known.has(String(child))) throw new Error(`SUITE_UNKNOWN_REFERENCE: ${suite} -> ${child}`);
    }
  }

  const state = new Map();
  const stack = [];
  function visit(suite) {
    if (state.get(suite) === 2) return;
    if (state.get(suite) === 1) {
      const start = stack.indexOf(suite);
      throw new Error(`SUITE_INCLUDE_CYCLE: ${[...stack.slice(start), suite].join(' -> ')}`);
    }
    state.set(suite, 1);
    stack.push(suite);
    for (const child of graph[suite] || []) visit(String(child));
    stack.pop();
    state.set(suite, 2);
  }
  for (const suite of known) visit(suite);
}

function resolveSuitePlan({ selected = [], suite_includes = {}, known_suites } = {}) {
  if (!suite_includes || typeof suite_includes !== 'object' || Array.isArray(suite_includes)) {
    throw new Error('SUITE_INCLUDE_INVALID: suite_includes must be an object');
  }
  const chosen = unique(selected);
  const configuredChildren = [];
  for (const [suite, included] of Object.entries(suite_includes)) {
    if (!Array.isArray(included)) throw new Error(`SUITE_INCLUDE_INVALID: ${suite} must contain an array`);
    configuredChildren.push(...included);
  }
  const known = unique(known_suites || [...chosen, ...Object.keys(suite_includes), ...configuredChildren]);
  for (const [suite, included] of Object.entries(suite_includes)) {
    if (!known.includes(suite)) throw new Error(`SUITE_UNKNOWN_REFERENCE: ${suite}`);
    for (const child of included) {
      if (!known.includes(String(child))) throw new Error(`SUITE_UNKNOWN_REFERENCE: ${suite} -> ${child}`);
    }
  }
  const graph = {};
  for (const suite of known) graph[suite] = unique(suite_includes[suite] || []);
  validateSuiteGraph(graph, known);
  for (const suite of chosen) {
    if (!known.includes(suite)) throw new Error(`SUITE_UNKNOWN_REFERENCE: selected ${suite}`);
  }

  const closures = {};
  function closure(suite, seen = new Set()) {
    for (const child of graph[suite] || []) {
      if (!seen.has(child)) {
        seen.add(child);
        closure(child, seen);
      }
    }
    return seen;
  }
  for (const suite of known) closures[suite] = [...closure(suite)].sort();

  const hasSelectedAncestor = suite => chosen.some(owner => owner !== suite && closures[owner].includes(suite));
  const execute = chosen.filter(suite => !hasSelectedAncestor(suite));
  if (chosen.length > 0 && execute.length === 0) throw new Error('SUITE_PLAN_EMPTY: selected suites have no execution root');
  const includedBy = {};
  const ownedSuites = unique(execute.flatMap(root => [root, ...closures[root]]));
  for (const suite of ownedSuites) {
    const owners = execute.filter(root => root === suite || closures[root].includes(suite));
    if (owners.length > 1) throw new Error(`SUITE_OWNER_AMBIGUOUS: ${suite} <- ${owners.join(', ')}`);
  }
  for (const suite of chosen) {
    if (execute.includes(suite)) continue;
    const owners = execute.filter(root => closures[root].includes(suite));
    if (owners.length === 0) throw new Error(`SUITE_OWNER_MISSING: ${suite}`);
    includedBy[suite] = owners[0];
  }
  return {
    status: 'READY',
    selected: chosen,
    execute,
    included_by: includedBy,
    closures,
  };
}

function projectSuiteResults(plan, executedResults = {}) {
  const out = {};
  for (const suite of plan.selected || []) {
    if (!plan.included_by || !plan.included_by[suite]) {
      out[suite] = executedResults[suite] || {
        status: 'FAIL',
        reason: 'SUITE_RESULT_MISSING',
      };
      continue;
    }
    const owner = plan.included_by[suite];
    const ownerResult = executedResults[owner];
    out[suite] = ownerResult ? {
      ...ownerResult,
      command: `included by ${owner}`,
      reason: `suite ${suite} is covered by ${owner}`,
      included_by: owner,
      inherited: true,
    } : {
      status: 'FAIL',
      command: `included by ${owner}`,
      reason: 'SUITE_OWNER_RESULT_MISSING',
      included_by: owner,
      inherited: true,
    };
  }
  return out;
}

function valuesAtPath(document, pattern) {
  const parts = String(pattern || '').split('.').filter(Boolean);
  let rows = [{ path: '', value: document }];
  for (const part of parts) {
    const next = [];
    for (const row of rows) {
      if (part === '*') {
        if (Array.isArray(row.value)) {
          row.value.forEach((value, index) => next.push({ path: `${row.path}[${index}]`, value }));
        } else if (row.value && typeof row.value === 'object') {
          Object.entries(row.value).forEach(([key, value]) => next.push({ path: row.path ? `${row.path}.${key}` : key, value }));
        }
      } else if (row.value && typeof row.value === 'object' && Object.prototype.hasOwnProperty.call(row.value, part)) {
        next.push({ path: row.path ? `${row.path}.${part}` : part, value: row.value[part] });
      }
    }
    rows = next;
  }
  return rows;
}

function markdownSections(markdown) {
  const sections = new Map();
  const lines = String(markdown || '').split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      current = heading[2].trim();
      if (!sections.has(current)) sections.set(current, []);
    } else if (current) {
      sections.get(current).push(line);
    }
  }
  return sections;
}

function placeholderRegexes(patterns) {
  return unique(patterns && patterns.length ? patterns : DEFAULT_PLACEHOLDER_PATTERNS).map(pattern => {
    try { return new RegExp(pattern, 'iu'); }
    catch (err) { throw new Error(`REQUIREMENT_PLACEHOLDER_PATTERN_INVALID: ${pattern}: ${err.message}`); }
  });
}

function textValue(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n');
  if (typeof value === 'object') return Object.values(value).map(textValue).filter(Boolean).join('\n');
  return String(value).trim();
}

function evaluateRequirementCompleteness({ state, document, policy = {} } = {}) {
  const completedStates = new Set(policy.completed_states || DEFAULT_COMPLETED_STATES);
  if (!completedStates.has(String(state || ''))) {
    return { status: 'NOT_APPLICABLE', allowed: true, state, failures: [] };
  }
  const regexes = placeholderRegexes(policy.placeholder_patterns);
  const failures = [];
  const inspect = (path, value) => {
    const text = textValue(value);
    if (!text) {
      failures.push({ code: 'REQUIRED_CONTENT_MISSING', path });
      return;
    }
    const hit = regexes.find(re => re.test(text));
    if (hit) failures.push({ code: 'REQUIRED_CONTENT_PLACEHOLDER', path, pattern: hit.source });
  };

  if (typeof document === 'string') {
    const sections = markdownSections(document);
    for (const section of policy.required_sections || []) {
      inspect(`section:${section}`, sections.has(section) ? sections.get(section).join('\n') : '');
    }
  } else {
    for (const field of policy.required_fields || []) {
      const values = valuesAtPath(document, field);
      if (values.length === 0) failures.push({ code: 'REQUIRED_CONTENT_MISSING', path: field });
      else values.forEach(row => inspect(row.path || field, row.value));
    }
  }

  return {
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    allowed: failures.length === 0,
    state,
    failures,
  };
}

module.exports = {
  DEFAULT_IDENTITY_FIELDS,
  DEFAULT_CONTROL_AREAS,
  DEFAULT_PLACEHOLDER_PATTERNS,
  DEFAULT_COMPLETED_STATES,
  evidenceIdentity,
  compareIdentity,
  verifyCandidateContinuity,
  baselineIntegrityAssessment,
  baselineAssessment,
  evaluateFullAdmission,
  evaluateReviewerPolicy,
  resolveSuitePlan,
  projectSuiteResults,
  valuesAtPath,
  markdownSections,
  evaluateRequirementCompleteness,
};

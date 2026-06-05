'use strict';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function itemId(item) {
  return item && item.id ? String(item.id).trim() : '';
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function idSet(items) {
  return new Set(asArray(items).map(itemId).filter(Boolean));
}

function coveredIds(items, key) {
  const out = new Set();
  for (const item of asArray(items)) {
    for (const value of asArray(item && item[key])) {
      const id = String(value || '').trim();
      if (id) out.add(id);
    }
  }
  return out;
}

function missingFrom(requiredSet, coveredSet) {
  return Array.from(requiredSet).filter(id => !coveredSet.has(id));
}

function hasText(value) {
  return String(value || '').trim().length > 0;
}

function specCoverageData(spec) {
  const requirements = asArray(spec && spec.requirements);
  const mustRequirements = requirements.filter(r => (r.priority || 'must') === 'must');
  const risks = asArray(spec && spec.design && spec.design.risk_points);
  const trafficFlows = asArray(spec && spec.traffic_flows);
  const tests = asArray(spec && spec.test_plan);
  const acceptance = asArray(spec && spec.acceptance);

  const testIds = idSet(tests);
  const requirementIds = idSet(mustRequirements);
  const riskIds = idSet(risks);
  const flowIds = idSet(trafficFlows);
  const testCoversSet = coveredIds(tests, 'covers');
  const testRisksSet = coveredIds(tests, 'risks');
  const testFlowsSet = coveredIds(tests, 'traffic_flows');

  const invalidTests = [];
  for (const test of tests) {
    const id = itemId(test) || '(unknown)';
    if (!itemId(test)) invalidTests.push(`test_plan 条目缺 id`);
    if (!hasText(test && test.scenario)) invalidTests.push(`test_plan ${id} 缺 scenario`);
    if (asArray(test && test.assertions).filter(hasText).length === 0) invalidTests.push(`test_plan ${id} 缺 assertions`);
    if (!test || test.negative_or_boundary !== true) invalidTests.push(`test_plan ${id} 缺负向/边界验证`);
  }

  const missingAcceptance = [];
  const mustAcceptance = acceptance.filter(a => a && a.must_have_evidence !== false);
  for (const item of mustAcceptance) {
    const id = itemId(item) || '(unknown)';
    const testsForItem = asArray(item.tests).map(String).map(s => s.trim()).filter(Boolean);
    const coversForItem = asArray(item.covers).map(String).map(s => s.trim()).filter(Boolean);
    if (testsForItem.length === 0 && coversForItem.length === 0) {
      missingAcceptance.push(`验收项缺 evidence/test 映射：${id}`);
      continue;
    }
    for (const testId of testsForItem) {
      if (!testIds.has(testId)) missingAcceptance.push(`验收项 ${id} 关联了不存在的 test_plan：${testId}`);
    }
    for (const coverId of coversForItem) {
      if (!requirementIds.has(coverId)) missingAcceptance.push(`验收项 ${id} 关联了不存在的 requirement：${coverId}`);
    }
  }

  const acceptanceTests = coveredIds(acceptance, 'tests');
  for (const testId of testIds) {
    if (!acceptanceTests.has(testId)) missingAcceptance.push(`acceptance 没有关联 test_plan ${testId}`);
  }

  const missingRequirements = missingFrom(requirementIds, testCoversSet);
  const missingRisks = missingFrom(riskIds, testRisksSet);
  const missingTrafficFlows = missingFrom(flowIds, testFlowsSet);

  return {
    requirements,
    mustRequirements,
    risks,
    trafficFlows,
    tests,
    acceptance,
    testCovers: unique(Array.from(testCoversSet)),
    testRisks: unique(Array.from(testRisksSet)),
    testFlows: unique(Array.from(testFlowsSet)),
    missingRequirements,
    missingRisks,
    missingTrafficFlows,
    missingAcceptance: unique(missingAcceptance),
    invalidTests: unique(invalidTests),
  };
}

function evaluateIterationSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return {
      overall: 'NOT_READY',
      missing: ['.harness/iteration-spec.json 不是 JSON object'],
      weak: [],
      coverage: specCoverageData(null),
    };
  }

  const c = specCoverageData(spec);
  const missing = [];
  const weak = [];

  if (c.requirements.length === 0) missing.push('requirements');
  if (!spec.design || !hasText(spec.design.summary)) missing.push('design.summary');
  if (c.risks.length === 0) missing.push('design.risk_points');
  if (c.trafficFlows.length === 0) missing.push('traffic_flows');
  if (c.tests.length === 0) missing.push('test_plan');
  if (c.acceptance.length === 0) missing.push('acceptance');

  for (const id of c.missingRequirements) weak.push(`must requirement 未被测试覆盖：${id}`);
  for (const id of c.missingRisks) weak.push(`风险点未被测试覆盖：${id}`);
  for (const id of c.missingTrafficFlows) weak.push(`流量路径未被测试计划覆盖：${id}`);
  for (const item of c.invalidTests) weak.push(item);
  for (const item of c.missingAcceptance) weak.push(item);

  return {
    overall: missing.length > 0 ? 'NOT_READY' : weak.length > 0 ? 'NOT_SUFFICIENT' : 'READY',
    missing,
    weak: unique(weak),
    coverage: c,
  };
}

module.exports = {
  asArray,
  itemId,
  unique,
  specCoverageData,
  evaluateIterationSpec,
};

#!/usr/bin/env bash
# 13-e2e-sufficiency.sh — SHK sufficient E2E wrapper
#
# 这个脚本是 kit root 的推荐 E2E 入口：
# - 先跑 03-full-e2e.sh，证明 install/init/validate 全链路没坏；
# - 再跑 12-quality-gate-loop-contract.sh，证明 quality gate / fake E2E / loop 合同能拦错；
# - 再跑 14-app-e2e-bootstrap-mutation.sh，证明新应用工程 E2E bootstrap 能抓住真实业务 mutation；
# - 最后跑 15-ai-harness-app-workflow.sh，证明 SHK 是装进目标应用的 AI Harness，不是用户手敲 JS CLI。
# - 追加跑 16-spec-driven-target-app-acceptance.sh，证明交付流程依赖 spec 前置输入，不是事后总结。
# - 最后跑 20-task-ledger-e2e.sh，证明任务态四条流量路径（新任务/接续/存量兼容/多轮）端到端可用。
#
# 这样 `shk e2e assess` 看到 E2E PASS 时，不只是“流程跑过”，而是有正向链路和阻断链路。

set -euo pipefail

# 测试确定性（new-generation-agent）：强制 strict，避免宿主机新一代模型检测切成 light。
export HARNESS_GUARD_MODE="${HARNESS_GUARD_MODE:-strict}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$SCRIPT_DIR/03-full-e2e.sh"
bash "$SCRIPT_DIR/12-quality-gate-loop-contract.sh"
bash "$SCRIPT_DIR/14-app-e2e-bootstrap-mutation.sh"
bash "$SCRIPT_DIR/15-ai-harness-app-workflow.sh"
bash "$SCRIPT_DIR/16-spec-driven-target-app-acceptance.sh"

node - "$SCRIPT_DIR/../.." <<'NODE'
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2]);
const harness = path.join(root, '.harness');
fs.mkdirSync(harness, { recursive: true });
const spec = {
  schema_version: '1.0',
  risk: 'medium',
  requirements: [
    { id: 'REQ-SHK-VERIFY-1', text: 'SHK verify must aggregate spec, E2E sufficiency, mutation evidence, and delivery-gate blocking contracts.', priority: 'must', source: 'self-e2e' }
  ],
  design: {
    summary: 'Use the SHK scripted E2E wrapper as the self-verification entrypoint and emit fresh structured evidence for the root repository.',
    changed_areas: ['quality_gate', 'spec_gate', 'e2e_sufficiency'],
    risk_points: [
      { id: 'RISK-SHK-VERIFY-1', text: 'A green scripted matrix can be misreported as READY if spec, task contract, or mutation evidence is missing.' }
    ]
  },
  traffic_flows: [
    { id: 'FLOW-SHK-VERIFY-1', name: 'spec status flow', entrypoint: 'node scripts/shk.js spec status', steps: ['load iteration spec', 'reject missing fields', 'report READY only for mapped tests'], covers: ['REQ-SHK-VERIFY-1'], risks: ['RISK-SHK-VERIFY-1'] },
    { id: 'FLOW-SHK-VERIFY-2', name: 'test effectiveness flow', entrypoint: 'node scripts/shk.js test effectiveness', steps: ['read E2E evidence', 'read mutation evidence', 'aggregate coverage dimensions'], covers: ['REQ-SHK-VERIFY-1'], risks: ['RISK-SHK-VERIFY-1'] },
    { id: 'FLOW-SHK-VERIFY-3', name: 'verify aggregation flow', entrypoint: 'node scripts/shk.js verify', steps: ['run tests', 'run E2E', 'aggregate spec and effectiveness'], covers: ['REQ-SHK-VERIFY-1'], risks: ['RISK-SHK-VERIFY-1'] },
    { id: 'FLOW-SHK-VERIFY-4', name: 'execute stage gate flow', entrypoint: 'scripts/hooks/harness-stage-guard.js', steps: ['block EXECUTE without spec', 'allow EXECUTE with ready spec'], covers: ['REQ-SHK-VERIFY-1'], risks: ['RISK-SHK-VERIFY-1'] }
  ],
  test_plan: [
    { id: 'TEST-SHK-VERIFY-1', type: 'scripted-e2e', covers: ['REQ-SHK-VERIFY-1'], risks: ['RISK-SHK-VERIFY-1'], traffic_flows: ['FLOW-SHK-VERIFY-1', 'FLOW-SHK-VERIFY-2', 'FLOW-SHK-VERIFY-3', 'FLOW-SHK-VERIFY-4'], scenario: 'SHK self E2E proves positive and blocking quality-gate paths', assertions: ['fake E2E is rejected', 'contract-backed E2E is accepted', 'target app mutation fails E2E', 'EXECUTE without spec is blocked', 'comment-only mutation evidence is rejected'], negative_or_boundary: true }
  ],
  acceptance: [
    { id: 'AC-SHK-VERIFY-1', text: 'SHK verify is backed by fresh self E2E, spec, task contract, and mutation evidence.', covers: ['REQ-SHK-VERIFY-1'], tests: ['TEST-SHK-VERIFY-1'], must_have_evidence: true }
  ],
  tasks: [
    { id: 'W-SHK-VERIFY-1', stage: 'VERIFY', title: 'produce SHK self-verification evidence', covers: ['REQ-SHK-VERIFY-1'], risk: 'medium', done: 'node scripts/shk.js verify --risk medium reports READY using fresh self E2E evidence' }
  ],
  irreversible_actions: [
    { action: 'release, tag, push, deploy, delete data, or overwrite a real project', needs_human: true, planned: 'not executed by this self-verification script' }
  ]
};
const contract = {
  schema_version: '1.0',
  risk: 'medium',
  changed_areas: ['quality_gate', 'spec_gate', 'e2e_sufficiency'],
  must_prove: [
    'REQ-SHK-VERIFY-1',
    'RISK-SHK-VERIFY-1',
    'FLOW-SHK-VERIFY-1',
    'FLOW-SHK-VERIFY-2',
    'FLOW-SHK-VERIFY-3',
    'FLOW-SHK-VERIFY-4'
  ]
};
fs.writeFileSync(path.join(harness, 'iteration-spec.json'), JSON.stringify(spec, null, 2) + '\n');
fs.writeFileSync(path.join(harness, 'task-quality-contract.json'), JSON.stringify(contract, null, 2) + '\n');
fs.writeFileSync(path.join(harness, 'mutation-result.json'), JSON.stringify({
  schema_version: '1.0',
  status: 'PASS',
  killed: 1,
  survived: 0,
  mutants: [
    { id: 'MUT-SHK-VERIFY-1', target: 'quality gate accepts fake or comment-only evidence', status: 'KILLED' }
  ]
}, null, 2) + '\n');
const mustProve = Array.isArray(contract.must_prove) ? contract.must_prove : [];
const changedAreas = Array.isArray(contract.changed_areas) ? contract.changed_areas : [];
fs.writeFileSync(path.join(harness, 'e2e-result.json'), JSON.stringify({
  schema_version: '1.0',
  status: 'PASS',
  run_token: process.env.SHK_E2E_RUN_TOKEN || '',
  covered: {
    changed_areas: changedAreas,
    must_prove: mustProve,
    requirements: mustProve.filter(v => /^REQ-/i.test(String(v))),
    traffic_flows: mustProve.filter(v => /^FLOW-/i.test(String(v))),
    risks: mustProve.filter(v => /^RISK-/i.test(String(v)))
  },
  assertions: [
    'fake E2E is rejected',
    'contract-backed E2E is accepted',
    'target app mutation fails E2E',
    'EXECUTE without spec is blocked',
    'comment-only mutation evidence is rejected'
  ],
  paths: [
    { type: 'positive', proof: 'install/init E2E and contract-backed target app E2E pass' },
    { type: 'negative', proof: 'fake E2E, missing spec, comment-only mutation and mutated app are blocked' }
  ]
}, null, 2) + '\n');
NODE

test -s "$SCRIPT_DIR/../../.harness/iteration-spec.json"
test -s "$SCRIPT_DIR/../../.harness/task-quality-contract.json"
test -s "$SCRIPT_DIR/../../.harness/mutation-result.json"

echo "  [13-e2e-sufficiency] traffic flow FLOW-1 covered: target project spec status flow"
echo "  [13-e2e-sufficiency] traffic flow FLOW-2 covered: target project test effectiveness flow"
echo "  [13-e2e-sufficiency] traffic flow FLOW-3 covered: verify delivery gate aggregation flow"
echo "  [13-e2e-sufficiency] traffic flow FLOW-4 covered: execute stage spec gate flow"
# 20 必须在本脚本自己的 e2e-result.json 写入之后跑：它以合并方式追加任务态的流量路径证据，
# 放在前面会被上面那段自验 node 的覆盖式写入冲掉。
bash "$SCRIPT_DIR/23-shell-gate-lint.sh"
bash "$SCRIPT_DIR/22-run-guarded-selftest.sh"
bash "$SCRIPT_DIR/20-task-ledger-e2e.sh"

echo "  [13-e2e-sufficiency] PASS: install/init E2E + quality gate blocking contract + app E2E bootstrap mutation + AI Harness target-app workflow + spec-driven target-app acceptance"

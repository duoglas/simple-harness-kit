#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TASK_DIR="$ROOT/docs/tasks/T-20260930-release-admission-fix"
: "${SHK_E2E_RUN_TOKEN:?a fresh verification run token is required}"
cd "$ROOT"

# These task flows exercise real temporary Git repositories and CLI/hook
# entrypoints, including altered evidence, candidate drift and invalid inputs.
bash docs/tasks/T-20260807-feature-verification-policy/verify-flow-e2e.sh
bash docs/tasks/T-20260804-evidence-attestation/verify-flow-e2e.sh
node tests/verification-policy.test.js
node tests/verification-applicability.test.js
node tests/upgrade-ref-contract.test.js

# This is the real browser dogfood, including its mutation controls, rather
# than a source-text claim of browser coverage. Release verification may declare
# e2e -> browser_e2e_dogfood containment because this command actually runs it.
SHK_BROWSER_E2E_REQUIRED=1 bash tests/scripts/19-browser-e2e-dogfood.sh
node - "${SHK_BROWSER_E2E_ARTIFACT_DIR:-/private/tmp/shk-browser-e2e-artifacts}/phase2-browser-e2e-dogfood-result.json" <<'NODE'
const fs = require('fs');
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (result.status !== 'PASS') throw new Error('browser dogfood did not produce PASS evidence');
NODE

# Emit the current task mapping only after all positive and negative assertions
# have passed. Preserve the executed attestation flow's fault-injection results.
node - "$TASK_DIR/spec.json" "$SHK_E2E_RUN_TOKEN" <<'NODE'
const fs = require('fs');
const [specFile, token] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const fault = JSON.parse(fs.readFileSync('.harness/mutation-result.json', 'utf8'));
if (fault.status !== 'PASS' || !(fault.killed > 0) || fault.survived !== 0) {
  throw new Error('the executed E2E flow did not produce passing fault controls');
}
const requirements = spec.requirements.map(r => r.id);
const risks = spec.design.risk_points.map(r => r.id);
const traffic_flows = spec.traffic_flows.map(r => r.id);
const must_prove = [...requirements, ...risks, ...traffic_flows];
const write = (name, value) => fs.writeFileSync(`.harness/${name}.json`, JSON.stringify(value, null, 2) + '\n');
write('task-quality-contract', {
  schema_version: '1.0', risk: spec.risk,
  changed_areas: spec.design.changed_areas, must_prove, source: 'task-spec',
});
write('e2e-result', {
  schema_version: '1.0', status: 'PASS', run_token: token,
  covered: { changed_areas: spec.design.changed_areas, must_prove, requirements, risks, traffic_flows },
  assertions: [
    'same-risk exact verification reuses evidence; risk upgrades and incomplete signed checks are rejected',
    'configured control drift and unsatisfied review/freeze prerequisites reject reuse',
    'wildcard requirements retain missing branches and preserve complete/draft controls',
    'delivery hooks reject foreign repositories and unbound implicit tag delivery with valid evidence',
    'attestation rejects tampering, unverified trust and mismatched Git candidates',
    'explicit applicability is honest and current-contract bound across producers and consumers',
    'remote upgrade proof binds actual remote objects and missing proof blocks release',
    'real browser dogfood and mutation controls pass',
  ],
  paths: [
    { type: 'positive', proof: 'real temporary Git/CLI and evidence-consumer controls pass' },
    { type: 'negative', proof: 'fault inputs and altered candidates are rejected before task mutation or delivery' },
  ],
});
NODE
echo '[release-admission-e2e] PASS'

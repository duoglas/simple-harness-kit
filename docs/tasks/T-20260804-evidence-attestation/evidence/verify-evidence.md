# SHK Verification Report

- risk: high
- overall: READY
- completed_at: 2026-08-05T02:06:17.855Z
- run_id: run-c62b0012-30ad-48d2-bec5-a91373d412b9
- mode: full
- git_commit: c49b14944e850dedff31e39eddd1a5c2df121f92
- git_tree: c5c3697f0e2a32fb26c54646ff1d07c45e06a9a7
- git_dirty: true
- git_candidate_digest: sha256:f780403e3260098ded7f75d6925afc7c16538ecb6aead586b5e4f253a365b333
- attestation_trust: local-self
- attestation_digest: sha256:01faf7bb356ddb38ec93a59bc15abb5861270ffe821bf9145026b7e85ef0994a

| Check | Status | Command / Detail |
|---|---|---|
| quality_gate | PASS | 这次按 high 风险做准出检查。已找到测试入口：node tests/run.js --unit。已找到 E2E 入口：bash docs/tasks/T-20260804-evidence-attestation/verify-flow-e2e.sh。当前准出入口状态：READY。这只是能力快照，还没有跑测试；最终能不能交付要看 `shk verify --write-evidence` 的 fresh evidence。 |
| build | SKIP | not configured |
| types | SKIP | not configured |
| lint | SKIP | not configured |
| tests | PASS | node tests/run.js --unit |
| coverage | SKIP | not configured |
| e2e | PASS | bash docs/tasks/T-20260804-evidence-attestation/verify-flow-e2e.sh |
| security | PASS | 0 findings |
| diff | PASS | .gitignore                                         /    4 +
 README.md                                          /   15 +-
 docs/constraints.md                                /   19 +-
 .../evidence/verify-evidence.json                  /   65 +-
 .../evidence/verify-evidence.md                    /   44 +-
 .../T-20260804-evidence-attestation/findings.md    /   84 +-
 docs/tasks/T-20260804-evidence-attestation/plan.md /  107 +-
 .../T-20260804-evidence-attestation/progress.md    /  203 ++--
 .../T-20260804-evidence-attestation/spec.json      /   94 +-
 .../T-20260804-evidence-attestation/task_plan.md   /  130 +--
 .../verify-flow-e2e.sh                             /   85 +-
 scripts/hooks/delivery-gate.js                     /   31 +-
 scripts/hooks/harness-stage-guard.js               /  106 +-
 scripts/hooks/verification-gate.js                 /  615 ++++++++++-
 scripts/lib/evidence-attestation.js                /  184 ++-
 scripts/lib/run_guarded.py                         /  422 ++++++-
 scripts/shk.js                                     /    3 +
 tests/codex-init-smoke.sh                          /   17 +-
 tests/codex-smoke-selftest.sh                      /   25 +-
 tests/codex-smoke.sh                               /   29 +-
 tests/evidence-attestation.test.js                 /  162 ++-
 tests/hook-scenarios/guard-mode-light.json         /   22 +-
 tests/hook-scenarios/stage-guard.json              /    2 +-
 .../verification-gate-task-mode.json               /    2 +-
 tests/hook-scenarios/verification-gate.json        /   27 +-
 tests/quality-suite.test.js                        / 1166 +++++++++++++++++++-
 tests/run.js                                       /  105 +-
 tests/scripts/22-run-guarded-selftest.sh           /  410 +++++++
 update.sh                                          /  592 ++++++++--
 upgrade.sh                                         /   25 +-
 30 files changed, 4062 insertions(+), 733 deletions(-) |
| spec | PASS | 迭代 spec 是有效的：需求、方案、风险、测试计划、流量路径和验收标准都有明确映射。 |
| santa | SKIP | santa requires agent/human review |
| runtime | SKIP | not required or not configured |
| runtime_selftest | SKIP | not required or not configured |
| doctor | SKIP | not required or not configured |
| dogfood_oss | SKIP | not required or not configured |
| upstream_dogfood | SKIP | not required or not configured |
| browser_e2e_dogfood | SKIP | not required or not configured |
| clean_tree | SKIP | not required or not configured |
| upstream | SKIP | not required or not configured |
| e2e_sufficiency | PASS | E2E 不只是跑过了，也覆盖了本次风险、正向路径、阻断路径和结构化证据。 |
| spec_status | PASS | 迭代 spec 是有效的：需求、方案、风险、测试计划、流量路径和验收标准都有明确映射。 |
| test_effectiveness | PASS | 测试有效性足够：它不是只证明“跑过”，而是映射到了 spec 的需求、风险、流量路径、断言、负向场景和 mutation/fault 证据。运行真实性是 PARTIAL。 |

## Limitations

- coverage: Coverage is not configured; this run does not claim an 80% line/branch coverage proof.
- runtime: Runtime/Codex smoke was not required for this risk level and is not counted as runtime PASS evidence.
- santa: Santa adversarial review requires agent/human review; this run does not claim santa PASS evidence.

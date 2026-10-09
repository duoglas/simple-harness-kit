# SHK Verification Report

- risk: high
- overall: READY
- completed_at: 2026-10-09T02:06:32.347Z
- run_id: run-40d0e8cf-8a89-48b1-a994-61555e0414dd
- mode: full
- git_commit: ff00b68241aacddf68d21f4a59554f843930574f
- git_tree: ac1d83531b096eadeb65dfe7bee5887626c24b58
- git_dirty: true
- git_candidate_digest: sha256:b91202ad1190b08c696c1b408e46638775ee06beecb2e667b1e9fb556e748a1d
- attestation_trust: local-self
- attestation_digest: sha256:cb7ab33011db67803a7b15921e4ae592b401f4a576b67f341063943d2fb4b09b

| Check | Status | Command / Detail |
|---|---|---|
| quality_gate | PASS | 这次按 high 风险做准出检查。已找到测试入口：bash -o pipefail -c 'node tests/run.js --unit 2>&1 / tee .harness/verification-tests.log'。已找到 E2E 入口：SHK_BROWSER_E2E_REQUIRED=1 bash docs/tasks/T-20260930-release-admission-fix/verify-flow-e2e.sh。当前准出入口状态：READY。这只是能力快照，还没有跑测试；最终能不能交付要看 `shk verify --write-evidence` 的 fresh evidence。 |
| build | NOT_APPLICABLE | Source-distributed Node.js and Bash toolkit; no build artifact or build command is defined. |
| types | NOT_APPLICABLE | The project ships JavaScript and Bash sources and defines no static type-check command. |
| lint | NOT_APPLICABLE | No lint tool or lint command is configured for this release; lint validation is not claimed. |
| tests | PASS | bash -o pipefail -c 'node tests/run.js --unit 2>&1 / tee .harness/verification-tests.log' |
| coverage | NOT_APPLICABLE | No coverage collection command is configured; no coverage percentage or threshold attainment is claimed. |
| e2e | PASS | SHK_BROWSER_E2E_REQUIRED=1 bash docs/tasks/T-20260930-release-admission-fix/verify-flow-e2e.sh |
| security | PASS | 0 findings |
| diff | PASS | CHANGELOG.md                                       /   32 +
 docs/TODO.md                                       /   20 +-
 docs/constraints.md                                /  130 +-
 docs/evidence-attestation.md                       /   73 +
 docs/release-process.md                            /   15 +-
 docs/tasks/INDEX.md                                /    1 +
 init-prompt.md                                     /   10 +-
 scripts/hooks/delivery-gate.js                     /   14 +-
 scripts/hooks/harness-stage-guard.js               /   14 +-
 scripts/hooks/verification-gate.js                 / 1383 ++++++-
 scripts/lib/evidence-attestation.js                /   93 +-
 scripts/lib/verification-policy.js                 /   63 +-
 scripts/lib/verify-cache.js                        /   13 +-
 scripts/shk.js                                     /  215 +-
 skills/harness-init/resources/init-prompt.md       /   10 +-
 skills/harness-init/resources/required-wiring.json /    1 +
 tests/evidence-attestation.test.js                 / 4357 +++++++++++++++++++-
 tests/pre-release-check.sh                         /   10 +-
 tests/quality-suite.test.js                        /   52 +-
 tests/required-wiring.json                         /    1 +
 tests/run.js                                       /   39 +-
 tests/scripts/21-upgrade-ref-contract.sh           /   58 +-
 tests/verification-policy.test.js                  /  310 +-
 upgrade.sh                                         /    5 +-
 24 files changed, 6622 insertions(+), 297 deletions(-) |
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
| test_effectiveness | PASS | 测试有效性足够：它不是只证明“跑过”，而是映射到了 spec 的需求、风险、流量路径、断言、负向场景和 mutation/fault 证据。运行真实性是 PASS。 |

## Limitations

- build: build: NOT_APPLICABLE — Source-distributed Node.js and Bash toolkit; no build artifact or build command is defined.
- types: types: NOT_APPLICABLE — The project ships JavaScript and Bash sources and defines no static type-check command.
- lint: lint: NOT_APPLICABLE — No lint tool or lint command is configured for this release; lint validation is not claimed.
- coverage: coverage: NOT_APPLICABLE — No coverage collection command is configured; no coverage percentage or threshold attainment is claimed.
- runtime: Runtime/Codex smoke was not required for this risk level and is not counted as runtime PASS evidence.
- santa: Santa adversarial review requires agent/human review; this run does not claim santa PASS evidence.

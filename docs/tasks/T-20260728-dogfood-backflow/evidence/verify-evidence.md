# SHK Verification Report

- risk: high
- overall: READY
- completed_at: 2026-07-29T12:04:33.649Z

| Check | Status | Command / Detail |
|---|---|---|
| quality_gate | PASS | 这次按 high 风险做准出检查。已找到测试入口：node tests/run.js --unit。已找到 E2E 入口：bash tests/scripts/13-e2e-sufficiency.sh。当前准出入口状态：READY。这只是能力快照，还没有跑测试；最终能不能交付要看 `shk verify --write-evidence` 的 fresh evidence。 |
| build | SKIP | not configured |
| types | SKIP | not configured |
| lint | SKIP | not configured |
| tests | PASS | node tests/run.js --unit |
| coverage | SKIP | not configured |
| e2e | PASS | bash tests/scripts/13-e2e-sufficiency.sh |
| security | PASS | 0 findings |
| diff | PASS | scripts/shk.js / 14 +++++++++++++-
 tests/run.js   / 13 +++++++++++--
 2 files changed, 24 insertions(+), 3 deletions(-) |
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

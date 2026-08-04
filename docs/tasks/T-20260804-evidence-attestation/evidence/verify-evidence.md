# SHK Verification Report

- risk: high
- overall: READY
- completed_at: 2026-08-04T09:52:07.512Z
- run_id: run-e58beefa-e409-40d8-b4b3-ef54f0c1e52c
- mode: full
- git_commit: f54facdbff9e28dd3ea4e16f7c7e5670e5f1b682
- git_tree: 9cf5a765f71fbfd29ba810f3bc4a1ce1eece365f
- git_dirty: true
- attestation_trust: local-self
- attestation_digest: sha256:e755c02f2bf6e6d7f803c51bfb049bd88f25b7c72377cf7be8f52fefdf18bd1a

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
| diff | PASS | docs/tasks/INDEX.md / 4 +++-
 1 file changed, 3 insertions(+), 1 deletion(-) |
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

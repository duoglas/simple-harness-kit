# Quality Engineering Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SHK help target application projects write clear specs, generate/validate effective tests, gate delivery, and loop-fix problems.

**Architecture:** Keep `scripts/shk.js` as the AI harness backend, not a user-facing product surface. Add spec and test-effectiveness assessors that aggregate iteration spec, E2E sufficiency, traffic coverage, mutation/fault evidence, and fresh evidence into `verify`.

**Tech Stack:** Node.js CLI, JSON evidence under `.harness/`, shell script regression tests, existing SHK hooks/skills/templates.

---

### Task 1: Spec-backed gate

**Files:**
- Modify: `scripts/shk.js`
- Test: `tests/quality-suite.test.js`

- [x] Add failing tests for missing `.harness/iteration-spec.json`, uncovered must requirements, and uncovered traffic flows.
- [x] Implement `shk spec status --risk <risk> --format json`.
- [x] Require requirements, design, test_plan, traffic_flows, and acceptance mappings.

### Task 2: Test effectiveness assessor

**Files:**
- Modify: `scripts/shk.js`
- Test: `tests/quality-suite.test.js`

- [x] Add failing tests for traffic coverage and mutation/fault evidence.
- [x] Implement `shk test effectiveness --risk <risk> --format json`.
- [x] Include dimensions: requirements, risks, traffic, assertion quality, positive path, negative path, mutation sensitivity, runtime realism, fresh evidence.

### Task 3: Verify aggregation

**Files:**
- Modify: `scripts/shk.js`
- Test: `tests/quality-suite.test.js`

- [x] Add failing test that `verify --write-evidence` writes `spec_status` and `test_effectiveness`.
- [x] Aggregate these checks into medium/high/release verification evidence.
- [x] Keep `NOT_SUFFICIENT` as a blocking overall state.

### Task 4: AI Harness docs and skills

**Files:**
- Create: `docs/quality-engineering-gate.md`
- Modify: `skills/harness-start/SKILL.md`
- Modify: `skills/auto-harness-test-bootstrap/SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Test: `tests/template-integrity.js`

- [x] Explain Phase 2 as target-project capability, not this repo's internal test process.
- [x] Cover three outcomes: measurable spec, test generation/effective validation/delivery gate, loop optimization.
- [x] Add template integrity anchors.

### Task 5: Verification

**Files:**
- Test only.

- [x] Run `node tests/quality-suite.test.js`.
- [x] Run `node tests/template-integrity.js`.
- [x] Run broader scripted matrix and final verify once current repo has a matching iteration spec/evidence.

### Task 6: Spec-driven stage guard

**Files:**
- Modify: `scripts/hooks/harness-stage-guard.js`
- Test: `tests/quality-suite.test.js`
- Test: `tests/hook-scenarios/stage-guard.json`

- [x] PLAN 阶段允许写 `.harness/iteration-spec.json`。
- [x] 切到 EXECUTE 前检查 iteration spec 是否存在、是否覆盖需求、风险和流量路径。
- [x] 缺 spec 或 spec 不充分时拦住，不让 AI 先写代码后补文档。

### Task 7: Target app dogfood acceptance

**Files:**
- Modify: `tests/scripts/13-e2e-sufficiency.sh`
- Modify: `tests/scripts/16-spec-driven-target-app-acceptance.sh`
- Create: `docs/phase2-quality-gate/05-phase2-dogfood-iteration.md`

- [x] 样例订单应用缺 spec 时，`spec status` 必须拦住。
- [x] 样例订单应用缺 spec 时，stage guard 必须拦住 EXECUTE。
- [x] 补 spec 后才能生成 E2E，并用 mutation 证明坏订单逻辑会被抓住。

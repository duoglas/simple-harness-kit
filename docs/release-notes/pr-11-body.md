## Summary

This PR upgrades SHK from “AI should run checks before delivery” to “AI must produce measurable delivery evidence before it can hand work off.”

The main user-facing change: inside Claude Code / Codex, SHK now expects the agent to start from a short iteration spec, generate or select tests for the target app, judge whether those tests actually prove the changed path, and enter a bounded repair loop when proof is missing.

## What changed

- Added a Phase 2 Quality Engineering Gate:
  - spec-driven iteration workflow;
  - target-app E2E inspection/bootstrap;
  - E2E sufficiency assessment;
  - test effectiveness assessment;
  - bounded loop repair skill;
  - stronger delivery/verification gates.
- Reworked README / README.zh-CN so the GitHub landing page explains SHK as an AI harness, not a JS package.
- Added release-note drafts:
  - `docs/release-notes/v0.10.0-github.md` for the already-published Quality Gate Suite release;
  - `docs/release-notes/v0.11.0.md` for this Phase 2 work.

## How to read the result

E2E PASS is no longer enough by itself.

For medium/high/release work, SHK now distinguishes:

- `READY`: the evidence is fresh and covers the changed spec/risk paths;
- `NOT_READY`: required evidence is missing, failed, stale, or degraded;
- `NOT_SUFFICIENT`: commands passed, but they did not prove the change.

That means fake E2E, smoke-only flows, missing assertions, uncovered traffic, or tests that still pass after critical logic is broken cannot be used as delivery proof.

## Test evidence

Latest evidence from this branch:

```text
node tests/run.js: 216 passed, 0 failed
run-all matrix: 16 PASS / 1 SKIP / 0 FAIL in sandbox
Phase 2 dogfood: fake/smoke-only blocked, target-app mutation caught, spec-driven acceptance caught broken behavior
security scan: PASS
Codex runtime smoke: DEGRADED / SKIP, not runtime PASS
```

## Known limits

- Codex `exec` runtime hook execution is still not fully proven in every environment. When it is degraded, the report must say DEGRADED and must not count it as release-ready runtime evidence.
- Phase 2 sufficiency is an engineering proof-strength gate, not a formal coverage proof.

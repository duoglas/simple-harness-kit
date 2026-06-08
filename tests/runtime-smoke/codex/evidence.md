# Codex Runtime Smoke Evidence

Date: 2026-06-08

## Commands

```bash
codex --version
bash tests/codex-smoke.sh
CODEX_REQUIRED=1 bash tests/codex-smoke-selftest.sh
bash tests/scripts/11-codex-smoke-contract.sh
node tests/run.js
```

## Output Summary

- `codex --version` -> `codex-cli 0.137.0`
- `bash tests/codex-smoke.sh` -> exit 0, `DEGRADED: project .codex/hooks.json command 未被 exec 模式验证`
- `CODEX_REQUIRED=1 bash tests/codex-smoke-selftest.sh` -> exit 1, `FAIL: 当前 Codex exec 未执行 project sentinel hook；bad-hook 捕获能力未被验证`
- `bash tests/scripts/11-codex-smoke-contract.sh` -> PASS
- `node tests/run.js` -> `218 passed, 0 failed, 218 total`
- `tests/scripts/run-all.sh` inside `node tests/run.js` -> `17 PASS / 0 SKIP / 0 FAIL` in this sandbox.

## Interpretation

The live Codex evidence is intentionally degraded. It shows that a minimal `codex exec` run completed and did not emit hook failure markers, but the injected project sentinel hook did not run, so it does not prove `.codex/hooks.json` command execution.

The fake-Codex contract test is substitute evidence only for script behavior: required unverified smoke fails, optional unverified smoke remains degraded, and simulated hook failure patterns are classified correctly. It is not evidence that real Codex executed project hooks.

# Codex runtime smoke

Use `bash tests/codex-smoke.sh` for Codex runtime compatibility. For real enforcement health in an interactive session, run:

```bash
node scripts/shk.js doctor
```

Doctor checks whether Bash PostToolUse observations exist without matching PreToolUse stage-guard observations.

## Current evidence boundary

In the current validation environment (`codex-cli 0.137.0`), a minimal `codex exec` run can finish without any hook failure marker, but the project sentinel hook injected by `tests/codex-smoke.sh` does not execute. That means the live smoke result is `DEGRADED`: it proves the runtime can start and did not report hook failures, but it does not prove `.codex/hooks.json` commands actually ran.

Release gates must not treat that degraded live result as runtime `PASS`. For release-ready enforcement, run:

```bash
CODEX_REQUIRED=1 bash tests/codex-smoke-selftest.sh
```

If the sentinel hook is not executed in required mode, the selftest fails. `tests/scripts/11-codex-smoke-contract.sh` uses a fake Codex binary only to validate the smoke scripts' exit-code and message contracts; it is replacement evidence for script classification behavior, not evidence that real Codex executed project hooks.

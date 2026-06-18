# Codex runtime smoke

Use `bash tests/codex-smoke.sh` for Codex runtime compatibility. For real enforcement health in an interactive session, run:

```bash
node scripts/shk.js doctor
```

Doctor checks whether Bash PostToolUse observations exist without matching PreToolUse stage-guard observations.
It also warns if `~/.codex/config.toml` trusts only a parent directory and does not contain an exact
`[projects."/absolute/repo/root"] trust_level = "trusted"` entry for the current repo root. In
current Codex builds, that exact-root trust is often required before interactive project-local hooks
become eligible to run.
For current Codex behavior, doctor also accepts fresh `.harness/pretool-observations.jsonl` evidence
as a stronger fallback when `UserPromptSubmit` banner evidence is missing. That reflects a real
project-local hook execution path, even if `entry-banner.json` was not emitted.

## Current evidence boundary

In the current validation environment (`codex-cli 0.137.0`), a minimal `codex exec` run can finish without any hook failure marker, but the project sentinel hook injected by `tests/codex-smoke.sh` does not execute. That means the live smoke result is `DEGRADED`: it proves the runtime can start and did not report hook failures, but it does not prove `.codex/hooks.json` commands actually ran.

A stricter real-world check was also run in a fresh target project via a real macOS Terminal window. In that run, Codex did visibly trigger the project-local `$harness-init` skill, wrote the target-project files, and eventually completed `.claude/settings.json`, `CLAUDE.md`, `AGENTS.md`, and `.codex/hooks.json`. The temporary “same observation window still missing artifacts” result was caused by a real approval gate when Codex tried to write into project `.codex/`; after approving that prompt, the same live session finished its init validation with required-file, JSON-parse, canonical-hook, and placeholder checks all `PASS`.

A follow-up fresh Codex session was then run in that target project with `$harness-start`. That session emitted `.harness/entry-banner.json`, `.harness/pretool-observations.jsonl`, `.harness/observations.jsonl`, and `.harness/session-log.md`, hit the `PreToolUse` stage guard until `.harness/iteration-spec.json` was made sufficient, then completed a minimal real development task (`sum.js`, `tests/sum.test.js`, `package.json`) and ran `npm test` with `pass 3 / fail 0`.

So the current evidence is split:

- `codex exec` smoke remains `DEGRADED` and is not release-ready hook evidence.
- real target-project `$harness-init` artifact generation is `PASS` after runtime approval.
- fresh hook-loaded target-project `$harness-start` workflow is `PASS` for the minimal task recorded in `evidence.md`.

Release gates must not treat that degraded live result as runtime `PASS`. For release-ready enforcement, run:

```bash
CODEX_REQUIRED=1 bash tests/codex-smoke-selftest.sh
```

If the sentinel hook is not executed in required mode, the selftest fails. `tests/scripts/11-codex-smoke-contract.sh` uses a fake Codex binary only to validate the smoke scripts' exit-code and message contracts; it is replacement evidence for script classification behavior, not evidence that real Codex executed project hooks.

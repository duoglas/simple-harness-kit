# Codex runtime smoke

Use `bash tests/codex-smoke.sh` for Codex runtime compatibility. For real enforcement health in an interactive session, run:

```bash
node scripts/shk.js doctor
```

Doctor checks whether Bash PostToolUse observations exist without matching PreToolUse stage-guard observations.

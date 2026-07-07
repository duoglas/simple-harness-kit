# Claude Code Runtime Smoke Evidence

Claude Code is the primary SHK hook target. Acceptance evidence must include real target-project sessions, not only fixture scripts or `shk.js` probes.

## 2026-06-18 Target-Project Init Attempt

Target project:

```text
/Users/duoglas/ops/tmp-claude-shk-acceptance-2
```

Install command run in the target project:

```bash
bash /Users/duoglas/simple-harness-kit/install.sh --target claude --scope project
```

Real Claude Code command:

```bash
claude -p \
  --add-dir /Users/duoglas/simple-harness-kit \
  --permission-mode bypassPermissions \
  --output-format stream-json \
  --include-hook-events \
  --max-budget-usd 0.5 \
  "/harness-init 请为当前项目初始化 harness。kit 路径使用 /Users/duoglas/simple-harness-kit。完成后给出创建文件与验证结果。"
```

Observed real behavior:

- Claude Code entered `/harness-init`.
- Stream JSON showed real `Read`, `Bash`, and `Write` tool activity against the target project and kit resources.
- Claude wrote `.claude/settings.json`, `.claude/rules/*.md`, `docs/constraints.md`, `CLAUDE.md`, and a partial `scripts/hooks/` set.
- The copied hook set followed the old 6-hook shape and did not include `scripts/lib/spec-quality.js` before settings became active.
- Subsequent hook events failed with `Error: Cannot find module '../lib/spec-quality'`.
- The require stack pointed at `scripts/hooks/harness-stage-guard.js`.
- The session ended with `subtype: error_max_budget_usd` after reaching the configured `$0.5` cap.

Conclusion:

- Claude Code real target-project init is currently `FAIL/BLOCKED` for this PR state.
- This is not a script-only failure; it was observed in a real Claude Code agent session.
- The blocker is init ordering: required hook/lib files must be copied before `.claude/settings.json` is written, because Claude Code may load the new settings during the same session.
- This evidence must not be reported as Claude Code workflow PASS until a fresh run completes init and a follow-up hook-loaded `$harness-start` task in a target project.

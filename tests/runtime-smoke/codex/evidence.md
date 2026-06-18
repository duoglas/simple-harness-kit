# Codex Runtime Smoke Evidence

Date: 2026-06-18

## Commands

```bash
codex --version
bash tests/codex-smoke.sh
CODEX_REQUIRED=1 bash tests/codex-smoke-selftest.sh
bash tests/scripts/11-codex-smoke-contract.sh
node tests/quality-suite.test.js
npm test
```

## Codex Prompt Runs

These runs were executed from the real repo root `/Users/duoglas/simple-harness-kit`, not from a fake fixture.

### Non-interactive `codex exec`

Prompt:

```text
reply with ok
```

Observed result:

- Codex version observed in this round: `OpenAI Codex v0.140.0`
- final assistant output: `ok`
- project-local `PreToolUse` evidence did **not** refresh
- `.harness/entry-banner.json` was **not** emitted
- conclusion: `exec` can complete successfully, but this run does not prove `.codex/hooks.json` commands executed

Prompt:

```text
Run bash command: printf SMOKE_<token>. Then reply with ok.
```

Observed result:

- Codex executed the requested Bash command and replied `ok`
- `pretool-observations.jsonl` line count did **not** increase
- conclusion: even with a real tool-use prompt, this `exec` path still did not yield fresh project-hook runtime evidence

### Interactive Codex TTY experiments

Prompt sent after TTY startup:

```text
请只回复 ok
```

Observed result:

- Codex session reached the TTY UI and produced normal model output
- `.harness/entry-banner.json` was **not** emitted
- no fresh `.harness/pretool-observations.jsonl` entry was written

Prompt sent after TTY startup:

```text
Run bash command: printf TTY_READY_TOKEN
```

Observed result:

- prompt was accepted by the interactive session
- `.harness/entry-banner.json` was **not** emitted
- no fresh `.harness/pretool-observations.jsonl` entry was written

Prompt sent with hook-trust bypass enabled:

```text
Run bash command: printf TTY_BYPASS_TOKEN
```

Observed result:

- interactive Codex printed the expected warning/UI text
- `.harness/entry-banner.json` was still **not** emitted
- no fresh `.harness/pretool-observations.jsonl` entry was written

## Agent-driven Harness init in a target project

This round used a concrete target project, not the kit repo itself:

- target project: `/Users/duoglas/ops/tmp-agent-os-terminal-app`
- SHK install command run in a real macOS Terminal window:

```bash
bash /Users/duoglas/simple-harness-kit/install.sh --target codex --scope project
```

- during install, Terminal showed the alias prompt:

```text
添加到 /Users/duoglas/.zshrc? [Y]es / [n]o / [s]kip silently:
```

- response used in the same Terminal session: `n`

Then a real Codex TUI session was launched from that same Terminal window with an initial prompt:

```bash
codex --enable hooks --sandbox workspace-write --ask-for-approval on-request --no-alt-screen \
  '$harness-init 请为当前项目初始化 harness。kit 路径使用 /Users/duoglas/simple-harness-kit；检测到 Codex 后生成 .codex/hooks.json；完成后给出创建文件与验证结果。'
```

Observed Terminal output:

- Codex echoed the exact `$harness-init ...` prompt in the live TUI
- Codex stated: `使用 using-superpowers 和 harness-init`
- Codex then showed read-phase activity such as:
  - `Read SKILL.md (harness-init skill)`
  - `Read SKILL.md (using-superpowers skill)`
- Codex then showed write-phase activity in the same live TUI:
  - `Ran mkdir -p .claude/rules .codex scripts/hooks scripts/lib docs .harness`
  - `Ran cp ... scripts/hooks/...`
  - `Ran cp ... scripts/lib/spec-quality.js`
  - `Ran cp ... templates/constraints.md.tmpl docs/constraints.md`
  - `Ran cp ... templates/rules/... .claude/rules/...`

Observed filesystem state during that same Terminal-driven session:

- created early in the same session:
  - `.claude/rules/role-constraints.md`
  - `.claude/rules/qa-standards.md`
  - `.claude/rules/feedback-workflow.md`
  - `.claude/rules/harness-entry.md`
  - `docs/constraints.md`
  - required `scripts/hooks/*.js`
  - `scripts/lib/spec-quality.js`
- created later in the same session:
  - `.claude/settings.json`
  - `CLAUDE.md`
  - `AGENTS.md`
- `.codex/hooks.json` did **not** appear at the first observation point because Codex hit a real approval gate when writing into project `.codex/`

Root cause and continuation observed in the same real run:

- Codex ran:

```bash
node /Users/duoglas/simple-harness-kit/scripts/generate-codex-hooks.js --input .claude/settings.json --output .codex/hooks.json
```

- Codex then reported:
  - `EPERM: operation not permitted, open '.codex/hooks.json'`
  - `touch: cannot touch '.codex/test-write.tmp': Operation not permitted`
- the live TUI showed an approval prompt to allow that write
- after approving that exact prompt in the same Terminal window, `.codex/hooks.json` was created successfully

Final state reported by that same live Codex session:

- required file existence: `PASS`
- `.claude/settings.json` JSON parse: `PASS`
- `.codex/hooks.json` JSON parse: `PASS`
- settings-referenced hook scripts exist: `PASS`
- hook local `require()` dependencies exist: `PASS`
- Codex canonical hook checks: `PASS`
- `CLAUDE.md` size check: `PASS`
- template placeholder residue check: `PASS`

Conclusion for this agent-driven run:

- this is real OS-controlled Terminal usage of Codex, not a fake fixture and not a hand-driven `shk.js` command sequence
- project-local skill triggering is proven: Codex visibly entered `using-superpowers` + `harness-init`
- project-local file writes are proven end-to-end, including the eventually approved `.codex/hooks.json` write
- the earlier “same observation window still missing four artifacts” result was a timing artifact caused by a real `.codex/` approval gate, not by `harness-init` failing to generate them
- this round therefore proves **real Codex target-project init can complete**, but it still does **not** prove a full SHK workflow acceptance PASS, because the session itself says a **new session** is required before the newly generated hooks can actually load and be exercised

## Fresh hook-loaded Codex workflow in the target project

A follow-up fresh Codex session was started in the same target project after init artifacts existed:

- target project: `/Users/duoglas/ops/tmp-agent-os-terminal-app`
- Codex launch:

```bash
codex --enable hooks --sandbox workspace-write --ask-for-approval on-request --no-alt-screen
```

Initial prompt submitted inside Codex:

```text
$harness-start 请在这个项目里完成一个最小但真实的需求开发：新增 sum.js，导出 sum(a, b)；新增 tests/sum.test.js，使用 node:test 验证至少 3 个用例；把 package.json 的 npm test 改成 node --test；运行测试；最后给出 VERIFICATION REPORT，并明确说明你实际创建了哪些文件、跑了什么命令、得到什么结果。
```

The first implementation attempt was blocked by the harness stage guard because `.harness/iteration-spec.json` did not yet satisfy the required schema. A steering prompt was then submitted:

```text
Update .harness/iteration-spec.json to satisfy the stage guard first: add explicit edge/negative coverage in test_plan, add acceptance ids plus evidence/test mappings, then continue with implementation, run npm test, and finish with a VERIFICATION REPORT.
```

Runtime evidence written during that fresh session:

- `.harness/current-stage.json`
- `.harness/entry-banner.json`
- `.harness/tool-count.json`
- `.harness/observations.jsonl`
- `.harness/pretool-observations.jsonl`
- `.harness/session-log.md`

Stage observed after implementation and verification:

```json
{"stage":"REVIEW","since":"2026-06-18T01:30:30.000Z","task":"summarize verification evidence and delivery status"}
```

Files created or changed by Codex in the target project:

- `sum.js`
- `tests/sum.test.js`
- `package.json`

Implementation delivered:

```js
function sum(a, b) {
  return a + b;
}

module.exports = { sum };
```

Test coverage delivered:

- positive integer addition
- negative plus positive number
- decimal addition

Commands observed in the Codex session included:

```bash
pwd
rg --files
git status --short
sed -n '1,220p' package.json
sed -n '1,260p' .harness/iteration-spec.json
sed -n '1,260p' scripts/lib/spec-quality.js
sed -n '1,220p' sum.js
sed -n '1,220p' tests/sum.test.js
npm test
```

Final test evidence:

```text
npm test
node --test
pass 3
fail 0
```

The target project's `.harness/session-log.md` records:

```text
命令: npm test
结果: node --test 执行 3 条用例，pass 3，fail 0。
```

Conclusion for this follow-up run:

- `init artifact pass`: PASS
- `fresh hook-loaded runtime pass`: PASS
- `real workflow pass`: PASS for this minimal target-project task
- `codex exec` smoke remains DEGRADED and must not be promoted to hook runtime PASS

## Output Summary

- `bash tests/codex-smoke.sh` -> exit 0, `DEGRADED: project .codex/hooks.json command 未被 exec 模式验证`
- `CODEX_REQUIRED=1 bash tests/codex-smoke-selftest.sh` -> exit 1, `FAIL: 当前 Codex exec 未执行 project sentinel hook；bad-hook 捕获能力未被验证`
- `bash tests/scripts/11-codex-smoke-contract.sh` -> PASS
- `node tests/quality-suite.test.js` -> `61/61 quality suite tests passed`
- real macOS Terminal + Codex + `$harness-init` target-project run -> `PASS for init artifact generation after approval`; `not yet PASS for full SHK workflow acceptance`
- fresh Codex target-project `$harness-start` run -> `PASS for hook-loaded minimal workflow`; `npm test` passed with `pass 3 / fail 0`

## Acceptance boundary

For SHK acceptance, the user-defined bar is stricter than smoke/doctor/quality-suite evidence:

- acceptance must happen in a **real project directory**
- acceptance must be done through **real agent-driven Claude Code / Codex usage**
- the workflow must be the real SHK usage form: skill / hook entry and task delivery, not hand-driven `shk.js` probing

Against that bar, the current Codex evidence is now split:

- `codex exec` smoke is still only runtime compatibility evidence
- the Terminal-driven `$harness-init` round now proves real target-project init artifact generation, including `.codex/hooks.json` after approval
- the follow-up fresh Codex `$harness-start` round proves a hook-loaded target-project workflow for a minimal real task
- this file still does not claim that `codex exec` is a valid substitute for interactive hook-loaded workflow evidence

## Interpretation

The tested Codex runtime can answer prompts and execute requested commands. The current live evidence now shows:

- `codex exec` remains insufficient to prove project-local hooks ran
- a real macOS Terminal Codex session can complete target-project `harness-init`, including `.claude/settings.json`, `CLAUDE.md`, `AGENTS.md`, and `.codex/hooks.json`, once the runtime approval gate for writing `.codex/` is granted
- a fresh post-init Codex session can load the harness runtime, enforce the stage guard, complete a minimal development task, and pass its target-project tests

What the current evidence still does **not** show is reliable project-local hook execution in:

- `codex exec`

That is why the runtime conclusion remains intentionally constrained:

- `exec`-based smoke remains `DEGRADED`
- selftest correctly fails in required mode
- contract tests only prove the shell-script classification logic
- real Terminal-driven agent usage now proves skill entry, complete target-project init artifact generation, and one fresh hook-loaded target-project workflow

This is also why `doctor` was tightened in this PR:

- exact repo-root trust in `~/.codex/config.toml` is surfaced explicitly
- recent `PreToolUse` evidence is accepted when present
- missing `entry-banner.json` alone is no longer treated as the only live signal

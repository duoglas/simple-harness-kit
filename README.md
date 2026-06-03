# Simple Harness Kit

**[中文文档](README.zh-CN.md)**

A portable, tool-agnostic **Harness Engineering** methodology + template repo.

> "Don't ask which model is smarter. Ask whose execution system is more reliable."

### The Problem

| Pain Point | Solution |
|-----------|---------|
| Rule drift in long conversations | Hook enforcement (100% tool-level interception) |
| Unstable code quality | 5-Layer QA Pyramid (AI does 4 layers, humans do final review) |
| No knowledge accumulation | Constraint ID tracing + F1-F5 feedback loops |
| Blind to actual behavior | Continuous learning (auto-captures patterns, improvement suggestions) |

### Quick Start

**Step 1: Install Skills (one command)**

```bash
git clone https://github.com/duoglas/simple-harness-kit.git ~/simple-harness-kit
bash ~/simple-harness-kit/install.sh
```

`install.sh` will:
- Install skills to `~/.claude/skills/` and/or `~/.codex/skills/` (auto-detect, or `--target claude|codex|both`)
- Write `~/.simple-harness-kit-root` so `harness-init` can auto-locate the kit later
- (Codex only) Ask if you want `alias codex='codex --enable hooks --sandbox workspace-write --ask-for-approval on-request'` written to `~/.zshrc` / `~/.bashrc` — recommended; enables hooks and uses the current explicit sandbox/approval flags

Update: `git -C ~/simple-harness-kit pull && bash ~/simple-harness-kit/install.sh`

**Step 2: Initialize Harness for your project (once per project)**

Enter your project directory, then:

```bash
# Claude Code:
claude              # start TUI
# then in TUI:
/harness-init

# Codex (must be TUI mode — exec/non-interactive deadlocks at kit lookup):
codex               # if you accepted the alias in Step 1, this is enough
# OR if no alias:
codex --enable hooks --sandbox workspace-write --ask-for-approval on-request
# then in TUI:
$harness-init       # NOTE: $ not / — Codex skill trigger sigil is $
```

Or paste this prompt directly (works in both, no skill needed):

```
Read ~/simple-harness-kit/init-prompt.md and the methodology/ directory.
Initialize Harness for this project.

Required steps:
1. Auto-scan project structure (package.json/directories/existing config), detect tech stack automatically — don't ask me for info
2. Generate ALL mandatory components (marked in init-prompt.md):
   - 8 hook scripts: harness-stage-guard.js, harness-session-start.js, harness-entry-banner.js, session-logger.js, safety-guard.js, find-root.js, session-end.js, stage-since-autofill.js
   - 4 rules: role-constraints.md, qa-standards.md, feedback-workflow.md, harness-entry.md
   - settings.json (use minimum config from init-prompt.md, register all mandatory hooks)
   - docs/constraints.md, CLAUDE.md
3. Select optional components based on project needs (must explain why for any skipped)
4. Copy all hook scripts from ~/simple-harness-kit/scripts/hooks/ — do NOT write from scratch
5. Output completeness checklist (OK/MISSING for each mandatory component)
6. Fix any MISSING items immediately
7. Remind me: hooks take effect in the NEXT session, I need to start a new one
```

> **Important:** You must start a new session after init. Hooks don't take effect in the current session.

**Step 3: Daily usage**

After starting a new session, Harness takes over automatically (hooks drive the 6-Stage Loop). Two options:

Option A — Skill (recommended, interactive):
```
/harness-start          # Claude Code
$harness-start          # Codex (note the $ sigil)
```
The skill asks for your feature description and automatically includes all constraints (PLAN pause, VERIFY evidence, delivery checklist).

Option B — Manual:
```
Follow Harness 6-Stage Loop. PLAN pause for my confirmation, VERIFY needs quantitative evidence, answer delivery checklist before presenting results.
Feature: implement XXX
```

**Handling feedback:**

```
/harness-feedback       # Claude Code
$harness-feedback       # Codex
```

The skill asks for the issue and expected behavior, then runs F1-F5 automatically. Or manually: `[Harness Feedback] Issue: XXX Expected: YYY`.

### Core Mechanisms

- **6-Stage Loop:** Plan → Setup → Execute → Verify → Review → Feedback (loops until quality gates pass)
- **5-Layer QA Pyramid:** TDD self-verify → Tool checks (build/lint/test) → Spec review (independent reviewer) → Santa Method (dual adversarial) → Human review
- **Hook enforcement:** core hooks + optional/helper scripts cover stage guard, safety, verification, commit, delivery, learning, session logging, branch policy, and Codex compatibility — fire at 100% reliability regardless of context length
- **Continuous Learning:** Auto-captures tool usage patterns (<50ms, no overhead), analyzes at each REVIEW stage. Pure local analysis, zero API calls. Discovers workflow habits, hot files needing tests, stable patterns to promote to Rules (token savings)
- **Quality Gate Suite:** `scripts/shk.js` provides `verify` for structured evidence, `doctor` for stage/evidence/hook-enforce health, `security scan` for secrets/leak/config risk, `test-infra assess` for Infra Tier, profile dry-run/repair, and `e2e detect` for E2E quickstart. `verification-gate.js` reads `.harness/verify-evidence.json` first and requires `overall=READY` before commit/tag gates pass.

### Preset System (v0.9.0)

Commit format and branch policy are **data-driven** — different companies / teams / projects often need different rules (TICKET-ID prefixes, protected branches, no `feat` on `release-*` etc.). Instead of forking the kit and rewriting hooks, drop a preset config.

**Zero config = zero behavior change.** Default fallback to `generic` is silent and back-compatible — existing users upgrading from v0.8.x see no new warnings.

**Built-in presets:**
- `presets/generic/` — default, equivalent to Conventional Commits + Co-Authored-By
- `presets/example-company/` — public scaffold demonstrating TICKET-ID prefix + protected branches + single-release constraint + feat-on-release block. Copy and rename to author your own.

**Opt-in to a non-default preset:**

```bash
cp .harness.local.example.json .harness.local.json
# edit "preset" field, e.g. "example-company" or your own
```

Or env override for one-shot: `HARNESS_PRESET=example-company`.

**What gets enforced:**
- `commit-check` warns when subject doesn't match active preset's `subject_regex`
- `branch-policy-guard` blocks `git push` to `merge_only_branches`, blocks `--all`/`--mirror` when protected branches exist, blocks commit types listed in `type_blocked_on_branch` (e.g. `feat` on `release-*`)
- `HARNESS_SKIP_GATE=1` bypasses for one-off emergency

Full reference: [methodology/19-company-presets.md](methodology/19-company-presets.md)

### Real-World Validation

| Experiment | Project | Type | Tests | Loops | Key Finding |
|-----------|---------|------|-------|-------|------------|
| **A** | [json-2-csv](https://github.com/mrodrig/json-2-csv) (459 stars) | TS library | TDD + 6 unit tests | 1 | Independent reviewer caught interaction bug missed by implementer |
| **B** | [Fyrre Magazine](https://github.com/asbhogal/Fyrre-Magazine) | Next.js frontend | 14 Playwright E2E + axe a11y | 3 | Santa Method dual reviewers found 8 deep issues (aria-live, React key, unused components...) |
| **C** | [Planka](https://github.com/plankanban/planka) (11.5k stars) | Full-stack (Sails.js + React) | 7 API E2E + Playwright UI | 1 | Claude Code vs Codex comparison: independent reviewer is the core value; prompt quality determines output |

13 methodology corrections (M1-M13) produced across all experiments, all fed back into this repo.

**Experiment B — feature delivery:**

| Initial state | Search filtering |
|---------|---------|
| ![Initial](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-1-top.png) | ![Search](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-2-search-secret.png) |

| Category filter | Search + filter combo |
|---------|-------------|
| ![Filter](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-3-sculptures.png) | ![Combo](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-4-combo.png) |

| Empty state | Mobile responsive |
|--------|-----------|
| ![Empty](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-5-empty-state.png) | ![Mobile](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-6-mobile.png) |

> Details: [examples/experiment-a/](examples/experiment-a/) | [examples/experiment-b/](examples/experiment-b/) | [examples/experiment-c-planka/](examples/experiment-c-planka/)

### Selection Rationale

We surveyed three layers: **agent frameworks** (DeerFlow/LangGraph/CrewAI — build agent platforms, need Python deployment), **coding tools** (Claude Code/Codex/Gemini/Cursor — all support hooks now except Windsurf), and **methodology systems** (ECC Superpowers/Ralphinho/OpenAI Harness Eng. — good skills but no unified loop). We chose **high constraint strength + low setup cost**: hooks guarantee enforcement, pure docs guarantee zero deployment. See [methodology/01-comparison.md](methodology/01-comparison.md) for full analysis.

### Tool Compatibility

> Experiments A/B/C verified on **Claude Code**. Experiment C also verified on **Codex CLI**. Codex cross-compatibility testing (hooks.json format, stdin JSON, exit 2 blocking protocol) independently verified. Other tools analyzed from docs, not yet tested.

| Tool | Hook Support | Status |
|------|-------------|--------|
| **Claude Code** | Native PreToolUse/PostToolUse | **Verified** (Exp A/B/C) |
| **Codex CLI** | Native hooks (`hooks` flag required) | **Verified** (Exp C + cross-test) |
| **Gemini CLI** | v0.26+ BeforeTool/AfterTool | Untested |
| **Cursor** | v1.7+ hooks | Untested |
| **OpenCode** | Plugin API (needs rewrite) | Untested |
| **Windsurf** | Audit only, no block | **Not supported** |

### Environment Variables

| Variable | Value | Effect |
|----------|-------|--------|
| `HARNESS_LOG` | `off` | Disable session-log recording |
| `HARNESS_AUTO` | `full` | Full auto, no PLAN pause |
| `HARNESS_AUTO` | `off` | Pause at every stage |
| `HARNESS_LEARN` | `off` | Disable observations.jsonl |
| `HARNESS_ATTRIBUTION` | `off` | Don't add "Harnessed by" to README |

### Repo Structure

```
simple-harness-kit/
├── methodology/   22 methodology docs
├── presets/       2 built-in (generic + example-company), data-driven commit & branch rules
├── templates/     11 templates
├── scripts/hooks/ 16 hook/helper scripts
├── skills/        11 skills (init user-triggered | rest AI-auto)
├── examples/      3 real-world experiments (A + B + C)
├── tests/         170 hook scenarios + template integrity + scripted matrix + codex smoke
└── init-prompt.md initialization prompt
```

### License

MIT

---

Harnessed by [Simple Harness Kit](https://github.com/duoglas/simple-harness-kit)

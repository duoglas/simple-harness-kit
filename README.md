# Simple Harness Kit

**[中文文档](README.zh-CN.md)**

Simple Harness Kit (SHK) is an **AI engineering harness** for Claude Code, Codex, and other hook-capable coding agents.

It is not a JavaScript SDK you import into your app. You install it into a software project so the AI working in that project has a repeatable delivery system: write a short spec, choose or generate meaningful tests, verify the evidence, loop on failures, and stop before unsafe delivery.

> Do not ask which model is smarter. Ask whether the workflow can prove the change is safe.

## What SHK fixes

| Without SHK | What usually happens | With SHK |
|---|---|---|
| Long AI sessions lose rules | The agent starts careful, then skips steps later | Hooks keep enforcing the same stage rules |
| “Tests passed” is too weak | A smoke script or `echo ok` looks green | E2E must prove the changed path, not just exit 0 |
| No clear spec | Requirements, risks, and acceptance drift during the chat | Each medium/high/release task starts from an iteration spec |
| Failed tests stall progress | The agent retries randomly or changes too much | A bounded repair loop fixes one failure at a time |
| Delivery is based on trust | “I ran it” becomes oral history | `verify` writes fresh, structured evidence |
| Lessons disappear | Same mistake shows up in the next task | Feedback becomes constraints and regression checks |

## The user experience

After SHK is initialized in a target project, you keep working inside Claude Code or Codex as usual:

```text
Implement checkout coupon support.
```

The harness changes what the AI must do before it can claim the work is done:

1. **Classify risk** — low, medium, high, or release.
2. **Write or read the iteration spec** — requirement, approach, risks, traffic paths, test plan, acceptance.
3. **Find the project’s test surface** — unit, integration, API, browser E2E, upstream CI.
4. **Generate missing tests when needed** — for example the first Playwright or API E2E in a new app.
5. **Run the smallest useful checks first** — then widen only when needed.
6. **Assess test effectiveness** — did the tests cover the changed business path, assertions, negative path, and mutation/fault evidence?
7. **Loop on failures** — at most 3 repair rounds, one failure point per round.
8. **Report in plain language** — what is proven, what is still missing, and what happens next.

A good SHK report should read like this:

```text
I cannot hand this off yet.

The new order creation path is not covered by an E2E or API-level acceptance test.
The current checks only prove that the service starts and /health responds.
They do not prove that POST /orders creates an order, rejects invalid input, or fails when the order logic is broken.

Next I will add one positive order creation test and one invalid-order blocking test, then rerun the smallest API E2E.
Machine state: NOT_SUFFICIENT
```

The machine state is still useful for hooks, but the user-facing report should explain the engineering reason first.

## Quick start

### 1. Install SHK once

```bash
git clone https://github.com/duoglas/simple-harness-kit.git ~/simple-harness-kit
bash ~/simple-harness-kit/install.sh
```

`install.sh` will:

- install skills into `~/.claude/skills/` and/or `~/.codex/skills/`;
- write `~/.simple-harness-kit-root` so project init can find the kit later;
- optionally add a Codex alias with the current explicit hook/sandbox/approval flags.

Update later:

```bash
git -C ~/simple-harness-kit pull
bash ~/simple-harness-kit/install.sh
```

### 2. Initialize each project once

In the target project:

```bash
# Claude Code
claude
/harness-init

# Codex: use TUI mode, not codex exec
codex --enable hooks --sandbox workspace-write --ask-for-approval on-request
$harness-init
```

Or paste the init prompt directly:

```text
Read ~/simple-harness-kit/init-prompt.md and the methodology/ directory.
Initialize Harness for this project.
Copy hook scripts from the kit. Do not rewrite them from scratch.
Generate the required rules, settings, docs/constraints.md, and project guide.
Print a completeness checklist and fix any missing required item.
Remind me that hooks take effect in the next session.
```

Start a new AI session after initialization. Hooks do not affect the session that created them.

### 3. Use the harness every day

```text
/harness-start     # Claude Code
$harness-start     # Codex
```

Then describe the task. For feedback or review findings:

```text
/harness-feedback  # Claude Code
$harness-feedback  # Codex
```

## How SHK decides whether a change can ship

SHK uses the 6-stage loop:

```text
PLAN → SETUP → EXECUTE → VERIFY → REVIEW → FEEDBACK
```

For real code changes, the important question is not “did a command pass?” It is “what did the tests prove?”

### Evidence levels

| State | Meaning |
|---|---|
| `READY` | The required checks ran, the evidence is fresh, and the tests cover the relevant spec/risk paths. |
| `NOT_READY` | Something required is missing, failed, stale, or degraded. |
| `NOT_SUFFICIENT` | A command passed, but it did not prove the change is safe. Fake E2E, smoke-only checks, no assertions, uncovered traffic, or no mutation/fault evidence land here. |

### What counts as an effective E2E

For medium/high/release work, SHK expects more than a browser opening a page or an API returning 200:

- a spec that names the requirement, risk, traffic path, and acceptance evidence;
- a real positive path;
- a real negative or blocking path;
- assertions that would fail if the behavior changed;
- structured evidence written during this run, not a stale file;
- mutation or fault evidence showing that broken critical behavior is caught;
- clear reporting when runtime evidence is degraded.

If the key logic is broken and the test still passes, the test is not effective.

## Phase 2: Quality Engineering Gate

Phase 2 is SHK’s shift from “AI should run tests” to “AI must produce measurable, reviewable, and improvable delivery evidence.” In practice, that means spec-driven work, test generation, test effectiveness checks, and delivery gates that block weak proof. The AI should generate or select meaningful tests instead of asking users to memorize backend commands.

It adds four practical behaviors inside the AI workflow:

1. **Spec-driven work** — medium/high/release tasks depend on `.harness/iteration-spec.json` before implementation.
2. **Test generation for target apps** — when a target project has no E2E, the AI must bootstrap one instead of merely reporting the gap.
3. **E2E sufficiency and test effectiveness** — `verify` aggregates spec status, E2E proof strength, test effectiveness, security, diff, and runtime status.
4. **Bounded repair loop** — failures and insufficient proof trigger up to 3 focused repair rounds; no auto-push, auto-tag, or unsafe reset.

Read more:

- [Quality Engineering Gate](docs/quality-engineering-gate.md)
- [Phase 2 docs](docs/phase2-quality-gate/README.md)
- [v0.11.0 draft release notes](docs/release-notes/v0.11.0.md)

## Quality Gate Suite

The CLI under `scripts/shk.js` is mainly a backend for AI skills and hooks. Users can run it manually, but the intended path is that Claude Code or Codex calls it during VERIFY.

Useful backend probes include:

```bash
node scripts/shk.js verify --risk medium --write-evidence
node scripts/shk.js spec status --format json
node scripts/shk.js e2e inspect --format json
node scripts/shk.js e2e bootstrap --risk medium --format json
node scripts/shk.js e2e assess --risk medium --format json
node scripts/shk.js test effectiveness --risk medium --format json
node scripts/shk.js security scan
```

`verify` writes `.harness/verify-evidence.json` and a human-readable report. Commit/tag hooks read that evidence before allowing delivery-sensitive actions.

## Presets for teams

Commit format and branch policy are data-driven. The built-in presets are:

- `presets/generic/` — default Conventional Commits + Co-Authored-By behavior;
- `presets/example-company/` — public example for ticket prefixes, protected branches, and release constraints.

Opt in per project with `.harness.local.json` or `HARNESS_PRESET=...`. Zero config means zero behavior change for older projects.

See [methodology/19-company-presets.md](methodology/19-company-presets.md).

## Real-world validation

SHK was originally shaped through public project experiments:

| Experiment | Project | What it showed |
|---|---|---|
| A | [json-2-csv](https://github.com/mrodrig/json-2-csv) | Independent review caught a data interaction bug missed during implementation. |
| B | [Fyrre Magazine](https://github.com/asbhogal/Fyrre-Magazine) | Browser E2E + accessibility checks needed multiple feedback loops before handoff. |
| C | [Planka](https://github.com/plankanban/planka) | Tool choice mattered less than having review, evidence, and loop discipline. |

Phase 2 adds dogfood checks against temporary copies of real OSS projects, including TodoMVC browser flows and an Express API service. Those checks must pass on normal behavior and fail after targeted mutation.

## Tool support

| Tool | Status |
|---|---|
| Claude Code | Primary supported path through skills and hooks. |
| Codex | Supported through TUI skills and hook configuration; runtime smoke may still be degraded in some environments. |
| Gemini CLI / Cursor / OpenCode | Analyzed for compatibility; not the primary verified path yet. |
| Windsurf | Audit-only hooks are not enough for SHK’s blocking gate model. |

## Known limits

- Codex `exec` runtime smoke can still be `DEGRADED` in some environments because project hook execution is not fully proven. SHK must report that honestly and must not count it as runtime PASS for release readiness.
- SHK improves process discipline; it does not replace human product judgment or final review.
- Phase 2 sufficiency checks intentionally start with practical engineering signals: spec mapping, structured evidence, assertions, positive/negative paths, and mutation/fault proof. They are not a full formal coverage proof.

## Repository map

```text
simple-harness-kit/
├── methodology/                engineering method docs
├── docs/                       constraints, release process, Phase 2 docs
├── skills/                     Claude Code / Codex skills
├── scripts/hooks/              stage, safety, verification, delivery hooks
├── scripts/shk.js              backend probes used by skills/hooks
├── templates/                  project guide templates
├── presets/                    commit and branch policy presets
├── examples/                   public validation experiments
└── tests/                      hook scenarios, integrity tests, dogfood scripts
```

## License

MIT

---

Harnessed by [Simple Harness Kit](https://github.com/duoglas/simple-harness-kit)

# 2026-06-16 Experience Backfeed Map

This map records which lessons from the source project were generalized into SHK and which were rejected as project-specific. The goal is to improve generic harness behavior without importing application defaults.

## Minimal Landing Points

| Lesson | Source | Classification | SHK landing point | Decision |
|---|---|---|---|---|
| External/runtime assumptions need a probe before execution. | `docs/verification-report.md`, `.harness/iteration-spec.json` | generic | `methodology/03-workflow.md`, `skills/harness-start/SKILL.md` | Migrate as PLAN/SETUP discipline. |
| Each work item needs objective done evidence. | `.harness/iteration-spec.json` tasks | generic | `scripts/lib/spec-quality.js`, `docs/phase2-quality-gate/02-iteration-spec-template.md` | Migrate into spec gate and template. |
| Each task should carry one primary risk. | `.harness/iteration-spec.json` tasks | generic | `scripts/lib/spec-quality.js`, `templates/rules/harness-entry.md.tmpl` | Migrate as task quality check. |
| Irreversible actions need explicit human confirmation. | `.harness/iteration-spec.json` irreversible actions | generic | `scripts/lib/spec-quality.js`, `skills/auto-harness-review/SKILL.md` | Migrate as required spec section and review checklist item. |
| Negative and boundary cases must be declared, not inferred. | `.harness/iteration-spec.json` test plan | generic | Existing gate plus `skills/auto-harness-qa/SKILL.md` | Keep and reinforce in skill text. |
| Mixed old/new compatibility evidence belongs in VERIFY. | `merged/check.sh`, `merged/tests/` | generic | `skills/auto-harness-qa/SKILL.md`, tests | Migrate as QA wording and positive compatibility tests. |
| Independent review catches author-bias in high-risk changes. | `docs/constraints.md` C-HARNESS-03 | generic | `templates/rules/qa-standards.md.tmpl`, `skills/auto-harness-review/SKILL.md` | Keep as generic review rule. |
| Long sessions degrade and need explicit continuation boundaries. | `docs/constraints.md` C-CTX-01 | generic | `methodology/03-workflow.md` | Migrate as planning guidance, not a hard runtime default. |
| Hot-path work must be separated from heavy work. | `docs/constraints.md` C-PERF-* | generic pattern | Rejected for default SHK template; keep as domain-specific example only. | Do not add app-specific performance defaults. |
| Device, platform, root, and messaging-app operations need real-device verification. | `docs/constraints.md` C-PLUGIN/C-DEVICE/C-SEC | project_specific | Rejected for SHK defaults. | Keep out of templates and generic skills. |

## Gate Decision

W6 result: W7 is needed. Existing spec status already checked requirements, design, risk points, traffic flows, test plan, and acceptance, but did not require `tasks` or `irreversible_actions`. The minimal gate enhancement is limited to these sections and per-task quality: `id`, `stage`, `title`, `covers`, one non-mixed `risk`, and objective `done`.

Backward compatibility proof: existing valid spec fixtures keep their prior coverage semantics after adding the two new generic sections, while new negative fixtures prove hollow task plans and missing irreversible-action inventories are rejected.

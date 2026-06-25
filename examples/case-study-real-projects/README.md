# Case Study: SHK in Two Real Projects

Two real projects, same person, same AI tools — one without SHK, one with.

> [View the slides (HTML)](slides.html) — download and open in browser, or use GitHub Pages.

## Projects

| | Project A: Team Assessment | Project B: Device Plugin |
|---|---|---|
| Domain | 60+ person capability evaluation | Mobile hook plugin, real-device adb deploy |
| Stack | Python scripts + AI modeling + HTML reports | BeanShell + adb + Magisk |
| Duration | 3 weeks (5 rounds without SHK, 1 round with) | 10 days (all with SHK) |
| Operator | 1 person + AI | 1 person + AI |

## Key Results

### Project A — Before/After Contrast

The same project ran multiple rounds without SHK, then one round with SHK.

**Without SHK (5 rounds, 3 weeks):**
- 5-10 dialogue rounds per task, 17% of messages were corrections
- 3-4 versions per deliverable (v617 → v618 → v622)
- 32/67 person cards had text contradicting their data
- Data bugs lurked for weeks undetected

**With SHK (1 round, same day):**
- 2-3 dialogue rounds per task, 0 correction messages
- 0 rework — first delivery accepted
- VERIFY stage caught 2 data bugs on day one that had been lurking for the entire previous cycle

### Project B — Feedback Loop in Action

SHK was used from day one. Over 10 days:

- **9 incidents** → **20+ executable constraints** (each with ID, WHY, and violation consequences)
- **0 repeat incidents** of the same type
- **7/9** issues caught during VERIFY stage, not after delivery
- One performance fix had **quantified evidence**: 1600x latency reduction measured via real-device perf logs

The most revealing incident: a change passed Santa dual-review (two independent AI reviewers, both said NICE) but still caused a production incident. Result: the review process itself was upgraded — review must now cover deployment risk and abnormal states, not just code logic. The constraint system evolves too.

## What SHK Does

SHK enforces a 5-stage loop via hook scripts (PreToolUse / PostToolUse) that run on every tool call:

```
PLAN → EXECUTE → VERIFY → REVIEW → FEEDBACK
                                       ↓
                              constraints.md
                              (next PLAN reads it)
```

The critical difference from prompt-based instructions (Cursor Rules, CLAUDE.md):

| Approach | Mechanism | Long session? |
|---|---|---|
| Prompt instructions | AI reads and follows voluntarily | Degrades over time |
| SHK Hooks | Scripts execute on every tool call | Consistent enforcement |

## Slides

The `slides.html` file is a self-contained 8-page presentation. Open in any browser; print to PDF with Cmd/Ctrl+P.

| Slide | Content |
|---|---|
| 1 | Cover |
| 2 | The problem — real correction quotes from sessions |
| 3 | What SHK does — 5-stage loop + hook enforcement |
| 4 | Case A — per-task dialogue round comparison |
| 5 | Case B — 3 real incidents → constraints |
| 6 | Feedback loop mechanism — constraint growth timeline |
| 7 | Data comparison tables |
| 8 | Takeaway |

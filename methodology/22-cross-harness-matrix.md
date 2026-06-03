# Cross-harness Adapter Compliance Matrix

SHK 不把所有 AI 工具都宣传成 full support。每个 harness 的能力按 stage guard、evidence、hook enforce、skill support 分级。

| Harness | Stage Guard | Evidence | Hook Enforce | Skill Support | Status |
|---|---|---|---|---|---|
| Claude Code | full | full | full | full | first-class |
| Codex | full-ish | full | full-ish | good | first-class target |
| Gemini | partial | full | partial | weak | adapter candidate |
| Cursor | partial | partial | partial | partial | docs + smoke |
| OpenCode | adapter needed | partial | adapter needed | unknown | research |
| Windsurf | audit only | partial | no PreToolUse | weak | not full SHK |

## Compliance rules

- `full` 表示可以在工具调用前阻断违规操作。
- `partial` 表示可以记录或提示，但部分工具或事件不能阻断。
- `audit only` 表示只能事后记录，不能作为准出强制层。
- Runtime smoke 必须区分“hook 无错误”和“hook 确实执行并能阻断”。

## Current smoke scope

- `tests/codex-smoke.sh`：检查 Codex runtime 无 hook failure marker；当前 exec 模式对 project hook command 的验证可能降级。
- `shk doctor`：在真实 session 中发现 PreToolUse enforce 观测缺失。

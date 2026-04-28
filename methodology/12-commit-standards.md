# Commit 规范：AI Co-Authored-By 标注

## 为什么要标注

团队需要统计每个人的 AI 代码提交占比，用于：
- 衡量 AI 工具在团队中的实际渗透率
- 分析不同 AI 工具/模型的产出质量
- 作为 AI 转型效果的量化指标
- 审计和追溯：哪些代码是 AI 写的、用了什么模型

## Co-Authored-By 格式

所有由 AI 工具生成或协助完成的 commit，必须在 commit message 末尾添加：

```
Co-Authored-By: {工具名} {模型型号} <{邮箱}>
```

### 各工具的标准格式

| 工具 | 格式 |
|------|------|
| Claude Code | `Co-Authored-By: Claude Code (claude-opus-4-6)` |
| Claude Code (Sonnet) | `Co-Authored-By: Claude Code (claude-sonnet-4-6)` |
| Claude Code (Haiku) | `Co-Authored-By: Claude Code (claude-haiku-4-5)` |
| Codex CLI | `Co-Authored-By: Codex CLI (gpt-5.3-codex)` |
| Cursor | `Co-Authored-By: Cursor (claude-sonnet-4-6)` |
| Cursor (GPT) | `Co-Authored-By: Cursor (gpt-5.3)` |
| Windsurf | `Co-Authored-By: Windsurf (claude-sonnet-4-6)` |
| GitHub Copilot | `Co-Authored-By: GitHub Copilot (gpt-5.3)` |
| OpenCode | `Co-Authored-By: OpenCode (gemini-3.1-pro)` |

### 格式规则

```
Co-Authored-By: {工具名} ({模型ID})
                 ↑           ↑
             工具品牌名    具体模型ID
```

- **工具名**：用户使用的 AI 工具品牌（Claude Code / Codex CLI / Cursor 等）
- **模型ID**：实际调用的模型标识（claude-opus-4-6 / gpt-5.3-codex 等）

### 多个 AI 工具协作

如果一次 commit 涉及多个 AI 工具（比如 Claude 写代码 + Codex review），每个工具一行：

```
feat: add search functionality to magazine page

Implement real-time article search with a11y support.

Co-Authored-By: Claude Code (claude-opus-4-6)
Co-Authored-By: Codex CLI (gpt-5.3-codex)
```

### 纯人工 commit

如果 commit 完全由人手动编写（没有任何 AI 辅助），不需要 Co-Authored-By。

### 部分 AI 辅助

即使只是 AI 帮忙生成了部分代码（比如用 Copilot 补全了几行），也必须标注。标注的是"有 AI 参与"，不是"AI 写了全部"。

## Commit Message 完整格式

```
{type}: {简短描述}

{详细描述（可选）}

Co-Authored-By: {工具名} ({模型ID})
```

type 遵循 Conventional Commits：feat / fix / refactor / test / docs / chore / perf / ci

### Preset 覆盖

上面的 subject 格式是**默认 preset (`generic`)**。公司或项目可以通过 preset 系统覆盖 subject 格式（例如要求 `<TICKET-ID> feat: ...` 前缀），但 **Co-Authored-By 是所有 preset 都强制的最低线**。

切换 preset、查看 active preset、写自己的 preset：见 `methodology/19-company-presets.md`。

## 统计方法

基于 Co-Authored-By 可以统计：

```bash
# 统计某人的 AI 辅助 commit 数
git log --author="Doug Du" --grep="Co-Authored-By:" --oneline | wc -l

# 统计各 AI 工具的 commit 数
git log --grep="Co-Authored-By: Claude Code" --oneline | wc -l
git log --grep="Co-Authored-By: Codex CLI" --oneline | wc -l

# 统计各模型的 commit 数
git log --grep="claude-opus-4-6" --oneline | wc -l
git log --grep="claude-sonnet-4-6" --oneline | wc -l

# AI 辅助 commit 占比
total=$(git log --oneline | wc -l)
ai=$(git log --grep="Co-Authored-By:" --oneline | wc -l)
echo "AI 辅助占比: $ai / $total"
```

## Commit / Push 阶段规则

Harness 不仅约束 commit message 格式，也约束 **commit 和 push 的时机**。这是为了避免 AI 在未验证或未审查的状态下污染仓库历史。

### 阶段允许矩阵

| 操作 | 允许阶段 | 不允许阶段 | 理由 |
|------|----------|------------|------|
| `git commit` | VERIFY, REVIEW, FEEDBACK | PLAN, SETUP, EXECUTE | EXECUTE 阶段未验证就 commit 容易留下未测试的代码 |
| `git push` | REVIEW | PLAN, SETUP, EXECUTE, VERIFY, FEEDBACK | push 是任务最终交付动作，必须先完成验证和审查 |

verification-gate hook 会强制这两条规则。不符合时 exit 2 阻止操作。

### 何时 commit

- VERIFY 阶段：QA 通过 + 验证证据产出后立即 commit
- REVIEW 阶段：审查中发现需要修复的小问题，可以补充 commit
- FEEDBACK 阶段：F1-F5 流程产生的修复 commit

**证据时效性要求**（verification-gate 强制）: commit 时必须存在至少一份验证证据文件，且其 mtime 必须晚于 current-stage.json 的 since。这条规则在 VERIFY/REVIEW/FEEDBACK 三个阶段的 commit 都生效，不只是 VERIFY。

证据文件可以是以下任一（按优先级查找）:
- `docs/verification-report.md`
- `.harness/last-verification.json`
- `.harness/verify-evidence.md`

每个任务通常产生 1 个主 commit（VERIFY 后），可能有 0-N 个修复 commit。

### 何时 push

- 任务完成进入 REVIEW 阶段后，把所有未推送的 commit 一起 push
- 不要在每个 commit 后都 push（碎片化推送增加远程噪音）
- 不要等多个任务积累后再统一 push（应该任务完成立即 push，避免本地堆积造成审查困难）

**核心原则**: 一个完整 Harness 闭环（PLAN→EXECUTE→VERIFY→REVIEW）→ 一次 push。

### REVIEW 阶段的 push 提醒

stage-guard 在 REVIEW 阶段的 directive 中应包含 "检查 unpushed commits 并 push" 的提醒，避免 commit 后忘记 push 导致本地堆积。

### 强制例外

如果遇到必须绕过 gate 的情况（如紧急修复），用 `HARNESS_SKIP_GATE=1 git push ...`。verification-gate 会放行但要求记录原因。

## Hook 强制执行

通过 Hook 在 commit 前检查：如果当前 session 是 AI 工具，commit message 必须包含 Co-Authored-By。

详见 `scripts/hooks/commit-check.js`。

verification-gate.js 强制 commit/push 的阶段规则，详见 `scripts/hooks/verification-gate.js`。

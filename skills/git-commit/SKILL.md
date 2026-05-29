---
name: git-commit
description: AI 智能生成 commit message 并分批提交。读取 active preset 的 subject 格式、type 枚举、分支规则、业务词归一表，自动适配 generic / example-company / 公司自定义 preset。**不自动 push** —— push 时机交回 shk 的 verification-gate（仅 REVIEW 阶段放行）。Use when 用户说提交、commit、git commit、分批提交、生成 commit message 等。
---

# git-commit

AI 自动生成 commit message 并分批提交。Test 与非 Test 自动分离，大改自动拆批。

> **本 skill 不 push**。push 时机由 shk 的 `verification-gate.js` 决定（其他阶段直接 exit 2 阻断）。

## 何时使用

- 用户说 "提交"、"commit"、"分批提交"、"帮我生成 commit message"
- 完成 EXECUTE 进入 VERIFY/REVIEW 前
- `git status` 有较多变更想拆 commit

## 何时不要用

- 用户已经写好 message + `git commit -m` 手动提交 → 直接放行，本 skill 不必介入
- 在 PLAN / SETUP / EXECUTE 阶段（verification-gate 会拒 commit；先验证再来）

## 执行原则

> 严格按步骤顺序执行，前一步成功后才进入下一步。
> 🔒 标记的步骤必须等待用户实际输入，禁止自动跳过。

---

## 1. 环境检查

```bash
git rev-parse --is-inside-work-tree
git symbolic-ref --short HEAD       # $BRANCH
git status --porcelain              # changes
```

- 非仓库 / 游离 HEAD / 无变更 → 终止
- 记录 `$BRANCH` 备后续步骤使用

## 2. 读取 active preset

```bash
node scripts/hooks/load-preset.js
```

吐出的 JSON 取以下字段：

| 字段 | 用途 |
|---|---|
| `commit_format.subject_regex` | 校验 subject 必须匹配 |
| `commit_format.format_description` | 人类可读说明（生成时参考） |
| `commit_format.type_enum` | 候选 type 列表 |
| `commit_format.type_blocked_on_branch` | type→[branch] 禁用表（支持 `!` 取反） |
| `commit_format.type_required_on_branch` | branch→[type] allowlist |
| `commit_format.title_hints` | 业务词归一表（可选；公司自定义 preset 可能提供，generic 没有） |

> 没有 `HARNESS_PRESET` / `.harness.local.json` / `.claude/settings.json` 配置时，loader fallback 到 `generic`。

## 3. 获取上次前缀

```bash
git log -1 --format=%B
```

按 active preset 的 `subject_regex` 解析第一行，提取：

- **generic / Conventional**：`<type>(scope?): subject` → `LAST_TYPE` = 第 1 个捕获组
- **任务 ID 前缀风格**（公司自定义 preset 可能采用）：`{任务ID?} {type} {title}` → `LAST_TASKID` + `LAST_TYPE`

仅作为下一步"前缀复用"的默认建议。

## 4. 前缀判定（含分支×类型约束）

### 4.1 type 选择

按以下优先级决定本批次的 `type`：

1. **Test 批次**（见 §5.1 识别）→ 强制 `test`，最高优先级
2. `LAST_TYPE` 仍合法（在 `type_enum`、不被 §4.2 拒）→ 复用
3. 否则 🔒 提示用户输入：`请输入 type（候选: <从 preset.type_enum 列出>）`

### 4.2 分支×类型校验

读 `type_blocked_on_branch` 与 `type_required_on_branch`：

- `type_blocked_on_branch[type]` 任一 pattern 匹配 `$BRANCH`（含 `!pattern` 取反）→ 该 type 在该分支被禁
- `type_required_on_branch` 中存在 pattern 匹配 `$BRANCH` 而 `type` 不在该 pattern 的 allowlist → 该 type 在该分支被禁

> 例：某公司 preset 下：
> - `master` 分支不能用 `fix`（`fix: ['!fix-*']`）
> - `fix-PROJ-42` 分支只能用 `fix` 或 `test`（`fix-*: ['fix','test']`）
> - `release-20260429` 分支不能用 `feat`（`feat: ['release-*','fix-*']`）

被禁 → 🔒 提示用户重选 type 或换分支。**严禁绕过**——`branch-policy-guard.js` 同时会在 `git commit` 时 exit 2 阻断。

### 4.3 任务 ID

仅当 active preset 的 `subject_regex` 允许任务 ID 段（例如形如 `(?:\S+\s+)?` 的可选段）时执行：

- `LAST_TASKID` 仍有效 → 复用
- 否则 🔒 输入：`请输入任务号（可跳过）`

## 5. 分批

### 5.1 Test 识别

`git diff HEAD --numstat` 后，按路径分桶：

**TEST_GROUP**（命中即视为 Test）：
- `test/` / `tests/` / `__tests__/` 目录
- `*.test.*` / `*.spec.*`
- `*_test.go` / `Test*.java` / `*_test.py`

**NONTEST_GROUP**：其余

约束：Test 与非 Test 必须分独立 commit，**不允许混合**。

### 5.2 分批策略

每组内：

- ≤ 4000 行优先聚合
- ≤ 40 文件兜底
- 单文件超 4000 行 → 单独成批
- 同目录优先聚合

### 5.3 Co-Authored-By 类型段

每个批次的 coauthor 第三段（`code` / `test` / `fix`）按规则：

| 批次特征 | type 段 |
|---|---|
| Test 批次（§5.1 命中） | `test` |
| AI 修人写的 bug / AI 自修上一轮 | `fix` |
| 其他 | `code` |

完整格式（按当前实际工具/模型）：

```
Co-Authored-By: {Tool} ({model-id}) {code|test|fix}
```

例：Claude Code Opus 4.6 写业务代码 →

```
Co-Authored-By: Claude Code (claude-opus-4-6) code
```

工具名白名单与表格见 `methodology/12-commit-standards.md`。`commit-check.js` Hook 会在 commit 时 warn 不合格行。

## 6. 标题生成

### 6.1 业务词归一（仅当 preset 提供 `title_hints`）

读 `commit_format.title_hints`（形如 `{业务词: [触发词, ...]}`）。

扫描本批次的 diff / 文件名 / 目录名，命中任一触发词 → 把对应业务词记为本批次的 **module hint**。

> 例：某公司 preset 的 `title_hints = {"billing": ["invoice","payment","charge"], ...}`，diff 命中 `src/billing/invoice.ts` → module hint = `billing`。

`generic` / `example-company` preset 没有 `title_hints` → 跳过本步骤。

### 6.2 标题文本

不论 preset：

- **≤ 50 字**（中英文均按字符算）
- **动词开头**：新增 / 修复 / 优化 / 重构 / 调整 / 删除 / 统一 …
- 聚焦**业务行为**，不要写文件名
- **避免 AI 腔**：不要 "实现了 X"、"完成了 X 的开发"、"使得 Y 成为可能"
- 不放表情包、慎用特殊字符

### 6.3 subject 拼装

按 active preset：

- **generic / Conventional**：`{type}({module-hint})?: {title}`。如有 module hint 可作 scope：`feat(billing): add invoice filter`
- **任务 ID 前缀风格**（公司自定义 preset 可能采用）：`{任务ID?} {type} {[module-hint ]title}`。是否允许括号/冒号取决于该 preset 的 `subject_regex`。module hint 可前置进 title：`PROJ-42 feat billing add invoice filter`
- 其他公司 preset：按其 `format_description` 拼

拼完用 active `subject_regex` 自校验，不通过则修正。

### 6.4 完整 message

```
{subject}

{详细说明（可选，逐条变更点，≤10 行）}

Co-Authored-By: {Tool} ({model-id}) {code|test|fix}
```

## 7. 🔒 全局预览

一次性把所有批次的 message 展示给用户：

```
=== 提交计划 ===
共 X 文件 / Y 行 / N 批：

[1/N] 文件: src/billing/invoice.ts src/billing/filter.ts
      message:
        PROJ-42 feat billing add invoice filter
        - 发票列表加渠道筛选
        - 默认按更新时间倒序
        Co-Authored-By: Claude Code (claude-opus-4-6) code

[2/N] 文件: src/billing/__tests__/invoice.test.ts
      message:
        PROJ-42 test billing invoice filter unit tests
        Co-Authored-By: Claude Code (claude-opus-4-6) test

确认执行？(y/n)
```

用户 `n` 或要求修改 → 重做对应批次。**必须等真实输入**，禁自动 y。

## 8. 执行提交

对每批：

```bash
git add -- <file1> <file2> ...
git commit -m "<subject>" -m "<body+coauthor>"
```

**严禁** `git add .` / `git add -A`（误带未规划的文件）。
**严禁** 跨批共享 staging。
任一批失败 → 立即中断，提示具体错误，不继续后续批次。

> 若 `verification-gate.js` 在当前阶段拒 commit，说明流程位置不对——先按 6 阶段 Loop 推进到 VERIFY/REVIEW/FEEDBACK 再来。

## 9. 不 push（重要）

本 skill **不执行** `git push`，原因：

- shk 的 `verification-gate.js` 把 `git push` 限制在 **REVIEW 阶段**；其他阶段直接 exit 2 阻断
- push 是 harness 级关注点（任务最终交付动作），与 commit 生成职责分离

正确做法：

- 提示用户："已生成 N 个 commit。push 时机由 verification-gate 决定，在 REVIEW 阶段它会主动提醒。"
- 用户明确要立即 push 且确认在 REVIEW → **用户自己执行** `git push`，本 skill 不代劳

后续用户 push 时若遇冲突：

```
⚠️ 远端领先，请手动处理：
  1. git pull --rebase origin <branch>
  2. 解冲突 → git add → git rebase --continue
  3. 再 git push
```

## 10. 总结

```
=== 提交总结 ===
[1] <hash> PROJ-42 feat billing add invoice filter
[2] <hash> PROJ-42 test billing invoice filter unit tests

未推送本地领先: 2 个 commit
下一步: 到 REVIEW 阶段时由 verification-gate 提醒 push
```

---

## 执行约束（必读）

1. 严格按 1→10 顺序，禁止跳步
2. 🔒 步骤必须等真实用户输入，不允许自动 y
3. 每批 add 指定文件，**禁止 `git add .` / `git add -A`**
4. Test 必须独立 commit（§5.1）
5. AI 修 bug 必须用 `fix` 第三段（§5.3）
6. **不自动 push**（§9）—— push 归 verification-gate 管
7. push 冲突必须中断、不允许自动 rebase
8. preset 提供什么字段就用什么；缺字段 fallback 到 generic

## 与其他 skill / hook 的关系

- 上游：本 skill 在 VERIFY 阶段产出 commit；evidence 文件由 `verification-gate.js` 强制
- 下游：`commit-check.js` 在 `git commit` 前校验 coauthor 3 段 + subject 匹配 preset，不合格 stderr warn（不阻塞）
- 并行：`branch-policy-guard.js` 同步校验 type × branch，本 skill §4.2 应预先按相同规则筛 type 避免 hook 拒
- 隔离：本 skill **不** 调 verification-gate；push 由用户触发

## 自测

```bash
# fixture 跑通
node tests/run.js --filter commit-check
node tests/run.js --filter branch-policy

# 本地 load-preset
node scripts/hooks/load-preset.js
```

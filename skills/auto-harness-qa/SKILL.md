---
name: auto-harness-qa
description: 执行 5 层 QA 金字塔检查，生成量化验证报告。Use when completing a feature, before committing, or before creating a PR.
---

# Harness QA

执行 5 层 QA 金字塔的自动化部分（Layer 1-4），生成结构化报告。

## 何时使用

- 完成一个功能或重要代码变更后
- 提交代码前
- 创建 PR 前
- 用户说"跑 QA"或"验证一下"

## 执行流程

### 首选入口：Quality Gate Suite

如果项目存在 `scripts/shk.js`，优先使用结构化准出入口：

```bash
node scripts/shk.js verify --risk medium --write-evidence
```

高风险或发布前改用：

```bash
node scripts/shk.js verify --risk high --write-evidence
node scripts/shk.js verify --risk release --write-evidence
```

该命令会生成：

- `.harness/verify-evidence.json` — `verification-gate.js` 优先读取的机器证据
- `.harness/verify-evidence.md`
- `docs/verification-report.md`

如果 `scripts/shk.js` 不存在，再按下面的手动 Layer 1-4 流程执行。

### Layer 1: Agent Self-Verification

检查当前变更是否有对应测试：
```bash
git diff --name-only | grep -E '\.(ts|js|py|go|rs)$'
# 对每个变更文件，检查是否有对应测试文件
```

### Layer 2: Verification Loop

按顺序执行，任一失败则停止并报告：

```bash
# Phase 1: Build
{{构建命令}}

# Phase 2: Type Check
{{类型检查命令}}

# Phase 3: Lint
{{lint 命令}}

# Phase 4: Test + Coverage
{{测试命令}} --coverage

# Phase 5: Security Scan
grep -rn "sk-\|api_key\|password\|secret" {{源码目录}}/ --include="*.{{ext}}"

# Phase 6: Diff Review
git diff --stat
```

### Layer 3: Spec Compliance Review

如果有 spec 文档：
1. 启动独立 Reviewer Agent
2. 传入 spec + 代码变更
3. 逐项对照检查
4. 输出 PASS/FAIL 清单

### Layer 4: Santa Method（可选，高风险时启用）

1. 启动两个独立 Reviewer Agent
2. 相同 rubric，独立上下文
3. 都通过 → NICE
4. 任一不通过 → 收集 issues → 修复 → 重新双 Review（max 3 轮）

## 输出格式

```
HARNESS QA REPORT
==================

Layer 1 - Self Verification:
  Tests exist for changes:  [YES/NO]
  TDD compliance:           [YES/NO/PARTIAL]

Layer 2 - Verification Loop:
  Build:     [PASS/FAIL]
  Types:     [PASS/FAIL] (N errors)
  Lint:      [PASS/FAIL] (N warnings)
  Tests:     [PASS/FAIL] (X/Y passed, Z% coverage)
  Security:  [PASS/FAIL] (N issues)
  Diff:      [N files, +X/-Y lines]

Layer 3 - Spec Compliance:
  Verdict:   [PASS/FAIL/SKIPPED]
  Details:   [逐项清单]

Layer 4 - Santa Method:
  Verdict:   [NICE/NAUGHTY/SKIPPED]
  Round:     [N/3]
  Details:   [双 Reviewer 报告]

Overall:     [READY / NOT READY]
Issues:      [待修复问题列表]
```

报告写入 `docs/verification-report.md` 或 `.harness/last-verification.json`。

## 简化模式

| 风险等级 | 执行层级 |
|---------|---------|
| 低（小改动） | Layer 1 + Layer 2 |
| 中（新功能） | Layer 1 + Layer 2 + Layer 3 |
| 高（生产部署） | Layer 1-4 全部 |

## AI 工具内测试准出协议

只要任务涉及代码变更，AI 不能等用户提醒才验证。按下面顺序做：

1. 先判断风险等级：low / medium / high / release。
新应用没有 E2E 时，AI 不能只报告缺失；要先用 `shk e2e inspect/bootstrap` 识别项目并生成第一套有正向、负向、真实断言和 evidence 的 E2E。
E2E PASS 不等于充分；如果只是 echo ok、空脚本、只 smoke、或没覆盖本次风险，用户报告要先说“现在还不能交付”，再说明测到了什么、没测到什么、下一步补什么；机器状态放最后，例如：机器状态：NOT_SUFFICIENT。DEGRADED 不能说成 PASS。
2. 识别测试能力：单测、lint、coverage、E2E、runtime smoke。
3. medium / high / release 任务必须有 E2E 证据；只有 low 小改可以不强制 E2E；找不到 E2E 入口时，先生成计划或只问一个具体启动问题。
4. VERIFY 阶段必须产出 fresh evidence；没有 READY evidence 不能说“完成了”。
5. 测试失败时进入修复 loop：一轮只修一个失败点，重跑最小测试，最多 3 轮；没进展就停下来说明卡点。
6. 报告必须说人话：先说现在能不能交付，再说测到了什么、没测到什么、下一步补什么；不能只贴日志，也不要用 READY/NOT_READY/NOT_SUFFICIENT 开头。机器状态如果必须出现，放最后。不能把 DEGRADED 说成 PASS。

AI 可以调用 `shk quality status --format json`、`shk e2e plan --format json`、`shk e2e run --format json`、`shk loop state --format json` 作为测试准出后端检查器，但不要把这些命令丢给用户自己记。

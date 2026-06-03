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

---
name: auto-harness-santa
description: 执行 Santa Method 双独立对抗验证。Use when reviewing high-risk changes, production deployments, or complex logic before shipping.
---

# Harness Santa

双独立 Reviewer 对抗验证——两个 Agent 独立审查，都通过才放行。

## 何时使用

- 高风险代码变更（安全、支付、核心逻辑）
- 生产部署前
- 复杂算法或多组件集成
- 用户说"Santa review"或"对抗验证"

## 何时不用

- 低风险改动（文档、配置、格式化）
- 有充分自动化测试覆盖的简单变更
- 探索性原型

## 执行流程

### Phase 1: Make a List（准备）

收集待审查的材料：
- 代码变更（git diff 或文件内容）
- 需求规格（如果有）
- 审查 Rubric（见下方模板）

### Phase 2: Check It Twice（双独立审查）

并行启动两个独立 Reviewer Agent：

**Reviewer A（Claude Agent）：**
```
你是独立的质量审查者。你没有看过其他任何审查意见。

## 待审查内容
{代码变更}

## 审查标准
{Rubric}

## 指令
逐项对照标准检查。对每一项：
- PASS: 完全满足，无问题
- FAIL: 发现具体问题（引用具体位置）

输出 JSON：
{
  "verdict": "PASS" | "FAIL",
  "checks": [{"criterion": "...", "result": "PASS|FAIL", "detail": "..."}],
  "critical_issues": ["..."],
  "suggestions": ["..."]
}

严格检查。你的工作是发现问题。
```

**Reviewer B（可选用 Codex `/codex:adversarial-review`，或另一个 Claude Agent）：**
同样的 Rubric，同样的代码变更，独立上下文。

**关键不变量：**
- 两个 Reviewer 互不可见（上下文隔离）
- 使用相同的 Rubric
- 并行执行

### Phase 3: Naughty or Nice（判决）

```
Reviewer A: PASS  AND  Reviewer B: PASS  →  NICE  →  放行
其他情况                                →  NAUGHTY  →  Phase 4
```

一个发现问题就算 NAUGHTY。

### Phase 4: Fix Until Nice（修复循环）

```
收集两个 Reviewer 的所有 issues
    ↓
派 Fix Agent 修复（只修 flagged issues，不做额外重构）
    ↓
重新启动两个全新 Reviewer Agent 审查修复后的代码
    ↓
最多 3 轮。超过 3 轮 → 升级给人工处理。
```

**关键：** 每轮修复后用全新 Agent 重审，防止锚定偏差。

## Rubric 模板

| 检查项 | PASS 条件 | FAIL 信号 |
|--------|----------|----------|
| 功能正确性 | 所有 spec 需求被覆盖 | 遗漏需求项 |
| 无幻觉 | 无虚构的 API/函数/URL | 引用不存在的东西 |
| 安全性 | 无硬编码密钥，输入有验证 | 发现敏感信息 |
| 一致性 | 无自相矛盾 | A 处说 X，B 处说 non-X |
| 技术正确性 | 代码可编译运行，逻辑正确 | 语法错误、逻辑 bug |
| 错误处理 | 异常路径有处理 | 缺少 error handling |

根据项目补充领域特定的检查项。

## 指标

- **First-pass rate**: 第一轮通过率（目标 >70%）
- **Mean iterations**: 平均修复轮数（目标 <1.5）
- **Reviewer agreement**: 两个 Reviewer 同时发现的问题占比
- **Escape rate**: Santa 通过但上线后发现的问题（目标 0）

## 跨模型扩展

Reviewer A 用 Claude，Reviewer B 用 Codex（`/codex:adversarial-review`）。不同模型有不同盲区，交叉审查进一步降低逃逸率。

## AI 工具内测试准出协议

只要任务涉及代码变更，AI 不能等用户提醒才验证。按下面顺序做：

1. 先判断风险等级：low / medium / high / release。
E2E PASS 不等于充分；如果只是 echo ok、空脚本、只 smoke、或没覆盖本次风险，用户报告要先说“现在还不能交付”，再说明测到了什么、没测到什么、下一步补什么；机器状态放最后，例如：机器状态：NOT_SUFFICIENT。DEGRADED 不能说成 PASS。
2. 识别测试能力：单测、lint、coverage、E2E、runtime smoke。
3. medium / high / release 任务必须有 E2E 证据；只有 low 小改可以不强制 E2E；找不到 E2E 入口时，先生成计划或只问一个具体启动问题。
4. VERIFY 阶段必须产出 fresh evidence；没有 READY evidence 不能说“完成了”。
5. 测试失败时进入修复 loop：一轮只修一个失败点，重跑最小测试，最多 3 轮；没进展就停下来说明卡点。
6. 报告必须说人话：先说现在能不能交付，再说测到了什么、没测到什么、下一步补什么；不能只贴日志，也不要用 READY/NOT_READY/NOT_SUFFICIENT 开头。机器状态如果必须出现，放最后。不能把 DEGRADED 说成 PASS。

AI 可以调用 `shk quality status --format json`、`shk e2e plan --format json`、`shk e2e run --format json`、`shk loop state --format json` 作为测试准出后端检查器，但不要把这些命令丢给用户自己记。

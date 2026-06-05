---
name: auto-harness-review
description: 执行交付前 5 项复盘检查，确保流程合规和质量达标。Use when about to deliver work to users, before final handoff, or when completing a development cycle.
---

# Harness Review

交付前 5 项复盘——确保流程完整、质量达标、规则沉淀。

## 何时使用

- 即将交付工作成果
- 完成一轮开发循环
- 创建 PR 前
- 用户说"复盘"或"交付检查"

## 5 项复盘检查

### 1. 流程合规

- 是否按 6 阶段 Loop 执行？（Plan → Setup → Execute → Verify → Review → Feedback）
- 是否有跳过的阶段？如果有，原因是什么？
- 是否有绕过 Gate 条件的情况？

### 2. QA 达标

- Layer 2 Verification Loop 是否执行？报告是否完整？
- 构建成功？类型检查通过？Lint 通过？测试通过？覆盖率达标？
- Layer 3 Spec Review 是否执行（如果适用）？
- Layer 4 Santa Method 是否执行（如果是高风险）？

### 3. 需求完整

- 逐项对照原始需求：每个需求点是否都有对应的实现？
- 是否有部分完成或推迟的需求？如果有，是否已记录？

### 4. 规则升级

- 开发过程中是否发现新问题？
- 新问题是否已通过 F3-F4 提炼为规则并写入 constraints.md？
- Violation History 是否更新？

### 5. 改进机会

- 哪些步骤耗时最长？有没有自动化的空间？
- 哪些 Agent 派发效果不好？prompt 需要怎么改进？
- Hook 有没有漏拦或误拦的情况？
- QA 流程有没有改进空间？

### 6. 行为学习分析（自动）

REVIEW 阶段自动运行 `harness-learn.js` 分析本轮积累的 observations，输出：
- 发现了哪些行为模式（工具序列、高频文件）
- 有没有 instinct 可以提炼为 Rule（Token 优化）
- 高频修改但缺少测试的文件

**这一步不需要用户触发——REVIEW 阶段自动执行。**

## 输出格式

```
DELIVERY REVIEW
===============

1. 流程合规:    [✓/✗] {备注}
2. QA 达标:     [✓/✗] {备注}
3. 需求完整:    [✓/✗] {备注}
4. 规则升级:    [✓/✗] {备注}
5. 改进机会:    {列出 1-3 个改进点}
6. 行为学习:    {N} 个模式 | {N} 个 instinct 更新 | Token 优化建议: {有/无}

结论: [可以交付 / 需要补充工作]
```

## 与 Hooks 配合

`delivery-review.js` Hook 会在打开交付物时自动触发复盘提醒。本 Skill 提供完整的复盘流程。

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

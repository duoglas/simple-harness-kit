---
name: harness-feedback
description: 执行 F1-F5 结构化反馈处理流程，从问题中提炼规则并写入约束系统。Use when receiving bug reports, user feedback, review findings, or test failures.
---

# Harness Feedback

结构化反馈处理——从问题到规则的闭环。

## 何时使用

- 收到用户反馈（"这个不对"）
- Review 发现问题
- 测试失败
- 任何"需要修"的情况
- 用户说"处理反馈"或"F1-F5"

## 执行流程

### Step 0: 收集反馈信息

如果用户在 `/harness-feedback` 后面直接附了内容，用那个内容。否则依次询问：

1. **问题是什么？** — 等待用户描述
2. **期望行为是什么？** — 等待用户回答

收集到信息后，进入 F1-F5。

### F1: 记录原话

原样记录问题描述，不解读、不简化、不猜测意图。

```markdown
## 反馈记录
- **来源**: [用户反馈 / Review / 测试失败 / 自查]
- **原话**: "[原样记录]"
- **时间**: [YYYY-MM-DD]
- **严重性**: [阻断 / 重要 / 建议]
```

### F2: 分类问题层级

判断：这个问题只出现在一个地方，还是可能出现在多处？

| 层级 | 判断依据 | 修改位置 |
|------|---------|---------|
| 规则层 | 多处可能出现同样问题 | docs/constraints.md |
| 工具层 | 工具逻辑 bug | src/（通过 Agent） |
| 配置层 | 配置不当 | 配置文件 |
| 实例层 | 仅此一处 | 具体文件 |

### F3: 提炼规则（关键步骤，禁止跳过）

从具体实例抽象为通用规则：

```
❌ "把登录按钮的 padding 改成 16px"
✅ "所有可交互元素在移动端最小触控区域为 44x44pt，padding ≥ 12px"
```

提炼方法：
1. 问"还有哪些地方可能有同样问题？"
2. 具体值 → 通用规则（"16px" → "≥ 12px"）
3. 具体对象 → 类别（"登录按钮" → "所有可交互元素"）
4. 同类问题归一条规则

### F4: 写入文件

规则层问题写入 `docs/constraints.md`：

```markdown
## C-{AREA}-{NN}: {规则标题}

{规则描述}

- **WHY**: {为什么需要这条规则}
- **违反后果**: {不遵守会怎样}
- **来源**: VH-{NN}（{日期} {问题描述}）
```

同时在 Violation History 中记录：

```markdown
| VH-{NN} | {日期} | {发生了什么} | {根因} | C-{AREA}-{NN} |
```

**先写规则，再派 Agent。**

### F5: 派 Agent 修复

```markdown
修复 C-{AREA}-{NN} 违规。
读取 docs/constraints.md 中该约束的完整描述。
扫描 {范围} 中所有不符合该约束的地方，全部修复。
修复后运行 {测试命令} 确认通过。
```

Agent prompt 必须引用 Constraint ID。

## 输出

每次 F1-F5 完成后，输出处理摘要：

```
反馈处理完成
============
问题: {一句话描述}
层级: {规则层/工具层/配置层/实例层}
规则: C-{AREA}-{NN} — {规则标题}
违规记录: VH-{NN}
修复: Agent 已按规则修复并自验通过
```

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

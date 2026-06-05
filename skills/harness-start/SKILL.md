---
name: harness-start
description: 启动 Harness 任务（交互式收集需求，自动带上全部流程约束）。Use when starting a new feature, task, or any development work in a Harness-enabled project.
---

# Harness Start

交互式启动一个 Harness 任务，自动注入全部流程约束。

## 执行流程

### Step 1: 询问需求

向用户提问：

```
请描述你要做的任务：
```

等待用户回答。如果用户在 `/harness-start` 后面直接附了内容，用那个内容，不需要再问。

### Step 2: 进入 PLAN 阶段

将 `.harness/current-stage.json` 设为 PLAN，然后按以下约束执行：

**流程约束（全部强制，不可跳过）：**

1. **PLAN 暂停** — 任务拆解完成后，输出任务清单，暂停等用户确认。用户没说"继续/go/确认"之前不进入下一阶段。
2. **VERIFY 量化证据** — 不接受"看起来没问题"。必须有命令输出、测试结果、检查报告等可复现的证据。
3. **真实验证** — 功能性变更必须在真实场景验证，不能只靠 mock 或文件存在性检查。
4. **交付检查清单** — 向用户交付结果之前，逐项回答：
   - 流程合规：按 PLAN → EXECUTE → VERIFY 执行了吗？
   - QA 达标：验证证据充分吗？
   - 真实验证：功能性变更在真实场景跑过了吗？
   - 需求完整：所有需求都处理了吗？
   - 规则升级：过程中新问题写入 constraints 了吗？
5. **Session Log** — 关键决策和偏差必须记录到 .harness/session-log.md。工具调用由 Hook 自动记录，但"为什么这么做"和"偏离了什么"需要主动写。

### Step 3: 开始执行

按 6 阶段 Loop 正常执行：
```
PLAN → EXECUTE → VERIFY → REVIEW
```

如果 REVIEW 不达标，进入 FEEDBACK 循环。

## AI 工具内测试准出协议

SHK 第二阶段的目标不是让本仓库多跑脚本，而是让 SHK 装进目标应用工程后，帮助 AI 工具完成三件事：

1. **可衡量**：先写清 `.harness/iteration-spec.json`，用说人话的方式说明需求、方案、风险、测试计划、流量路径和验收标准。
2. **可验收**：AI 要为目标工程完成测试生成或选择测试，验证这些测试是否有效，再用结构化 evidence 做交付准出。
3. **持续优化**：发现失败或测试不充分时，进入最多 3 轮的 loop 修复，每轮只推进一个明确失败点。

只要任务涉及代码变更，AI 不能等用户提醒才验证。按下面顺序做：

1. 先判断风险等级：low / medium / high / release，并为本轮目标工程生成/更新 iteration spec。
新应用没有 E2E 时，AI 不能只报告缺失；要先用 `shk e2e inspect/bootstrap` 识别项目并生成第一套有正向、负向、真实断言和 evidence 的 E2E。
E2E PASS 不等于充分；如果只是 echo ok、空脚本、只 smoke、或没覆盖本次风险，用户报告要先说“现在还不能交付”，再说明测到了什么、没测到什么、下一步补什么；机器状态放最后，例如：机器状态：NOT_SUFFICIENT。DEGRADED 不能说成 PASS。
2. 识别测试能力：单测、lint、coverage、E2E、runtime smoke，并判断是否需要为目标工程生成测试。
3. 验证测试是否有效：需求覆盖、风险覆盖、流量覆盖、断言质量、正向路径、负向/边界路径、mutation/fault injection、runtime realism、fresh evidence。
4. medium / high / release 任务必须有 E2E 证据和 test effectiveness READY；只有 low 小改可以不强制 E2E；找不到 E2E 入口时，先生成计划或只问一个具体启动问题。
5. VERIFY 阶段必须产出 fresh evidence；没有 READY evidence 不能说“完成了”。
6. 测试失败或 NOT_SUFFICIENT 时进入修复 loop：一轮只修一个失败点，重跑最小测试，最多 3 轮；没进展就停下来说明卡点。
7. 报告必须说人话：先说现在能不能交付，再说测到了什么、没测到什么、下一步补什么；不能只贴日志，也不要用 READY/NOT_READY/NOT_SUFFICIENT 开头。机器状态如果必须出现，放最后。不能把 DEGRADED 说成 PASS。

AI 可以调用 `shk spec status --format json`、`shk quality status --format json`、`shk e2e inspect/bootstrap/assess --format json`、`shk test effectiveness --format json`、`shk verify --write-evidence`、`shk loop state --format json` 作为后端检查器，但不要把这些命令丢给用户自己记。

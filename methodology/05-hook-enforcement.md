# Hook 强制执行策略

## 为什么 Hook 是核心

```
可靠性排名：

Hook（工具级拦截）     ████████████████████ 100%
Rules（.claude/rules/） ████████████░░░░░░░░  ~60-80%
CLAUDE.md 指令         ██████████░░░░░░░░░░  ~50-70%
Prompt 中的口头叮嘱     ██████░░░░░░░░░░░░░░  ~30-50%

                       ← 上下文越长，后三者越不可靠 →
```

Rules 和 CLAUDE.md 的内容在 session 开始时加载到上下文。随着对话变长：
- LLM 的注意力从 system prompt 漂移到最近的对话
- 早期加载的规则权重下降
- Agent 开始"合理化"违规行为（"这种情况应该例外"）

**Hook 不受此影响。** 它在 LLM 调用工具的管道上拦截，与上下文无关。

## Hook 类型

> 完整的工具 / 事件覆盖矩阵见 [15-hook-coverage-matrix.md](./15-hook-coverage-matrix.md)。本章只介绍核心类型。

Claude Code 支持多种 Hook 触发点，核心列表：

| 触发点 | 时机 | 用途 |
|--------|------|------|
| **PreToolUse** | Agent 调用工具之前 | 拦截违规操作、检查前置条件、注入提醒 |
| **PostToolUse** | Agent 调用工具之后（成功） | 验证产出、记录行为、触发后续检查 |
| **PostToolUseFailure** | Agent 调用工具之后（失败） | 记录失败工具调用，避免遗漏黑匣子 |
| **SessionStart** | 新 session 开始 | 重置陈旧 stage、输出入口 banner、注入 AI directive |
| **UserPromptSubmit** | 用户提交 prompt | Codex 可见入口 fallback：在 SessionStart stderr 不显示时注入 banner/context |
| **TaskCompleted** | 任务被标记为 completed | 在 EXECUTE/VERIFY 阶段提醒检查验证证据（含 agent team 场景） |
| **StopFailure** | API 错误结束（rate_limit 等） | 记录到 session-log/observations，下次 session 知道上次怎么挂的 |
| **SessionEnd** | session 结束（clear/logout 等） | 归档 observations.jsonl + 写结束标记 |

Hook 返回值：
- `exit 0` — 放行
- `exit 2` — 阻止该工具调用
- `stderr` 输出 — 作为提醒/警告显示给 Agent

## 核心 Hook 清单

Hook 分为两级：

| 级别 | 含义 | init 时 |
|------|------|---------|
| **必选** | Harness 运行时基础设施，缺少则流程失控或无记录 | 所有项目必须生成，不可以"轻量适配"为由跳过 |
| **可选** | 按项目特点选配，有明确的适用/不适用场景 | 跳过时必须记录理由 |

> **实战经验（VH-04）：** mind-palace 项目 init 时 AI 以"纯文档项目不需要"为由跳过了 session-logger、stage-guard、session-start。结果新 session 没有阶段强制、没有过程记录。这三个是基础设施，不是功能 Hook。

### 0. Harness Stage Guard（阶段声明强制）[必选]

**触发：** PreToolUse:* — Bash/Edit/Write/Agent（写类） + Read/Grep/Glob/WebFetch/WebSearch（读类） + TaskUpdate（任务管理）。完整覆盖见 [15-hook-coverage-matrix.md](./15-hook-coverage-matrix.md)。
**作用：** 强制 Agent 在新 session 中声明当前 Harness 阶段；PLAN 阶段阻止写类工具

```text
检查 .harness/current-stage.json 是否存在
  不存在 → exit 2 阻止（Write .harness/current-stage.json 是唯一豁免）
  解析异常 / stage 值无效 → exit 2 阻止
  first-call guard 未通过 → exit 2（要求 AI 先输出阶段声明，TASK_TOOLS 跳过）
  PLAN 阶段非读类/非任务管理工具 → exit 2
  切换到 REVIEW 但流程或证据不完整 → exit 2
  其他 → exit 0 放行，必要时注入阶段 directive 和 session-log 提醒
  存在但超过 2 小时 → 提醒确认阶段是否仍然正确（不阻止）
```

完整行为见 [`scripts/hooks/harness-stage-guard.js`](../scripts/hooks/harness-stage-guard.js) 顶部注释。

**为什么排在第一位：** Rules 和 CLAUDE.md 级别的流程指令容易被其他 prompt（如外部 skill）覆盖。Hook 在工具调用管道上拦截，优先级高于所有 LLM 层面的指令。实测证明：即使项目已有完整方法论文档，新 session 仍可能不遵守 Harness 流程——这是 LLM 注意力机制的固有特性，必须用 Hook 兜底。

> **实战经验（Experiment C 准备阶段）：** 新 session 被外部 brainstorming skill 覆盖，连续多轮问答而不进入 Harness 6 阶段 Loop。CLAUDE.md 中的流程指令完全失效。此 Hook 专门解决这个问题。

### 0.5 Session Logger（全过程记录）[必选]

**触发：** PostToolUse + PostToolUseFailure（覆盖 Agent/Bash/Edit/Write 等工具，记录成功和失败的工具调用）
**作用：** 每次工具调用后自动追加日志到 `.harness/session-log.md`，失败调用同样进入黑匣子

这是整个 Harness 的"黑匣子"。AI 可能忘记手动记录，但 Hook 不会忘。记录内容包括 Agent 派发、命令执行、文件变更。人的指示和偏差分析仍需 AI 在规则引导下主动记录，但工具操作层面有了 100% 的兜底。

> **实战经验（Experiment A）：** session-logger.js 的 PostToolUse Hook 在实验中可能未正确触发（日志全由 AI 主动写入）。**SETUP 阶段必须用实弹测试验证 Hook 生效**——不能只检查文件存在。排查方向：PostToolUse hook 的 stdin 格式是否与 PreToolUse 一致、hook 脚本是否有执行权限。

### 0.9 Session Start（session 初始化）[必选]

**触发：** SessionStart
**作用：** 新 session 重置阶段为 PLAN、重置工具调用计数器、输出 banner

> Codex Desktop 注意：SessionStart 的状态副作用会生效，但 stderr/banner 不保证进入 UI 或模型上下文。Codex profile 额外挂载 `UserPromptSubmit → harness-entry-banner.js`，通过 `hookSpecificOutput.additionalContext` 注入 `HARNESS MODE ACTIVE` 和首轮阶段声明要求。

与 Stage Guard 配合：Session Start 做初始化，Stage Guard 做持续强制。缺少 Session Start，Stage Guard 会基于过期的阶段数据工作。

### 1. Safety Guard（安全防护）[必选]

**触发：** PreToolUse:Bash
**作用：** 拦截危险命令

```javascript
// 拦截模式
const BLOCKED = [
  { pattern: /rm\s+-rf\s+[\/~]/, msg: '禁止删除根目录或 home 目录' },
  { pattern: /git\s+push\s+--force/, msg: '禁止 force push，使用 --force-with-lease' },
  { pattern: /git\s+reset\s+--hard/, msg: '禁止 hard reset，请确认后手动执行' },
  { pattern: /--no-verify/, msg: '禁止跳过 git hooks' },
  { pattern: /DROP\s+(TABLE|DATABASE)/i, msg: '禁止直接 DROP，需要人工确认' },
];
```

### 2. Role Guard（角色越权拦截）[可选 — 有 PM 角色分离时]

**触发：** PreToolUse:Bash
**作用：** PM 角色不直接执行 pipeline 命令

```javascript
// PM 模式下拦截直接执行
const PM_BLOCKED = [
  { pattern: /\b(python3?|node)\s+src\//, msg: 'PM 不直接执行 pipeline，请用 Agent' },
  { pattern: /npm\s+run\s+build/, msg: 'PM 不直接构建，请派 Agent 执行' },
];
```

### 3. Agent Prompt Check（Agent 派发合规）[可选 — 使用 Agent tool 时]

**触发：** PreToolUse:Agent
**作用：** 修复类 Agent 必须引用 Constraint ID

```javascript
const prompt = String(input.tool_input?.prompt || '');
const desc = String(input.tool_input?.description || '');

const isFix = /fix|repair|修复|bug|审计|audit/i.test(desc + prompt.substring(0, 200));

if (isFix) {
  const hasConstraintRef = /C-[A-Z]+-\d+|constraints\.md/.test(prompt);
  if (!hasConstraintRef) {
    process.stderr.write(
      '[Agent Check] 修复类 Agent 未引用 Constraint ID。\n' +
      '→ 先写规则到 constraints.md，再派 Agent。\n'
    );
    // 不阻止，但发出警告
  }
}
```

### 4. Verification Gate（验证门控）[可选 — 有测试框架时]

**触发：** PreToolUse:Bash (git commit)
**作用：** 提交前确认 QA 已完成

```javascript
const cmd = String(input.tool_input?.command || '');

if (/git\s+commit/.test(cmd)) {
  // 检查是否有 verification report
  const fs = require('fs');
  const reportExists = fs.existsSync('docs/verification-report.md') ||
    fs.existsSync('.harness/last-verification.json');

  if (!reportExists) {
    process.stderr.write(
      '[Verification Gate] 未找到验证报告。\n' +
      '→ 请先运行 QA 验证流程（Layer 2: Verification Loop）。\n'
    );
    process.exit(2); // 阻止提交
  }
}
```

### 5. Delivery Review（交付前复盘）[可选 — 有交付物文件时]

**触发：** PreToolUse:Bash (open/打开交付物)
**作用：** 在交付用户之前提醒复盘

```javascript
if (/open\s+.*\.(pptx|pdf|html|zip|apk|ipa)/.test(cmd)) {
  process.stderr.write(
    '\n[Delivery Review] 交付前复盘 5 项检查：\n' +
    '1. 流程合规：是否按 6 阶段 Loop 执行？\n' +
    '2. QA 达标：各层 QA 报告是否完整？\n' +
    '3. 需求完整：所有需求是否全部处理？\n' +
    '4. 规则升级：新问题是否写入 constraints？\n' +
    '5. 改进机会：哪些步骤可以优化？\n\n'
  );
}
```

### 6. Context Budget Monitor（上下文预算监控）[可选 — 长 session 场景]

**触发：** PreToolUse:Edit, PreToolUse:Write
**作用：** 工具调用计数过多时提醒 compact

```javascript
const COUNTER_FILE = '/tmp/harness-tool-counter.json';
let counter = { count: 0 };
try { counter = JSON.parse(fs.readFileSync(COUNTER_FILE)); } catch {}
counter.count++;
fs.writeFileSync(COUNTER_FILE, JSON.stringify(counter));

if (counter.count >= 50 && counter.count % 25 === 0) {
  process.stderr.write(
    `[Context Monitor] 已执行 ${counter.count} 次工具调用。\n` +
    '→ 建议在下一个逻辑阶段边界执行 /compact。\n' +
    '→ 这能防止上下文过长导致规则遵从度下降。\n'
  );
}
```

## settings.json 模板

完整的 `settings.json` 模板是 `templates/settings-json.tmpl`，它是实际生效的 source of truth。本节不重复展示所有 matcher，以免出现"多份竞争性真实源"导致的漂移。

- 完整模板: [templates/settings-json.tmpl](../templates/settings-json.tmpl)
- 最小配置示例（init 时必选部分）: [init-prompt.md §settings.json 最小配置](../init-prompt.md)
- 每个工具/事件被哪些 hook 覆盖及理由: [15-hook-coverage-matrix.md](./15-hook-coverage-matrix.md)

**快速一瞥** — 模板包含五个顶层 key：

| 顶层 key | 作用 | 挂载脚本 |
|----------|------|----------|
| `SessionStart` | 新 session 初始化 | `harness-session-start.js` |
| `UserPromptSubmit` | Codex 可见入口 fallback | `harness-entry-banner.js` |
| `PreToolUse` | 工具调用前守门 | `harness-stage-guard.js`（多 matcher） + `safety-guard` + `verification-gate` + `delivery-review` + `commit-check` + `agent-check` + `context-monitor` |
| `PostToolUse` | 成功工具调用记录 | `session-logger.js`（Agent/Bash/Edit/Write） |
| `PostToolUseFailure` | 失败工具调用记录 | `session-logger.js`（全局） |
| `Stop` | 交付前守门 | `delivery-gate.js` |

修改 settings.json 时必须同步矩阵和模板，详见矩阵的 E 节一致性检查清单。

## Hook 设计原则

### 1. 阻止 vs 警告

| 严重性 | 行为 | 例子 |
|--------|------|------|
| **阻止**（exit 2） | 危险操作，不可恢复 | rm -rf /, force push, DROP TABLE |
| **强警告**（stderr） | 流程违规，但可继续 | 修复 Agent 未引用 Constraint ID |
| **轻提醒**（stderr） | 建议性改进 | 工具调用过多，建议 compact |

### 2. Hook 不应该做什么

- **不修改 Agent 的输出** — Hook 是守门人，不是干预者
- **不做复杂的业务逻辑** — Hook 应该快速、确定性
- **不产生副作用** — 除了计数器等轻量记录
- **读操作不做内容过滤** — Read/Grep/Glob/WebFetch/WebSearch 一旦进入工具执行阶段不会被拦截内容。注意：这些工具仍然受 first-call guard 和 stage-guard 的流程约束（例如本轮第一次调用前必须先输出阶段声明），只是 stage-guard 不会以"路径/内容不合规"为由阻止它们

### 3. 项目定制

每个项目的 Hook 应该根据实际情况定制：
- **Pipeline 项目**：加 pipeline-gate（阶段前置条件检查）
- **PM 模式**：加 role-guard（角色越权拦截）
- **高安全项目**：加 file-scope-guard（限制可编辑目录）
- **长时任务**：加 context-monitor（提醒 compact）

## 与 Rules 的配合

```
Rules（.claude/rules/）        Hooks（.claude/settings.json）
  "应该做什么"                    "不做什么就拦住"
  ↓                              ↓
  引导 Agent 的行为方向            强制执行不可违反的约束
  ↓                              ↓
  可能被遗忘                      100% 执行
```

最佳实践：**关键约束写 Hook + Rule 双保险。** Rule 告诉 Agent 为什么这么做，Hook 确保它真的做了。

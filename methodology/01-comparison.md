# 对比与定位

## 我们是什么

Simple Harness Kit 是一套**可移植的方法论 + 模板**，不是框架、不是平台、不是 IDE 插件。

丢给 AI agent，它帮你在任意项目里生成 Rules/Hooks/Constraints/QA 流程。

## 一、Harness 框架层对比

### vs DeerFlow 2.0（字节跳动）

| 维度 | DeerFlow | Simple Harness Kit |
|------|----------|-------------------|
| 定位 | SuperAgent Harness 平台 | 方法论 + 模板 |
| 使用方式 | 部署 Python 服务 + LangGraph | 纯 Markdown，丢给 AI 即用 |
| 约束机制 | 代码级（Python guard） | Hook 级（工具层拦截，LLM 无法绕过） |
| 核心能力 | 子 Agent 编排、Docker 沙箱、长期记忆 | QA 金字塔、Hook 强制、约束追溯 |
| 适用场景 | 构建 Agent 产品 | 用 AI 做日常开发 |
| 上手成本 | 高（需要 Python 开发 + 部署） | 低（填项目信息 → AI 生成配置） |

**关系：不同赛道。** DeerFlow 面向"构建 Agent 应用"，我们面向"用 Agent 做开发"。

### vs LangGraph / CrewAI

| 维度 | LangGraph / CrewAI | Simple Harness Kit |
|------|-------------------|-------------------|
| 本质 | 编排引擎（需要写代码） | 方法论（纯文档） |
| 产出 | Agent 应用 | 开发流程配置 |
| 学习曲线 | 需要学框架 API | 读文档即可 |
| 依赖 | Python + 框架依赖 | 无依赖 |

**关系：不同层级。** 它们是"造车的发动机"，我们是"开车的交通规则"。

### vs OpenAI Harness Engineering

OpenAI 2026 年提出 Harness Engineering 概念：3 人团队日均 3.5 PR，管理百万行仓库。

| 维度 | OpenAI Harness Eng. | Simple Harness Kit |
|------|---------------------|-------------------|
| 形式 | 概念文章 + Codex 内置实践 | 可落地的模板和 Skill |
| 约束机制 | Codex 内置（闭源） | Hook 模板（开源可定制） |
| 可移植性 | Codex 绑定 | Claude Code + Codex + 其他 |

**关系：理念同源，我们提供可落地的实现。**

### vs Composio Agent Orchestrator

| 维度 | Composio | Simple Harness Kit |
|------|----------|-------------------|
| 核心能力 | 多 Agent 并行管理（worktree/branch/PR） | 单 Agent 质量保障 + 反馈闭环 |
| 关注点 | 编排和并发 | 约束和质量 |
| Agent 支持 | 无关（Claude/Codex/Aider） | Claude Code 最佳，Codex 兼容 |

**关系：互补。** Composio 管"怎么同时跑多个 Agent"，我们管"每个 Agent 怎么做得对"。

### vs ECC（Everything Claude Code）

| 维度 | ECC | Simple Harness Kit |
|------|-----|-------------------|
| 本质 | **工具箱**——135 个独立 skill | **方法论**——有序的流程 |
| 使用方式 | 安装插件 → 记住哪些 skill 存在 → 手动调 | 填表 → AI 生成项目级配置 → 自动运转 |
| 统一性 | 各 skill 独立，无统一 Loop | 6 阶段 Loop 串联所有组件 |
| Hook 体系 | 分散在各 skill 里 | **统一的 Hook 模板体系** |
| QA 体系 | verification-loop 和 santa-method 是独立 skill | **5 层 QA 金字塔是内置流程** |
| 约束追溯 | 无 Constraint ID | **每条约束有唯一 ID** |
| 反馈闭环 | continuous-learning 做行为学习 | **F1-F5 结构化反馈流程** |
| 跨工具 | Claude Code 专属 | CLAUDE.md + AGENTS.md 双格式 |
| 跨模型 CR | 无 | Codex review Claude 产出 |

**关系：继承 + 结构化 + 扩展。** 我们站在 ECC 肩膀上，从 135 个 skill 中提炼最需要的子集，用 6 阶段 Loop 串成流程，加上 ECC 没有的约束追溯和反馈闭环。

> ECC 是 Claude Code 的瑞士军刀，我们是"拿着瑞士军刀干活的操作手册"。

## 二、工具层对比

### AI 编码工具全景

| 能力 | Claude Code | Codex CLI | Gemini CLI | Cursor | OpenCode | Windsurf |
|------|------------|-----------|-----------|--------|----------|----------|
| 开源 | 否 | 是 | 是 | 否 | 是（120K stars） | 否 |
| 模型灵活性 | Claude 系列 | GPT 系列 | Gemini 系列 | 多模型 | **75+ 模型** | 多模型 |
| **Hook 系统** | **完整** | **有**（需 `hooks` flag） | **有**（v0.26+） | **有**（v1.7+） | **有**（插件 API） | ⚠️ 有限 |
| Hook 阻止能力 | exit 2 阻止 | exit 2 阻止 | exit 2 阻止 | allow/deny | 插件 API | 仅审计 |
| Skill 系统 | 有 | 有（兼容格式） | 无 | 有（Marketplace） | 无 | 无 |
| 独立 Agent | **Agent tool** | 云端沙箱 | 无原生 | Background Agent | 无 | Cascade |
| 上下文 | 1M | 1M | 1M | 200K | 取决于模型 | 50-70K |
| 价格 | $20-200/月 | $20/月起 | 免费起 | $20/月起 | **$10/月起** | $15/月起 |
| **Harness 适配度** | **最佳** | **良好** | **良好** | **良好** | 一般 | 弱 |

### 各工具的 Harness 适配分析

**Claude Code（最佳）：** 完整的 Hook（PreToolUse/PostToolUse）+ Skill 系统 + Agent tool（独立子 Agent）。三者齐备，是 Harness Engineering 的最佳载体。我们的 Hook 脚本原生适配 Claude Code 的 stdin JSON 协议。

**Codex CLI（良好，已实测验证）：** 原生 Hook 系统（SessionStart/PreToolUse/PostToolUse/PermissionRequest/UserPromptSubmit/Stop），使用 canonical `.codex/hooks.json` 顶层 `hooks` 配置。当前 `hooks` feature 为 stable；仍可用 `--enable hooks` 或 `[features] hooks = true` 显式启用。Codex stage guard 覆盖 `Bash|apply_patch|mcp__.*`，project-local hooks 需 `/hooks` trust/review。AGENTS.md 标准 + Skill 系统 + 云端沙箱。

**Gemini CLI（良好）：** 2026.01 发布完整 Hook 系统（BeforeTool/AfterTool），exit 2 阻止协议与 Claude Code 一致。配置格式稍有差异（.gemini/settings.json，事件名用 BeforeTool 而非 PreToolUse），但 Hook 脚本可复用。文档齐全，安全设计好（指纹机制防恶意 hook 注入）。

**Cursor（良好）：** v1.7 引入 Hook 系统，支持 allow/deny 决策。可读取 `.claude/settings.json`，意味着 Claude Code 的 Hook 配置可以在 Cursor 中直接生效。有 Plugin Marketplace。但作为 IDE 工具，Agent 隔离能力不如 CLI 工具。

**OpenCode（一般）：** 有原生的插件事件系统（tool.execute.before/after），但 API 格式与 Claude Code 不同（TypeScript 插件 vs JSON stdin），不能直接复用我们的 Hook 脚本。有社区适配器（codex-hooks）但不完善。

**Windsurf（弱）：** 仅有 Cascade Hooks（model response 级别），**没有 PreToolUse 级别的工具拦截能力**。只能用于审计和日志，无法阻止违规操作。是唯一不支持完整 Harness 的主流工具。

### Hook 脚本兼容性

我们的 Hook 脚本（Node.js，stdin JSON，exit 2 阻止）可以在以下工具上运行：

| 工具 | 直接兼容 | 需要适配 |
|------|---------|---------|
| Claude Code | ✅ 原生 | — |
| Codex CLI | ✅ 原生兼容 | `.codex/hooks.json` canonical `hooks` + `/hooks` trust/review |
| Gemini CLI | ⚠️ 协议兼容 | 配置文件格式 + 事件名映射 |
| Cursor | ✅ 读取 .claude/settings.json | — |
| OpenCode | ❌ | 需要改写为 TypeScript 插件 |
| Windsurf | ❌ 不支持 | — |

### 推荐组合策略

```
日常编码（80%时间）：Cursor / Windsurf（autocomplete + inline edit）
中等任务（15%时间）：Claude Code / Codex（Agent 模式 + 部分 Harness）
复杂任务（5%时间）：Claude Code + Full Harness（5 层 QA + Hook + Agent 隔离）
跨模型 CR（扩展）：Codex adversarial-review 审查 Claude 产出
```

## 三、我们的优势与不足

### 优势

1. **Hook 是唯一 100% 可靠的约束机制** — 不依赖 LLM 自觉
2. **5 层 QA 金字塔** — 纵深防御，AI 做 4 层，人做 1 层
3. **独立 Agent 消除规则遗忘** — 每任务新上下文
4. **约束可追溯** — Constraint ID + Violation History
5. **跨工具跨模型** — CLAUDE.md + AGENTS.md + Codex CR
6. **零依赖** — 纯 Markdown + JS，无框架无部署
7. **渐进式采用** — 可以只用 Rules，也可以全套 Hook+QA

### 不足（坦诚说明）

1. **有学习成本** — 比直接用 Claude Code 多一层方法论理解
2. **需要初始配置** — 按项目定制 Rules/Hooks/Constraints
3. **Hook 配置格式部分不统一** — Claude Code 与 Codex 格式一致（已实测），Gemini/Cursor 需要适配配置文件格式（脚本可复用）
4. **Token 开销** — 多层 QA = 更多 Agent 调用，成本约 2-3x
5. **不适合小任务** — 一次性脚本/原型不需要这套体系
6. **Windsurf 不支持** — Windsurf 缺少 PreToolUse 级别的 Hook 阻止能力，无法运行完整 Harness

### 适用场景 vs 不适用场景

| 适用 | 不适用 |
|------|--------|
| 团队 AI 转型，需要规范化流程 | 个人探索性编码 |
| 多人协作，Agent 产出需要质量保证 | 一次性脚本和原型 |
| 有测试框架的中大型项目 | 没有测试的遗留项目 |
| 对质量有硬要求（金融、安全等） | 对速度要求 > 质量要求的场景 |
| 持续迭代的产品开发 | 一次性交付的外包项目 |

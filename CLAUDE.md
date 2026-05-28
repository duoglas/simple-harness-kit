# CLAUDE.md

## 项目概述

Simple Harness Kit — 可移植的 Harness Engineering 方法论 + 模板仓库。纯文档项目，无应用代码。

## 本仓库用途

包含方法论文档、模板和 Skills，AI Agent 读取后可为任意项目生成开发 Harness 配置（Rules、Hooks、Constraints、QA 流水线）。

## 文件结构

- `methodology/` — 方法论核心文档，编号 00-19
- `templates/` — 可生成的模板文件（.tmpl 后缀）
- `skills/` — Claude Code / Codex 可安装的 Skills（SKILL.md 格式）
- `examples/` — 实战验证案例（附证据链）
- `experiments/` — 对照实验与 dogfooding 证据
- `docs/dogfooding-maintainers.md` — 维护者如何用 SHK 自己开发 SHK（bootstrap + 日常回路）
- `init-prompt.md` — 用户填写项目信息后喂给 AI 生成 Harness

## 写作约定

- 默认中文，技术术语和代码示例保留英文原文
- Markdown 格式，不用 HTML
- 文件命名：小写 + 连字符
- 不使用 emoji

## 关键概念（跨文档引用）

- **6 阶段 Loop**: Plan → Setup → Execute → Verify → Review → Feedback
- **5 层 QA 金字塔**: Agent 自验 → 工具检查 → Spec 审查 → Santa 对抗验证 → 人工终审
- **Hook 强制执行**: PreToolUse/PostToolUse Hook 作为主要约束机制
- **Agent 隔离**: 每个任务独立 subagent，无上下文污染
- **Constraint ID**: `C-{area}-{number}` 格式，single source of truth 在 constraints.md
- **F1-F5 反馈闭环**: 记录 → 分类 → 提炼规则 → 写入文件 → 派 Agent

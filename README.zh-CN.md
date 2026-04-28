# Simple Harness Kit

**[English](README.md)**

一套可移植、工具无关的 **Harness Engineering** 方法论 + 模板仓库。

> "不要问哪个模型更聪明，要问谁的执行系统更可靠。"

### 解决什么问题

| 痛点 | 症状 | 解法 |
|------|------|------|
| **规则遗忘** | 长对话后 Agent 忽略约束 | Hook 强制执行（工具层 100% 拦截） |
| **质量不稳定** | 有时好有时 bug | 5 层 QA 金字塔（AI 做 4 层，人只做终审） |
| **经验不沉淀** | 同样问题反复出现 | Constraint ID 追溯 + F1-F5 反馈闭环 |
| **行为无感知** | 不知道团队实际怎么用 AI | 持续学习（自动积累行为模式 → 发现改进机会） |

### 快速开始

**Step 1: 安装 Skills（一条命令）**

```bash
git clone https://github.com/duoglas/simple-harness-kit.git ~/simple-harness-kit
bash ~/simple-harness-kit/install.sh
```

`install.sh` 会做这些事：
- 把 skills 装到 `~/.claude/skills/` 和/或 `~/.codex/skills/`（自动检测，或用 `--target claude|codex|both`）
- 写入 `~/.simple-harness-kit-root` 文件，让 `harness-init` 后续自动定位 kit
- （仅 Codex）询问是否把 `alias codex='codex --enable codex_hooks --full-auto'` 写入 `~/.zshrc` / `~/.bashrc` —— 推荐选 [Y]，一条 alias 同时覆盖 init 和日常 session

更新：`git -C ~/simple-harness-kit pull && bash ~/simple-harness-kit/install.sh`

**Step 2: 为项目初始化 Harness（每个项目做一次）**

进入你的项目目录，然后：

```bash
# Claude Code:
claude              # 启动 TUI
# 然后在 TUI 输入：
/harness-init

# Codex（必须 TUI 模式 — exec/non-interactive 在定位 kit 时会卡死）:
codex               # 如果 Step 1 接受了 alias，这一条就够
# 或者没设 alias 时：
codex --full-auto --enable codex_hooks
# 然后在 TUI 输入：
$harness-init       # 注意：Codex 用 $ 不是 / 触发 skill
```

或者直接粘贴这段 prompt（两个工具都 work，无需 skill）：

```
读取 ~/simple-harness-kit/init-prompt.md 和 methodology/ 目录。
为这个项目初始化 Harness。

必须执行的步骤：
1. 自动扫描项目结构（package.json/目录/已有配置），自动识别技术栈，不要问我要信息
2. 生成全部必选组件（init-prompt.md 里标注了哪些是必选）：
   - 4 个 Hook 脚本: harness-stage-guard.js, harness-session-start.js, session-logger.js, safety-guard.js
   - 4 个 Rules: role-constraints.md, qa-standards.md, feedback-workflow.md, harness-entry.md
   - settings.json（按 init-prompt.md 中的最小配置，注册全部必选 Hook）
   - docs/constraints.md, CLAUDE.md
3. 根据项目特点选配可选组件（跳过的必须说明理由）
4. 所有 Hook 脚本从 ~/simple-harness-kit/scripts/hooks/ 复制，不要从头写
5. 完成后输出完整性检查清单（逐项列出每个必选组件的 OK/MISSING 状态）
6. 任何 MISSING 必须当场修复
7. 提醒我：Hook 在下一个 session 才生效，需要开新 session
```

> **重要：** init 完成后必须开新 session。Hook 在当前 session 不生效。

**Step 3: 日常使用**

开新 session 后，Harness 自动接管（Hook 驱动 6 阶段 Loop）。两种方式：

方式 A — Skill（推荐，交互式引导）：
```
/harness-start          # Claude Code
$harness-start          # Codex（注意 $ sigil）
```
Skill 会询问你的需求，自动带上全部约束（PLAN 暂停、VERIFY 量化证据、交付检查清单）。

方式 B — 手动输入：
```
按 Harness 6 阶段 Loop 执行。PLAN 暂停等我确认，VERIFY 要有量化证据，交付前回答检查清单。
需求：帮我实现 XXX
```

**处理反馈：**

```
/harness-feedback       # Claude Code
$harness-feedback       # Codex
```

Skill 会询问问题描述和期望行为，自动按 F1-F5 流程执行。也可以手动输入 `[Harness 反馈] 问题：XXX 期望：YYY`。

---

### 核心机制

**6 阶段 Loop：** Plan → Setup → Execute → Verify → Review → Feedback（不达标则循环）

**5 层 QA 金字塔：**
```
  L5: Human Review    人工终审           ← 人只做这层
  L4: Santa Method    双独立对抗验证      ← 两个 AI Reviewer 都通过才放行
  L3: Spec Review     规格合规审查        ← 独立 Reviewer ≠ 实现者
  L2: Verification    工具自动检查        ← Build/Type/Lint/Test/Security
  L1: Self-Verify     Agent 自验          ← TDD 红绿重构
```

**Hook 强制执行：** 9 个内置 Hook，在工具层 100% 拦截——safety-guard | harness-stage-guard | agent-check | verification-gate | commit-check | delivery-review | context-monitor | session-logger | branch-policy-guard

**持续学习：** 开发过程中 Hook 自动记录行为数据（<50ms 无感知），每轮 Loop 结束时自动分析——发现工具使用模式、高频修改文件（可能缺测试）、稳定行为可提炼为 Rule（减少 token 消耗）。不调 AI API，纯本地分析。

详见 [methodology/](methodology/) 全部 15 篇文档。

---

### Preset 系统 (v0.9.0)

Commit 格式和分支策略**数据驱动** —— 不同公司 / 团队 / 项目对规则要求不同（TICKET-ID 前缀、保护分支、`release-*` 上禁止 `feat` 等）。无需 fork 改 hook 代码，丢一份 preset 配置即可。

**零配置 = 零变化。** 没主动选 preset 就静默 fallback 到 `generic`，向后兼容 v0.8.x 老用户升级，不会突然多出新 warning。

**内置 preset：**
- `presets/generic/` —— 默认，等价 Conventional Commits + Co-Authored-By
- `presets/example-company/` —— 公开范例：TICKET-ID 前缀 + 受限分支 + 单 release 约束 + feat-on-release 禁止。复制一份改名即可定制自己的

**主动选用 preset：**

```bash
cp .harness.local.example.json .harness.local.json
# 编辑 "preset" 字段，例如 "example-company" 或自定义
```

或者临时 env 覆盖：`HARNESS_PRESET=example-company`。

**强制层做什么：**
- `commit-check` 当 subject 不匹配 active preset 的 `subject_regex` 时 warn
- `branch-policy-guard` 阻 `git push` 到 `merge_only_branches`、阻 `--all`/`--mirror` 当存在受保护分支、阻 `type_blocked_on_branch` 配置的提交类型（如 `release-*` 上 `feat`）
- `HARNESS_SKIP_GATE=1` 紧急一次性 bypass

完整 schema + 设计取舍：[methodology/19-company-presets.md](methodology/19-company-presets.md)

---

### 使用场景

#### 初始化 + 开发需求（最常见）

先按 Step 2 初始化，开新 session 后：

```
按 Harness 6 阶段 Loop 执行。

要求：
1. PLAN 暂停等我确认
2. VERIFY 有量化证据
3. 交付前回答检查清单

需求：为文章列表页添加搜索和分类筛选功能：
- 搜索框实时过滤文章标题和摘要
- 分类标签点击筛选，支持搜索+筛选组合使用
- 无结果时显示空状态
- 需要 E2E 测试覆盖搜索、筛选、组合场景
```

#### 给已有项目加装

```
读取 ~/simple-harness-kit/init-prompt.md 和 methodology/ 目录。
这个项目已有代码，帮我加装 Harness。
已知问题：auth 模块没有错误处理，API 响应格式不一致。

必须执行：按 init-prompt.md 的必选清单生成全部组件，Hook 从 ~/simple-harness-kit/scripts/hooks/ 复制，
完成后输出完整性检查清单。
```

#### 补测试

```
按 Harness 6 阶段 Loop 执行。

要求：PLAN 暂停等确认，VERIFY 用真实测试结果验证。

需求：为这个项目建立自动化测试体系。
目前没有任何自动化测试，全靠人工。重点关注 src/auth/ 和 src/api/。
```

AI 自动执行：分析模块风险 → 暂停确认优先级 → 搭建测试框架 → 按优先级生成测试（单元→集成→E2E→a11y）→ 报告。发现 bug 记录到 constraints，不自动修（用户决定）。

**业界参考：** [Diffblue Cover](https://www.diffblue.com/) 为 Java 项目全自动生成单测；[QA Wolf](https://www.qawolf.com/) 从自然语言生成 Playwright E2E；[OpenObserve](https://openobserve.ai/blog/autonomous-qa-testing-ai-agents-claude-code/) 用 8 个 AI Agent 将测试从 380 增长到 700+。我们不绑定特定工具，用 Harness 方法论编排 AI 完成同样的事。详见 [skills/harness-test-bootstrap/](skills/harness-test-bootstrap/)

---

### 实战验证

#### Experiment A: json-2-csv — 库函数级

| 维度 | 数据 |
|------|------|
| **项目** | [mrodrig/json-2-csv](https://github.com/mrodrig/json-2-csv)（TypeScript，459 stars） |
| **需求** | [#281](https://github.com/mrodrig/json-2-csv/issues/281) 添加 `alwaysQuote` 配置项 |
| **代码量** | 6 文件，+78/-16 行 |
| **测试** | TDD + Mocha 单元测试，141→147（新增 6） |
| **Loop** | 1 次迭代（Layer 3 Spec Review 发现交互 bug） |

```
SETUP → PLAN(6) → EXECUTE → VERIFY ─→ L3 FAIL: alwaysQuote+fieldTitleMap 交互 bug
                                        ↓
                              FEEDBACK(提炼规则 C-DATA-01) → EXECUTE-2 → VERIFY(PASS) → REVIEW ✓
```

**关键发现：** 独立 Reviewer 发现了 Implementer 遗漏的交互 bug——单一 Agent 长对话中几乎不可能自己发现。详见 [examples/experiment-a/](examples/experiment-a/)

#### Experiment B: Fyrre Magazine — 前端页面级

| 维度 | 数据 |
|------|------|
| **项目** | [asbhogal/Fyrre-Magazine](https://github.com/asbhogal/Fyrre-Magazine)（Next.js + Tailwind + Playwright） |
| **需求** | 搜索 + 分类筛选 + 修复/新增 E2E + a11y |
| **代码量** | 8 文件，+152/-129 行 |
| **测试** | TDD + Playwright E2E 14 个 + axe a11y |
| **Loop** | 3 次迭代（L3 FAIL → L4 Santa NAUGHTY → L4 NICE） |

```
SETUP → PLAN(13) → EXECUTE(搜索+筛选) → VERIFY ─→ L3 FAIL: 4 个 a11y+交互问题
                                                     ↓
                                           FEEDBACK(修复) → EXECUTE(E2E)
                                                     ↓
                                           VERIFY ─→ L4 Santa NAUGHTY: 双 Reviewer 发现 8 个问题
                                                     ↓
                                           FEEDBACK(Fix Cycle) → VERIFY(L4 NICE) → REVIEW ✓
```

**功能交付验收：**

| 初始状态 | 搜索过滤 |
|---------|---------|
| ![初始状态](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-1-top.png) | ![搜索过滤](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-2-search-secret.png) |
| 搜索框 + 分类标签，All 默认选中 | 输入 "secret" 实时过滤 |

| 分类筛选 | 搜索+筛选组合 |
|---------|-------------|
| ![分类筛选](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-3-sculptures.png) | ![组合](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-4-combo.png) |
| 点击 Sculptures 只显示该分类 | Sculptures + "museum" AND 组合 |

| 空状态 | 移动端适配 |
|--------|-----------|
| ![空状态](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-5-empty-state.png) | ![移动端](https://github.com/duoglas/simple-harness-kit/releases/download/v0.1.0/demo-6-mobile.png) |
| 无结果显示 "No articles found" | 375px 下搜索框全宽，单列布局 |

详见 [examples/experiment-b/](examples/experiment-b/)

#### 对比

| 维度 | Experiment A | Experiment B |
|------|-------------|-------------|
| 类型 | 库函数 | 前端页面 |
| 测试方法 | Mocha 单元测试 | Playwright E2E + axe a11y |
| Loop 迭代 | 1 次 | 3 次 |
| QA 最高层 | Layer 3 | **Layer 4 Santa** |
| 发现问题 | 1 个 | **12 个** |
| 方法论反馈 | M1-M5 | M6-M10 |

#### Experiment C: Planka — 全栈级 + 多工具对比

| 维度 | 数据 |
|------|------|
| **项目** | [plankanban/planka](https://github.com/plankanban/planka)（Sails.js + React，11.5k stars） |
| **需求** | [#1485](https://github.com/plankanban/planka/issues/1485) 为 Board/List 添加 description 字段 |
| **代码量** | 15 文件，+294/-7 行（Claude Code）/ +289/-6 行（Codex） |
| **测试** | 7 API E2E + Playwright UI 验证 |
| **Loop** | 1 次迭代（Layer 3 Spec Review 发现遗漏后修复） |
| **工具** | Claude Code (gpt-opus-4-6) vs Codex CLI (gpt-5.4) |

```
SETUP(Harness Init) → PLAN → EXECUTE(3 Agent) → VERIFY(L2 PASS, L3 FAIL) → FIX → VERIFY(L3 PASS) → REVIEW ✓
```

**关键发现：**
- 独立 Reviewer Agent 发现了 Claude Code Implementer 遗漏的需求（board description 未在主视图显示）
- Codex 在给定详细 prompt 后一次通过 Spec Review 8/8——但 prompt 质量来自 Claude Code 实验的教训
- 新 session 不遵守 Harness 流程（Rule 被外部 skill 覆盖），已用 harness-stage-guard Hook 解决（M-11）

详见 [examples/experiment-c-planka/](examples/experiment-c-planka/)

#### 对比

| 维度 | Experiment A | Experiment B | Experiment C |
|------|-------------|-------------|-------------|
| 类型 | 库函数 | 前端页面 | **全栈** |
| 工具 | Claude Code | Claude Code | **Claude Code + Codex** |
| 测试方法 | Mocha 单元测试 | Playwright E2E + axe a11y | API E2E + Playwright UI |
| Loop 迭代 | 1 次 | 3 次 | 1 次 |
| QA 最高层 | Layer 3 | **Layer 4 Santa** | Layer 3 |
| 发现问题 | 1 个 | **12 个** | 1 个 |
| 方法论反馈 | M1-M5 | M6-M10 | M11-M13 |

三次实验共产出 **13 项方法论修正**，全部已反馈回本仓库。

---

### 选型分析

#### 背景

2026 年，AI 从"回答系统"转向"执行系统"。微软 .NET 团队用 Copilot Agent 10 个月合并 535 个 PR（[来源](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/)）。OpenAI 提出 [Harness Engineering](https://openai.com/index/harness-engineering/)——3 人团队日均 3.5 PR 管理百万行仓库。核心问题：**如何让 AI 可控地参与工程协作？**

#### 调研：三个层级

**Agent 编排框架**（DeerFlow / LangGraph / CrewAI / Composio）——解决"构建 Agent 平台"，需要 Python 开发和部署。我们的问题是"用 Agent 做日常开发的质量控制"，层面不同。

**AI 编码工具**（Claude Code / Codex / Gemini CLI / Cursor / OpenCode / Windsurf）——2026 Q1 除 Windsurf 外全部支持 Hook 阻止。Claude Code 和 Codex CLI 已实测验证，其余基于文档分析。详见 [methodology/01-comparison.md](methodology/01-comparison.md)

**方法论体系**（ECC Superpowers / Ralphinho / OpenAI Harness Eng. / GitHub Squad）——有理念有工具有 Skill，缺少把它们串成可执行流程的方法论。

#### 我们从各框架借鉴了什么

| 来源 | 借鉴维度 | 具体影响 |
|------|---------|---------|
| **ECC Superpowers** | 工作流 + 测试 + Agent 执行 + 上下文管理 | TDD 铁律、两阶段 Review、subagent 隔离、context-monitor |
| **ECC verification-loop** | QA 自动化 | Layer 2 六阶段检查 |
| **ECC santa-method** | 对抗验证 | Layer 4 双独立 Reviewer + 收敛循环 |
| **ECC eval-harness** | 量化度量 | pass@k 指标体系 |
| **ECC continuous-learning-v2** | 行为记录 | 我们实现了轻量版（Node.js <50ms vs ECC Bash+Python 200-500ms） |
| **Ralphinho RFC-DAG** | 任务编排 + 角色隔离 | 复杂度分 tier、Author ≠ Reviewer |
| **OpenAI Harness Engineering** | 工程实践 | 验证了约束+自动化可规模化 |
| **GitHub Squad** | 设计原则 | inspectable/predictable/repository-native |
| **DeerFlow 2.0** | 架构概念 | SuperAgent Harness 概念层对齐 |
| **微软 Agentic Platform** | 渐进路线 | 轻量/标准/完整三级模式 |
| **AGENTS.md 标准** | 跨工具兼容 | CLAUDE.md + AGENTS.md 双格式 |

#### 设计决策

| 决策 | 选择 | 理由 | 放弃 |
|------|------|------|------|
| 约束机制 | Hook 强制 | 100% 可靠 | Rules-only（上下文长了就忘） |
| QA | 5 层金字塔 + 角色隔离 | 纵深防御 | 单层测试 |
| 反馈 | Constraint ID + F1-F5 | 经验沉淀 | ad-hoc 修复 |
| Agent | 按角色隔离 | 消除 author-bias | 单 Agent 全搞定 |
| 载体 | 纯文档 + JS Hook | 零部署 | 框架/服务 |
| 兼容 | CLAUDE.md + AGENTS.md | 不锁厂商 | 单工具绑定 |

---

### 参与改进

每次使用 Harness 时，`.harness/session-log.md` 会自动记录全过程。其中**偏差记录**最有价值——方法论说应该 X，实际做了 Y。

**团队成员提交反馈：** 在本仓库开 Issue，附上 session-log 中的偏差记录：

```markdown
## Session Log 反馈
项目: [名] | 日期: [日期] | 模式: [轻量/标准/完整]

### 偏差
1. 方法论要求: [X] → 实际: [Y] → 原因: [为什么] → 建议: [改什么]

### 附件
- session-log.md
```

我们会定期从 Issue 提取共性问题更新方法论——Experiment A/B 产出的 M1-M10 修正就是这个流程。

---

### 工具兼容性

> Experiment A/B/C 基于 **Claude Code** 验证，Experiment C 同时验证了 **Codex CLI**。Codex 交叉兼容性测试（hooks.json 格式、stdin JSON、exit 2 阻止协议）已独立验证。其他工具基于文档分析推断。

| 工具 | Hook 能力 | 状态 |
|------|----------|------|
| **Claude Code** | 原生 PreToolUse/PostToolUse | **已验证** (Exp A/B/C) |
| **Codex CLI** | 原生 Hook（需 `codex_hooks` flag） | **已验证** (Exp C + 交叉测试) |
| **Gemini CLI** | v0.26+ BeforeTool/AfterTool | 未验证 |
| **Cursor** | v1.7+ hooks | 未验证 |
| **OpenCode** | 插件 API（需改写） | 未验证 |
| **Windsurf** | 仅审计，无阻止 | **不支持** |

### 环境变量

| 变量 | 值 | 作用 |
|------|---|------|
| `HARNESS_LOG` | `off` | 关闭 session-log 自动记录 |
| `HARNESS_AUTO` | `full` | 全程自动，PLAN 也不暂停 |
| `HARNESS_AUTO` | `off` | 每个阶段都暂停等确认 |
| `HARNESS_LEARN` | `off` | 关闭持续学习数据采集 |
| `HARNESS_ATTRIBUTION` | `off` | 不在用户 README 追加标注 |

### 仓库结构

```
simple-harness-kit/
├── methodology/   15 篇方法论文档
├── presets/       2 个内置 (generic + example-company)，数据驱动 commit & 分支规则
├── templates/     5 规则模板 + 9 Hook 脚本 + 4 配置模板
├── skills/        7 个 Skills (init 用户触发 | 其余 AI 自动调用)
├── examples/      3 个实战验证 (Experiment A + B + C)
├── tests/         138+ Hook 场景 + 模板完整性 + 脚本矩阵 + Codex smoke
└── init-prompt.md 初始化 Prompt
```

### 许可

MIT — 零法律摩擦，最大化采纳。方法论项目的价值在于被广泛使用。

---

Harnessed by [Simple Harness Kit](https://github.com/duoglas/simple-harness-kit)

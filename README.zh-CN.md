# Simple Harness Kit

**[English](README.md)**

Simple Harness Kit（SHK）是一套给 Claude Code、Codex 这类 AI 编程工具用的 **工程 Harness**。

它不是让你在业务代码里 import 的 JS 包。它是装进目标工程里的工作流、Hook、Skill 和检查器，让 AI 在做需求时必须说清楚：要做什么、怎么验收、测试证明了什么、哪里还不能交付。

> 不要只问哪个模型更聪明，要问这套交付系统能不能证明结果可靠。

## 它解决什么问题

| 没有 SHK 时 | 常见结果 | SHK 做什么 |
|---|---|---|
| 长对话规则漂移 | AI 开始很谨慎，后面开始跳步骤 | Hook 在工具层持续拦截 |
| “测试通过”太空 | `echo ok`、只打开首页也算绿 | E2E 必须证明本次业务风险 |
| 没有清晰 spec | 需求、方案、验收在聊天里漂 | medium/high/release 先写迭代 spec |
| 测试失败后乱修 | 一次改很多，越修越偏 | 最多 3 轮 loop，每轮只修一个失败点 |
| 交付靠口头承诺 | “我刚才测了”不可复现 | `verify` 写结构化 evidence |
| 经验不沉淀 | 同类问题反复出现 | 反馈进入 constraints 和回归检查 |

## 用户实际会怎么用

你还是在 Claude Code 或 Codex 里正常说需求：

```text
帮我实现优惠券结算能力。
```

SHK 改变的是 AI 的交付动作。它不能直接说“完成了”，而要先做这些事：

1. **判断风险等级**：low / medium / high / release。
2. **写或读取迭代 spec**：需求、方案、风险、流量路径、测试计划、验收标准。
3. **识别项目测试能力**：单测、集成、API E2E、浏览器 E2E、上游 CI。
4. **缺 E2E 时生成第一套**：Web/fullstack 优先 Playwright，API 服务生成 API E2E，已有 Cypress 就沿用。
5. **先跑最小有效测试**：不要一上来乱跑全量，也不要只跑无关命令。
6. **判断测试是否有效**：有没有测到本次业务路径、真实断言、失败路径、mutation/fault 证据。
7. **失败后 loop 修复**：最多 3 轮，每轮只处理一个失败点并重跑最小验证。
8. **用人话汇报**：测到了什么、没测到什么、现在能不能交付、下一步做什么。

好的报告应该像这样：

```text
现在还不能交付。

订单创建这条路径还没被验收测试覆盖。
现有检查只证明服务能启动、/health 能返回。
它还没证明 POST /orders 能创建订单、能拒绝空订单，也没证明订单逻辑坏掉时测试会失败。

我会先补一条创建订单正向测试和一条空订单阻断测试，然后重跑最小 API E2E。
机器状态：NOT_SUFFICIENT
```

机器状态给 Hook 和工具读，但用户首先应该看到工程原因。

## 快速开始

### 1. 安装一次 SHK

```bash
git clone https://github.com/duoglas/simple-harness-kit.git ~/simple-harness-kit
bash ~/simple-harness-kit/install.sh
```

`install.sh` 会：

- 把 skills 安装到 `~/.claude/skills/` 和/或 `~/.codex/skills/`；
- 写入 `~/.simple-harness-kit-root`，后续初始化项目时自动定位 kit；
- 可选写入 Codex alias，带上当前明确的 hooks / sandbox / approval 参数。

更新：

```bash
git -C ~/simple-harness-kit pull
bash ~/simple-harness-kit/install.sh
```

### 2. 每个项目初始化一次

进入目标工程：

```bash
# Claude Code
claude
/harness-init

# Codex：必须用 TUI，不要用 codex exec 跑 init
codex --enable hooks --sandbox workspace-write --ask-for-approval on-request
$harness-init
```

也可以直接粘贴初始化 prompt：

```text
读取 ~/simple-harness-kit/init-prompt.md 和 methodology/ 目录。
为当前项目初始化 Harness。
Hook 脚本必须从 kit 复制，不要从头写。
生成必选 rules、settings、docs/constraints.md 和项目入口说明。
完成后输出完整性清单，缺什么当场补齐。
提醒我：Hook 要下一个新 session 才生效。
```

初始化后要开新 session，Hook 才会生效。

### 3. 日常使用

```text
/harness-start     # Claude Code
$harness-start     # Codex
```

然后描述需求即可。

处理反馈：

```text
/harness-feedback  # Claude Code
$harness-feedback  # Codex
```

## SHK 怎么判断能不能交付

SHK 的主流程是：

```text
PLAN → SETUP → EXECUTE → VERIFY → REVIEW → FEEDBACK
```

真正重要的不是“有没有一个命令返回 0”，而是“这次测试到底证明了什么”。

### 三种机器状态

| 状态 | 人话含义 |
|---|---|
| `READY` | 必要检查跑过，证据是新的，测试覆盖了这次 spec / 风险路径。 |
| `NOT_READY` | 必要检查缺失、失败、过期，或 runtime 降级。 |
| `NOT_SUFFICIENT` | 命令是绿的，但证明力不够。假 E2E、只 smoke、没断言、没覆盖流量、没 mutation/fault 证据，都在这里。 |

### 什么叫有效 E2E

medium / high / release 任务不能只看 E2E 是否 PASS。SHK 期望看到：

- spec 写清需求、风险、流量路径和验收证据；
- 有真实正向路径；
- 有真实失败或阻断路径；
- 有断言，而且行为改坏时断言会失败；
- evidence 是本次运行新写出来的，不是旧文件；
- 有 mutation/fault 证据证明关键逻辑坏了会被抓住；
- runtime 降级时必须原样报告，不能包装成 PASS。

如果关键逻辑坏了测试还绿，这套测试就是无效的。

## Phase 2：质量工程门禁

Phase 2 的重点不是“再加几个命令”，而是把 spec 驱动、测试生成、有效测试验证和交付准出接进 AI 日常工作流，让 AI 帮目标工程做到三件事：

1. **可衡量**：每轮迭代先有 `.harness/iteration-spec.json`，用短文档说明需求、方案、风险、测试计划、流量路径、验收标准。
2. **可验收**：AI 自动生成或选择测试，并判断测试是否真的覆盖业务路径，而不是只走流程。
3. **持续优化**：失败或证明力不够时进入受控 loop，最多 3 轮，不自动 push/tag/release。

Phase 2 接入了：

- `shk spec status`
- `shk e2e inspect/bootstrap/assess`
- `shk test effectiveness`
- `shk verify`
- `auto-harness-loop-fix`
- QA / review / santa / feedback / project templates

这些命令是 AI Harness 的后端探针，不是让用户背的 CLI。

更多说明：

- [Quality Engineering Gate](docs/quality-engineering-gate.md)
- [Phase 2 文档](docs/phase2-quality-gate/README.md)
- [v0.11.0 draft release notes](docs/release-notes/v0.11.0.md)

## Quality Gate Suite

`node scripts/shk.js ...` 是 skills 和 hooks 的后端。典型探针：

```bash
node scripts/shk.js verify --risk medium --write-evidence
node scripts/shk.js spec status --format json
node scripts/shk.js e2e inspect --format json
node scripts/shk.js e2e bootstrap --risk medium --format json
node scripts/shk.js e2e assess --risk medium --format json
node scripts/shk.js test effectiveness --risk medium --format json
node scripts/shk.js security scan
```

`verify` 会写 `.harness/verify-evidence.json` 和人可读报告。commit/tag 相关 Hook 会读取这些证据后再决定是否放行。

## 团队 preset

提交格式和分支策略是数据驱动的：

- `presets/generic/`：默认 Conventional Commits + Co-Authored-By；
- `presets/example-company/`：公开示例，演示 ticket 前缀、保护分支、release 限制。

项目可以用 `.harness.local.json` 或 `HARNESS_PRESET=...` 主动选择 preset。零配置时不改变旧项目行为。

详见 [methodology/19-company-presets.md](methodology/19-company-presets.md)。

## 实战验证

SHK 最早来自几个公开项目实验：

| 实验 | 项目 | 证明了什么 |
|---|---|---|
| A | [json-2-csv](https://github.com/mrodrig/json-2-csv) | 独立 review 抓到了实现者漏掉的数据交互 bug。 |
| B | [Fyrre Magazine](https://github.com/asbhogal/Fyrre-Magazine) | 浏览器 E2E + a11y 需要多轮反馈后才适合交付。 |
| C | [Planka](https://github.com/plankanban/planka) | 工具选择没有 review、evidence、loop discipline 重要。 |

Phase 2 又补了真实 OSS dogfood：TodoMVC 浏览器链路和 Express API 服务。正常行为下测试要通过；故意改坏关键逻辑后，同一套测试必须失败。

## 工具支持

| 工具 | 状态 |
|---|---|
| Claude Code | 主路径，skills + hooks。 |
| Codex | 支持 TUI skills + hooks；部分环境下 runtime smoke 仍可能 DEGRADED。 |
| Gemini CLI / Cursor / OpenCode | 已分析兼容路径，但不是当前主验证路径。 |
| Windsurf | 只有 audit 类 hook，不适合 SHK 的阻断式门禁。 |

## 已知限制

- Codex `exec` runtime smoke 在部分环境仍可能是 `DEGRADED`，不能算 runtime PASS，也不能用于 release READY。
- SHK 不能替代产品判断和人工终审；它解决的是执行纪律、证据和反馈闭环。
- Phase 2 的充分性判断先落地工程上有效的信号：spec 映射、结构化证据、真实断言、正负路径、mutation/fault 证明。它不是形式化覆盖率证明。

## 仓库结构

```text
simple-harness-kit/
├── methodology/                方法论文档
├── docs/                       constraints、发布流程、Phase 2 文档
├── skills/                     Claude Code / Codex skills
├── scripts/hooks/              阶段、安全、验证、交付 hooks
├── scripts/shk.js              skills/hooks 读取的后端探针
├── templates/                  项目入口模板
├── presets/                    提交和分支策略 preset
├── examples/                   公开验证实验
└── tests/                      hook 场景、完整性检查、dogfood 脚本
```

## License

MIT

---

Harnessed by [Simple Harness Kit](https://github.com/duoglas/simple-harness-kit)

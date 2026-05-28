# 维护者 Dogfooding 指南

> 本文档面向 **本仓库的维护者/贡献者**（不是 SHK 的下游用户）。
> SHK 是方法论产品，**只有用 SHK 自己的 harness 来开发 SHK，方法论才能被持续验证和打磨**。
> 这条 dogfooding 主回路是 SHK 产品价值的来源，见 [实验证据](../experiments/ecc-vs-shk/RESULTS.md)。

## 现状（为什么需要本文档）

实验 `experiments/ecc-vs-shk/` 暴露了一个产品级 meta-gap：

- SHK 的核心强制机制（`stage-guard`、`verification-gate` 等 PreToolUse hook）依赖 `.harness/current-stage.json` 等运行时状态。
- 这些状态文件是 per-developer 的，仓库根的 `.gitignore` 明确以 `.harness/` 一行把它排除——这是有意为之，不该提交。
- 同理 `.claude/` 与 `.codex/` 也作为"dogfooded 实例"被 `.gitignore` 排除，相关注释明确说明它们是 `harness-init` 在 kit 自身仓库生成的运行实例而非要分发的模板。
- 后果：克隆仓库后，维护者**默认拿不到一个能跑的 harness 实例**，于是上手就没有强制约束——SHK 自己不被 SHK 约束。

这不是 bug 是 design intent，但 **bootstrap 流程必须可发现** 否则等于隐藏功能。本文档就是那条流程。

## 一次性 bootstrap（新机器/新 clone）

**关键认知（C-INIT-05）**：bootstrap 失败的真正根因不是"settings 不热载"，而是 **"settings 从未存在"**——SHK 主仓库根默认无 `.claude/settings.json`，user-level `~/.claude/settings.json` 通常是别的 harness 设置（如 fleet/vibe-island），与 SHK 自家 28 个 hook 完全互不知情。下列步骤的核心是 **步骤 2**（写入项目级 settings），不是步骤 3（restart）。

```bash
# 1. 装 SHK 的 skills 到本机的 Claude Code 和/或 Codex CLI
bash install.sh --target both --scope personal

# 2. **关键一步：在主仓库根写入 SHK 项目级 .claude/settings.json**
#    选 a 或 b 任一种方式：
#    a) 在主仓库根打开 Claude Code，跑 /harness-init（含交互式向导，会在本仓库
#       生成 .claude/、.codex/、.harness/ 及对应 settings.json）
#    b) 纯 shell 一行：
#         cp templates/settings-json.tmpl .claude/settings.json
#       （等价于 a 的核心动作；不含 .codex/.harness/ 那两个目录的初始化）
#    完成后必须能 ls 看到主仓库根的 .claude/settings.json（13KB 左右），缺它就
#    无论 restart 多少次 SHK hook 都不会跑——这是上一轮诊断错过的真根因。

# 3. 重启 Claude Code session
#    Claude Code 不在 mid-session 热载 settings.json，必须 exit + 重新启动
#    才能让 hook 注册生效。
#    （注意：步骤 3 是 *次要* 步骤；步骤 2 缺失则步骤 3 重启再多次也无效）

# 4. 验证活跃信号（见下）
```

## 验证 dogfooding 起效（restart 后立刻做）

restart 后的第一个 session 做以下三件事确认 hook 真活跃。**如果三个信号全失败但你的 user-level harness（如 vibe-island）看起来在工作，那就是经典 dogfooding 假象——SHK 自家 hook 完全没挂、但你在用别的 harness**：

1. **副作用信号**：发一个 Bash 命令（如 `ls`），查 `.harness/observations.jsonl` 与 `.harness/tool-count.json` 是否被自动创建。这两个文件由 SHK 自家的 session-logger / stage-guard 在 PostToolUse / PreToolUse 时写入，**只在 SHK 自家 hook 真活跃时**才会出现（user-level vibe-island-bridge 不写这两个文件）。
2. **拦截信号**：发一个 `echo "chmod 777 /tmp/test"`——SHK 自家 safety-guard 正则 `/chmod\s+777/` 应命中，exit 2 并 stderr 写 `[Safety Guard] 禁止 chmod 777`。echo 正常输出 = SHK hook 没挂。
3. **stage-guard 信号**：`.harness/current-stage.json` 不存在时尝试 Write 任何文件——SHK 自家 stage-guard 应 exit 2 提示进入 PLAN 阶段。直接放行 = SHK hook 没挂。

三个信号有一个出问题，就**先确认主仓库根 `.claude/settings.json` 真的存在**（步骤 2 是否做了），再考虑 restart 等次要因素。

## 日常使用回路

dogfooding 起效后，开发本仓库的每一项功能/修复都应走 SHK 自己的 6 阶段 Loop：

1. **Plan** — 跑 `/harness-start`（或手写 `.harness/current-plan.md`），声明阶段、引用 Constraint ID。
2. **Setup → Execute → Verify → Review** — hook 会按 [03-workflow.md](../methodology/03-workflow.md) 强制顺序。
3. **Feedback** — 出现摩擦/漏洞时跑 `/harness-feedback`，按 [08-feedback-loop.md](../methodology/08-feedback-loop.md) 的 F1-F5 流程把规则沉淀回 `methodology/` 或 `constraints.md`。

**关键诚实**：当你发现 SHK 自己的 hook 卡住你做正当工作时，**不要绕过它**——那条卡点就是产品 bug 候选，记到 session log 走 feedback 流。这是 dogfooding 价值的核心来源。

## 与下游用户的区别

| 场景 | 下游用户 | 本仓库维护者 |
|---|---|---|
| 目标 | 让自己的项目接入 SHK | 改进 SHK 本身 |
| 触发 | `bash install.sh` + `/harness-init`（针对**自己的项目目录**） | `bash install.sh` + `/harness-init`（针对**本仓库**） |
| .harness/ 状态 | 在他们项目里生成 | 在本仓库根生成（gitignored） |
| 验证 | 自己业务跑得稳 | dogfooding 摩擦点会变成 SHK 改进 |

## Bootstrap 不到位的几种典型表征

| 症状 | 含义 | 修复 |
|---|---|---|
| 提交时 commit-check.js 没跑、commit message 不被校验 | settings.json 未生成或 hooks 未挂载 | 重跑 `/harness-init` |
| Edit/Write 之前没有 stage-guard 阻断 | `.harness/current-stage.json` 不存在或路径不对 | 跑 `/harness-start` 进入 PLAN |
| `/harness-*` 系列 skill 找不到 | install.sh 未跑或 scope 选错 | `bash install.sh --target both --scope personal` |
| 钩子跑了但报"找不到 constraints.md" | 模板未实例化 | 在仓库根放一份 `constraints.md`（可空 placeholder） |

## 未来工作

- [ ] **TODO**：考虑加一个 `bootstrap-dogfood.sh` 顶层脚本，把 install.sh 的 skill 安装 + `harness-init` 等价行为合一执行。当前 `harness-init` 必须在 AI 客户端内跑，无法纯 shell 完成；这条 TODO 取决于是否能写一份非交互的 init 路径。
- [ ] CI 加 dogfood 就绪自检：当本仓库 PR 进来时检查贡献者有没有把"绕过 hook"的痕迹混进 PR（如 `--no-verify` 提交、未声明阶段直接 Write 等的提交模式）。

参考：[experiments/ecc-vs-shk/RESULTS.md](../experiments/ecc-vs-shk/RESULTS.md) 第 3 条与 backlog 第 1 项。

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

```bash
# 1. 装 SHK 的 skills 到本机的 Claude Code 和/或 Codex CLI
bash install.sh --target both --scope personal

# 2. 在本仓库根目录打开 Claude Code（或 Codex），让 AI 跑：
#    /harness-init
#    它会在本仓库生成: .claude/  .codex/  .harness/  以及对应 settings.json
#    这些目录都是 gitignored，每台机器各自生成。

# 3. 验证 dogfooding 起效：
#    在 Claude Code 里随便写一个文件，PreToolUse hook 应在没有 .harness/current-stage.json 时
#    拒绝并提示进入 PLAN 阶段。如果直接放行 = bootstrap 未完成。
```

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

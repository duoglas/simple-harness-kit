# Worktree 多 lane 工作模式

## 为什么需要 worktree

单 checkout 单 session 的局限：

- **任务 A 半截切去看任务 B**——主 checkout 工作区脏，stash/branch 切换打断思路
- **多 Agent 并行跑实验**——共享同一份代码会互相覆写
- **后台 session 跑长任务**——和前台交互踩同一个 working tree

git worktree 解决：一个仓库共享 `.git`，但每个 worktree 有自己的 working tree、独立分支、独立工作目录。Claude Code 的 `EnterWorktree` 在 `.claude/worktrees/<name>/` 下创建工作隔离。

## SHK 在 worktree 内的工作模型

**每个 worktree 是独立的 Harness 实例**：

| 内容 | 位置 | 生命周期 |
|---|---|---|
| `.harness/current-stage.json` | 各 worktree 自己的 | 该 worktree session |
| `.harness/current-plan.md` | 各 worktree 自己的 | 当前任务 |
| `.harness/session-log.md` | 各 worktree 自己的 | session 期 |
| `.harness/observations/` | 各 worktree 自己的 | 累积 |
| `.harness/verify-evidence.md` | 各 worktree 自己的 | 任务期 |
| `scripts/hooks/`、`.claude/settings.json` | git tracked / 共享 | 项目级 |

`.harness/` 永远 `.gitignore`——transient state 不进历史。worktree 因此**不会**通过 git 带过去任何活跃 stage，每个 worktree 在首次启动时由 `harness-session-start.js` 自举一个 fresh PLAN。

## find-root 边界（关键机制）

`scripts/hooks/find-root.js` 是所有 hook 的根定位器。它检测 cwd 是否匹配 `<anything>/.claude/worktrees/<name>(/...)?`，是则**停在 worktree 边界**返回，不再上探到主仓库。

这条规则是 worktree 隔离的物理保证。少了它：

- worktree 内的 SessionStart 会覆写主仓库的 active stage
- worktree 的 PLAN 写入路径会锚到主仓库
- 与 Claude Code 的 bg-isolation 守门冲突——bg session 必须把写入留在 worktree 内

详见 **C-WORK-02 + VH-17**。

## 何时该开 worktree

| 场景 | 用 worktree | 用主 checkout |
|---|---|---|
| 后台跑超过 5 分钟的任务 | ✓ | |
| 多 Agent 并行实验（A/B、SHK vs ECC 这种） | ✓ | |
| 任务 A 进行中要插入处理 hot fix | ✓ | |
| 跨分支临时对比 | ✓ | |
| 单一任务，主交互式 session | | ✓ |
| 改方法论 / 改 hook 本身 | | ✓（主 checkout，所有 worktree 共享改动） |

**反模式**：在 worktree 内修改 `scripts/hooks/`、`.claude/settings.json`、`methodology/`——这些是 git tracked 共享内容，应在主 checkout 改完 commit 后让其他 worktree 通过 `git pull` 或重新 `EnterWorktree` 获取。

## bg-isolation 与 worktree

Claude Code 的后台 session 默认开启 bg-isolation，强制 bg session 的 Write 必须落在 worktree 内。这是为了防止后台并发与前台主 checkout 互踩。

`find-root` 的 worktree 边界识别让 SHK 与 bg-isolation **同源对齐**：

- bg-isolation 要求 worktree 内写
- find-root 也返回 worktree 路径
- harness 守门的所有合法路径都在 worktree 内
- 两者不再冲突

如果某项目用了 SHK 但**没有**升级到 v0.9.0 的 find-root（VH-17 修复版本），bg session 进 worktree 后 PLAN→EXECUTE 切换会被永久拒（参考 VH-17 完整原因链）。

## 清理

`ExitWorktree action=remove` 会：

- 删 worktree 目录（含其 `.harness/`、`.claude/`、工作改动）
- 删 worktree 分支
- 提交未推送的 commit 会丢失（如果选了 `discard_changes=true`）

清理之前确认：

1. 已经 push 重要 commit
2. 没有还在用的 verify-evidence
3. session-log 中的偏差记录已迁移到 `methodology/` 改进（如果有）

## 相关约束

- **C-WORK-01**：每个 worktree 独立 `.harness/`
- **C-WORK-02**：`find-root` 在 worktree 内停边界
- **VH-17**：worktree × bg-isolation 死锁历史
- **C-HOOK-05**：hook 用项目根定位（与 C-WORK-02 配合）

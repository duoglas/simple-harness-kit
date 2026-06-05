# Harness 初始化 Prompt

> 将此文档 + methodology/ 目录一起发给 Claude / Codex，它即可为你的项目生成完整的 Harness 配置。

## 快速开始

告诉 AI：

```
读取 <kit 绝对路径>/init-prompt.md 和 <kit 绝对路径>/methodology/ 目录 (如 ~/ops/simple-harness-kit 或 D:\\simple-harness-kit, 按你实际 clone 位置填)。
为这个项目初始化 Harness。
```

AI 会自动扫描项目（package.json、技术栈、目录结构），不需要你手动填写项目信息。

如果有特殊情况需要补充，直接说：

```
补充：这个项目没有测试框架，重点约束 src/auth/ 目录。
```

## 生成清单

### 必选（基础设施，所有项目都必须生成，不可跳过）

| 组件 | 文件 | 作用 |
|------|------|------|
| 阶段声明强制 | `scripts/hooks/harness-stage-guard.js` | 强制新 session 声明 Harness 阶段，PLAN 阶段禁止写操作 |
| Session 初始化 | `scripts/hooks/harness-session-start.js` | 新 session 重置阶段、输出 banner |
| Codex 可见入口 | `scripts/hooks/harness-entry-banner.js` | UserPromptSubmit 注入 Codex 可见 banner/context fallback |
| 全过程记录 | `scripts/hooks/session-logger.js` | 自动记录工具调用到 session-log + observations |
| 安全防护 | `scripts/hooks/safety-guard.js` | 拦截 rm -rf、force push 等危险命令 |
| Session 结束收尾 | `scripts/hooks/session-end.js` | SessionEnd 时归档 observations + 写结束标记 |
| Stage since 自愈 | `scripts/hooks/stage-since-autofill.js` | `since:"auto"/"now"` sentinel 自动覆写为真实 ISO |
| Hook 共享依赖 | `scripts/hooks/find-root.js` / `scripts/lib/spec-quality.js` | hook 通过 `require('./find-root')` 定位项目根目录，通过 `require('../lib/spec-quality')` 共用 spec 质量判定。**AI 漏复制会导致 hook 报 MODULE_NOT_FOUND 或 hook/CLI 判定不一致**，必须与 hook 同步复制 |
| Hooks 配置 | `.claude/settings.json` | 注册所有 Hook 到 Claude Code |
| 项目说明 | `CLAUDE.md` | 项目级指令，指向 rules |
| 约束系统 | `docs/constraints.md` | 初始约束模板 |
| 角色约束 | `.claude/rules/role-constraints.md` | Director/Implementer/Reviewer 职责 |
| QA 标准 | `.claude/rules/qa-standards.md` | 量化验收指标 |
| 反馈流程 | `.claude/rules/feedback-workflow.md` | F1-F5 反馈处理 |
| 入口规则 | `.claude/rules/harness-entry.md` | 新 session banner + 等待指令 |

### 可选（按项目需要选配）

| 组件 | 文件 | 何时需要 | 何时跳过 |
|------|------|---------|---------|
| Agent 派发规范 | `.claude/rules/agent-dispatch.md` | 会派 Agent 做子任务 | 纯文档项目、不用 Agent |
| Agent prompt 合规 | `scripts/hooks/agent-check.js` | 有修复类 Agent 需要引用 Constraint ID | 不用 Agent |
| 验证门控 | `scripts/hooks/verification-gate.js` | 有测试框架，commit 前需要验证 | 无测试框架的早期项目 |
| 交付前复盘 | `scripts/hooks/delivery-review.js` | 有交付物（pdf/pptx/zip 等） | 纯代码项目 |
| Co-Authored-By 检查 | `scripts/hooks/commit-check.js` | 团队需要统计 AI 辅助占比 | 个人项目 |
| 上下文预算监控 | `scripts/hooks/context-monitor.js` | 长 session、复杂任务 | 短任务 |
| 持续学习 | `scripts/hooks/harness-learn.js` | 想从行为数据中发现模式 | 初期不需要 |
| Codex 兼容 | `AGENTS.md` | 同时用 Codex/Cursor | 只用 Claude Code |

## 生成后必须验证（C-INIT-03 + C-SKILL-03）

init 完成后，做 **5 项用户层完整性检查**（不要跑 kit 的 76 项 CI 工具 `e2e-acceptance-validate.sh`，那是 kit 维护者的工具，用户不需要看）：

1. **必选文件存在**: `.claude/settings.json` / `.claude/rules/` 下 4 个必选 .md (`role-constraints` / `qa-standards` / `feedback-workflow` / `harness-entry`) / `scripts/hooks/` 下 8 个必选 .js (`harness-stage-guard` / `harness-session-start` / `harness-entry-banner` / `session-logger` / `safety-guard` / `find-root` / `session-end` / `stage-since-autofill`) / `scripts/lib/spec-quality.js` / `docs/constraints.md` / `CLAUDE.md`
2. **settings.json JSON 有效**: `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"`
3. **hook 脚本存在**: settings.json 里每个 `command` 引用的 .js 都有对应文件
4. **hook 本地 require 依赖存在**: 对 settings.json 引用的每个 hook，扫描 `require('./...')` / `require('../...')` 这类本地依赖，确认目标文件存在；例如 `harness-stage-guard.js` 的 `require('../lib/spec-quality')` 必须对应 `scripts/lib/spec-quality.js`。缺依赖会导致新 session 一触发 hook 就 `MODULE_NOT_FOUND`，不能放行。
5. **CLAUDE.md 非空**: 大于 200 bytes，且是项目定制的（不是空模板）

全部通过 → 输出:

```
Harness init 完成 ✓
下一步: 开新 session (当前 session 的 hook 不生效), 输入任务开始工作
如需深度验证: bash <kit_root>/tests/e2e-acceptance-validate.sh
```

任何失败 → 输出失败项 + 修复 → 重新检查。

## Codex 用户注意

### 前提条件

1. **启用 canonical `hooks` feature**：当前 Codex CLI 中 `hooks` 已是 stable feature。推荐在 `~/.codex/config.toml` 写入：
   ```toml
   [features]
   hooks = true
   ```
   也可以每次启动时显式加 `--enable hooks`。不要使用旧版 deprecated feature alias。

2. **project-local hooks 放在 `.codex/hooks.json`**。顶层只使用 canonical `"hooks"`，结构为 event → matcher group → command handler；不要在同一层同时维护 `hooks.json` 和 inline `[hooks]` 的重复配置。

3. **project-local hooks 需要 trust/review**。新增或变更 `.codex/hooks.json` 后，Codex 可能先不运行这些 hook；请在新 session 里用 `/hooks` 检查并信任/review 项目 hooks。

### Codex Hook 覆盖

Codex 支持的事件类型：SessionStart、PreToolUse、PostToolUse、PermissionRequest、UserPromptSubmit、Stop。
不支持的事件：PostToolUseFailure、StopFailure、TaskCompleted、SessionEnd。

harness-init 生成 Codex 配置时会用 `scripts/generate-codex-hooks.js` 派生 `.codex/hooks.json`：
- `PreToolUse` 的 stage guard matcher 覆盖 `Bash|apply_patch|mcp__.*`，所以 PLAN 阶段可以放行只读 Bash，同时拦截普通写入、普通 patch 和 MCP 写入类工具。
- `PermissionRequest` 复用 stage guard，PLAN 阶段用官方 `decision.behavior` 响应拒绝权限升级。
- safety / session logger 等 Bash-only hook 仍保持 `Bash` matcher。
- hook command 通过 git/root wrapper 定位 `scripts/hooks/...`，不写脆弱的 repo 相对路径。

### init 命令

Codex 执行 init **必须使用 TUI 模式**（不能用 `codex exec` non-interactive）：

```bash
# ✅ 正确（TUI 模式）：
codex --enable hooks --sandbox workspace-write --ask-for-approval on-request
# 进入 TUI 后输入：
$harness-init
# 注意：是 $ 不是 /（详见后文 "在 Codex 里触发 skill"）

# ❌ 错误：codex exec 是 non-interactive，init 流程问 kit 路径时会卡死或时序错乱
codex exec --enable hooks "$harness-init"   # 不要用
```

**为什么必须 TUI**：init Step 0 需要交互定位 kit 仓库（询问/确认路径）。`exec` 模式没有 stdin 回路，AI 提的问题没人回答，要么超时要么乱跳。VH-15 现场已确认。

**为什么不再写旧的一键自动 flag**：新版 Codex CLI 已移除旧参数。需要显式开发权限时，用当前 flags：`--sandbox workspace-write --ask-for-approval on-request`；需要危险全绕过时只应在外部沙箱化的 CI/smoke 测试里使用 `--dangerously-bypass-approvals-and-sandbox`。

**install.sh 已经为你做了什么**：
- 写入 `~/.simple-harness-kit-root` 文件 → harness-init Step 0 自动定位 kit，不必手输
- 询问是否加 `alias codex='codex --enable hooks --sandbox workspace-write --ask-for-approval on-request'` 到 shell rc → 之后 `codex` 一行覆盖 hooks + 当前开发权限默认

### .codex/hooks.json 生成

harness-init 会自动检测 Codex 环境并生成 `.codex/hooks.json`（canonical `hooks` 顶层；不使用 deprecated feature alias）。

如果未自动生成，可手动：
```bash
node <KIT_ROOT>/scripts/generate-codex-hooks.js --input .claude/settings.json --output .codex/hooks.json
```

生成或变更后，启动新 Codex session 并运行 `/hooks` review/trust；未信任的 project-local hooks 可能不会执行。

### 日常启动 Codex（init 完成之后）

日常启动需要：(a) `hooks` feature 打开，(b) 至少 `workspace-write` sandbox，(c) project-local hooks 已通过 `/hooks` trust/review。**3 种方式择一即可**：

```bash
# 方式 1（推荐）：用 install.sh 询问时选 [Y]，写 alias 到 ~/.zshrc / ~/.bashrc
#   alias codex='codex --enable hooks --sandbox workspace-write --ask-for-approval on-request'
# 一行覆盖 hooks + 开发默认权限。alias 不递归，不会无限展开：
codex                       # 实际带上 --enable hooks --sandbox workspace-write --ask-for-approval on-request
codex exec "<任务>"          # 同样继承 alias 的全局 flags
$harness-init               # TUI 内输入，直接 work

# 方式 2（原生 + 配置）：写入 ~/.codex/config.toml
#   [features]
#   hooks = true
codex --sandbox workspace-write --ask-for-approval on-request

# 方式 3：每次都显式（最啰嗦，不推荐）
codex --enable hooks --sandbox workspace-write --ask-for-approval on-request
codex exec --enable hooks --sandbox workspace-write --ask-for-approval on-request "<任务>"
```

**临时绕过 alias**（极少需要，如想用更紧的 sandbox）：
```bash
\codex --sandbox read-only         # 反斜杠转义跳过 alias
command codex --sandbox read-only  # 等效
```

**与 Claude Code 日常启动的差异**：

| 项 | Claude Code | Codex |
|---|---|---|
| feature flag | 无需 | `hooks = true` 或 `--enable hooks` |
| sandbox | 无 | 建议显式 `workspace-write` |
| project hook trust | Claude Code trust 流程 | `/hooks` trust/review |
| 首次 init | 直接启动 | TUI 启动后输入 `$harness-init` |
| 后续 session | 直接启动 | 配好 config.toml/alias 后也直接启动 |

**排错**：如果日常 session 发现 Harness hook 完全不触发（`.harness/observations.jsonl` 无新增、没有阶段声明 banner）→ 先检查 `~/.codex/config.toml` 有没有 `[features] hooks = true`，再运行 `/hooks` 确认 project-local hooks 已 trust/review。

### 在 Codex 里触发 skill（重要差异：用 `$` 不是 `/`）

Codex 的 skill 触发机制和 Claude Code 不一样。Codex 系统提示里的 skill 规则是：

> "If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned."

**3 种触发方式**：

| 方式 | 例子 | 精准度 |
|---|---|---|
| (1) Sigil 显式调用 | `$harness-init` | 最精准 |
| (2) skill 名字 plain text | `用 harness-init 初始化` | 高 |
| (3) description 语义匹配 | `初始化 harness 配置` | 中（依赖模型判断） |

**关键差异**：

| 行为 | Claude Code | Codex |
|---|---|---|
| TUI 里输入 `/skill-name` | ✅ 真正的 dispatcher，触发 skill | ❌ "Unrecognized command"（`/` 只认内置 `/help` `/clear` 等） |
| TUI 里输入 `$skill-name` | 当文本进入对话 | ✅ 官方 sigil，触发 skill |
| 自然语言描述触发 | ✅ | ✅ |
| skill 跨轮持续 | ✅ 一旦激活后续轮自动维持 | ❌ **每轮必须重新提及** |

**结论**：Codex 用户**统一用 `$skill-name` 触发**（如 `$harness-init`、`$harness-start`、`$harness-feedback`），不要用 `/`。

CLI 模式里 `codex "/skill-name"` 之所以能 work，是因为 `/` 进入对话后被 AI 当作描述匹配 + 名字匹配触发——但这是侥幸，TUI 里就会被 slash 解析器拦截。统一 `$` 最稳。

**zsh 注意**：`$` 在 shell 里有变量展开语义，命令行传入需要转义：
```bash
codex --enable hooks --sandbox workspace-write --ask-for-approval on-request "\$harness-init"
# 或加单引号：
codex --enable hooks --sandbox workspace-write --ask-for-approval on-request '$harness-init'
```

## settings.json 最小配置

settings.json 必须至少包含以下 Hook 注册。**真实源是 `tests/required-wiring.json`** —— 模板/validate.sh/此配置块都从它派生，本节由 `template-integrity.js` 强制对齐，不允许手工漂移：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-session-start.js"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-entry-banner.js"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-stage-guard.js"
          }
        ]
      },
      {
        "matcher": "Edit",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-stage-guard.js"
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-stage-guard.js"
          }
        ]
      },
      {
        "matcher": "Agent",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-stage-guard.js"
          }
        ]
      },
      {
        "matcher": "TaskUpdate",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-stage-guard.js"
          }
        ]
      },
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-stage-guard.js"
          }
        ]
      },
      {
        "matcher": "Grep",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-stage-guard.js"
          }
        ]
      },
      {
        "matcher": "Glob",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-stage-guard.js"
          }
        ]
      },
      {
        "matcher": "WebFetch",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-stage-guard.js"
          }
        ]
      },
      {
        "matcher": "WebSearch",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-stage-guard.js"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/safety-guard.js"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Agent",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/session-logger.js"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/session-logger.js"
          }
        ]
      },
      {
        "matcher": "Edit",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/session-logger.js"
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/session-logger.js"
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/stage-since-autofill.js"
          }
        ],
        "description": "since sentinel (\"auto\"/\"now\") 自动覆写为真实 ISO (VH-14 Option A, C-HOOK-09)"
      }
    ],
    "PostToolUseFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/session-logger.js"
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/session-logger.js"
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/harness-stage-guard.js"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "D=$(cd \"$(pwd)\" && pwd -P);while [ \"$D\" != / ]&&[ ! -f \"$D/scripts/hooks/find-root.js\" ];do D=$(dirname \"$D\");done;[ -f \"$D/scripts/hooks/find-root.js\" ]&&cd \"$D\"&&node scripts/hooks/session-end.js"
          }
        ]
      }
    ]
  }
}
```

## 可选 Hook 与最小集的关系

**`tests/required-wiring.json` 是最小集（20 wirings），上面的 JSON 块严格等于这个最小集**。

**`templates/settings-json.tmpl` 是完整 superset**（最小集 + 下面 7 个可选 wiring），适合"想一次启用全部 optional 的项目"。

可选 wiring 清单：

| Event | Matcher | Script | 何时启用 |
|---|---|---|---|
| `PreToolUse` | `Bash` | `verification-gate.js` | 有测试框架，commit 前需要验证 |
| `PreToolUse` | `Bash` | `delivery-review.js` | 有交付物（pdf/pptx/zip 等） |
| `PreToolUse` | `Bash` | `commit-check.js` | 团队需要统计 AI 辅助占比 |
| `PreToolUse` | `Agent` | `agent-check.js` | 会派 Agent 做子任务，需要 Constraint ID 引用 |
| `PreToolUse` | `Edit` | `context-monitor.js` | 长 session 场景，需要超阈值提醒 compact |
| `PreToolUse` | `Write` | `context-monitor.js` | 同上 |
| `Stop` | (无 matcher) | `delivery-gate.js` | 严格交付守门——阻止在 EXECUTE/VERIFY(无证据)阶段宣称完成 |

**两种 init 策略**：

1. **最小集策略（推荐）**：从 `tests/required-wiring.json` 直接派生最小 settings.json，不含任何 optional wiring。再按上面表格根据项目需要逐项添加。`Stop` 段在最小集中**不存在**——只有添加 `delivery-gate.js` 时才出现。
2. **完整 superset 策略**：从 `templates/settings-json.tmpl` 复制完整版（含全部 optional），然后按"何时启用"列删除不需要的项。`Stop` 段在 template 中**存在**，需要根据是否启用 delivery-gate 决定是否保留。

详见 `skills/harness-init/SKILL.md` 第 3 步的"两种生成策略"对比段。

## AI 工具内测试准出 / E2E / 修复 loop

初始化后的项目默认把 SHK 能力接到 AI 工具工作流里，而不是要求用户记命令。

- 代码变更开始时，AI 先判断风险等级。
- VERIFY 阶段，AI 必须检查测试准出并写 evidence。
- medium / high / release 任务必须有 E2E 证据；只有 low 小改可以不强制 E2E；找不到 E2E 入口时，AI 只问一个具体启动问题。
- 新应用没有 E2E 时，AI 不能只报告缺失；要先用 `shk e2e inspect/bootstrap` 识别项目并生成第一套有正向、负向、真实断言和 evidence 的 E2E。
- E2E PASS 不等于充分；如果只是 echo ok、空脚本、只 smoke、或没覆盖本次风险，用户报告要先说“现在还不能交付”，再说明测到了什么、没测到什么、下一步补什么；机器状态放最后，例如：机器状态：NOT_SUFFICIENT。DEGRADED 不能说成 PASS。
- 测试失败后，AI 进入受控修复 loop：最多 3 轮，一轮只修一个失败点，重跑最小测试。
- 交付说明必须说人话，不能只贴日志，也不能把 DEGRADED 说成 PASS。

`shk quality status`、`shk e2e plan/run`、`shk loop state` 是 AI 的后端检查器，不是用户必须手动记住的入口。

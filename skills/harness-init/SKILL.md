---
name: harness-init
description: 为当前项目初始化完整的 Harness Engineering 配置（Rules、Hooks、Constraints、QA 标准）。Use when bootstrapping a new project or adding harness to an existing project.
---

# Harness Init

为当前项目生成完整的 Harness Engineering 配置。

## 何时使用

- 新建项目，需要搭建开发 Harness
- 已有项目，需要加装约束和 QA 体系
- 用户说"初始化 harness"或"搭建开发流程"

---

## 生成原则（不可违反，违反即视为 bug）

> 历史教训 VH-08（2026-04-08）：本 skill 的旧版本只画了文件树和必选清单，没有要求 AI 读取真实源。AI 走到这里时凭训练记忆拼 `.claude/settings.json`，结果生成了 Claude Code 不认识的 key 结构（`Invalid key in record`），用户重启 session 即报错。同一个失败模式在 templates ⇌ required-wiring.json 这一对上已经被 #16 / #23 修复过，但当时没意识到 SKILL.md 也是一份会"凭记忆生成"的入口。

约束 **C-INIT-04**（+ **C-SKILL-01** 路径解析约定）：

**路径解析约定**（C-SKILL-01, VH-10 教训）：本 SKILL.md 中所有 `./resources/xxx` 路径均**相对 SKILL.md 文件本身的位置**（通常是 `~/.claude/skills/harness-init/resources/` 或 `<project>/.claude/skills/harness-init/resources/`），这是 skill 安装后的真实路径，与 AI 当前 cwd 无关。kit 仓库相关的文件（hooks、templates/rules、e2e-acceptance-validate.sh）通过 Step 0 定位的 `$KIT_ROOT` 变量访问。cwd-relative 路径（如直接写 `simple-harness-kit/foo`）会直接失败——60+ 用户把 kit 放在任意位置。

1. **`.claude/settings.json` 不能凭记忆生成**。必须先读取 `./resources/settings-json.tmpl`（skill-relative），以模板为唯一真实源，再做项目定制（替换路径、可选 hook 增删）。
2. **Hook 脚本不能凭记忆生成**。必须从 kit 仓库 `scripts/hooks/` 读取对应脚本（定位方式见 Step 0），复制到目标项目，**不修改脚本内容**——它们是 kit 的一部分，会随升级更新。如目标项目用 monorepo，复制策略由项目结构决定，但脚本本体保持不变。
3. **Rules 文件不能凭记忆生成**。必须从 kit 仓库 `templates/rules/` 下的 `*.tmpl` 派生，做项目占位符替换。
4. **必选/可选组件清单以 `./resources/init-prompt.md` 为权威**（skill-relative）。本文件不复述清单——任何看到必选项变化的人，都必须改 init-prompt.md，而不是改这里。
5. **wiring（hook event/matcher 注册）以 `./resources/required-wiring.json` 为权威**（skill-relative）。这是工程层的 single source of truth，validate.sh 和 template-integrity 都从它派生。
6. **生成完毕后必须做 Step 4 的 4 项用户层完整性检查**（C-SKILL-03），全部通过才可宣称 init 完成。**不要**默认跑 kit CI 工具 `tests/e2e-acceptance-validate.sh`（那是 kit 维护者用的 76 项全量检查，不是用户 flow）。用户如需深度验证可自行跑。

任何"为了简化/适配/AI 觉得这样更好"而违反以上 6 条的行为，都是 bug，不是优化。

---

## 执行流程

### Step 0: 定位 kit 仓库（只为 Step 3 的脚本/rule 拷贝 + Step 4 的 validate.sh）

本 skill 已自包含 4 个关键资源（`./resources/` 下），Step 1 全部从 resources/ 读取。
但 Step 3 需要把 kit 的 `scripts/hooks/*.js` 和 `templates/rules/*.tmpl` 拷贝到目标项目——这一步需要知道 kit 仓库在哪。

**定位顺序**（取第一个命中且锚点校验通过的）：
1. 环境变量 `SIMPLE_HARNESS_KIT_ROOT` 指向的目录（若用户显式设置，最可信）
2. `~/.simple-harness-kit-root` 文件第一行（install.sh / update.sh 写入，用户运行过 install 即有）
3. 主动扫描以下候选位置 + 当前 SKILL.md 文件位置向上回溯（如 skill 在 `$HOME/.codex/skills/harness-init/SKILL.md`，回溯到 `$HOME/` 不会找到 kit；但若是 project-scope 装在 project root 的 `.claude/skills/harness-init/`，向上找可能命中 project root 下的 `simple-harness-kit/`）：
   - `~/simple-harness-kit`
   - `~/ops/simple-harness-kit`
   - `~/Projects/simple-harness-kit`
   - `~/code/simple-harness-kit`
   - `~/Dropbox/*/simple-harness-kit`（常见 Dropbox 结构）

   每个候选都必须做下面的 7 锚点校验。校验通过的候选**列出来让用户确认/选择**（多个候选时让用户输入数字），不得静默使用。
4. 让用户手动输入 kit 绝对路径

**优先级 (1) 和 (2)** 是用户已显式信任的源（设了 env var / 跑过 install.sh），校验通过即可使用，不必再问。
**优先级 (3)** 是自动扫描，校验通过的候选必须显式让用户确认。
**优先级 (4)** 是兜底。

**禁止**（C-SKILL-02, VH-10 后加强的 trust model 规则）：
- **不得**在用户当前 cwd 或其父目录自动"向上查找 `simple-harness-kit/`"然后静默使用。如果用户在 `/tmp/untrusted-project` 下工作，而该目录恰好有 `simple-harness-kit/` 子目录，自动信任这个"子目录" = supply-chain 攻击：恶意 kit 的 `install.sh` / `templates/rules/*.tmpl` / `scripts/hooks/*.js` 会被写入用户项目。必须用户显式确认。
- **不得**假设第一个找到的 `simple-harness-kit/` 目录就是真的。**必须做结构完整性校验**：定位到候选路径 `$CAND` 后，先校验以下所有文件/目录都存在且非空：
  - `$CAND/methodology/00-philosophy.md`（方法论根文档，真实文件名）
  - `$CAND/templates/settings-json.tmpl`
  - `$CAND/tests/required-wiring.json`
  - `$CAND/tests/template-integrity.js`
  - `$CAND/scripts/hooks/` 下至少 5 个 `.js` 文件
  - `$CAND/CHANGELOG.md` 首行含 `# Changelog`
  - `$CAND/init-prompt.md` 存在

  这 7 个锚点都是 kit 长期稳定的文件。任一不满足 → 拒绝使用该候选，回到定位流程 next priority。

- **必须**：优先级 (3) 主动扫描定位到候选 kit 路径时，**必须显式告诉用户**："我打算用 `$CAND` 作为 kit 仓库，这是你的安装位置吗？(确认/否)"。得到用户确认后才继续 Step 3/4。如果用户不确认 → 进入优先级 (4) 询问绝对路径。
- 优先级 (1)（env var）和 (2)（`~/.simple-harness-kit-root` 文件）已是用户显式信任的源（设了变量 / 跑过 install.sh 自己写的），校验通过后可直接使用，无需再问。

**反模式**（禁止）：
- 直接写 `simple-harness-kit/...` 这样的 cwd-relative 路径（VH-10 问题 B）
- 自动信任 cwd 向上搜索到的 `simple-harness-kit/`（VH-10 Codex gpt-5.4 round 3 F3 发现的 supply-chain 风险）

**Codex 模式提示**：如果你检测到当前是 Codex `exec` (non-interactive) 模式（hook stdin 的 `permission_mode === "bypassPermissions"` 且无法等待用户输入），且优先级 (1) (2) 都没命中、(3) 多个候选需要用户选择 / 确认 → 直接退出并提示用户："Codex exec 模式无法交互回答 kit 路径，请改用 TUI: 关掉当前会话, 跑 `codex --enable hooks --sandbox workspace-write --ask-for-approval on-request`, 进入 TUI 后再输 `\$harness-init`"。强行猜路径或继续 = VH-15 类回归。

### Step 1: 读取真实源（全部 skill-relative，cwd 无关）

依次 Read 以下文件，作为本次 init 的全部依据：

1. `./resources/init-prompt.md` —— 流程总纲、必选/可选组件清单、定制说明
2. `./resources/settings-json.tmpl` —— settings.json 唯一真实源
3. `./resources/required-wiring.json` —— hook wiring 唯一真实源
4. `./resources/hook-coverage-matrix.md` —— hook 覆盖矩阵，理解每个 wiring 的来由

这些路径相对 SKILL.md 文件本身，skill 安装到任何位置都能解析。
不要跳过这一步。不要"我已经知道大概结构"。

### Step 2: 自动扫描项目信息

按 init-prompt.md 描述的方式扫描：`package.json` / `pyproject.toml` / `go.mod` / 目录结构 / 已有 `CLAUDE.md` / 已有 `.claude/`。

### Step 3: 按 init-prompt.md 生成产物

完全遵循 `./resources/init-prompt.md` 的"必选 / 可选 / 定制"段落。`.claude/settings.json` 必须从 `./resources/settings-json.tmpl` 派生（**不是从记忆里写**）。

拷贝 kit 脚本和 rule 模板到目标项目时，用 Step 0 定位到的 kit 根目录 `$KIT_ROOT`：
- Hook 脚本源: `$KIT_ROOT/scripts/hooks/*.js`
- Rule 模板源: `$KIT_ROOT/templates/rules/*.tmpl`

> **生成 settings.json 的两种策略 — 默认走更安全的那条**：
>
> - **(推荐) 从 `./resources/required-wiring.json` 直接派生最小集** — 这是工程层的 single source of truth，只包含必选 wiring，不含 optional hooks。一行一行翻译成 `{event, matcher, hooks: [{type, command}]}` 即可。**优点**：默认安全，AI 不会"忘记删 optional"
> - **(高级) 从 `./resources/settings-json.tmpl` 复制后删 optional 条目** — template 包含 optional hooks (verification-gate / delivery-review / commit-check / agent-check / context-monitor / delivery-gate) 的预设 wiring。如果项目需要这些 hooks，按 init-prompt.md 的"可选组件"表判断保留哪些；其余必须删除。**风险**：AI 容易漏删，结果是 settings 引用了不存在的 hook 脚本（被 validate.sh E2 检查 catch，但多一次 round trip）
>
> 默认走第一种。只有当用户明确要求启用某个 optional hook 时，才走第二种并精确取舍。

### Step 3.5: 检测并生成 Codex 配置（如适用）

Step 3 生成了 Claude Code 的 `.claude/settings.json`。此步检测是否需要同时生成 Codex 的 `.codex/hooks.json`。

**检测方式**（按优先级，任一命中即视为需要 Codex 配置）：
1. 用户在 prompt 中提到了 "Codex" 或 "codex"
2. 项目中已有 `.codex/` 目录
3. 系统中 `which codex` 可用

**如检测到 Codex 适用**，向用户说明：

```
检测到 Codex 环境，我会额外生成:
  .codex/hooks.json — canonical hooks 配置（顶层 hooks，无 deprecated alias）

不需要 Codex 配置? 告诉我"跳过 Codex"。
```

用户确认（或未反对）后，生成步骤：
1. 读取刚生成的 `.claude/settings.json`
2. 用 `$KIT_ROOT/scripts/generate-codex-hooks.js` 派生 canonical `.codex/hooks.json`（顶层只含 `hooks`）
3. 确认 `PreToolUse` stage guard matcher 覆盖 `Bash|apply_patch|mcp__.*`
4. 确认包含 `PermissionRequest` guard，用官方 `decision.behavior` shape 拦截 PLAN 阶段权限升级
5. 确认没有 deprecated feature alias
6. 在输出中提醒：

```
Codex 用户注意:
  hooks feature flag 必须启用才能触发 Hook。
  推荐在 ~/.codex/config.toml 中添加:
    [features]
    hooks = true
  新增或变更 project-local hooks 后，请在新 session 里运行 /hooks 做 trust/review。
```

**如未检测到 Codex** — 跳过此步，不生成 `.codex/hooks.json`。

**手动工具**：如果 init 时未生成，用户后续可手动生成：
```bash
node $KIT_ROOT/scripts/generate-codex-hooks.js --input .claude/settings.json --output .codex/hooks.json
```

### Step 4: 验证 init 完整性（C-SKILL-03: 用户层最小集）

生成产物后，做以下 **4 项用户层检查**（不跑 76 项 kit CI）:

1. **必选文件存在**: `.claude/settings.json` / `.claude/rules/` 下 4 个必选 .md / `scripts/hooks/` 下必选 .js（至少 harness-stage-guard / harness-session-start / session-logger / safety-guard / find-root / session-end）/ `docs/constraints.md` / `CLAUDE.md`
2. **settings.json JSON 有效**: `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"`
3. **hook 脚本存在**: settings.json 里每个 `command` 引用的 `scripts/hooks/xxx.js` 都有对应文件
4. **CLAUDE.md 非空**: 大于 200 bytes
5. **Codex harness 检查（如生成 `.codex/hooks.json`）**: JSON 顶层是 canonical `hooks`、不含 deprecated alias、`PreToolUse` matcher 含 `Bash|apply_patch|mcp__.*`、包含 `PermissionRequest`、hook command 引用的脚本存在且可执行/可读

全部通过 → 输出:

```
Harness init 完成 ✓
下一步: 开新 session (当前 session 的 hook 不生效), 输入任务开始工作
Codex: 如生成/更新了 .codex/hooks.json，请在新 session 里运行 /hooks trust/review
如需深度验证: bash $KIT_ROOT/tests/e2e-acceptance-validate.sh
```

**任何失败** → 输出失败项 + 修复 → 重新检查。

**禁止**默认跑 `tests/e2e-acceptance-validate.sh` 的 76 项全量 CI 输出（C-SKILL-03）。那是 kit 维护者的工具，不是用户 init flow 的组成部分。用户想跑就给路径让用户自己决定。

---

## 注意事项

- 不覆盖已有的 `CLAUDE.md` 或 `.claude/settings.json`，而是合并
- `docs/constraints.md` 初始为空模板，随项目迭代逐步填充
- Hook 脚本需要 Node.js 环境
- Hook 配置写入后**当前 session 不生效，必须新 session**

## Codex 用户

Codex 用户执行 init 时必须使用 TUI 模式；推荐启动参数为 `codex --enable hooks --sandbox workspace-write --ask-for-approval on-request`。Step 3.5 会自动检测 Codex 环境并生成 canonical `.codex/hooks.json`。

如果 init 时未自动生成，可手动：
```bash
node $KIT_ROOT/scripts/generate-codex-hooks.js --input .claude/settings.json --output .codex/hooks.json
```

详见 `./resources/init-prompt.md` 中"Codex 用户注意"段。

## Attribution

如果项目已有 `README.md`，默认在底部追加：

```markdown
---
Harnessed by [Simple Harness Kit](https://github.com/duoglas/simple-harness-kit)
```

- 已有此标注则不重复
- 没有 README 不创建
- `HARNESS_ATTRIBUTION=off` 跳过

# Changelog

本仓库的所有版本变更记录在此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **Phase 2 Quality Engineering Gate**: SHK 现在不只是要求 AI “跑测试、交 evidence”，而是把 spec 变成交付流程的前置依赖。每轮 medium / high / release 任务必须先有有效 spec：需求是什么、准备怎么做、风险在哪里、要测哪些流量路径、验收证据是什么。没有 spec 不能开工，不能事后补文档冒充 spec。
- **Spec-backed workflow for AI tools**: 新增 `shk spec status` 作为 AI Harness 后端探针，用来检查 `.harness/iteration-spec.json` 是否完整，must 需求、风险点、测试计划、流量路径和验收项是否互相映射。没有 spec 是 `NOT_READY`；spec 写了但没覆盖关键需求/风险/流量，是 `NOT_SUFFICIENT`。
- **Test generation + effectiveness gate**: 目标工程缺 E2E 时，AI 不能只报告“缺测试”。它要先识别工程类型，再进入测试生成/bootstrap：Web/fullstack 优先 Playwright，已有 Cypress 就沿用，API 服务生成 API E2E。生成后的测试还要通过 `shk test effectiveness` 判断是否真的有效。
- **E2E sufficiency + test effectiveness in `verify`**: `shk verify` 现在聚合 `spec_status`、`e2e_sufficiency`、`test_effectiveness`。E2E PASS 不再等于可以交付；fake E2E、只打开首页、无真实断言、没覆盖本轮流量路径、没有 mutation/fault 证据，都不能变成 READY。
- **Bounded repair loop for insufficient delivery**: 新增 `auto-harness-loop-fix` skill，并把 loop 规则接入 `harness-start`、QA、review、santa、feedback 和项目入口模板。测试失败或 `NOT_SUFFICIENT` 时，AI 最多尝试 3 轮；每轮只修一个失败点，重跑最小测试，没进展就停下来说明原因，不自动 push/tag/release。
- **Phase 2 process doc**: 新增 `docs/quality-engineering-gate.md` 和 `docs/phase2-quality-gate/`，用人话解释第二阶段的 spec 驱动流程：SPEC → PLAN → EXECUTE → TEST GENERATION → TEST EFFECTIVENESS → VERIFY → REVIEW。文档明确这些 `shk` 命令是 AI Harness 的后端探针，不是让用户手动背的 CLI。
- **Real OSS dogfood for Phase 2**: 新增 `tests/scripts/17-oss-dogfood-validation.sh`。它不再只用 SHK 自己造的 fixture 证明测试有效，而是把 SHK 接入两个真实开源工程的临时副本：TodoMVC 前端和 Express API。正常代码下 E2E 必须通过；故意改坏真实源码后，同一条 E2E 必须失败；fake / smoke-only / 注释关键词脚本不能被当成 READY。
- **Upstream CI and browser E2E dogfood**: 新增 `tests/scripts/18-upstream-ci-dogfood.sh` 和 `tests/scripts/19-browser-e2e-dogfood.sh`。18 会真实跑 OSS npm install/ci，并把空壳上游 test 标成 `NO_PROOF`；19 会用 headless browser 打开真实 TodoMVC 页面，跑输入、DOM、计数、筛选和清理链路，再用 mutation 证明 UI 坏掉会被抓住。
- **Human-readable GitHub landing docs**: 重写 `README.md` / `README.zh-CN.md`，把首页从“方法论 + 命令清单”调整为“AI 工具内怎么用 SHK 交付一个目标工程”。新增 `docs/release-notes/v0.10.0-github.md` 和 `docs/release-notes/v0.11.0.md`，分别用于补强已发布的 v0.10.0 GitHub release 正文和准备 Phase 2 后续发布说明。

### Fixed

- **Delivery gate now requires fresh READY evidence**: REVIEW/FEEDBACK 阶段也不能在缺少 `.harness/verify-evidence.json`、证据不是 `READY`、证据过期、E2E 充分性不是 READY、测试有效性不是 READY 或包含 `DEGRADED` 时说“完成了”。失败、降级、缺证据和不充分必须原样告诉用户，不能包装成 PASS。
- **Release tag evidence gate**: release tag 要求 release 风险证据里 E2E、E2E 充分性和 runtime 都是 `PASS`；runtime 只要是 `DEGRADED`，tag 会被阻止并提示限制说明。

### Known Issues

- **Codex runtime smoke 仍可能 DEGRADED**: 当前 `codex exec` runtime 在部分环境会因为 `Operation not permitted` 无法完成完整 project hook smoke。这个状态必须原样报告，不能当作 runtime PASS，也不能用于 release READY。
- **PLAN Bash `sed -n` 仍存在写文件边界**: 当前 `harness-stage-guard.js` 将 `sed -n` 视为只读探索，但 `sed -n '1w pwned' input.txt` 这类 sed `w` command 仍可写文件。此项先记录为已知问题，后续应收窄 PLAN 阶段 sed 白名单或移除 sed 放行，并补回归 fixture。

## [0.10.0] - 2026-06-03

### Added

- **Quality Gate Suite MVP**: 新增 `scripts/shk.js` 命令面，支持 `verify --risk ... --write-evidence`、`doctor`、`security scan`、`test-infra assess`、`e2e detect`、profile dry-run/repair、skills consult、lane/benchmark MVP。(`3e82fbc`)
- **Structured verification evidence**: `shk verify` 生成 `.harness/verify-evidence.json`、`.harness/verify-evidence.md`、`docs/verification-report.md`；`verification-gate.js` commit/tag 前优先读取 JSON evidence，要求 `overall=READY`，tag 要求 release risk。(`3e82fbc`)
- **PreToolUse enforce observability**: `harness-stage-guard.js` 记录 `.harness/pretool-observations.jsonl`；`shk doctor` 能发现 “PostToolUse Bash 有记录但 PreToolUse 无记录” 的半失效状态。(`3e82fbc`)
- **Security / leak / config scanner**: `shk security scan` 检查 generic secrets、配置化 public leak patterns、以及 high-risk hook/MCP config；public kit 不内置组织私有词表。(`3e82fbc`)
- **Infra Tier Gate**: `shk test-infra assess` 生成 Tier 证据；stage-guard 会阻止 Tier 0 项目直接进入新 feature EXECUTE。(`3e82fbc`)
- **Profiles / cross-harness docs**: 新增 `manifests/shk-profiles.json`、`methodology/21-quality-gate-suite.md`、`methodology/22-cross-harness-matrix.md`、runtime smoke 占位说明。(`3e82fbc`)
- **Quality tests**: 新增 `tests/quality-suite.test.js` 并纳入 `tests/run.js` 总门控，覆盖 structured evidence、doctor、public leak/config scan、profile dry-run、Tier 0 EXECUTE gate。(`698b321`)
- **Codex-visible Harness entry**: 新增 `scripts/hooks/harness-entry-banner.js`，通过 `UserPromptSubmit` 输出 Codex 可解析 `hookSpecificOutput.additionalContext`，解决 SessionStart stderr/banner 在 Codex Desktop 新 session 不可见的问题。(`d54d3df`)

### Fixed

- **Codex stage switch deadlock**: `harness-stage-guard.js` 允许仅修改 `.harness/current-stage.json` 的 `apply_patch` 作为阶段切换/恢复通道，并复用 stage/since/Infra Tier/REVIEW gate 校验；修复 Codex 无 `Write` 工具时 PLAN/非法 stage 自锁。(`d54d3df`)
- **Project hooks sync without personal skills writes**: `update.sh` 新增 `--hooks-only <project>` / `--skip-skills`，项目只同步 hooks 时不触碰 `$HOME/.claude/skills` / `$HOME/.codex/skills`；Codex hooks.json 生成失败时输出失败文件和可手动执行的 generator 命令。(`9da7743`)

## [0.9.1] - 2026-06-02

### Changed

- **Codex harness bootstrap**: 保持现有 `install.sh` + `$harness-init` 入口不变，Codex 侧改用 canonical `hooks` 配置、AGENTS 首轮 PLAN 规则、`PreToolUse` 覆盖 `Bash|apply_patch|mcp__.*`、`PermissionRequest` 使用 `decision.behavior` 拦截 PLAN 权限升级，并提示 `/hooks` trust/review。
- **Codex CLI flags**: 移除活跃文档/脚本中已废弃的 `--full-auto` 推荐，改为当前显式 flags：`--enable hooks --sandbox workspace-write --ask-for-approval on-request`；非交互 smoke 保留 `--dangerously-bypass-approvals-and-sandbox` 仅用于 tmp 外部沙箱测试。

### Fixed

- **PLAN `apply_patch` stage bypass**: PLAN 阶段禁止 `apply_patch` 修改 `.harness/current-stage.json`，阶段切换必须走 `Write current-stage.json`，从而复用 stage/since 校验和 REVIEW gate。
- **PLAN Bash false negatives**: 收窄只读 Bash 白名单，拒绝 `find -delete/-exec`、quoted `find '-delete'`、newline chaining、backtick substitution、`rg --pre`、`git diff --output/--ext-diff/--textconv`、`sed -i` 等带写入或执行副作用的形式。

### Tests

- **Codex stage guard regression fixtures**: 新增 current-stage patch bypass、find destructive args、shell chaining/substitution、quoted find、rg preprocessor 等回归场景。`node tests/run.js --filter stage-guard` 最新为 `107 passed, 0 failed`。

## [0.9.0] - 2026-04-30

### Added — Preset 系统

- **`presets/` 目录**：默认两个 preset
  - `presets/generic/` — 等价于 methodology/12 的 Conventional Commits + Co-Authored-By
  - `presets/example-company/` — 公开范例，演示 TICKET-ID 前缀 + 受限分支 + 单 release 约束 + fork 来源约束 + feat-on-release 禁止
- **`scripts/hooks/load-preset.js`**：preset 加载器，支持 env / `.harness.local.json` / `.claude/settings.json` 三级解析 + extends 链 + 缺失自动回退到 generic
- **`scripts/hooks/branch-policy-guard.js`**：PreToolUse:Bash，按 active preset 阻 push 受保护分支 / 阻 feat-on-release / 阻 push --all/--mirror
- **`scripts/hooks/commit-check.js`** 扩展：subject 匹配 active preset 的 `subject_regex`（warn 级，与 Co-Authored-By 检查同风格，**opt-in**：仅在用户主动选 preset 时生效，详见下方 Fixed）；改进 `-m` 提取支持 single quotes 和 `--message=`
- **`templates/settings-json.tmpl`**：注册 branch-policy-guard hook
- **`.harness.local.example.json`**：committed 模板，展示如何选 preset + 设 author_prefix
- **`.gitignore`**：增 `.harness.local.json`（每台机器自己选 preset，不进 git）
- **`methodology/19-company-presets.md`**：解释 preset 系统、如何写公司 preset、双仓策略（公开框架 vs 私有 preset 内容）
- **`methodology/12-commit-standards.md`**：标注 generic 是默认 preset，preset 可覆盖 commit format 但不削弱 Co-Authored-By

### Fixed (back-compat)

- **`commit-check.js` subject 检查改 opt-in (back-compat for v0.8.x → v0.9.0)**: 默认 fallback 到 generic preset（即 `loadPreset().source === 'default'`）时跳过 subject_regex 校验，避免老用户升级后无 preset 配置就突然出现 conv-commit 格式 warning。仅在用户主动选了 preset（env `HARNESS_PRESET` / `.harness.local.json` / `.claude/settings.json` `harness.preset`）时才校验 subject。Co-Authored-By 检查（v0.8.x 起就有的行为）不变。新增 5 个 commit-check scenario 覆盖 opt-in 正负路径（详见 `tests/hook-scenarios/commit-check.json`）。
- **`branch-policy-guard.js`** 默认行为：generic preset 的 `protected_branches` / `merge_only_branches` / `type_blocked_on_branch` 均为空，hook 通过 `hasAnyPolicy=false` 早返；老用户升级后即使 settings.json 注册了该 hook 也是 no-op，零变化。

### Why this matters

公司 / 团队 / 项目对 commit 格式和分支策略有不同要求（例如 GitLab 服务端 hook 强制特定格式）。之前 harness-kit 写死 Conventional Commits，公司私有规则只能在外部维护。Preset 系统让规则数据驱动，AI 收到 active preset 即可遵循，无需重写硬编码。**对没有特殊需求的项目，零配置 = 零变化。**

### Known Issues

3 个 pre-existing test failures inherited from v0.8.x，与 v0.9.0 preset 系统改动无关，已计划 v0.9.1 修复：

- **`02-skill-path-resolution.sh`**: `install/uninstall` path resolution + `skill-relative` (`./resources/...`) 路径检查多项 FAIL，根因待排查
- **`03-full-e2e.sh`**: `e2e-acceptance-validate.sh` 无法从 `required-wiring.json` 加载 `required_files` 数组
- **`05-mutation-test.sh M2`**: 移除 mutation 后维度 02 应 PASS 但仍 FAIL（与 02 同根因）

`tests/pre-release-check.sh` exit 1 因 C-GATE-09 严格规则触发。Hook scenarios 段 (151 个) + template-integrity (T1-T16) + 其余 scripted matrix 全绿。**preset 系统本身的 138+ scenarios + 双 README + methodology/19 全部 PASS**，本次发版核心范围无 regression。

## [0.8.7] - 2026-04-17

### Fixed

- **kit template 子目录启 session MODULE_NOT_FOUND (VH-16)**: mind-palace 用户在子目录启动 Claude Code，Stop hook 报 `Cannot find module '<subdir>/scripts/hooks/delivery-gate.js'`。根因：`templates/settings-json.tmpl` + `skills/harness-init/resources/settings-json.tmpl` 用裸 `node scripts/hooks/X.js`，cwd=子目录时相对路径解析到不存在路径。所有用 kit init 出来的项目都有潜在 bug。修复：两份模板 + `init-prompt.md` 嵌入 sample 全部加 find-root shell wrapper（marker=`scripts/hooks/find-root.js`）。新增 C-HOOK-08 约束 + `tests/template-integrity.js` T16 自动守门。
- **VH-14 Option A sentinel 兑现 (C-HOOK-09)**: v0.8.1 的 Option B（`SINCE_DRIFT_LIMIT` 放宽到 30 分钟）在跨 hour 长 session 仍撞窗（dogfooding session 本次已撞 2 次）。Option A 落地：`harness-stage-guard.js::validateSince` 接受 `"auto"` / `"now"` sentinel，新增 `scripts/hooks/stage-since-autofill.js`（PostToolUse:Write）立即用真实 ISO 覆写。AI 不再需要手抄 `date -u` 输出。新增 10 个 hook-scenarios（sentinel 覆写 + 边界拒绝）。
- **05-mutation-test M1 假阴性**: 注入 `# rm -rf` 后 维度 01 应 FAIL 但通过。根因：install.sh 有 belt-and-suspenders 双重防御（`rm -rf` + `cp -r` src 尾斜杠），任一保留都能防止嵌套。M1 只破单防御，另一个仍防住。修复：M1 同时破坏两层（`rm -rf` 注释 + `${skill_dir%/}` 去尾斜杠）。
- **codex-smoke-selftest `RUN_EXIT` unbound variable**: 两个独立问题。(1) line 173 `echo "... exit=$RUN_EXIT）..."` 中的全角括号 `）`（UTF-8 EF BC 89）被 bash `set -u` 并进变量名，导致 `RUN_EXIT\xEF\xBC\x89` unbound。修复：`${RUN_EXIT}` 显式定界。(2) macOS 默认无 `timeout` 命令，导致 `timeout "$TIMEOUT_SEC" codex exec` exit 127（command not found），早于 `RUN_EXIT=$?` 赋值。修复：运行时探测 `timeout` / `gtimeout` / 无（警告不限时）。

### Added

- **`tests/pre-release-check.sh` + C-GATE-09 release gate**: 发版前强制机器门控三层检查（`tests/run.js` 全绿 + working tree 干净 + local ≡ origin/master）。任一 FAIL 拒绝 tag。接入 `docs/release-process.md` Step 0.7。背景：v0.8.6 带着 2 个 pre-existing `tests/run.js` FAIL 发布到 60+ 用户，Step 0/0.5 只跑 `template-integrity` + `run-all.sh`，不覆盖 `hook-scenarios/` / `codex-smoke.sh`。本次 VH-16 调查时才发现漏洞，补守门避免重犯。
- **`tests/template-integrity.js` T16**: 静态检查 `templates/settings-json.tmpl` + `init-prompt.md` sample 所有 hook command 含 find-root wrapper (C-HOOK-08)。
- **10 new `hook-scenarios/`**: 7 个 `stage-since-autofill.json`（sentinel 覆写 / 非目标 / 非 Write / JSON 损坏等）+ 3 个 `stage-guard.json`（auto/now 放行、invalid 仍拒）。

### Changed

- **`required-wiring.json`**: 新增 `scripts/hooks/stage-since-autofill.js` 为必选文件 + `PostToolUse:Write:stage-since-autofill.js` 为必选 wiring。
- **`templates/settings-json.tmpl` + `skills/harness-init/resources/settings-json.tmpl` + `init-prompt.md` + `resources/init-prompt.md`**: 所有 hook command wrap + 注册 autofill hook + 资源副本同步。
- **T3/T4/T6 regex**: 从 `scripts\/hooks\/([\w-]+\.js)` 改为 `node\s+scripts\/hooks\/([\w-]+\.js)` 以排除 wrapper 里 find-root.js marker 的干扰。

### Constraints

- **新 C-HOOK-08** (kit-level): settings.json hook command 必须用 find-root wrapper
- **新 C-HOOK-09** (kit-level): since sentinel + autofill
- **新 C-GATE-09** (kit-level): release 前 pre-release-check.sh 必须 exit 0
- **新 VH-16**: mind-palace 子目录 Stop hook 事件
- 双仓同步（workspace + kit）+ T10/T11/T12 PASS

## [0.8.6] - 2026-04-16

### Added

- **`tests/codex-init-smoke.sh`** — `$harness-init` 完整 E2E 自动化补齐 C-GATE-04 在 skill 入口的盲区
  - tmp 项目 + 预设 `SIMPLE_HARNESS_KIT_ROOT` env var → SKILL.md Step 0 优先级 (1) 命中跳过交互
  - `codex exec --dangerously-bypass-approvals-and-sandbox --enable hooks --skip-git-repo-check --ephemeral '$harness-init'` 触发
  - 断言 6 类产物：必选文件存在 / settings.json JSON 有效含 SessionStart+PreToolUse+PostToolUse / hook 脚本 ≥ 6 个含 5 必选 / 无 passthrough stdout / .codex/hooks.json JSON 有效（warn 级）/ codex 日志无 hook failed 标记
  - 默认 SKIP（opt-in via `CODEX_INIT_SMOKE=1`），单次跑 ~5 分钟
  - 集成到 `tests/run.js` 末尾（默认 SKIP，不卡日常 run）

### Constraints

- **C-GATE-04 自动化层补齐**: skill 入口 (`$harness-init`) E2E 之前只能手测，现在 `CODEX_INIT_SMOKE=1` 可机器跑。release 前 `CODEX_INIT_SMOKE=1 node tests/run.js` 双 smoke 全过

### Implementation Notes

发现并修了 2 个断言 bug（写在第一版自验里）：
1. `Stop` 事件不在 `tests/required-wiring.json` 必选清单（关联 optional 的 delivery-gate.js），原来误判为必选
2. `hook (failed)` / `invalid pre-tool-use JSON output` 这些字符串作为引用文字出现在 `docs/constraints.md` (VH-13/VH-15 描述里)，被 codex 写文件后 echo 到 log 误匹配。改用严格行首/缩进锚点：`^hook: <Event> Failed$` / `^[[:space:]]+error: hook returned invalid` 区分 codex emission 和文件内容

## [0.8.5] - 2026-04-16

### Documentation

- **README.md / README.zh-CN.md 同步 v0.8.3 / v0.8.4 更新**:
  - **Step 1**: 加 install.sh 行为说明（写 `~/.simple-harness-kit-root` + 询问 alias）
  - **Step 2**: 拆分 Claude Code 和 Codex 启动命令；明确 Codex 必须 TUI 模式 + `$harness-init`（`$` 不是 `/`）
  - **Step 3**: skill 触发示例同时给出 `/skill-name` (Claude) 和 `$skill-name` (Codex) 两种形式
- 用户反馈："readme 更新了么" → README 之前漏掉了 v0.8.3/v0.8.4 几个核心 UX 改进，对新用户首屏完全不可见

## [0.8.4] - 2026-04-16

### Changed

- **Codex alias 包含 `--full-auto`**: install.sh 询问的 alias 从 `codex --enable hooks` 升级为 `codex --enable hooks --full-auto`。一行覆盖 init + 日常 session，省去用户每次手动加 `--full-auto`。
  - **动机**: 用户反馈"设置了 alias 以后为什么还要手动 --full-auto"。原 alias 只覆盖 `hooks` flag，init 和日常都还得记得手动加 `--full-auto`，UX 不到位。
  - **风险**: `--full-auto` = `workspace-write sandbox + on-request approval`，比 default 略宽松，但对开发场景是合理默认。bypass: `\codex` 反斜杠转义或 `command codex`。
- **`init-prompt.md` 日常启动段重写**: 3 种方式对比表更新，明确"为什么 alias 要带 `--full-auto`"，加 escape alias 用法

### Migration

升级到 v0.8.4 后，**已装 v0.8.3 alias 的用户**：
1. 跑 `bash install.sh` 不会重复写（幂等标记块检测到已存在跳过）
2. **手动**编辑 `~/.zshrc` / `~/.bashrc` 把 `alias codex='codex --enable hooks'` 改成 `alias codex='codex --enable hooks --full-auto'`
3. 或先删除 `# >>> simple-harness-kit alias >>>` 标记块再 `bash install.sh` 重写

## [0.8.3] - 2026-04-16

### Added

- **install.sh / update.sh 写 `~/.simple-harness-kit-root`**: 持久化 kit 绝对路径到家目录单文件。`harness-init` Step 0 优先读取此文件（仅次于 `SIMPLE_HARNESS_KIT_ROOT` 环境变量），用户运行过 install 即不必再手动告诉 kit 在哪。每次 update.sh 也刷新（kit 移动后路径同步）
- **install.sh 交互式询问 alias**: Codex 安装后询问"是否将 `alias codex='codex --enable hooks'` 写入 `~/.zshrc` / `~/.bashrc`?"。三选: `[Y]es 自动写` / `[n]o 打印让你手动加` / `[s]kip silently`。用 `# >>> simple-harness-kit alias >>>` 标记块幂等，二次 install 检测到跳过。非 TTY (CI / 管道) 默认 skip 不打扰
- **SKILL.md Step 0 主动扫描 + 用户确认**: 优先级改为 `env > 文件 > 主动扫描 > 手动`。主动扫描候选含 `~/simple-harness-kit` / `~/ops/...` / `~/Projects/...` / `~/code/...` / `~/Dropbox/*/simple-harness-kit`，每个候选做 7 锚点完整性校验，校验通过的列给用户确认（C-SKILL-02 显式确认仍然强制）
- **SKILL.md Codex 模式提示**: 检测到 exec (non-interactive) 模式且 kit 路径需要交互定位时，AI 应直接退出并提示用户改用 TUI

### Fixed

- **`init-prompt.md` Codex skill 触发 sigil 文档** (来自 v0.8.2 后续): 明确 Codex 0.118.0 用 `$skill-name`（不是 `/skill-name`），TUI `/` 只认内置命令。包含 3 种触发方式对比表 + Claude Code vs Codex 行为差异表 + zsh 转义提示
- **`init-prompt.md` 强调 init 必须 TUI**: 删除"`codex exec --full-auto --enable hooks "/harness-init"`"建议（exec 模式无法回答 Step 0 问 kit 路径，会卡死或乱跳）。改为：必须 TUI 模式启动 codex 后输入 `$harness-init`
- **install.sh "下一步" Codex 段同步**: 删除 `codex exec`，改为 TUI 模式 + `$harness-init` 触发

### Constraints

- **更新 C-SKILL-02**: Step 0 优先级新增 (2) `~/.simple-harness-kit-root` 文件读取，与 env var 同列为"用户已显式信任的源"，校验通过即可使用，无需再问
- **VH-15 后续确认**: 用户在另一台机器（pre-VH-13 hooks 残留）成功重现 "PreToolUse hook (failed)"。确认 VH-15 真实 root cause 是 target 项目 hook 副本未随 kit 升级。立即 fix: `bash <kit>/update.sh --hooks <project>`

### Migration Notes

- **现有用户 (v0.8.x)**: `git pull && bash install.sh` 一次即可，会询问 alias 并写 kit-root 文件
- **新机器**: `git clone ... && bash install.sh` 流程不变，新增 alias 询问步骤
- **Codex 用户重要**: 如果你之前用 `codex exec "/harness-init"` 跑 init —— 这个会卡，换成：
  ```
  codex --full-auto --enable hooks   # TUI
  $harness-init                            # 在 TUI 里输（$ 不是 /）
  ```

## [0.8.2] - 2026-04-16

### Added

- **Codex runtime 冒烟测试 (C-GATE-08, VH-15)**: 新增 `tests/codex-smoke.sh` — 在真实 Codex CLI 上执行 "Read README.md" 最小任务，断言 hook 层无 "hook: * Failed" / "hook returned invalid" 告警。默认策略：无 codex → SKIP + warn；`CODEX_REQUIRED=1` → 升级为 FAIL。兑现 VH-13 遗留的"加固 TODO"
- **Smoke 反向自测**: 新增 `tests/codex-smoke-selftest.sh` — 注入一个 stdout 写非法 JSON 的坏 hook，断言 `codex-smoke.sh` 能正确 FAIL。防止 smoke 的 grep 断言因 Codex 输出格式变化而静默失效
- **`tests/run.js` Codex Smoke 集成**: 在 hook scenarios + template integrity + scripted matrix 之后自动运行 smoke + selftest，结果纳入 run.js 总 pass/fail 统计

### Constraints

- **新增 C-GATE-08**: Codex runtime 兼容性必须机器守门 — `tests/codex-smoke.sh` + `codex-smoke-selftest.sh` + `tests/run.js` 集成。禁止"加固 TODO"模式
- **新增 VH-15**: v0.8.1 后用户在 Codex `/harness-init` 仍报 "invalid JSON output"。调查结论：kit 代码无 bug（v0.8.1 hooks empty stdout 通过冒烟测试），最可能根因是 target 项目残留 pre-VH-13 旧 hook。真正教训：VH-13 "加固 TODO" 未当即兑现，用户仍是唯一回归 catcher

### Tests

- 全量 hook scenarios 139 PASS（不变）+ template integrity 19 PASS + Codex smoke PASS + selftest PASS

### Migration Notes

无需用户迁移。新增测试脚本不影响 hook 行为。升级路径：
- `git pull && bash update.sh` 即可
- 如果 target 项目仍有 Codex hook 报错，运行 `bash update.sh --hooks` 刷新项目 hook 脚本到 v0.8.2

## [0.8.1] - 2026-04-15

### Fixed

- **Codex runtime hook JSON schema 兼容 (VH-13, P0)**: 删除 9 个 hook 共 19 处放行分支 `process.stdout.write(raw)` 调用。Codex 0.118.0 严格按决策响应 schema parse PreToolUse hook 的 stdout，原 passthrough 写回的是请求 JSON（`tool_name`/`tool_input`/`hook_event_name`），每次 Bash 调用都报 "PreToolUse hook (failed) - invalid pre-tool-use JSON output"。改用空 stdout + exit 0，两个 runtime 都视为 allow-unchanged。受影响文件：`harness-stage-guard.js`、`verification-gate.js`、`session-logger.js`、`session-end.js`、`safety-guard.js`、`context-monitor.js`、`agent-check.js`、`delivery-review.js`、`commit-check.js`
- **`init-prompt.md` 日常启动 Codex 文档补齐**: 新增 "### 日常启动 Codex（init 完成之后）" 小节，说明 init 之后不需要 `--full-auto`、仍需 `hooks` feature flag、默认 `workspace-write` sandbox 够用、与 Claude Code 差异对照表、以及 "hook 完全不触发 → 99% 是 flag 没开" 的排错提示
- **`skills/harness-init/resources/init-prompt.md`**: byte-identical 同步上述文档
- **`harness-stage-guard.js` since drift 窗口放宽 (VH-14)**: `SINCE_DRIFT_LIMIT` 从 5 分钟放宽到 30 分钟。用户反馈"经常出现时间戳不一致的问题"——AI 写 `.harness/current-stage.json` 需要手抄 `since` 字段，5 分钟窗口容错过小，跨 tool 调用的墙钟漂移频繁触壁。30 分钟窗口远大于正常 AI 手抄 drift，远小于"有意回拨到覆盖 evidence mtime"所需跨度，invariant 仍成立

### Changed

- **`tests/run.js` stdout 契约**: 新增 `"stdout": "empty"` 期望语义，表示 hook stdout 必须为空（Codex 兼容要求）。原 `"stdout": "passthrough"` 标记为 deprecated 但保留兼容
- **全部 hook 场景测试**: 60+ 场景从 `"stdout": "passthrough"` 迁移到 `"stdout": "empty"`，确保回归覆盖新契约
- **`tests/run.js` 时间戳占位符**: 新增 `TS_OFFSET_<±N><S|M|H>` 通用占位符（如 `TS_OFFSET_-15M` = 15 分钟前），支持 since drift 边界场景测试；`RECENT_TIMESTAMP` 保留兼容

### Constraints

- **新增 VH-13**: v0.8.0 发布后 Codex runtime hook JSON 不兼容 P0 bug 的根因分析（workspace + kit 双份）
- **新增 VH-14**: 5 分钟 since drift 窗口过严的 UX 反馈 + 放宽到 30 分钟的决策依据（workspace + kit 双份）
- **更新 C-GATE-04 加固 TODO**: `tests/e2e-acceptance-validate.sh` 应增加 "Codex session log 无 'hook (failed)'" 断言（下次迭代实施）

### Tests

- 全量测试 139 passed, 0 failed（从 136 → +3 VH-14 边界场景：15 分钟过去 PASS、45 分钟过去 REJECT、20 分钟未来 PASS）

### Migration Notes

无需用户迁移。此 patch 只删代码 + 放宽常量、不改接口。升级路径：
- Claude Code 用户：`bash update.sh` 即可（hook 行为保持不变，时间戳限制更宽松）
- Codex 用户：`bash update.sh --target codex` 后，原来每次 Bash 的 "invalid pre-tool-use JSON output" 噪声消失

## [0.8.0] - 2026-04-15

### Added

- **install.sh / update.sh 双工具支持**: 新增 `--target claude|codex|both` 参数 + 交互式选择菜单（TTY 感知），默认安装到所有已检测到的工具。装 Claude Code → `~/.claude/skills/`，装 Codex → `~/.codex/skills/`，both → 两处都装。支持 `--scope personal|project` (10734e5)
- **`scripts/generate-codex-hooks.js`**: 从 `.claude/settings.json` 派生 `.codex/hooks.json`，过滤 Codex 不支持的事件（PostToolUseFailure / StopFailure / TaskCompleted / SessionEnd），保留 SessionStart / PreToolUse / PostToolUse / Stop / UserPromptSubmit (10734e5)
- **`skills/harness-init` Step 3.5**: init 流程自动检测 Codex 环境（用户 prompt 提及 Codex / 存在 `.codex/` / `which codex`），自动生成 `.codex/hooks.json`，用户可跳过 (10734e5)
- **`verification-gate.js` 第 4 层守门（C-GATE-07, VH-12 加固）**: 当 commit 触及 `install.sh` / `update.sh` / `init-prompt.md` / `SKILL.md` / `resources/init-prompt.md` / `generate-codex-hooks.js` 任一文件时，`verify-evidence.md` 必须同时含三个 runtime 标记（`独立 agent` / `Claude Code` / `Codex`），缺任一 `exit 2`。仅在 kit 仓库触发（`tests/template-integrity.js` 存在性检测），不影响 60+ 用户项目。紧急豁免：`HARNESS_SKIP_GATE=1` + commit message 记录原因 (ae1ba6e)
- **`tests/run.js` gitSetup 支持**: scenario 可声明 `gitSetup: { stage: [...] }`，runner 在 tmp dir 内 `git init` 并 stage 指定文件，供 verification-gate C-GATE-07 场景测试 (ae1ba6e)
- **5 个新 verification-gate 场景**: 覆盖 C-GATE-07 的正反路径（kit 触及入口文件 + 证据缺模式 → 阻止；kit 触及入口文件 + 证据齐全 → 放行；kit 触及非入口文件 → 放行；非 kit 触及同名文件 → 放行） (ae1ba6e)

### Fixed

- **`init-prompt.md`**: 删除"Codex 用 `--full-auto` 或 `-s workspace-write`"的错误描述，改为仅允许 `--full-auto`，并解释 sandbox 限制原因（Codex 0.118.0 在 `workspace-write` 下把 `.codex/` 视为受保护目录，`mkdir .codex` 会被拒绝）。E2E 实测验证 (4996c97)
- **`skills/harness-init/resources/init-prompt.md`**: byte-identical 同步上述修复 (4996c97)

### Changed

- 12 个 hook 的 `@version` 统一 bump 0.7.0/0.7.4 → 0.8.0

### Constraints

- **新增 C-GATE-07** (kit-level meta): 用户入口变更强制三模式证据（实现在 `verification-gate.js`）
- **新增 VH-12**: 记录 install.sh 双工具 PR 在 REVIEW 阶段主动豁免 C-GATE-04 的根因 + 机器守门补丁

### Tests

- 全量测试 136 passed, 0 failed（从 131 → +5 C-GATE-07 场景）

### Migration Notes

- **双工具用户**：`install.sh --target both` 或 `update.sh` 会同时维护 `~/.claude/skills/` 和 `~/.codex/skills/`，已安装任一的用户升级后会被正确检测
- **Codex 用户**：init 时必须加 `--full-auto`（文档之前写的 `-s workspace-write` 在 0.118.0 下无效）
- **kit 维护者**：修改用户入口文件时，verify-evidence 必须贴三个 runtime 实测结果，否则 commit 被阻。紧急情况用 `HARNESS_SKIP_GATE=1`

## [0.7.3] - 2026-04-11

### Fixed

- `harness-stage-guard.js`: `validateStageWrite()` 增加 stage 值合法性校验，写入 "COMPLETE" 等无效值时直接 exit 2 阻止（Issue #2 预防层）
- `harness-stage-guard.js`: 已有无效 stage 文件时的错误消息增加修复指引（Write 示例 + date 命令），AI 可自行修复而非锁死用户（Issue #2 恢复层）

### Tests

- 新增 5 个测试场景 (T1-T5): 写入无效值阻止、读取无效值指引、修复路径放行

## [0.7.2] - 2026-04-09

### Migration Notes for VH-10

**🚨 P0 修复 — 所有 v0.7.0 / v0.7.1 使用者 `/harness-init` 路径都应拉取**

#### 故障表现

v0.7.0 / v0.7.1 交付后用户连续反馈两个 P0 低级 bug:

1. **问题 A（嵌套目录）**: `bash install.sh` 或 `bash update.sh` 第二次及以后执行，会在 `~/.claude/skills/harness-init/` 里产生 `harness-init/harness-init/SKILL.md` 嵌套。根因：`install.sh` / `update.sh` 第 63 行的 `cp -r "$src" "$dst/$name"` 在 dst 已存在时的 POSIX 行为是"把 source 作为 subdir 嵌入 dst"。

2. **问题 B（cwd-relative 路径失效）**: `skills/harness-init/SKILL.md` 硬编码 `simple-harness-kit/templates/settings-json.tmpl` 类 cwd-relative 路径，60+ 用户的 cwd 不是 kit 父目录（例如 kit 在 D 盘），`/harness-init` skill 启动即报 "无法找到 simple-harness-kit"。

#### 影响范围

- **问题 A 影响**: 所有跑过二次 `install.sh` 或 `update.sh` 的用户（包括本地开发、CI、升级场景），skill 目录损坏，新 session 找不到 SKILL.md
- **问题 B 影响**: 所有 cwd 不是 kit 父目录的用户（绝大多数真实场景）， `/harness-init` slash command 路径入口直接不可用
- **不影响已经 init 好、只用 hooks 的项目** — 老 hook 脚本不受影响，只影响用 skill 入口的新 init / 更新流程

#### 升级步骤

```bash
# Step 1: 拉取最新 kit
cd /path/to/simple-harness-kit
git fetch origin
git checkout master
git pull origin master
git describe --tags  # 应当看到 v0.7.2

# Step 2: 如果之前有嵌套目录损坏，手动清理再重装
rm -rf ~/.claude/skills/harness-init
bash install.sh   # 幂等安装，新版本不会再产生嵌套

# Step 3: 新 session 里跑 /harness-init 就能正常工作
```

#### Added

- `skills/harness-init/resources/` — skill 自包含 4 个关键资源副本（方案 C），`SKILL.md` 用 `./resources/*` skill-relative 路径引用，彻底解耦 cwd 假设
- `skills/harness-init/SKILL.md` Step 0 — kit 仓库定位逻辑（环境变量优先 + 结构完整性校验 + 显式用户确认），防 supply-chain 影子仓库欺骗
- `tests/scripts/` — 全新 7 维度脚本化测试矩阵（100% 不依赖 AI 能力，可在任意 CI 跑）:
  - `01-script-idempotency.sh` install/update 幂等性
  - `02-skill-path-resolution.sh` SKILL.md 中所有路径在真实用户 cwd 下可解析（含 kit-internal 白名单 + 路径穿越 `..` 检测 + 绝对路径存在性校验）
  - `03-full-e2e.sh` install → 模拟 init 链路
  - `04-dir-structure-invariant.sh` manifest 不变式
  - `05-mutation-test.sh` 9 类 bug 注入反测（M1-M9 双向证明）
  - `06-path-style-matrix.sh` plain/空格/中文/超长路径 × 维度 1+4
  - `07-scope-branches.sh` --scope personal / project 两种路径
  - `run-all.sh` 主 runner + meta L1（语法）/ L2（断言计数）/ L6（multi-shell）
- `tests/template-integrity.js` T12 — `skills/harness-init/resources/` 与 kit 源文件 byte-identical 同步守门
- `tests/template-integrity.js` T13 — SKILL.md Step 0 含 C-SKILL-02 trust model 守门静态检查
- `tests/template-integrity.js` T14 — SKILL.md Step 0 完整性校验锚点在 kit 里真实存在（防声明的文件名与实际不符的漂移, 阶段 4 验收发现）
- `tests/template-integrity.js` T15 — `qa-standards.md.tmpl` 含 9 个必需行为短语（TDD 铁律 / Layer 1-5 / VERIFICATION REPORT / Reviewer / pass@1, Issue #1 / VH-11）
- `docs/constraints.md` JC-07 — VH-10 + C-SKILL-01 + **C-SKILL-02 (trust model)** + **C-SKILL-03 (Skill UX 边界)** + C-TEST-04 + C-TEST-05 + C-TEST-06 + C-HOOK-07
- `docs/release-process.md` Step 0.5 — Scripted Test Matrix 强制 gate，release 前必须 `bash tests/scripts/run-all.sh` 全 PASS
- `methodology/04-qa-pyramid.md` Layer 2 铁律 — "实弹测试不得绕过被测组件"
- `methodology/08-feedback-loop.md` — VH-10 教训段 + F 层铁律（5 条脚本化测试硬要求）

### Fixed

- **`install.sh` + `update.sh` 幂等性** (VH-10 问题 A): `cp -r "$src" "$dst/$name"` 改为 `rm -rf "$dst/$name" && cp -r "$src" "$dst/$name"`，二次及多次执行不再产生嵌套目录
- **`skills/harness-init/SKILL.md` 路径解析** (VH-10 问题 B): 硬编码 `simple-harness-kit/...` 路径全部改为 `./resources/*` (skill-relative) 或 `$KIT_ROOT/*` (Step 0 定位的变量)
- **`templates/rules/commit-standards.md.tmpl`** + **`templates/rules/feedback-workflow.md.tmpl`**: 清除派生到用户项目的 cwd-relative kit 路径引用（用户项目下这些路径无法解析）
- **`skills/harness-init/SKILL.md` 完整性校验锚点** (阶段 4 验收发现): `methodology/00-overview.md` → `methodology/00-philosophy.md`（真实文件名）+ 新增 `init-prompt.md` 锚点, 共 7 个
- **`scripts/hooks/harness-stage-guard.js` macOS symlink 路径比较** (阶段 5 验收发现): `/tmp` → `/private/tmp` symlink 导致 `path.resolve()` 比较不一致 → PLAN 阶段 Write `.harness/current-stage.json` 被错误阻止 → AI 死锁。改用 `fs.realpathSync()` 统一真实路径
- **`templates/rules/qa-standards.md.tmpl` 从骨架改为完整 5 层 QA** (Issue #1 / VH-11): 56 行占位符 → ~130 行含 TDD 铁律 "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST" + Layer 1-5 + Santa Method + VERIFICATION REPORT 格式 + 量化指标。A/B 对比证明: 旧模板 → AI 直接写代码; 新模板 → AI 先补测试基建再写功能
- **`skills/harness-init/SKILL.md` Step 4 用户层 UX** (C-SKILL-03): init 结束不再默认跑 76 项 kit CI，改为 4 项用户层最小集检查，输出 "Harness init 完成 ✓"

### Changed

- `methodology/15-hook-coverage-matrix.md` + `init-prompt.md`: 把"一致性检查清单"和"Codex 用户示例"里的 `simple-harness-kit/xxx` 硬编码改为相对 kit 根目录的说明

### Constraint 系统

- 新增约束 (7)：C-SKILL-01 / C-SKILL-02 / C-SKILL-03 / C-TEST-04 / C-TEST-05 / C-TEST-06 / C-HOOK-07
- 扩展约束 (2)：C-GATE-02 (3-random-dir + sub-agent 反模式) + C-GATE-04 (4 层验收矩阵: 机制+内容+行为+产出)
- 新增 VH：VH-10（路径/幂等, 5 层失效分析）+ VH-11（模板内容质量, "机制完整 ≠ 产出有效"）
- workspace (`harness-dogfood`) ↔ kit 两份 constraints.md 同步双写（C-META-04 守门）

### 质量工程成果

- 测试: **127 passed, 0 failed, 127 total**（107 hook scenarios + **19 template-integrity T1-T15** + 1 Scripted Matrix 7 维度聚合）
- 脚本化矩阵: **7 / 7 维度**
- Mutation: **21 / 21** (M1-M9 bug 注入双向证明 + 2 baseline)
- 跨模型交叉验收: 4 轮, Claude Opus 4.6 实现 + Sub-agent A spec(15/15) + Sub-agent B test-replay(APPROVE WITH NOTES, 修 3 盲区) + Codex gpt-oss-120b(round 1/2 找 1 盲区) + **Codex gpt-5.4(round 3 找 3 block 级缺陷, round 4 零发现 APPROVE)**
- 收敛曲线: 每轮 cross-review 发现递减，round 4 零发现 = release gate 关闭

### v0.7.3 backlog (本 release 不包含)

- H5/H6 theoretical: `$HOME/...` 变量路径解析后存在性校验 / symlink 跟随 fs.realpath
- Codex round 4 未发现新 bug，但以上 2 条是 gpt-oss-120b round 2 提出的低概率 edge case

## [0.7.1] - 2026-04-08

### Migration Notes for VH-09

**🚨 Meta 约束仓库同步修复 — 所有 v0.7.0 使用者都应拉取**

#### 故障表现

- v0.7.0 及之前 release 中，kit 仓库的 `docs/constraints.md` **长期滞后于 dogfooding workspace** 的 `docs/constraints.md`
- 具体缺失：`C-HOOK-06` / `C-GATE-04` / `C-GATE-05` / `C-GATE-05a` / `C-GATE-06` / `C-INIT-04`，整个 `VH-01..VH-08` 历史也不在 kit 仓库
- `C-INIT-01` 等少数条目内容也和 workspace 版本不一致
- 使用者 clone 或 pull kit 仓库时，看不到完整的 meta 约束历史

#### 影响范围

- **所有已经 clone 了 kit 仓库的用户**（包括 60+ 团队成员）
- **不影响已经 init 的项目**：新项目 init 时拿到的是 `templates/constraints.md.tmpl`（空脚手架），本次修复不改这个文件
- 影响的是"kit 维护者的 meta 约束参考"和"kit 仓库本身的 violation history 完整性"

#### 何时需要升级

- 如果你是 kit 维护者 / contributor / 要读 kit methodology 细节的人 —— **必须** `git pull`
- 如果你只是 kit 使用者，已经 init 好项目正常工作 —— **不必须**，但建议 pull 以获取完整的 meta 约束参考

#### 升级步骤

```bash
# Step 1: 拉取最新 kit
cd ~/path/to/simple-harness-kit
git fetch origin
git checkout master
git pull origin master
git describe --tags  # 应当看到 v0.7.1

# Step 2: （可选）读新补上的 meta 约束
less docs/constraints.md  # 完整的 C-DOC/C-META/C-HOOK/C-TEST/C-GATE/C-INIT + VH-01..VH-09
```

**不需要改动任何已有项目的代码/配置**。本 release 是 kit 仓库 meta 文件的同步，不改 runtime 行为。

#### 根因摘要

Dogfooding feedback loop 最后一公里从未落地：

1. `.claude/rules/feedback-workflow.md` F4 只说"写入 docs/constraints.md"，没说"如果是 kit-level 必须同步到 kit 仓库"
2. `docs/release-process.md` 7 步 release 流程没有 "Step 0: Dogfooding sync gate"
3. `tests/template-integrity.js` 13 个 T 检查全守 kit 内部自洽，没有守"workspace vs kit 仓库"的约束同步
4. VH-08 的 C-INIT-04 教训只覆盖 kit 内部副本，没扩展到"workspace vs kit 仓库"这对更外层副本
5. 本次 release 的作者（AI session）早期把"同步 constraints"当作"20 分钟文档同步"的治标任务

完整根因分析见 [docs/constraints.md](docs/constraints.md) 的 VH-09 条目。

#### 防退化保证（本 release 的核心）

v0.7.1 是**首次执行新 release-process 的 release**。新流程包含：

- **Step 0: Dogfooding Feedback Sync** — release 前强制跑 `tests/template-integrity.js`，`T10` 和 `T11` 必须 PASS 才能进 Step 1
- **T10**: workspace `docs/constraints.md` 的 kit-level 约束（C-DOC/META/HOOK/TEST/GATE/INIT/SKILL 前缀）和 VH-* 必须在 kit `docs/constraints.md` 中存在
- **T11**: workspace `.claude/rules/*.md`（5 个核心 rules）必须有对应 `templates/rules/*.md.tmpl`
- **F4.3**: `methodology/08-feedback-loop.md` 和 `.claude/rules/feedback-workflow.md` 的 F4 步骤拆分为 F4.1 (写入本地) + F4.2 (判断 scope) + F4.3 (kit 维护者必须同步 kit 仓库)
- **C-META-04**: 新约束强制 workspace ↔ kit 同步义务

本 v0.7.1 release 的 Step 0 实际执行结果：T10 + T11 全 PASS，122/122 测试通过。

### Added

- **`tests/template-integrity.js` 新增 T10 + T11 守门 (#C-META-04, VH-09 fix)** — 检测 workspace vs kit 仓库的 constraints.md 和 templates/rules 同步。反退化实测通过：手动删 kit C-META-04 → T10 立即 FAIL → 恢复 PASS (9c74a1b)
- **`docs/constraints.md` 新增 C-META-04** — kit-level 约束和 rules 必须 workspace ↔ kit 同步，由 T10/T11 工程层守门 + F4.3 规则层守门 + Step 0 流程层守门 (9c74a1b)
- **`docs/constraints.md` 新增 VH-09** — 本次 drift 的完整历史记录（5 个失效模式）(9c74a1b)
- **`templates/rules/commit-standards.md.tmpl` 新建** — 之前 workspace 有 commit-standards.md 但 kit 缺 template，T11 首次运行 catch 到此缺失 (9c74a1b)

### Changed

- **`docs/constraints.md` 完整重写** — 对齐 workspace 最新状态，补全缺失的 C-HOOK-06 / C-GATE-04/05/05a/06 / C-INIT-04 和 VH-01..VH-08 (9c74a1b)
- **`docs/release-process.md` 加 Step 0** — "Dogfooding Feedback Sync"，release 前必须跑 T10/T11 PASS 才能进 Step 1 (9c74a1b)
- **`methodology/08-feedback-loop.md` F4 拆分为 F4.1/F4.2/F4.3** — 加 "判断约束 scope" 和 "kit 维护者场景必须同步 kit 仓库" 子段，加 VH-09 背景说明 (9c74a1b)
- **`templates/rules/feedback-workflow.md.tmpl` 同步 F4 拆分** — 新 init 的 kit 维护者 workspace 也拿到 F4.1/F4.2/F4.3 结构 (9c74a1b)

### Fixed

- **VH-09: Dogfooding feedback loop 最后一公里缺失 drift** — workspace 产出的 6 条 meta 约束和 VH-01..VH-08 之前只写入 workspace 没同步 kit 仓库。本 release 一次性同步 + 加 T10/T11 守门防再发生 + 改 release-process / feedback-workflow / 08-feedback-loop.md 流程补丁 (9c74a1b)

### Notes

- 本 release 只改 kit 仓库的 meta 文件（`docs/constraints.md` / `docs/release-process.md` / `methodology/08-feedback-loop.md` / `templates/rules/*.md.tmpl` / `tests/template-integrity.js`），**不改任何 hook 脚本 runtime 行为**
- hook `@version` 未 bump（保持 0.7.0）
- 是 v0.7.0 的补丁，PATCH bump 符合 SemVer
- **首次执行新 release-process Step 0**（Dogfooding Feedback Sync gate），T10/T11 PASS

## [0.7.0] - 2026-04-08

### Migration Notes for VH-08

**🚨 P0 Fix — 受影响用户必读**

#### 故障表现

- 通过 `/harness-init` slash command 初始化项目后，新开 Claude Code session 立即报错 `Invalid key in record`
- 6 阶段 Loop 完全失效，hook 链路加载失败
- 绕过 skill（直接喂 init-prompt.md 内容）则正常

#### 根因摘要

旧版 `skills/harness-init/SKILL.md` 没有要求 AI 读取 `templates/settings-json.tmpl` 真实源，AI 凭训练记忆拼出 schema 错误的 `.claude/settings.json`：`SessionStart` 是字符串而不是数组、`command` 平铺在 matcher 同级而没有 `hooks: [{type, command}]` 包装层、`matcher` 用 `"Write|Edit"` 这样的 regex 或 `"*"` 通配符。完整复盘见 [docs/decisions/2026-04-08-skill-entry-blindspot.md](docs/decisions/2026-04-08-skill-entry-blindspot.md)。

#### 何时不需要升级

- 你**没有**用过 `/harness-init` slash command（直接读 init-prompt.md 喂给 AI 的，不受影响）
- 你的 `.claude/settings.json` 是你手工写的或从 templates/settings-json.tmpl 直接复制的
- 你的 Claude Code session 启动正常、6 阶段 Loop 工作正常

如果以上**全部成立**，可以跳过升级，但仍建议拉最新代码以获得 SessionEnd hook、StopFailure 等新 lifecycle event 支持。

#### 何时需要升级

如果以下**任一项**成立，你必须升级：

- 启动新 session 报 `Invalid key in record`
- `.claude/settings.json` 里出现 `"matcher": "Write|Edit"` 或 `"matcher": "*"` 或 `SessionStart` 是字符串
- `bash <kit-path>/tests/e2e-acceptance-validate.sh` 在你的项目里报 FAIL

#### 升级步骤

**Step 1: 拉取最新 kit 代码**

```bash
cd ~/path/to/your/simple-harness-kit
git fetch origin
git checkout master
git pull origin master
git describe --tags  # 应当看到 v0.7.0
```

**Step 2: 删除损坏的 settings.json 和受影响的 hook 脚本**

```bash
cd <受影响的项目根目录>
rm -f .claude/settings.json
# Hook 脚本也要重新生成 (旧版可能也是凭记忆生成的 stub)
rm -rf scripts/hooks/
```

**Step 3: 重新跑 /harness-init**

在 Claude Code 里输入：

```
/harness-init
```

新版 SKILL.md 会强制 Claude 先 Read templates/settings-json.tmpl / init-prompt.md / required-wiring.json 三个真实源，再派生产物。完成后会自动跑 `e2e-acceptance-validate.sh`。

**Step 4: 验证修复生效**

```bash
cd <项目根目录>
bash ~/path/to/simple-harness-kit/tests/e2e-acceptance-validate.sh
# 期望: PASS xx / xx, FAIL 0 / xx, 退出码 0
```

然后新开一个 Claude Code session，确认：
- 不再报 `Invalid key in record`
- SessionStart hook 输出 `HARNESS MODE ACTIVE` banner
- 6 阶段 Loop 可以正常进入

#### 如果升级后还有问题

- 检查 `.claude/settings.json` 的内容是否符合 `templates/settings-json.tmpl` 的格式（用 `diff` 对比）
- 检查 `scripts/hooks/` 下是否包含所有必选 hook，**特别是 `find-root.js`**（hook 之间的共享依赖，漏复制会导致 `Cannot find module './find-root'`）
- 跑 `bash tests/e2e-acceptance-validate.sh` 看具体哪个 section FAIL
- 如以上仍无法解决，开 issue 附 validate.sh 完整输出

#### 防退化保证

新加 4 个层次的可执行守门，未来不会再退化到这个失效模式：

1. `tests/template-integrity.js` 新增 T8 检查：SKILL.md 必须引用真实源、禁止内嵌 settings.json 代码块、禁止硬编码 hook 路径清单
2. `tests/e2e-acceptance-validate.sh` 新增 E2 section：检查所有 wired script 文件必须存在
3. `docs/constraints.md` (使用方工作区) 新约束 C-INIT-04：Skill 不得复述工程真实源；C-GATE-06：E2E 验收必须覆盖双入口（init-prompt.md 直接 + /harness-init slash command）
4. Sub-agent BEFORE/AFTER 量化对照实验作为修复证据：BEFORE 21/57 PASS → AFTER 64/64 PASS

### Added

- **SessionEnd hook (#26)** — 新增 `scripts/hooks/session-end.js`。session 结束时立即归档 `.harness/observations.jsonl` 到 `.harness/observations.archive/observations-<sid8>-<ts>.jsonl`（不等 10MB 阈值），写 session 结束标记到 session-log。HARNESS_LOG=off 完全跳过。observability-only 不阻塞退出。自动触发 harness-learn 放弃（避免阻塞），留给 manual/periodic 模式 (761c5e5)
- **E2E validate.sh E2 section (#34)** — `tests/e2e-acceptance-validate.sh` 新增 E2 检查 "wired script 文件必须存在"：从 required-wiring.json 派生脚本集合，扫 `scripts/hooks/` / `.claude/hooks/` / `hooks/` 三个候选目录。反 VH-08 同类回归（settings 已注册但脚本未复制）(761c5e5)
- **Template integrity T8 (#34)** — `tests/template-integrity.js` 新增 T8 守门 "skill: harness-init/SKILL.md 强制读真实源 + 不复述清单"：检查 SKILL.md 引用 init-prompt.md / settings-json.tmpl / required-wiring.json，禁止凭记忆字面，禁止内嵌 settings.json JSON 代码块和硬编码 hook 清单。实测能 catch 旧版本 SKILL.md (761c5e5)
- **tests/run.js 扩展 `expect.dirs` (#26)** — 支持正则目录文件名匹配 + minCount + contains，用于断言 archive 文件创建/命名/内容 (761c5e5)
- **Post-mortem: skill-entry-blindspot (#34)** — 新增 [docs/decisions/2026-04-08-skill-entry-blindspot.md](docs/decisions/2026-04-08-skill-entry-blindspot.md)。VH-08 根因复盘：4 个失效模式叠加（skill 不读真实源 / 多源副本漂移 / E2E 入口盲区 / 长期未 review），含 BEFORE/AFTER sub-agent 量化实验（BEFORE 21/57 PASS → AFTER 64/64 PASS）(761c5e5)
- **Hook 版本号机制** — 13 个 Hook 脚本头部注释加 `@version` 字段，update.sh 增强版本比对 + `--dry-run` 模式 (66e5fcf)
- **TaskUpdate matcher** — stage-guard 监听 TaskUpdate 工具调用，EXECUTE/VERIFY 阶段标记 completed 时提醒检查验证证据；first-call guard 跳过 TASK_TOOLS (66e5fcf)
- **WebFetch / WebSearch 覆盖** — stage-guard READ_TOOLS 数组扩展，PLAN 阶段放行并注入 directive；模板和本地配置同步 (1c1a09d)
- **PostToolUseFailure 事件支持** — session-logger 监听失败工具调用，写入 [失败] 标记到 session-log，observations.jsonl 增加 status 和 error 字段；methodology/05-hook-enforcement.md Hook 类型表加入此事件 (1c1a09d)
- **StopFailure 事件支持 (#25)** — session-logger 监听 StopFailure，记录 API 错误结束（rate_limit / billing / server_error 等）到 session-log + observations，下次 session 知道上次怎么挂的 (b41deba)
- **TaskCompleted 事件迁移 (#24)** — 旧的 PreToolUse:TaskUpdate completed 提醒迁移到 TaskCompleted lifecycle event；harness-stage-guard.js 直接监听该事件 (5fd0fc1)
- **TASK_TOOLS 任意阶段放行** — TaskUpdate/TaskCreate/TaskList/TaskGet 在 PLAN 阶段不被阻止（流程管理操作无代码副作用）(1c1a09d)
- **stage-guard since 字段校验 (#20)** — 写 current-stage.json 的 since 字段必须是真实 ISO8601 时间，± 5 分钟以内。防止 AI 手写假时间戳导致 verification-gate 假阳 (a5d722e)
- **e2e-acceptance-validate.sh (#21)** — 新增端到端验收可执行守门，从 required-wiring.json 派生事件/matcher/script 集合做静态 + 实弹检查 (fd000cf)
- **template-integrity.js (#23)** — kit 仓库级模板注册完整性自动化测试，防止模板层漂移 (710c4cc)
- **Hook 覆盖矩阵文档** — 新增 [methodology/15-hook-coverage-matrix.md](methodology/15-hook-coverage-matrix.md)，记录工具/事件的 Hook 覆盖决策、intent vs registered 状态、新增工具决策流程、一致性检查清单 (4de0240)
- **Lifecycle events 评估报告** — 新增 [docs/decisions/2026-04-07-lifecycle-events-evaluation.md](docs/decisions/2026-04-07-lifecycle-events-evaluation.md)，评估 9 项 lifecycle events / 能力，决策 P0/P1/P2/P3 优先级 (0e31062)
- **commit/push 阶段策略文档化** — methodology/12-commit-standards.md 新增 'Commit / Push 阶段规则' 章节；stage-guard REVIEW directive 增加 push 提醒 (b63407c)
- **CHANGELOG.md 和 release 流程** — 新增本文件 + [docs/release-process.md](docs/release-process.md) (84acf7a)

### Changed

- **skills/harness-init/SKILL.md 彻底重写 (#34)** — 134 行变 92 行。删除硬编码的文件树、必选清单、完整性 checklist。新增强制"生成原则"段，要求 AI 必须先 Read `templates/settings-json.tmpl` / `init-prompt.md` / `required-wiring.json` 作为真实源，禁止凭记忆生成 `.claude/settings.json` 和 hook 脚本。Step 3 下方新增"两种生成策略"对比段，建议默认从 required-wiring.json 派生最小集（避免 AI 漏删 optional hooks）。反 VH-08 根因修复 (761c5e5)
- **init-prompt.md 清理陈旧表述 (#34)** — (1) "必选 4 个"改为指向 required-wiring.json 真实源；(2) 必选组件表加入 `session-end.js` 和 `find-root.js`（hook 共享依赖，漏复制会导致 MODULE_NOT_FOUND）(761c5e5)
- **SessionEnd wiring 加入 templates/settings-json.tmpl + required-wiring.json + .claude/settings.json (#26)** — 19 个 wiring (从 18 扩到 19) (761c5e5)
- **methodology/05-hook-enforcement.md + 15-hook-coverage-matrix.md 同步 SessionEnd (#26)** — 矩阵从"gap"改为"已覆盖"，添加 Hook 类型表 session-end 行 (761c5e5)
- **tests/scenarios/01-setup-completeness.md 去除硬编码事件清单 (#34)** — 手工"PreToolUse+PostToolUse+PostToolUseFailure"清单改为"运行 validate.sh"引用；显式加入"不要再硬编码副本"禁令。反 VH-08 同类回归 (761c5e5)
- **scripts/hooks/ 为唯一源** — 删除 templates/hooks/（11 个陈旧副本），update.sh 改从 scripts/hooks/ 取源 (66e5fcf)
- **constraints.md 种子扩充** — kit 默认 constraints 从 2 个 JC 组扩到 6 个组 (66e5fcf)
- **methodology/05-hook-enforcement.md 精简 settings.json 示例** — 完整 settings.json 示例替换为指向模板的精简版（避免三份竞争性真实源）；多处行为描述对齐实际代码 (4de0240)
- **harness-stage-guard.js 头部注释** — 重写为完整的 10 条机制说明，覆盖所有 exit 0 / exit 2 路径 (4de0240)

### Fixed

- **P0: VH-08 /harness-init skill 生成错误 settings.json (#34)** — 用户用 `/harness-init` 初始化后新 session 报 `Invalid key in record`。根因：旧 SKILL.md 不要求 AI 读 templates/settings-json.tmpl，AI 默认凭训练记忆拼 JSON，产生 3 个 schema 错误（SessionStart 是字符串不是数组 / command 平铺无 hooks 包装 / matcher 用 regex 或 `*`）。修复：重写 SKILL.md 强制读真实源 + T8 守门 + E2 wired-script 检查 + 双入口 E2E（C-GATE-06）。BEFORE/AFTER sub-agent 实验量化基线：21/57 → 64/64 PASS。详见上方 Migration Notes 段 (761c5e5)
- **P0: templates/settings-json.tmpl 缺少 SessionStart 和 Stop 顶层事件** — 用此模板 init 的项目会丢失 harness-session-start.js 和 delivery-gate.js 触发；本次补齐 (4de0240)
- **update.sh --dry-run 不影响 Skills 复制** — Skills 复制现在受 DRY_RUN 控制 (66e5fcf)
- **update.sh 不安装新增 Hook 文件** — 写循环改为目标不存在时也复制 (66e5fcf)
- **TaskUpdate matcher 未同步到模板** — templates/settings-json.tmpl 和 init-prompt.md 补齐 (66e5fcf)
- **session-logger 不区分成功/失败** — PostToolUseFailure 调用现在在 session-log 加 [失败] 标记，observations.jsonl 加 status='failure' + error 字段 (1c1a09d)
- **methodology/05-hook-enforcement.md 多处文档漂移** — 移除"Read/Grep/Glob 永远放行"等过时表述；REVIEW gate 文案对齐实际代码（只检查 EXECUTE/VERIFY，不检查 PLAN）(4de0240)

### Notes

- 经过多轮 Codex 交叉验收（每个变更 2-5 轮）确保实现与文档一致
- 5 个 commit 的端到端验收发现 P0 模板缺陷，证明矩阵审计的价值
- 13 个 hook `@version` 全部统一 bump 到 0.7.0 (释放本 release)
- VH-08 修复同时引入 4 条新约束（C-INIT-04 / C-GATE-06 / C-GATE-05a 在使用方 harness-dogfood 工作区，VH-08 在 history）—— 这些是工作区本地配置，不在 kit 仓库内

## [0.6.0] — Hook 路径定位修复

Hook 脚本通过 find-root.js 主动定位项目根，不再依赖 process.cwd()。解决 CWD 漂移导致的 MODULE_NOT_FOUND 问题。

详见 commit 1699b88 和 git tag v0.6.0。

## [0.5.0] — Stop Hook delivery-gate + Skill 命名差异化

详见 git tag v0.5.0。

## [0.4.1]

详见 git tag v0.4.1。

## [0.4.0] — Hook 自动化测试 + init 流程修复 + REVIEW Gate + install/update 脚本

详见 commit d862450 和 git tag v0.4.0。

## [0.3.0]

详见 git tag v0.3.0。

## [0.2.0]

详见 git tag v0.2.0。

## [0.1.0]

最早发布版本。详见 git tag v0.1.0。

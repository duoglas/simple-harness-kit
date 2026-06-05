# Kit Constraints (simple-harness-kit 仓库级 meta 约束)

**SINGLE SOURCE OF TRUTH (kit 产品仓库)** — kit 方法论本身的约束。

## 这个文件是什么

本 constraints 是 **kit 维护者**（修改 methodology / templates / hooks / skills 的人）的约束清单，**不是**"新 init 项目应该遵守的约束"。新项目的 constraints 种子模板是 `templates/constraints.md.tmpl`（一个空的脚手架，由 init 流程拷贝后用户自行填充项目特定约束）。

### 与 workspace `harness-dogfood/docs/constraints.md` 的关系

本 kit 有一个 dogfooding workspace（`harness-dogfood`），它也维护一份 `docs/constraints.md`。这两份文件**必须保持同步**：

- workspace 是 dogfooding 发生的地方 —— F1-F5 产出新约束首先在那里
- kit 仓库是公共产品 —— 60+ 使用者 clone 这里
- **所有 kit-level meta 约束必须存在于两份之中**（workspace 为了本地 enforcement，kit 为了公共可见）

同步由 `tests/template-integrity.js` 的 T10 自动守门（见下方 C-META-04）。本文件的编辑**必须同时**更新 workspace `docs/constraints.md`，反之亦然。若任一方新增约束，另一方必须在同一 commit 同步更新。

### 与 templates/constraints.md.tmpl 的关系

`templates/constraints.md.tmpl` 是**新项目 init 时拿到的空脚手架**，不是本文件的 subset。它只提供 JC/C/VH ID 格式 + 区域列表 + 空表模板，让用户按项目需要自行填充。本文件的 kit-level meta 约束**不应**出现在 .tmpl 中（那些是 kit 维护者的约束，不是新项目的）。

## 约束 ID 格式

- `C-{area}-{number}` — 单条约束
- `JC-{number}` — 联合约束组（组内必须同时成立）
- `VH-{number}` — 违规历史

## 约束区域

- `DOC` — 文档规范
- `HOOK` — Hook 脚本
- `SKILL` — Skill 定义
- `META` — 方法论自身的约束（含 dogfooding sync）
- `TEST` — 测试相关
- `INIT` — 初始化流程
- `GATE` — 交付门控 + 端到端验收
- `WORK` — Worktree 多 lane 工作模式（git worktree + Claude Code bg-isolation 兼容）

---

## [JC-01: 文档质量]

| ID | 约束 | WHY | 违反后果 |
|---|---|---|---|
| C-DOC-01 | 场景实例只展示 Harness 相关步骤，不教用户做自己的事 | 用户不需要被教 npm init | 场景臃肿，信息噪声 |
| C-DOC-02 | AI 能自动扫出的信息（技术栈、构建命令等）不要求用户提供 | 减少用户负担 | 初始化指令过长 |
| C-DOC-03 | 方法论修改必须有实验依据（M1-M13 有对应实验）或 Issue 支撑 | 防止凭空想象 | 方法论脱离实际 |

## [JC-02: 方法论一致性]

| ID | 约束 | WHY | 违反后果 |
|---|---|---|---|
| C-META-01 | 本项目自身必须使用 Harness（dogfooding） | 如果自己都不用，怎么说服别人 | 信任度为零 |
| C-META-02 | Hook 脚本修改后必须通过 node -c 语法检查 | JS Hook 语法错误会阻断所有工具调用 | 用户项目瘫痪 |
| C-META-03 | Hook 脚本修改后必须通过功能测试（node tests/run.js） | 语法正确不等于功能正确 | Hook 行为偏离预期 |
| C-META-04 | kit-level 约束和 rules 必须在 workspace (harness-dogfood) 本地和 kit (simple-harness-kit) 仓库之间保持同步。F1-F5 的 F4 步骤有 sync 义务；release-process 的 Step 0 有 gate 检查；template-integrity 的 T10/T11 有工程层守门 | dogfooding feedback loop 的"最后一公里"必须闭环，否则 workspace 新学习不会进产品仓库，60+ 使用者拉不到 learning（VH-09） | kit 产品仓库长期与 workspace 漂移，新 init 项目拿不到最新 meta 约束；"VH-08 同类的副本漂移"问题持续出现 |

## [JC-03: 测试约束]

| ID | 约束 | WHY | 违反后果 |
|---|---|---|---|
| C-TEST-01 | Hook 功能变更必须先更新/新增测试场景（tests/hook-scenarios/） | TDD 纪律 | 回归风险 |
| C-TEST-02 | 功能性变更不能只用 mock 验证，必须在真实场景中跑过 | mock 通过不代表真实生效 | 上线后发现问题 |
| C-TEST-03 | 新 session 开始时验证 .harness/observations.jsonl 有新数据 | 确认 session-logger hook 生效 | 所有 hooks 可能未加载 |

## [JC-04: Hook 脚本规范]

| ID | 约束 | WHY | 违反后果 |
|---|---|---|---|
| C-HOOK-01 | Hook 执行时间 < 50ms | Hook 在每次工具调用时运行，慢了卡开发体验 | 用户关掉 hooks |
| C-HOOK-02 | Hook 不修改 Agent 输出（stdout 透传 stdin） | Hook 是守门人，不是干预者 | 行为不可预测 |
| C-HOOK-03 | Hook 不产生复杂副作用（轻量计数器/日志除外） | 保持确定性 | 调试困难 |
| C-HOOK-04 | 读操作工具（Read/Grep/Glob）永远不被 Hook 阻止 | 读操作无害，阻止会卡死探索流程 | 用户无法工作 |
| C-HOOK-05 | Hook 脚本必须用项目根目录定位来解析 .harness/ 等相对路径，不依赖 process.cwd() | CWD 可能在子目录（如 git 操作 cd 到子仓库），导致路径翻倍或找不到文件 | Hook 报 MODULE_NOT_FOUND 或读错文件 |
| C-HOOK-06 | 新增工具类型时必须评估是否需要 Hook 覆盖（stage-guard / session-logger 等），不能默认跳过 | TaskUpdate 等工具无 matcher，AI 可绕过阶段控制 | 阶段 Gate 形同虚设 |
| C-HOOK-08 | `.claude/settings.json` 所有 hook `command` 必须用 find-root shell wrapper 定位脚本（向上找 `scripts/hooks/find-root.js` → `cd` 到根 → `node scripts/hooks/<X>.js`），禁止裸 `node scripts/hooks/<X>.js`。Kit 两份模板（`templates/settings-json.tmpl` + `skills/harness-init/resources/settings-json.tmpl`）都必须遵守；`tests/template-integrity.js` T16 自动守门 | Claude Code / Codex 在子目录起 session 时 CWD 不是项目根，裸相对路径解析到子目录不存在路径，hook 报 MODULE_NOT_FOUND（VH-16） | Hook 静默失效，stage 守门 / session 日志 / 交付 gate 全部不工作，用户在子目录做的工作没有任何 Harness 保护 |
| C-HOOK-09 | `current-stage.json` 的 `since` 字段允许 `"auto"` 或 `"now"` 作为 sentinel，`harness-stage-guard.js::validateSince` 放行；新增 `scripts/hooks/stage-since-autofill.js` 作为 PostToolUse:Write hook 立即覆写为真实墙钟 ISO。AI 不需要手抄 `date -u` 输出，也不再撞 30 分钟 drift 窗口 | VH-14 Option B（窗口放宽到 30 分钟）实战仍撞窗（跨 hour 长 session 常见），Option A 兑现：sentinel + autofill 彻底消除"AI 手抄时间戳"失败模式 | AI 反复被 30 分钟窗口拒绝，Harness 流程体验断裂；严重时 AI 放弃声明阶段直接绕过流程 |
| C-HOOK-10 | 新 session 的 Harness 可见入口不能只依赖 `SessionStart` stderr/banner。Codex profile 必须额外挂载 `UserPromptSubmit` 入口 hook，通过 Codex 可解析 JSON 的 `hookSpecificOutput.additionalContext` 注入 `HARNESS MODE ACTIVE` 和首轮阶段声明要求；该 hook 必须保持轻量、幂等，不重置 stage | Codex Desktop 可执行 `SessionStart` 副作用（stage/tool-count 刷新），但其 stderr/banner 不一定进入用户可见 UI 或模型上下文（VH-20） | hooks 明明生效但用户看不到 Harness logo/banner，AI 第一轮不知道要输出 Harness 入口，误判为“SHK 没生效” |
| C-HOOK-11 | 当当前 runtime 没有 `Write` 工具但有 `apply_patch` 时，`harness-stage-guard.js` 必须允许**仅修改** `.harness/current-stage.json` 的 `apply_patch` 作为阶段切换通道，并复用 stage/since/Infra Tier/REVIEW gate 校验；禁止要求一个 runtime 不存在的工具作为唯一恢复路径 | Codex 本地会话工具集可能只有 `apply_patch` 而没有 Claude Code 的 `Write`。如果 PLAN/非法 stage 只允许 `Write current-stage.json`，一旦需要切阶段或修复损坏 stage，所有工具都会被 guard 拦截，形成自锁（VH-20） | 用户必须手动去外部终端修 `.harness/current-stage.json`；Harness 变成阻断开发的死锁源 |

## [JC-05: 交付 Gate 强制 + 端到端验收]

| ID | 约束 | WHY | 违反后果 |
|---|---|---|---|
| C-GATE-01 | 切换到 REVIEW 阶段时，stage-guard 必须检查：(a) 经过了 PLAN→EXECUTE→VERIFY 流程 (b) VERIFY 有量化证据文件 | AI 会跳过验证直接宣称 READY | 质量不达标的变更交付给用户 |
| C-GATE-02 | 功能性变更的 VERIFY 阶段，必须有真实场景验证记录，不能只有 mock/文件存在性检查。**涉及"用户任意 cwd / 任意 kit 位置"的功能**（install 脚本 / Skill 入口 / init 流程等）必须用**至少 3 个无父子关系的随机 tmp 目录**作为 `$HOME` / `$KIT` / `$CWD` 跑脚本化测试。**禁止**在 sub-agent 实验 prompt 里手工提供被测组件本应自己 locate 的资源路径（这会绕过被测组件）。参考 C-TEST-04/05/06 | mock 通过不代表真实生效（VH-05）；dogfooding 作者环境特殊性掩盖 cwd-rel bug（VH-10）；sub-agent 实验预置绝对路径产生假 PASS（VH-10） | 文档改了但 init 流程实际没改善 |
| C-GATE-03 | 向用户交付结果前，stage-guard 必须注入交付检查清单提醒（流程合规、QA 达标、需求完整、规则升级、改进机会） | delivery-review 只在 open 命令触发，大部分交付不经过 open | 交付时没有复盘 |
| C-GATE-04 | harness-kit 的结构性/功能性变更，验收必须用 sample 工程做端到端验证，覆盖 **4 层验收矩阵**：**(1) 机制完整性** — validate.sh + 7 维脚本矩阵 PASS；**(2) 内容断言** — init 后的 `.claude/rules/qa-standards.md` 必须含 TDD 铁律 + 5 层金字塔 + VERIFICATION REPORT 等行为指令（T15 自动守门）；**(3) 行为观测** — sample 工程做一个标准化小任务，检查 AI 行为轨迹：先写失败测试了吗？输出 VERIFICATION REPORT 了吗？做 spec review 了吗？；**(4) 产出质量** — AI 产出的代码能通过项目测试、能启动运行。runtime 三模式 × 入口两模式不变 | 单元测试和局部真实场景不能覆盖 init 生成质量、Hook 运行时行为、跨阶段流转等端到端问题。**VH-11 教训**: 仅验"机制能转"不验"产出有效"，导致模板骨架问题在 4 轮交叉验收中全部逃逸 | 改了模板但 init 流程实际坏了、改了 Hook 但运行时报错、模板行为指令缺失但结构检查全绿导致用户代码质量断崖 |
| C-GATE-05 | 本项目所有任务的验收，除分级 QA 外，必须做跨实例交叉验收，且方向单一：**Claude 驱动的 session 不主动交叉调用 Codex**，改用 2 个上下文隔离的独立 Claude sub-agent 交叉验收（Santa Layer 4）；**Codex 驱动的 session 可以交叉调用 Claude**。无论哪个方向，至少一个交叉验收方必须实际产出可量化对比的产物，不能只有纯 review 意见 | 单一实例验证存在盲区，交叉验收降低逃逸率；但 Claude→Codex 方向的交叉调用已被 Director 明确禁止（稳定性/流程偏好），故固定为单向，避免不稳定通道反噬流程 | 问题逃逸到用户手中；或 Claude 误调 codex 违反 Director 指令、引入不稳定交叉通道 |
| C-GATE-05a | 交叉验收降级规则，两类合法路径：**(A) Director 指令不使用 Codex（默认，见 C-GATE-05）**——Claude 驱动时用 2 个独立 Claude sub-agent 交叉验收，至少一个产出量化产物而非纯 review 意见，无需入队"待补 Codex"。**(B) Codex 不可用（仅当方向是 Codex 应作验收方时）**：(1) 必须贴错误日志证明是 infrastructure（API 403 / 服务 down / token 耗尽）而非内容问题；(2) 最低替代同 (A) 的双独立 Claude sub-agent；(3) 入队"待补 Codex round X"，恢复后补跑；(4) AI 自身理由（如"时间紧"）不属豁免范围 | 坚持单向交叉而非彻底放弃交叉，两害取其轻；Director 偏好（A）与 infrastructure 故障（B）是两类不同合法降级，sub-agent 交叉已验证比纯 review 给出更强证据 | 豁免门槛过低会让交叉验收空洞化；把 Director 偏好误当 infrastructure 故障会污染待补队列 |
| C-GATE-06 | C-GATE-04 三模式 E2E 验收的"入口"必须至少覆盖 2 种：(a) 直接读 init-prompt.md 入口；(b) 通过 /harness-init slash command 触发 skill 入口。两种入口都要走完 validate.sh 全 PASS。三模式（独立 agent / Claude Code / Codex）针对每种入口都要跑一遍 | "三模式"是 runtime 三模式，不是 entry 三模式。历次 E2E 都只测 init-prompt.md 入口，从未测过 /harness-init skill 入口，导致 VH-08 长期未被发现 | skill 路径成为永久测试盲区，类似 bug 持续逃逸 |
| C-GATE-07 | **用户入口变更强制三模式证据**: 当 commit 涉及 `install.sh` / `update.sh` / `init-prompt.md` / `skills/harness-init/SKILL.md` / `skills/harness-init/resources/init-prompt.md` / `scripts/generate-codex-hooks.js` 任一文件时，`.harness/verify-evidence.md` 必须同时含三个 runtime 模式标记（`独立 agent` / `Claude Code` / `Codex`）。由 `verification-gate.js` 第 4 层检查强制，仅在 kit 仓库触发（`tests/template-integrity.js` 存在性检测），不影响 60+ 用户项目。紧急豁免: `HARNESS_SKIP_GATE=1` + commit message 记录原因 | VH-12 根因：install.sh 双工具 PR 在 REVIEW 阶段明知"未测 Codex runtime"仍交付 = 主动豁免 C-GATE-04 而无机器守门。纸面约束 + 口头复盘不足以拦截"明知故犯"的豁免 | 用户入口 P0 bug（如 Codex 路径 Step 3.5 失败）潜伏到用户生产环境才被发现 |
| C-GATE-09 | **Release 前必须机器门控 tests/run.js 全绿 + working tree 干净 + local==origin**: `tests/pre-release-check.sh` 在任何 `git tag v*` 之前必须 exit 0. 三层检查：(1) `node tests/run.js` 0 FAIL；(2) `git status --porcelain` 空；(3) `git rev-parse HEAD == @{u}`. 紧急豁免: `SKIP_SYNC_CHECK=1` 仅跳过 git sync 检查，tests/run.js 和 dirty 检查不可豁免 | v0.8.6 带着 2 个 tests/run.js FAIL（05-mutation M1 假阴性 + codex-smoke-selftest RUN_EXIT unbound）发布到 60+ 使用者，release-process.md Step 0/0.5 只跑 template-integrity + scripted-matrix 两部分，不覆盖 hook-scenarios / codex-smoke 等路径 | 回归测试失效：release 带着 FAIL 发出去，用户成为唯一回归 catcher（VH-13/VH-15 教训再次复演） |
| C-GATE-08 | **Codex runtime 兼容性必须机器守门**: `tests/codex-smoke.sh` 在真实 Codex CLI 上跑最小任务（"Read README.md"），断言 hook 层无 "hook: * Failed" / "hook returned invalid" 告警。默认策略：本地无 codex → SKIP + warn（不阻塞）；`CODEX_REQUIRED=1` → 无 codex 升级为 FAIL。`tests/codex-smoke-selftest.sh` 注入坏 hook 断言 smoke 能 catch。两者由 `tests/run.js` 末尾自动调用。**禁止**"加固 TODO"模式（先标 TODO 下次再实现），VH-13 的加固 TODO 拖延导致 VH-15 用户再次成为回归 catcher | VH-13 修了 hook stdout passthrough，VH-13 CHANGELOG 留"加固 TODO: e2e-acceptance-validate.sh 增加 Codex session log 无 hook (failed) 断言"却未当即兑现，v0.8.1 发布后用户在 Codex 再次撞到疑似 hook 问题（VH-15）。教训：Codex 兼容性不能靠用户手测发现，必须有本地 codex 冒烟测试作为机器守门 | hook 代码改动引入 Codex 不兼容的 stdout/exit-code 组合，CI / run.js 全绿但 Codex runtime 爆 "invalid JSON output"，用户成为唯一回归 catcher |
| C-GATE-10 | **PreToolUse enforce 必须有运行时观测，不得只证明 PostToolUse logging 生效**: stage-guard 在 PreToolUse 触发时必须写 `.harness/pretool-observations.jsonl`；doctor/verify 类工具必须能发现“`.harness/observations.jsonl` 有 Bash PostToolUse，但没有 PreToolUse 观测”的半失效状态。涉及 Codex/Claude runtime 兼容性的验收必须区分：(1) hook 无 failed marker；(2) hook command 真实执行；(3) blocking/enforce 真能阻断 | “hook 开启 + session-log 有 Bash”只能证明观察层生效，不能证明准入/准出层能阻断。PreToolUse 失效时，Agent 仍可在 PLAN 阶段执行写类命令，SHK 表面正常但执行边界已空洞化 | 所有 Quality Gate / stage guard / safety guard 变成事后日志，无法阻止违规提交或危险命令 |
| C-GATE-11 | 质量门的覆盖判定**禁止以"文本/ID 字符串包含"作为语义证据**：spec↔test 的 requirement/risk/traffic 覆盖、E2E 充分性、断言存在性，不得仅凭关键字（assert/expect/PASS/e2e-result.json 等）或 ID 子串命中即判 PASS；必须基于结构化字段 + **本次运行新产生且可校验**的 evidence（E2E 用一次性 run-token 写入 `.harness/e2e-result.json` 并在 assess 时比对，证明非陈旧文件/非源码关键字）。结构化 evidence 与 run-token 要求仅作用于 medium/high/release，low 维持宽松 | review 发现 #1/#3/#5：空壳 test_plan、注释关键字、纯 console.log stub 仅因出现正确英文单词或 ID 子串即被判"有真实断言/已覆盖/写了证据"，质量门语义层被关键字绕过 | 空壳 spec + 假 E2E 一路 READY，证明力为零的交付被准出 |
| C-GATE-12 | mutation/fault evidence **仅在结构化文件且 `killed > 0 && survived === 0` 时 PASS**：禁止"源码注释出现 mutation/broken/KILLED 关键词即 PASS"的文本回退（无结构化证据 = FAIL）；禁止裸 `status: PASS` 自声明短路；`killed=0, survived=0` 必须 FAIL | review 发现 #1 回退 + #2：两行注释或 `{"status":"PASS","killed":0,"survived":0}` 即可让 mutation_sensitivity=PASS，Phase 2 核心卖点"坏代码必失败"被绕过 | 没杀任何 mutant 的交付被当作"测试有效"，坏代码逃逸 |
| C-GATE-13 | spec 语义检查必须**单一来源**：EXECUTE gate（`harness-stage-guard.js`）与 `shk spec status`（CLI）共用同一纯函数判定，禁止 hook 严 / CLI 松的双标准；对同一份 spec 必须给出一致结论 | review 发现 #6：同一空壳 spec，hook 判 NOT_SUFFICIENT 拦住 EXECUTE，而 `shk spec status` 判 READY，AI 用 CLI 自检得到假安全感 | AI 自检 READY 与实际 gate 行为冲突，绕过 EXECUTE 拦截 |
| C-GATE-14 | EXECUTE 阶段必须**会话期持续复检** spec，不止切入时：已 EXECUTE 后 `.harness/iteration-spec.json` 缺失/损坏/降级空壳，必须拦截代码写入与实现命令；放行只读操作、写 spec 本身、切回 PLAN/修 spec。复检按 spec 文件 mtime 缓存避免性能退化，且必须保留每次 PreToolUse 写 `.harness/pretool-observations.jsonl`（不破坏 C-GATE-10） | review 发现 #7：gate 只在"切入 EXECUTE 写入瞬间"校验，合法切入后删除/损坏 spec 再写代码不复检，构成状态绕过 | EXECUTE 中途丢失 spec 仍可继续改代码，质量门在会话期失效 |

## [JC-06: 初始化流程]

| ID | 约束 | WHY | 违反后果 |
|---|---|---|---|
| C-INIT-01 | init 必须生成 3 个基础设施 Hook: session-logger、harness-stage-guard、harness-session-start | 这三个是 Harness 运行时的基座，缺少任何一个都会导致流程失控或无记录 | session-log 无数据、新 session 不走 6 阶段 Loop、阶段可被绕过 |
| C-INIT-02 | init 文档必须显式标注必选组件和可选组件，不允许 AI 自行判断删减必选项 | AI 会以"轻量适配"为由跳过基础设施 | 用户项目 Harness 残缺，出问题后无法排查 |
| C-INIT-03 | init 完成后必须输出组件完整性检查清单，列出每个必选组件的存在状态 | 当场发现缺失，不要等新 session 才暴露 | 用户不知道少了什么，直到出问题 |
| C-INIT-04 | Skill / 文档不得复述工程真实源（required-wiring.json / templates/*.tmpl / scripts/hooks/*.js / init-prompt.md 必选清单）。任何要列必选清单/wiring/文件结构/json 配置的地方，必须以"先 Read 真实源"的指针形式引用，不得硬编码副本。settings.json 与 hook 脚本不得"凭记忆生成"，必须先读取对应模板/源文件后派生 | 多源副本必然漂移；LLM 默认行为是凭记忆拼 JSON，不强制读模板就一定出错（VH-08） | 用户走 skill 入口生成的产物结构错误，新 session 启动即报 Invalid key in record |
| C-INIT-05 | init 的用户层完整性检查必须验证 settings 引用 hook 的**本地 `require()` 依赖**也存在：先确认 settings 里每个 `scripts/hooks/*.js` 文件存在，再扫描这些 hook 的 `require('./...')` / `require('../...')` 相对依赖，确认目标文件也被复制（例如 `scripts/lib/spec-quality.js`）。`tests/required-wiring.json` 必须覆盖必选 hook 的跨目录依赖，`tests/template-integrity.js` 和 `tests/e2e-acceptance-validate.sh` 必须守门 | Issue #10：`harness-stage-guard.js` 引入 `../lib/spec-quality`，但 init 早期只检查 hook 文件本身存在，漏复制共享库时 init 全绿，首次工具调用才 `MODULE_NOT_FOUND` | 新项目表面初始化成功，实际所有 PreToolUse hook 一触发就崩，Harness 强制形同失效 |

## [JC-08: Worktree 多 lane 工作模式（VH-17）]

| ID | 约束 | WHY | 违反后果 |
|---|---|---|---|
| C-WORK-01 | 每个 git worktree 必须维护**独立**的 `.harness/` 控制状态（current-stage / current-plan / tool-count / stage-history / session-log / observations / verify-evidence 等）。`.harness/` 目录在 worktree 首次启动时由 hook 自动 `mkdir -p` 创建，不依赖 git tracking | worktree 与主仓库共用 `.harness/` 会导致：(a) 多 worktree 并发跑各自的 PLAN→EXECUTE→VERIFY 时互相覆写阶段状态；(b) worktree 内 SessionStart 把主仓库的活跃 stage 重置为 PLAN，主仓库进行中的工作丢上下文；(c) verify-evidence 文件在 worktree A 写但 worktree B 通过 REVIEW Gate；(d) 与 Claude Code bg-isolation 守门冲突——bg-isolation 要求 bg-session 写入落在 worktree 内，但 hook 用主仓库路径，永远死锁（VH-17） | 多 worktree 并行开发完全不可用；bg-session 进 worktree 后 PLAN→EXECUTE 切换永远被拒；用户被迫禁用 bg-isolation 或禁用 harness 二选一 |
| C-WORK-02 | `scripts/hooks/find-root.js` 检测到 cwd 路径匹配 `<anything>/.claude/worktrees/<name>(/...)?` 时**必须**停在该 worktree 边界返回，禁止继续向上探到主仓库的 `.harness/`。贪婪匹配自然处理嵌套 worktree（返回最内层）。**Windows 反斜杠路径**（如 `C:\repo\.claude\worktrees\foo`）必须先归一化为正斜杠再匹配（VH-18 F5）。守门: `tests/hook-scenarios/find-root.json` 6 项集成 + `tests/run.js` 13 项纯函数单元（含 Unix/Windows/嵌套/edge case） | 仅靠"查 `.harness/` 目录存在性"的向上探索逻辑会跳过 worktree 边界直接走到主仓库（因为 `.gitignore` 阻止 git worktree add 拷贝 `.harness/`），导致所有 hook 路径锚错 → 与 C-WORK-01 同源死锁。worktree 子目录（如 `worktree/src/foo/`）必须正确识别。Unix-only 正则会把 Windows 用户挡在外面 | hook 静默在错的目录写状态文件；主仓库 `.harness/` 成为多 session 共享脏数据池；Windows 用户的 worktree 功能完全不可用 |
| C-WORK-03 | hook 的 `.harness/` mkdir 自举**必须**通过 `find-root.js::isLegitimateHarnessRoot(ROOT)` 守门：仅当 (a) cwd 匹配 worktree 模式 或 (b) ROOT 下已有 `.harness/` 时才创建，否则直接 `process.exit(0)` 静默退出。`harness-session-start.js` / `harness-stage-guard.js` 顶层 `mkdirSync` 必须在该守门之后 | find-root fallback 到 cwd（无 worktree 模式、无 `.harness/` 祖先）时无条件 mkdir 会**把用户随便 cd 进的任意空目录污染成 Harness 项目**——Codex review 在 `/tmp` 实测复现：`echo {} \| node session-start.js` 生成 `.harness/current-stage.json` 并输出 HARNESS MODE banner（VH-18 F3） | 用户的任意 tmp/工作目录被无声 footprint；session-start 在非 Harness 项目里发出错误的 banner 指令，AI 据此进入不该有的 6 阶段 Loop |

## [JC-07: Skill 路径解析 + 测试反假 PASS（VH-10）]

| ID | 约束 | WHY | 违反后果 |
|---|---|---|---|
| C-SKILL-01 | Skill 内所有操作性路径引用必须是**绝对路径**或 **skill-relative (`./resources/...` 相对 SKILL.md 本身)**，**禁止**使用 cwd-relative 形式（如 `simple-harness-kit/foo`）。kit 内部资源需要在 Skill 中引用时，必须先 bundle 到 `skills/<name>/resources/` 下再 skill-relative 引用，或在 SKILL.md 里定义 `$KIT_ROOT` 定位步骤后再用 `$KIT_ROOT/...` | Skill 安装后 AI 当前 cwd 不一定是 kit 父目录；60+ 用户把 kit 放在任意位置（D 盘 / `~/ops/` / 任意 clone 位置），cwd-relative 路径在真实用户环境下必然 Read tool "File does not exist" | Skill 入口功能直接坏掉，用户报 "无法找到 simple-harness-kit"（VH-10 问题 B） |
| C-SKILL-02 | Skill 中涉及"自动定位外部资源仓库"的逻辑，**禁止**在 cwd 或其祖先目录"自动搜索 + 静默信任"。必须满足: (a) 优先信任用户显式设置的环境变量 (如 `SIMPLE_HARNESS_KIT_ROOT`); (b) 定位到候选路径后**必须做结构完整性校验** (验证一组已知文件存在且非空, 例如 kit 的 `methodology/00-philosophy.md` / `templates/settings-json.tmpl` / `tests/required-wiring.json` / `scripts/hooks/*.js` / `init-prompt.md`); (c) 除非是环境变量指定, 所有自动定位结果**必须显式询问用户确认**后才使用. **禁止**假设"第一个找到的同名目录就是真的". 守门: T13 静态检查 SKILL.md 包含这些锚点字符串, T14 实际 stat 锚点文件真实存在 (防 VH-10 阶段 4 发现的"声明的锚点文件名与真实不符"漂移) | cwd 向上搜索 + 静默信任 = 经典 supply-chain 攻击面: 用户 `cd /tmp/untrusted-project` 工作, 恶意行为者在该位置种一个伪 kit, skill 自动使用伪 kit 的 hooks/templates/rules, 把恶意代码写入用户项目. (VH-10 Codex gpt-5.4 round 3 F3 发现, 阶段 4 真实验收暴露 T13 meta gap) | 用户被诱导运行恶意 hook 脚本 / 恶意 rule 模板 / 恶意 validate.sh |
| C-SKILL-03 | Skill 面向用户的 init/start 等 flow **禁止**默认跑 kit 维护者的 CI 工具（如 `tests/e2e-acceptance-validate.sh` 76 项全量检查）。用户 flow 只做**最小完整性检查**（必选文件存在 + settings.json JSON 有效 + hook 脚本存在 + CLAUDE.md 非空，4 项）。Kit CI 作为"如需深度验证"的可选路径提供给用户自行选择 | 用户只想 init harness，不需要看 76 行 ✓/✗ CI 输出。强制全量 CI = 网站注册后让用户看完单元测试 report。且 CI 工具依赖 kit 仓库路径 + Node 环境，与 init 后的项目环境耦合 | 用户流失：init 过程冗长、输出不可理解、环境依赖重 |
| C-TEST-04 | Sub-agent 实验 / 测试用 agent dispatch 时，**禁止**在 prompt 里手工提供被测组件"本应自己 locate 的资源"的绝对路径。测试 SKILL.md 路径解析能力时不能在 sub-agent prompt 里先说 "kit 在 /abs/path/to/kit"——这会绕过 SKILL.md 的路径解析机制，使实验结果变成"sub-agent 按我给的路径读文件"而不是"SKILL.md 的路径解析是否 work"。正确做法：模拟真实用户环境（随机 cwd、kit 在未知位置），让 sub-agent 完全按被测组件的指令 locate | VH-10 根因的 meta 失效：本 session 早期的 dogfooding 实验全部在 prompt 里提供了 kit 绝对路径，sub-agent 成功读到文件 ≠ SKILL.md 写得对 | 假 PASS 逃逸到 release，用户交付后报同类 bug |
| C-TEST-05 | 任何"AI 遵循 SKILL.md / rule / 模板文档"的功能测试，必须**同时**验证"真实 cwd 下路径能解析"（`[ -f "$cwd/<path>" ]` 或等价），不能只做"文档内容存在且格式对"的静态检查 | 静态内容检查告诉你文档里写了什么，不告诉你文档里写的路径在用户环境下能不能打开 | 文档层面 PASS 但运行时 FAIL，CI 绿灯交付后爆炸 |
| C-TEST-06 | 涉及"用户在任意目录"的功能（install 脚本、Skill 入口、init 流程等），脚本化测试必须使用**至少 3 个无父子关系的随机 tmp 目录**作为 `$HOME` / `$KIT` / `$CWD`，`cp -r` 真实拷贝 kit（不用 symlink），然后在 `$CWD` 下跑被测功能 | dogfooding workspace (harness-dogfood 有 simple-harness-kit 作为子目录) 是一个特殊 case，cwd-relative 路径在这里恰好能 work——这正是 bug 长期隐藏的原因。测试必须打破这个特殊环境 | 测试在作者机器上永远 PASS，用户机器上永远 FAIL |
| C-HOOK-07 | Shell 脚本中所有 `cp -r <src> <dst>` 当 `<dst>` 可能已存在时，必须使用幂等模式 `rm -rf "<dst>" && cp -r "<src>" "<dst>"`。直接 `cp -r` 在 dst 存在时 GNU/BSD 行为都是"把 src 作为 subdir 放进 dst"，产生嵌套 | 不幂等导致第二次 install/update 产生 `.claude/skills/harness-init/harness-init/` 嵌套（VH-10 问题 A） | 二次安装/更新损坏 skill 结构 |

---

## Violation History

| ID | 日期 | 发生了什么 | 根因 | 对应约束 |
|---|---|---|---|---|
| VH-01 | 2026-04-01 | 本项目全程未使用 Harness（无 rules、无 hooks、无 constraints） | 初始化时没有 dogfooding 意识 | C-META-01 |
| VH-02 | 2026-04-02 | 新 session 不遵守 Harness 流程，被外部 skill 覆盖 | Rule 级别不够，需要 Hook 强制 | C-META-01 |
| VH-03 | 2026-04-03 | safety-guard.js 误拦 --force-with-lease（合法操作） | 正则 /--force\b/ 匹配到了 --force-with-lease 中的 --force | C-HOOK-02, C-TEST-01 |
| VH-04 | 2026-04-03 | mind-palace 项目 init 跳过了 session-logger、stage-guard、session-start | init-prompt.md 未列出这 3 个 Hook，AI 以"轻量适配"为由删减 | C-INIT-01, C-INIT-02 |
| VH-05 | 2026-04-03 | init 流程修改后只做了文件存在性检查就宣称 READY，没有在真实项目跑 init | 无 Hook 强制 VERIFY 阶段必须有真实验证，完全靠 AI 自觉 | C-GATE-01, C-GATE-02 |
| VH-06 | 2026-04-03 | `claude skill install` 启动新进程触发 session-start，重置了当前 session 的 stage/tool-count，导致 deadlock | session-start 无条件重写状态文件，不区分是否有活跃 session | C-HOOK-03 |
| VH-07 | 2026-04-06 | #9 CWD 修复在 EXECUTE 阶段直接 TaskUpdate completed 跳过 VERIFY，向用户宣称交付 | TaskUpdate 不在 stage-guard matcher 覆盖范围，delivery-gate 只检测语言模式无法拦截 | C-HOOK-06, C-GATE-01 |
| VH-08 | 2026-04-08 | 用户用 /harness-init 初始化时 Claude 生成结构错误的 .claude/settings.json，重启 session 立即报 "Invalid key in record"。绕开 skill 直接喂 init-prompt.md 内容则正常 | 4 个并存的失效模式：(1) skills/harness-init/SKILL.md 没要求 AI 读取 templates/settings-json.tmpl，AI 凭记忆拼 JSON；(2) SKILL.md 把必选清单硬编码成副本，与 init-prompt.md 漂移（4 vs 11 项）；(3) C-GATE-04 三模式 E2E 入口只覆盖 init-prompt.md 直接入口，从未覆盖 /harness-init skill 入口；(4) Skill 文件长期不在任何任务的 diff 中，从未被 Codex 交叉验收过 | C-INIT-04, C-GATE-06 |
| VH-09 | 2026-04-08 | 本 session F1-F5 产出的 6 条 meta 约束（C-INIT-04 / C-HOOK-06 / C-GATE-04 / C-GATE-05 / C-GATE-05a / C-GATE-06）和 VH-01..VH-08 全部只写入 workspace `docs/constraints.md`，**未同步到 kit 产品仓库 `docs/constraints.md`**。v0.7.0 release 时也没有任何人/工具检查此同步，带着 gap 发布。60+ 使用者上周开始用 kit，clone 仓库拿到的 meta 约束残缺 | Dogfooding feedback loop 最后一公里彻底缺失：(1) `.claude/rules/feedback-workflow.md` F4 步骤只说"写入 docs/constraints.md"，没说"如果是 kit-level 必须同步到 kit 仓库对应文件"；(2) `docs/release-process.md` 7 步流程没有 Step 0 检查 workspace↔kit 同步；(3) `tests/template-integrity.js` 13 个 T 检查全守 kit 内部自洽，没一个守"workspace vs kit 仓库"的 constraints 副本；(4) VH-08 的 C-INIT-04 教训只覆盖"kit 内部副本"（templates ↔ required-wiring ↔ SKILL.md），没扩展到"workspace vs kit 仓库"这对副本；(5) 本 session 作者（Claude）早期把 "T1 同步 constraints" 定性为"纯文档同步 20 分钟"的治标思维，忽略了机制化治根 | C-META-04 |
| VH-11 | 2026-04-09 | 用户 SJF 报告 v0.7.x init 后代码质量断崖: `qa-standards.md.tmpl` 是 56 行骨架，缺 TDD 铁律 + 5 层金字塔 + Spec Review + Santa + 量化指标。AI 读 rules/ 看不到行为指令 → 不做 TDD → 不写测试 → 直接提交坏代码。本 session 4 轮交叉验收全部未 catch: 所有测试只验机制完整性不验内容质量。模板从骨架改为完整 ~130 行含行为指令版 + T15 模板内容断言守门 + C-GATE-04 加 4 层验收矩阵 | C-GATE-04, C-SKILL-03 |
| VH-10 | 2026-04-08 | v0.7.0 交付后用户连续反馈 2 个 P0 低级 bug：**问题 A** — `update.sh` / `install.sh` 第 63 行 `cp -r "$skill_dir" "$dst/$skill_name"` 在 dst 已存在时产生嵌套 `.claude/skills/harness-init/harness-init/`；**问题 B** — `skills/harness-init/SKILL.md` 硬编码 `simple-harness-kit/templates/settings-json.tmpl` 这类 cwd-relative 路径，60+ 用户 cwd 不是 kit 父目录（例如 kit 在 D 盘），AI 报"无法找到 simple-harness-kit"，skill 入口直接坏 | 五层失效叠加：(1) **Shell 幂等性盲区**：`cp -r` 在 dst 存在时的"嵌套"行为是 BSD/GNU 共有意料外行为，install.sh 从来没测过二次执行，测试体系只覆盖"从零状态"；(2) **Skill 路径解析盲区**：没有测试验证"skill 中写的路径在真实用户 cwd 下能不能解析"，只有静态文件存在性检查；(3) **dogfooding 环境假象**：harness-dogfood workspace 碰巧把 simple-harness-kit 作为子目录，cwd-relative 路径在作者机器上恰好能 work，完美掩盖 bug；(4) **sub-agent 实验假 PASS**：本 session 早期跑 dogfooding 实验时在 sub-agent prompt 里手工提供了 kit 绝对路径，sub-agent 据此成功读文件，实验"全 PASS" ≠ SKILL.md 写得对——这是 VH-05 "mock 通过不代表真实"在 sub-agent 层的重演；(5) **E2E 入口盲区延续**：VH-08 虽然登记了 C-GATE-06 要求 skill 入口也测 E2E，但测的是"三模式 runtime"不是"真实用户 cwd"，仍然在作者机器上跑，没打破 dogfooding 环境特殊性 | C-SKILL-01, C-TEST-04, C-TEST-05, C-TEST-06, C-HOOK-07 |
| VH-12 | 2026-04-15 | install.sh 双工具支持 PR 在 REVIEW 阶段宣称交付，但 C-GATE-04 三 runtime 模式只测了 2 个（独立 agent + Claude Code），跳过 Codex CLI runtime。事后跑 Codex E2E 发现：(a) `init-prompt.md` 写"Codex 用 `--full-auto` 或 `-s workspace-write`"，但实测 `-s workspace-write` 会拒绝 `mkdir .codex` （sandbox 把 `.codex/` 视为受保护目录），Step 3.5 自动生成 `.codex/hooks.json` 直接失败；(b) 默认 sandbox 下 init 产物缺 `.codex/hooks.json` / `CLAUDE.md` / `AGENTS.md` / `docs/constraints.md`，但 PR 已 push。**根因**: REVIEW 阶段 6 项复盘第 6 项"改进机会"明知"未为 Codex 端做 E2E"却仍交付 = 主动豁免 C-GATE-04 而无机器守门。修复：init-prompt.md 改为只允许 `--full-auto`，标 VH-12，提示 sandbox 限制原因。**机器守门已加（C-GATE-07）**: `verification-gate.js` 第 4 层在 kit 仓库 commit 触及 `install.sh` / `update.sh` / `init-prompt.md` / `SKILL.md` / `resources/init-prompt.md` / `generate-codex-hooks.js` 时强制 verify-evidence 含三模式标记，缺任一 exit 2 | C-GATE-04, C-GATE-06, C-GATE-07 |
| VH-13 | 2026-04-15 | v0.8.0 发布后用户在 Codex runtime 遇到大量 "PreToolUse hook (failed) - error: hook returned invalid pre-tool-use JSON output"，每次 Bash 调用都报错。**根因**: 所有 hook 在放行分支执行 `process.stdout.write(raw)` 把 stdin 的请求 JSON（含 `tool_name`/`tool_input`/`hook_event_name`）原样写回 stdout。Claude Code 宽容接受（视为 allow-unchanged），但 Codex 0.118.0 严格按决策响应 schema parse stdout，收到请求 JSON → 判为 invalid。**C-GATE-07 三模式守门未 catch 此 bug**: VH-12 的 Codex E2E 证据只检查产物存在性（`.codex/hooks.json` 是否生成），未检查 Codex session 的 stderr / log 中是否含 "hook (failed)" 字样，Codex runtime soft-fail 的 hook 错误被视为成功。结果：v0.8.0 带着此 P0 兼容性问题发布到 60+ 使用者。**修复**: 删除 9 个 hook 共 19 处放行分支 `process.stdout.write(raw)`，改用空 stdout + exit 0（两个 runtime 都视为 allow-unchanged）。测试期望同步从 `"stdout": "passthrough"` 改为 `"stdout": "empty"`。**加固 TODO**: `tests/e2e-acceptance-validate.sh` 增加 "Codex session log 无 'hook (failed)'" 断言；否则下次 hook 改动若再引入 stdout 污染仍可能漏检 | C-GATE-04, C-GATE-07 |
| VH-15 | 2026-04-15 | v0.8.1 发布后用户在 Codex `/harness-init` 时仍看到 "hook returned invalid pre-tool-use JSON output"。**调查结论**: kit 代码无 bug — v0.8.1 hooks（empty stdout + exit 0）在 Codex 0.118.0 下冒烟测试 PASS（有 stage / 无 stage / block 路径三种组合均通过）。Codex 源码 `pre_tool_use.rs::parse_completed` 确认 empty stdout → Completed。最可能根因：target 项目残留 pre-VH-13 旧 hook 副本（仍有 passthrough stdout），`update.sh --hooks` 未执行。**真正教训**: VH-13 的"加固 TODO"从未兑现，用户仍是唯一 regression catcher。**修复**: 新增 `tests/codex-smoke.sh` + `codex-smoke-selftest.sh` + `tests/run.js` 集成，兑现 VH-13 遗留 TODO。新约束 C-GATE-08 | C-GATE-08 |
| VH-14 | 2026-04-15 | 用户反馈"经常出现时间戳不一致的问题， 我觉得这个有点问题"。**根因**: `harness-stage-guard.js::validateSince` 把 `SINCE_DRIFT_LIMIT` 设为 5 分钟。AI 写 `.harness/current-stage.json` 的 `since` 字段时不知真实墙钟，必须先 `date -u` 再抄进 JSON，抄的过程中常因跨 tool 调用墙钟继续走动而超出 5 分钟窗口被拒。守门的实际用意是"防止 AI 手编递增时间戳骗过 verification-gate evidence freshness"，不是"必须精确到分钟"。**决策评估**: 方案 A（`since:"auto"` sentinel + PostToolUse autofill）最彻底但引入新 hook 与自愈失败模式；方案 B（窗口放宽到 30 分钟）一行改、零架构变动、invariant 仍成立（30 分钟远大于 AI 手抄正常 drift，远小于"覆盖 evidence mtime"所需跨度）；方案 C（彻底删检查）会把 evidence freshness 降级为存在性（重演 VH-08 的坑）。**取 B**，3 新测试场景覆盖窗口边界（15 分钟过去 PASS、45 分钟过去 REJECT、20 分钟未来 PASS）。**加固 TODO**: 若 30 分钟窗口实战仍超窗 → 再升级到方案 A（sentinel + autofill） | C-HOOK-\* 工具层 |
| VH-16 | 2026-04-17 | 用户在 `mind-palace/workspaces/recruiting/candidates/2026-04-17-zhou-live-task/` 子目录启动 Claude Code，Stop hook 报 `Cannot find module '.../<subdir>/scripts/hooks/delivery-gate.js'`。调查发现 mind-palace `.claude/settings.json` 所有 hook `command` 是裸 `node scripts/hooks/<X>.js`，cwd=子目录时相对路径解析到不存在路径。**根因**: kit 两份模板（`templates/settings-json.tmpl` + `skills/harness-init/resources/settings-json.tmpl`）本身就是裸相对路径，所有用 kit init 出来的项目都有潜在 bug，只是没人从子目录起 session 就不触发。dogfooding workspace `harness-dogfood` 因为 kit 在子目录，`.claude/settings.json` 的 hook command 带了 `simple-harness-kit` marker 的 wrapper 所以没撞 — **VH-10 教训再次复演**（dogfooding 环境碰巧能 work = 假 PASS）。VH-10 已学到 SKILL.md 路径需 find-root，但 settings.json 的 hook path 同类问题被忽略。**修复**: kit 两份模板都加 find-root shell wrapper（marker=`scripts/hooks/find-root.js`），新增 C-HOOK-08 + T16 守门；热修 mind-palace `.claude/settings.json` 29 处 hook command 全 wrap。**同 release (v0.8.7)**: VH-14 Option A sentinel (C-HOOK-09) + 05-mutation-test M1 + codex-smoke-selftest + release gate (C-GATE-09) | C-HOOK-08 |
| VH-17 | 2026-05-29 | SHK 自身在 Claude Code 后台 session 中使用 worktree 模式自维护时遭遇硬死锁：（A）`scripts/hooks/find-root.js` 从 cwd 向上查 `.harness/`，git worktree 因 `.gitignore` 不带 `.harness/` → 函数一路上探到主仓库的 `.harness/`；（B）所有 hook 因此把主仓库当 root，`STAGE_FILE` / `PLAN_FILE` 锚到主仓库路径；（C）Claude Code 的 bg-isolation 守门强制 bg session 的所有 Write 必须落在 worktree 内，拒绝主仓库路径；（D）两个守门方向相反，`Write .harness/current-stage.json` 切换 PLAN→EXECUTE 永远 exit 2。隐藏 bug：worktree 内 SessionStart hook 因为同样的 find-root 错误**直接覆写主仓库的 active stage 文件**，多个 worktree 并发就会互相踩。**根因**: 三层叠加—(1) 方法论 / `.gitignore` 注释只写"per-machine 实例"语义，没区分"per-machine"与"per-worktree-session"两个粒度；(2) find-root 假设 `.harness/` 是绝对锚点，没考虑"虽未创建但必须停在此层"的语义边界；(3) hook 写文件全部 try-catch 静默吞失败 → 行为差异不可见，dogfooding 早期未撞 worktree 场景所以一直没暴露。**修复方案 C**: (a) find-root 检测 cwd 匹配 `*/.claude/worktrees/<name>(/...)?` → 停在 worktree 边界返回；(b) `harness-session-start.js` + `harness-stage-guard.js` 写状态文件前 `mkdir -p .harness/` 自举；(c) 引入 `WORK` 区域 + C-WORK-01 / C-WORK-02 + JC-08；(d) 新写 `methodology/20-worktree-workflow.md`；(e) 不动 `.gitignore`（`.harness/` 仍是 per-session transient state）。**临时手段**: 修期间在主仓库 settings.json 加 `worktree.bgIsolation: none`，T6 完成后恢复。**dogfood 二次教训**: bg-isolation × find-root 的兼容性属于"双方都按各自语义正确"的产物，VH-10/VH-16 学到"作者环境特殊性产生假 PASS"，VH-17 是同类——SHK 维护者过去都在 main checkout 工作，从未在 worktree 内 dogfooding，所以这道死锁 9+ 个月没被发现。**加固 TODO**: 把"在 worktree 内跑一次 PLAN→EXECUTE"列入 release 前必跑路径，写入 `tests/pre-release-check.sh` | C-WORK-01, C-WORK-02 |
| VH-18 | 2026-05-29 | Codex 对 PR #5（含 VH-17 修复 + 用户的 commit-rules 工作）review，5 项缺陷：(F1) skills/git-commit/SKILL.md + tests/hook-scenarios/commit-check.json + branch-policy-guard.js 含内部专属信息——公司自定义 preset 名、内部业务模块名、真实任务号、内部 ticket 前缀、内部风格标签，违反"公开 kit 用中性占位"原则；(F2) git-commit skill 推荐 `git commit -m "subj" -m "body+coauthor"` 多 -m 形式，但 commit-check.js 只解析第一个 -m，误判缺 Co-Authored-By；(F3) v0.9.0 的 mkdir 自举无条件触发，在普通空目录跑 hook 会创建 `.harness/` 污染该目录；(F4) constraints.md C-WORK-02 声明的测试路径 `tests/scenarios/find-root-worktree-boundary` 实际不存在；(F5) `detectWorktreeRoot` 正则只匹配 `/`，Windows 路径返 null。**根因**: (1) F1/F2 是用户 commit-rules 工作引入，发 PR 前未做公开仓库 sanity；(2) F3 是 VH-17 修复 commit `9dacdb1` 顶层 mkdir 没加守门——VH-17 偏差记录 #3 已经提到"tests/run.js 未加 worktree boundary 测试，靠人为沙盒验证"是加固 TODO，但 PR 发布时没补齐；(3) F4 是 C-WORK-02 文档先于测试写出，承诺测试路径但实际未创建；(4) F5 是开发者只在 Unix 环境验证，没思考 60+ 用户里的 Windows 子集。**修复**: (F1) 内部专属词 → 抽象提法（"公司自定义 preset" / "内部业务模块名" / "内部任务号" / "内部 ticket 前缀"）+ `JIRA-1234` / `PROJ-42` / `billing` 中性占位；删 9 个内部 preset fixture；(F2) commit-check.js 多 -m 用 `\n\n` 拼接（git 真实行为），加 3 个 fixture；(F3) `find-root.js` 新增 `isLegitimateHarnessRoot(root)`：仅 worktree-pattern 或已存 `.harness/` 才放行；session-start / stage-guard 顶层加守门，否则 exit 0；4 个老 stage-guard fixture 加 `.harness/.gitkeep` setup 表达"真 Harness 项目缺 stage"；(F4) 加 `tests/hook-scenarios/find-root.json` 6 项集成 + tests/run.js 13 项 detectWorktreeRoot/isLegitimateHarnessRoot 纯函数单元；C-WORK-02 文档更正测试路径；(F5) `detectWorktreeRoot` 入口 `cwd.replace(/\\\\/g, '/')` 归一化反斜杠；纯函数单元含 3 个 Windows case。新增 C-WORK-03（mkdir 必须经 isLegitimateHarnessRoot 守门）。**Round 2 review 又抓到 2 项**: (R2-1) 本 VH-18 entry 初版直接列出内部专属词（"从 skill 删完又写回 violation history" 等同没删）→ 抽象化重写；(R2-2) F2 多 -m 解析分 3 趟跑（先双引、再单引、再 --message=）顺序错乱：`git commit -m 'subj' -m "trailer"` 拼出 `trailer\n\nsubj`，subject 被识别成 trailer 内容 → 改单 regex 按 `match.index` 自然迭代保序，加 mixed-quote fixture。**meta 教训**: (1) F3 是"VH-17 自带加固 TODO 实际就是 production blocker"的典型——交付时把"加固 TODO"当成"以后再做"，等于把 P1 bug 留给下游 reviewer 发现；(2) Round 2 R2-1 教训——"清理"不仅是删源，也要清沉淀文档；写 VH 时本能想列具体词以便定位，但公开 kit 的 VH 应当只描述类别。"Codex review = 用户"的镜像案例：codex 在外部 reviewer 角色发现了我作为内部 dev 没主动去 cover 的盲区。下次 release 前应跑一遍 codex pre-review 而不是等 PR 阶段 | C-WORK-02, C-WORK-03, commit-check / SKILL 内容质量层 |
| VH-19 | 2026-06-02 | 用户指出“SHK 没有生效”。调查发现 config 中 hooks 已开启且 PostToolUse session-log/observations 能记录 Bash，但 PLAN 阶段写类命令未被 stage-guard 拦截，安全规则中的阻断命令也未在当前通道阻止执行。**根因**: 既有验证把“hook 无 failed marker”和“PostToolUse logging 有记录”当成 runtime 健康，缺少“PreToolUse command 真实执行并能阻断”的独立观测；当 PreToolUse enforce 半失效时，SHK 表面仍有日志，实际准入/准出边界已失效。**修复**: stage-guard 每次 PreToolUse 写 `.harness/pretool-observations.jsonl`；新增 `scripts/shk.js doctor` 检测 PostToolUse Bash 有记录但 PreToolUse 无观测的组合并 FAIL；新增 `tests/quality-suite.test.js` 覆盖 doctor 发现该状态；新增 C-GATE-10 | C-GATE-10 |
| VH-20 | 2026-06-02 | 用户同步最新版 SHK 后开新 Codex Desktop session，`.harness/current-stage.json` 与 `.harness/pretool-observations.jsonl` 均显示 hook 已执行，但 UI/模型上下文没有出现 `HARNESS MODE ACTIVE` logo/banner。继续排障时发现当前 Codex 会话没有 Claude Code 的 `Write` 工具，PLAN 阶段又禁止 `apply_patch .harness/current-stage.json`，导致 agent 无法按 guard 提示切到 EXECUTE；一次手工 bootstrap 写坏 JSON 后，非法 stage 文件让所有工具继续被 guard 拦截，只能请用户在外部 Terminal 恢复。**根因**: (1) `SessionStart` stderr 在 Codex Desktop 不可靠可见，side effect 生效不等于可见入口生效；(2) stage-guard 把 `Write` 当作唯一 stage 切换/恢复通道，未适配 Codex 的 `apply_patch` 工具体系；(3) PLAN_BLOCK_MSG 文字写着允许 apply_patch stage 文件，但实际代码分支拒绝该行为，文案与守门行为冲突。**修复**: 新增 `harness-entry-banner.js` 挂 `UserPromptSubmit` 输出 Codex 可解析 `additionalContext`；模板/required wiring/resource 同步；stage-guard 对仅修改 `.harness/current-stage.json` 的 apply_patch 提取目标 JSON 并复用 stage/since/Infra Tier/REVIEW gate；新增回归测试 | C-HOOK-10, C-HOOK-11 |
| VH-21 | 2026-06-04 | Phase 2「spec 驱动质量门」交付后 review（文档+实现+实跑+双独立 Claude sub-agent 对抗）发现 8 条质量门可绕过漏洞：mutation 文本回退/自声明、空壳 test_plan 靠 ID 字符串命中、E2E 充分性纯关键字、verify 全链路对空壳输出 READY、hook 严 CLI 松双标准、EXECUTE 只切入时检查、acceptance 全局计数。均用最小反例端到端复现 | 质量门的语义层退化为关键字/ID 字符串包含、自声明状态、仅切换瞬间检查；结构存在性检查扎实但证明力判定可糊弄。同时暴露 C-GATE-05 codex 铁律与 Director「Claude 不交叉调用 codex」指令冲突，05a 豁免只认 infrastructure 不认 Director 偏好 | C-GATE-11, C-GATE-12, C-GATE-13, C-GATE-14, C-GATE-05, C-GATE-05a |
| VH-22 | 2026-06-05 | GitHub Issue #10 报告：Phase 2 分支中新 init 项目表面全绿，但首次触发 `harness-stage-guard` 报 `MODULE_NOT_FOUND`。根因是 `harness-stage-guard.js` 依赖 `../lib/spec-quality`，而 init 的复制/验收早期只看 `scripts/hooks/` 和 settings 引用脚本是否存在，没有把 hook 自身本地依赖作为用户层完整性检查。当前分支已补 `scripts/lib/spec-quality.js` 到 required files，并进一步增加“settings 引用 hook 的本地 require 依赖必须存在”守门 | init 验收停留在“文件名存在”，没有验证 hook 可加载；共享库跨目录依赖缺少单一真实源和测试守门 | C-INIT-05, C-INIT-03, C-INIT-04 |

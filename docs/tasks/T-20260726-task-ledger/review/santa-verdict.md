# Santa 双独立审查 — NAUGHTY

两个 Reviewer 在隔离上下文、相同 rubric（spec.json 的 R1-R11 / RK1-RK8 / A1-A8）下独立审查，
**双方均判 FAIL**，且核心发现高度重合——重合本身就是可信度信号。

kit 自有测试 245/245 全绿，`shk verify --risk high` 报 overall READY。
**两项都是假信号**：READY 之所以成立，正是因为门禁消费方读不到新位置的证据，
结构化检查被整体跳过了。绿灯是缺陷的症状，不是质量的证明。

## 双方一致的 Critical

| 缺陷 | A | B | 根因 |
|---|---|---|---|
| 任务模式下 commit gate 失效（fail-open） | F1 | F1 | 产出写入路径改了，三个消费方读取路径没改 |
| 迁移后 gate 永久读陈旧证据 | — | F2 | migrate 只复制不移动，legacy 证据残留且永不更新，而它在 REPORT_PATHS 里排第一 |

同一份 NOT_READY 证据：有 CURRENT 时 gate exit=0 放行提交，移除 CURRENT 后 exit=2 拒绝。
**打开这个特性等于关掉门禁。**

## 双方一致的 High

| 缺陷 | A | B |
|---|---|---|
| delivery-gate 任务模式下永久阻塞，且提示的命令无法执行 | F3 | F3 |
| stage-guard REVIEW 门禁降级为文件存在性检查 | F2 | F4 |
| 缓存记录 normalize **之前**的状态，release 类 FAIL 被缓存成 PASS | F8 | F5 |
| LEDGER_NOISE 正则未锚定，`src/evidence/*.js`、`INDEX.md` 等真实源码被排除出变更集 | F5 | F6 |
| classify() 漏掉 .vue/.env/fixtures/yaml/Dockerfile/lock 等，改了不重跑 | F4 | F7 |
| `!docs/tasks/` 在父目录被忽略时无效，整个 ledger 被 gitignore | F6 | F8 |
| migrate 无目录存在守卫，覆盖已有任务的 spec/plan，并把 closed 任务改回 open | F7 | F9 |
| selectTests 是死代码，R9 只报告不实现 | F9 | F10 |
| upgrade 路径给不到 task 能力（DEFAULT_REF 过期 + update.sh 不同步 shk.js） | F12 | F15 |

## 最刺眼的一条

`.gitignore` 的父目录取反陷阱——**设计文档 §2.2 决定 6 里我自己写过这个 git 语义**，
实现时照样踩了。写下规则不等于遵守规则；只有可执行的检查才算数。
T6 的断言"生成的 .gitignore 规则不排除 tasks_dir"是文本匹配，恰好漏掉了语义。

## 对"绿灯"的结论

- 245/245 单测全绿：这些缺陷全部在测试覆盖面之外
- `shk verify --risk high` 报 READY：READY 本身由被绕过的门禁产生
- 我为本轮补的 E2E（20-task-ledger-e2e.sh，29 断言）也全绿：它测的是产出侧，没测消费侧

**三层绿灯同时失效，因为它们测的是同一侧。** 这正是需要独立对抗审查的原因。

## 处置

进入 Fix Cycle。修复顺序按根因聚类而非按编号，详见 journal。
在全部 critical/high 修复并由全新 Reviewer 复审通过前，本分支不推送、不发 tag、不迁移真实工程。

---

# Fix Cycle R1 复审（Fresh Reviewer）— 仍判 FAIL

9 条里 4 条确实修好（normalize 顺序、migrate 守卫、CACHED 标注、update.sh 同步 CLI），
证据路径路由在主路径上也确实生效。但：

## Critical 没关掉，只是换了一扇门

`writeEvidence` 每轮无条件写 `docs/verification-report.md`，它在任务模式候选列表排第三；
`readStructuredEvidence` 对非 `verify-evidence.json` 结尾的路径返回 null，于是它一旦胜出，
overall / e2e / 风险档检查全部跳过。**`shk task new` 之后新任务尚无证据，提交直接放行。**
与原始 F1 同样的结果，经由日常流程即可触发。

## 我上一轮改坏了一个东西

`upgrade.sh` 的 `DEFAULT_REF` 被我改成尚未推送的 `feat/task-ledger`。远端不存在该 ref，
checkout 以 128 失败、`set -euo pipefail` 下整个升级中止。
**把"过期但能用"改成了"硬失败"，比原问题更糟。**

## 最该记的：复审对方法的批评

上一轮的 verdict 自己写着"三层绿灯都失效，因为测的是同一侧"，
而那一轮的修复：加了 29 条**仍然只测产出侧**的 E2E、**零新单测**、
Critical 修复**没有任何回归锁**。测试总数 245 → 245，一个没变。

F-A 和 F-D 正是这样活下来的。**写下教训、甚至把教训写进交付文档，都不等于应用了教训。**
只有当教训变成一条会失败的检查，它才开始起作用。

R2 因此改变顺序：先写 5 个任务模式门禁场景 → 确认第一条真的红 → 再改代码。
测试总数 245 → 250。

## R2 已修

| 复审编号 | 问题 | 修法 |
|---|---|---|
| F-A | 任务模式下弱证据让门禁 fail-open | 任务模式拿不到结构化证据即拒绝；存量模式行为不变 |
| F-C | stage-guard 裸 require，lib 缺失时崩溃=守门消失 | try/catch 降级到 legacy 路径实现 |
| F-N | DEFAULT_REF 指向未推送分支，upgrade 直接中止 | 回到已存在的 tag，并写明"必须是 origin 已存在的 ref" |
| F-K/F-L | gitignore 检查只挂 migrate，主流程 task new 没有 | task new 同样调用；CURRENT 现在被正确忽略 |
| F-F | classify 漏 .json/.tmpl（kit 自身 template-integrity 就测 .tmpl） | 补进 config 类；.md 刻意不补，否则缓存收益归零 |
| F-H | ledgerNoiseMatchers 自己解析 tasks_dir，与 ledger 不一致 | 复用 ledger.tasksDir()，非法配置下两边同步回退 |
| F-O | init-prompt.md 两份未同步 shk.js | 两份都补 |

## R2 未修（如实列出，等第三轮或降级接受）

- **F-D** REVIEW 门禁降级：复审判未修，但我新增的场景 5（任务模式无结构化证据切 REVIEW）
  在 strict 下测出 deny。两边结论不一致，需要对齐复现路径后再定。
- **F-B** light 模式下无 stageSince 锚点，陈旧弱证据无条件通过。这是 light 模式的既有设计
  （v3 的 B5 议题"证据自锚"就是为它立的），不属于本分支引入，但本分支放大了它的影响面。
- F-E delivery-gate 的 `evidencePathList()` 是死代码、`EVIDENCE_PATHS` 仍硬编码 legacy
- F-J migrate dry-run 在目标目录已存在时现在退出 1（行为变化，非破坏性）
- F-M gitignore 警告只走 stderr，migrate 仍返回 0，自动化检测不到
- F-I `docs/verification-report.md` 未列入噪音，永远出现在变更集里
- F-G `.css/.html/.sql/.tf` 归为 source，前端项目缓存命中率趋近于零（保守方向，可接受）
- 文档不一致：三处 methodology/skills 仍把 `.harness/last-verification.json` 写成有效证据落点，
  而任务模式不再接受它

## 状态

Santa Fix Cycle 已用 2 轮（上限 3 轮）。第三轮复审未做。
**在此之前：不推送、不发 tag、不迁移真实工程。**

---

# Fix Cycle R2 复审（第三轮 Fresh Reviewer）— FAIL，但很窄

**先说结论里最重要的一句：HEAD 上没有活的 fail-open。** 每个"必须拦"的探测都拦住了
（悬空 CURRENT、损坏 JSON、伪造证据缺 schema_version、任务目录里的弱 md、低风险证据
遇上 git tag、自定义 tasks_dir）。存量模式在 12 个状态下与升级前逐位相同。
Critical 与 High 是真修好了，4 个指定变异抓到 3 个。

**这一轮是真改进，不是又一次纸面修复**——复审的原话。

## 变异测试：3 抓 1 逃

| 变异 | 结果 |
|---|---|
| 移除 verification-gate 的任务模式 `!structured` 拒绝 | 抓到 |
| 移除 stage-guard 的 `!structured` 分支 | 抓到（同时坐实 F-D 确曾存在） |
| `structuredEvidencePath` 永远返回 legacy | 抓到（4 个场景一起红） |
| **`evidenceSearchPaths` 把 legacy 追加到任务模式列表** | **逃逸** |

逃逸那条的后果就是 Santa F2 原样复现：门禁读一张永不更新的旧快照。
6 个场景 + 27 个单测全绿，而行为已经错了。

根因：承载 Critical 修复的两个函数**零单测覆盖**。
场景测试只覆盖夹具里出现过的组合，覆盖不到"多加一项"这种形态。

## R3 已修（最小集里属于代码的部分）

| 项 | 修法 |
|---|---|
| N1 | `tests/run.js` 的 `expect` 加键名+类型白名单。加上后立刻抓出我自己漏登记的 `files`/`dirs`——**校验当场证明了自己有效** |
| N2 | `evidenceSearchPaths`/`structuredEvidencePath` 五条单测，用 `deepStrictEqual` 锁整个列表。重放 M3a：单测红、场景仍绿，证明这个洞只有单测能堵 |
| N5 | 真调 `git check-ignore` 的断言，给"最刺眼的一条"补上回归锁 |
| N3 | `spec-quality` 裸 require 加降级，与 task-ledger 同理；降级返回 `overall: UNKNOWN` 而非伪装通过 |
| N4 关键项 | `skills/auto-harness-qa/SKILL.md` 不再指示写 `.harness/last-verification.json`（任务模式门禁不接受，会产出假 bug 报告） |

## 未修，明确记为已知问题

- **F-N（发布顺序约束，非代码问题）**：`upgrade.sh` 的 `DEFAULT_REF=v0.13.0-rc.1` 指向
  `c2a9105`，早于本特性。默认 `curl | bash` 装的 kit 没有任务态能力，却会打印一条
  `task migrate` 命令，实跑 `MODULE_NOT_FOUND`。**这是鸡生蛋**：必须先 tag 才能指过去。
  处置：**tag → 改 DEFAULT_REF → 重跑升级 E2E**，并加一条断言 DEFAULT_REF 对应的 tree
  里含 `scripts/lib/task-ledger.js`。R1 已经把这个字段写错过一次，注释不是控制手段。
- N4 余量：`methodology/` 与 `README.md` 另有 2 处提及 `last-verification.json`。
  可以合并，但**不能带着它发版**。
- N6 存量模式仍是宽松模式（R4「存量行为不变」的必然结果，任务模式是唯一被加固的模式）
- N7 `verification-gate` 缺 `hasDegradedRequiredCheck`，与另两个 gate 对同一状态判断不一致（**升级前就存在**）
- N8/N9 及 R2 已声明的 F-B/F-E/F-G/F-I/F-J/F-M

## 状态

Santa 三轮用尽，按规矩升级人工判断。
复审给出的人类决策点很窄：**代码侧最小集已做完；剩下的 F-N 是发布顺序，不是代码。**

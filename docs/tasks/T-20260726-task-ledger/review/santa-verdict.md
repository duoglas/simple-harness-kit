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

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

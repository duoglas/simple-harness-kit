# android-ops 经验回流 kit

来源：对 android-ops 全量扫描出 16 条候选，用户逐条判定。判据统一为
「把 android-ops 整个删掉，这条经验还成立吗」。

## 判定结果

| # | 内容 | 判定 | 落点 |
|---|---|---|---|
| ① | context-monitor 按写次数计数，真实自变量是上下文深度 | **改** | `scripts/hooks/context-monitor.js` 加时长/深度维度 + session 起始 + 跨天检测，保留写次数为辅助信号 |
| ② | C-GATE-18 阈值 200，实测 P90 2200 / 峰值 2700 | **按实测重调** | 默认值常量 |
| ③ | run-guarded 超时治理（唯一净新增工程件） | **搬脚本 + 加约束** | 移植 4 文件 + 新增 C-AGENT-01 |
| ④ | Santa 从未定义「审的是哪个版本」 | **写进规则 + 模板** | `agent-dispatch.md.tmpl` Reviewer 段 + `06-agent-isolation.md` |
| ⑤ | shell 四条铁律（tail 的 $?、pipefail 静默死、不写死总数、修 bug 的代码两分支都测） | **约束 + 方法论 + 静态检查** | 新增 C-HOOK-* + `21-quality-gate-suite.md` + tests/ 加检查 |
| ⑥ | 行为断言 vs 调度断言；新闸门必须配能变红的变异靶子 | **两条都收** | `qa-standards.md.tmpl` Layer 1 + `04-qa-pyramid.md` |
| ⑦ | 绿灯必须声明它覆盖了哪些消费方 | **只写方法论，不立约束** | `21-quality-gate-suite.md` + `15-hook-coverage-matrix.md` |
| ⑧ | reviewer 只读是纪律非沙箱；kit 无 Deployer 角色、只有上下文隔离没有权限隔离 | **全补** | `agent-dispatch.md.tmpl` + `role-constraints.md.tmpl` + `02-roles.md` + `06-agent-isolation.md` |
| ⑨-A | 多阻断汇总成单一矩阵，不逐个交还控制权 | **要，阈值放宽到两轮** | `role-constraints.md.tmpl` 自治约定段 |
| ⑨-B | 实现完成 ≠ 已部署，默认终点 READY_TO_DEPLOY | **要** | 同上 |
| ⑩ | 一个因果假设 = 一个可独立还原的候选；任务文件必须对应真实在做的事 | **两条都要 + 漂移告警** | 新增约束 + `harness-learn.js` 加一项告警 |
| ⑪ | 生产回归第一动作是产物 diff 而非假设检验 | **写进方法论** | `08-feedback-loop.md` 的 F2 分类步骤 |
| ⑫ | 时间盒 30s/10min/2min/60s；workbench 熔断规则未回流 | **合并进 ③ 的时间治理包** | 同 ③ + `role-constraints.md.tmpl` |
| ⑬ | 单测参数必须等于生产参数；同量级负载窗口；墙钟 vs CPU | **全收** | `04-qa-pyramid.md` Layer 2 + `qa-standards.md.tmpl` |
| ⑭ | 观察循环四条（真墙钟、别自己成负载、pipefail 下别用 grep -q、优先报加载超时） | **整条收** | 并进 ③ 的包与 ⑤ 的 shell 铁律 |
| ⑮ | 结构化输入工具 payload 折叠 | **跳过** | — |
| ⑯ | 独立 review 必须在 PLAN 拆解时显式列成一个任务 | **收** | `harness-entry.md.tmpl` PLAN 清单 + `03-workflow.md` |

## 执行分组

- **A** 修 kit 自己的错：① ②
- **B** 时间治理包：③ ⑫ ⑭
- **C** review 与角色：④ ⑧ ⑯
- **D** 测试与门禁：⑤ ⑥ ⑦ ⑬
- **E** 流程与归因：⑨ ⑩ ⑪

## 边界

- 只回流通用经验，android-ops 专名（adb / BeanShell / 微信 / 红包 / 装配体 / routeCommand / UiPort）一律中性化
- ⑦ 明确不立约束，只作方法论指导
- ⑯ 不改风险分级策略，只要求 review 进任务清单

---

## 落地结果（2026-07-29 全部完成）

15 条采纳全部落地，1 条（⑮ payload 折叠）按判定跳过。252/252，五个 commit 已推送。

| 组 | commit | 内容 |
|---|---|---|
| A | `5d112b8` | context-monitor 改按上下文深度度量；C-GATE-18 阈值 200→2500 |
| B | `d4e2ed1` | run-guarded 四文件移植；AGENT 区域与 C-AGENT-01/02/03；workbench 熔断回流 |
| C | `de210fe` | review 冻结被审对象；Deployer 角色与权限隔离维度；review 进 PLAN 清单 |
| D | `c992bfd` | shell 铁律 L1-L4 与静态检查；行为断言与变异靶子；测量有效性；覆盖面声明 |
| E | `a064eff` | 阻断汇总；READY_TO_DEPLOY 双授权；C-AGENT-04 归因隔离与漂移提示；F2 产物 diff |

## 过程中自己撞到的三件事

**新写的闸门第一版都是假的**，两次都靠变异才发现：

1. `template-integrity` 的 required_files 比对——glob 判定写成"出现过 `scripts/` 且
   出现过 `*.js`"，任意 `scripts/*.js` 都算已覆盖。塞一个绝不会被复制的文件进去，照样全绿。
2. `harness-learn` 的漂移检测——判据用"任务描述与文件路径的词重叠"+ ASCII 正则分词，
   对中文任务名整个失效。而这类项目的任务名基本都是中文。

第三件是 shell lint 首跑就抓到三处真实隐患，**其中两处在我自己上一轮写的 E2E 里**
（`$(cat CURRENT)` 在夹具没生成时零输出退出，看不出哪步失败）。

## 沉淀

- **规则写进文档不算生效，被变异打过一次才算。** 本轮回流的 ⑥ 条要求"新增安全阀必须
  自带能变红的靶子"，而我在同一轮里两次需要这条规则来救自己。
- **语言相关的判据在多语项目里不可靠。** 文本匹配类的检测要么语言无关（时间、计数、
  路径结构），要么明确声明只对某语言有效。
- **required_files 咬了三次才补检查。** 声明与实现两处分离时，等 e2e 间接发现的代价
  远高于直接钉一条比对。


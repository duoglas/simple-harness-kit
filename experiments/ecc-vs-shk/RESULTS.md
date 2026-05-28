# 实验结果：ECC 驱动 vs SHK 驱动迭代本工程

> 日期 2026-05-28。设计与评分标准见 [SPEC.md](SPEC.md)。
> 两条 lane 独立 worktree、相同任务规格与汇报契约，仅"驱动方法论"不同，同用 sonnet。

## 方法论诚实声明（必读，先于结论）

本实验**未达到严格的 pre-registered 标准**，以下事实在 PR#4 跨模型 review 中被指出，
此处如实保留以避免日后误读：

1. **`SPEC.md` 与 `RESULTS.md` 在同一个 commit（`39a66f2`）、同一秒提交**——git 历史
   无法独立证明 SPEC 写定先于 RESULTS。"预注册"在此**仅指会话内时序**（SPEC 内容确实
   在 lane 子 agent 派遣之前由控制器写定），而非 git 时序。读者若要追求严格的预注册
   证据，应取会话原始 transcript 而非本仓库 git 历史。
2. **M2 工具调用数有两组**：harness 自动记录的 `tool_uses` 总数（40 / 23）与子 agent
   自报数（20 / 16）有 ≈ 2× 偏差，原因可能是 subagent 自计漏掉了内部转发的调用。
   下表已统一改用 harness 记录的更权威数值。
3. **M4 方法论洞察由控制器（同一 AI session）人工判定**，无独立见证方。结论仍站得住
   的根据是**洞察具体内容可被读者独立核验**——见 `lane-a/REPORT.md` §INSIGHTS 与
   `lane-b/REPORT.md` §INSIGHTS 全文，以及它们对应催生的 commit。
4. 实验的"AI 同时扮演 Lane A / Lane B / 评审者三角色"是真实结构性限制；本 PR 引入的
   跨 model（codex + 独立 Claude）外部 review 流程正是为弥补这一点。

记住：实验是发现性的、不是审计性的；这些限制不抵消结论，但读者应据此调整置信度。

## 评分卡

| 指标 | Lane A（SHK 驱动） | Lane B（ECC 驱动） | 胜 |
|---|---|---|---|
| **M1 完成度**（gate, /4） | T1=2 T2=2 = **4** | T1=2 T2=2 = **4** | 平 |
| **M2 效率**（工具调用 / 耗时） | 40 calls (harness 记录，子 agent 自报 20) / 221s | **23 calls (harness 记录，子 agent 自报 16) / 153s** | **B** |
| **M3 质量**（evaluate.sh 自动, /5） | **5/5** | **5/5** | 平 |
| **M4 方法论洞察**（可写回 methodology/） | 2 条 + **1 条 dogfood 才暴露的 meta-gap** | 1 条真洞察 + 1 条"关于适配 ECC 成本" | **A** |
| **M5 规范契合** | 中文✓ emoji 0✓ bash(贴合 tests/) | 中文✓ emoji 0✓ JS(贴合 hooks/) + workflow 更健壮 | 略 B |

两条 lane 的**原始 SCORECARD/FRICTION/INSIGHTS/SELF_VALIDATION 汇报全文**见
[`lane-a/REPORT.md`](lane-a/REPORT.md) 与 [`lane-b/REPORT.md`](lane-b/REPORT.md)；
最终产物（`ci.yml`、`validator.*`）在同目录；自动打分器 `./evaluate.sh` 可复跑。

## 关键发现

1. **原始交付物打平**：M1、M3 都满分。两条路线都产出了能用、正确（抓泄漏、不误报、中文、可测）的 CI + validator。说明"做一个具体任务"两条路都行。

2. **B 更快、工程更健壮**（证实"ECC 给工程马力"）：Lane B 少用 ~40% 工具调用、快 1/3，且 workflow 自带 `concurrency: cancel-in-progress` + `timeout-minutes`——这是从 ECC 成熟 CI 约定继承来的健壮性，Lane A 没有。

3. **A 产出更高的产品价值**（证实核心论点）：
   - Lane A 的洞察直指 SHK 自身机制：「CI 最小权限 + pin 版本应写进 `constraints.md` 成为固定约束，而非靠 AI 每次记得」——可直接落地改进产品。
   - 更关键：Lane A 在摩擦里**暴露了一个只有 dogfooding 才会发现的 meta-gap**——
     **SHK 仓库自己不是一个完整 Harness 实例**（没有 `.harness/current-stage.json`），所以 SHK
     无法用自己的 stage-guard / verification-gate 来约束自己的开发。这是产品级缺陷，外部工具永远照不出。

4. **B 的洞察大多是"关于 ECC 的"**：impedance mismatch、ECC validator 硬编码目录需 ~30% 重写、ECC 的
   CI 矩阵对纯文档仓库过度设计「适配实质变成重写」。这本身就是反证——**用 ECC 迭代 SHK，主要学到的是
   ECC 的不合身，而不是如何改进 SHK 的方法论。**

## 结论（证实预注册预测）

- **单任务工程效率：ECC 驱动更优。** 成熟基座 + 健壮 CI 约定让它更快更稳。
- **产品价值（方法论改进）：SHK 驱动大幅更优。** 只有 dogfooding 能产生 F1-F5 反馈、暴露自身 meta-gap。
- **用 ECC 造 SHK 自相矛盾**：改善的是代码，不是产品；且会把"学习 ECC 不合身"误当成进展。

**采纳策略**：日常用 **SHK 自己驱动**（dogfooding 为主回路），把 **ECC 当零件供应商 + 外部预言机**——
借它的工程健壮性约定（concurrency/timeout/commit-pin、成熟 validator 结构），但不让它当日常驱动。

## 本实验直接产出的真实 backlog（dogfooding 副产品）

1. **[产品 bug]** SHK 仓库非完整 harness 实例，无法自我强制阶段约束 → 在仓库内放最小 `.harness/` 实例，让 SHK 能 dogfood 自己的 hooks。
2. **[methodology]** 把"CI 最小权限 + pin 版本 + concurrency + timeout"写进 `constraints.md` 作为生成 CI 的固定约束。
3. **[methodology]** 区分 pin 成熟度两阶段：新仓库 `@v4` tag pin 起步，生产级再上 commit-hash pin（配 Dependabot）。
4. **[直接可合入]** 两个 lane 的 CI workflow + no-personal-paths validator 本身就是真实改进，择优合入。

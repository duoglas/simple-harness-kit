# 6 阶段工作流

## 总览

```
┌─────────────────────────────────────────────────────────┐
│              HARNESS ENGINEERING LOOP                    │
│                                                         │
│  ① PLAN ──→ ② SETUP ──→ ③ EXECUTE ──→ ④ VERIFY         │
│                                           │             │
│                                           ↓             │
│                          ⑥ FEEDBACK ←── ⑤ REVIEW        │
│                              │                          │
│                              ↓                          │
│                   不达标 → 规则升级 → 回到 ③              │
│                   达标 → 交付 → 下一轮                    │
└─────────────────────────────────────────────────────────┘
```

## ① PLAN（规划）

**谁：** Director（人）+ AI 辅助
**做什么：**
1. 明确需求和验收标准
2. 任务拆解——每个任务 ≤15 分钟可独立验证
3. 定义每个任务的 done 条件
4. 识别任务间依赖关系
5. **把独立 review 列成清单里的一行**，不作为其他阶段的附属项。做到哪一层（Layer 3 还是
   Layer 4）由风险档决定，但"清单上有没有这一行"与风险档无关——没有这一行，
   赶工时它会被静默跳过，而且事后没人看得出它被跳过了
5. 对外部系统、运行环境、数据源和工具链先做只读探针，避免把未经验证的假设写进 EXECUTE
6. 列出不可逆动作，并标明哪些需要人确认

**Gate 条件（满足才进入下一阶段）：**
- [ ] 每个任务有明确的验收标准
- [ ] 任务粒度 ≤15 分钟
- [ ] 每个任务有单一主要风险
- [ ] 依赖关系已标注
- [ ] 外部/runtime 假设已用只读探针确认，或标为待确认
- [ ] 发布、部署、删除数据、覆盖真实环境等不可逆动作已列出并等待确认

**输出物：** 任务清单（带验收标准、依赖关系、风险、不可逆动作）

**PLAN 完成后暂停，等用户确认。** 这是默认行为——PLAN 是人介入的最高杠杆点，方向错了后面全白做。用户确认后自动进入后续阶段，不再逐阶段等待。

> 关闭暂停：设置 `HARNESS_AUTO=full`，PLAN 也不暂停，全程自动。
> 全程暂停：设置 `HARNESS_AUTO=off`，每个阶段都等用户确认。
> 默认：只在 PLAN 后暂停。

**拆解原则（15 分钟法则）：**
每个任务应该是独立可验证的最小单元：
- "写失败测试" — 一个任务
- "运行验证失败" — 一个任务
- "写最少代码通过" — 一个任务
- "运行验证通过" — 一个任务
- "Commit" — 一个任务

## ② SETUP（搭建）

**谁：** AI Agent（harness-init skill）
**做什么：**
1. 生成项目级 Rules（.claude/rules/）
2. 生成 Hooks（scripts/hooks/ + .claude/settings.json）
3. 生成 Constraints（docs/constraints.md）
4. 验证 Hook 拦截生效

**Gate 条件：**
- [ ] Rules 文件存在且内容正确
- [ ] Hooks 配置在 settings.json 中
- [ ] Hook 拦截测试通过（故意触发一次，验证被拦截）
- [ ] constraints.md 已创建，ID 格式正确

**输出物：** 完整的 .claude/ 配置 + hooks 脚本 + constraints.md

**注意：** 已有 Harness 的项目跳过此阶段。

## ③ EXECUTE（执行）

**谁：** Implementer Agent（独立 Agent 实例）
**做什么：**
1. 按任务清单逐个执行
2. 每个任务启动独立 Agent
3. TDD：先写失败测试 → 最少代码通过 → 重构
4. 引用 Constraint ID
5. 完成后自验

**Gate 条件（每个任务）：**
- [ ] 测试先写且先失败
- [ ] 代码通过测试
- [ ] 无新 warning/error
- [ ] Commit 引用了 Constraint ID（如果是修复类）

**执行模式：**

```
Director 调度
  ├→ Task 1: dispatch Implementer Agent A
  │   → 完成 → 返回结果
  ├→ Task 2: dispatch Implementer Agent B
  │   → 完成 → 返回结果
  └→ ...
```

每个 Agent 独立上下文，不受其他任务污染。

## ④ VERIFY（验证）

**谁：** QA Agent + Reviewer Agent
**做什么：** 按 QA 金字塔逐层检查

```
Layer 1: Agent Self-Verify    → 已在 ③ 中完成
Layer 2: Verification Loop     → Build/Type/Lint/Test/Security/Diff
Layer 3: Spec Compliance Review → 独立 Agent 对照 spec
Layer 4: Santa Method          → 双独立 Reviewer（高风险时）
```

**Gate 条件：**
- [ ] Layer 2 全部 PASS
- [ ] Layer 3 verdict = PASS
- [ ] Layer 4 verdict = NICE（如果启用）

**输出物：** 各层 QA 报告

详见 [04-qa-pyramid.md](./04-qa-pyramid.md)

## ⑤ REVIEW（审查）

**谁：** Director（人）+ AI 自动分析
**做什么：** 交付前 6 项复盘（前 5 项人审，第 6 项自动）

1. **流程合规**：是否按 6 阶段 Loop 执行？
2. **QA 达标**：各层 QA 报告是否完整？
3. **需求完整**：所有需求是否全部处理？
4. **规则升级**：过程中新问题是否写入 constraints？
5. **改进机会**：哪些步骤下次可以优化？
6. **行为学习**（自动）：运行 harness-learn 分析本轮 observations，输出模式发现 + Token 优化建议

**Gate 条件：**
- [ ] 前 5 项复盘全部 ✓
- [ ] 第 6 项自动完成（无需人工判断）

**达标 → 交付**
**不达标 → 进入 ⑥ FEEDBACK**

## ⑥ FEEDBACK（反馈）

**谁：** Director + AI Agent
**做什么：** F1-F5 反馈处理流程

```
F1: 记录原话     → 不解读不简化，原样记录问题
F2: 分类层级     → 规则层 / 工具层 / 配置层 / 页面层
F3: 提炼规则     → 不是"把 X 改成 Y"，而是"所有 X 类必须满足 Y"
F4: 写入文件     → constraints.md（用 ID 编号）
F5: 派 Agent     → 引用 Constraint ID，按规则修复
```

**写完规则后回到 ③ EXECUTE**，进入新的迭代。

详见 [08-feedback-loop.md](./08-feedback-loop.md)

## Inner Loop / Outer Loop

```
Outer Loop（人 / Director）
  PLAN → 审查计划 → ... → REVIEW → 方向修正
  ↕                              ↕
Inner Loop（AI）
  ③ EXECUTE → ④ VERIFY → 不通过 → ⑥ FEEDBACK → ③ EXECUTE
  （可以多次迭代，人不需要介入每次循环）
```

人在 Outer Loop 控制方向和最终质量。
AI 在 Inner Loop 执行和自我修正。
人的介入点是 ① PLAN 和 ⑤ REVIEW。

## 简化模式

不是所有项目都需要完整 6 阶段。按复杂度选择：

| 复杂度 | 使用阶段 | PLAN 粒度 | 适用场景 |
|--------|---------|----------|---------|
| 轻量 | ③→④（Layer 1-2 only） | 不需要正式 PLAN | 改配置、改文档、改默认值 |
| 标准 | ①→②→③→④→⑤ | 2-6 个任务，按功能/文件聚合 | 新功能、重构 |
| 完整 | 全部 6 阶段 + Layer 4 Santa | 完整拆解 | 高风险、复杂逻辑、生产部署 |

> **实战经验（Experiment A）：** `alwaysQuote` 需求拆为 6 个任务（标准模式），粒度合适。如果是更小的改动（如加个默认值），6 步就过度了——用轻量模式即可。

> **实战经验（Experiment B）：** 搜索+筛选需求 PLAN 拆了 13 个任务，但执行时子需求 1+2 合并只改了 1 个文件。**前端组件类需求，按文件/组件级别拆分比按功能点拆分更实际。** 过细的任务拆解反而增加调度开销。

## 阶段切换的正确姿势

阶段切换通过 Write `.harness/current-stage.json` 实现，文件内容示例：

```json
{"stage":"EXECUTE","since":"2026-04-07T02:15:00.000Z","task":"任务描述"}
```

### since 字段必须是真实当前时间

`since` 字段必须是**真实系统时间**，不能手编"看起来递增"的时间戳。原因：

- verification-gate 在 commit 时用真实文件 mtime 比对 `since`，来判断验证证据是否新鲜
- 如果 AI 写入未来时间（比如 `02:40` 但实际是 `02:11`），会导致"证据早于任务开始"的误报
- stage-guard 会强制检查：`since` 与当前时间偏差 > 5 分钟时 `exit 2` 拒绝

### 正确做法

先用 `date` 命令获取真实时间，再写入：

```bash
date -u +%Y-%m-%dT%H:%M:%S.000Z
# 输出: 2026-04-07T02:15:42.000Z
```

然后把这个值作为 `since` 写入 current-stage.json。不要凭感觉递增或填"整数分钟"的时间。

> **实战教训（#20 任务）**：AI 手编递增时间戳导致 verification-gate 误报，被迫用 `touch` 绕过。修复是在 stage-guard 加 since 合理性检查，偏差 > 5 分钟直接拒绝。

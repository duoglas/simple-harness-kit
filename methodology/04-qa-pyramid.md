# 5 层 QA 金字塔

## 核心原则

> AI 做 4 层，人做 1 层。每层独立拦截问题，纵深防御。

## 金字塔结构

```
┌─────────────────────────────────────────────────────┐
│ Layer 5: Human Final Review（人工最终审查）           │
│   只看报告 + 关键决策，5 项交付前复盘                │
│   投入：最少                                         │
├─────────────────────────────────────────────────────┤
│ Layer 4: Santa Method（AI 对抗验证）                 │
│   两个独立 Reviewer Agent 同时检查                    │
│   都通过 → 提交人工审查                              │
│   任一不通过 → 自动修复循环（max 3 轮）               │
├─────────────────────────────────────────────────────┤
│ Layer 3: Spec Compliance Review（AI 规格审查）        │
│   独立 Agent 对照需求规格逐项检查                     │
│   Reviewer ≠ Author（消除 author-bias）              │
├─────────────────────────────────────────────────────┤
│ Layer 2: Verification Loop（自动化工具检查）           │
│   Build → Type Check → Lint → Test → Security → Diff │
│   全部 PASS 才能进入 Layer 3                         │
├─────────────────────────────────────────────────────┤
│ Layer 1: Agent Self-Verification（Agent 自验）        │
│   TDD 红绿重构 + 实现后立即自验                       │
│   最基础的质量保证                                   │
└─────────────────────────────────────────────────────┘
```

## Layer 1: Agent Self-Verification

**谁执行：** 实现任务的 Agent 自己
**何时执行：** 每个任务完成后立即执行
**怎么执行：**

1. TDD 红绿重构循环：
   - 先写失败测试（RED）
   - 写最少代码通过测试（GREEN）
   - 重构（REFACTOR）
2. 实现完成后运行全部相关测试
3. 检查自己的改动是否引入新的 warning/error

**Gate 条件：** 测试通过 + 无新 warning

**铁律：** NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

### Pre-Layer 1 Gate: Infra Tier ≥ 1

> 上面的"铁律"有一个**前置条件**：项目的测试基础设施必须 ≥ Infra Tier 1。
> 如果项目处于 Tier 0 (BROKEN)，连"先写失败测试"都执行不了（测试 bootstrap 跑不起来 / 测试结果不可信）。
>
> Infra Tier 0 项目必须先走 M-12 治理任务把 infra 修好，才能进入 EXECUTE 阶段执行 Layer 1。
> 唯一例外是 Sev0/security/regulatory 紧急 hotfix，走 emergency override（必须有 incident tag + minimal scope + manual verification + N 天内 follow-up 补测试）。
>
> 完整定义、6 个 H 硬标准、4 个 Tier 判据、emergency override 规则见 [16-infra-tier.md](./16-infra-tier.md)。
>
> **结论**: Infra Tier ≥ 1 是让 Layer 1 铁律 *能够被执行* 的前提，不是 Layer 1 的放松。Tier 0 项目"不写测试"是被阻止的，不是被允许的。

## Layer 2: Verification Loop

**谁执行：** 自动化工具（不依赖 LLM 判断）
**何时执行：** Agent 自验通过后，进入下一层前
**怎么执行：**

```bash
# Phase 1: Build
npm run build  # 或项目对应的构建命令

# Phase 2: Type Check
npx tsc --noEmit  # 或 pyright / mypy

# Phase 3: Lint
npm run lint  # 或 ruff check / golint

# Phase 4: Test Suite
npm test -- --coverage  # 目标覆盖率 ≥ 80%

# Phase 5: Security Scan
grep -rn "sk-\|api_key\|password" src/  # 基础秘钥扫描

# Phase 6: Diff Review
git diff --stat  # 检查改动范围是否合理
```

**Gate 条件：** 6 项全部 PASS

### Layer 2 铁律: 实弹测试不得绕过被测组件（VH-10 教训, 2026-04-09 加入）

Layer 2 的测试和实弹场景必须**真正经过被测组件的真实使用路径**。**禁止**以下反模式:

1. **Sub-agent 实验时在 prompt 里预先提供资源绝对路径** — 如果被测组件是"Skill 的路径解析逻辑"，却在 sub-agent prompt 里先说"kit 在 /abs/path/to/kit"，sub-agent 据此成功读文件，这**不证明** Skill 写得对，只证明"sub-agent 按你给的路径读文件的能力"。参考 C-TEST-04。

2. **静态内容检查替代运行时解析** — 检查文档里"是否包含某字符串"不等于"该字符串在真实用户环境下能解析"。涉及路径的测试**必须同时**验证 `[ -f "$cwd/<path>" ]` 或等价。参考 C-TEST-05。

3. **在作者机器特殊环境跑"真实场景"** — dogfooding workspace (如 harness-dogfood 同时持有 simple-harness-kit 作为子目录) 是一个**特殊 case**，cwd-relative 路径在这里恰好能 work。真实用户的 cwd 和 kit 位置无父子关系。涉及"用户在任意目录"的功能，测试必须用**至少 3 个无父子关系的随机 tmp 目录**作为 `$HOME` / `$KIT` / `$CWD`。参考 C-TEST-06。

**正确姿势**: 
- 写**脚本化**（不依赖 AI）测试
- 用 `mktemp -d` 建 3 个无父子 tmp dir
- `cp -r` 真实拷贝 kit 到 tmp (不用 symlink — 模拟 clone)
- 在 $CWD 下跑被测功能
- 每个 assertion 都用 `EXPECTED_ASSERTIONS=N + 结尾校验` 防止 early exit 静默跳过
- Mutation 反证: 注入已知 bug → 期望 FAIL, 移除 → 期望 PASS (证明"测试通过"非假象)

**历史教训 VH-10**: v0.7.0 发布后用户连续报两个 P0 低级 bug (`cp -r` 非幂等 + SKILL.md cwd-relative 路径)。两者都在发版前"测试全绿", 但测试体系(a) 从未跑"二次 install", (b) 只做 SKILL.md 静态内容检查, (c) dogfooding 作者环境恰好能让 cwd-rel 路径 work。这是 VH-05 "mock 通过不代表真实生效" 在 sub-agent 层 + 环境特殊性层的双重重演。

**输出格式：**
```
VERIFICATION REPORT
===================
Build:     [PASS/FAIL]
Types:     [PASS/FAIL] (N errors)
Lint:      [PASS/FAIL] (N warnings)
Tests:     [PASS/FAIL] (X/Y passed, Z% coverage)
Security:  [PASS/FAIL] (N issues)
Diff:      [N files changed, +X/-Y lines]

Overall:   [READY/NOT READY]
```

## Layer 3: Spec Compliance Review

**谁执行：** 独立的 Reviewer Agent（不是写代码的那个 Agent）
**何时执行：** Verification Loop 全部 PASS 后
**怎么执行：**

1. Reviewer 收到：需求规格 + Agent 的代码变更
2. 逐项对照规格检查：
   - 每个需求点是否被实现
   - 实现是否符合规格描述
   - 是否有遗漏的边界条件
3. 输出结构化报告

**关键设计：Reviewer ≠ Author**

写代码的 Agent 和做 review 的 Agent 必须是不同的 Agent 实例（独立上下文）。这消除了 author-bias——作者审查自己的代码时，会不自觉地用"我知道我想做什么"来填补代码中的漏洞。

**Gate 条件：** 所有规格项 PASS

## Layer 4: Santa Method（对抗验证）

**谁执行：** 两个独立的 Reviewer Agent（互相不知道对方的存在）
**何时执行：** 高风险产出物、生产部署前、复杂逻辑变更
**怎么执行：**

```
Phase 1: Make a List
  Generator Agent 完成实现

Phase 2: Check It Twice
  ┌───────────┐  ┌───────────┐
  │ Reviewer A │  │ Reviewer B │  ← 独立上下文，相同 rubric
  └─────┬─────┘  └─────┬─────┘
        │              │
        ↓              ↓
Phase 3: Naughty or Nice
  A passes AND B passes → NICE → 进入 Layer 5
  否则 → NAUGHTY → 进入 Fix Cycle

Phase 4: Fix Until Nice
  收集所有 issue → Fix Agent 修复 → 重新双 Review
  最多 3 轮。超过 3 轮 → 升级给人工处理
```

**关键不变量：**
- 上下文隔离：两个 Reviewer 互不可见
- 相同 rubric：评审标准一致
- 都必须通过：一个发现问题就算 NAUGHTY
- **Fresh Agent per round：每轮修复后必须用全新 Reviewer Agent 重审，防止锚定偏差。"跑测试通过了"不等于 NICE——必须有独立 Reviewer 的结构化报告才算。**

> **实战经验（Experiment B）：** Santa Round 2 被标记为"隐式"——仅跑了测试确认修复，没有真正重启双 Reviewer。这不符合 Santa 的核心设计：每轮都需要独立的新视角来审查。"隐式确认"可能遗漏 Fix 引入的新问题。

**Rubric 设计原则：**
每个检查项必须有客观的 PASS/FAIL 条件，不接受"看起来不错"。

| 检查项 | PASS 条件 | FAIL 信号 |
|--------|----------|----------|
| 功能正确性 | 所有 spec 需求被覆盖 | 遗漏需求项 |
| 无幻觉 | 无虚构的 API/函数/URL | 引用不存在的东西 |
| 安全性 | 无硬编码密钥，输入有验证 | 发现敏感信息 |
| 一致性 | 无自相矛盾 | A 处说 X，B 处说 non-X |
| 技术正确性 | 代码可编译运行，逻辑正确 | 语法错误、逻辑 bug |

**跨模型对抗（扩展）：**
可以用 Codex 做 Reviewer A，Claude 做 Reviewer B。不同模型有不同的盲区，交叉审查进一步降低逃逸率。

**指标：**
- First-pass rate：第一轮通过率（目标 >70%）
- Mean iterations：平均修复轮数（目标 <1.5）
- Escape rate：上线后发现的问题（目标 0）

**何时跳过 Layer 4：**
- 低风险改动（文档、配置、格式化）
- 已有充分的自动化测试覆盖
- 时间压力下可降级为 Layer 3 only，但需要记录降级决策

## Layer 5: Human Final Review

**谁执行：** 人
**何时执行：** Layer 4 通过后（或 Layer 3 通过后如果跳过了 Layer 4）
**怎么执行：**

交付前 5 项复盘清单：

1. **流程合规**：是否按 6 阶段 Loop 执行？是否有跳过的阶段？
2. **QA 达标**：各层 QA 报告是否完整？量化指标是否达标？
3. **需求完整**：用户/产品的所有需求点是否全部处理？
4. **规则升级**：过程中发现的新问题是否已写入 constraints.md？
5. **改进机会**：哪些步骤下次可以优化？

**人只需要看报告和做判断，不需要逐行审查代码。** 逐行审查是 Layer 3 和 Layer 4 的工作。

## 量化指标体系

来自 eval-harness 的度量框架：

| 指标 | 含义 | 目标 |
|------|------|------|
| pass@1 | 一次就通过的比例 | >70% |
| pass@3 | 三次内通过的比例 | >90% |
| First-pass rate | Santa 第一轮通过率 | >70% |
| Mean iterations | 平均修复轮数 | <1.5 |
| Escape rate | 上线后发现问题 | 0 |
| Coverage | 测试覆盖率 | ≥80% |

## 层级之间的关系

```
Layer 1 失败 → 不进入 Layer 2（Agent 自己先修）
Layer 2 失败 → 不进入 Layer 3（工具检查先修）
Layer 3 失败 → 不进入 Layer 4（规格不符先修）
Layer 4 失败 → 自动修复循环，不进入 Layer 5
Layer 4 通过 → 进入 Layer 5（人工最终审查）
```

每层都是门控，不允许"先过了再说"。这保证了到达人工审查时，大部分问题已经被解决。

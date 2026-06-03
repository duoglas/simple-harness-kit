# Infra Tier — 测试基础设施治理 + 强制补测试

> 别名: M-12（历史编号，源自 Experiment C）
>
> 状态: ✅ ACCEPTED (经 Experiment C 实战 + Codex 交叉验收 + 用户明确 review)
>
> 关联: [04-qa-pyramid.md](./04-qa-pyramid.md) Layer 1 pre-gate · [examples/experiment-c-planka/m12-tiered-tdd-draft.md](../examples/experiment-c-planka/m12-tiered-tdd-draft.md) ADR 全文 · [examples/experiment-c-planka/m12-pilot-test.md](../examples/experiment-c-planka/m12-pilot-test.md) Planka 实战 pilot

## 核心命题

**测试基础设施差不是豁免理由，而是必须优先治理的信号**。

旧的"低覆盖项目允许跳过 TDD" 是给烂 infra 找借口，长期会让测试代码崩盘。Infra Tier 是 04-qa-pyramid Layer 1 铁律的 **precondition**，不是 exception：先把 infra 修到能跑测试，再让 Layer 1 "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST" 真正可执行。

## 两个核心原则

1. **任何项目的新代码都必须带测试**。无例外（emergency hotfix override 见下文，是有条件的"延后"，不是"豁免"）。
2. **测试基础设施不可用，必须先修**。修完才能开始新 feature。不允许"先写 feature 再补测试"的妥协。

## 6 个 Infra 健康度硬标准（H1-H6）

按 infra 健康度，**不是按覆盖率 %** 判 Tier。**H1/H2/H4 是 blocker-class**：单项 fail 即视为 Tier 0，不能用平均分掩盖。

| ID | 硬标准 | 类型 | 自动化程度 |
|---|---|:---:|:---:|
| **H1** | 裸跑 `npm test` 无预设能跑（新贡献者第一次就能跑） | **blocker** | 脚本可自动 |
| **H2** | 测试 bootstrap 在 CI 合理时间内完成（无硬编码 timeout bug） | **blocker** | 脚本可自动 |
| H3 | 测试代码无 dead / skipped（无 `describe.skip`、无整文件注释） | normal | 脚本可自动 |
| **H4** | 测试能独立于 runtime 跑（源码不耦合 runtime 全局，或测试套能完整 bootstrap runtime） | **blocker** | 半自动（hybrid）|
| H5 | Coverage tool 存在且 CI 跑（有动态覆盖率数据） | normal | 脚本可自动 |
| H6 | 测试确定性 / 无 flaky（CI 重复跑应稳定 PASS, 无外部隐式依赖, hermetic） | normal | 半自动（多次重跑统计）|

**为什么 H1/H2/H4 是 blocker**：它们直接决定"测试能否被执行 + 测试结果能否被信任"。任何一项 fail，新增的测试可能根本跑不起来，或者跑起来也是误报，无法承担"防止 regression"的核心职责。

## 4 级 Infra Tier

| Infra Tier | 判定 | 含义 | Harness 准入 |
|---|---|---|---|
| **Tier 0: BROKEN** | 任一 blocker (H1/H2/H4) fail，或 ≤ 3/6 通过 | 测试基础设施有阻塞性缺陷 | **禁止开启新 feature 的 EXECUTE 阶段**。必须先走 M-12 治理任务升级到 Tier 1。唯一例外是 emergency hotfix override（见下文）|
| **Tier 1: FRAGILE** | 所有 blocker pass，4-5/6 | 能跑但不完整 | **新代码必须带测试**；H 项缺失的部分必须跟踪修复；允许"一边补 infra 一边做 feature" |
| **Tier 2: SOLID** | 6 / 6 | 所有硬标准通过 | **常规 TDD**；可以完整跑 04-qa-pyramid 的 Layer 1-5 |
| **Tier 3: MATURE** | 6/6 + 覆盖率 CI 阈值 + mutation testing | Tier 2 + 阈值 | **严格 TDD + 阈值守门 + mutation testing**（可选）|

## Tier 判定时机

- **Init 时**：harness-init skill 必须执行 H1-H6 自动检测 + 人工补全 H4/H6 → 写入 `.harness/infra-tier.json`（包含 tier 名 + 各 H 项打分）
- **每次 EXECUTE gate**：stage-guard hook（或 rules 层提醒）读 `.harness/infra-tier.json`，按 tier 决定是否允许进入 EXECUTE
- **重大 infra 改动后**：手动重跑评估，更新 `.harness/infra-tier.json`

## Pre-Layer 1 Gate（与 04-qa-pyramid 的衔接）

[04-qa-pyramid.md](./04-qa-pyramid.md) Layer 1 的铁律：

> NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

这条铁律的**前置条件**是：项目的 Infra Tier ≥ 1。

```
EXECUTE 阶段开始
    ↓
[Pre-Layer 1 Gate] 检查 .harness/infra-tier.json
    ↓
Infra Tier == 0 (BROKEN)?
    ├── YES → 阻止 EXECUTE，要求先走 M-12 治理任务（除非走 emergency override）
    └── NO  → 进入 Layer 1（"先写失败测试" 铁律可执行）
```

**结论**: Infra Tier ≥ 1 是让 Layer 1 铁律 *能够被执行* 的前提，不是 Layer 1 的放松。

## Emergency Hotfix Override

Tier 0 项目通常禁止 EXECUTE 新 feature。**唯一例外**是必须走 emergency lane 的紧急修复。

### 触发条件（all 必须满足）

- **Sev0** 严重程度（生产 down / 数据丢失 / 大规模用户阻断）
- **Security** 漏洞需立即 patch（CVE 公开 / active exploit）
- **Regulatory** 强制（GDPR / 法律要求 N 天内修复）

### 走 emergency lane 必须做的事

1. **Incident tag**: commit message 必须含 `[emergency-hotfix]` + 引用具体 incident ID（用户工单 / 安全报告 / 法律通知）
2. **Minimal scope**: 改动只能修这一个 incident，**禁止顺手改其他**
3. **Mandatory manual verification**: 由 reviewer/director 在 staging 或 production 验证修复有效，记录到 commit message 或 ops log
4. **Hard deadline for follow-up**: hotfix 后 **N 天内**（建议 7 天）必须：
   - 补对应的 unit/integration test 覆盖修复路径
   - 完成 Tier 0 → Tier 1 升级（如果 hotfix 之前是 Tier 0）
   - 写 incident retrospective（含为什么 emergency 必须存在）
5. **审计登记**: 在 `docs/constraints.md` 的 violation history 区登记这次 emergency 例外

### 不算 emergency 的情况

- "用户着急想要" → no
- "deadline 临近" → no
- "看起来很简单的改动" → no
- "下个 release 才修就晚了" → no

emergency lane **不是** "免测试通道"，而是**例外承认 Tier 0 项目偶尔有必须立刻 ship 的情况**，并强制 follow-up。如果 emergency 频繁触发，说明 Tier 0 治理推不动，应该升级为 P0 task。

## Tier 升级路径

### Tier 0 → Tier 1（最关键的一步）

按优先级修复 6 个 H 项。一般顺序：

1. **修 H1**：让 `npm test` 裸跑能启动（默认 env vars / 测试专用 .env / npm script 包装）
2. **修 H2**：把任何硬编码过短的 timeout 改可配置（默认值 ≥ 60s）
3. **修 H4**：源码不显式 require 的隐式 runtime 全局（如 sails 注入的 `_`）一律加 require
4. **修 H3**：清理 `describe.skip` / 整文件注释 dead code（恢复并修，或正式删除）
5. **修 H5**：装 coverage tool（nyc / c8 / Jest 自带）+ 跑出 baseline coverage 数字
6. **评 H6**：在 CI 上跑 N 次测试（建议 ≥ 5 次）统计 PASS rate；< 100% 标 flaky 单独跟踪

完成 ≥ 4 个 H 项 + 全部 blocker 通过 → 升级到 Tier 1。

### Tier 1 → Tier 2 → Tier 3

- **Tier 1 → 2**: 补 H6（CI 重跑稳定）+ 覆盖率达到一个 baseline（5-30%，视项目情况）
- **Tier 2 → 3**: 加 CI 覆盖率阈值守门 + （可选）mutation testing

**升级动作的核心特点**：所有动作都是"补测试基础设施 + 补测试"，**不是"放宽测试要求"**。

## 反面教材: Experiment C

[Experiment C](../examples/experiment-c-planka/report.md) 的 feature #1485 (board/list descriptions) 在 Planka 上做时**没补测试**，原因是"项目本身几乎无测试，写测试的成本和价值不匹配"。

**v1 草稿曾打算追认 Experiment C 为合法的 Tier 0 行为**。这是错的方向，被用户和 Codex 双重否决：

- 追认 = 给烂 infra 找借口
- 实质是把"不能做"偷换成"不应该做"
- 长期效果是测试代码永远不补，infra 永远是 Tier 0

**v2 的正确定性**：Experiment C 是反面教材，**未来 Tier 0 项目启动 feature 前必须先过 M-12 治理**，否则交付的 feature 没有回归保障。Experiment C 的 feature 代码本身有效（UI 层 smoke test 手动跑过），但**没建立可重复的回归保障**——这是 methodological failure。

补救：如果 Planka 后续要继续维护，应该补一套测试覆盖 board/list description 的 happy path。本任务不强制做（属于 follow-up case study）。

## 实战证据

- [m12-baseline.md](../examples/experiment-c-planka/m12-baseline.md): Planka 测试基础设施治理前的量化基线（H1-H6 全 fail，Tier 0）
- [m12-pilot-test.md](../examples/experiment-c-planka/m12-pilot-test.md): Planka 治理 pilot 报告（H1-H5 全 pass，Tier 0 → Tier 1，第一个新 helper 测试 7 tests pass）

实测数据：
- Server effective `it()`: 4 (50% pass) → 23 (100% pass)
- Coverage: 不可测 → 0.42% baseline
- 治理时间: ~2 小时（含读 codebase 到完成 5 个 H 修复 + 第一个新测试）

## 对其他 methodology 文档的影响

| 文档 | 改动类型 | 状态 |
|---|---|:---:|
| `04-qa-pyramid.md` Layer 1 | 加 pre-gate 引用本文件 | 同步落地 |
| `03-workflow.md` EXECUTE | 加 "Infra Tier ≥ 1 才能进 EXECUTE" gate | 待跟进 |
| `init-prompt.md` | Init 时执行 H1-H6 检测，写入 `.harness/infra-tier.json` | 待跟进 |
| `templates/rules/qa-standards.md.tmpl` | 加 pre-Layer 1 gate 描述 | 待跟进 |
| Hook 层 | stage-guard 读 `.harness/infra-tier.json` 强制 Tier 0 阻 EXECUTE | 已落地（Quality Gate Suite） |

## 历史

- **2026-04-02 (Experiment C)**: 在 Planka 实测发现 "低测试覆盖项目无法 TDD" 痛点 → M-12 入 TODO
- **2026-04-08 上午**: #11 任务 baseline 量化，发现 Planka 5 个具体故障
- **2026-04-08 中午 v1 草稿**: 错误方向 "Tier 0 允许不写测试"，被用户否决
- **2026-04-08 下午 v2 草稿**: 反向重写 "infra 差不豁免，必须修+补"
- **2026-04-08 下午 Planka pilot**: 修 H1-H5 全 pass，写第一个新测试，Tier 0 → Tier 1
- **2026-04-08 下午 Codex 交叉验收**: PASS-with-notes，加 emergency hotfix override + blocker-class 标记
- **2026-04-08 下午**: 本文件接受为 methodology 正式条目（M-12 / 16-infra-tier）

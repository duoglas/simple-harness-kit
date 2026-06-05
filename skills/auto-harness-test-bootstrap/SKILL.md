---
name: auto-harness-test-bootstrap
description: 为缺少测试的已有项目渐进式补充多层自动化测试覆盖。Use when project has low or no test coverage and needs automated test generation.
---

# Harness Test Bootstrap

为缺少测试的已有项目建立多层自动化测试覆盖。AI 分析代码、生成测试、运行验证、迭代补充——用户只做验收。

这不是单纯“补几个测试文件”。SHK 在目标工程里的职责是完整链路：

1. **测试生成**：根据 spec、工程类型和风险，为目标工程生成单测、API E2E、浏览器 E2E 或组合测试。
2. **有效测试验证**：检查测试是否覆盖需求、风险、流量路径、断言、正向、负向/边界和 mutation/fault 证据。
3. **交付准出**：只有 spec、test effectiveness、E2E sufficiency 和基础 gate 都 READY，AI 才能说可以交付。

## 何时使用

- 项目测试覆盖率低或为零
- 团队长期依赖人工测试，想转自动化
- 用户说"补测试"、"加测试覆盖"、"建立测试体系"

## 核心原则

1. **AI 写测试，人验收** — 用户不需要自己写任何测试代码
2. **渐进式，不一步到位** — 先高风险模块，再逐步扩展
3. **先搭基础设施，再生成测试** — 没有测试框架就先装
4. **测试现有行为，不是理想行为** — 先锁定当前行为，再讨论要不要改
5. **新应用没有 E2E 时，AI 要生成第一套** — 不能只报告“缺 E2E”就停下
6. **E2E PASS 不等于充分** — fake、空脚本、只 smoke、坏代码也能 PASS 的 E2E 都不能交付

## 执行流程

### Phase 1：分析（AI 自动完成）

AI 扫描项目，输出分析报告：

如果是新应用工程或 UI/API 相关任务，先跑后端识别器：

```bash
node scripts/shk.js spec status --risk medium --format json
node scripts/shk.js e2e inspect --format json
node scripts/shk.js e2e bootstrap --risk medium --format json
```

这两个命令是给 AI 读的，不是让用户背命令。AI 要根据输出判断：

- 这是 Web、fullstack、API service，还是未知项目；
- 本地启动命令是什么；
- 有没有 Playwright / Cypress / API E2E；
- 没有 E2E 时，该生成 Playwright、Cypress 还是 API E2E；
- 如果无法判断，只问用户一个具体问题。
- 如果缺少 `.harness/iteration-spec.json`，AI 要先补一份短 spec：需求、方案、风险、测试计划、流量路径、验收标准。

```
测试分析报告
============
技术栈: [自动识别]
现有测试: [框架/覆盖率/数量，如果有]
建议测试框架: [根据技术栈推荐]

模块风险评估:
  高风险: src/auth/（认证逻辑，无测试）
  高风险: src/api/（对外接口，无测试）
  中风险: src/utils/（工具函数，部分测试）
  低风险: src/components/（展示组件）

建议优先级:
  1. src/auth/ — 先补单元测试
  2. src/api/ — 补集成测试
  3. 关键页面 — 补 E2E 测试
```

→ **暂停，等用户确认优先级。**

### Phase 2：搭建测试基础设施

如果项目没有测试框架，AI 自动搭建：

- 安装测试依赖（根据技术栈自动选择）
- 创建配置文件
- 写一个 smoke test 验证环境可用
- 配置覆盖率报告

→ 运行 smoke test 确认环境 OK。

如果项目没有 E2E，AI 必须进入 E2E bootstrap：

- Web/fullstack 默认生成 Playwright；
- 已有 Cypress 则沿用 Cypress；
- API-only 生成 API E2E，不强行上浏览器；
- 必须写 `.harness/task-quality-contract.json`；
- 第一版至少有 1 个正向路径、1 个负向/阻断路径、真实断言和结构化 evidence。

### Phase 3：按优先级生成测试

对每个模块，按 3 步循环：

```
Step 1: AI 读代码，理解现有行为
Step 2: 生成测试（覆盖正常路径 + 边界 + 错误处理）
Step 3: 运行测试
  → 全部通过 → 记录覆盖率，进入下一个模块
  → 有失败 → 分析原因：
    - 测试写错了 → AI 修测试
    - 发现真实 bug → 记录到 constraints.md（不自动修，等用户决定）
```

### Phase 4：多层测试覆盖

根据项目类型，逐层补充：

**Layer 1 — 单元测试（最先补）**
```
目标: 所有公开函数/方法
方法: AI 读函数签名和实现 → 生成测试 → 运行
覆盖: 正常输入、边界值、空值、异常输入
```

**Layer 2 — 集成测试（API/数据库项目）**
```
目标: API 端点、数据库操作、服务间调用
方法: AI 分析路由/ORM → 生成请求级测试
覆盖: 正常请求、参数校验、权限、错误码
```

**Layer 3 — E2E 测试（有前端的项目）**
```
目标: 关键用户流程
方法: AI 分析页面路由和交互 → 生成 Playwright 测试
覆盖: 核心路径（登录→操作→结果）、错误路径、响应式
```

E2E 生成后必须运行：

```bash
node scripts/shk.js e2e assess --risk medium --format json
node scripts/shk.js test effectiveness --risk medium --format json
```

如果结果是 `NOT_READY` 或 `NOT_SUFFICIENT`，不能交付。AI 最多进入 3 轮修复 loop，每轮只补一个失败点并重跑最小测试。

有效性证明必须包含 mutation 思路：故意破坏一个关键行为后，E2E 应该失败。坏代码下 E2E 也 PASS，说明这套 E2E 是摆设。

**Layer 4 — a11y / 安全（按需）**
```
目标: 无障碍合规、安全扫描
方法: axe-core 扫描、依赖审计、秘钥扫描
```

### Phase 5：报告

```
测试 Bootstrap 完成
===================
新增测试: [N] 个
  单元测试: [n1]
  集成测试: [n2]
  E2E 测试: [n3]
  a11y 测试: [n4]

覆盖率: [之前]% → [之后]%

发现的问题（未修复，等用户决定）:
  1. [描述] — 记录在 C-XXX-01
  2. [描述] — 记录在 C-XXX-02

下一步建议:
  - 开启 CI 中的覆盖率检查（不低于当前值）
  - 后续开发用 TDD 自然维持覆盖率
```

E2E 报告必须说人话：

```
这套 E2E 可以用于本轮准出。

它已经跑过核心正向流程，也跑过错误输入的拦截路径。我还把关键成功输出改坏试了一次，E2E 会失败。

机器状态：READY
```

如果不充分，必须直说：

```
现在还不能交付。

这套 E2E 只证明页面能打开，还没测到本次改动的业务路径，也没证明错误输入或阻断场景能被拦住。

我会先补一条业务正向路径和一条失败路径，再重跑最小 E2E。

机器状态：NOT_SUFFICIENT
```

## 发现 bug 的处理

AI 生成测试时可能发现现有代码的 bug。处理原则：

- **不自动修复** — 测试是锁定现有行为，不是改行为
- **记录到 constraints.md** — 用 Constraint ID 标记
- **报告给用户** — 用户决定修不修、什么时候修
- 如果用户说"修"→ 按 F1-F5 走 Harness 反馈闭环

## 与 Harness 其他机制的配合

- **Phase 1 分析报告**后暂停 → 对应 PLAN 阶段确认机制
- **Phase 3 发现 bug** → 写入 constraints.md → Harness 反馈闭环
- **Phase 5 覆盖率基准** → 写入 qa-standards.md → verification-gate 后续强制

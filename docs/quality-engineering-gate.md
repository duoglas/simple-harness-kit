# SHK Phase 2: Quality Engineering Gate

SHK 第一阶段解决的是“AI 别乱跑”：有阶段、有 Hook、有 evidence、有交付前检查。

第二阶段解决的是“AI 怎么把目标工程做稳”：SHK 装到一个应用工程后，要帮助 Claude Code / Codex 把每轮迭代做到 **spec 前置、可衡量、可验收、可持续优化**。

这不是把用户变成 CLI 操作者，也不是做完以后补总结。`shk` 命令是 AI Harness 的后端探针；spec 是交付流程的前置输入。用户应该看到的是清楚的判断和下一步，而不是一串命令日志。

## 一句话说明

一轮代码变更想交付，不能先实现再事后补文档，也不能只说“测试过了”。SHK 要求 AI 先有 spec，再证明四件事：

1. 这轮到底要做什么；
2. 准备怎么做，风险在哪里；
3. 哪些测试证明了需求、风险和关键流量路径；
4. 如果关键逻辑坏了，测试和 gate 会不会真的失败。

证明不了，就是 `NOT_READY` 或 `NOT_SUFFICIENT`，不能说完成。

## Phase 1 和 Phase 2 的区别

| 阶段 | 解决的问题 | 用户看到的效果 |
|---|---|---|
| Phase 1 | AI 不按流程、跳阶段、没证据就交付 | AI 被 Hook 约束，必须 PLAN → VERIFY → REVIEW，有 evidence 才能交付 |
| Phase 2 | AI 虽然跑了测试，但测试不一定证明需求安全 | spec 成为交付前置依赖；没有 spec 不能开工，测试生成和准出都必须映射回 spec |

Phase 1 是“别乱跑”。Phase 2 是“做得稳”。

## Spec 驱动顺序

正确顺序是：

```text
SPEC → PLAN → EXECUTE → TEST GENERATION → TEST EFFECTIVENESS → VERIFY → REVIEW
```

错误顺序是：

```text
PLAN → EXECUTE → VERIFY → 最后补文档
```

所有测试生成、E2E 充分性、测试有效性和交付准出，都必须能回到 spec 里的需求、风险和流量路径。


## 1. 可衡量：先有有效 spec

每轮 medium / high / release 迭代都必须先有 `.harness/iteration-spec.json`。它不追求长，只追求清楚。AI 不能绕过它直接实现；如果实现中发现 spec 不完整，要回到 SPEC 阶段补齐。

最少要说清：

- **需求**：用户到底要什么，哪些是 must-have；
- **方案**：准备改哪里，为什么这样改；
- **风险**：最容易坏的点是什么；
- **测试计划**：哪些测试覆盖哪些需求和风险；
- **流量路径**：关键用户旅程、API 路由、请求顺序是什么；
- **验收标准**：什么 evidence 才算可以交付。

没有这份 spec，测试再绿也不知道证明了什么，所以是 `NOT_READY`。

如果 spec 写了，但 must 需求、风险点或流量路径没有对应测试，就是 `NOT_SUFFICIENT`。

## 2. 可验收：测试生成、有效测试验证、交付准出

### 2.1 测试生成

目标工程缺测试时，AI 不能只说“这里没有 E2E”。它要进入 bootstrap：

- Web / fullstack：优先生成 Playwright；已有 Cypress 就沿用 Cypress；
- API service：生成 API E2E，不强行开浏览器；
- 不确定启动方式：只问用户一个具体问题，比如“本地启动用 `npm run dev` 还是 `docker compose up`？”

生成出来的第一套测试，至少要有：

- 一个正向路径；
- 一个负向、边界或阻断路径；
- 真实断言，不是只打开页面；
- 结构化 evidence；
- 与 spec 的需求、风险、流量路径能对上。

### 2.2 有效测试验证

E2E PASS 不等于有效。下面这些都不能算 READY：

- `echo ok` 或空脚本；
- 只打开首页，没有断言；
- 只测 happy path，没有失败路径；
- 没覆盖本轮改动的风险点；
- 没覆盖关键 API / 页面 / 用户旅程；
- 故意把关键逻辑改坏后，测试仍然 PASS。

SHK 用这些维度判断测试有效性：

| 维度 | 人话解释 |
|---|---|
| 需求覆盖 | must 需求有没有测试证明 |
| 风险覆盖 | 最容易坏的地方有没有被测到 |
| 流量覆盖 | 关键用户路径、API 路由、请求顺序有没有覆盖 |
| 断言质量 | 是只跑了流程，还是检查了真实结果 |
| 正向路径 | 好情况能不能完成 |
| 负向/边界路径 | 坏输入、权限失败、错误状态会不会被拦 |
| mutation / fault injection | 故意把关键逻辑改坏，测试会不会失败 |
| runtime realism | source-level、API、browser、full runtime 要说清楚 |
| fresh evidence | 证据是不是本轮改动后真实跑出来的 |

### 2.2.1 不能只靠 fixture 证明有效

样例工程可以证明流程闭环，但不能单独证明 SHK 真能服务目标工程。Phase 2 还要求至少有真实工程 dogfood：

- 用真实开源工程或用户目标工程的临时副本；
- 写入本轮 spec、质量合约、E2E 和 evidence；
- 正常代码下 E2E 通过；
- 故意改坏真实源码后，同一条 E2E 失败；
- fake / smoke-only / 注释关键词脚本不能被当成充分证据。

当前 public SHK 用 `tests/scripts/17-oss-dogfood-validation.sh` 跑两类真实 OSS：一个 TodoMVC 前端，一个 Express API。它证明的是 SHK 在真实代码路径上能生成和判断有效测试；它还不等于完整浏览器链路、完整上游 CI 或线上流量回放。

Phase 2 继续补了两个更硬的验证：

- `tests/scripts/18-upstream-ci-dogfood.sh`：真实 OSS 临时副本跑 npm install/ci，并把原项目 test/build/lint/typecheck 的证明力单独标出来。空壳 `npm test` 只能说 `NO_PROOF`，不能说成有效 CI。
- `tests/scripts/19-browser-e2e-dogfood.sh`：真实 TodoMVC 页面跑 headless browser E2E。输入 todo、检查 DOM/计数/筛选/清理，再 mutation `completed: false -> completed: true`，同一条浏览器 E2E 必须失败。

因此报告必须分清：

```text
依赖安装跑通了；
原项目 CI 有没有证明力；
SHK 生成的 E2E/mutation 有没有证明力；
浏览器真实链路有没有跑；
线上真实流量有没有回放。
```

这几件事不能互相冒充。

### 2.3 交付准出

准出不是“测试命令退出码为 0”。

medium / high / release 想进入 `READY`，至少要同时满足：

- spec 有效；
- E2E 充分性 READY；
- 测试有效性 READY；
- security / diff 等基础检查通过；
- runtime 如果是 `DEGRADED`，必须原样报告，不能包装成 PASS。

## 3. 持续优化：失败后进入 bounded loop

发现失败或 `NOT_SUFFICIENT` 后，AI 不应该把日志丢给用户，也不应该乱改一堆东西。

SHK 要求 AI 进入受控 loop：

1. 一轮只修一个失败点；
2. 每轮重跑最小测试；
3. 最多 3 轮；
4. 没有进展就停，说明卡在哪里；
5. 不自动 push / tag / release；
6. 不用危险重置，不绕过校验。

## 后端探针，不是用户入口

这些命令是给 AI 工具读取的，不是让用户手动背：

```bash
node scripts/shk.js spec status --risk medium --format json
node scripts/shk.js e2e inspect --format json
node scripts/shk.js e2e bootstrap --risk medium --format json
node scripts/shk.js e2e assess --risk medium --format json
node scripts/shk.js test effectiveness --risk medium --format json
node scripts/shk.js verify --risk medium --write-evidence
```

AI 应该把这些结果翻译成人话。

## 用户应该看到什么报告

充分时：

```text
可以交付。

这轮要做的是订单创建。相关的正向路径、参数错误和失败阻断都已经跑过；我也把订单成功逻辑改坏试了一次，E2E 会失败。

机器状态：READY
```

不充分时：

```text
现在还不能交付。

订单创建这条主流程还没测到。现在的测试只证明了健康检查接口能通，没证明订单真的能创建，也没证明空订单会被拦住。

我会先补订单创建的正向用例和空订单拦截用例，再重跑这条最小 E2E。

机器状态：NOT_SUFFICIENT
```

runtime 降级时：

```text
Codex runtime smoke 当前是 DEGRADED。
这不能当作 runtime PASS，也不能用于 release READY。
```

## 当前第一版边界

第一版不做复杂覆盖率平台，也不接真实线上流量。它先把质量工程的核心闭环落住：

- spec 必须存在并可映射；
- 测试必须覆盖需求、风险和关键流量路径；
- E2E 必须有正向、负向、断言和 evidence；
- mutation/fault evidence 必须证明坏逻辑能被抓住；
- `NOT_SUFFICIENT` 必须阻断交付。

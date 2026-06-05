# 01. Spec 驱动交付流程

## 核心原则

spec 是交付流程的输入，不是交付后的总结。

AI 在目标工程里开始改代码前，必须先生成或更新 `.harness/iteration-spec.json`。后续的测试生成、测试有效性验证、交付准出，都依赖这份 spec。

## 正确流程

一句话版：

```text
SPEC → PLAN → EXECUTE → TEST GENERATION → TEST EFFECTIVENESS → VERIFY → REVIEW
```

展开版：

```text
SPEC
  写清需求、方案、风险、测试计划、流量路径、验收标准

PLAN
  根据 spec 拆任务；不能脱离 spec 自己发挥

EXECUTE
  按 spec 实现；发现 spec 不完整先回到 SPEC

TEST GENERATION
  根据 spec 生成或补齐测试

TEST EFFECTIVENESS
  判断测试是否覆盖 spec 的需求、风险和流量路径

VERIFY
  聚合 spec_status、e2e_sufficiency、test_effectiveness

REVIEW
  用人话说明：spec 要求什么、实现了什么、测试证明了什么、没证明什么
```

错误顺序是：

```text
PLAN → EXECUTE → VERIFY → 最后补文档
```

这种“最后补文档”不是 spec 驱动，只是事后总结。

## 阻断规则

- 没有 `.harness/iteration-spec.json`：`NOT_READY`。
- spec 缺需求、方案、风险、测试计划、流量路径或验收标准：`NOT_READY`。
- spec 写了，但测试没有覆盖 must 需求、风险或流量路径：`NOT_SUFFICIENT`。
- E2E PASS 但和 spec 无关：`NOT_SUFFICIENT`。
- mutation/fault 证明缺失：`NOT_SUFFICIENT`。

## AI 的报告口径

不要说：

```text
测试都通过了，完成。
```

要说：

```text
现在还不能交付。

订单创建这条主流程还没测到。现在的测试只证明了健康检查接口能通，没证明订单真的能创建，也没证明空订单会被拦住。

我会先补订单创建的正向用例和空订单拦截用例，再重跑这条最小 E2E。

机器状态：NOT_SUFFICIENT
```

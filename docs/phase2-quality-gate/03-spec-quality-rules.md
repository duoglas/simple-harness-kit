# 03. Spec 质量规则

## READY

满足以下条件，spec 才能 READY：

- 有 must requirements；
- 有 design summary；
- 有 risk_points；
- 有 traffic_flows；
- 有 test_plan；
- 有 acceptance；
- 每个 must requirement 都被 test_plan 覆盖；
- 每个 risk point 都被 test_plan 覆盖；
- 每个关键 traffic flow 都被 test_plan 覆盖。

## NOT_READY

这些情况是 `NOT_READY`：

- 缺 `.harness/iteration-spec.json`；
- JSON 不合法；
- 缺 requirements；
- 缺 design；
- 缺 test_plan；
- 缺 acceptance；
- 风险等级是 medium/high/release，但没有 spec 输入。

`NOT_READY` 的意思是：还没资格谈实现和准出。

## NOT_SUFFICIENT

这些情况是 `NOT_SUFFICIENT`：

- spec 有了，但 must requirement 没被测试覆盖；
- risk point 没被测试覆盖；
- traffic flow 没被测试覆盖；
- E2E PASS，但没有证明 spec 里的关键路径；
- 测试没有真实断言；
- 没有负向/边界路径；
- 没有 mutation/fault evidence 证明坏代码会失败。

`NOT_SUFFICIENT` 的意思是：流程走了，但证明力不够，不能交付。

## 和测试生成的关系

测试不是凭空生成的。AI 生成测试时必须从 spec 取输入：

- 根据 requirements 选正向场景；
- 根据 risk_points 选负向/边界场景；
- 根据 traffic_flows 选页面/API/命令入口；
- 根据 acceptance 写 evidence。

如果测试无法映射回 spec，就不能算有效测试。

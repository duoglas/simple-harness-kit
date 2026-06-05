# 02. Iteration Spec 模板

每轮迭代开始前，AI 必须先生成或更新 `.harness/iteration-spec.json`。

最小结构：

```json
{
  "schema_version": "1.0",
  "risk": "medium",
  "requirements": [
    {
      "id": "REQ-1",
      "text": "用户可以创建订单。",
      "priority": "must",
      "source": "user"
    }
  ],
  "design": {
    "summary": "新增订单创建接口，校验 items 后返回创建成功。",
    "changed_areas": ["order_creation"],
    "risk_points": [
      { "id": "RISK-1", "text": "空订单不能被当作创建成功。" }
    ]
  },
  "traffic_flows": [
    {
      "id": "FLOW-1",
      "name": "create order api flow",
      "entrypoint": "POST /orders",
      "steps": ["submit order", "assert created", "submit empty order", "assert blocked"],
      "covers": ["REQ-1"],
      "risks": ["RISK-1"]
    }
  ],
  "test_plan": [
    {
      "id": "TEST-1",
      "type": "e2e",
      "covers": ["REQ-1"],
      "risks": ["RISK-1"],
      "traffic_flows": ["FLOW-1"],
      "scenario": "创建订单正向 + 空订单阻断",
      "assertions": ["返回 created", "空订单报错"],
      "negative_or_boundary": true
    }
  ],
  "acceptance": [
    {
      "id": "AC-1",
      "text": "订单创建正向和空订单阻断都有自动化证据。",
      "covers": ["REQ-1"],
      "tests": ["TEST-1"],
      "must_have_evidence": true
    }
  ]
}
```

## 写 spec 的原则

- 需求要能被测试验证，不写空泛目标。
- 风险点要写最容易坏的地方。
- 流量路径要写真实入口，比如页面路由、API、命令或用户旅程。
- test_plan 必须映射 requirements / risk_points / traffic_flows。
- acceptance 必须说明 evidence 证明什么。

如果 AI 不确定启动方式或业务入口，只问一个具体问题，不要用猜测填 spec。

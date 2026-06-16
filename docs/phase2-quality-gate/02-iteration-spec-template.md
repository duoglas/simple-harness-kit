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
  ],
  "tasks": [
    {
      "id": "W1",
      "stage": "EXECUTE",
      "title": "实现订单创建接口",
      "covers": ["REQ-1"],
      "risk": "low",
      "done": "自动化测试证明订单创建正向和空订单阻断"
    }
  ],
  "irreversible_actions": [
    {
      "action": "发布、部署、删除数据或覆盖真实用户环境",
      "needs_human": true,
      "planned": "本轮不执行；如后续需要必须单独确认"
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
- tasks 必须是 ≤15 分钟、可独立验证、单一主要风险，并写客观 done。
- irreversible_actions 必须列出发布、部署、删除数据、覆盖真实环境等需人确认动作；没有计划执行也要写明不执行。

如果 AI 不确定启动方式或业务入口，只问一个具体问题，不要用猜测填 spec。

# 04. 实际目标应用验收

本轮验收必须证明：SHK 不是事后补总结，而是在目标应用交付流程里强制 spec 前置。

验收脚本：

```bash
bash tests/scripts/16-spec-driven-target-app-acceptance.sh
```

## 验收应用

脚本会创建一个临时目标应用：

```text
spec-driven-target-app
  src/orders.js
  tests/e2e/order-flow.e2e.js
  .harness/iteration-spec.json
```

业务是创建订单：

- 正向：有 items 的订单返回 `ORDER_CREATED`；
- 负向：空订单必须被阻断。

## 验收流程

### 1. 缺 spec 先失败

脚本先在没有 `.harness/iteration-spec.json` 的情况下运行：

```bash
node scripts/shk.js spec status --risk medium --format json
```

期望：`NOT_READY`。

这证明：spec 是前置输入，不是事后补档。

### 2. 写 spec，再生成测试

脚本随后写入 spec，里面明确：

- requirement：用户可以创建包含商品的订单；
- risk：空订单不能被当作成功；
- traffic flow：`POST /orders`；
- test plan：正向创建 + 空订单阻断；
- acceptance：两条路径都有 evidence。

然后根据这份 spec 生成 E2E。

### 3. 验证 spec / E2E / test effectiveness / verify

期望全部 READY：

- `shk spec status`
- `shk e2e assess`
- `shk test effectiveness`
- `shk verify --write-evidence`

### 4. mutation 验证

脚本故意把 `ORDER_CREATED` 改坏。

期望：E2E FAIL。

这证明：这套测试不是只走流程，关键行为坏了会被抓住。

## 验收结论

只有脚本完整通过，才算 Phase 2 的 spec 驱动流程在目标应用里成立。

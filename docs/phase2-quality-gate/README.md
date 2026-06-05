# SHK Phase 2 Spec-Driven Delivery

这组文档不是事后总结。它定义的是 **交付流程必须依赖 spec** 的工作方式。

正确顺序是：

```text
SPEC → PLAN → EXECUTE → TEST GENERATION → TEST EFFECTIVENESS → VERIFY → REVIEW
```

错误顺序是：

```text
PLAN → EXECUTE → VERIFY → 最后补文档
```

## 文档清单

- `01-spec-driven-workflow.md`：spec 如何成为交付前置输入。
- `02-iteration-spec-template.md`：每轮迭代 spec 应该怎么写。
- `03-spec-quality-rules.md`：什么样的 spec 才算有效。
- `04-target-app-acceptance.md`：如何用实际目标应用验收 spec 驱动流程。
- `05-phase2-dogfood-iteration.md`：本轮 SHK Phase 2 自己如何按 spec-driven 流程 dogfood，并用样例工程验收。
- `06-oss-dogfood-validation.md`：真实开源工程 dogfood；说明不能只用 fixture 证明测试有效，必须在真实 OSS 代码路径上跑 mutation。
- `07-upstream-ci-and-browser-dogfood.md`：补齐 upstream npm install / 原项目 CI，以及真实浏览器链路 E2E。

## 机器 evidence

机器证据仍在 `.harness/`：

- `.harness/iteration-spec.json`
- `.harness/spec-status.json`
- `.harness/test-effectiveness.json`
- `.harness/e2e-sufficiency.json`
- `.harness/verify-evidence.json`

这些 evidence 必须回到 spec 上解释，不能脱离 spec 单独说“测试通过”。

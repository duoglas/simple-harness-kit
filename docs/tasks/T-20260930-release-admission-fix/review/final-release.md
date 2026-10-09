# v0.15.1 发布验收

2026-10-09 已发布：[GitHub Release](https://github.com/duoglas/simple-harness-kit/releases/tag/v0.15.1)。

- 不可变版本提交：`8df2691fc99a63154b13f90283ab3b65d08a869e`。
- 产品修复与测试分别提交：`d996553`、`8df2691`；268 个文件与双独立审查通过的完整候选逐文件、模式及原始 Git 对象一致。
- 完整 Claude 与 Codex 独立源码审查均 PASS；历史失败记录保留。
- 原生 release 验证 READY：`run-6cffe848-87f4-4481-9f6b-ffcbb8c4aa8b`。
- 独立 `tests/pre-release-check.sh`：10 PASS / 0 SKIP / 0 DEGRADED / 0 WARN / 0 FAIL。
- 完整 `tests/run.js`：262 PASS / 0 FAIL / 1 optional SKIP / 0 DEGRADED。可选 Codex Init Smoke 未运行，未计入通过。
- Codex CLI 0.162.0 实际 hook smoke 和故障自检通过；此项不等同交互式 `/hooks` 界面或完整初始化流程验收。
- 两个真实 OSS 项目的 SHK E2E 与故障注入通过；Playwright Chromium 的 TodoMVC 页面流程及故障注入通过。
- 上游项目真实 `npm ci` 通过，但原始 CI 为 NO_PROOF（缺少有效脚本或只有占位命令），未计为有效上游质量证明。
- build/types/lint/coverage 有明确未配置原因，记为 NOT_APPLICABLE，不计入 PASS 或覆盖率达标。
- 以上均为本机实际验证，不声称远端 CI 已运行。

`v0.15.0` 保持在 `ff00b68241aacddf68d21f4a59554f843930574f`。新标签发布后，独立提交 `8813406` 将 master 的 `upgrade.sh DEFAULT_REF` 推进至 v0.15.1；标签内保留此前已发布的默认入口。三个相关任务在 GitHub Release 实际发布后，通过原生 task close 标为 shipped。

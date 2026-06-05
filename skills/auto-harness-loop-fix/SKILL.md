---
name: auto-harness-loop-fix
description: 在 AI 工具内执行受控自动修复 loop。Use when tests, E2E, quality gate, or verification fails and the user expects the agent to fix and rerun instead of only reporting failure.
---

# Auto Harness Loop Fix

这个 skill 用来处理“测试没过，AI 自己修一轮再测”的场景。目标不是无限自动改代码，而是让修复过程可控、可回滚、说得清楚。

## 触发条件

- 单测、lint、E2E、security scan、`shk verify` 或测试准出失败。
- 用户说“修复测试”“继续修”“自动 loop”“你自己修到过”。
- VERIFY 阶段发现 evidence 是 `NOT_READY`。

## 修复 loop 规则

1. 先读失败输出，找一个最小失败点。
2. 一轮只改一个原因，不把多个猜测混在一起。
3. 每轮只重跑最小相关测试；通过后再跑更大范围验证。
4. 最多 3 轮。连续没有进展就停，不硬猜。
5. 不自动 push、tag、release。
6. 不用 `rm -rf`、`--no-verify`、危险 reset。
7. 需要浏览器时优先用 in-app browser；不碰用户 Chrome，除非用户明确授权。
8. 每轮都写清楚：失败点、判断、改了什么、重跑了什么、结果。

## 后端检查器

AI 可以读取：

```bash
node scripts/shk.js loop state --format json
node scripts/shk.js quality status --format json
node scripts/shk.js e2e plan --format json
```

这些命令是给 AI 看的，不要让用户自己背命令。

## 输出要求

报告必须说人话，格式类似：
E2E PASS 不等于充分；如果只是 echo ok、空脚本、只 smoke、或没覆盖本次风险，用户报告要先说“现在还不能交付”，再说明测到了什么、没测到什么、下一步补什么；机器状态放最后，例如：机器状态：NOT_SUFFICIENT。DEGRADED 不能说成 PASS。

```text
第 1 轮：
- 失败点：login.e2e.spec.ts 找不到 Save 按钮。
- 判断：页面文案已经从 Submit 改成 Save。
- 修改：只改这个 selector。
- 验证：重跑 login.e2e.spec.ts，通过。
```

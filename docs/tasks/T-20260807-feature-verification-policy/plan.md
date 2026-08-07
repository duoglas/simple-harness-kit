# 可信基线、Suite Inclusion 与候选验证策略

## 目标

将验证成本治理抽象为公开、项目无关的 SHK 能力：可信 baseline、full admission、suite inclusion、候选改写失效、Reviewer evidence audit + risk probe，以及需求完成态占位符门禁。

## 阶段

1. SETUP：写 spec 和失败测试，确认旧行为会在目标风险上变红。
2. EXECUTE-A：实现 admission、candidate continuity 与 reviewer policy。
3. EXECUTE-B：实现声明式 suite inclusion，并接入 verify 执行计划。
4. EXECUTE-C：实现 requirement completeness，并在 task close 前 fail-closed。
5. VERIFY：开发中只跑 focused 测试；冻结最终候选后只跑一次完整门禁。
6. REVIEW：核对 exact commit/tree/evidence，做独立风险 probe，不机械复制完整门禁。

## 边界与不可逆项

- 只实现通用策略原语，不复制任何项目专属控制器、suite 名或命令。
- 现有 `shk verify` 默认调用保持兼容；新约束仅在显式配置或完成态切换时生效。
- 不在开发中重复运行重型 full；最终候选仅一次。
- 将已验证提交推送到配置的远端已获授权；tag/release 不在本任务范围。

## Commit 拆分

1. `feat(verify): add trusted baseline admission policy`
2. `feat(verify): add declarative suite inclusion`
3. `feat(requirements): block incomplete completed requirements`
4. `test(verify): cover admission inclusion and completeness`
5. `docs(verify): define focused final and reviewer responsibilities`

实现过程中可按依赖关系调整，但不得把所有变化压成一笔。

## 验收标准

- 可信 full evidence 才能作为 baseline；candidate、test manifest、runner/verdict/scheduler 变化会结构化失效。
- suite inclusion 支持传递闭包，拒绝 cycle/unknown reference，同候选下不重复执行。
- Reviewer 默认审计 evidence + 独立风险 probe；只在身份或 runner/verdict 等风险下要求重建 full。
- completed/shipped 状态遇到必填内容中的 placeholder 必须拒绝，正控与 draft 控制必须通过。
- public 内容通过专名泄漏扫描。
- 最终 exact commit 仅运行一次完整门禁并产生 READY evidence。

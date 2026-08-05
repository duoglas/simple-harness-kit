# SHK 可信证据、交付约束与安全升级

## 目标

交付一组可复用的 SHK 基础能力：结构化 evidence attestation、候选 Git 身份绑定、交付命令目标绑定、权威 evidence 守门、受管文件升级冲突预检、reviewed override manifest，以及可证明终止状态的进程树清理。

## 责任边界

### SHK 通用能力

- `shk verify --write-evidence` 生成绑定 commit/tree/dirty/mode/candidate digest 的权威结构化证据。
- `shk evidence verify` 校验摘要、候选身份、执行模式、clean policy 和已认证 trust policy。
- commit/tag/push 等交付动作只接受合法且与实际目标一致的结构化证据。
- REVIEW 阶段只接受权威结构化证据；Markdown 与弱状态文件仅供阅读。
- 更新器在任何写入前完成全量冲突预检，并通过上游 Git blob 约束 reviewed overrides。
- runner 累计观察进程组与进程树，执行 TERM/KILL 后再发现，并诚实记录不确定性和残留。

### 项目级接入

- 项目策略、阈值和领域判据由项目自身维护，不进入公共 SHK。
- 项目定制必须显式登记为 reviewed override；上游对应 blob 变化时自动失效并要求重新合并、复测和审查。
- 正常升级不得依赖 `--force-overwrite`；该选项只作为明确丢弃定制的破坏性恢复出口。

## 阶段

### Phase 0 — PLAN（complete）

- [x] 建立 high-risk iteration spec、任务计划与边界。
- [x] 明确可信 evidence、升级安全和 runner 清理的验收标准。

### Phase 1 — Tests first（complete）

- [x] 为摘要篡改、陈旧候选、错误 mode/trust、verifier unavailable 写负向测试。
- [x] 为 shell substitution、wrapper、Git target binding 和弱证据绕过写负向测试。
- [x] 为 stale/invalid override manifest、半升级和 runner 残留写负向测试。

### Phase 2 — Implementation（complete）

- [x] 实现 evidence attestation 库与 CLI。
- [x] 接入 delivery/verification/stage/doctor 消费方并保持明确的 legacy 边界。
- [x] 实现交付命令解析、verified HEAD 目标绑定和 fail-closed 错误码。
- [x] 实现升级事务预检、reviewed override manifest 和显式 force 语义。
- [x] 实现 runner 累计发现、TERM/KILL 再发现与 terminal evidence。

### Phase 3 — VERIFY / REVIEW（in progress）

- [x] unit 回归：253 passed、0 failed、1 skipped、0 degraded、254 total。
- [x] quality suite：98/98 PASS。
- [x] evidence attestation suite：21/21 PASS。
- [x] 完整回归：255 passed、0 failed、1 skipped、1 degraded、257 total；scripted matrix 14 PASS / 3 capability SKIP / 0 FAIL。
- [x] runner selftest：27/27 PASS。
- [x] fresh high-risk evidence：READY，独立 verifier PASS。
- [ ] 双独立 reviewer 对冻结 diff 给出 2/2 PASS。
- [ ] 精确暂存、提交并推送 `master`，不打 tag。

## 边界与不可逆项

- 只发布 SHK 仓库；不在项目仓库执行 push。
- 不操作外部执行环境。
- 不覆盖未审阅的项目定制，不使用跳过门禁环境变量。
- 发布使用完整 commit SHA；不创建 tag 或 release。

## 验收标准

1. 合法 evidence 可复算且绑定准确候选；篡改、陈旧、策略不匹配和未认证高 trust 均被结构化拒绝。
2. commit/tag/push 无法通过 substitution、wrapper、未知 Git option 或未绑定 refspec 绕过 verified HEAD。
3. REVIEW 在 task/legacy、strict/light 模式下均不能用弱证据替代权威 structured evidence。
4. 升级冲突在任何项目或 skill 写入前整批阻断；合法 reviewed override 被保留，stale manifest 自动失效。
5. runner 对已观察后代执行清理并记录 residual/uncertainty，不能把不确定状态冒充 clean PASS。
6. 最终验证如实区分 PASS、SKIP 与 DEGRADED。

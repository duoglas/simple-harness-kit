# Progress — T-20260804-evidence-attestation

## 2026-08-04 PLAN

- 创建 SHK high-risk 任务 `T-20260804-evidence-attestation`。
- 复核 public SHK 与 downstream project 边界。
- 确定第一开发切片：evidence attestation + verifier + 最小消费方接入；downstream project 只登记优化需求建议。
- 尚未修改产品代码，等待用户确认计划后进入 EXECUTE。

## Errors

| 错误 | 尝试 | 处理 |
|---|---:|---|
| 在 SHK 仓库读取 `package.json` 失败：文件不存在 | 1 | 确认本仓测试入口为 `node tests/run.js`，后续不再按 npm 项目处理 |

| 生成 spec 的 Python 字面量误写为 `true`，触发 NameError | 1 | 改用严格 JSON heredoc 写入并重新跑 spec status |

## 2026-08-04 EXECUTE

- 用户确认计划，进入 EXECUTE。
- 下一步先写 attestation 和 CLI 的失败测试。


## 2026-08-04 EXECUTE 完成情况

- 新增 `scripts/lib/evidence-attestation.js`：canonical JSON、whole-evidence SHA-256、Git commit/tree/dirty、mode/trust policy 和结构化失败码。
- `shk verify --write-evidence` 现写入 `run_id`、provenance、`local-self` attestation，并对 JSON 使用临时文件 + rename 原子落盘。
- 新增 `shk evidence verify` CLI；默认缺 attestation 时 fail-closed，只有显式 `--allow-legacy` 接受 legacy。
- delivery/verification/stage-guard/doctor 在 attestation 存在时拒绝 digest-invalid READY；项目配置 `evidence.require_attestation=true` 后拒绝 legacy。
- 新增 C-GATE-20、公共说明和 required wiring；新增公共行未出现 downstream 业务词。
- downstream project 仅在 RQ-0130/RQ-0133/RQ-0143/RQ-0144 和 handoff 追加优化需求建议；未改业务代码、status/candidate 或 target runtime。
- 真实临时 Git E2E 已完成：fresh PASS；受保护字段篡改返回 `ATTESTATION_DIGEST_INVALID`；新 commit 返回 `GIT_COMMIT_MISMATCH` + `GIT_TREE_MISMATCH`。

## 2026-08-04 回归验证（进入 VERIFY 前）

- JS syntax + `git diff --check`：PASS。
- evidence attestation：9/9 PASS。
- quality suite：73/73 PASS。
- template integrity：34/34 PASS。
- `TMPDIR=/private/tmp node tests/run.js --unit`：254/254 PASS。
- security scan：PASS，0 findings。
- 首次 full run 的 scripted matrix 被 `tests/run.js` 既有 10 分钟外层硬上限中止，`spawnSync.status=null`，已确认不是断言失败；将完整真实 E2E matrix 上限改为 30 分钟后正在重跑 full suite。
- 同时修复 `tests/run.js` 汇总遗漏 evidence attestation suite 的 passed 计数；unit 汇总现为 254 passed / 0 failed / 254 total。

## 2026-08-04 VERIFY 完成情况

- 修复 E2E 被普通检查的 120 秒默认 hard timeout 截断：E2E 现在有独立且始终有限的默认上限 600 秒，可用 `SHK_VERIFY_E2E_TIMEOUT_MS` 调整；0、负值和非法值会回退到有限默认值。
- 修复 `e2e_sufficiency` 与 `test_effectiveness` 重复执行同一 E2E：后者复用本次 `checks.e2e` 结果，单次 verify 只执行一次任务 E2E。
- 新增任务级 `verify-flow-e2e.sh`，真实覆盖证据生成、verifier 拒绝路径、关键消费方、mutation/fault 和 downstream documentation contract；证据与本次 run token 绑定。
- targeted：evidence attestation 9/9、quality suite 74/74、template integrity 34/34 均 PASS。
- 完整回归：`TMPDIR=/private/tmp node tests/run.js` 为 257/257 PASS；scripted matrix 为 14 PASS / 3 SKIP / 0 FAIL。3 个 SKIP 分别是缺少打包产物的 OSS dogfood、缺少打包/npm 环境的 upstream CI dogfood、缺少浏览器运行依赖的 browser E2E。
- security scan：PASS，0 findings；`git diff --check` 与修改 JS syntax check 均 PASS。
- 首次去泄漏重跑被任务 E2E 正确阻断：扫描时旧的未跟踪 evidence 仍携带调用方私有配置。verify 随后写出不含私有词的失败 evidence；第二次 fresh high verify 通过。
- 最终 high verify：`READY`，run `run-749bed56-38f1-4bcf-a6bf-165172045783`，full、dirty=true、trust=`local-self`，digest=`sha256:e6732f25d6e3517988b281a89b5751d6de2db43a18125011bbbaba5afd7df542`。独立 `shk evidence verify --require-mode full --min-trust local-self` 为 PASS。
- public 新增行与任务 evidence 的 caller-supplied forbidden-pattern 扫描无命中。
- coverage 未配置，不声明 80% 覆盖率；runtime/Codex smoke 仍按 DEGRADED/SKIP limitation 记录，不冒充 PASS；未授权独立 reviewer，Santa 明确 SKIP。
- downstream project 本任务只修改 5 个指定优化建议文档；发现一个并发新增报告，保持未触碰。status/candidate 未变化，无非 docs 变更，未操作 target runtime。

## HARNESS QA REPORT

- Layer 1 — Self Verification：PASS。代码、gate、schema 和兼容路径均有正控、负向、篡改、陈旧候选及 legacy policy 测试。
- Layer 2 — Verification Loop：PASS with limitations。Tests 257/257；E2E PASS；Security 0 findings；diff/syntax PASS；coverage、runtime 按上述 limitation 保留。
- Layer 3 — Spec Compliance：PASS（当前 agent 逐项核对 REQ-EVID-1/2/3 与 REQ-DOWNSTREAM-1；不冒充独立 reviewer）。
- Layer 4 — Santa Method：SKIP。未授权两个独立 reviewer，不声明 NICE/PASS。
- Overall：READY，受限项不会被描述为已验证能力。

## DELIVERY REVIEW

1. 流程合规：PASS；经过 PLAN → EXECUTE → VERIFY，fresh READY evidence 后进入 REVIEW。
2. QA 达标：PASS with limitations；覆盖率、runtime、Santa 的未验证范围均显式保留。
3. 需求完整：PASS；SHK 实现通用证明能力，downstream project 只登记项目优化建议。
4. 规则升级：PASS；通用证据完整性/信任边界已进入 constraint、文档和 required wiring。
5. 改进机会：把任务 E2E timeout 分类内建为结构化配置；避免同一 E2E 在多个评估器重复执行；公开 evidence 不应序列化调用方私有环境配置。
6. 行为学习：已运行 `harness-learn.js --report`；当前观察数据为 0 条且无门禁事件，未生成模式或 instinct，提示后续确认 session-logger wiring。


## 2026-08-04 FEEDBACK 修复

- 提交前 review 发现两个 blocker：高 trust 可通过自声明后重算 digest 冒充；三个 hook 在 attestation verifier 模块缺失时 fail-open。
- 强化 C-GATE-20 并新增 VH-30：声明 trust 与经认证 trust 必须分离；attested/strict consumer 的 verifier unavailable 必须 fail-closed。
- 本地 `attestEvidence()` 现在只允许签发 `local-self`；手工提升 trust 并重算 digest 会得到 `EVIDENCE_TRUST_UNVERIFIED`。只有库调用方提供外部已认证的 `authenticated_trust_level` 才能验证更高 trust，CLI 不暴露该参数。
- attestation format 现在固定校验 `protected_scope`；修改 scope 后重算 digest 仍会因 `ATTESTATION_UNSUPPORTED` 被拒绝。
- delivery/verification/stage-guard 在 verifier 不可用时：已 attested 或 strict policy 返回 `ATTESTATION_VERIFIER_UNAVAILABLE`；仅未 attested 且非 strict 的 legacy evidence 保持兼容。
- targeted 修复验证：evidence attestation 13/13、quality suite 77/77、JS syntax 与 `git diff --check` 均 PASS。完整回归和 fresh high evidence 待重跑，旧 run 不再作为最终提交证据。

## 2026-08-04 最终 VERIFY / REVIEW

- FEEDBACK 后新增的 legacy policy 绕过与 CLI 参数 fail-open 已修复：`--allow-legacy` 只放宽缺 attestation，不绕过 commit/tree、clean、mode、minimum trust；未知、重复、缺值参数和非法 format 均 fail-closed。
- 最终 targeted：evidence attestation 16/16、quality suite 79/79，均 PASS。
- 最终完整回归：257/257 PASS；scripted matrix 14 PASS / 3 SKIP / 0 FAIL。3 个 SKIP 仍是缺 OSS tarball、缺 upstream CI tarball/npm 环境、缺 Playwright Chromium。
- 最终任务 E2E：PASS；覆盖 evidence 生成与独立验证、tamper/stale/trust/verifier-unavailable/legacy 负向路径、关键 consumer、mutation/fault、下游文档契约和 public forbidden-term scan。
- 提交实现与测试切片后再次生成 fresh high verify：`READY`，run `run-e58beefa-e409-40d8-b4b3-ef54f0c1e52c`，commit `f54facdbff9e28dd3ea4e16f7c7e5670e5f1b682`，tree `9cf5a765f71fbfd29ba810f3bc4a1ce1eece365f`，`dirty=true`，mode `full`，trust `local-self`，digest `sha256:e755c02f2bf6e6d7f803c51bfb049bd88f25b7c72377cf7be8f52fefdf18bd1a`。
- 独立 `shk evidence verify --require-mode full --min-trust local-self --format json`：PASS。
- 最终逐文件 review 未发现新的 blocker；任务文档中的调用方私有仓名称已中性化，public 新增行禁词扫描无命中。
- 限制保持原样：coverage 未配置；runtime/Codex smoke 为 SKIP/DEGRADED 范畴，未声明 runtime PASS；Santa 未获独立双 reviewer 授权，明确 SKIP；`real-git-e2e.json` 仅是早期专项 artifact，不冒充最终完整回归。
- 进入 REVIEW，准备精确暂存和本地提交；不 push、不 tag、不 release。

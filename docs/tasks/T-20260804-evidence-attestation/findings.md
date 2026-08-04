# Findings — T-20260804-evidence-attestation

## 2026-08-04 边界结论

- public SHK 负责通用证明机制；downstream project 负责项目策略和 downstream 业务语义。
- 当前 SHK 已有 structured evidence、E2E run-token freshness、mutation killed/survived 和 task ledger，但 `writeEvidence()` 仍主要写普通 JSON，没有绑定 Git commit/tree/dirty，也没有 evidence 内容摘要。
- `.harness/gate-green-at` 若只是候选可写文件，会变成新的不可信状态字段；downstream project 的 RQ-0133 应消费通用 verifier，而不是把普通 marker 当最终信任根。
- 哈希提供一致性，不自动提供独立真实性。第一版必须显式记录 `trust_level`，不能把 `local-self` 描述成不可伪造签名。
- SHK 仓库没有 `package.json`；测试入口是 `node tests/run.js`。此前探测 package scripts 失败，后续不重复该假设。
- 另一个非目标仓库有用户预存未提交修改，本任务禁止触碰。

## downstream project 现有承载位置

- RQ-0133：候选包含 main + gate 精确跑在候选上；适合补 SHK attestation 消费建议。
- RQ-0143：构建输入双解析器；适合补 inputs manifest/hash 绑定建议。
- RQ-0144：负载相关判据清点；适合补结构化 infra/resource verdict 建议。
- RQ-0125/RQ-0130：已有 worktree/owner identity 相关内容；执行阶段先查覆盖范围，再决定补现有需求还是新增缺口需求。


## 2026-08-04 实现结论

- digest 保护整个 JSON evidence，仅排除 `attestation.digest` 自身；因此后续项目写入通用 `inputs` 时无需再维护字段白名单。
- SHK CLI 只签发 `local-self`。SHA-256 证明内容一致性，不证明签发者独立性；`local-controller` / `ci-signed` / `independent` 只能由真正建立对应边界的外部集成声明。
- consumer 采用迁移策略：attestation 一旦存在就必须有效；legacy 暂时默认兼容；项目设置 `evidence.require_attestation=true` 后强制 fail-closed。
- macOS 默认 `os.tmpdir()` 的祖先目录存在外部旧 `.harness`，会让 find-root 场景吸附错误根；本轮测试统一显式使用 `TMPDIR=/private/tmp`，未删除或覆盖外部状态。
- 完整 scripted matrix 已增长到真实应用/OSS/browser E2E，10 分钟外层上限会制造 infra 假红；runner 上限调整为 30 分钟，仍保留有限硬超时。

## 2026-08-04 VERIFY 结论

- 普通检查的 120 秒 timeout 不能直接套给真实 E2E；但 E2E 也不能允许 0/非法值取消 hard timeout。通用策略应是按检查类型提供独立、有限、可覆盖的默认值。
- 同一 E2E 同时服务充分性和测试有效性时，应共享一次结构化 run，而不是由两个评估器各跑一次；否则会放大耗时、资源争用和非确定性。
- 任务级 flow wrapper 必须在所有真实断言通过后才写 run-token-bound evidence，不能用预先存在的 PASS JSON 代替执行结果。
- public evidence 会记录配置中的 command；调用方私有路径或关键词不能内嵌到仓库配置，应由外层环境传入，公开 command 只保留通用 wrapper。
- 泄漏扫描首次正确拦截了旧 evidence 中的私有调用配置。这说明扫描应覆盖未跟踪交付物；同时生成流程需要通过一次失败 evidence 清除旧内容后再重跑，不能绕过扫描。
- downstream project 工作树存在一个并发文档，不属于本任务。边界判断应以“本任务 write set + 非 docs 禁止 + metadata 不变”为准，而不是错误断言整个工作树只有 5 个文件。
- 最终 READY evidence 诚实记录 `dirty=true` 和 `local-self`。当前结果证明内容完整性与本地生成过程，不等同于独立签名或 clean release candidate。

## 2026-08-04 提交前 FEEDBACK 结论

- 公开 digest 可由本地调用方重算，因此“声明的 trust level”不能作为“已认证 trust boundary”。本地 attester 只允许签发 `local-self`；更高声明没有外部认证结果时必须返回 `EVIDENCE_TRUST_UNVERIFIED`。
- `authenticated_trust_level` 只保留在库层供真正完成签名/controller 验证的集成调用；CLI 不暴露该入口，不能仅凭 JSON 中写着 `ci-signed` 就提升 trust。
- consumer 的 legacy 兼容必须区分依赖故障：verifier 不可用时，只有无 attestation 且未开启 strict 的旧 evidence 可继续；已 attested 或 `require_attestation=true` 必须返回 `ATTESTATION_VERIFIER_UNAVAILABLE`。
- digest 的准确能力边界是“检测未伴随新 attestation 的生成后改写”；`local-self` issuer 本身仍可重新签发，不能抵抗恶意本地生成者。

## 最终复核补充（2026-08-04）

- legacy compatibility 是“缺少 attestation 的迁移窗口”，不是其他策略的总开关；否则 `--allow-legacy` 会意外绕过候选谱系、clean、mode 和 trust 准入。
- verifier CLI 必须把未知参数、重复参数、缺失参数值和非法输出格式视为策略错误；静默忽略拼错参数等同 fail-open。
- public 仓任务记录本身也是交付面，必须和代码/文档一起做新增行泄漏扫描；本轮已将调用方私有仓名称中性化。
- 最终证明链以 fresh `verify-flow-e2e.sh`、257/257 完整回归和实现/测试提交后的 run `run-e58beefa-e409-40d8-b4b3-ef54f0c1e52c` 为准；早期 `real-git-e2e.json` 只证明当时的专项路径。
- fresh evidence 记录 `dirty=true`，适合证明本次提交前工作树的验证结果，但不声称是 clean release-candidate attestation；提交后 commit hash 由 Git 提交本身记录。

# SHK 可信证据与候选谱系基础能力

## 目标

交付 SHK 第一批通用可信证据能力，使 `shk verify` 产出的证据不再只证明“有一份 fresh JSON”，而能机械绑定生成时的 Git commit/tree、dirty 状态、执行模式和证据摘要；同时提供独立 verifier 供项目准入脚本消费。downstream project 只登记项目级优化需求建议，本任务不修改其业务代码、不部署target runtime。

## 责任边界

### public SHK

- 实现通用 evidence attestation schema、生成器与 verifier。
- `shk verify --write-evidence` 自动写入 provenance/attestation。
- 新增 `shk evidence verify`，支持校验证据摘要、commit/tree、clean、mode 和最小 trust level。
- 以结构化错误码区分 tampered/stale/dirty/mode/trust 等失败。
- 补正向、负向、篡改、陈旧候选、dirty tree 测试和公共文档/约束。

### downstream project

- 不复制 SHK 实现，不修改 project business or release code。
- 在现有 RQ-0133、RQ-0143、RQ-0144 等需求的合适位置追加“接入 SHK attestation”的优化建议，避免重复立项。
- 缺少现有承载项的内容，才新增独立优化需求；只写建议和客观验收，不进入 implemented/done。

## 阶段

### Phase 0 — PLAN（complete）

- [x] 复核 SHK/downstream project 边界和现有 evidence 实现。
- [x] 建立 high-risk iteration spec、任务计划和接力记录。
- [x] 用户已确认，进入 EXECUTE。

### Phase 1 — Tests first：attestation 契约（complete）

- [x] 新增单元/CLI 场景，先证明以下路径在未实现时失败：
  - 正常证据摘要可验证；
  - 修改 evidence 任意受保护字段后拒绝；
  - evidence commit/tree 与当前候选不一致时拒绝；
  - `--require-clean` 拒绝 dirty evidence；
  - `--require-mode full` 拒绝 incremental evidence；
  - 最小 trust level 不满足时拒绝；
  - 正常路径不会被“永远拒绝”实现误伤。

### Phase 2 — SHK attestation 实现（complete）

- [x] 新增单一通用库，负责 canonical payload、SHA-256、Git identity、trust/mode 校验和结构化 verdict。
- [x] `shk verify --write-evidence` 写入 schema version、run identity、commit、tree、dirty、mode、issuer/trust 和 digest。
- [x] 新增 `shk evidence verify` CLI；human/json 两种输出。
- [x] 保持旧 evidence 的兼容边界明确：普通读取可显示 legacy，要求 attested 时必须 fail-closed。

### Phase 3 — SHK 消费方与文档（complete）

- [x] doctor/delivery/verification 的最小安全接入：不得把 digest 已损坏的 evidence 当 READY。
- [x] 更新帮助、方法论文档和 kit-level constraints；按 C-META-04 同步 dogfood 约束副本。
- [x] 不把 downstream 业务名词写入 public SHK。

### Phase 4 — downstream project 优化需求建议（complete）

- [x] RQ-0133：建议 `req.sh implemented` 消费 SHK verifier，不采用可手写的 `gate-green-at` 作为最终信任根。
- [x] RQ-0143：建议构建输入 manifest 与 evidence 的 inputs hash 绑定。
- [x] RQ-0144：建议引入结构化 `CODE_FAIL/INFRA_TIMEOUT/RESOURCE_CONTENTION/DEGRADED`，项目继续负责阈值。
- [x] 检查 RQ-0130/RQ-0125 是否已覆盖 task/run nonce、重型 gate lease；只补缺口，不重复建需求。
- [x] 在 handoff 或需求索引中加入可发现的交叉引用。

### Phase 5 — VERIFY / REVIEW / FEEDBACK（in progress）

- [x] `node -c` 覆盖所有修改的 JS。
- [x] 跑新增 targeted tests。
- [x] 跑 `node tests/run.js` 全量；257/257 PASS，环境能力缺口按 SKIP limitation 记录。
- [x] 在临时 Git 仓库跑真实 CLI：生成 evidence → verify PASS → 篡改 FAIL → checkout/新 commit 后 stale FAIL。
- [x] 运行 SHK 自身 `shk verify --risk high --write-evidence`，产出 fresh READY evidence。
- [x] 检查 public SHK 泄漏词和 downstream project 工作树，不覆盖用户已有改动。
- [x] 提交前 review 发现高 trust 自声明与 verifier unavailable fail-open 两个 blocker，已按 C-GATE-20 修复并补 targeted 负向测试。
- [x] 重跑完整回归、fresh high evidence 和最终逐文件 review；确认无 blocker 后再提交。

## 边界与不可逆项

- 不 push、不 tag、不 release。
- 不操作 downstream target runtime、不运行 device write operation、不部署任何产物。
- 不修改任何本任务范围外仓库的现有未提交文件。
- 不把 downstream/公司内部信息写入 public SHK。
- downstream project 仅新增/更新需求建议文档，不改变需求状态和候选字段。

## 验收标准

1. `shk verify --write-evidence` 生成的 evidence 含可复算 attestation，绑定 commit/tree/dirty/mode。
2. `shk evidence verify` 对合法证据 PASS，对内容篡改、commit/tree 不一致、dirty/mode/trust 不满足分别给出结构化 FAIL。
3. SHK gate 不再把 digest 损坏的 READY evidence 当可交付证据。
4. 旧项目兼容行为有测试和文档，不出现静默误判。
5. downstream project 的建议落在已有需求或明确的新优化需求中，责任边界写清，未改业务代码和target runtime状态。
6. targeted、full test 与真实临时仓库 E2E 均有可复现记录。

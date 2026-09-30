# Task Ledger：任务态持久化（产出/簿记分层）

## 目标

把任务提升为 Harness 第一类实体，让任务状态跨 session 可接续、可审计：

1. `.harness/CURRENT` 指针 + `docs/tasks/<id>/` 目录分层：簿记（task.json/journal）与产出（spec/plan/findings/evidence/review）分离。
2. `task new / status / log / current / close` 全生命周期命令，close 前按 verification-policy 校验 requirement 完整性（shipped 必须内容达标）。
3. 门禁与 stage-guard 感知当前任务：证据路径回落（有 CURRENT 走任务目录，无则单例），存量项目行为不变。
4. 多轮修复：verify 增量 round 记录，全绿后可 seal 封盘。

## 阶段

- EXECUTE：ledger 核心（task-ledger.js + shk task 子命令）+ 门禁路径回落 + e2e 流量覆盖。
- REVIEW：spec 四条流量（F1 新任务 / F2 跨 session / F3 存量兼容 / F4 多轮修复）的正反断言齐备。
- VERIFY：20-task-ledger-e2e 并入 13-e2e-sufficiency 矩阵，e2e-result 合并写入 covered.traffic_flows。

## 边界与不可逆项

- 只新增产出物与命令，不改既有单例门禁语义；无 CURRENT 时行为与旧版完全一致（F3 断言）。
- close --outcome shipped 是任务态不可逆迁移，必须通过 requirement 完整性校验（缺内容拒绝）。
- journal.jsonl 只追加不重写；seal 后不再接受 round 写入。

## 验收标准

1. F1：`task new` 建出完整骨架；spec 缺失时 status 非零；spec 达标后 status 零；close shipped 后 CURRENT 清除、task.json 标记 closed、目录保留。
2. F2：新进程只凭 `.harness/CURRENT` 可取到接续摘要（journal 最近 handoff 行）。
3. F3：无 CURRENT 的存量项目，证据/门禁路径回落单例，全部既有 hook 场景不变。
4. F4：verify --round 逐轮追加，全绿后 --seal 封盘，seal 后 round 写入被拒。
5. 每条流量均有阻断断言（只跑通 happy path 不算覆盖），13-e2e-sufficiency 全绿。

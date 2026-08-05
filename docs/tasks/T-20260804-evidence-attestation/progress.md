# Progress — T-20260804-evidence-attestation

## 已完成实现

- 新增 `scripts/lib/evidence-attestation.js`：canonical payload、SHA-256、Git provenance、mode/trust policy 和结构化 verdict。
- `shk verify --write-evidence` 原子写入 provenance/attestation；`shk evidence verify` 提供 human/json 校验接口。
- delivery、verification、stage guard 和 doctor 对 attested/strict evidence fail-closed，并保留明确的 non-strict legacy 迁移行为。
- verification gate 支持 substitution、shell/wrapper、Git global option 和 refspec 解析；commit/tag/push 均绑定 verified candidate/HEAD。
- REVIEW 在 task 与 legacy 模式、strict 与 light guard 下均只接受 schema 合法的 structured evidence。
- `update.sh` 在任何写入前完成全量冲突预检，支持上游 blob 绑定的 `.harness/shk-overrides.v1`，并对 stale/invalid manifest 整批阻断。
- `run_guarded.py` 累计发现进程组和进程树，执行 TERM/KILL 后再发现，并把不确定性与残留写入 terminal evidence。
- `tests/run.js` 汇总改为分别统计 passed/failed/skipped/degraded/total。

## 已完成验证

- 定向 quality suite：98/98 PASS。
- evidence attestation suite：21/21 PASS。
- unit 回归：253 passed、0 failed、1 skipped、0 degraded、254 total。
- 完整回归：255 passed、0 failed、1 skipped、1 degraded、257 total。
- scripted matrix：14 PASS / 3 capability SKIP / 0 FAIL。
- runner selftest：27/27 PASS。
- 关键负向覆盖包括：摘要篡改、未认证高 trust、verifier unavailable、弱 evidence、动态 delivery executable、未知 wrapper/Git option、旧 tag/push source、stale override manifest、写入前事务阻断、detached descendant 与持续发现故障。

## 当前发布候选状态

- 当前阶段：REVIEW。
- 公共内容卫生检查、完整回归和 runner selftest 已完成。
- fresh high-risk evidence 已生成：READY、full、dirty=true、trust=`local-self`；独立 verifier PASS。
- 尚待：冻结 diff 双独立审查。
- 只有上述检查全部通过后才精确暂存、提交并 push `master`；不打 tag。
- 最终报告必须如实列出 capability SKIP 与 Codex runtime DEGRADED/SKIP，不得计入 PASS。

## 已知环境限制

- 缺少可选打包产物时，相关 dogfood 场景按 capability SKIP 记录。
- 缺少浏览器运行依赖时，browser E2E 按 capability SKIP 记录。
- Codex runtime smoke 本轮为 DEGRADED/SKIP；Codex init smoke 为 opt-in SKIP，不声明运行时 PASS。

## 边界

- 不操作外部执行环境。
- 不修改公共任务范围外的现有文件。
- 不使用 `HARNESS_SKIP_GATE`。
- 不打 tag，不创建 release。
## 2026-08-04 第三轮 Santa 反馈循环

- 来源：发布前双独立对抗审查，2/2 reviewer 均因交付解析与 runtime 分类问题判定 FAIL。
- 严重性：阻断。
- 层级：规则层 + 工具层。
- 已先写入 `C-GATE-23` / `VH-33`，覆盖动态关键位置 fail-closed、结果型 Git 操作不得复用操作前 evidence、runtime 只消费结构化终态。
- 下一步：先补失败回归，再修 parser/runtime，重跑最小测试、全量验证和双独立审查。

## C-GATE-23 实现与定向验证

- verification gate：动态 executable、wrapper option/environment、Git global target、subcommand、tag name/target、push destination/refspec 均在 substitution marker 命中时 fail-closed。
- legacy backtick：嵌套或转义 backtick 直接拒绝为 ambiguous；合法嵌套 `$()` 可正常解析。
- 结果型 Git 操作：`merge`、`cherry-pick`、`rebase`、`revert`、`am`、`pull` 在专用结果 attestation 实现前统一拒绝为 `GIT_DELIVERY_RESULT_UNBOUND`。
- runtime：新增 `[shk-runtime-result] status=...` 终态协议，`tests/run.js` 只读取最后一个结构化 marker；缺 marker 按 degraded fail-closed。
- 定向 quality suite：99/99 PASS。
- unit：253 passed、0 failed、1 skipped、0 degraded、254 total。
- 无 Codex 的隔离 PATH 验证：codex smoke/selftest 与 init smoke 均输出结构化 SKIP marker，exit 0。

## 2026-08-04 — Santa 第四轮反馈与修复

- Santa round 4：两名全新独立 reviewer 均判定 FAIL（2/2 FAIL），冻结 diff 未进入发布。
- 反馈先写入约束：新增 `C-GATE-24`、`C-GATE-25`、`C-GATE-26` 与 `VH-34`。
- 交付命令解析器现对变量 executable/subcommand/wrapper/target、动态 shell `-c`、Git config alias、`eval`/`source`/process substitution 全部 fail-closed；结果型 Git 操作 `merge/cherry-pick/rebase/revert/am/pull` 统一拒绝为 result-unbound。
- candidate digest 升级到 `shk-git-candidate-v3`：changed gitlink 绑定实际 checkout HEAD OID；dirty、未初始化或无法确认仓库边界的 submodule 令 Git identity unavailable。
- `update.sh` 在任何 skill 写入前递归预检 HOME 与显式项目四个 skill roots；未知文件、内容、symlink 或类型变化默认阻断，只有显式 `--force-overwrite` 才可丢弃。
- `upgrade.sh` 使用 `git status --porcelain=v1 --untracked-files=normal` 阻断 tracked、index 与 untracked kit 源树污染，同时保留 linked-worktree 支持。
- 定向回归：quality suite `101/101 PASS`；evidence attestation `22/22 PASS`。

### 本轮错误与处理

- 初次 quality rerun 在新增 untracked-upgrade 测试处失败；该进程在 `upgrade.sh` 修复落盘前已进入旧脚本路径。使用独立 fixture 验证新实现后重跑，测试 PASS。
- skill preflight 初次放在 manifest 校验之前，导致 manifest 负向测试看不到精确错误；保留完整 skill 扫描，但把冲突报告延后到 manifest/project 预检之后、首个写入之前，恢复精确错误优先级。
- 一次临时 shell 诊断因包含清理命令被执行策略拒绝；改为不删除 fixture 的只读诊断，没有降低验证范围。

## 2026-08-04 — 第四轮修复后的冻结验证

- static checks：`bash -n`、Python compile、Node syntax、`git diff --check` 全部 PASS。
- runner selftest：`27 passed, 0 failed`。
- task E2E：首次直接执行因缺少必须的 `SHK_E2E_RUN_TOKEN` 明确 FAIL；随后使用 fresh UUID run token 重跑，复用矩阵、attestation、quality、安全扫描与 task evidence 全部 PASS。
- 全量回归：`256 passed, 0 failed, 1 skipped, 0 degraded, 257 total`。
- Scripted Matrix：`14 PASS / 3 capability SKIP / 0 FAIL`；三个 SKIP 分别是缺少 OSS tarball、upstream CI 网络/缓存、Playwright Chromium，均未冒充 PASS。
- Codex runtime smoke + selftest PASS；Codex init smoke 为显式 opt-in capability SKIP。

## 2026-08-04 — Santa round 5 冻结候选

- fresh high-risk evidence 在修复后首次生成：`overall=READY`、`mode=full`、`trust=local-self`，run `run-941a56f5-46f1-4bda-9952-8fa725b6ee71`。
- 在把本条审计记录纳入最终候选后，将重新签发一次 fresh evidence；随后冻结 diff，启动两名全新且互不可见的 reviewer 执行 Santa round 5。

## 2026-08-05 — Santa Round 5 feedback repair

- F1-F4: recorded Round 5 findings as C-GATE-27 through C-GATE-30 and VH-35; synchronized kit and dogfood constraints.
- Delivery parser now rejects static Git aliases, unknown wrappers, shell control forms, executable globs, and multiple irreversible Git actions; shell continuation/redirection forms are normalized and recognized.
- Delivery/stage evidence consumers bind attested evidence to freshly read commit/tree/candidate identity.
- Candidate schema advanced to `shk-git-candidate-v4`; changed gitlinks bind the index OID and require a clean checkout whose HEAD matches that OID.
- Project managed targets are preflighted without following symlinks; forced replacement uses same-directory temporary files plus atomic rename.
- Upgrade aborts before fetch when kit status cannot be established.
- Any cleanup/discovery uncertainty forces runner `INTERNAL_ERROR`, non-zero exit, and empty completed steps.
- Targeted verification: quality suite 104/104 PASS; evidence attestation 22/22 PASS; runner selftest 28/28 PASS.

## 2026-08-05 — Santa Round 6 feedback repair

- Round 6 was NAUGHTY (0/2): Reviewer A reproduced authorization of backslash-newline and adjacent-redirection commit spellings when fresh evidence was valid; Reviewer B reproduced project parent-symlink writes outside the project and force-mode false success for directory leaves.
- Verification parser now treats raw backslash-newline and adjacent redirection around a delivery command as `GIT_DELIVERY_COMMAND_AMBIGUOUS` before normalization, including when current full evidence is otherwise valid.
- `update.sh` now canonicalizes the project root, preflights every existing parent component for all managed paths plus control paths, and never permits parent symlinks/type changes even under force.
- Managed directory/non-regular leaves are fail-closed in all modes; atomic installation uses a same-directory `mktemp`, revalidates the parent, performs `os.replace`, and verifies the resulting leaf is a regular file.
- Added regressions for valid-evidence continuation/redirection ambiguity, `scripts`/`scripts/hooks`/`scripts/lib`/`.harness` parent symlinks, and hook/lib/runner/CLI directory leaves under normal and force upgrades.
- Targeted quality suite after repair: 105/105 PASS.

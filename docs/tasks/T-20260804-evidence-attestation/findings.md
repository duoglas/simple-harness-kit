# Findings — T-20260804-evidence-attestation

## 信任边界

- fresh JSON 与 `overall=READY` 只能说明“存在一份状态”，不能说明它对应哪个候选、内容是否被改写或由谁建立信任。
- attestation digest 保护除自身 digest 字段外的完整 evidence；它能检测未伴随新 attestation 的生成后改写，但 `local-self` 签发者仍可重新签发。
- SHK CLI 只签发 `local-self`。`local-controller`、`ci-signed`、`independent` 必须由真实外部认证边界提供，不能由 JSON 自声明提升。
- legacy compatibility 只是缺少 attestation 时的迁移窗口，不能绕过 commit/tree/clean/mode/trust 等其他策略。
- attestation 已存在或策略明确要求时，verifier 缺失、异常、摘要错误或认证不足都必须 fail-closed。

## 候选与交付绑定

- candidate digest 排除任务 evidence 自身，以保证 evidence 生成与重新签发不会改变被证明候选；同时单独报告 index/worktree 是否一致。
- `git commit` 必须同时满足 candidate digest 与 index/worktree 完整匹配；tag/push 还必须将实际 source/target 绑定到 verified HEAD。
- shell command substitution、wrapper、Git global options 与 refspec 都属于解析边界。无法可靠判断执行目标时必须拒绝，而不是猜测放行。
- `command -v/-V` 是查询，不应误判为执行；`command -p`、shell `-c`、`env`、`sudo` 等真实 wrapper 则必须继续解包。
- REVIEW 只接受符合 schema 的权威结构化 JSON。Markdown、last-verification 或阶段历史不能替代 evidence verdict。

## 更新安全

- 仅比较模板版本无法证明项目文件未定制；同版本文件也可能包含已提交增强。
- 更新器必须先识别所有受管目标，再进行任何项目文件、local skill 或 global skill 写入，避免半升级状态。
- reviewed override manifest 绑定的是当前上游文件 Git blob，而不是项目定制内容摘要：项目可继续演进定制；上游变化时授权自动失效。
- manifest 中 malformed、duplicate、unknown path、stale blob、target missing、target equals upstream 都是配置错误，必须整批阻断。
- `--force-overwrite` 的语义是明确丢弃全部项目定制并移除失效 manifest，不应出现在常规升级路径。
- linked worktree 的 `.git` 可以是文件，仓库识别不能只接受 `.git/` 目录。

## Runner 清理

- 仅跟踪初始 PGID 会漏掉重新建立会话的后代；需要累计采样 PGID 与父子进程树，并在 TERM/KILL 后重新发现。
- 父进程在首次采样前退出是实际竞态；per-run marker 可补强常见路径，但不是操作系统级或密码学安全边界。
- 单个 stale PGID 或 `EPERM` 不能提前中断其他信号目标；布尔短路也不能跳过后续 TERM/KILL。
- 持续发现失败或残留进程意味着无法证明 clean terminal state，结果必须记录 `cleanup_uncertain`/residual 信息并返回内部错误。

## 验证与报告真实性

- 测试汇总必须分别统计 passed、failed、skipped、degraded、total；SKIP/DEGRADED 不能累计到 passed。
- 普通检查和真实 E2E 需要不同但始终有限的 hard timeout；非法或非正值配置应回退到安全默认值。
- 同一 E2E 同时服务多个评估器时应共享一次结构化结果，避免重复执行导致资源争用和不确定性。
- 公共任务记录、配置和 evidence 都属于交付面，必须和代码一起扫描新增行，不能包含环境专属路径、标识符或领域词。

## 第三轮审查后的补充结论

- substitution 安全边界不能只递归检查“替换内容是否直接执行 git”；替换结果落在 executable、wrapper 控制参数、Git subcommand 或交付 target/refspec 时，本身就是不可判定的交付语义。
- `git merge` 一类命令与 `git commit` 的根本区别是：gate 检查发生在操作前，而被交付候选产生在操作后；没有结果候选 attestation 就不能复用旧 evidence。
- runtime 状态属于协议字段，不属于自然语言；消费者必须读取唯一结构化终态，叙述文本中的状态词没有判定权。

## 第四轮审查后的补充结论

- 静态识别 `git` 字面量不够：shell 变量、动态 wrapper/options、Git config alias、`eval`/`source` 都能改变最终执行语义。任何二次解释或动态生成交付关键字段的路径都必须 fail-closed。
- submodule 是 Git tree 中的 gitlink，而不是普通目录。候选摘要必须绑定实际 checkout OID；只记录“目录/other”会让不同 gitlink 候选碰撞。dirty 或未初始化 submodule 不能形成可认证候选。
- `rm -rf` 整个 skill 目录意味着冲突检测必须覆盖完整目录树，而不仅是 `SKILL.md`。额外说明文件、旧版文件、symlink 和类型变化都属于可能被删除的定制面。
- upgrade checkout 前只检查 tracked/index diff 会漏掉未跟踪注入；受管源树的 untracked 文件同样可能在 checkout 后被 glob 同步，必须在 fetch/checkout 前阻断。

## 2026-08-05 — Round 5 findings and resolution

Round 5 demonstrated that safe delivery requires conservative treatment across four independent boundaries: shell interpretation, evidence identity, filesystem target type, and process discovery. A parser that recognizes only direct `git` tokens is insufficient when aliases, wrappers, control structures, globbed executables, continuations, redirections, or multi-action command chains can change the executed result. Evidence freshness is also insufficient unless every authoritative reader binds the evidence to the current commit/tree/candidate. For gitlinks, the index OID is authoritative because that is what Git commits; a checkout/index split is not an attestable candidate. Upgrade writers must never follow managed-target symlinks, and source status failures cannot be treated as clean. Finally, process discovery uncertainty is sticky: later clean observations do not justify PASS.

## 2026-08-05 — Round 6 findings and resolution

A command being recognized as a protected Git operation is weaker than proving its raw shell spelling is safe to authorize. Continuations and redirections must remain parser-ambiguity failures even when valid evidence exists; otherwise the evidence gate converts an intentionally fail-closed syntax into an allowed action. Likewise, leaf-only lstat is not a no-follow transaction: every ancestor directory is part of the write boundary. Force may replace a leaf symlink, but it must never authorize a symlinked parent or report success after moving a temporary file inside a directory-shaped leaf.

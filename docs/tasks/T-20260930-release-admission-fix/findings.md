# Findings

## 2026-09-30 双独立审查

冻结对象：`ff00b68241aacddf68d21f4a59554f843930574f`。Reviewer A 和 B 独立上下文，均判 FAIL；审查代码与既有测试，并分别运行纯内存准入与冻结 Git parser probe，未执行真实 push。

- 两位均复现：low full baseline 可授权 release REUSE；默认忽略控制面摘要；exact REUSE 跳过 review/freeze 前置条件。
- Reviewer A 另复现：requirements 通配路径混合有效与缺 text 元素时允许 shipped。
- 两位均复现：Git/wrapper 变更执行目录后仍使用原仓 evidence；follow-tags 可附带未绑定标签。
- attestation 外部 trust、摘要篡改拒绝、suite inclusion、升级冲突预检及 runner 不确定终态未发现本轮新增 blocker。

问题归类：工具层与规则层。约束：C-GATE-31/33/35/38；事件：VH-38。保留失败判决，修复后重新冻结复审，不能用旧完整测试绿灯代替修复。

## 第二轮复审

冻结产品/测试内容后，Reviewer A/B 均判 FAIL：目录与环境变更检查位于 wrapper 解包前。`command cd` / `command export` / `builtin cd` 可以隐藏后续 Git 上下文变化。两个不同 HEAD 的临时仓中，A 的有效证据错误放行了指向 B 的交付字符串；独立只读 shell probe 确认执行上下文确实变为 B，未实际执行交付。

准入范围、控制面身份、前置条件、通配字段与 follow-tags 修复均经两位 reviewer 审核通过。高风险聚合验证在取消前已完成且返回 READY，但该结果不能覆盖已复现缺口，不授权发布。继续按 C-GATE-38 修复解包后的统一检查，再冻结进入第三轮。

## 第三轮复审与暂停点

两位全新 reviewer 均判 FAIL，开始和结束的 7 项内容摘要均匹配。风险范围、控制面身份、前置条件、通配完整性和 follow-tags 已通过审计；实际 shell 上下文仍有两项缺口：

- 引号或转义后的 Git 等价拼写绕过原始文本 `mayReachDelivery` 判断：`command cd <B> && g'it' push origin HEAD` 可获放行。需要根据解析后的操作共同判定上下文修改，不能用原始拼写决定是否检查。
- `BASH_ENV` 指向的启动脚本先于 `bash -c` 执行，可先切到 B；直接赋值和 env wrapper 两种输入均未被识别。需要把 shell 启动输入纳入上下文信任边界。

探针均使用有效 A 仓 attested evidence；只读 rev-parse 证明真实仓库为不同 HEAD 的 B，未执行实际交付。第三轮 high 自动验证返回 READY（unit 257 PASS / 0 FAIL / 1 optional SKIP；任务 E2E PASS；quality 106/106；policy 19/19），但已被审查反例否定，不能据此发布。覆盖率未配置，runtime/browser 发布检查尚未运行。

Santa 三轮上限已到，等待用户决定是否追加一轮修复复审。原 v0.15.0 标签未动，v0.15.1 未创建；旧任务不结项。详见 `review/round-3.json`。

行为学习分析已执行：仅 1 条观察且无门禁事件，样本不足，不生成规则统计结论。

## 第四轮授权与修复

用户在人工升级后明确回复“继续”，授权追加一轮修复与独立复审。修复方向是先解析操作再统一校验上下文，并把 shell 启动输入纳入绑定边界；第三轮失败记录继续保留。

## 发布契约审计与扩展范围

独立只读审计发现：模板允许明确 N/A，producer/baseline/consumer 却没有对应契约；新 tag 自引用和发布前检查远端存在构成循环；升级检查使用同名本地对象代替远端对象，离线 SKIP 又被 pre-release 按 exit 0 计为 PASS。用户明确选择将这些修复纳入本次发布。

仅 build/types/lint/coverage 可声明 N/A 并说明原因；已配置命令冲突、关键证明豁免、缺验证器和当前契约漂移全部拒绝。关键发布检查继续要求 PASS。默认入口按已存在版本、新标签、后续独立更新的顺序推进。

升级证明先增加四项旧红回归，原实现 0/4；修复后扩展为 7/7 PASS，覆盖真实临时 bare origin、远端/本地同名错指、对象缺失、annotated tag、歧义引用、普通文件类型与 SKIP 汇总。生产远端没有因这些探针发生变更。规则：C-GATE-39/40，事件：VH-39。

## 第四至六轮修复与当前阻断

第四、五轮均为双独立 FAIL，详见 `review/round-4.json`、`review/round-5.json`。修复覆盖 runtime cwd、导出函数、shell 包装、tag 选项值、子模块递归、完整 spec 绑定、N/A 继承标记，以及全 PASS 契约、普通缓存控制内容和 release doctor 恢复路径。

第六轮 high 为 READY：unit 汇总 259 PASS / 0 FAIL / 1 optional SKIP，真实 Playwright 与任务 E2E PASS；专项 evidence 36/36、applicability 14/14、policy 19/19、quality 106/106。新增契约回归旧代码 11/14、修复后 14/14；四组 Git 回归均保留旧红新绿。

第六轮独立反例再次否定发布资格：

- 空字符串参数丢失，使 `git -C "" push` / `commit` 未被识别为交付。
- 控制文件内容漂移或缺失时，baseline 与普通缓存拒绝复用，但其他证据 reader 仍可能接受旧证明。
- shell 的 PS4/SHELLOPTS 和 Git 的执行回调配置可触发未绑定交付。
- `git subtree push` / `git-subtree push` 未进入门禁。
- 直接推送远端 `refs/tags/*` 只要求 low 风险，绕过 release 证据要求。
- 独立 doctor 未比较当前 Git commit/tree/candidate，候选改变后仍可能把旧证据记为 PASS。

这些探针未向真实远端交付。两项由主执行者用 hook-only 输入或隔离 Git fixture 独立复现；shell/Git 执行上下文只用无害 rev-parse 验证。自动 high 结果已标为不授权发布。

扩大范围后的三轮已到 Santa 上限，已请求人工决定是否继续收紧语法和统一 reader 校验。没有新增项目 commit、push、tag 或 Release；任务保持 open，v0.15.0 不移动，旧任务不结项。

# Findings — T-20260726-task-ledger

## dogfood 首次使用即发现 spec-quality 缺陷

写本任务自己的 spec.json 时，`shk task status` 报 `验收项 A5 关联了不存在的 requirement：R7`，
但 R7 确实存在，只是 `priority: "should"`。

根因：`specCoverageData` 用 `idSet(mustRequirements)` 同时承担两件事——

1. "must requirement 必须被 test 覆盖"的强校验（正确用法）
2. acceptance.covers 的引用存在性检查（错误用法）

导致 acceptance 引用任何 should 级 requirement 都被误报为悬空引用，
逼使用者要么把 should 提成 must（污染优先级语义），要么不写这条验收。

修法：拆出 `allRequirementIds` 供存在性检查用，must 集合仍只管测试覆盖强校验。

规则层结论：**优先级字段只应影响"要求有多强"，不应影响"这个 ID 存不存在"。**
凡是按 priority 过滤后的集合，都不能拿来做引用完整性校验。

## git porcelain 输出不能整体 trim

`verify-cache.changedFiles` 初版复用了通用 `git()` helper，它对 stdout 做了 `.trim()`。
`git status --porcelain` 的状态位是 `XY ` 三字符**定宽**前缀，未暂存修改的行首本身就是空格，
整体 trim 会把第一行的行首空格吃掉，随后 `slice(3)` 就切错一位——`src/a.js` 变成 `rc/a.js`。

只有第一行受影响（trim 只作用于整个字符串首尾），所以症状是"偶发的路径少一个字母"，
比全错更难发现。是真机连跑才暴露的，纯单测若只造单行输入也可能漏掉。

规则层结论：**定宽前缀格式的命令输出，解析前不得做整体 trim；只能按行处理并保留行首。**
适用于 `git status --porcelain`、`ls -l`、`df` 等一切列对齐输出。

## 簿记文件必须排除出验证指纹

首版把 `.harness/verify-cache.json` 自己算进变更集：每写一次缓存，下一轮变更集就多一个文件，
指纹永远在变，缓存永不命中——自己把自己的收益吃掉了。
journal.jsonl / evidence/ / INDEX.md 同理，它们在一次验证过程中就会变动。

规则层结论：**任何参与"输入是否变化"判定的文件集，必须排除该机制自身的产物**，
否则形成自反馈，机制静默失效（且表现为"功能正常但没效果"，不报错）。

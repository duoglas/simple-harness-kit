# 拆分提交检查 Hook 的输入处理函数，降低复杂度

## 目标

`scripts/hooks/commit-check.js` 的 stdin 结束处理函数集中了提交信息提取、subject 校验、Co-Authored-By 校验和未提交变更提醒四段逻辑，认知复杂度约 100。下游 overlay 项目在 SonarQube 中只要修改这个函数，就会被计为新增严重问题，质量门无法通过。本任务把它拆成按职责命名的小函数，行为保持不变。

## 阶段

1. SETUP：补充现有场景未覆盖的边界（非法输入、部分尾行不合规、`--message=` 与 `-m` 混用），在未修改的代码上确认通过，作为行为基线
2. EXECUTE：拆分处理函数，消除缺大括号、一行多语句、嵌套三元、字符串拼接、魔法数字等问题
3. VERIFY：commit-check 场景全部通过；对应 SonarJS 规则的 ESLint 检查无问题；`node tests/run.js --unit` 通过；`shk verify` 写出证据

## 边界与不可逆项

- 只改 `scripts/hooks/commit-check.js`、对应场景文件与 CHANGELOG；提示文本、输出顺序、stdout 为空的约定不变
- 不改变 Hook 的触发条件与警告级别
- push 分支与创建 PR 需用户确认；本任务不发布 tag 或 Release

## 验收标准

- ACC-HOOK-1：重构前后全部 commit-check 场景结果一致，新增边界场景通过
- ACC-HOOK-2：commit-check.js 中每个函数圈复杂度 ≤ 10、认知复杂度 ≤ 15、嵌套 ≤ 3 层，修改范围内无缺大括号、一行多语句、嵌套三元、字符串拼接问题

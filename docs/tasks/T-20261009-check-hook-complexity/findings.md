# Findings — T-20261009-check-hook-complexity

## 背景

下游 overlay 项目的合并请求在 SonarQube 质量门中失败：修改了 `scripts/hooks/commit-check.js` 的 stdin 结束处理函数后，该函数（认知复杂度约 100、圈复杂度 37）被计为新增严重问题。函数来自本仓库，overlay 单独重构会在之后每次同步时冲突，因此先在本仓库修复。

## 行为基线（SETUP）

在未修改的 `commit-check.js` 上新增 5 个场景并确认通过，连同原有 22 个共 27 个场景作为行为基线：

- stdin 不是对象：不报错、无输出
- 多个尾行中只有一行不合规：只列出不合规的行
- `--message=bare` 与 `-m` 混用：按出现顺序拼接
- 交付复盘命令且有未提交文件：提醒先提交（原先没有任何场景覆盖这条分支）
- 交付复盘命令但不在 git 仓库：静默

## 实现（EXECUTE）

处理函数拆为 `extractMessage`、`checkSubject`、`checkCoAuthor`、`checkCommitCommand`、`remindUncommitted`、`handleInput`；工具名清单与尾行正则提升为模块常量；提交信息提取的五层嵌套三元改为按捕获组顺序取第一个已定义值；字符串拼接改为模板与 `join`。提示文本逐字保留。

## 验证（VERIFY）

- commit-check 场景 27/27 通过
- 变异检查（每次只改一处，跑完恢复）：
  - `-m` 拼接顺序颠倒 → 2 个场景失败
  - 去掉未提交变更提醒 → 1 个场景失败（只有本次新增的场景能发现）
  - 不再报告不合规尾行 → 7 个场景失败
  - 跳过 subject 校验 → 2 个场景失败
- 静态检查：用与 SonarJS 对应的 ESLint 规则（curly、max-statements-per-line、complexity 10、sonarjs/cognitive-complexity 15、sonarjs/nested-control-flow 3、sonarjs/expression-complexity 3、sonarjs/no-nested-conditional、sonarjs/no-nested-template-literals、prefer-template、no-magic-numbers、no-shadow、no-console）检查 `commit-check.js`，0 问题。工具在仓库外的临时目录安装，未加入本仓库依赖
- `node tests/run.js --unit`：262 passed / 2 failed / 1 skipped。两个失败均为超时中断：Evidence Attestation Suite 触及运行器自身的 10 分钟上限，Verification Applicability Suite 被外层总超时一并终止；两者单独重跑分别为 146/146、33/33 通过，且不涉及 commit-check

## 未做

- 未运行 `shk verify --write-evidence`：当前 `.harness/config.json` 的 e2e 命令绑定 T-20260930 发布任务的规格，在本任务下无法使用，修改该配置不在本任务范围
- 未 push、未创建 PR、未发布版本，等待用户确认

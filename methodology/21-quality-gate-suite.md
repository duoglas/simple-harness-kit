# Quality Gate Suite

Quality Gate Suite 把 SHK 的测试、准出、Infra Tier、E2E quickstart、security scan 和结构化 evidence 合并为一个可运行的质量门控面。

## 命令面

```bash
node scripts/shk.js verify --risk medium --write-evidence
node scripts/shk.js evidence verify --current-git --require-clean --require-mode full
node scripts/shk.js doctor --format json
node scripts/shk.js security scan
node scripts/shk.js test-infra assess
node scripts/shk.js e2e detect
node scripts/shk.js qa report
```

`shk verify` 生成三份证据：

- `.harness/verify-evidence.json` — 机器准出源
- `.harness/verify-evidence.md` — 当前任务摘要
- `docs/verification-report.md` — 人类可读报告

JSON evidence 同时携带 Git commit/tree/dirty、执行模式、issuer/trust 和 canonical SHA-256 digest。`shk evidence verify` 可按候选 commit/tree、clean、mode 和最小 trust 做校验。摘要只能检测未伴随新 attestation 的生成后改写；本地 issuer 仍可重新签发，所以本地 CLI 产物必须诚实标成 `local-self`。更高 trust 必须由签名/controller 等外部认证边界确认，不能靠 JSON 自声明。完整契约见 `docs/evidence-attestation.md`。

## Risk level

| Risk | Required checks |
|---|---|
| low | build / tests / diff / security |
| medium | low + types / lint / coverage / spec |
| high | medium + e2e / santa |
| release | high + runtime smoke + clean tree + local==upstream |

未配置的项目命令标记为 `SKIP`；失败命令标记为 `FAIL` 并使 overall 变为 `NOT_READY`。coverage 或 runtime/Codex smoke 为 `SKIP` 时，报告必须写入 limitations，说明没有覆盖率 80% 证明或 runtime hook 完整执行证明；不得把 SKIP/DEGRADED 写成 PASS。release 风险额外要求工作区干净且本地 HEAD 与 upstream 一致。

## Gate 行为

`verification-gate.js` commit/tag 前优先读取 `.harness/verify-evidence.json`：

1. evidence 必须晚于当前 stage 的 `since`。
2. `overall` 必须是 `READY`。
3. `git tag` 要求 `risk=release`。
4. attestation 存在时 format/digest/trust authentication 必须有效；损坏或未认证高 trust 的 `READY` evidence 一律拒绝。
5. verifier 模块不可用时，只允许“无 attestation 且未启用 strict”的 legacy evidence 兼容；attested evidence 或 `evidence.require_attestation=true` 必须 fail-closed。
6. 旧 Markdown/legacy JSON evidence 仍可在上述窗口兼容，但不能表达完整 provenance；项目应明确兼容截止条件。

## PreToolUse enforce 观测

`harness-stage-guard.js` 在每次 `PreToolUse` 触发时写入 `.harness/pretool-observations.jsonl`。`shk doctor` 会比较：

- `.harness/observations.jsonl` 中已有 Bash PostToolUse；但
- `.harness/pretool-observations.jsonl` 中没有 PreToolUse。

若出现这种组合，doctor 报 `pretool-enforce-observed=FAIL`。这可以发现“日志在跑，但阻断 hook 没跑”的半失效状态。

## Internal leak patterns

Public kit 不硬编码任何组织私有词表。通用 secret pattern 内置；组织或 overlay 可通过以下本地文件注入私有泄漏词表：

- `.harness/security-patterns.json` — secret / token / 私有关键字
- `.harness/public-leak-patterns.json` — public repo 泄漏词表
- `.harness/internal-leak-patterns.json` — overlay 私有别名，等同 public leak pattern

`shk security scan` 同时检查：

- generic secrets；
- 配置化 public leak patterns；
- high-risk hook / MCP config（例如 destructive shell、`curl | sh`、world-writable chmod、权限绕过 flags）。

## Infra Tier gate

`shk test-infra assess` 生成 `.harness/infra-tier.json` 与 `.harness/test-capability.json`。`harness-stage-guard.js` 会在写入 `.harness/current-stage.json` 切换到 `EXECUTE` 时读取该文件：若 tier 为 0，且任务不是测试/infra 治理任务，则阻止进入新 feature EXECUTE。

## Manifest profiles

`manifests/shk-profiles.json` 是 profile source of truth。`shk install --profile <name> --dry-run` / `shk repair --profile <name>` 会展开 profile 并输出 add/update/skip/conflict 四类计划，repair 默认只补缺失文件，`--force` 才覆盖本地修改。

## 绿灯要声明自己覆盖了什么

这不是一条硬性约束，是一个判断习惯。它值得单独写出来，因为同一个失效模式在完全不同的
领域反复出现，而每次都长得不一样：

- 一个 `--full` 构建检查报 105/105 全绿，但它只构建 prod 装配体，**不构建实际上机的那个**。
  接口改了而某个实现类没同步时，它照样全绿，直到真机 DEX 编译失败。
- 一个命令加了处理分支，但没登记进热路径的派发预筛表。命令完全静默——不报错、不留痕、
  不回复。而闭包完整性门禁**物理上抓不到**：处理器存在、可达、闭合完整，缺的是注册。
- 一次改造把验证证据的**写入**路径换了位置，测试全绿，但没有一条测试检查**读取**方
  还找不找得到。于是门禁在新模式下整体失效。
- 一个测试场景的断言键拼错，测试框架静默忽略未知键，场景显示 PASS 而实际什么都没断言。

四个都是同一个结构：**检查覆盖的范围，和人以为它覆盖的范围，中间有个缺口；
而"全绿"这个结果本身不会暴露缺口。**

### 实践上怎么用

- 凡是存在「A 处声明、B 处实现」的一致性要求（注册表与分支、清单与复制点、
  写入方与读取方、接口与实现类），**要有一条直接比对这两边的检查**。
  不要指望上游的全绿顺带证明它——上游证明的是上游关心的东西。
- 新增或修改一个绿灯时，顺手回答一句：**它构建/覆盖了哪些消费方？有没有消费方在它之外？**
  答不上来就是缺口所在。
- 存在未被覆盖的消费方时，那个绿灯**不足以作为准出依据**。它仍然有价值，
  只是价值范围要说清楚。

kit 自己就吃过这个亏：`required_files` 是声明、`03-full-e2e.sh` 的复制段是实现，
两处从无比对，同一类漏项连咬三次才补上一条检查（见 `tests/template-integrity.js`）。

## 门禁脚本自身的编写规范

门禁脚本判断别人合不合格，所以它们自己出错的代价更高：**一个读错退出码的门禁不会报错，
它会放行。** 四条铁律，前两条已由 `tests/scripts/23-shell-gate-lint.sh` 静态检查，
后两条只能人工 review。

### L1 管道之后的 `$?` 不是上游的

`cmd | tail -3` 的 `$?` 是 `tail` 的。上游失败、下游成功时，这个判断读到的是成功。
实证：某工程因此把一次 `EXIT=1` 读成了通过。用 `PIPESTATUS[0]`，或者干脆拆开写。

### L2 `set -euo pipefail` 下裸读文件 = 静默死

`v="$(cat 可能不存在的文件)"` 在 `pipefail` 下会让脚本**零输出、退出码 1、无任何错误信息**
地终止。它看起来像"脚本跑了但什么都没发生"，最难排查。

诊断法：`sh -x` 重跑，**trace 停在赋值行本身**就是这个模式。
写法：`|| true` 兜底后显式判空，或者先测存在性。

### L3 不要写死测试总数（人工 review 项）

判据应该是 `failures=0 && timeouts=0 && 无未登记用例`，报实际的 passed/total。
写死"必须等于 251"会在用例增加的当天误判为失败，然后被人顺手改大——
改大之后它就再也不是判据了。

### L4 为消灭某类 bug 写的代码，两个分支都要测（人工 review 项）

上面那个 L2 静默死，恰恰出自一段**"为了消灭静默失败"而加的检查**——它只测了
"锁存在"这个分支，没测"锁不存在"，而后者正是它要防的情况。

新加的防御代码最容易只被正向路径覆盖，因为写的时候脑子里想的是"它会保护我"，
而不是"它自己会不会坏"。

### 静态检查覆盖的范围

`23-shell-gate-lint.sh` 只覆盖 L1/L2。**它全绿不代表 L3/L4 也合格**——
这条提醒本身就是本文档反复强调的那件事：绿灯必须声明自己覆盖了什么。

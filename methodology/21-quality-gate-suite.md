# Quality Gate Suite

Quality Gate Suite 把 SHK 的测试、准出、Infra Tier、E2E quickstart、security scan 和结构化 evidence 合并为一个可运行的质量门控面。

## 命令面

```bash
node scripts/shk.js verify --risk medium --write-evidence
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

## Risk level

| Risk | Required checks |
|---|---|
| low | build / tests / diff / security |
| medium | low + types / lint / coverage / spec |
| high | medium + e2e / santa |
| release | high + runtime smoke + clean tree + local==upstream |

未配置的项目命令标记为 `SKIP`；失败命令标记为 `FAIL` 并使 overall 变为 `NOT_READY`。release 风险额外要求工作区干净且本地 HEAD 与 upstream 一致。

## Gate 行为

`verification-gate.js` commit/tag 前优先读取 `.harness/verify-evidence.json`：

1. evidence 必须晚于当前 stage 的 `since`。
2. `overall` 必须是 `READY`。
3. `git tag` 要求 `risk=release`。
4. 旧 Markdown evidence 仍兼容，但不能表达 `overall` 和 risk level。

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

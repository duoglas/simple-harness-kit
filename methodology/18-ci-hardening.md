# CI 加固约束

## 为什么需要这份文档

CI workflow 是项目对外暴露的、带写权限的可执行入口。一个配置粗糙的 workflow（过度权限、未 pin 版本、无并发控制、无超时）就是供应链攻击和资源失控的入口。

本文档把"生成或新增 CI 时必须满足的约束"持久化，避免每次靠 AI 当场记得做对——本约束源自实验 [`experiments/ecc-vs-shk/`](../experiments/ecc-vs-shk/RESULTS.md) 的 dogfooding 副产品：两条 lane 都满足任务要求，但 ECC 驱动那条工程更健壮（concurrency + timeout），正是因为 ECC 把这些当成默认约定而非可选项。把这种"默认约定"写下来，就是把外部经验内化成 SHK 自己的方法论。

## 一、最小必备约束（生成任何 CI workflow 都必须满足）

| ID | 约束 | WHY | 违反后果 |
|---|---|---|---|
| C-CI-01 | `permissions:` 显式收窄（首选 `contents: read`），不得用默认或 `write-all` | GitHub Actions 默认 token 权限随仓库设置而变；显式声明等于自我审计 | 一个被注入的 step 即可改 release/issue/PR |
| C-CI-02 | 第三方 action 必须 pin 版本（最低 `@vN` tag，见 §二） | 未 pin = 跟 master，攻击者推恶意 tag 即可命中你 | 2024+ 多起 tj-actions 类供应链事故 |
| C-CI-03 | 每个 job 设 `timeout-minutes`（建议 ≤10） | 死循环或 fork-bomb 在没有超时时会耗光 Actions 配额 | 账单/配额事件、PR 阻塞 |
| C-CI-04 | 触发 PR 的 workflow 设 `concurrency: cancel-in-progress` | 同一 PR 连推 N 次会并发起 N 份相同 job，浪费配额 | 配额浪费、合并冲突期 CI 漂移 |
| C-CI-05 | 安装依赖时必须禁脚本（`npm ci --ignore-scripts` / `pnpm install --ignore-scripts` / `yarn --mode=skip-build` / `bun install --ignore-scripts`） | install-time `postinstall` 是供应链注入主入口（参见 ECC `scan-supply-chain-iocs.js`） | 一次 `npm install` 即被注入 |
| C-CI-06 | 不允许 `pull_request_target` + checkout 不可信 ref/repo | 该组合让 fork PR 代码在 base 仓库的 write-scoped token 下执行 | GitHub 安全文档列为高危 |

这 6 条约束已登记到 single source of truth [`docs/constraints.md`](../docs/constraints.md) §JC-08，是 SHK 生成下游 CI 时的强制必填项。

参考实现：本仓库 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 满足 C-CI-01..04 与 C-CI-06；**C-CI-05 因本仓库 CI 不安装第三方包管理器依赖故不适用，但作为生成下游 CI 的强制项保留**。

## 二、Pin 成熟度两阶段

不要把"pin 到 commit hash"当成所有项目的入门门槛——它需要外部可信源持续维护，否则会演变成"看起来 pin 了实际过期不更新"。区分两个成熟度：

### 阶段 1：tag pin（`actions/checkout@v4`）

适用：新仓库、无 Dependabot/sigstore、维护精力有限。

特点：
- 表达"按这一个大版本拿"，攻击者若发布 `v4.0.99` 恶意 tag，理论上能命中
- 但 GitHub 主流 action 由 actions 组维护，tag 移动风险相对低
- **运维成本接近零**

### 阶段 2：commit-hash pin（`actions/checkout@<40-char-sha>`）

适用：生产关键路径、有 Dependabot 自动 PR 升级、需通过供应链审计。

特点：
- 完全锁死字节，无 tag 移动可乘之机
- **必须**配合 Dependabot 或 Renovate（否则 SHA 过期没人推升级，安全反成阻塞）
- 推荐在 yml 行尾加注释标明对应 tag：`uses: actions/checkout@a1b2c3...  # v4.1.7`

### 升级路径

新项目从阶段 1 起步；当 (a) 上 Dependabot/Renovate 且 (b) 项目进入生产用途时，整体迁到阶段 2。中间状态（部分 action SHA pin / 部分 tag pin）容易让审计失焦，应在一个 PR 内整体切。

## 三、与其他约束的关系

- [05-hook-enforcement.md](05-hook-enforcement.md) 讨论的是**本机** PreToolUse/PostToolUse hook 拦截；本文是**远端** CI 拦截。两层互补：本机 hook 拦"我写错代码"，CI 拦"PR 进来的代码 + workflow 本身"。
- [15-hook-coverage-matrix.md](15-hook-coverage-matrix.md) 矩阵的 intent vs registered 概念同样适用于 CI：workflow 文件就是 CI 的 "registered"，本文 §一是 "intent"。新增 workflow 时对照 §一逐条核对。
- [16-infra-tier.md](16-infra-tier.md) 的"基础设施分层"思路在此体现为：把"权限/pin/超时/并发"当作 workflow 的基础设施层约束，业务 step 是上层。

## 四、Anti-patterns

- 把 `permissions: write-all` 当 "省事"——一次注入即可改任何东西
- 把 commit-hash pin 当成"必须做的高级实践"——没有 Dependabot 的 SHA pin 是技术债不是安全
- workflow 里直接 `npm install` 不加 `--ignore-scripts` 还写注释"我们包不多没事"——你的传递依赖会笑出声
- `pull_request_target` + `actions/checkout` 拉 `${{ github.event.pull_request.head.sha }}`——这是入侵 base 仓库的范式入口

## 五、下游项目如何采纳

本仓库已经把 C-CI-01..06 登记到 [`docs/constraints.md`](../docs/constraints.md) §JC-08。下游项目用 SHK init 出来的 `constraints.md`（基于 [`templates/constraints.md.tmpl`](../templates/constraints.md.tmpl)）应**整组复制 JC-08 块**作为生成 CI workflow 的强制必填项，并在 PR review 与 CI workflow 修改时强制核对。

注意 C-CI-05 的"包管理器禁 lifecycle script"是**通用强制项**，不因 SHK 自身仓库不安装依赖而豁免——下游项目大概率会安装依赖，必须遵守。

# Company Presets — 把公司/团队规则数据化

## 问题

不同公司/团队/项目对 commit 格式和分支策略有不同要求：

- 有的公司 GitLab 服务端 hook 强制 `<6位 task-id> <type> <subject>` 格式（无冒号），与 Conventional Commits 不兼容
- 有的公司只允许 `feature-*` / `release-*` / `master` 等受限分支由特定角色操作，开发者只能在 `<author>-feature-*` 上 push 后通过 MR 合入
- 有的 release 分支上禁止 `feat` 类型（只能 fix）
- 有的项目 fork 来源有约束（feature 必须 fork 自 master，hotfix 必须 fork 自 tag）

之前 harness-kit 的 `methodology/12-commit-standards.md` 把 Conventional Commits 写死，公司私有规则只能在 kit 之外维护，重复劳动且脱节。

**Preset 系统**把这些规则数据化为 JSON 文件，AI 收到 active preset 即可遵循，无需改动 hook 代码。

## 概念

**Preset = 一组 commit/branch 规则的命名集合**，存放在 `presets/<name>/`：

```
presets/<name>/
├── manifest.json        # 元信息 + extends
├── commit-format.json   # subject_regex / type_enum / type_blocked_on_branch / examples
├── branch-policy.json   # protected_branches / merge_only_branches / fork_constraints
└── README.md            # 说明文档
```

Hook 在每次 `git commit` / `git push` 前加载 active preset，按其规则放行或阻止。

## 加载顺序

`scripts/hooks/load-preset.js` 按以下顺序解析 active preset 名称：

1. `process.env.HARNESS_PRESET` — 临时覆盖
2. `<root>/.harness.local.json` 中的 `preset` 字段 — 每台机器持久选择
3. `<root>/.claude/settings.json` 中的 `harness.preset` 字段 — 项目层默认
4. `generic` — 兜底

如果指定的 preset 目录不存在（例如选了 `acme-internal` 但 `presets/acme-internal/` 没在本机），**自动回退到 `generic`** 并 warn，不 crash。这让"私有 preset 内容只在某些机器上存在"成为可能。

## 内置 preset

### `generic`（默认）

等价于 `methodology/12-commit-standards.md` 描述的通用规则：
- subject_regex：`^(feat|fix|docs|chore|...)(\([^)]+\))?: .{1,72}$`
- 无 protected_branches / 无 type_blocked_on_branch

### `example-company`（公开范例）

演示一个常见公司场景的规则组合。**不是任何真实公司的规则**，作为学习和模板使用：
- subject_regex：`^[A-Z]+-\d+\s+(feat|fix|...)(\([^)]+\))?: .{1,72}$`（要求 TICKET-ID 前缀）
- protected_branches：`feature-*` / `release-*` / `hotfix-*` / `main` / `master`（拒绝直接 push）
- single_branch_constraints：`release-*` 同时只能存在一个
- fork_constraints：`feature-*` 必须从 `main`/`master` fork
- type_blocked_on_branch：`feat` 在 `release-*`/`hotfix-*` 上禁止

## 写自己的 preset

最简单的方式：

```bash
cp -r presets/example-company presets/<your-company>
$EDITOR presets/<your-company>/manifest.json
$EDITOR presets/<your-company>/commit-format.json
$EDITOR presets/<your-company>/branch-policy.json
```

然后启用：

```bash
echo '{"preset":"<your-company>"}' > .harness.local.json
```

## Schema 详解

### manifest.json

```json
{
  "name": "your-company",
  "version": "1.0.0",
  "description": "短描述",
  "extends": "generic",   // null | preset 名；继承 commit-format + branch-policy 然后覆盖
  "files": {
    "commit_format": "commit-format.json",   // 可改名
    "branch_policy": "branch-policy.json"
  }
}
```

### commit-format.json

| 字段 | 类型 | 说明 |
|---|---|---|
| `format_description` | string | 给人看的格式说明，warn 时显示 |
| `subject_regex` | string | JS 正则，匹配 commit subject 第一行 |
| `subject_max_length` | int | 主题最大长度（建议 ≤ 100） |
| `type_enum` | string[] | 允许的 type 列表（用于 lint 提示） |
| `require_co_authored_by_for_ai` | bool | AI commit 是否强制 Co-Authored-By（默认 true，建议保持） |
| `type_blocked_on_branch` | object | `{type: [branch-pattern]}` —— 在指定分支上禁止指定 type |
| `examples` | string[] | warn 时显示的合规示例 |

### branch-policy.json

| 字段 | 类型 | 说明 |
|---|---|---|
| `description` | string | 给人看的策略说明 |
| `protected_branches` | string[] | 受保护分支（glob，如 `release-*`）—— 仅声明，不直接强制 |
| `merge_only_branches` | string[] | 拒绝直接 push 的分支（glob）—— **被 branch-policy-guard 强制** |
| `single_branch_constraints` | object | `{pattern: {max_concurrent: N, message: ...}}` —— 仅声明 |
| `fork_constraints` | object | `{pattern: {from: [...] \| from_tag: bool}}` —— 仅声明 |

注意：当前 `branch-policy-guard.js` 只强制 `merge_only_branches` 和 `type_blocked_on_branch`。其他字段是给文档/外部工具的元信息（GitLab 服务端 hook 已经强制了它们时不需要客户端重复劳动）。

## 公开 vs 私有 preset

### 公开 preset（committed）

- **能放入 commit-format/branch-policy 的内容**：规则形状（正则、glob、布尔）
- **不能放的内容**：内网 URL、真实 task ID、员工身份、公司代号
- **典型例子**：`presets/generic`、`presets/example-company`

### 私有 preset（gitignored）

如果 preset 内容含敏感线索（暴露内部代号、内部分支名、内部 task ID 格式等），**不要 commit**：

1. 在 kit 仓库的 `.gitignore` 加上 `presets/<your-company>/`
2. 把内容放在团队的安全分发渠道：内网私库、加密 gist、共享盘、密码管理器
3. 团队成员第一次设置时手工放置 `presets/<your-company>/`
4. `load-preset.js` 在 `presets/<your-company>/` 不存在时会自动回退到 `generic`，所以**没有这个目录的机器仍能正常工作**

### `extends` 链

```json
{ "name": "acme-strict", "extends": "acme-base", "files": {...} }
```

`acme-strict` 先加载 `acme-base` 的所有字段，再用自己的字段**整体覆盖**（顶层 merge，不深度合并）。当前 loader 实现 1+ 级 extends，有循环检测（防止 a→b→a）。

## 与服务端 hook 的关系

如果你的 GitLab/GitHub server hook 已经强制了某些规则（如「只 root 能合 master」），客户端 preset 不需要重复实现 —— 让服务端拒就行。客户端 preset 的价值是：

1. **Fast feedback**：在 commit 时立即拒绝（如 `feat` on release-*），不等到 push 才知道
2. **AI-specific concerns**：Co-Authored-By 这类服务端不管的事
3. **MR 引导**：提示 AI "这个分支只能 MR"，避免无效尝试
4. **离线/无服务端场景**：开源项目、个人项目没有强制 hook 服务端

`branch-policy.json` 中的 `single_branch_constraints` / `fork_constraints` 通常**只声明给文档看**，不在客户端强制（成本高、易误判）。

## 调试

```bash
# 查看 active preset
node scripts/hooks/load-preset.js

# 强制加载某 preset
HARNESS_PRESET=example-company node scripts/hooks/load-preset.js

# 模拟 hook 输入测试 branch-policy-guard
echo '{"tool_input":{"command":"git push origin feature-foo"}}' \
  | HARNESS_PRESET=example-company node scripts/hooks/branch-policy-guard.js
echo "exit=$?"
```

## 历史与设计取舍

- **为什么不用 .yaml**：Node 原生不支持 YAML，多一个依赖对一个 hook 项目不值。JSON 够用。
- **为什么 `merge_only_branches` 用 glob 不用正则**：`feature-*` 比 `^feature-.*$` 直观，团队成员不需要正则知识。底层用 glob→regex 转换。
- **为什么 fallback 到 generic 而不是 fail-loud**：让"AI 拉到没有公司私有 preset 的机器"也能干活，只是规则宽松。fail-loud 会让团队新成员第一次 clone 后所有 commit 都拒绝，体验差。
- **为什么 subject_regex 是 warn 而不是 block**：与现有 `commit-check.js` 风格一致（Co-Authored-By 也是 warn）。block 留给 type_blocked_on_branch 这种"明确错误"的情况。

## 不在本系统范围

下列工作**不在 simple-harness-kit 范围**，应在外部仓维护：

- 团队成员的实名 mailmap
- 跨机器 commit 历史改写（如本地 → GitHub 公开镜像的脱敏）
- VPS / Dropbox / 私有桥接管道
- 真实公司私有 preset 的实际内容

simple-harness-kit 提供的是**通用 preset 机制**；具体公司规则数据是各团队自己的事。

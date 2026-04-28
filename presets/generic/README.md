# Preset: generic

默认 preset，等价于 `methodology/12-commit-standards.md` 中描述的通用规则：

- **Commit 格式**: Conventional Commits (`feat: ...`, `fix(scope): ...`)
- **Subject 长度**: ≤ 72 字符
- **AI commits 必须含 Co-Authored-By**
- **分支策略**: 无限制，所有分支可直接 push

## 何时使用

- 新建项目，没有公司特定的 commit/分支约束
- 个人项目、开源项目
- 作为其他 preset 的 `extends` 基础

## 如何切换到其他 preset

在 `.harness.local.json` 中：

```json
{
  "preset": "example-company"
}
```

或运行时覆盖：

```bash
HARNESS_PRESET=example-company node scripts/hooks/load-preset.js
```

详见 `methodology/19-company-presets.md`。

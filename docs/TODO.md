# Harness Kit TODO

## 当前发版（v0.9.0 草案，未打 tag）

- [x] ~~**Preset 系统**~~ — `presets/{generic,example-company}` + load-preset.js + branch-policy-guard.js + commit-check.js 接 preset + methodology/19 (commits b4895bb / 90c78a7 / 5f8a283)
- [ ] **v0.9.0 release 收尾**：等切回 master 后 `tests/pre-release-check.sh` 全绿 → tag → push → 同步 dogfooding workspace
- [ ] **`tests/hook-scenarios/branch-policy-guard.json`** — 新 hook 还没有 scenario 覆盖（手动验证已通过 5/5：master / --all / feature-* block；personal / 非 push 放行）
- [ ] **`tests/run.js` stage-guard symlink 测试在 Windows 缺 SeCreateSymbolicLinkPrivilege 时崩**：当前 `pre-release-check.sh` 在 Win 非管理员 / 未开 Developer Mode 的机器上无法跑完，需要 setupTempDir 检测 symlink 权限 fallback 跳过
- [ ] **example-company preset → company-private 实物 preset**（属于私有 overlay repo 的事，跨仓库工作）

## 近期

- [x] ~~**Hook 检查更新机制**~~ — 所有 Hook 添加 @version 注释，update.sh 支持版本比对 + --dry-run (v0.6.1)
- [x] ~~**Skill 便捷分发**~~ — install.sh 已实现一键安装全部 Skills
- [ ] **低测试覆盖项目 TDD 策略 (M-12)** — 方向：先用框架帮项目搭建测试基础设施（以 Planka 为实战），再基于实战经验更新方法论
- [ ] **e2e 环境搭建指南 (M-13)** — init 时检测 docker-compose 等配置，生成快速启动指南
- [x] ~~**Release 时同步模板到本项目**~~ — 已通过删除 templates/hooks/ 解决，scripts/hooks/ 为唯一源 (v0.6.1)
- [x] ~~**Codex init AGENTS.md 未落盘**~~ — init-prompt.md 补注 codex 必须使用 `--full-auto` 或 `-s workspace-write` (v0.6.1)
- [x] ~~**E2E 验收 agent 的 CWD 清理**~~ — 工作区 (harness-dogfood) 的 .claude/settings.json Hook 命令添加 find-root 前置脚本，从任意 CWD 自动定位项目根 (v0.6.1)

## 持续学习改进（设计文档: docs/design/continuous-learning-improvements.md）

- [ ] 三级 instinct 粒度（用户→项目→组织）— 需要多用户场景验证
- [x] 周期性分析报告 — `--periodic N` 已实现 (v0.3.x)
- [x] 稳定 instinct → Rule 自动晋升 — `--promote` 已实现 (v0.3.x)

## 远期

- [ ] Instinct → Constraint 打通

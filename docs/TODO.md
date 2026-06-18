# Harness Kit TODO

## 当前发版（v0.11.0 Phase 2 草案，未打 tag）

- [x] ~~**Phase 2 Quality Engineering Gate 文档草案**~~ — `docs/quality-engineering-gate.md` + `docs/phase2-quality-gate/` + `docs/release-notes/v0.11.0.md`
- [x] ~~**交付时本地门禁刷新**~~ — 2026-06-08 运行 `node tests/template-integrity.js`：exit 0，30 passed, 0 failed；`node tests/run.js`：exit 0，218 passed, 0 failed，scripted matrix 14 PASS / 3 SKIP / 0 FAIL
- [ ] **最终 tag 前刷新 release evidence**：在目标发版机器重跑 `node tests/run.js`，并把 `docs/release-notes/v0.11.0.md` / `CHANGELOG.md` 的数字同步到最终输出
- [ ] **真实 OSS / browser dogfood 证据**：`tests/scripts/17/18/19` 默认环境可能 SKIP；只有满足各自依赖条件时才能写成 PASS
- [ ] **Codex runtime smoke**：当前 `codex exec` smoke 只能报告 `DEGRADED / SKIP`，不能作为 release-ready runtime PASS；release tag 仍要求 runtime PASS
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

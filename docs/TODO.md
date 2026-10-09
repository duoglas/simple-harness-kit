# Harness Kit TODO

## 当前发布收尾（v0.15.1 补丁候选）

- [x] v0.15.0 代码与 tag 已推送；保留原 tag，不重打。
- [x] 配置项目 Codex hooks 与精确信任，并用真实会话证明 hook 派发。
- [x] 双独立发布复审发现准入和 Git 目标绑定缺口，登记 VH-38。
- [ ] 修复全部已复现问题并完成旧实现失败、新实现通过的回归。
- [ ] 落实显式 N/A 契约，并修复远端版本证据绑定及 SKIP 汇总；关键发布证明继续必须 PASS。
- [ ] 冻结补丁候选，完成专项 E2E、完整发布门禁和双独立复审。
- [ ] 核对证据后关闭两项旧任务，发布 v0.15.1 与对应说明。
- [ ] Public 仓 CI workflow 接入单独排期；本机结果不等于远端 CI。

当前任务见 [任务台账](tasks/INDEX.md)，历史 v0.11.0 验证数字见该版本 release notes，不能作为当前准出证据。

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

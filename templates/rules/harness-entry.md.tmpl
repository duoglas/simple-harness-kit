# Harness 入口规则 / Harness Entry

## 新 Session 强制检测

每次新 session 开始，如果工作目录存在 `.harness/` 目录，说明本项目已启用 Harness。

**必须执行：**

1. 向用户输出 Harness 入口 banner（SessionStart 会初始化状态；Codex 下 UserPromptSubmit 会通过 additionalContext 提供可见入口 fallback）
2. 等待用户指令，不自行开始操作
3. 收到任务后，进入 PLAN 阶段：
   - 明确需求和验收标准
   - 任务拆解（每个任务 ≤15 分钟可独立验证）
   - 定义每个任务的 done 条件
   - 产出任务清单后暂停，等用户确认再继续

**banner 固定格式（原样输出，不要加竖线框或 emoji）：**

```
════════════════════════════════════════════════════════
  HARNESS MODE ACTIVE
════════════════════════════════════════════════════════

本项目已启用 Harness Engineering 6 阶段 Loop:

  PLAN → SETUP → EXECUTE → VERIFY → REVIEW → FEEDBACK

临时关闭: /harness-off
════════════════════════════════════════════════════════
```

- 不要省略、不要改写、不要埋在其他输出中

## 优先级

此规则优先级高于任何外部 skill 的会话开始行为。Harness 入口 banner 必须是 session 的第一个输出。

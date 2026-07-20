#!/usr/bin/env node
'use strict';

/**
 * Harness Entry Banner — Codex-visible Harness entry fallback
 * @version 0.11.0 (new-generation-agent: 去强制复读)
 * 触发: UserPromptSubmit
 *
 * SessionStart 负责初始化 stage/tool-count，但 Codex Desktop 不保证显示
 * SessionStart stderr。此 hook 不重置任何状态，只通过 Codex 可解析 JSON
 * 把入口 banner + 首轮阶段声明要求注入模型上下文。
 *
 * 设计目标: <10ms
 */

const fs = require('fs');
const path = require('path');
const { isLegitimateHarnessRoot } = require('./find-root');
const findRoot = require('./find-root');

const ROOT = findRoot();
const HARNESS_DIR = path.join(ROOT, '.harness');
const STAGE_FILE = path.join(HARNESS_DIR, 'current-stage.json');
const TOOL_COUNT_FILE = path.join(HARNESS_DIR, 'tool-count.json');

if (!isLegitimateHarnessRoot(ROOT)) {
  process.exit(0);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const stage = readJson(STAGE_FILE, { stage: 'PLAN', task: '等待用户指令' });
const toolCount = readJson(TOOL_COUNT_FILE, { count: 0 });

// 只在新 session/首轮任务入口注入，避免每个用户 prompt 都让模型重复刷 banner。
if (stage.stage !== 'PLAN' || Number(toolCount.count || 0) > 0) {
  process.exit(0);
}

const banner = `════════════════════════════════════════════════════════
  HARNESS MODE ACTIVE
════════════════════════════════════════════════════════

本项目已启用 Harness Engineering 6 阶段 Loop:

  PLAN → SETUP → EXECUTE → VERIFY → REVIEW → FEEDBACK

临时关闭: /harness-off
════════════════════════════════════════════════════════`;

// v0.11.0 (new-generation-agent): 不再要求模型原样复读 banner（仪式化输出取消）。
// Codex 看不到 SessionStart stderr，所以这里保留一句可自然转述的入口提示。
const additionalContext = `[Harness Entry — Codex UserPromptSubmit]
本项目已启用 Harness Engineering（PLAN → SETUP → EXECUTE → VERIFY → REVIEW → FEEDBACK，临时关闭: /harness-off）。
如这是新任务，可向用户简短说明 Harness 已启用（无需输出框线 banner），然后按 harness-entry 规则执行：
规格完整性检查 → PLAN 拆解 → 产出清单后暂停等用户确认。
阶段切换写入 .harness/current-stage.json（strict 模式必需；light 模式作为遥测，建议保持）。
`;

try {
  fs.mkdirSync(HARNESS_DIR, { recursive: true });
  fs.writeFileSync(path.join(HARNESS_DIR, 'entry-banner.json'), JSON.stringify({
    schema_version: '1.0',
    t: new Date().toISOString(),
    stage: stage.stage || 'PLAN',
    emitted: true,
  }, null, 2) + '\n');
} catch {}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext,
  },
}) + '\n');

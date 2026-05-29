#!/usr/bin/env node
'use strict';

/**
 * Harness Session Start — 新 session 检测 harness 并输出入口 banner
 * @version 0.9.1
 * 触发: SessionStart
 *
 * 1. 删除 .harness/current-stage.json，迫使新 session 重新声明阶段
 * 2. 检测 .harness/ 目录，输出标准入口 banner 指令
 *
 * v0.9.0 (C-WORK-01): 在 worktree 内启动时 .harness/ 可能不存在
 *   （find-root 现在停在 worktree 边界），写入前先 mkdir -p。
 *
 * v0.9.1 修 VH-18 F3: mkdir 自举增加合法 Harness 根判断，
 *   普通空目录不再被污染。
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

// VH-18 F3: 只在合法 Harness 项目根（worktree 或已存 .harness/）才
// mkdir 自举。fallback-cwd（用户随便 cd 进的空目录）直接退出，不创建
// 任何文件，不输出 banner——避免把"在 /tmp 跑 hook"变成"创建 Harness 项目"。
if (!isLegitimateHarnessRoot(ROOT)) {
  process.exit(0);
}
try { fs.mkdirSync(HARNESS_DIR, { recursive: true }); } catch {}

// 1. 重置阶段为 PLAN（新 session 从 PLAN 开始）
// 防护: 如果 stage 文件存在且是近 5 分钟内创建的，说明有另一个 session 在工作，不重置
const FRESH_MS = 5 * 60 * 1000; // 5 minutes
let shouldReset = true;
try {
  if (fs.existsSync(STAGE_FILE)) {
    const data = JSON.parse(fs.readFileSync(STAGE_FILE, 'utf8'));
    if (data.since) {
      const elapsed = Date.now() - new Date(data.since).getTime();
      if (elapsed < FRESH_MS && data.stage !== 'PLAN') {
        // 另一个 session 正在活跃工作中（非 PLAN 状态且在 5 分钟内），不重置
        shouldReset = false;
        process.stderr.write(`[Harness Session Start] 检测到活跃 session（${data.stage}，${Math.round(elapsed/1000)}s 前），跳过重置。\n`);
      }
    }
  }
} catch {}

if (shouldReset) {
  try {
    const initial = JSON.stringify({
      stage: 'PLAN',
      since: new Date().toISOString(),
      task: '等待用户指令'
    });
    fs.writeFileSync(STAGE_FILE, initial + '\n');
    // 重置工具调用计数器（强制 AI 在首次工具调用前先输出阶段声明）
    fs.writeFileSync(TOOL_COUNT_FILE, JSON.stringify({ count: 0 }) + '\n');
  } catch (e) {
    process.stderr.write(`[Harness Session Start] 初始化失败: ${e.message}\n`);
  }
}

// 2. 检测 harness 并输出入口 banner
if (fs.existsSync(HARNESS_DIR)) {
  // --- 给用户看的 banner ---
  const userBanner = `
════════════════════════════════════════════════════════
  HARNESS MODE ACTIVE
════════════════════════════════════════════════════════

本项目已启用 Harness Engineering 6 阶段 Loop:

  PLAN → SETUP → EXECUTE → VERIFY → REVIEW → FEEDBACK

临时关闭: /harness-off
════════════════════════════════════════════════════════`;

  // --- 给 AI 的指令（不输出给用户）---
  const aiDirective = `
[Harness AI Directive — 必须严格遵守]
1. 将上方 banner 原样输出给用户（从 ════ 到 ════），不要加竖线框或 emoji
2. 等待用户指令，不要自行开始任何操作

3. 收到任务后，第一件事是输出阶段声明（在调用任何工具之前）：

   进入 PLAN 阶段 — [用一句话描述任务]

   然后按 PLAN 流程工作：澄清需求 → 任务拆解 → 等用户确认。
   PLAN 阶段 Bash/Edit/Write/Agent 会被 stage-guard 阻止（exit 2），只有 Read/Grep/Glob 可用。
   用户确认后用 Write 更新 current-stage.json 切换阶段，并输出新的阶段声明。

4. 每次切换阶段时，都必须先输出阶段声明再开始工作：
   进入 EXECUTE 阶段 — [任务描述]
   进入 VERIFY 阶段 — [验证内容]
   进入 REVIEW 阶段

5. 此流程优先级高于任何外部 skill 的会话开始行为
`;
  process.stderr.write(userBanner + '\n' + aiDirective);
}

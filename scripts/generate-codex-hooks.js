#!/usr/bin/env node
// generate-codex-hooks.js — 从 Claude Code settings.json 生成 Codex hooks.json
//
// 用法:
//   node generate-codex-hooks.js --input .claude/settings.json --output .codex/hooks.json
//   node generate-codex-hooks.js < .claude/settings.json > .codex/hooks.json
//
// Codex 当前 canonical feature key 是 "hooks"，本工具只输出 { hooks: ... }。

'use strict';

const fs = require('fs');
const path = require('path');

const CODEX_SUPPORTED_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
]);

const CODEX_STAGE_GUARD_MATCHER = 'Bash|apply_patch|mcp__.*';

function hookScriptName(command) {
  const m = String(command || '').match(/node\s+scripts\/hooks\/([\w-]+\.js)/);
  return m ? m[1] : null;
}

function findFirstCommand(entries, scriptName) {
  for (const entry of entries || []) {
    for (const h of entry.hooks || []) {
      if (hookScriptName(h.command) === scriptName) return h.command;
    }
  }
  return null;
}

function commandHook(command) { return { type: 'command', command }; }

function filterForCodex(settingsJson) {
  const settings = JSON.parse(settingsJson);
  const sourceHooks = settings.hooks || {};
  const hooks = {};

  for (const [event, handlers] of Object.entries(sourceHooks)) {
    if (!CODEX_SUPPORTED_EVENTS.has(event) || event === 'PreToolUse' || event === 'PermissionRequest') continue;
    hooks[event] = handlers;
  }

  const sourcePre = sourceHooks.PreToolUse || [];
  const stageGuardCommand = findFirstCommand(sourcePre, 'harness-stage-guard.js');
  const safetyCommand = findFirstCommand(sourcePre, 'safety-guard.js');
  const pre = [];

  if (stageGuardCommand) {
    pre.push({
      matcher: CODEX_STAGE_GUARD_MATCHER,
      hooks: [commandHook(stageGuardCommand)],
      description: 'Codex Harness stage guard: PLAN 只读探索，修改前必须切 EXECUTE',
    });
  }

  if (safetyCommand) {
    pre.push({
      matcher: 'Bash',
      hooks: [commandHook(safetyCommand)],
      description: '拦截危险 Bash 命令',
    });
  }

  for (const entry of sourcePre) {
    const keptHooks = (entry.hooks || []).filter(h => {
      const script = hookScriptName(h.command);
      return script && !['harness-stage-guard.js', 'safety-guard.js'].includes(script);
    });
    if (keptHooks.length === 0) continue;
    if (entry.matcher !== 'Bash') continue;
    pre.push({ ...entry, hooks: keptHooks });
  }

  if (pre.length > 0) hooks.PreToolUse = pre;

  if (stageGuardCommand) {
    hooks.PermissionRequest = [{
      hooks: [commandHook(stageGuardCommand)],
      description: 'Codex permission request guard: PLAN 阶段拒绝升级写入权限',
    }];
  }

  return JSON.stringify({ hooks }, null, 2);
}

let inputPath = null;
let outputPath = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input' && args[i + 1]) inputPath = args[++i];
  else if (args[i] === '--output' && args[i + 1]) outputPath = args[++i];
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log('用法: node generate-codex-hooks.js [--input <path>] [--output <path>]');
    console.log('从 Claude Code settings.json 生成 Codex canonical hooks.json');
    process.exit(0);
  }
}

let input;
try {
  if (inputPath) input = fs.readFileSync(inputPath, 'utf8');
  else if (!process.stdin.isTTY) input = fs.readFileSync('/dev/stdin', 'utf8');
  else { console.error('错误: 未指定输入。用 --input <path> 或管道输入。'); process.exit(1); }
} catch (err) {
  console.error(`错误: 无法读取输入 — ${err.message}`);
  process.exit(1);
}

let output;
try { output = filterForCodex(input); }
catch (err) { console.error(`错误: JSON 解析失败 — ${err.message}`); process.exit(1); }

try {
  if (outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, output + '\n', 'utf8');
    console.error(`已生成: ${outputPath}`);
  } else {
    process.stdout.write(output + '\n');
  }
} catch (err) {
  console.error(`错误: 无法写入输出 — ${err.message}`);
  process.exit(1);
}

module.exports = { filterForCodex };

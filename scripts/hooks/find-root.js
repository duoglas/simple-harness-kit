#!/usr/bin/env node
'use strict';

/**
 * find-root.js — 从 CWD 向上查找项目根目录（包含 .harness/ 的目录）
 * @version 0.9.1
 *
 * 解决问题: Hook 脚本用相对路径访问 .harness/ 等文件，但 process.cwd()
 * 可能在子目录（如 cd 到子仓库做 git 操作），导致路径解析错误。
 *
 * v0.9.0 新增 (C-WORK-02): 检测 cwd 是否在 git worktree 内
 *   （路径形如 <main>/.claude/worktrees/<name>/...）。若是，必须停在
 *   worktree 边界返回该 worktree 路径，不再上探到主仓库。
 *
 * v0.9.1 修 VH-18:
 *   - 反斜杠归一化（Windows 兼容，F5）
 *   - 新增 isLegitimateHarnessRoot()：只在 worktree 或已存 .harness/ 时
 *     允许 hook mkdir，避免普通空目录被污染（F3）
 *
 * 用法:
 *   const findRoot = require('./find-root');
 *   const ROOT = findRoot();
 *   const stageFile = path.join(ROOT, '.harness/current-stage.json');
 *
 * 约束: C-HOOK-05, C-WORK-02
 */

const fs = require('fs');
const path = require('path');

// 检测路径是否在 worktree 内并返回 worktree 根。
// 匹配模式: <anything>/.claude/worktrees/<name>(/...)?
// 贪婪匹配自然处理嵌套场景（返回最内层 worktree 路径）。
// VH-18 F5: 反斜杠先归一化为正斜杠以支持 Windows 路径（如
//   `C:\repo\.claude\worktrees\foo\src` 也能匹配）。
function detectWorktreeRoot(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const normalized = cwd.replace(/\\/g, '/');
  const m = normalized.match(/^(.*\/\.claude\/worktrees\/[^/]+)(\/|$)/);
  return m ? m[1] : null;
}

// VH-18 F3: 判断给定 ROOT 是否是合法 Harness 项目根。
// hook 的 mkdir 自举只在这两种情况触发，避免 fallback-cwd 时把任意空
// 目录变成 Harness 项目。
function isLegitimateHarnessRoot(root) {
  if (!root || typeof root !== 'string') return false;
  // 1. worktree 模式：路径形如 */.claude/worktrees/<name>(/...)?
  if (detectWorktreeRoot(root) === root) return true;
  // 2. .harness/ 已存在：本来就是 Harness 项目根
  try {
    return fs.statSync(path.join(root, '.harness')).isDirectory();
  } catch {
    return false;
  }
}

function findProjectRoot() {
  const cwd = process.cwd();

  // C-WORK-02: worktree 边界优先于 .harness/ 上探
  const wtRoot = detectWorktreeRoot(cwd);
  if (wtRoot) return wtRoot;

  let dir = cwd;
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.harness'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 最后检查根目录
  if (fs.existsSync(path.join(dir, '.harness'))) {
    return dir;
  }

  // fallback: 返回 CWD
  return cwd;
}

module.exports = findProjectRoot;
module.exports.detectWorktreeRoot = detectWorktreeRoot;
module.exports.isLegitimateHarnessRoot = isLegitimateHarnessRoot;

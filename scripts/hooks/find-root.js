#!/usr/bin/env node
'use strict';

/**
 * find-root.js — 从 CWD 向上查找项目根目录（包含 .harness/ 的目录）
 * @version 0.9.0
 *
 * 解决问题: Hook 脚本用相对路径访问 .harness/ 等文件，但 process.cwd()
 * 可能在子目录（如 cd 到子仓库做 git 操作），导致路径解析错误。
 *
 * v0.9.0 新增 (C-WORK-02): 检测 cwd 是否在 git worktree 内
 *   （路径形如 <main>/.claude/worktrees/<name>/...）。若是，必须停在
 *   worktree 边界返回该 worktree 路径，不再上探到主仓库。否则会出现：
 *   - worktree 内 hook 写到主仓库 .harness/，多 worktree 互相踩
 *   - 与 Claude Code bg-isolation（要求 bg session 写入落在 worktree 内）冲突
 *   .harness/ 目录在 worktree 内不存在时由 stage-guard/session-start 自动 mkdir。
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
function detectWorktreeRoot(cwd) {
  const m = cwd.match(/^(.*\/\.claude\/worktrees\/[^/]+)(\/|$)/);
  return m ? m[1] : null;
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

#!/usr/bin/env node
/**
 * scripts/ci/validate-no-personal-paths.js
 *
 * 扫描 git 跟踪的文本文件里的本机绝对路径泄漏。
 * 检测模式:
 *   /Users/<name>  — macOS
 *   /home/<name>   — Linux（CI 跑在 ubuntu-latest，覆盖必要）
 *   C:\Users\<name> — Windows
 *
 * 放行占位符用户名（example/me/user/username/you/yourname/yourusername/your-username）。
 *
 * EXEMPT_PREFIXES 列出的目录整体豁免——证据/fixture/对照实验材料里允许出现植入的"假
 * 泄漏"以测试 validator 本身，这些不该被产品级扫描看到。
 *
 * 发现真实泄漏时退出码非 0、打印中文提示；通过时退出码 0。
 *
 * 用法:
 *   node scripts/ci/validate-no-personal-paths.js [扫描根目录]
 *
 * 第一个位置参数为扫描根目录（便于自动化测试），默认仓库根。
 *
 * 改编自 ECC（everything-claude-code）同名脚本。约束登记: C-CI-01..06 / JC-08。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 扫描根目录：优先取命令行参数，回退到仓库根
const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '../..');

// 放行的占位符用户名（全部小写比较）
const PLACEHOLDER_USERNAMES = new Set([
  'example',
  'me',
  'user',
  'username',
  'you',
  'yourname',
  'yourusername',
  'your-username',
]);

// 整体豁免的目录前缀（相对扫描根）。证据/对照实验目录可能含植入的假泄漏样本
// 用来测试 validator 本身的检测能力——这些不能作为产品级扫描的命中。
const EXEMPT_PREFIXES = [
  'experiments/',
];

// 三种本机绝对路径模式
const POSIX_USER_RE = /\/Users\/([a-zA-Z][a-zA-Z0-9._-]*)/g;     // macOS
const LINUX_USER_RE = /\/home\/([a-zA-Z][a-zA-Z0-9._-]*)/g;       // Linux
const WIN_USER_RE   = /C:\\Users\\([a-zA-Z][a-zA-Z0-9._-]*)/gi;   // Windows

/**
 * 扫描内容，返回泄漏路径列表。
 * @param {string} content 文件文本
 * @returns {string[]} 命中的真实路径片段
 */
function findLeaks(content) {
  const leaks = [];
  for (const pattern of [POSIX_USER_RE, LINUX_USER_RE, WIN_USER_RE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const username = match[1];
      if (PLACEHOLDER_USERNAMES.has(username.toLowerCase())) continue;
      leaks.push(match[0]);
    }
  }
  return leaks;
}

/**
 * 获取 git 跟踪的文本文件列表；git 不可用时回退到递归遍历文件系统。
 */
function getTrackedFiles(root) {
  try {
    const output = execSync('git ls-files', { cwd: root, encoding: 'utf8' });
    return output.split('\n').filter(Boolean).map(f => path.join(root, f));
  } catch {
    const files = [];
    function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git') continue;
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    }
    walk(root);
    return files;
  }
}

// 仅扫描文本文件（按扩展名过滤）
const TEXT_FILE_RE = /\.(md|txt|json|js|ts|sh|bash|zsh|yml|yaml|toml|ini|cfg|conf|html|css|tmpl)$/i;

function relUnix(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function isExempt(relPath) {
  return EXEMPT_PREFIXES.some(prefix => relPath.startsWith(prefix));
}

const files = getTrackedFiles(ROOT).filter(f => TEXT_FILE_RE.test(f));

let failures = 0;

for (const file of files) {
  const rel = relUnix(file);
  if (isExempt(rel)) continue;

  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const leak of findLeaks(content)) {
    console.error(`错误: 发现个人绝对路径 "${leak}" 位于 ${rel}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`\n共发现 ${failures} 处个人路径泄漏，请替换为占位符或相对路径。`);
  process.exit(1);
}

console.log('通过: 未发现个人绝对路径泄漏。');

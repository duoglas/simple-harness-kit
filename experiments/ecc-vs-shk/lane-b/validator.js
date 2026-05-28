#!/usr/bin/env node
/**
 * scripts/ci/validate-no-personal-paths.js
 *
 * 扫描 git 跟踪的文本文件里的本机绝对路径泄漏。
 * 检测模式: /Users/<name>（macOS）和 C:\Users\<name>（Windows）。
 * 放行占位符用户名（example/me/user/username/you/yourname/your-username 等）。
 * 对合法 GitHub URL（如 github.com/duoglas/...）不误报。
 * 发现真实泄漏时退出码非 0，并打印提示。
 *
 * 用法:
 *   node scripts/ci/validate-no-personal-paths.js [扫描根目录]
 *
 * 默认扫描根目录为脚本所在位置向上两级（仓库根）。
 * 传入第一个位置参数可覆盖（便于自动化测试）。
 *
 * 改编自 ECC（everything-claude-code）同名脚本。
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

// 匹配 /Users/<name> 的正则（macOS 路径）
const POSIX_USER_RE = /\/Users\/([a-zA-Z][a-zA-Z0-9._-]*)/g;
// 匹配 C:\Users\<name> 的正则（Windows 路径）
const WIN_USER_RE = /C:\\Users\\([a-zA-Z][a-zA-Z0-9._-]*)/gi;

// 判断某个 /Users/<name> 命中是否来自合法 GitHub URL
// 例: https://github.com/duoglas/simple-harness-kit 不应报错
// 这类 URL 中不会出现 /Users/，GitHub org/user 名不走 /Users/ 路径
// 所以主要误报来源是：URL 中的路径段恰好包含 "Users"
// 例：https://somehost/Users/foo/bar — 但这类不在 github.com 路径里
// 实际上 github.com URL 格式为 github.com/<owner>/<repo>，不含 /Users/
// 为安全起见：检查匹配前后文，若匹配紧跟在 "github.com" 或 "http(s)://" 域名之后则豁免
function isGitHubUrl(content, matchIndex) {
  // 取匹配前 50 个字符，检查是否包含 github.com 或类似 URL 域名前缀
  const prefix = content.slice(Math.max(0, matchIndex - 50), matchIndex);
  return /github\.com\s*$/.test(prefix) || /https?:\/\/[^\s/]*$/.test(prefix);
}

/**
 * 扫描内容，返回泄漏路径列表。
 * content: 文件文本内容
 */
function findLeaks(content) {
  const leaks = [];

  for (const pattern of [POSIX_USER_RE, WIN_USER_RE]) {
    pattern.lastIndex = 0;
    let match;

    while ((match = pattern.exec(content)) !== null) {
      const username = match[1];
      // 放行占位符
      if (PLACEHOLDER_USERNAMES.has(username.toLowerCase())) continue;
      // 放行 GitHub URL 上下文（/Users/ 不出现在合法 github.com URL 中，
      // 但保留此检查以备将来误报场景）
      if (isGitHubUrl(content, match.index)) continue;
      leaks.push(match[0]);
    }
  }

  return leaks;
}

/**
 * 获取 git 跟踪的文本文件列表。
 * 若 git 不可用则回退到递归遍历文件系统。
 */
function getTrackedFiles(root) {
  try {
    const output = execSync('git ls-files', { cwd: root, encoding: 'utf8' });
    return output
      .split('\n')
      .filter(Boolean)
      .map(f => path.join(root, f));
  } catch {
    // git 不可用时的回退：递归遍历
    const files = [];
    function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git') continue;
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else {
          files.push(full);
        }
      }
    }
    walk(root);
    return files;
  }
}

// 仅扫描文本文件（按扩展名过滤）
const TEXT_FILE_RE = /\.(md|txt|json|js|ts|sh|bash|zsh|yml|yaml|toml|ini|cfg|conf|html|css|tmpl)$/i;

const files = getTrackedFiles(ROOT).filter(f => TEXT_FILE_RE.test(f));

let failures = 0;

for (const file of files) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    // 二进制文件或读取失败，跳过
    continue;
  }

  const leaks = findLeaks(content);
  const rel = path.relative(ROOT, file).split(path.sep).join('/');

  for (const leak of leaks) {
    console.error(`错误: 发现个人绝对路径 "${leak}" 位于 ${rel}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`\n共发现 ${failures} 处个人路径泄漏，请替换为占位符或相对路径。`);
  process.exit(1);
}

console.log('通过: 未发现个人绝对路径泄漏。');

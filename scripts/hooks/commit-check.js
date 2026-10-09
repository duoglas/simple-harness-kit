#!/usr/bin/env node
'use strict';

/**
 * Commit Check Hook — 提交前检查三件事:
 * @version 0.9.1
 * 1. AI session 的 commit 必须包含 Co-Authored-By（warn）
 * 2. commit subject 必须匹配 active preset 的 subject_regex（warn）
 * 3. REVIEW 阶段检查是否有未提交变更（配合 verification-gate）
 *
 * 触发: PreToolUse:Bash
 */

const { execSync } = require('child_process');
const { loadPreset } = require('./load-preset');
const MAX_STDIN = 1048576; // 1 MB
const GIT_STATUS_TIMEOUT_MS = 5000;

// 允许的工具名清单与 methodology/12 表格同步，缺少某工具只需在这里加
const ALLOWED_TOOLS = [
  'Claude Code',
  'Codex CLI',
  'Cursor',
  'Windsurf',
  'GitHub Copilot',
  'OpenCode',
];
const TOOL_ALT = ALLOWED_TOOLS
  .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
// 正则：Co-Authored-By: <Tool Name> (<model-id>) <type>
//   - 模型 ID 允许字母/数字/点/连字符/下划线，括号必选
//   - 第三段 type 必选，仅 code/test/fix（commit 内容语义维度）
//   - 禁止尾部 <email>（老模板产物）
const VALID_CO_AUTHOR_LINE = new RegExp(`^Co-Authored-By:\\s+(?:${TOOL_ALT})\\s+\\([\\w.\\-]+\\)\\s+(?:code|test|fix)\\s*$`);
const CO_AUTHOR_FORMAT = 'Co-Authored-By: {工具名} ({模型ID}) {code|test|fix}';
const CO_AUTHOR_EXAMPLE = 'Co-Authored-By: Claude Code (claude-opus-4-6) code';

// 单 regex 覆盖 -m "..." / -m '...' / --message="..." / --message='...' / --message=bare
// 捕获组语义：
//   2 = -m "..." 内容
//   3 = -m '...' 内容
//   5 = --message="..." 内容
//   6 = --message='...' 内容
//   7 = --message=bare 内容
const MESSAGE_ARG_RE = /(?:^|\s)(?:-m\s+("([\s\S]*?)(?<!\\)"|'([\s\S]*?)')|--message=("([^"]*)"|'([^']*)'|(\S+)))/g;
const MESSAGE_GROUP = { mDouble: 2, mSingle: 3, messageDouble: 5, messageSingle: 6, messageBare: 7 };
const MESSAGE_GROUPS = Object.values(MESSAGE_GROUP);

/**
 * 从命令中提取 commit message。
 * VH-18 F2 / R2-2: 与 git 一致——多个 -m / --message= 之间用 "\n\n" 拼接
 *   （git 的实际行为）。旧代码只取第一个 -m → 误判缺 Co-Authored-By；
 *   v1 分 3 趟 regex（双引、单引、--message=）顺序错乱，混用引号时
 *   `git commit -m 'subj' -m "trailer"` 拼成 `trailer\n\nsubj`，
 *   subject 被识别成 trailer。
 *   v2 用单个全局 regex 一次扫所有 token，按 match.index
 *   自然顺序迭代，参数顺序 == git 实际语义。
 * 覆盖顺序：heredoc (取首段) → 所有 -m / --message= 按出现顺序拼接
 */
function extractMessage(cmd) {
  const heredoc = cmd.match(/<<['"]?EOF([\s\S]*?)EOF/);
  if (heredoc && heredoc[1]) {
    return heredoc[1];
  }
  const segs = [];
  for (const mm of cmd.matchAll(MESSAGE_ARG_RE)) {
    const group = MESSAGE_GROUPS.find(g => mm[g] !== undefined);
    segs.push(group === undefined ? '' : mm[group]);
  }
  return segs.join('\n\n');
}

function compileOrNull(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * 检查 2: subject 匹配 active preset's subject_regex (warn, opt-in)
 * 仅在用户**主动**选了 preset 时校验（HARNESS_PRESET env / .harness.local.json
 * / .claude/settings.json `harness.preset`）。默认 fallback 到 generic
 * 的用户体验"原方式"，不应被新检查打扰（back-compat for v0.8.x → v0.9.0）。
 */
function checkSubject(subject) {
  const preset = loadPreset();
  const format = preset.commit_format || {};
  if (preset.source === 'default' || !format.subject_regex) {
    return;
  }
  const regex = compileOrNull(format.subject_regex);
  if (!regex || !subject || regex.test(subject)) {
    return;
  }
  process.stderr.write([
    `[Commit Check] Subject 不符合 preset '${preset.name}' 格式。`,
    `→ 期望: ${format.format_description || format.subject_regex}`,
    `→ 实际: ${subject}`,
    `→ 示例: ${(format.examples || [])[0] || '(none)'}`,
    '→ 警告级别，不阻止执行。bypass: HARNESS_SKIP_GATE=1',
    '',
  ].join('\n'));
}

/**
 * 检查 1: Co-Authored-By 必须存在，每一行必须匹配 methodology/12-commit-standards.md 规定的格式。
 * 警告但不阻止，因为可能是纯人工 commit。
 */
function checkCoAuthor(msg) {
  if (!/Co-Authored-By:/i.test(msg)) {
    process.stderr.write([
      '[Commit Check] AI 辅助的 commit 缺少 Co-Authored-By 标注。',
      `→ 格式: ${CO_AUTHOR_FORMAT}`,
      `→ 例如: ${CO_AUTHOR_EXAMPLE}`,
      '→ 详见 methodology/12-commit-standards.md',
      '',
    ].join('\n'));
    return;
  }
  const badLines = msg.split('\n')
    .filter(line => /^Co-Authored-By:/i.test(line))
    .map(line => line.trim())
    .filter(line => !VALID_CO_AUTHOR_LINE.test(line));
  if (!badLines.length) {
    return;
  }
  process.stderr.write([
    '[Commit Check] Co-Authored-By 格式不符合 methodology/12-commit-standards.md。',
    `→ 标准格式: ${CO_AUTHOR_FORMAT}`,
    `→ 例如:    ${CO_AUTHOR_EXAMPLE}`,
    `→ 允许的工具名: ${ALLOWED_TOOLS.join(' / ')}`,
    '→ type 段（必填）: code（业务代码）/ test（测试）/ fix（修 bug）',
    '→ 禁止: 尾部 <email> / 括号外带空格 / 工具名与表格不符 / 缺第三段',
    '→ 不合规的行:',
    ...badLines.map(l => `    ${l}`),
    '→ 修正后重新 commit。警告级别，不阻止执行',
    '',
  ].join('\n'));
}

// === 检查 1+2: git commit 必须包含 Co-Authored-By + subject 匹配 preset ===
function checkCommitCommand(cmd) {
  const msg = extractMessage(cmd);
  if (!msg) {
    return;
  }
  const subject = (msg.split('\n').find(l => l.trim()) || '').trim();
  try {
    checkSubject(subject);
  } catch {
    // preset 读取失败时跳过 subject 校验
  }
  checkCoAuthor(msg);
}

// === 检查 3: 检测 REVIEW 相关操作时，提醒未提交变更 ===
function remindUncommitted() {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf8', timeout: GIT_STATUS_TIMEOUT_MS }).trim();
    if (!status) {
      return;
    }
    process.stderr.write([
      `[Commit Check] 有 ${status.split('\n').length} 个文件未提交。`,
      '→ REVIEW Gate 要求：代码已提交，commit message 引用 Constraint ID。',
      '→ 请先 commit 再进行交付复盘。',
      '',
    ].join('\n'));
  } catch {
    // 不在 git 仓库或 git 不可用时静默
  }
}

function handleInput(text) {
  const input = JSON.parse(text);
  const cmd = String(input.tool_input?.command || '');
  if (/git\s+commit/.test(cmd)) {
    checkCommitCommand(cmd);
  }
  if (/delivery|review|交付|复盘/.test(cmd)) {
    remindUncommitted();
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) {
    raw += chunk.substring(0, MAX_STDIN - raw.length);
  }
});

process.stdin.on('end', () => {
  try {
    handleInput(raw);
  } catch {
    // Hook 只做提醒，任何异常都不阻断命令
  }
  // stdout 保持为空（Codex 0.118.0 兼容，见 VH-13）
});

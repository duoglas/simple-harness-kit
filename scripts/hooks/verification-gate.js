#!/usr/bin/env node
'use strict';

/**
 * Verification Gate Hook — commit/push 前的阶段和证据检查
 * @version 0.15.1 (C-GATE-38: Git 上下文绑定与 applicability 证据校验)
 * 触发: PreToolUse:Bash
 *
 * 五重检查（[过程] 检查在 light 模式降级为提示；[证据] 检查两种模式一致保留）:
 * 1. [过程] commit 阶段检查: 必须在 VERIFY/REVIEW/FEEDBACK 才能 commit
 * 2. [证据] 证据时效性: 验证证据文件的 mtime 必须晚于 current-stage.json 的 since
 *    （light 下 stage 文件可选：无有效 since 时跳过时效锚点，但证据存在性/READY 仍强制）
 * 3. [过程] push 阶段检查: 必须在 REVIEW 才能 push
 * 4. [证据] 结构化 evidence 检查: .harness/verify-evidence.json 必须 overall=READY
 *    （含 e2e sufficiency / release blockers / 风险等级——均为证据类，两模式一致）
 * 5. [证据] 用户入口变更三模式证据（C-GATE-07, 仅 kit 仓库触发）:
 *    commit 涉及 install.sh / update.sh / init-prompt.md / SKILL.md
 *    / resources/init-prompt.md / generate-codex-hooks.js 时，
 *    verify-evidence.md 必须同时含 '独立 agent' / 'Claude Code' / 'Codex' 三个标记
 *
 * 证据存在性（未找到任何验证报告 → 阻断）属于 [证据] 类，两种模式一致保留。
 *
 * 环境变量 HARNESS_SKIP_GATE=1 临时跳过（需记录原因）。
 *
 * 设计目标: <50ms
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const findRoot = require('./find-root');
const guardMode = require('./guard-mode');
const ROOT = findRoot();

const MAX_STDIN = 1024 * 1024;

const STAGE_FILE = path.join(ROOT, '.harness/current-stage.json');
const COMMIT_ALLOWED_STAGES = ['VERIFY', 'REVIEW', 'FEEDBACK'];
const PUSH_ALLOWED_STAGES = ['REVIEW'];
// lib 可能在升级窗口内尚未同步到目标工程。只有“无 attestation 且未启用 strict”
// 的 legacy evidence 可兼容；已 attested 或 strict policy 必须 fail-closed。
let ledger = null;
try { ledger = require('../lib/task-ledger'); } catch { ledger = null; }
let evidenceAttestation = null;
try { evidenceAttestation = require('../lib/evidence-attestation'); } catch { evidenceAttestation = null; }
function evidenceJsonPath() {
  return ledger ? ledger.structuredEvidencePath(ROOT) : path.join(ROOT, '.harness/verify-evidence.json');
}
function evidencePathList() {
  return ledger ? ledger.evidenceSearchPaths(ROOT) : [
    path.join(ROOT, '.harness/verify-evidence.json'),
    path.join(ROOT, 'docs/verification-report.md'),
    path.join(ROOT, '.harness/last-verification.json'),
    path.join(ROOT, '.harness/verify-evidence.md'),
  ];
}

const RISK_ORDER = { low: 1, medium: 2, high: 3, release: 4 };

// ── C-GATE-07: kit-only 守门 ──
// kit 特征文件，用于判定"当前仓库是否 simple-harness-kit"。
// 非 kit 仓库（用户项目）跳过本层，旧行为不变。
const KIT_MARKER_FILE = path.join(ROOT, 'tests/template-integrity.js');

// 用户入口文件白名单：任一命中 → 要求三模式证据
const USER_ENTRY_FILES = [
  'install.sh',
  'update.sh',
  'upgrade.sh',
  'init-prompt.md',
  'skills/harness-init/SKILL.md',
  'skills/harness-init/resources/init-prompt.md',
  'scripts/generate-codex-hooks.js',
];

// 三模式证据标记（对应 C-GATE-04 三 runtime 模式）
const RUNTIME_MARKERS = ['独立 agent', 'Claude Code', 'Codex'];


function shellTokens(command) {
  const tokens = [];
  let token = '';
  let started = false;
  let state = 'normal';
  const push = () => { if (started) tokens.push({ type: 'word', value: token }); token = ''; started = false; };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (state === 'normal' && ch === '#' && !started) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i += 1;
      continue;
    }
    if (state === 'normal' && !/\s/.test(ch) && !';|&(){}<>'.includes(ch)) started = true;
    if (state === 'ansi') {
      if (ch === '\\') i += 1;
      else if (ch === "'") state = 'normal';
      continue;
    }
    if (state === 'single') {
      if (ch === "'") state = 'normal';
      else token += ch;
      continue;
    }
    if (state === 'double') {
      if (ch === '"') state = 'normal';
      else if (ch === '\\' && i + 1 < command.length && '$`"\\\n'.includes(command[i + 1])) token += command[++i];
      else {
        if (ch === '$' && /[A-Za-z_0-9@*#?$!\-{(\[+=~^]/.test(command[i + 1] || '')) token += SHELL_EXPANSION_WORD_MARKER;
        token += ch;
      }
      continue;
    }
    if (ch === '$' && command[i + 1] === "'") {
      token += SHELL_ENCODED_WORD_MARKER;
      state = 'ansi'; i += 1; continue;
    }
    if (ch === '$' && command[i + 1] === '"') {
      token += SHELL_ENCODED_WORD_MARKER;
      state = 'double'; i += 1; continue;
    }
    if ('?*+@!'.includes(ch) && command[i + 1] === '(') {
      token += SHELL_ENCODED_WORD_MARKER;
      continue;
    }
    if (ch === "'") { state = 'single'; continue; }
    if (ch === '"') { state = 'double'; continue; }
    if (ch === '\\' && i + 1 < command.length) { token += command[++i]; continue; }
    // Ordinary reflog/upstream selectors are literal words in Bash and Zsh.
    // Keep this narrow: commas, ranges and nested/dynamic braces still follow
    // the unsupported shell-syntax path below.
    if (ch === '{' && token.endsWith('@')) {
      const selector = command.slice(i).match(/^\{[A-Za-z0-9_+./:-]+\}/);
      if (selector && !selector[0].includes('..')) {
        token += selector[0]; i += selector[0].length - 1; continue;
      }
    }
    // Unquoted tilde prefixes select HOME, a named home or a shell directory.
    // Bash also expands them after '=' and ':' in assignment-shaped words.
    // Keep quoted/escaped tildes and ordinary paths/revisions such as ./~ or
    // HEAD~1 literal; Zsh still expands a leading tilde after empty quotes.
    if (ch === '~' && (!token.length || /^[A-Za-z_][A-Za-z0-9_]*=(?:[\s\S]*:)?$/.test(token))) token += SHELL_EXPANSION_WORD_MARKER;
    // zsh expands =program and treats attached (...) as glob qualifiers.
    // A separate '(' still starts an ordinary subshell.
    if (ch === '=' && !token.length) { token += `=${SHELL_EXPANSION_WORD_MARKER}`; continue; }
    if (ch === '(' && token.length) token += SHELL_EXPANSION_WORD_MARKER;
    if ((ch === '$' && /[A-Za-z_0-9@*#?$!\-{(\[+=~^]/.test(command[i + 1] || '')) || '*?['.includes(ch)) token += SHELL_EXPANSION_WORD_MARKER;
    if (/\s/.test(ch)) { push(); if (ch === '\n') tokens.push({ type: 'operator', value: ';' }); continue; }
    if (';|&(){}<>'.includes(ch)) {
      push();
      const pair = command.slice(i, i + 2);
      if (pair === '&&' || pair === '||') { tokens.push({ type: 'operator', value: pair }); i += 1; }
      else tokens.push({ type: 'operator', value: ch, adjacent: '<>'.includes(ch)
        && (/\S/.test(command[i - 1] || '') || /\S/.test(command[i + 1] || '')) });
      continue;
    }
    token += ch;
  }
  if (state !== 'normal') throw new Error('unterminated shell quote in tool command');
  push();
  return tokens;
}

function commandSubstitutions(command) {
  const spans = [];

  const ambiguousBackticks = new Set();
  const backtickEnd = start => {
    let sawEscapedBacktick = false;
    for (let i = start + 1; i < command.length; i += 1) {
      if (command[i] === '\\') {
        if (command[i + 1] === '`') sawEscapedBacktick = true;
        i += 1;
        continue;
      }
      if (command[i] === '`') {
        if (sawEscapedBacktick) ambiguousBackticks.add(start);
        return i + 1;
      }
    }
    throw new Error('unterminated shell command substitution');
  };

  const dollarParenEnd = start => {
    let depth = 1;
    let state = 'normal';
    let wordStarted = false;
    for (let i = start + 2; i < command.length; i += 1) {
      const ch = command[i];
      if (state === 'normal') {
        if (ch === '#' && !wordStarted) {
          while (i + 1 < command.length && command[i + 1] !== '\n') i += 1;
          continue;
        }
        wordStarted = !/[\s;|&(){}<>]/.test(ch);
      }
      if (state === 'ansi') {
        if (ch === '\\') i += 1;
        else if (ch === "'") state = 'normal';
        continue;
      }
      if (state === 'single') {
        if (ch === "'") state = 'normal';
        continue;
      }
      if (ch === '\\') { i += 1; continue; }
      if (state === 'double') {
        if (ch === '"') { state = 'normal'; continue; }
        if (ch === '`') { i = backtickEnd(i) - 1; continue; }
        if (ch === '$' && command[i + 1] === '(') {
          i = dollarParenEnd(i) - 1;
          continue;
        }
        // A ')' inside double quotes is data, not the end of this substitution.
        continue;
      }
      if (ch === '$' && command[i + 1] === "'") { state = 'ansi'; i += 1; continue; }
      if (ch === "'") { state = 'single'; continue; }
      if (ch === '"') { state = 'double'; continue; }
      if (ch === '`') { i = backtickEnd(i) - 1; continue; }
      if (ch === '$' && command[i + 1] === '(') {
        i = dollarParenEnd(i) - 1;
        continue;
      }
      if (ch === '(') { depth += 1; continue; }
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    throw new Error('unterminated $() shell command substitution');
  };

  let state = 'normal';
  let wordStarted = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (state === 'normal') {
      if (ch === '#' && !wordStarted) {
        while (i + 1 < command.length && command[i + 1] !== '\n') i += 1;
        continue;
      }
      wordStarted = !/[\s;|&(){}<>]/.test(ch);
    }
    if (state === 'ansi') {
      if (ch === '\\') i += 1;
      else if (ch === "'") state = 'normal';
      continue;
    }
    if (state === 'single') {
      if (ch === "'") state = 'normal';
      continue;
    }
    if (ch === '\\') { i += 1; continue; }
    if (state === 'double') {
      if (ch === '"') { state = 'normal'; continue; }
      if (ch === '`') {
        const end = backtickEnd(i);
        spans.push({ begin: i, end, inner: command.slice(i + 1, end - 1), ambiguous: ambiguousBackticks.has(i) });
        i = end - 1;
        continue;
      }
      if (ch === '$' && command[i + 1] === '(') {
        const end = dollarParenEnd(i);
        spans.push({ begin: i, end, inner: command.slice(i + 2, end - 1) });
        i = end - 1;
      }
      continue;
    }
    if (ch === '$' && command[i + 1] === "'") { state = 'ansi'; i += 1; continue; }
    if (ch === "'") { state = 'single'; continue; }
    if (ch === '"') { state = 'double'; continue; }
    if (ch === '`') {
      const end = backtickEnd(i);
      spans.push({ begin: i, end, inner: command.slice(i + 1, end - 1), ambiguous: ambiguousBackticks.has(i) });
      i = end - 1;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      const end = dollarParenEnd(i);
      spans.push({ begin: i, end, inner: command.slice(i + 2, end - 1) });
      i = end - 1;
    }
  }
  if (state !== 'normal') throw new Error('unterminated shell quote in tool command');
  return spans;
}

function commandWithSubstitutionMarkers(command, spans) {
  if (!spans.length) return command;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += command.slice(cursor, span.begin) + '__SHK_COMMAND_SUBSTITUTION__';
    cursor = span.end;
  }
  return out + command.slice(cursor);
}

function gitInvocation(args) {
  const takesValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--version' || arg === '--help') return { subcommand: arg.slice(2), args: args.slice(i + 1), prefixArgs: args.slice(0, i) };
    if (arg === '--') return { subcommand: args[i + 1] || null, args: args.slice(i + 2), prefixArgs: args.slice(0, i + 1) };
    if (takesValue.has(arg)) { if (args[i + 1] === undefined) throw new Error(`git option ${arg} requires a value`); i += 1; continue; }
    if (/^-(?:C|c).+/.test(arg)) continue;
    if (/^--(?:git-dir|work-tree|namespace|super-prefix|config-env)=/.test(arg)) continue;
    if (/^--exec-path(?:=|$)/.test(arg)) throw new Error('Git --exec-path changes unverified program resolution');
    if (['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks'].includes(arg)) continue;
    if (arg.startsWith('-')) throw new Error(`unsupported git global option ${arg}`);
    return { subcommand: arg, args: args.slice(i + 1), prefixArgs: args.slice(0, i) };
  }
  return { subcommand: null, args: [], prefixArgs: args.slice() };
}

const SUPPORTED_GIT_COMMANDS = new Set([
  'commit', 'tag', 'push', 'merge', 'cherry-pick', 'rebase', 'revert', 'am', 'pull', 'fetch',
  'status', 'diff', 'log', 'show', 'show-ref', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file',
  'branch', 'config', 'add', 'reset', 'restore', 'checkout', 'switch', 'remote', 'stash', 'clean',
  'init', 'clone', 'version', 'help', 'check-ignore', 'check-attr', 'check-ref-format', 'describe',
  'merge-base', 'ls-remote', 'blame', 'grep', 'shortlog', 'for-each-ref', 'count-objects', 'reflog', 'symbolic-ref',
  'rm', 'mv', 'rev-list', 'worktree', 'submodule', 'apply',
]);

function gitReadArgs(prefix, args) {
  return prefix.filter(arg => arg !== '--').concat(['--no-replace-objects', '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'], args);
}

function explicitGitConfigurationProblem(prefix) {
  const safeKeys = new Set(['user.name', 'user.email', 'color.ui', 'core.quotepath', 'core.autocrlf',
    'core.safecrlf', 'core.eol', 'core.filemode', 'core.ignorecase', 'push.followtags',
    'push.recursesubmodules', 'submodule.recurse']);
  for (let i = 0; i < prefix.length; i += 1) {
    const arg = prefix[i];
    if (/^--config-env(?:=|$)/.test(arg)) return 'Git --config-env is not a supported static configuration boundary';
    const entry = arg === '-c' ? prefix[++i] : /^-c.+/.test(arg) ? arg.slice(2) : null;
    if (entry === null) continue;
    const split = String(entry).indexOf('=');
    const key = (split < 0 ? String(entry) : entry.slice(0, split)).toLowerCase();
    const value = split < 0 ? '' : entry.slice(split + 1);
    const safeDisable = (['core.fsmonitor', 'commit.gpgsign', 'tag.gpgsign', 'tag.forcesignannotated', 'push.gpgsign'].includes(key) && /^(?:false|no|off|0)$/i.test(value))
      || (key === 'maintenance.auto' && /^(?:false|no|off|0)$/i.test(value))
      || (key === 'gc.auto' && value === '0')
      || (key === 'core.hookspath' && value === '/dev/null')
      || (key === 'core.pager' && safePager(value, {}))
      || (key === 'core.editor' && ['true', 'false', ':'].includes(value))
      || (key === 'credential.helper' && value === '');
    if (!safeKeys.has(key) && !safeDisable) return `unsupported executable or unbound Git configuration key ${key}`;
  }
  return null;
}

function effectiveGitConfiguration(invocation, cwd, environment = process.env) {
  // Git's external subcommands/helpers search this directory before PATH.
  // Refuse an inherited override before even starting configuration probes.
  if (environment.GIT_EXEC_PATH !== undefined) return null;
  // GIT_CONFIG selects a file only for `git config`; ordinary Git operations
  // still read repository/global settings. A probe using it cannot attest to
  // the protected command's callbacks, mappings or implicit delivery options.
  if (environment.GIT_CONFIG !== undefined) return null;
  // `config --list` does not run fsmonitor, filters, hooks, credential helpers,
  // or external diff. Preserve its values for inspection; disable its pager.
  const result = spawnSync('git', invocation.prefixArgs.filter(arg => arg !== '--')
    .concat(['--no-pager', 'config', '--null', '--list']), {
    cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...environment, GIT_PAGER: 'cat' },
  });
  if (result.error || result.signal || result.status !== 0) return null;
  const values = new Map();
  for (const record of String(result.stdout || '').split('\0').filter(Boolean)) {
    const split = record.indexOf('\n');
    // Only section/variable names are case-insensitive; subsection names
    // (filters, remotes, credentials, URL rewrites) retain their exact case.
    const key = (split < 0 ? record : record.slice(0, split)).replace(/^[^.]+|[^.]+$/g, part => part.toLowerCase());
    // A valueless pretty declaration is invalid, unlike an explicit empty alias.
    const value = split < 0 ? (key.startsWith('pretty.') ? null : '') : record.slice(split + 1);
    if (/^credential(?:\..+)?\.helper$/.test(key)) {
      if (!value) values.set(key, []);
      else values.set(key, [...(values.get(key) || []), value]);
    } else if (['init.templatedir', 'uploadpack.packobjectshook'].includes(key)) {
      // Clone reads global/system templates without the current repository's
      // local overrides. Preserve every declaration, including empty shadows.
      values.set(key, [...(values.get(key) || []), value]);
    } else if (/^remote\..+\.(?:fetch|push|url|pushurl)$/.test(key) || /^branch\..+\.merge$/.test(key)) values.set(key, [values.get(key), value].filter(Boolean).join('\n'));
    else values.set(key, value);
  }
  return values;
}

function safeCredentialHelper(value, environment, config, cwd) {
  const executableIdentity = file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() ? fs.realpathSync(file) : null; }
    catch { return null; }
  };
  const standard = value.match(/^(osxkeychain|manager|manager-core|cache(?: --timeout=\d+)?|store(?: --file(?:=| )[A-Za-z0-9_~./-]+)?)$/);
  if (standard) {
    const helper = `credential-${value.split(' ')[0]}`;
    if (config.has(`alias.${helper}`)) return false;
    // Git expands named helpers as `git credential-<name>`. Builtins win over
    // PATH; external helpers search Git's exec-path before the caller's PATH.
    const builtin = spawnSync('git', ['--list-cmds=builtins'], { cwd, env: environment, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (builtin.error || builtin.signal || builtin.status !== 0) return false;
    if (String(builtin.stdout).split(/\s+/).includes(helper)) return true;
    const execPath = spawnSync('git', ['--exec-path'], { cwd, env: environment, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (execPath.error || execPath.signal || execPath.status !== 0) return false;
    const program = `git-${helper}`;
    const installed = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/opt/local/bin',
      '/opt/homebrew/libexec/git-core', '/usr/local/libexec/git-core', '/usr/local/lib/git-core',
      '/usr/libexec/git-core', '/usr/lib/git-core', '/opt/local/libexec/git-core',
      '/Library/Developer/CommandLineTools/usr/libexec/git-core',
      '/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core']
      .map(dir => executableIdentity(path.join(dir, program))).filter(Boolean);
    const selected = [String(execPath.stdout).trim(), ...String(environment.PATH || '').split(path.delimiter)]
      .map(dir => executableIdentity(path.resolve(cwd, dir, program))).find(Boolean);
    return Boolean(selected && installed.includes(selected));
  }
  const gh = value.match(/^!\s*((?:\/[A-Za-z0-9._/-]+\/)?gh) auth git-credential$/);
  if (!gh) return false;
  const installed = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/bin/gh', '/opt/local/bin/gh']
    .map(executableIdentity).filter(Boolean);
  const selected = path.isAbsolute(gh[1]) ? executableIdentity(gh[1])
    : String(environment.PATH || '').split(path.delimiter).map(dir => executableIdentity(path.join(dir, 'gh'))).find(Boolean);
  return Boolean(selected && installed.includes(selected));
}

function externalRemoteHelper(value) {
  return /^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)
    || (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) && !/^(?:https?|ssh|git|file):\/\//.test(value));
}

function gitBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (/^(?:true|yes|on|1|)$/i.test(String(value))) return true;
  if (/^(?:false|no|off|0)$/i.test(String(value))) return false;
  throw new Error('invalid Git boolean configuration');
}

// Consume option values once. Callback classification must never interpret a
// commit message, grep pattern, or path as another option. Short clusters keep
// every flag preceding a value-taking option (for example tag -asm message).
function gitArgumentInfo(sub, args) {
  if (sub === 'tag') return tagArgumentInfo(args);
  // Stash viewers forward diff/log options: -m is a display flag there, while
  // mutation variants keep -m/--message values (even values named show/list).
  const optionSub = sub === 'stash' && args[0] === 'show' ? 'diff'
    : sub === 'stash' && args[0] === 'list' ? 'log' : sub;
  if (sub === 'stash' && args[0] === 'list') {
    // The stash wrapper consumes one delimiter before forwarding to git log.
    const separator = args.indexOf('--');
    if (separator >= 0) args = [...args.slice(0, separator), ...args.slice(separator + 1)];
  }
  const fileOutputReader = ['diff', 'log', 'show', 'reflog', 'rev-list', 'blame', 'shortlog'].includes(optionSub);
  const valueShort = {
    commit: 'mFCct', grep: 'efmABC', log: 'nSGLO', show: 'nSGLO', diff: 'SGO',
    blame: 'L', branch: '', 'cat-file': '', 'rev-list': 'nSG', apply: 'pC', stash: 'm', config: 'ft',
  }[optionSub] || '';
  const optionalShort = { commit: 'Su', grep: 'O', diff: 'U', log: '', branch: '', 'cat-file': '' }[optionSub] || '';
  const valueLong = new Set(sub === 'apply' ? ['exclude', 'include', 'whitespace', 'directory', 'build-fake-ancestor'] : sub === 'config' ? ['file', 'blob', 'type', 'default', 'value', 'url', 'comment'] : [
    'message', 'file', 'reuse-message', 'reedit-message', 'template', 'author', 'date',
    'cleanup', 'trailer', 'fixup', 'squash', 'pathspec-from-file', 'format', 'pretty',
    'max-count', 'skip', 'since', 'until', 'after', 'before', 'grep', 'grep-reflog',
    'committer', 'glob', 'exclude', 'exclude-hidden', 'sort', 'contains', 'no-contains',
    'points-at', 'merged', 'no-merged', 'abbrev', 'output', 'path', 'filters',
    'regexp', 'max-depth', 'after-context', 'before-context', 'context', 'max-depth',
    'upload-pack', 'receive-pack', 'exec', 'repo', 'push-option', 'config', 'template',
  ]);
  // Shortlog's --committer/-c selects grouping; other revision readers take a
  // committer pattern. The boolean must not consume a following --output.
  if (optionSub === 'shortlog') { valueLong.delete('committer'); valueLong.add('group'); }
  // These take only an attached optional value; the next word is an operand.
  const optionalLong = new Set(['gpg-sign', 'signed', 'open-files-in-pager', 'untracked-files',
    'color', 'color-moved', 'column', 'recurse-submodules', 'no-recurse-submodules',
    'batch', 'batch-check', 'batch-command', 'show-current-patch']);
  // Revision/diff readers accept these optional values only after '='. They
  // must not consume a following --output and hide its filesystem effect.
  if (fileOutputReader) { optionalLong.add('abbrev'); optionalLong.add('pretty'); }
  const strictFlags = {
    apply: 'stat no-stat numstat no-numstat summary no-summary check no-check index no-index intent-to-add no-intent-to-add cached no-cached unsafe-paths no-unsafe-paths apply no-apply 3way no-3way ours theirs union no-build-fake-ancestor no-whitespace no-directory no-add add ignore-space-change no-ignore-space-change ignore-whitespace no-ignore-whitespace reverse no-reverse unidiff-zero no-unidiff-zero reject no-reject allow-overlap no-allow-overlap verbose no-verbose quiet no-quiet inaccurate-eof no-inaccurate-eof recount no-recount allow-empty no-allow-empty',
    commit: 'all patch interactive amend no-edit edit no-gpg-sign signoff no-signoff allow-empty allow-empty-message no-verify dry-run short branch porcelain long null verbose quiet no-post-rewrite include only reset-author status no-status',
    branch: 'list delete force move copy all remotes show-current edit-description unset-upstream set-upstream-to track no-track create-reflog ignore-case omit-empty quiet verbose no-color no-column',
    grep: 'cached no-index untracked no-exclude-standard exclude-standard recurse-submodules textconv no-textconv no-ext-grep ext-grep ignore-case word-regexp invert-match full-name line-number column files-with-matches files-without-match count quiet all-match and or not break heading no-heading null name-only only-matching show-function function-context extended-regexp basic-regexp fixed-strings perl-regexp binary-files text no-color',
    'cat-file': 'textconv filters use-mailmap mailmap follow-symlinks batch-all-objects buffer unordered allow-unknown-type',
    'ls-remote': 'heads branches tags refs get-url exit-code quiet symref server-option',
    clone: 'local no-local shared no-checkout bare mirror single-branch no-single-branch no-tags shallow-submodules no-shallow-submodules recurse-submodules recursive remote branch revision depth shallow-since shallow-exclude reference reference-if-able dissociate separate-git-dir origin jobs filter also-filter-submodules sparse reject-shallow no-reject-shallow progress no-progress quiet verbose server-option',
    config: 'get get-all get-regexp get-urlmatch get-color get-colorbool list edit add replace-all unset unset-all remove-section rename-section append global no-global system no-system local no-local worktree no-worktree no-file no-blob all no-all regexp no-regexp no-value fixed-value no-fixed-value no-url null no-null name-only no-name-only show-origin no-show-origin show-scope no-show-scope show-names no-show-names no-type bool int bool-or-int bool-or-str path expiry-date includes no-includes no-default',
  }[sub];
  const allowedLong = strictFlags && new Set([...strictFlags.split(' '), ...valueLong, ...optionalLong, 'help']);
  const options = [];
  const positionals = [];
  const values = new Map();
  const groupFormats = [];
  const add = (name, value) => {
    options.push(name); values.set(name, value);
    if (optionSub === 'shortlog') {
      // Groups accumulate; only --no-group clears earlier format groups.
      if (name === '--no-group') groupFormats.length = 0;
      if (name === '--group') {
        if (value?.startsWith('format:')) groupFormats.push(value.slice(7));
        // A percent also selects an implicit format, except in literal trailer keys.
        else if (value?.includes('%') && !value.startsWith('trailer:')) groupFormats.push(value);
      }
    }
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      // Blame takes the next word as its filename, then still processes a
      // following revision option such as --output=, even before an error.
      // Preserve option-looking filenames without hiding subsequent output.
      if (sub === 'blame' && args[i + 1] !== undefined) { positionals.push(args[++i]); continue; }
      positionals.push(...args.slice(i + 1)); break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      let name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      // Shortlog accepts every nonempty group prefix, including reset forms.
      // Canonicalize before consuming values or classifying format callbacks.
      if (optionSub === 'shortlog') {
        if (name && 'group'.startsWith(name)) name = 'group';
        else if (name.startsWith('no-') && name.length > 3 && 'group'.startsWith(name.slice(3))) name = 'no-group';
      }
      if (fileOutputReader && ('output'.startsWith(name) || /^(?:no-)?out/.test(name))
          && !['output', 'output-indicator-new', 'output-indicator-old', 'output-indicator-context'].includes(name)) {
        throw new Error(`unsupported git ${sub} output option --${name}`);
      }
      if (allowedLong && !allowedLong.has(name)) throw new Error(`unsupported git ${sub} option --${name}`);
      let value = eq < 0 ? undefined : arg.slice(eq + 1);
      if (valueLong.has(name) && !optionalLong.has(name) && value === undefined) {
        if (args[i + 1] === undefined) throw new Error(`git ${sub} option --${name} requires a value`);
        value = args[++i];
        // The generic option table also contains other subcommands' options.
        // An unsupported option can fail only after Git truncates --output.
        // Preserve real revision-filter pattern values, but reject uncertain
        // consumption instead of treating that output option as harmless data.
        if (fileOutputReader && /^--output(?:=|$)/.test(value) && name !== 'output'
            && !(optionSub !== 'diff' && ['grep', 'grep-reflog', 'author', 'committer'].includes(name))) {
          throw new Error(`git ${sub} --${name} cannot safely consume an output option`);
        }
      }
      add(`--${name}`, value);
    } else if (arg.startsWith('-') && arg !== '-') {
      if (/^-\d+$/.test(arg)) { add(arg); continue; }
      for (let j = 1; j < arg.length; j += 1) {
        const flag = arg[j];
        if (sub === 'apply' && !'pCzNR3vqh'.includes(flag)) throw new Error(`unsupported git apply option -${flag}`);
        if (sub === 'config' && !'ftzelh'.includes(flag)) throw new Error(`unsupported git config option -${flag}`);
        // Reader parsers reject clusters such as -pn/-xS, but can truncate
        // --output before failing. Do not hide that output as a cluster value.
        if (fileOutputReader && j > 1 && valueShort.includes(flag)) {
          throw new Error(`unsupported git ${sub} clustered value option ${arg}`);
        }
        if (valueShort.includes(flag) || optionalShort.includes(flag)) {
          let value = arg.slice(j + 1) || undefined;
          if (value === undefined && valueShort.includes(flag)) {
            if (args[i + 1] === undefined) throw new Error(`git ${sub} option -${flag} requires a value`);
            value = args[++i];
          }
          add(`-${flag}`, value); break;
        }
        add(`-${flag}`);
      }
    } else positionals.push(arg);
  }
  return { options, positionals, values, groupFormats, writesOutput: fileOutputReader && options.includes('--output') };
}

function gitPrettyFormat(format, config) {
  // Direct empty formats suppress output; empty targets reached through aliases
  // still participate in Git's shortest-prefix lookup below.
  if (format === '') return format;
  // Builtins precede configured aliases and cannot be replaced by them.
  const formats = new Map(['raw', 'medium', 'short', 'full', 'fuller', 'oneline',
    'email', 'mboxrd', 'reference'].map(name => [name, null]));
  for (const [key, value] of config) {
    if (key.startsWith('pretty.') && !formats.has(key.slice(7))) formats.set(key.slice(7), value);
  }
  const lower = value => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
  const seen = new Set();
  while (typeof format === 'string') {
    // Explicit or percent-containing formats are literal, including alias values.
    if (/^(?:format|tformat):/.test(format) || format.includes('%')) return format;
    const prefix = lower(format);
    let selected;
    for (const [name, value] of formats) {
      const length = Buffer.byteLength(name);
      if (lower(name).startsWith(prefix) && (!selected || length < selected.length)) {
        selected = { name, value, length };
      }
    }
    // Equal-length matches retain declaration order. Unknown/cyclic aliases
    // fail in Git before rendering; builtins contain no signature placeholder.
    if (!selected || selected.value === null || seen.has(selected.name)) return undefined;
    seen.add(selected.name);
    format = selected.value;
  }
  return format;
}

function gitCommandProfile(invocation, config) {
  const sub = invocation.subcommand;
  const parsed = gitArgumentInfo(sub, invocation.args);
  const { options, positionals } = parsed;
  const has = (...names) => options.some(option => names.includes(option));
  const lastToggle = (enable, disable, fallback) => {
    let value = fallback;
    for (const option of options) {
      if (enable.includes(option)) value = true;
      if (disable.includes(option)) value = false;
    }
    return value;
  };
  const resultCreating = ['merge', 'cherry-pick', 'rebase', 'revert', 'am', 'pull'].includes(sub);
  const profile = {
    ...parsed, kind: sub === 'commit' || resultCreating ? 'commit' : sub === 'push' ? 'push' : null,
    variant: sub, network: ['push', 'fetch', 'clone', 'pull', 'ls-remote', 'remote'].includes(sub),
    content: ['diff', 'log', 'show', 'status', 'commit', 'blame', 'grep', 'cat-file', 'rev-list'].includes(sub),
    signature: ['log', 'show', 'rev-list', 'for-each-ref'].includes(sub),
    editor: false, sequenceEditor: sub === 'rebase',
    hooks: ['status', 'diff', 'add', 'commit', 'push', 'fetch', 'checkout', 'switch', 'reset', 'restore', 'stash', 'branch', 'clone', 'rm', 'mv', 'apply'].includes(sub),
    pager: ['log', 'show', 'diff', 'branch', 'tag', 'config', 'help', 'grep', 'blame', 'shortlog', 'reflog'].includes(sub),
  };
  if (sub === 'tag') {
    const mode = tagOperation(parsed);
    profile.variant = `tag-${mode}`;
    profile.kind = mode === 'create' ? 'tag' : null;
    profile.hooks = ['create', 'delete'].includes(mode);
    profile.pager = mode === 'list';
    let signing = lastToggle(['-s', '--sign', '-u', '--local-user'], ['--no-sign'], gitBoolean(config.get('tag.gpgsign')));
    const annotated = has('-a', '--annotate', '-m', '--message', '-F', '--file') || signing;
    // forceSignAnnotated is applied after --no-sign by Git itself.
    signing ||= annotated && gitBoolean(config.get('tag.forcesignannotated'));
    profile.signature = mode === 'verify' || (mode === 'list' && has('--format')) || (mode === 'create' && signing);
    profile.editor = mode === 'create' && (lastToggle(['-e', '--edit'], ['--no-edit'], annotated && !has('-m', '--message', '-F', '--file')));
  } else if (sub === 'commit') {
    const fixup = parsed.values.get('--fixup') || '';
    const editingFixup = /^(?:amend|reword):/.test(fixup);
    profile.editor = lastToggle(['-e', '--edit', '-c', '--reedit-message'], ['--no-edit'], editingFixup || !has('-m', '--message', '-F', '--file', '-C', '--reuse-message', '--fixup'));
    profile.signature = lastToggle(['-S', '--gpg-sign'], ['--no-gpg-sign'], gitBoolean(config.get('commit.gpgsign')));
    if (has('-p', '--patch', '--interactive')) profile.error = 'interactive Git editing cannot be bound to static execution';
    if (positionals.length || has('-o', '--only', '--pathspec-from-file', '--pathspec-file-nul') || fixup.startsWith('reword:')) profile.error = 'path-selected commit can produce a tree different from the verified index';
  } else if (sub === 'branch') {
    profile.editor = has('--edit-description'); profile.signature = has('--format');
    profile.variant = profile.editor ? 'branch-edit' : !positionals.length || has('--list') ? 'branch-list' : 'branch-change';
    profile.pager = profile.variant === 'branch-list';
  }
  else if (sub === 'push') {
    let signing = config.get('push.gpgsign') ?? 'false';
    for (const option of options) {
      if (option === '--signed') signing = parsed.values.get(option) ?? 'true';
      if (option === '--no-signed') signing = 'false';
    }
    profile.signature = signing === 'if-asked' || gitBoolean(signing);
  }
  if (sub === 'reflog' && !['delete', 'expire', 'exists', 'drop', 'list'].includes(positionals[0])) {
    profile.variant = 'reflog-show'; profile.content = true; profile.signature = true;
  }
  if (sub === 'stash' && ['show', 'list'].includes(positionals[0])) {
    profile.variant = `stash-${positionals[0]}`; profile.content = true; profile.signature = true; profile.pager = true;
  }
  if (['log', 'show', 'rev-list', 'shortlog'].includes(sub) || profile.variant === 'reflog-show' || /^stash-(?:show|list)$/.test(profile.variant)) {
    // Only log/show inherit the default pretty format; other viewers require
    // an explicit format. Shortlog also ignores log's signature-display default.
    let format = ['log', 'show'].includes(sub) ? config.get('format.pretty') : undefined;
    for (const option of options) {
      if (['--format', '--pretty'].includes(option)) format = parsed.values.get(option);
      if (option === '--oneline') format = 'oneline';
    }
    format = gitPrettyFormat(format, config);
    const signatureFormat = value => /%[+\- ]?G[?GSKFPT]/.test(String(value || '').replace(/%%/g, ''));
    // Group formats are literal pretty-format strings, not pretty aliases.
    profile.signature = signatureFormat(format)
      || (sub === 'shortlog' && parsed.groupFormats.some(signatureFormat))
      || lastToggle(['--show-signature'], ['--no-show-signature'], sub === 'shortlog' ? false : gitBoolean(config.get('log.showsignature')));
  }
  profile.trailers = (sub === 'commit' || profile.variant === 'tag-create') && has('--trailer');
  profile.submodules = has('--recurse-submodules')
    || ['status', 'diff', 'commit', 'add', 'reset', 'restore', 'checkout', 'switch', 'stash', 'rm', 'mv', 'grep', 'submodule'].includes(sub)
    || (['log', 'show'].includes(sub) && (parsed.values.get('--submodule') === 'diff' || config.get('diff.submodule') === 'diff'));
  profile.autoMaintenance = ['commit', 'fetch', 'clone', 'merge', 'pull', 'rebase', 'am', 'cherry-pick', 'revert'].includes(sub)
    && gitBoolean(config.get('maintenance.auto'), true)
    && (config.get('gc.auto') === undefined || !/^-?\d+$/.test(config.get('gc.auto')) || Number(config.get('gc.auto')) > 0)
    && !has('--no-auto-maintenance', '--no-auto-gc');
  if (profile.network && (has('--upload-pack', '--receive-pack', '--exec') || positionals.some(externalRemoteHelper))) {
    profile.error = 'explicit Git network callback is not supported';
  }
  if (sub === 'grep' && has('-O', '--open-files-in-pager')) profile.error = 'grep external pager execution is not supported';
  if (sub === 'grep' && has('--recurse-submodules')) profile.error = 'recursive grep callbacks are not bound to one repository';
  if (sub === 'help' && positionals.length) profile.error = 'external Git help viewers are not a supported command variant';
  if (['add', 'checkout', 'switch', 'reset', 'restore', 'stash'].includes(sub) && !['stash-show', 'stash-list'].includes(profile.variant)
      && has('-p', '--patch', '-i', '--interactive', '-e', '--edit')) profile.error = 'interactive Git editing cannot be bound to static execution';
  if (sub === 'clone' && has('-c', '--config', '-u', '--upload-pack', '--template', '--recurse-submodules', '--recursive')) profile.error = 'clone callback or recursive options cannot be bound safely';
  if (sub === 'clone' && config.has('init.templatedir')) profile.error = 'custom clone template declarations are not bound to verified execution';
  if (sub === 'remote' && (positionals.includes('update') || has('-f', '--fetch'))) profile.error = 'remote update may create unverified tag references';
  if (sub === 'worktree' && positionals[0] !== 'list') profile.error = 'only worktree list is a supported worktree variant';
  if (sub === 'submodule' && positionals[0] !== 'status') profile.error = 'only submodule status is a supported submodule variant';
  if (sub === 'apply') {
    // Git keeps each reporting flag separately. --apply overrides every active
    // report even when it precedes that report; --no-apply merely clears the
    // override, and without an active report Git still applies by default.
    const reporting = ['stat', 'numstat', 'summary', 'check']
      .some(name => lastToggle([`--${name}`], [`--no-${name}`], false));
    profile.appliesPatch = lastToggle(['--apply'], ['--no-apply'], false) || !reporting;
    // This output can overwrite an index even during an otherwise read-only
    // report. It is not part of the supported patch inspection boundary.
    if (has('--build-fake-ancestor')) profile.error = 'apply auxiliary index output is not bound to verified execution';
  }
  if (sub === 'config') {
    const mutation = has('-e', '--edit', '--add', '--replace-all', '--unset', '--unset-all', '--remove-section', '--rename-section')
      || ['edit', 'set', 'unset', 'rename-section', 'remove-section'].includes(positionals[0]);
    const query = has('--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l')
      || (positionals[0] === 'get' && positionals.length >= 2) || (positionals[0] === 'list' && positionals.length === 1)
      || (positionals.length === 1 && /^[A-Za-z][A-Za-z0-9-]*\..+/.test(positionals[0]));
    if (mutation || !query) profile.error = 'Git configuration mutation or editor is not a supported static execution boundary';
  }
  return profile;
}

function safePager(value, environment) {
  if (['', 'cat', 'false', 'true', ':'].includes(value)) return true;
  if (!/^less(?: -[FRXKMNSEQinrsx]+)*$/.test(value)) return false;
  return !['LESSOPEN', 'LESSCLOSE', 'LESSKEY', 'LESSKEYIN', 'LESSKEY_CONTENT'].some(key => environment[key])
    && (!environment.LESS || /^-?[FRXKMNSEQinrsx]+$/.test(environment.LESS));
}

function selectedPager(invocation, profile, config, environment) {
  let enabled = profile.pager;
  const commandPager = config.get(`pager.${invocation.subcommand}`);
  let program;
  if (commandPager !== undefined) {
    if (/^(?:true|yes|on|1|false|no|off|0|)$/i.test(commandPager)) enabled = gitBoolean(commandPager);
    else { enabled = true; program = commandPager; }
  }
  for (const arg of invocation.prefixArgs) {
    if (['-p', '--paginate'].includes(arg)) enabled = true;
    if (['-P', '--no-pager'].includes(arg)) enabled = false;
  }
  if (!enabled) return null;
  return environment.GIT_PAGER ?? program ?? config.get('core.pager') ?? environment.PAGER ?? 'less';
}

function selectedEditor(profile, config, environment) {
  const editor = environment.GIT_EDITOR ?? config.get('core.editor')
    ?? (environment.TERM === 'dumb' ? undefined : environment.VISUAL) ?? environment.EDITOR;
  return profile.sequenceEditor ? (environment.GIT_SEQUENCE_EDITOR ?? config.get('sequence.editor') ?? editor) : editor;
}

function gitCallbackProblem(invocation, cwd, config, profile, environment, visited = new Set()) {
  const sub = invocation.subcommand;
  const { network, content, signature } = profile;
  if (profile.error) return profile.error;
  if (environment.GIT_EXEC_PATH !== undefined) return 'inherited Git executable search path is not bound to verified execution';
  if (sub === 'clone' && environment.GIT_TEMPLATE_DIR !== undefined) return 'custom clone template environment is not bound to verified execution';
  const pager = selectedPager(invocation, profile, config, environment);
  if (pager !== null && !safePager(pager, environment)) return 'unverified effective Git pager';
  if (profile.editor || profile.sequenceEditor) {
    const editor = selectedEditor(profile, config, environment);
    if (editor !== undefined && !['true', 'false', ':'].includes(editor)) return 'unverified effective Git editor';
  }
  for (const [key, value] of config) {
    if (key === 'core.fsmonitor' && !/^(?:false|no|off|0)$/i.test(value)) return `unverified callback ${key}`;
    if (/^filter\..+\.(?:clean|smudge|process)$/.test(key) && value && sub !== 'config') return `unverified callback ${key}`;
    if ((key === 'diff.external' || /^diff\..+\.(?:command|textconv)$/.test(key)) && value
        && content) return `unverified callback ${key}`;
    if ((/^gpg(?:\..+)?\.program$/.test(key) || key === 'gpg.ssh.defaultkeycommand') && signature && value) return `unverified callback ${key}`;
    if (profile.trailers && /^trailer\..+\.(?:cmd|command)$/.test(key) && value) return `unverified callback ${key}`;
    if (network && ['core.sshcommand', 'core.askpass', 'core.gitproxy'].includes(key) && value) return `unverified callback ${key}`;
    if (network && /^credential(?:\..+)?\.helper$/.test(key) && value.some(helper => !safeCredentialHelper(helper, environment, config, cwd))) return `unverified callback ${key}`;
    if (network && key === 'uploadpack.packobjectshook' && value.some(declaration => declaration.trim())) return 'unverified protected upload-pack callback';
    if (key === 'core.alternaterefscommand' && value) return `unverified callback ${key}`;
    if (network && /^remote\..+\.(?:uploadpack|receivepack|vcs)$/.test(key) && value) return `unverified callback ${key}`;
    if (network && /^remote\..+\.(?:url|pushurl)$/.test(key)
        && String(value).split('\n').some(externalRemoteHelper)) return `unbound remote helper ${key}`;
    if (network && /^url\..+\.(?:insteadof|pushinsteadof)$/.test(key)
        && externalRemoteHelper(key.slice(4, key.lastIndexOf('.')))) return 'URL rewrite selects an unbound remote helper';
    if (sub === 'help' && (/^man\..+\.(?:cmd|path)$/.test(key) || /^browser\..+\.(?:cmd|path)$/.test(key))) return `unverified callback ${key}`;
    if (/^merge\..+\.driver$/.test(key) && ['merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'checkout', 'switch'].includes(sub)) return `unverified callback ${key}`;
    if (/^submodule\..+\.update$/.test(key) && String(value).startsWith('!')) return `unverified callback ${key}`;
  }
  for (const key of ['GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS',
    'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PROXY_COMMAND']) {
    if (environment[key] && ((network && /SSH|ASKPASS|PROXY/.test(key)) || (content && /DIFF/.test(key)))) {
      return `unverified callback environment ${key}`;
    }
  }
  const hookNames = ['reference-transaction', 'post-index-change'];
  if (profile.autoMaintenance) hookNames.push('pre-auto-gc');
  if (sub === 'commit') hookNames.push('pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-rewrite');
  if (sub === 'push') hookNames.push('pre-push');
  if (['checkout', 'switch', 'clone'].includes(sub)) hookNames.push('post-checkout');
  if (profile.hooks || profile.autoMaintenance) {
    const configured = config.get('core.hookspath');
    if (configured !== undefined && configured !== '/dev/null') return 'configured Git hooks path is not bound to verified execution';
    if (configured !== '/dev/null') {
      const result = spawnSync('git', gitReadArgs(invocation.prefixArgs, ['rev-parse', '--git-common-dir']), {
        cwd, env: environment, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0) {
        const directory = path.resolve(cwd, result.stdout.trim(), 'hooks');
        for (const hook of hookNames) {
          try {
            const file = path.join(directory, hook);
            if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return `unverified executable Git hook ${hook}`; }
          } catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) return 'Git hook path could not be inspected'; }
        }
      } else if (result.error || result.signal || !['init', 'clone'].includes(sub)) return 'Git hook directory could not be resolved';
    }
  }
  return profile.submodules ? gitSubmoduleCallbackProblem(invocation, cwd, environment, visited) : null;
}

function gitSubmoduleCallbackProblem(invocation, cwd, environment, visited) {
  const read = args => spawnSync('git', gitReadArgs([...invocation.prefixArgs, '--no-literal-pathspecs'], args), {
    cwd, env: environment, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const top = read(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    const bare = read(['rev-parse', '--is-bare-repository']);
    return bare.status === 0 && bare.stdout.trim() === 'true' ? null : 'submodule parent repository could not be resolved';
  }
  let root;
  try { root = fs.realpathSync(top.stdout.trim()); } catch { return 'submodule parent path is unavailable'; }
  if (visited.has(root) || visited.size >= 64) return 'submodule repository recursion cannot be bound safely';
  visited.add(root);
  // Parent status/diff can inspect children outside the caller's subdirectory.
  const entries = read(['ls-files', '--full-name', '--stage', '-z', '--', ':/']);
  if (entries.error || entries.signal || entries.status !== 0) return 'submodule index entries could not be inspected';
  const childPaths = [...new Set(entries.stdout.split('\0').filter(Boolean)
    .map(entry => /^160000 [0-9a-f]+ [0-3]\t([\s\S]+)$/.exec(entry)).filter(Boolean).map(match => match[1]))];
  if (!childPaths.length) return null;
  // Git clears repository-local environment when entering a submodule, but
  // propagates command-line -c settings. Parent -C/--git-dir must not be replayed.
  const localNames = read(['rev-parse', '--local-env-vars']);
  if (localNames.error || localNames.signal || localNames.status !== 0) return 'submodule environment could not be resolved';
  const childEnvironment = { ...environment };
  for (const name of localNames.stdout.trim().split('\n')) {
    if (!['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'].includes(name)) delete childEnvironment[name];
  }
  const prefixArgs = [];
  for (let i = 0; i < invocation.prefixArgs.length; i += 1) {
    const arg = invocation.prefixArgs[i];
    if (arg === '-c') prefixArgs.push(arg, invocation.prefixArgs[++i]);
    else if (/^-c.+/.test(arg)) prefixArgs.push(arg);
  }
  const childInvocation = { ...invocation, prefixArgs };
  for (const relative of childPaths) {
    const child = path.resolve(root, relative);
    if (!child.startsWith(root + path.sep)) return 'submodule path escapes its parent repository';
    try { fs.statSync(path.join(child, '.git')); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      return 'populated submodule metadata is unreadable';
    }
    const childConfig = effectiveGitConfiguration(childInvocation, child, childEnvironment);
    if (!childConfig) return 'populated submodule configuration is unavailable';
    const childProfile = gitCommandProfile(childInvocation, childConfig);
    const problem = gitCallbackProblem(childInvocation, child, childConfig, childProfile, childEnvironment, visited);
    if (problem) return `submodule ${relative}: ${problem}`;
  }
  return null;
}

function fetchTargetProblem(invocation, config, profile, cwd) {
  const supported = new Set(['--no-tags', '--no-recurse-submodules', '--recurse-submodules', '--no-all',
    '--prune', '-p', '--no-prune', '--no-prune-tags', '--no-auto-maintenance', '--no-auto-gc', '--dry-run', '-n', '--verbose', '-v', '--quiet', '-q', '--atomic',
    '--no-write-fetch-head', '--progress', '--no-progress']);
  for (const option of profile.options) if (!supported.has(option)) return `unsupported fetch option ${option}`;
  const has = option => profile.options.includes(option);
  if (!has('--no-all') && gitBoolean(config.get('fetch.all'))) return 'fetch.all expands an unbound set of remotes';
  let recurse = config.get('fetch.recursesubmodules') ?? config.get('submodule.recurse') ?? 'on-demand';
  for (const option of profile.options) {
    if (option === '--no-recurse-submodules') recurse = 'false';
    if (option === '--recurse-submodules') recurse = profile.values.get(option) ?? 'true';
  }
  if (recurse === 'on-demand' || gitBoolean(recurse)) return 'recursive fetch is not bound to one repository; use --no-recurse-submodules';
  const positionals = profile.positionals.slice();
  let remote = positionals.shift();
  if (!remote) {
    const branch = spawnSync('git', gitReadArgs(invocation.prefixArgs, ['symbolic-ref', '--quiet', '--short', 'HEAD']), {
      cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (branch.error || branch.signal || ![0, 1].includes(branch.status)) return 'default fetch branch could not be resolved';
    remote = (branch.status === 0 && config.get(`branch.${branch.stdout.trim()}.remote`)) || 'origin';
  }
  if (hasDynamicShellSyntax(remote) || config.has(`remotes.${remote}`)) return 'fetch remote or group cannot be bound safely';
  let pruneTags = gitBoolean(config.get(`remote.${remote}.prunetags`) ?? config.get('fetch.prunetags'));
  for (const option of profile.options) {
    if (option === '--no-prune-tags') pruneTags = false;
  }
  if (pruneTags) return 'pruneTags expands tag references even when --no-tags or --no-prune is set';
  if (!has('--no-tags') && !has('-n') && config.get(`remote.${remote}.tagopt`) !== '--no-tags') return 'fetch must disable implicit tag creation with --no-tags';
  // Explicit source arguments still use the remote's configured destination
  // mappings. Check both sets, even when the caller supplied one source.
  const refs = [...positionals, ...String(config.get(`remote.${remote}.fetch`) || '').split('\n').filter(Boolean)];
  for (const ref of refs) {
    if (hasDynamicShellSyntax(ref) || ref === 'tag' || /refs\/tags\//.test(ref)) return 'fetch cannot create or select tag references';
    const destination = ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : '';
    if (destination && !destination.startsWith('refs/remotes/')) return 'fetch may only update explicitly remote-tracking references';
  }
  return null;
}

function effectiveGitAlias(prefixArgs, subcommand, cwd) {
  if (!subcommand || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(subcommand)) {
    return { exists: false, uncertain: true };
  }
  const args = gitReadArgs(prefixArgs, ['config', '--get', `alias.${subcommand}`]);
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    return { exists: false, uncertain: true };
  }
  return { exists: result.status === 0, uncertain: false };
}

function tagArgumentInfo(args) {
  const valueOptions = new Set(['-u', '--local-user', '-m', '--message', '-F', '--file', '--cleanup', '--trailer', '--sort', '--format']);
  const flags = new Set(['-a', '-s', '-f', '-e', '-l', '-d', '-v', '-i',
    '--list', '--delete', '--verify', '--annotate', '--no-annotate', '--sign', '--no-sign',
    '--force', '--no-force', '--edit', '--no-edit', '--create-reflog', '--no-create-reflog',
    '--no-file', '--no-cleanup', '--no-local-user', '--omit-empty', '--no-omit-empty',
    '--ignore-case', '--no-ignore-case', '--no-column', '--no-color']);
  const options = [];
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (valueOptions.has(arg)) {
      if (args[i + 1] === undefined) throw new Error(`git tag option ${arg} requires a value`);
      options.push(arg); i += 1; continue;
    }
    if (/^--(?:local-user|message|file|cleanup|trailer|sort|format)=/.test(arg)) { options.push(arg.split('=')[0]); continue; }
    const shortValue = arg.match(/^-[asfe]*([umF])(.*)$/);
    if (shortValue) {
      const valueIndex = arg.length - shortValue[2].length - 1;
      options.push(...arg.slice(1, valueIndex).split('').map(flag => `-${flag}`));
      options.push(`-${shortValue[1]}`);
      if (!shortValue[2]) {
        if (args[i + 1] === undefined) throw new Error(`git tag option ${arg} requires a value`);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-')) {
      // Unknown/abbreviated options may consume the next token. Refusing them
      // prevents a message value such as --list from changing classification.
      if (!flags.has(arg) && !/^-n\d*$/.test(arg) && !/^-[asfe]+$/.test(arg)
          && !/^--(?:list|contains|no-contains|points-at|no-points-at|merged|no-merged|sort|no-sort|format|no-format|column|color)(?:=|$)/.test(arg)) {
        throw new Error(`unsupported git tag option ${arg}`);
      }
      if (/^-[asfe]+$/.test(arg)) options.push(...arg.slice(1).split('').map(flag => `-${flag}`));
      else options.push(arg);
    }
    else positionals.push(arg);
  }
  return { options, positionals };
}

function tagOperation({ options, positionals }) {
  if (options.some(arg => ['-d', '--delete'].includes(arg))) return 'delete';
  if (options.some(arg => ['-v', '--verify'].includes(arg))) return 'verify';
  if (options.some(arg => ['-l', '--list'].includes(arg) || /^-n\d*$/.test(arg)
      || /^--(?:list|contains|no-contains|points-at|merged|no-merged)(?:=|$)/.test(arg))) return 'list';
  return positionals.length > 0 || options.some(arg => ['-a', '--annotate', '-s', '--sign', '-u', '--local-user', '-m', '--message', '-F', '--file', '-f', '--force'].includes(arg)) ? 'create' : 'list';
}

function isTagCreation(args) {
  return tagOperation(tagArgumentInfo(args)) === 'create';
}

function wrappedCommandIndex(words, start, base) {
  let i = start + 1;
  let endOptions = false;
  const schemas = {
    env: {
      value: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '-P', '-a', '--argv0']),
      flag: new Set(['-i', '--ignore-environment', '-0', '--null', '-v', '--debug', '--help', '--version']),
      attached: /^-(?:u|C|S|P|a).+/,
      equals: /^--(?:unset|chdir|split-string|argv0)=/,
    },
    sudo: {
      value: new Set(['-a', '--auth-type', '-C', '--close-from', '-c', '--login-class', '-D', '--chdir', '-g', '--group', '-h', '--host', '-p', '--prompt', '-R', '--chroot', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-u', '--user', '-U', '--other-user']),
      flag: new Set(['-A', '--askpass', '-b', '--background', '-E', '--preserve-env', '-e', '--edit', '-H', '--set-home', '-i', '--login', '-K', '--remove-timestamp', '-k', '--reset-timestamp', '-l', '--list', '-n', '--non-interactive', '-P', '--preserve-groups', '-S', '--stdin', '-s', '--shell', '-V', '--version', '-v', '--validate']),
      attached: /^-(?:a|C|c|D|g|h|p|R|r|t|T|u|U).+/,
      equals: /^--(?:auth-type|close-from|login-class|chdir|group|host|prompt|chroot|role|type|command-timeout|user|other-user)=/,
    },
    command: { value: new Set([]), flag: new Set(['-p']), terminal: new Set(['-v', '-V']), terminalAttached: /^-[p]*[vV][pVv]*$/, attached: /^-p+$/, equals: /$a/ },
    builtin: { value: new Set([]), flag: new Set([]), attached: /$a/, equals: /$a/ },
    nohup: { value: new Set([]), flag: new Set([]), attached: /$a/, equals: /$a/ },
  };
  const schema = schemas[base] || schemas.nohup;
  while (i < words.length) {
    const arg = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)
        || (base === 'env' && (endOptions || !arg.startsWith('-')) && arg.includes('='))) { i += 1; continue; }
    if (arg === '--') { i += 1; if (base === 'env') { endOptions = true; continue; } break; }
    if (endOptions) break;
    if ((schema.terminal && schema.terminal.has(arg)) || (schema.terminalAttached && schema.terminalAttached.test(arg))) {
      // command -v/-V only describes a command; it does not execute it.
      return words.length;
    }
    if (schema.value.has(arg)) {
      if (words[i + 1] === undefined) throw new Error(`${base} option ${arg} requires a value`);
      i += 2; continue;
    }
    if (schema.flag.has(arg) || schema.attached.test(arg) || schema.equals.test(arg)) { i += 1; continue; }
    if (arg.startsWith('-')) throw new Error(`unsupported ${base} option ${arg}`);
    break;
  }
  return i;
}

function shellCommandString(words, start) {
  let i = start + 1;
  const takesValue = new Set(['-O', '+O', '-o', '+o', '--rcfile', '--init-file']);
  while (i < words.length) {
    const arg = words[i];
    if (takesValue.has(arg)) {
      if (words[i + 1] === undefined) throw new Error(`shell option ${arg} requires a value`);
      i += 2; continue;
    }
    if (arg === '-c' || (/^-[^-]+$/.test(arg) && arg.slice(1).includes('c'))) {
      if (words[i + 1] === undefined) throw new Error('shell -c requires a command string');
      return words[i + 1];
    }
    if (arg === '--') return null;
    if (arg.startsWith('-') || arg.startsWith('+')) { i += 1; continue; }
    return null;
  }
  return null;
}

function shellReadsStdin(words, start) {
  const takesValue = new Set(['-O', '+O', '-o', '+o', '--rcfile', '--init-file']);
  for (let i = start + 1; i < words.length; i += 1) {
    const arg = words[i];
    if (takesValue.has(arg)) { i += 1; continue; }
    if (arg === '-' || (arg.startsWith('-') && !arg.startsWith('--') && arg.includes('s'))) return true;
    if (arg === '--') return !words[i + 1] || words[i + 1] === '-';
    if (!arg.startsWith('-') && !arg.startsWith('+')) return false;
  }
  return true;
}

const SHELL_SUBSTITUTION_MARKER = '__SHK_COMMAND_SUBSTITUTION__';
const SHELL_ENCODED_WORD_MARKER = '__SHK_ENCODED_SHELL_WORD__';
const SHELL_EXPANSION_WORD_MARKER = '__SHK_EXPANDED_SHELL_WORD__';

function hasUnboundShellWord(value) {
  const text = String(value || '');
  return [SHELL_SUBSTITUTION_MARKER, SHELL_ENCODED_WORD_MARKER, SHELL_EXPANSION_WORD_MARKER]
    .some(marker => text.includes(marker));
}

function hasDynamicShellSyntax(value) {
  const text = String(value || '');
  return hasUnboundShellWord(text)
    || /\$(?:\{|[A-Za-z_0-9@*#?$!\-])/.test(text)
    || /(?:^|[^\\])[<>]\(/.test(text);
}

function assignmentName(word) {
  const match = String(word || '').match(/^([^=]+)=/);
  return match ? match[1] : null;
}

function shellStartupEnvironment(name) {
  return ['BASH_ENV', 'ENV', 'ZDOTDIR', 'PS0', 'PS1', 'PS2', 'PS4', 'PROMPT', 'RPROMPT',
    'PROMPT_COMMAND', 'SHELLOPTS', 'BASHOPTS'].includes(name) || name.startsWith('BASH_FUNC_');
}

const GIT_CALLBACK_ENVIRONMENT = new Set(['GIT_PAGER', 'PAGER', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR',
  'EDITOR', 'VISUAL', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS',
  'GIT_PROXY_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'LESS', 'LESSOPEN', 'LESSCLOSE',
  'LESSKEY', 'LESSKEYIN', 'LESSKEY_CONTENT', 'TERM']);

function applyEnvironmentAssignment(environment, word) {
  const name = assignmentName(word);
  if (name) environment[name] = word.slice(word.indexOf('=') + 1);
}

function assignmentMayRewriteGit(word) {
  const name = assignmentName(word);
  return Boolean(name && (
    name === 'PATH' || name === 'HOME' || name === 'XDG_CONFIG_HOME'
    || (name.startsWith('GIT_') && !GIT_CALLBACK_ENVIRONMENT.has(name))
    || shellStartupEnvironment(name)
    || name.startsWith('LD_') || name.startsWith('DYLD_')
  ));
}

function physicalDirectory(value, base) {
  // Let the filesystem follow symlinks before resolving a subsequent '..'.
  const target = path.isAbsolute(value) ? value : `${base}${path.sep}${value}`;
  const directory = fs.realpathSync.native(target);
  if (!fs.statSync(directory).isDirectory()) throw new Error('path is not a directory');
  return directory;
}

// Preserve only wrapper context that can be reproduced without executing the
// wrapper. Identity changes, split-string parsing and alternate search paths
// cannot share the hook process's effective Git configuration safely.
function wrapperContext(base, controls, cwd, environment) {
  if (base === 'sudo') return { error: 'sudo changes execution identity or filesystem context' };
  if (base !== 'env') return { cwd, environment };
  let endOptions = false;
  let changedDirectory = false;
  for (let i = 0; i < controls.length; i += 1) {
    const arg = controls[i];
    if (arg === '--') { endOptions = true; continue; }
    if ((endOptions || !arg.startsWith('-')) && arg.includes('=')) { applyEnvironmentAssignment(environment, arg); continue; }
    if (endOptions) return { error: 'env command boundary cannot be bound safely' };
    if (arg === '-C' || arg === '--chdir' || /^-C.+/.test(arg) || arg.startsWith('--chdir=')) {
      if (changedDirectory) return { error: 'repeated env chdir options are unsupported' };
      changedDirectory = true;
      const dir = arg === '-C' || arg === '--chdir' ? controls[++i]
        : arg.startsWith('--chdir=') ? arg.slice(8) : arg.slice(2);
      // Expansion markers preserve the lexer's quoting decisions; decoded
      // metacharacters alone do not make this directory dynamic.
      if (!dir || hasUnboundShellWord(dir)) return { error: 'env chdir is not a static directory' };
      try { cwd = physicalDirectory(dir, cwd); } catch { return { error: 'env chdir directory is unavailable' }; }
    } else if (arg === '-u' || arg === '--unset' || /^-u.+/.test(arg) || arg.startsWith('--unset=')) {
      const name = arg === '-u' || arg === '--unset' ? controls[++i]
        : arg.startsWith('--unset=') ? arg.slice(8) : arg.slice(2);
      if (name !== 'GIT_EXEC_PATH' && assignmentMayRewriteGit(`${name}=`)) return { error: 'env unset changes effective Git configuration' };
      delete environment[name];
    } else if (['-v', '--debug'].includes(arg)) {
      continue;
    } else {
      return { error: `env option ${arg} changes unverified execution context` };
    }
  }
  return { cwd, environment };
}

function shellStartupProblem(words, start, shell) {
  const options = [];
  const takesValue = new Set(['-O', '+O', '-o', '+o']);
  for (let i = start + 1; i < words.length; i += 1) {
    const arg = words[i];
    if (/^--(?:rcfile|init-file)(?:=|$)/.test(arg)) return 'explicit shell startup file is unverified';
    if (!arg.startsWith('-') && !arg.startsWith('+')) break;
    options.push(arg);
    if (takesValue.has(arg)) { i += 1; continue; }
    if (arg === '--' || arg === '-c' || (/^-[^-]+$/.test(arg) && arg.slice(1).includes('c'))) break;
  }
  const hasShort = letter => options.some(option => /^-[^-]+$/.test(option) && option.slice(1).includes(letter));
  if (options.includes('--interactive') || hasShort('i')) return 'interactive shell startup is unverified';
  if ((options.includes('--login') || hasShort('l'))
      && !(shell === 'bash' && options.includes('--noprofile'))) return 'login shell startup is unverified';
  if (shell === 'zsh' && ((!hasShort('f') && !options.includes('--no-rcs'))
      || options.some(option => option !== '--no-rcs' && !/^-[fc]+$/.test(option)))) {
    return 'zsh startup requires disabled user rc files without options that can re-enable them';
  }
  return null;
}

const COMMAND_WRAPPERS = new Set(['env', 'command', 'builtin', 'nohup', 'sudo']);
const SHELL_EXECUTABLES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PLUMBING_DELIVERY_COMMANDS = new Set(['send-pack', 'receive-pack', 'http-push', 'update-ref', 'fast-import']);
const GIT_CORE_DELIVERY_COMMANDS = new Set([...PLUMBING_DELIVERY_COMMANDS,
  'commit', 'tag', 'push', 'merge', 'cherry-pick', 'rebase', 'revert', 'am', 'pull']);
const DELIVERY_WORDS = /\b(?:commit|tag|push|merge|cherry-pick|rebase|revert|am|pull|send-pack|receive-pack|http-push|update-ref|fast-import|symbolic-ref)\b/;

function protectedGitEntrypoint(executable) {
  const base = path.basename(String(executable || ''));
  const name = base.startsWith('git-') ? base.slice(4) : '';
  if (name && /[*?\[]/.test(name)) return 'unbound-git-helper';
  return name || null;
}

function unboundPlumbingCommand(name, args) {
  if (PLUMBING_DELIVERY_COMMANDS.has(name)) return true;
  if (name !== 'symbolic-ref') return false;
  if (args.some(arg => hasDynamicShellSyntax(arg) || /[*?\[]/.test(arg))) return true;
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (['-q', '--quiet', '--short', '--recurse', '--no-recurse'].includes(arg)) continue;
    if (arg.startsWith('-')) return true;
    positionals.push(arg);
  }
  return positionals.length !== 1;
}

// This is only a refusal hint for syntax that the static parser cannot bind.
// It must never authorize a command or replace decoded-operation detection.
function unparsedDeliveryHint(text, allowGeneratedExecutable = false) {
  const simplified = String(text || '').replace(/[\\'"]/g, '');
  return DELIVERY_WORDS.test(simplified) && (allowGeneratedExecutable || /\bgit\b/.test(simplified));
}
// Classify the executable only after every wrapper has been removed. These
// builtins can change the directory stack, environment, or command resolution
// inherited by a later delivery operation; the hook cannot replay that state.
const SHELL_CONTEXT_COMMANDS = new Set([
  'cd', 'chdir', 'pushd', 'popd', 'dirs',
  'export', 'unset', 'typeset', 'declare', 'readonly', 'local',
  'read', 'readarray', 'mapfile', 'getopts', 'let',
  'set', 'shift', 'setopt', 'unsetopt', 'shopt',
  'alias', 'unalias', 'hash', 'rehash', 'enable', 'disable',
  'autoload', 'unfunction', 'zmodload', 'trap', 'exec',
]);

// These supported Git variants can change the candidate, index, references,
// or configuration consumed by a later command. They remain usable alone,
// but cannot share pre-command evidence with commit/tag/push in one shell.
function gitChangesDeliveryState(invocation, profile) {
  if (profile.kind) return false; // Existing delivery/result operations already have their own gate.
  const { subcommand } = invocation;
  const has = (...names) => profile.options.some(option => names.includes(option));
  // Even a viewer may truncate a source/control file before producing output
  // or reporting a later option error. Pre-command evidence cannot cover it.
  if (profile.writesOutput) return true;
  let dryRun = false;
  for (const option of profile.options) {
    if (option === '--dry-run' || (option === '-n' && subcommand !== 'fetch')) dryRun = true;
    if (option === '--no-dry-run') dryRun = false;
  }
  if (subcommand === 'apply') return profile.appliesPatch;
  if (['checkout', 'switch', 'reset', 'restore', 'init', 'clone'].includes(subcommand)) return true;
  if (['add', 'rm', 'mv', 'clean', 'fetch'].includes(subcommand)) {
    // fetch -n is --no-tags, whereas -n is dry-run for these worktree commands.
    return !dryRun;
  }
  if (subcommand === 'branch') return profile.variant !== 'branch-list'
    || has('-d', '--delete', '-D', '-m', '--move', '-M', '-c', '--copy', '-C', '--set-upstream-to', '--unset-upstream');
  if (subcommand === 'stash') return !['show', 'list', 'create'].includes(profile.positionals[0]);
  if (subcommand === 'tag') return profile.variant === 'tag-delete';
  if (subcommand === 'reflog') return !dryRun && ['delete', 'expire', 'drop'].includes(profile.positionals[0]);
  if (subcommand === 'remote') return profile.positionals.length > 0 && !['show', 'get-url'].includes(profile.positionals[0])
    && !(profile.positionals[0] === 'prune' && dryRun);
  return false;
}

function commandDeliveryInfo(command, depth = 0, cwd = process.cwd(), environment = process.env) {
  if (depth > 6) throw new Error('shell command nesting exceeds verification parser limit');
  const kinds = new Set();
  const operations = [];
  const candidateMutations = [];
  const ambiguous = [];
  const contextProblems = [];
  let hasGit = false;
  let shellEnvironmentProblem = Object.entries(environment).some(([name, value]) => shellStartupEnvironment(name) && value);
  if (depth === 0 && shellEnvironmentProblem) {
    contextProblems.push('inherited shell startup environment is unverified');
  }
  const rawCommand = String(command || '');
  // Shell removes backslash-newline before tokenization, but the gate must not
  // silently authorize the normalized command: the raw spelling is ambiguous.
  const normalizedCommand = rawCommand.replace(/\\\r?\n/g, '');
  if (/\\\r?\n/.test(rawCommand)) {
    contextProblems.push('backslash-newline around a delivery command cannot be bound safely');
  }
  command = normalizedCommand;
  const substitutions = commandSubstitutions(command);
  for (const substitution of substitutions) {
    if (substitution.ambiguous) {
      kinds.add('ambiguous');
      ambiguous.push('nested or escaped legacy backtick substitution cannot be parsed safely');
      continue;
    }
    const nested = commandDeliveryInfo(substitution.inner, depth + 1, cwd, environment);
    hasGit ||= nested.hasGit;
    for (const kind of nested.kinds) kinds.add(kind);
    operations.push(...nested.operations);
    candidateMutations.push(...nested.candidateMutations);
    ambiguous.push(...nested.ambiguous);
    contextProblems.push(...nested.contextProblems);
  }
  const tokens = shellTokens(commandWithSubstitutionMarkers(command, substitutions));
  if (tokens.some(token => token.type === 'operator' && token.adjacent)) {
    contextProblems.push('redirection adjacent to a delivery command token cannot be bound safely');
  }
  if (tokens.some(token => token.type === 'operator' && ['{', '}'].includes(token.value))) {
    contextProblems.push('shell control structure around a delivery operation cannot be bound safely');
  }
  const separators = new Set([';', '&&', '||', '|', '&', '(', ')', '{', '}', '<', '>']);
  let segment = [];
  let currentCwd = cwd;
  const canReplayDirectory = substitutions.length === 0
    && !tokens.some(token => token.type === 'operator' && ['||', '|', '&', '(', ')', '{', '}', '<', '>'].includes(token.value));
  const inspect = words => {
    if (!words.length) return;
    let commandCwd = currentCwd;
    let commandEnvironment = { ...environment };
    let changesCurrentShell = true;
    let i = 0;
    const leadingAssignments = [];
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
      leadingAssignments.push(words[i]);
      applyEnvironmentAssignment(commandEnvironment, words[i]);
      i += 1;
    }
    if (leadingAssignments.some(word => shellStartupEnvironment(assignmentName(word) || ''))) {
      kinds.add('ambiguous'); ambiguous.push('shell execution environment assignment cannot be bound safely'); return;
    }
    let exe = words[i];
    if (!exe) {
      if (leadingAssignments.some(word => shellStartupEnvironment(assignmentName(word) || ''))) shellEnvironmentProblem = true;
      if (leadingAssignments.some(word => assignmentMayRewriteGit(word) || GIT_CALLBACK_ENVIRONMENT.has(assignmentName(word)))) {
        contextProblems.push('shell assignments change later Git execution context');
      }
      return;
    }
    let base = path.basename(exe);
    while (COMMAND_WRAPPERS.has(base)) {
      if (!['command', 'builtin'].includes(base)) changesCurrentShell = false;
      const wrapperStart = i;
      i = wrappedCommandIndex(words, i, base);
      const wrapperControls = words.slice(wrapperStart + 1, i);
      if (wrapperControls.some(hasUnboundShellWord)) {
        kinds.add('ambiguous');
        ambiguous.push(`dynamic shell syntax may generate ${base} wrapper options or Git-affecting environment`);
        return;
      }
      if (wrapperControls.some(assignmentMayRewriteGit)) {
        contextProblems.push(`${base} assignments change Git or shell startup context`);
      }
      if (wrapperControls.some(word => shellStartupEnvironment(assignmentName(word) || ''))) shellEnvironmentProblem = true;
      if (base === 'env' && wrapperControls.some(word => /^-S|^--split-string(?:=|$)/.test(word))) {
        kinds.add('ambiguous');
        ambiguous.push('env split-string performs an unverified command parse');
        return;
      }
      const context = wrapperContext(base, wrapperControls, commandCwd, commandEnvironment);
      if (context.error) {
        contextProblems.push(context.error);
      } else { commandCwd = context.cwd; commandEnvironment = context.environment; }
      exe = words[i];
      base = exe ? path.basename(exe) : '';
      if (!exe) return;
    }
    if (['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac'].includes(base)) {
      contextProblems.push('shell control structure around a delivery operation cannot be bound safely');
    }
    const gitEntrypoint = protectedGitEntrypoint(base);
    if (gitEntrypoint && (gitEntrypoint !== 'symbolic-ref' || unboundPlumbingCommand(gitEntrypoint, words.slice(i + 1)))) {
      kinds.add('ambiguous');
      ambiguous.push('standalone Git delivery executables cannot be bound to verified candidate evidence');
      return;
    }
    if (base !== 'git' && !SHELL_EXECUTABLES.has(base)
        && !['echo', 'printf'].includes(base)
        && words.slice(i + 1).some(word => path.basename(String(word || '')) === 'git'
          || protectedGitEntrypoint(word)
          || SHELL_EXECUTABLES.has(path.basename(String(word || '')))
          || String(word).includes(SHELL_ENCODED_WORD_MARKER) || /\$['"]/.test(word)
          || unparsedDeliveryHint(word))) {
      kinds.add('ambiguous');
      ambiguous.push(`unknown wrapper or shell control token before git: ${base}`);
      return;
    }
    if (/[*?\[]/.test(exe)) {
      kinds.add('ambiguous');
      ambiguous.push('globbed executable cannot be bound to a static command');
      return;
    }
    if (SHELL_CONTEXT_COMMANDS.has(base)
        || (base === 'printf' && words.slice(i + 1).some(word => /^-v/.test(word)))) {
      if (words.slice(i + 1).some(word => shellStartupEnvironment(assignmentName(word) || word))) {
        kinds.add('ambiguous'); ambiguous.push('shell execution environment mutation cannot be bound safely'); return;
      }
      if (['cd', 'chdir'].includes(base) && canReplayDirectory && changesCurrentShell) {
        const dirs = words.slice(i + 1);
        if (dirs[0] === '--') dirs.shift();
        const dir = dirs[0];
        if (dirs.length === 1 && dir && !dir.startsWith('-') && !hasDynamicShellSyntax(dir)
            && !/[*?\[~]/.test(dir)
            && (!commandEnvironment.CDPATH || path.isAbsolute(dir) || /^\.{1,2}(?:\/|$)/.test(dir))) {
          try {
            const logical = path.resolve(currentCwd, dir);
            const resolved = fs.realpathSync(logical);
            if (fs.statSync(resolved).isDirectory()) {
              currentCwd = logical;
              contextProblems.push('static cd changes later Git execution context');
              return;
            }
          } catch { /* Keep the context unbound if the actual cd can fail. */ }
        }
      }
      contextProblems.push(`${base} changes later Git execution context`);
      return;
    }
    if (hasDynamicShellSyntax(exe)) {
      kinds.add('ambiguous');
      ambiguous.push('dynamic shell syntax may generate the executable');
      return;
    }
    if (['eval', 'source', '.'].includes(base)) {
      kinds.add('ambiguous');
      ambiguous.push(`${base} performs a second shell parse that cannot be bound to a static delivery command`);
      return;
    }
    if (base === 'git') {
      hasGit = true;
      const repositoryOverride = ['GIT_DIR', 'GIT_COMMON_DIR'].find(name => commandEnvironment[name] !== undefined);
      if (repositoryOverride) {
        kinds.add('ambiguous');
        ambiguous.push(`${repositoryOverride} repository override cannot be bound safely`);
        return;
      }
      if (shellEnvironmentProblem || leadingAssignments.some(word => shellStartupEnvironment(assignmentName(word) || ''))) {
        kinds.add('ambiguous'); ambiguous.push('shell execution environment cannot be bound safely'); return;
      }
      const rawGitArgs = words.slice(i + 1);
      if (rawGitArgs.some(hasUnboundShellWord)) {
        kinds.add('ambiguous');
        ambiguous.push('encoded or expanded Git arguments cannot be bound to static execution');
        return;
      }
      if (rawGitArgs.some((word, index) => /^alias\.[^=]+=/.test(word)
          || ((word === '-c' || word === '--config-env') && /^alias\./.test(rawGitArgs[index + 1] || ''))
          || /^-calias\./.test(word))) {
        kinds.add('ambiguous');
        ambiguous.push('Git alias configuration can rewrite the protected subcommand');
        return;
      }
      if (leadingAssignments.some(hasUnboundShellWord) || leadingAssignments.some(assignmentMayRewriteGit)) {
        kinds.add('ambiguous');
        ambiguous.push('leading environment assignments may dynamically rewrite Git behavior');
        return;
      }
      const invocation = gitInvocation(words.slice(i + 1));
      const sub = invocation.subcommand;
      if (hasDynamicShellSyntax(sub) || invocation.prefixArgs.some(hasUnboundShellWord)) {
        kinds.add('ambiguous');
        ambiguous.push('dynamic shell syntax may generate the Git subcommand or global target');
        return;
      }
      const configProblem = explicitGitConfigurationProblem(invocation.prefixArgs);
      if (configProblem || (sub && !SUPPORTED_GIT_COMMANDS.has(sub) && !PLUMBING_DELIVERY_COMMANDS.has(sub))) {
        kinds.add('ambiguous'); ambiguous.push(configProblem || `unsupported Git extension ${sub}`); return;
      }
      const effectiveConfig = effectiveGitConfiguration(invocation, commandCwd, commandEnvironment);
      const profile = effectiveConfig && gitCommandProfile(invocation, effectiveConfig);
      const callbackProblem = profile && gitCallbackProblem(invocation, commandCwd, effectiveConfig, profile, commandEnvironment);
      const fetchProblem = profile && sub === 'fetch' && fetchTargetProblem(invocation, effectiveConfig, profile, commandCwd);
      if (!effectiveConfig || callbackProblem || fetchProblem) {
        kinds.add('ambiguous'); ambiguous.push(callbackProblem || fetchProblem || 'effective Git configuration is unavailable'); return;
      }
      if (unboundPlumbingCommand(sub, invocation.args)) {
        kinds.add('ambiguous');
        ambiguous.push('low-level Git ref or remote delivery cannot be bound to verified candidate evidence');
        return;
      }
      const kind = profile.kind;
      if (!kind && sub) {
        const alias = effectiveGitAlias(invocation.prefixArgs, sub, commandCwd);
        if (alias.exists || alias.uncertain) {
          kinds.add('ambiguous');
          ambiguous.push(alias.exists
            ? `effective Git alias ${sub} can rewrite the protected subcommand`
            : `effective Git alias configuration for ${sub} could not be resolved`);
          return;
        }
      }
      if (kind === 'tag') {
        const target = tagTargetRevision(invocation.args, profile);
        if (!target.error && [target.name, target.revision].some(value => hasUnboundShellWord(value))) {
          kinds.add('ambiguous');
          ambiguous.push('command substitution may generate the tag name or target');
          return;
        }
      }
      if (kind === 'push') {
        const target = pushSourceRevision(invocation.args);
        if (!target.error && [target.destination, target.refspec, target.revision].some(value => hasUnboundShellWord(value))) {
          kinds.add('ambiguous');
          ambiguous.push('command substitution may generate the push destination or refspec');
          return;
        }
      }
      if (kind) {
        kinds.add(kind);
        operations.push({ kind, subcommand: sub, args: invocation.args, prefixArgs: invocation.prefixArgs, cwd: commandCwd, profile, config: effectiveConfig });
      }
      if (gitChangesDeliveryState(invocation, profile)) candidateMutations.push({ subcommand: sub, cwd: commandCwd });
      return;
    }
    if (SHELL_EXECUTABLES.has(base)) {
      if (shellEnvironmentProblem || leadingAssignments.some(word => shellStartupEnvironment(assignmentName(word) || ''))) {
        kinds.add('ambiguous'); ambiguous.push('shell execution environment cannot be bound safely'); return;
      }
      if (leadingAssignments.some(hasUnboundShellWord)
          || words.slice(i + 1).some(hasUnboundShellWord)) {
        kinds.add('ambiguous');
        ambiguous.push('dynamic shell syntax may generate shell options, script path, or the -c command string');
        return;
      }
      if (leadingAssignments.some(assignmentMayRewriteGit)) {
        contextProblems.push('shell assignments change Git or shell startup context');
      }
      const startupProblem = shellStartupProblem(words, i, base);
      if (startupProblem) contextProblems.push(startupProblem);
      const nestedCommand = shellCommandString(words, i);
      if (nestedCommand !== null) {
        if (/^[+-]/.test(nestedCommand)) {
          kinds.add('ambiguous');
          ambiguous.push('shell options after -c make the command string boundary ambiguous');
          return;
        }
        const nested = commandDeliveryInfo(nestedCommand, depth + 1, commandCwd, commandEnvironment);
        hasGit ||= nested.hasGit;
        for (const kind of nested.kinds) kinds.add(kind);
        operations.push(...nested.operations);
        candidateMutations.push(...nested.candidateMutations);
        ambiguous.push(...nested.ambiguous);
        contextProblems.push(...nested.contextProblems);
      } else if (shellReadsStdin(words, i)) {
        kinds.add('ambiguous');
        ambiguous.push('shell commands read from stdin cannot be bound to static delivery operations');
      }
    }
  };
  for (const token of tokens) {
    if (token.type === 'operator' && separators.has(token.value)) { inspect(segment); segment = []; }
    else segment.push(token.value);
  }
  inspect(segment);
  if (candidateMutations.length && ['commit', 'tag', 'push'].some(kind => kinds.has(kind))) {
    kinds.add('ambiguous');
    ambiguous.push('Git state-changing commands cannot share pre-command evidence with delivery; split the commands and verify the resulting candidate');
  }
  // Apply context constraints to decoded operations, including nested shells
  // and substitutions. Raw spelling cannot determine whether delivery occurs.
  const relevantContextProblems = operations.length
    || unparsedDeliveryHint(rawCommand, tokens.some(token => token.type === 'operator' && ['{', '}'].includes(token.value)))
    ? contextProblems : hasGit ? contextProblems.filter(problem => problem !== 'static cd changes later Git execution context') : [];
  if (relevantContextProblems.length) {
    kinds.add('ambiguous');
    ambiguous.push(...relevantContextProblems);
  }
  return { kinds, operations, candidateMutations, ambiguous, contextProblems, hasGit };
}

function gitContextArgs(operation, args) {
  return gitReadArgs(operation.prefixArgs, args);
}

function toolCommandContext(input) {
  try {
    const resolveDirectory = (value, base) => {
      if (typeof value !== 'string' || !value.trim()) throw new Error('tool cwd must be a nonempty directory path');
      return physicalDirectory(value, base);
    };
    const base = input.cwd === undefined ? process.cwd() : resolveDirectory(input.cwd, process.cwd());
    const tool = input.tool_input || {};
    const overrides = ['cwd', 'workdir'].filter(key => tool[key] !== undefined)
      .map(key => resolveDirectory(tool[key], base));
    if (new Set(overrides).size > 1) throw new Error('tool cwd and workdir disagree');
    return { cwd: overrides[0] || base };
  } catch {
    return { cwd: process.cwd(), error: 'actual tool working directory could not be bound safely' };
  }
}

function repositoryContextProblem(operation) {
  if (operation.prefixArgs.some(arg => /^--(?:namespace|super-prefix|config-env|exec-path)(?:=|$)/.test(arg))) {
    return { code: 'GIT_DELIVERY_REPOSITORY_UNBOUND', message: 'Git global context cannot be bound safely' };
  }
  const readContext = (cwd, args) => {
    const output = execFileSync('git', gitReadArgs(args, ['rev-parse', '--show-toplevel', '--absolute-git-dir']), {
      cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n');
    if (output.length !== 2) throw new Error('Git context is unavailable');
    return output.map(value => physicalDirectory(value, cwd));
  };
  try {
    const expected = readContext(ROOT, []);
    const actual = readContext(operation.cwd, gitContextArgs(operation, []));
    if (actual[0] !== physicalDirectory(ROOT, process.cwd()) || actual.some((value, index) => value !== expected[index])) {
      return { code: 'GIT_DELIVERY_REPOSITORY_MISMATCH', message: 'effective Git worktree or Git directory differs from the evidence repository' };
    }
    return null;
  } catch (error) {
    const detail = error.code === 'ETIMEDOUT' ? 'Git context query exceeded its 2000ms deadline'
      : error.code ? `context query failed (${String(error.code).replace(/[^A-Z0-9_]/g, '')})`
        : Number.isInteger(error.status) ? `Git context query exited ${error.status}` : 'Git context or filesystem identity is unavailable';
    return { code: 'GIT_DELIVERY_REPOSITORY_UNBOUND', message: `effective Git repository could not be resolved: ${detail}` };
  }
}

function pushConfigurationProblem(operation, target) {
  if (gitBoolean(operation.config.get(`remote.${target.destination}.mirror`))) {
    return { code: 'GIT_DELIVERY_TARGET_UNBOUND', message: 'remote mirror configuration expands unverified references' };
  }
  const configuration = {};
  for (const [key, allowed, boolean] of [
    ['push.followTags', ['true', 'false'], true],
    ['push.recurseSubmodules', ['no', 'check', 'on-demand', 'only'], false],
    ['submodule.recurse', ['true', 'false'], true],
  ]) {
    const args = ['config', ...(boolean ? ['--type=bool'] : []), '--get', key];
    const result = spawnSync('git', gitContextArgs(operation, args), {
      cwd: operation.cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const value = String(result.stdout || '').trim();
    if (result.error || result.signal || ![0, 1].includes(result.status)
        || (result.status === 0 && !allowed.includes(value)) || (result.status === 1 && value)) {
      return { code: 'GIT_DELIVERY_CONFIG_UNAVAILABLE', message: `effective ${key} configuration could not be read` };
    }
    configuration[key] = value;
  }
  if (configuration['push.followTags'] === 'true' && !target.noFollowTags) {
    return { code: 'GIT_DELIVERY_TARGET_UNBOUND', message: 'push.followTags can deliver additional unverified tag references; use --no-follow-tags or verify each ref separately' };
  }
  const recurse = configuration['push.recurseSubmodules']
    || (configuration['submodule.recurse'] === 'true' ? 'on-demand' : 'no');
  if (['on-demand', 'only'].includes(recurse)) {
    return { code: 'GIT_DELIVERY_TARGET_UNBOUND', message: 'effective recursive push configuration can deliver unverified submodule repositories' };
  }
  return null;
}

function resolveCommit(revision, operation) {
  try {
    return execFileSync('git', gitContextArgs(operation, ['rev-parse', '--verify', `${revision}^{commit}`]), {
      cwd: operation.cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function tagTargetRevision(args, parsed = tagArgumentInfo(args)) {
  const { positionals } = parsed;
  if (positionals.length < 1) return { error: 'git tag creation is missing a tag name' };
  if (positionals.length > 2) return { error: 'git tag target could not be determined safely' };
  return { name: positionals[0], revision: positionals[1] || 'HEAD' };
}

function pushSourceRevision(args) {
  const forbidden = new Set(['--all', '--mirror', '--tags', '--delete', '-d', '--prune', '--follow-tags']);
  const valueOptions = new Set(['--repo', '--receive-pack', '--exec', '--force-with-lease', '--force-if-includes', '--push-option']);
  const positionals = [];
  let noFollowTags = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (forbidden.has(arg) || /^--(?:all|mirror|tags|delete|prune|follow-tags)=/.test(arg)) {
      return { error: `git push option ${arg} can deliver multiple or unbound references` };
    }
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (arg === '--no-follow-tags') { noFollowTags = true; continue; }
    if (valueOptions.has(arg)) {
      // --force-with-lease may omit its optional value; treat the next non-option as destination.
      if (arg === '--force-with-lease' || arg === '--force-if-includes') continue;
      if (args[i + 1] === undefined) return { error: `git push option ${arg} requires a value` };
      i += 1; continue;
    }
    if (/^--(?:repo|receive-pack|exec|force-with-lease|push-option)=/.test(arg) || /^--signed=(?:true|false|if-asked)$/.test(arg)) continue;
    if (['-u', '--set-upstream', '-n', '--dry-run', '--porcelain', '-q', '--quiet', '-v', '--verbose', '--atomic', '--signed', '--no-signed', '--no-follow-tags', '--no-verify', '--force-with-lease', '--force-if-includes'].includes(arg)) continue;
    if (arg.startsWith('-')) return { error: `unsupported git push option ${arg}` };
    positionals.push(arg);
  }
  if (positionals.length !== 2) return { error: 'git push must name one destination and exactly one source refspec' };
  let refspec = positionals[1];
  if (refspec.startsWith('+')) refspec = refspec.slice(1);
  const source = refspec.split(':', 1)[0];
  if (!source || source.includes('*')) return { error: 'git push source refspec is empty or wildcarded' };
  return { destination: positionals[0], refspec: positionals[1], revision: source, noFollowTags };
}

function bindPushDestination(operation, target) {
  const refspec = target.refspec.replace(/^\+/, '');
  if (refspec.includes(':')) { target.resolvedDestination = refspec.slice(refspec.indexOf(':') + 1); return null; }
  const symbolic = spawnSync('git', gitContextArgs(operation, ['rev-parse', '--symbolic-full-name', '--verify', target.revision]), {
    cwd: operation.cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (symbolic.error || symbolic.signal || symbolic.status !== 0) return 'push source symbolic identity could not be resolved';
  const sourceRef = String(symbolic.stdout).trim();
  const mappings = String(operation.config.get(`remote.${target.destination}.push`) || '').split('\n').filter(Boolean);
  const destinations = [];
  for (const mapping of mappings) {
    const ref = mapping.replace(/^\+/, '');
    if (hasDynamicShellSyntax(ref) || ref.includes('*') || ref === ':' || ref.startsWith('^')) return 'configured push mapping is not one static reference';
    const [source, destination, extra] = ref.split(':');
    if (!source || extra !== undefined) return 'configured push mapping cannot be bound';
    if (sourceRef && source === sourceRef) {
      destinations.push(destination === undefined ? sourceRef : destination);
    }
  }
  if (destinations.length > 1) return 'configured push mapping has multiple matching destinations';
  if (destinations.length === 1) { target.resolvedDestination = destinations[0]; return null; }
  // Git applies push.default=upstream (or its old name tracking) to named
  // source branches even when the explicitly named remote is different.
  const pushDefault = operation.config.get('push.default');
  if (['upstream', 'tracking'].includes(pushDefault) && sourceRef.startsWith('refs/heads/')) {
    const merge = operation.config.get(`branch.${sourceRef.slice('refs/heads/'.length)}.merge`);
    if (merge !== undefined) {
      if (!merge || merge.includes('\n') || hasDynamicShellSyntax(merge)) return 'upstream push destination is not one static reference';
      target.resolvedDestination = merge; return null;
    }
  }
  target.resolvedDestination = sourceRef;
  return null;
}

function pushRequiresRelease(operation, target) {
  const refspec = target.refspec.replace(/^\+/, '');
  const colon = refspec.indexOf(':');
  if (colon >= 0 && !refspec.slice(colon + 1).startsWith('refs/heads/')) return true;
  if (!target.resolvedDestination || !target.resolvedDestination.startsWith('refs/heads/')) return true;
  const source = target.revision.replace(/(?:\^\{[^}]*\})+$/, '');
  if (source.startsWith('refs/tags/')) return true;
  const symbolic = spawnSync('git', gitContextArgs(operation, ['rev-parse', '--symbolic-full-name', '--verify', source]), {
    cwd: operation.cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (symbolic.error || symbolic.signal) return true;
  if (String(symbolic.stdout || '').trim().startsWith('refs/tags/')) return true;
  const object = spawnSync('git', gitContextArgs(operation, ['cat-file', '-t', source]), {
    cwd: operation.cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return object.status !== 0 || String(object.stdout || '').trim() === 'tag';
}

function deliveryTargetProblem(operations, currentGit) {
  if (operations.length > 1) {
    return {
      code: 'GIT_DELIVERY_RESULT_UNBOUND',
      message: 'one shell invocation may contain at most one irreversible Git operation; split commit/tag/push/result-creating actions into separate verified calls',
    };
  }
  for (const operation of operations) {
    const problem = repositoryContextProblem(operation);
    if (problem) return problem;
  }
  const resultCreating = new Set(['merge', 'cherry-pick', 'rebase', 'revert', 'am', 'pull']);
  const resultOperation = operations.find(operation => resultCreating.has(operation.subcommand));
  if (resultOperation) {
    return {
      code: 'GIT_DELIVERY_RESULT_UNBOUND',
      message: `git ${resultOperation.subcommand} creates or changes the delivery candidate; pre-operation evidence cannot attest the result`,
    };
  }
  const targetOperations = operations.filter(operation => operation.kind === 'tag' || operation.kind === 'push');
  if (targetOperations.length === 0) return null;
  if (!currentGit || !currentGit.commit) return { code: 'GIT_IDENTITY_UNAVAILABLE', message: 'current Git commit is unavailable' };
  for (const operation of targetOperations) {
    let target = null;
    if (operation.kind === 'tag') target = tagTargetRevision(operation.args, operation.profile);
    if (operation.kind === 'push') target = pushSourceRevision(operation.args);
    if (!target) continue;
    if (target.error) return { code: 'GIT_DELIVERY_TARGET_UNBOUND', message: target.error };
    if (operation.kind === 'push') {
      const problem = pushConfigurationProblem(operation, target);
      if (problem) return problem;
      const destinationProblem = bindPushDestination(operation, target);
      if (destinationProblem) return { code: 'GIT_DELIVERY_TARGET_UNBOUND', message: destinationProblem };
      operation.releaseRisk = pushRequiresRelease(operation, target);
    }
    const commit = resolveCommit(target.revision, operation);
    if (!commit) return { code: 'GIT_DELIVERY_TARGET_UNRESOLVED', message: `cannot resolve delivery target ${target.revision}` };
    if (commit !== currentGit.commit) {
      return { code: 'GIT_DELIVERY_TARGET_MISMATCH', message: `delivery target ${target.revision} resolves to ${commit}, not verified HEAD ${currentGit.commit}` };
    }
  }
  return null;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const cmd = String(input.tool_input?.command || '');

    const commandContext = toolCommandContext(input);
    const deliveryInfo = commandDeliveryInfo(cmd, 0, commandContext.cwd);
    const deliveryKinds = deliveryInfo.kinds;
    const isCommit = deliveryKinds.has('commit');
    const isTag = deliveryKinds.has('tag');
    const isPush = deliveryKinds.has('push');
    const isAmbiguous = deliveryKinds.has('ambiguous');

    if (!isCommit && !isPush && !isTag && !isAmbiguous) {
      // 非 git commit/push 命令，直接透传
      return;
    }

    // HARNESS_SKIP_GATE 跳过
    if (process.env.HARNESS_SKIP_GATE === '1') {
      process.stderr.write(
        '[Verification Gate] 门控已被 HARNESS_SKIP_GATE=1 跳过，请记录原因。\n'
      );
      return;
    }

    if (isAmbiguous) {
      process.stderr.write('[Verification Gate] GIT_DELIVERY_COMMAND_AMBIGUOUS: ' + deliveryInfo.ambiguous.join('; ') + '\n');
      process.exit(2);
    }

    const invocationProblem = commandContext.error
      ? { code: 'GIT_DELIVERY_REPOSITORY_UNBOUND', message: commandContext.error }
      : repositoryContextProblem({ cwd: commandContext.cwd, prefixArgs: [] });
    if (invocationProblem) {
      process.stderr.write(`[Verification Gate] ${invocationProblem.code}: ${invocationProblem.message}\n`);
      process.exit(2);
    }

    // 在写 gate-events 等门禁自身簿记前冻结候选身份。否则 light 提示先落盘，
    // 会让门禁自己制造 GIT_CANDIDATE_MISMATCH。
    const deliveryGit = evidenceAttestation ? evidenceAttestation.readGitIdentity(ROOT) : null;
    const targetProblem = deliveryTargetProblem(deliveryInfo.operations, deliveryGit);
    if (targetProblem) {
      process.stderr.write(`[Verification Gate] ${targetProblem.code}: ${targetProblem.message}\n`);
      process.exit(2);
    }
    const releaseDelivery = isTag || deliveryInfo.operations.some(operation => operation.releaseRisk);

    // guard_mode 解析（light 下过程类检查降级为提示）
    const LIGHT = guardMode.resolveGuardMode(input, ROOT).mode === 'light';
    const emitGate = (action, gate, detail) => guardMode.appendGateEvent(ROOT, {
      gate, hook: 'verification-gate', mode: LIGHT ? 'light' : 'strict',
      action, detail, session_id: input.session_id,
    });

    // 读取当前阶段
    let stage = null;
    let stageSince = null;
    try {
      const data = JSON.parse(fs.readFileSync(STAGE_FILE, 'utf8'));
      stage = data.stage;
      stageSince = data.since ? new Date(data.since) : null;
    } catch {}

    if (!stage) {
      if (!LIGHT) {
        emitGate('deny', 'vg-stage-missing');
        process.stderr.write(
          '[Verification Gate] 无法确定当前阶段（.harness/current-stage.json 不存在或无效）。\n' +
          '→ git commit/push 需要在 Harness 阶段声明后才能执行。\n'
        );
        process.exit(2);
      }
      // light: 阶段文件可选，继续走证据检查（无 since 锚点则跳过时效性）
      stageSince = null;
    }

    // ── push 阶段检查（[过程]，light 降级为提示）──
    if (isPush) {
      if (stage && !PUSH_ALLOWED_STAGES.includes(stage)) {
        if (LIGHT) {
          emitGate('hint', 'vg-push-stage', { stage });
          process.stderr.write(
            `[Verification Gate][light 提示] 当前阶段 ${stage} 非 REVIEW，建议确认验证已完成再 push（不阻断）。\n`
          );
        } else {
          emitGate('deny', 'vg-push-stage', { stage });
          process.stderr.write(
            `[Verification Gate] push 只允许在 REVIEW 阶段。当前阶段: ${stage}。\n` +
            '→ 完成 VERIFY 和 REVIEW 后再 push。\n'
          );
          process.exit(2);
        }
      }
      // 阶段检查通过后仍必须继续执行与 commit/tag 相同的可信 evidence 校验。
    }

    // ── commit / tag 阶段检查（[过程]，light 降级为提示）──
    if (isCommit || isTag) {
      if (stage && !COMMIT_ALLOWED_STAGES.includes(stage)) {
        if (LIGHT) {
          emitGate('hint', 'vg-commit-stage', { stage });
          process.stderr.write(
            `[Verification Gate][light 提示] 当前阶段 ${stage} 非 VERIFY/REVIEW/FEEDBACK（不阻断，证据检查仍强制）。\n`
          );
        } else {
          emitGate('deny', 'vg-commit-stage', { stage });
          process.stderr.write(
            `[Verification Gate] 当前阶段 ${stage} 不允许 commit。\n` +
            `→ commit 只允许在: ${COMMIT_ALLOWED_STAGES.join(', ')}。\n` +
            '→ 先完成 EXECUTE，进入 VERIFY 产出验证证据后再 commit。\n'
          );
          process.exit(2);
        }
      }
    }

    // ── commit / tag / push 共用的验证证据检查 ──
    {
      let freshReport = null;
      for (const p of evidencePathList()) {
        try {
          const stat = fs.statSync(p);
          if (stat.isFile()) {
            freshReport = { path: p, mtime: stat.mtime };
            break;
          }
        } catch {}
      }

      if (!freshReport) {
        emitGate('deny', 'vg-no-evidence');
        process.stderr.write(
          '[Verification Gate] 未找到验证报告。\n' +
          '→ 请先完成 QA 验证，产出证据文件。\n' +
          '→ 验证报告应在: ' + evidencePathList().join(' 或 ') + '\n'
        );
        process.exit(2);
      }

      // ── 证据时效性检查 ──
      if (stageSince && freshReport.mtime < stageSince) {
        emitGate('deny', 'vg-evidence-stale');
        process.stderr.write(
          `[Verification Gate] 验证证据早于当前任务开始时间，可能是上一轮残留。\n` +
          `→ 证据文件: ${freshReport.path}（修改于 ${freshReport.mtime.toISOString()}）\n` +
          `→ 当前任务开始: ${stageSince.toISOString()}\n` +
          '→ 请重新运行验证，产出新的证据文件。\n'
        );
        process.exit(2);
      }

      // ── 结构化 evidence 检查 ──
      const structured = readStructuredEvidence(freshReport.path);
      // git commit/tag/push 都是不可逆交付动作，只接受权威结构化 evidence。
      // markdown/last-verification 只能作为人读报告，不能绕过 overall/checks/attestation。
      if (!structured) {
        const want = evidenceJsonPath();
        emitGate('deny', 'vg-no-structured-evidence', { path: freshReport.path });
        process.stderr.write(
          '[Verification Gate] git commit/tag/push 缺少结构化验证证据。\n' +
          `→ 找到的是弱证据: ${freshReport.path}（只能证明验证跑过，不含 overall/checks）\n` +
          `→ 需要: ${want}\n` +
          '→ 生成: node scripts/shk.js verify --risk <档位> --write-evidence\n'
        );
        process.exit(2);
      }
      if (structured) {
        const attestationProblem = structuredEvidenceAttestationProblem(structured, deliveryGit, isCommit);
        if (attestationProblem) {
          emitGate('deny', 'vg-evidence-attestation', { code: attestationProblem.code });
          process.stderr.write(
            `[Verification Gate] 验证证据 attestation 无效 (${attestationProblem.code})。\n` +
            `→ ${attestationProblem.message}\n` +
            '→ 重新运行 shk verify --write-evidence 后再提交。\n'
          );
          process.exit(2);
        }
        if (structured.overall !== 'READY') {
          emitGate('deny', 'vg-not-ready', { overall: structured.overall });
          process.stderr.write(
            `[Verification Gate] 结构化验证证据未 READY: overall=${structured.overall || 'UNKNOWN'}。\n` +
            `→ 证据文件: ${freshReport.path}\n` +
            '→ 请重新运行 `shk verify --risk <level> --write-evidence`，修复 FAIL 项后再提交。\n'
          );
          process.exit(2);
        }
        const sufficiencyBlockers = e2eSufficiencyEvidenceBlockers(structured, releaseDelivery ? 'release' : 'medium');
        if (sufficiencyBlockers.length > 0) {
          emitGate('deny', 'vg-e2e-sufficiency');
          process.stderr.write(
            '[Verification Gate] E2E sufficiency 证据不足。\n' +
            '→ 具体问题: ' + sufficiencyBlockers.join('; ') + '\n' +
            '→ E2E PASS 不等于可以交付；medium/high/release 必须证明 E2E 覆盖了本次风险。\n'
          );
          process.exit(2);
        }
        const requiredRisk = releaseDelivery ? 'release' : 'low';
        const evidenceRisk = structured.risk || 'low';
        if ((RISK_ORDER[evidenceRisk] || 0) < RISK_ORDER[requiredRisk]) {
          emitGate('deny', 'vg-risk-level', { evidence: evidenceRisk, required: requiredRisk });
          process.stderr.write(
            `[Verification Gate] 验证证据风险等级不足: evidence=${evidenceRisk}, required=${requiredRisk}。\n` +
            `→ 证据文件: ${freshReport.path}\n`
          );
          process.exit(2);
        }
        if (releaseDelivery) {
          const releaseBlockers = releaseEvidenceBlockers(structured);
          if (releaseBlockers.length > 0) {
            emitGate('deny', 'vg-release-blockers');
            process.stderr.write(
              '[Verification Gate] release tag 被阻止：发布风险必须有完整 E2E/runtime 证据。\n' +
              '→ 具体问题: ' + releaseBlockers.join('; ') + '\n' +
              '→ 如果 runtime 只能 DEGRADED，报告里必须原样说明，不能当作 PASS。\n'
            );
            process.exit(2);
          }
        }
      }

      // ── C-GATE-07: 用户入口变更三模式证据检查（kit 仓库专用）──
      if (fs.existsSync(KIT_MARKER_FILE)) {
        const staged = getStagedFiles();
        if (staged !== null) {
          const hit = staged.filter(f => USER_ENTRY_FILES.includes(f));
          if (hit.length > 0) {
            const evidence = readAllEvidenceText();
            const missing = RUNTIME_MARKERS.filter(m => !evidence.includes(m));
            if (missing.length > 0) {
              emitGate('deny', 'C-GATE-07', { files: hit });
              process.stderr.write(
                `[Verification Gate] C-GATE-07: 本次 commit 涉及用户入口文件 ${JSON.stringify(hit)}，\n` +
                `但验证证据 ${freshReport.path} 缺少以下 runtime 模式标记: ${JSON.stringify(missing)}\n` +
                `→ 要求同时覆盖三模式: ${JSON.stringify(RUNTIME_MARKERS)}\n` +
                `→ 这是 VH-12 加固：用户入口变更必须提供完整 C-GATE-04 三模式证据。\n` +
                `→ 紧急豁免: HARNESS_SKIP_GATE=1 (需在 commit message 记录原因)\n`
              );
              process.exit(2);
            }
          }
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[Verification Gate] INTERNAL_ERROR: ${err && err.message || String(err)}\n`);
    process.exit(2);
  }
  // stdout 保持为空（Codex 0.118.0 兼容，见 VH-13）
});

/**
 * 返回 git 已 stage 的文件列表（相对 repo root 的 POSIX 路径），
 * 无 git / 非仓库 / 命令失败时返回 null（保守放行，不阻塞正常流）。
 */
function getStagedFiles() {
  try {
    const out = execFileSync('git', gitReadArgs([], ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-only']), {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function readStructuredEvidence(filePath) {
  if (!filePath || !filePath.endsWith('verify-evidence.json')) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data && data.schema_version && data.checks && data.overall) return data;
  } catch {}
  return null;
}

function structuredEvidenceAttestationProblem(evidence, currentGit, requireIndexReady = false) {
  let config = {};
  try { config = ledger ? ledger.readHarnessConfig(ROOT) : JSON.parse(fs.readFileSync(path.join(ROOT, '.harness/config.json'), 'utf8')); } catch {}
  const required = Boolean(config && config.evidence && config.evidence.require_attestation === true);
  if (!evidence) return null;
  const hasAttestation = Boolean(evidence.attestation && typeof evidence.attestation === 'object');
  const hasGitIdentity = Object.prototype.hasOwnProperty.call(evidence, 'git_identity')
    || Object.prototype.hasOwnProperty.call(evidence.provenance || {}, 'git');
  if (!evidenceAttestation) {
    if (hasAttestation || required || hasGitIdentity
        || Object.prototype.hasOwnProperty.call(evidence.provenance || {}, 'applicability')
        || Object.prototype.hasOwnProperty.call(config.verification_policy || {}, 'identity_inputs')
        || Object.values(evidence.checks || {}).some(check => check && check.status === 'NOT_APPLICABLE')) {
      return {
        code: 'ATTESTATION_VERIFIER_UNAVAILABLE',
        message: 'attestation verifier module is unavailable for protected evidence or configured controls',
      };
    }
    return null;
  }
  if (required && !hasAttestation) {
    return {
      code: 'ATTESTATION_MISSING',
      message: 'attestation is required by policy but missing',
    };
  }
  const mustBindCurrent = hasAttestation || required || hasGitIdentity;
  const needsCurrentGit = requireIndexReady || mustBindCurrent;
  if (needsCurrentGit && (!currentGit || !currentGit.available || !currentGit.commit || !currentGit.tree || !currentGit.candidate_digest)) {
    return {
      code: 'GIT_IDENTITY_UNAVAILABLE',
      message: 'current Git commit, tree, or candidate digest could not be resolved',
    };
  }
  if (requireIndexReady && currentGit.index_matches_worktree !== true) {
    const paths = Array.isArray(currentGit.index_mismatch_paths) ? currentGit.index_mismatch_paths.slice(0, 5) : [];
    return {
      code: 'GIT_INDEX_CANDIDATE_MISMATCH',
      message: `Git index does not match the verified working-tree candidate${paths.length ? `: ${paths.join(', ')}` : ''}; stage the complete candidate before commit`,
    };
  }
  const result = evidenceAttestation.verifyEvidence(evidence, {
    project_root: ROOT,
    require_attestation: required,
    allow_legacy: !required,
    ...(mustBindCurrent ? {
      expected_commit: currentGit.commit,
      expected_tree: currentGit.tree,
      expected_candidate_digest: currentGit.candidate_digest,
    } : {}),
  });
  return result.status === 'PASS' ? null : result.failures[0];
}

function readAllEvidenceText() {
  let out = '';
  for (const p of evidencePathList()) {
    try {
      if (fs.statSync(p).isFile()) out += '\n' + fs.readFileSync(p, 'utf8');
    } catch {}
  }
  return out;
}


function releaseEvidenceBlockers(evidence) {
  const checks = evidence && evidence.checks || {};
  const blockers = [];
  const e2e = checks.e2e;
  const sufficiency = checks.e2e_sufficiency;
  const runtime = checks.runtime;
  if (!e2e || e2e.status !== 'PASS') blockers.push(`E2E=${e2e && e2e.status || 'MISSING'}`);
  if (!sufficiency) blockers.push('E2E sufficiency=MISSING');
  else if (sufficiency.overall !== 'READY' || sufficiency.status !== 'PASS') blockers.push(`E2E sufficiency=${sufficiency.overall || sufficiency.status || 'UNKNOWN'}`);
  if (!runtime) blockers.push('runtime=MISSING');
  else if (runtime.status !== 'PASS') blockers.push(`runtime=${runtime.status}`);
  else if (runtime.degraded === true || /\bDEGRADED\b/.test(String(runtime.stdout_tail || '') + String(runtime.stderr_tail || ''))) blockers.push('runtime=DEGRADED');
  return blockers;
}

function e2eSufficiencyEvidenceBlockers(evidence, minimumRisk) {
  const risk = evidence && evidence.risk || 'low';
  if ((RISK_ORDER[risk] || 0) < RISK_ORDER[minimumRisk]) return [];
  const checks = evidence && evidence.checks || {};
  const sufficiency = checks.e2e_sufficiency;
  if (!sufficiency) return ['e2e_sufficiency=MISSING'];
  if (sufficiency.overall !== 'READY' || sufficiency.status !== 'PASS') {
    return [`e2e_sufficiency=${sufficiency.overall || sufficiency.status || 'UNKNOWN'}`];
  }
  return [];
}

#!/usr/bin/env node
'use strict';

/**
 * Verification Gate Hook — commit/push 前的阶段和证据检查
 * @version 0.14.0 (evidence-attestation: commit/push 拒绝摘要损坏或 strict legacy 证据)
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
  let state = 'normal';
  const push = () => { if (token.length > 0) { tokens.push(token); token = ''; } };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (state === 'single') {
      if (ch === "'") state = 'normal';
      else token += ch;
      continue;
    }
    if (state === 'double') {
      if (ch === '"') state = 'normal';
      else if (ch === '\\' && i + 1 < command.length) token += command[++i];
      else token += ch;
      continue;
    }
    if (ch === "'") { state = 'single'; continue; }
    if (ch === '"') { state = 'double'; continue; }
    if (ch === '\\' && i + 1 < command.length) { token += command[++i]; continue; }
    if (/\s/.test(ch)) { push(); if (ch === '\n') tokens.push(';'); continue; }
    if (';|&(){}<>'.includes(ch)) {
      push();
      const pair = command.slice(i, i + 2);
      if (pair === '&&' || pair === '||') { tokens.push(pair); i += 1; }
      else tokens.push(ch);
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
    for (let i = start + 2; i < command.length; i += 1) {
      const ch = command[i];
      if (ch === '\\') { i += 1; continue; }
      if (state === 'single') {
        if (ch === "'") state = 'normal';
        continue;
      }
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
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === '\\') { i += 1; continue; }
    if (state === 'single') {
      if (ch === "'") state = 'normal';
      continue;
    }
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
    if (arg === '--') return { subcommand: args[i + 1] || null, args: args.slice(i + 2), prefixArgs: args.slice(0, i + 1) };
    if (takesValue.has(arg)) { if (args[i + 1] === undefined) throw new Error(`git option ${arg} requires a value`); i += 1; continue; }
    if (/^-(?:C|c).+/.test(arg)) continue;
    if (/^--(?:git-dir|work-tree|namespace|super-prefix|config-env)=/.test(arg)) continue;
    if (arg === '--exec-path') continue;
    if (arg.startsWith('--exec-path=')) continue;
    if (['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks'].includes(arg)) continue;
    if (arg.startsWith('-')) throw new Error(`unsupported git global option ${arg}`);
    return { subcommand: arg, args: args.slice(i + 1), prefixArgs: args.slice(0, i) };
  }
  return { subcommand: null, args: [], prefixArgs: args.slice() };
}

function effectiveGitAlias(prefixArgs, subcommand) {
  if (!subcommand || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(subcommand)) {
    return { exists: false, uncertain: true };
  }
  const args = prefixArgs.filter(arg => arg !== '--').concat(['config', '--get', `alias.${subcommand}`]);
  const result = spawnSync('git', args, {
    cwd: ROOT, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    return { exists: false, uncertain: true };
  }
  return { exists: result.status === 0, uncertain: false };
}

function isTagCreation(args) {
  if (!args.length) return false;
  const readOnly = new Set(['-l', '--list', '-d', '--delete', '-v', '--verify']);
  if (args.some(arg => readOnly.has(arg) || /^--(?:list|contains|no-contains|points-at|merged|no-merged|sort|format|column)(?:=|$)/.test(arg))) return false;
  return args.some(arg => !arg.startsWith('-') || ['-a', '--annotate', '-s', '--sign', '-u', '--local-user', '-m', '--message', '-F', '--file', '-f', '--force'].includes(arg));
}

function wrappedCommandIndex(words, start, base) {
  let i = start + 1;
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
    nohup: { value: new Set([]), flag: new Set([]), attached: /$a/, equals: /$a/ },
  };
  const schema = schemas[base] || schemas.nohup;
  while (i < words.length) {
    const arg = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { i += 1; continue; }
    if (arg === '--') { i += 1; break; }
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

const SHELL_SUBSTITUTION_MARKER = '__SHK_COMMAND_SUBSTITUTION__';

function hasDynamicShellSyntax(value) {
  const text = String(value || '');
  return text.includes(SHELL_SUBSTITUTION_MARKER)
    || /\$(?:\{|[A-Za-z_0-9@*#?$!\-])/.test(text)
    || /(?:^|[^\\])[<>]\(/.test(text);
}

function assignmentName(word) {
  const match = String(word || '').match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  return match ? match[1] : null;
}

function assignmentMayRewriteGit(word) {
  const name = assignmentName(word);
  return Boolean(name && (
    name === 'PATH' || name === 'HOME' || name === 'XDG_CONFIG_HOME'
    || name.startsWith('GIT_CONFIG_') || name === 'GIT_CONFIG_PARAMETERS'
    || name === 'GIT_EXEC_PATH' || name === 'GIT_DIR' || name === 'GIT_WORK_TREE'
    || name.startsWith('LD_') || name.startsWith('DYLD_')
  ));
}

function commandDeliveryInfo(command, depth = 0) {
  if (depth > 6) throw new Error('shell command nesting exceeds verification parser limit');
  const kinds = new Set();
  const operations = [];
  const ambiguous = [];
  const rawCommand = String(command || '');
  // Shell removes backslash-newline before tokenization, but the gate must not
  // silently authorize the normalized command: the raw spelling is ambiguous.
  const normalizedCommand = rawCommand.replace(/\\\r?\n/g, '');
  const mayReachDelivery = /\bgit\b[\s\S]*\b(?:commit|tag|push|merge|cherry-pick|rebase|revert|am|pull)\b/.test(normalizedCommand);
  if (mayReachDelivery && /\\\r?\n/.test(rawCommand)) {
    kinds.add('ambiguous');
    ambiguous.push('backslash-newline around a delivery command cannot be bound safely');
    return { kinds, operations, ambiguous };
  }
  if (mayReachDelivery && /(?:\S[<>]|[<>]\S)/.test(rawCommand)) {
    kinds.add('ambiguous');
    ambiguous.push('redirection adjacent to a delivery command token cannot be bound safely');
    return { kinds, operations, ambiguous };
  }
  command = normalizedCommand;
  if (/\bgit\b[\s\S]*\b(?:commit|tag|push|merge|cherry-pick|rebase|revert|am|pull)\b/.test(command)
      && (/[{}]/.test(command) || /(?:^|[;\s])(?:if|then|else|elif|fi|for|while|until|do|done|case|esac)(?:[;\s]|$)/.test(command))) {
    kinds.add('ambiguous');
    ambiguous.push('shell control structure around a delivery operation cannot be bound safely');
    return { kinds, operations, ambiguous };
  }
  const substitutions = commandSubstitutions(command);
  for (const substitution of substitutions) {
    if (substitution.ambiguous) {
      kinds.add('ambiguous');
      ambiguous.push('nested or escaped legacy backtick substitution cannot be parsed safely');
      continue;
    }
    const nested = commandDeliveryInfo(substitution.inner, depth + 1);
    for (const kind of nested.kinds) kinds.add(kind);
    operations.push(...nested.operations);
    ambiguous.push(...nested.ambiguous);
  }
  const tokens = shellTokens(commandWithSubstitutionMarkers(command, substitutions));
  const separators = new Set([';', '&&', '||', '|', '&', '(', ')', '{', '}', '<', '>']);
  let segment = [];
  const inspect = words => {
    if (!words.length) return;
    let i = 0;
    const leadingAssignments = [];
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
      leadingAssignments.push(words[i]);
      i += 1;
    }
    let exe = words[i];
    if (!exe) return;
    let base = path.basename(exe);
    const laterGit = words.slice(i + 1).some(word => path.basename(String(word || '')) === 'git');
    if (base !== 'git' && laterGit && !['env', 'command', 'nohup', 'sudo'].includes(base)) {
      kinds.add('ambiguous');
      ambiguous.push(`unknown wrapper or shell control token before git: ${base}`);
      return;
    }
    const deliveryWords = new Set(['commit', 'tag', 'push', 'merge', 'cherry-pick', 'rebase', 'revert', 'am', 'pull']);
    if (/[*?\[]/.test(exe) && words.slice(i + 1).some(word => deliveryWords.has(word))) {
      kinds.add('ambiguous');
      ambiguous.push('globbed executable may resolve to git for a delivery operation');
      return;
    }
    while (['env', 'command', 'nohup', 'sudo'].includes(base)) {
      const wrapperStart = i;
      i = wrappedCommandIndex(words, i, base);
      const wrapperControls = words.slice(wrapperStart + 1, i);
      if (wrapperControls.some(hasDynamicShellSyntax) || wrapperControls.some(assignmentMayRewriteGit)) {
        kinds.add('ambiguous');
        ambiguous.push(`dynamic shell syntax may generate ${base} wrapper options or Git-affecting environment`);
        return;
      }
      exe = words[i];
      base = exe ? path.basename(exe) : '';
      if (!exe) return;
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
      const rawGitArgs = words.slice(i + 1);
      if (rawGitArgs.some((word, index) => /^alias\.[^=]+=/.test(word)
          || ((word === '-c' || word === '--config-env') && /^alias\./.test(rawGitArgs[index + 1] || ''))
          || /^-calias\./.test(word))) {
        kinds.add('ambiguous');
        ambiguous.push('Git alias configuration can rewrite the protected subcommand');
        return;
      }
      if (leadingAssignments.some(hasDynamicShellSyntax) || leadingAssignments.some(assignmentMayRewriteGit)) {
        kinds.add('ambiguous');
        ambiguous.push('leading environment assignments may dynamically rewrite Git behavior');
        return;
      }
      const invocation = gitInvocation(words.slice(i + 1));
      const sub = invocation.subcommand;
      if (hasDynamicShellSyntax(sub) || invocation.prefixArgs.some(hasDynamicShellSyntax)) {
        kinds.add('ambiguous');
        ambiguous.push('dynamic shell syntax may generate the Git subcommand or global target');
        return;
      }
      let kind = null;
      const resultCreating = new Set(['merge', 'cherry-pick', 'rebase', 'revert', 'am', 'pull']);
      if (sub === 'commit' || resultCreating.has(sub)) kind = 'commit';
      else if (sub === 'tag' && isTagCreation(invocation.args)) kind = 'tag';
      else if (sub === 'push') kind = 'push';
      if (!kind && sub) {
        const alias = effectiveGitAlias(invocation.prefixArgs, sub);
        if (alias.exists || alias.uncertain) {
          kinds.add('ambiguous');
          ambiguous.push(alias.exists
            ? `effective Git alias ${sub} can rewrite the protected subcommand`
            : `effective Git alias configuration for ${sub} could not be resolved`);
          return;
        }
      }
      if (kind === 'tag') {
        const target = tagTargetRevision(invocation.args);
        if (!target.error && [target.name, target.revision].some(value => hasDynamicShellSyntax(value))) {
          kinds.add('ambiguous');
          ambiguous.push('command substitution may generate the tag name or target');
          return;
        }
      }
      if (kind === 'push') {
        const target = pushSourceRevision(invocation.args);
        if (!target.error && [target.destination, target.refspec, target.revision].some(value => hasDynamicShellSyntax(value))) {
          kinds.add('ambiguous');
          ambiguous.push('command substitution may generate the push destination or refspec');
          return;
        }
      }
      if (kind) {
        kinds.add(kind);
        operations.push({ kind, subcommand: sub, args: invocation.args });
      }
      return;
    }
    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(base)) {
      if (leadingAssignments.some(hasDynamicShellSyntax)
          || words.slice(i + 1).some(hasDynamicShellSyntax)) {
        kinds.add('ambiguous');
        ambiguous.push('dynamic shell syntax may generate shell options, script path, or the -c command string');
        return;
      }
      const nestedCommand = shellCommandString(words, i);
      if (nestedCommand !== null) {
        const nested = commandDeliveryInfo(nestedCommand, depth + 1);
        for (const kind of nested.kinds) kinds.add(kind);
        operations.push(...nested.operations);
        ambiguous.push(...nested.ambiguous);
      }
    }
  };
  for (const token of tokens) {
    if (separators.has(token)) { inspect(segment); segment = []; }
    else segment.push(token);
  }
  inspect(segment);
  return { kinds, operations, ambiguous };
}

function resolveCommit(revision) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
      cwd: ROOT, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function tagTargetRevision(args) {
  const valueOptions = new Set(['-u', '--local-user', '-m', '--message', '-F', '--file', '--cleanup']);
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (valueOptions.has(arg)) {
      if (args[i + 1] === undefined) return { error: `git tag option ${arg} requires a value` };
      i += 1; continue;
    }
    if (/^--(?:local-user|message|file|cleanup)=/.test(arg) || /^-(?:u|m|F).+/.test(arg)) continue;
    if (arg.startsWith('-')) continue;
    positionals.push(arg);
  }
  if (positionals.length < 1) return { error: 'git tag creation is missing a tag name' };
  if (positionals.length > 2) return { error: 'git tag target could not be determined safely' };
  return { name: positionals[0], revision: positionals[1] || 'HEAD' };
}

function pushSourceRevision(args) {
  const forbidden = new Set(['--all', '--mirror', '--tags', '--delete', '-d', '--prune']);
  const valueOptions = new Set(['--repo', '--receive-pack', '--exec', '--force-with-lease', '--force-if-includes', '--push-option']);
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (forbidden.has(arg) || /^--(?:all|mirror|tags|delete|prune)=/.test(arg)) {
      return { error: `git push option ${arg} can deliver multiple or unbound references` };
    }
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (valueOptions.has(arg)) {
      // --force-with-lease may omit its optional value; treat the next non-option as destination.
      if (arg === '--force-with-lease' || arg === '--force-if-includes') continue;
      if (args[i + 1] === undefined) return { error: `git push option ${arg} requires a value` };
      i += 1; continue;
    }
    if (/^--(?:repo|receive-pack|exec|force-with-lease|push-option)=/.test(arg)) continue;
    if (['-u', '--set-upstream', '-n', '--dry-run', '--porcelain', '-q', '--quiet', '-v', '--verbose', '--atomic', '--signed', '--no-signed', '--follow-tags', '--no-verify', '--force-with-lease', '--force-if-includes'].includes(arg)) continue;
    if (arg.startsWith('-')) return { error: `unsupported git push option ${arg}` };
    positionals.push(arg);
  }
  if (positionals.length !== 2) return { error: 'git push must name one destination and exactly one source refspec' };
  let refspec = positionals[1];
  if (refspec.startsWith('+')) refspec = refspec.slice(1);
  const source = refspec.split(':', 1)[0];
  if (!source || source.includes('*')) return { error: 'git push source refspec is empty or wildcarded' };
  return { destination: positionals[0], refspec: positionals[1], revision: source };
}

function deliveryTargetProblem(operations, currentGit) {
  if (operations.length > 1) {
    return {
      code: 'GIT_DELIVERY_RESULT_UNBOUND',
      message: 'one shell invocation may contain at most one irreversible Git operation; split commit/tag/push/result-creating actions into separate verified calls',
    };
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
    if (operation.kind === 'tag') target = tagTargetRevision(operation.args);
    if (operation.kind === 'push') target = pushSourceRevision(operation.args);
    if (!target) continue;
    if (target.error) return { code: 'GIT_DELIVERY_TARGET_UNBOUND', message: target.error };
    const commit = resolveCommit(target.revision);
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

    const deliveryInfo = commandDeliveryInfo(cmd);
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

    // 在写 gate-events 等门禁自身簿记前冻结候选身份。否则 light 提示先落盘，
    // 会让门禁自己制造 GIT_CANDIDATE_MISMATCH。
    const deliveryGit = evidenceAttestation ? evidenceAttestation.readGitIdentity(ROOT) : null;
    const targetProblem = deliveryTargetProblem(deliveryInfo.operations, deliveryGit);
    if (targetProblem) {
      process.stderr.write(`[Verification Gate] ${targetProblem.code}: ${targetProblem.message}\n`);
      process.exit(2);
    }

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
        const sufficiencyBlockers = e2eSufficiencyEvidenceBlockers(structured, isTag ? 'release' : 'medium');
        if (sufficiencyBlockers.length > 0) {
          emitGate('deny', 'vg-e2e-sufficiency');
          process.stderr.write(
            '[Verification Gate] E2E sufficiency 证据不足。\n' +
            '→ 具体问题: ' + sufficiencyBlockers.join('; ') + '\n' +
            '→ E2E PASS 不等于可以交付；medium/high/release 必须证明 E2E 覆盖了本次风险。\n'
          );
          process.exit(2);
        }
        const requiredRisk = isTag ? 'release' : 'low';
        const evidenceRisk = structured.risk || 'low';
        if ((RISK_ORDER[evidenceRisk] || 0) < RISK_ORDER[requiredRisk]) {
          emitGate('deny', 'vg-risk-level', { evidence: evidenceRisk, required: requiredRisk });
          process.stderr.write(
            `[Verification Gate] 验证证据风险等级不足: evidence=${evidenceRisk}, required=${requiredRisk}。\n` +
            `→ 证据文件: ${freshReport.path}\n`
          );
          process.exit(2);
        }
        if (isTag) {
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
    const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
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
  if (!evidence) return null;
  if (!evidenceAttestation) {
    return {
      code: 'ATTESTATION_VERIFIER_UNAVAILABLE',
      message: 'attestation verifier module is unavailable for a delivery command',
    };
  }
  if (!currentGit || !currentGit.available || !currentGit.commit || !currentGit.tree || !currentGit.candidate_digest) {
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
    require_attestation: true,
    allow_legacy: false,
    expected_commit: currentGit.commit,
    expected_tree: currentGit.tree,
    expected_candidate_digest: currentGit.candidate_digest,
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

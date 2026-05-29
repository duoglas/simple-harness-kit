#!/usr/bin/env node
'use strict';

/**
 * branch-policy-guard.js — Block git operations that violate the active
 * preset's branch-policy.json / commit-format.json.
 * @version 0.10.0
 * Trigger: PreToolUse:Bash
 *
 * Blocks (exit 2):
 *   1. git push to a branch matching merge_only_branches → use MR/PR instead
 *   2. git push --all / --mirror when any protected branches exist
 *   3. git commit with a type listed in commit_format.type_blocked_on_branch
 *      matching the current branch. Pattern may use `!` prefix to invert,
 *      e.g. `fix: ['!fix-*']` = "fix forbidden everywhere except fix-*"
 *      (i.e. "fix only allowed on fix-*")
 *   4. git commit with a type NOT in commit_format.type_required_on_branch[p]
 *      where p is a branch pattern matching the current branch,
 *      e.g. `fix-*: ['fix', 'test']` = "on fix-* only fix/test are allowed"
 *
 * Warn-only (no exit):
 *   - Push target unparseable (let server-side reject if violation)
 *   - Preset missing (loader already fell back to generic)
 *
 * Bypass: HARNESS_SKIP_GATE=1 (logged).
 */

const { execFileSync } = require('child_process');
const { loadPreset } = require('./load-preset');

const MAX_STDIN = 1024 * 1024;
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

function matchesAny(branch, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some(p => globToRegex(p).test(branch));
}

// Pattern supports `!` prefix to negate: `!fix-*` matches branches NOT
// matching `fix-*`. Used by type_blocked_on_branch to express "type blocked
// everywhere except this branch family".
function branchMatchesPattern(branch, pattern) {
  if (pattern.startsWith('!')) {
    return !globToRegex(pattern.slice(1)).test(branch);
  }
  return globToRegex(pattern).test(branch);
}

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function parsePushTargets(cmd) {
  if (/--all\b|--mirror\b/.test(cmd)) return { wildcard: true };

  const tokens = cmd.split(/\s+/);
  const pushIdx = tokens.findIndex(t => t === 'push');
  if (pushIdx < 0) return { ambiguous: true };

  // Strip flags after `push` to find positional args (remote, refspec)
  const positional = [];
  for (let i = pushIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      // skip --flag=value or --flag value
      if (!t.includes('=')) i++;
      continue;
    }
    if (t.startsWith('-') && t !== '-') {
      // -u takes one arg; others mostly are short flags
      if (t === '-u' || t === '-o') i++;
      continue;
    }
    positional.push(t);
  }

  if (positional.length === 0) {
    const cb = currentBranch();
    return cb ? { dst: [cb] } : { ambiguous: true };
  }

  // First positional = remote name; rest = refspecs
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) {
    const cb = currentBranch();
    return cb ? { dst: [cb] } : { ambiguous: true };
  }

  const dsts = refspecs.map(rs => {
    if (rs.startsWith(':')) {
      // delete refspec: ":branch" — destination is the branch being deleted
      return rs.slice(1).replace(/^refs\/heads\//, '');
    }
    if (rs.includes(':')) {
      const dst = rs.split(':')[1];
      return dst.replace(/^refs\/heads\//, '');
    }
    if (rs === 'HEAD') return currentBranch();
    return rs;
  }).filter(Boolean);

  return dsts.length > 0 ? { dst: dsts } : { ambiguous: true };
}

function extractCommitType(cmd) {
  // Try to extract subject from common -m / --message= forms
  let subject = null;

  // -m "..." (double quotes, allow embedded escapes loosely)
  let m = cmd.match(/(?:^|\s)-m\s+"([\s\S]*?)(?<!\\)"/);
  if (m) subject = m[1];

  // -m '...' (single quotes, no escapes)
  if (!subject) {
    m = cmd.match(/(?:^|\s)-m\s+'([\s\S]*?)'/);
    if (m) subject = m[1];
  }

  // --message=...  (until end-of-arg / next flag / end of cmd)
  if (!subject) {
    m = cmd.match(/--message=("([^"]*)"|'([^']*)'|(\S+))/);
    if (m) subject = m[2] || m[3] || m[4] || '';
  }

  // heredoc $(cat <<EOF ... EOF)
  if (!subject) {
    m = cmd.match(/<<['"]?EOF([\s\S]*?)EOF/);
    if (m) subject = m[1].trim();
  }

  if (!subject) return null;

  const firstLine = subject.split('\n').find(l => l.trim()) || '';
  // Conventional Commits: "feat: ..." or "feat(scope): ..."
  let t = firstLine.match(/^(\w+)(?:\([^)]+\))?:\s/);
  if (t) return t[1];
  // Task-ID-prefixed (loose ticket style): "<TICKET> <type> ..." (e.g., "PROJ-42 feat add x")
  t = firstLine.match(/^[A-Z0-9-]+\s+(\w+)\s+\S/);
  if (t) return t[1];
  return null;
}

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const cmd = String(input.tool_input?.command || '');

    if (!/git\s+(push|commit)/.test(cmd)) return;
    if (process.env.HARNESS_SKIP_GATE === '1') {
      process.stderr.write('[Branch Policy Guard] Bypassed via HARNESS_SKIP_GATE=1.\n');
      return;
    }

    const preset = loadPreset();
    const protected_branches = preset.branch_policy?.protected_branches || [];
    const merge_only = preset.branch_policy?.merge_only_branches || [];
    const type_blocked = preset.commit_format?.type_blocked_on_branch || {};
    const type_required = preset.commit_format?.type_required_on_branch || {};

    const hasAnyPolicy =
      protected_branches.length > 0 ||
      merge_only.length > 0 ||
      Object.keys(type_blocked).length > 0 ||
      Object.keys(type_required).length > 0;
    if (!hasAnyPolicy) return;

    // === git push ===
    if (/git\s+push/.test(cmd)) {
      const target = parsePushTargets(cmd);

      if (target.wildcard) {
        if (protected_branches.length || merge_only.length) {
          process.stderr.write(
            '[Branch Policy Guard] git push --all / --mirror is unsafe with protected branches.\n' +
            `→ Active preset: ${preset.name}\n` +
            `→ Protected: ${[...new Set([...protected_branches, ...merge_only])].join(', ')}\n` +
            '→ Push branches individually instead.\n'
          );
          process.exit(2);
        }
        return;
      }

      if (target.ambiguous) {
        // Cannot determine target; let it through (server will reject if violation)
        return;
      }

      for (const dst of target.dst || []) {
        if (matchesAny(dst, merge_only)) {
          process.stderr.write(
            `[Branch Policy Guard] Direct push to '${dst}' is forbidden by preset '${preset.name}'.\n` +
            `→ Branch matches merge-only pattern. Use a Merge Request / Pull Request.\n` +
            `→ Patterns: ${merge_only.join(', ')}\n` +
            '→ Bypass once: HARNESS_SKIP_GATE=1 git push ...\n'
          );
          process.exit(2);
        }
      }
    }

    // === git commit (and amend) ===
    if (/git\s+commit/.test(cmd) &&
        (Object.keys(type_blocked).length > 0 || Object.keys(type_required).length > 0)) {
      const branch = currentBranch();
      if (!branch) return;
      const type = extractCommitType(cmd);
      if (!type) return;

      // type_blocked_on_branch: {type: [branch-pattern, ...]} — block `type`
      // on matching branches. Pattern with `!` prefix inverts (block everywhere
      // except matching), e.g. `fix: ['!fix-*']` = "fix only on fix-*".
      const blockedPatterns = type_blocked[type];
      if (Array.isArray(blockedPatterns) && blockedPatterns.length > 0) {
        for (const pat of blockedPatterns) {
          if (branchMatchesPattern(branch, pat)) {
            process.stderr.write(
              `[Branch Policy Guard] Commit type '${type}' is forbidden on branch '${branch}'.\n` +
              `→ Active preset: ${preset.name}\n` +
              `→ Pattern matched: '${pat}'\n` +
              `→ Reason: '${type}' commits don't belong on this branch family.\n` +
              '→ Use a different type (e.g. "fix" on release-*) or commit on a feature branch.\n' +
              '→ Bypass once: HARNESS_SKIP_GATE=1 git commit ...\n'
            );
            process.exit(2);
          }
        }
      }

      // type_required_on_branch: {branch-pattern: [allowed-type, ...]} — on
      // branches matching this pattern, only the listed types are allowed.
      for (const [branchPat, allowedTypes] of Object.entries(type_required)) {
        if (!Array.isArray(allowedTypes) || allowedTypes.length === 0) continue;
        if (!globToRegex(branchPat).test(branch)) continue;
        if (!allowedTypes.includes(type)) {
          process.stderr.write(
            `[Branch Policy Guard] Commit type '${type}' is not allowed on branch '${branch}'.\n` +
            `→ Active preset: ${preset.name}\n` +
            `→ Branch matched pattern: '${branchPat}'\n` +
            `→ Allowed types on this branch: ${allowedTypes.join(', ')}\n` +
            '→ Bypass once: HARNESS_SKIP_GATE=1 git commit ...\n'
          );
          process.exit(2);
        }
      }
    }
  } catch {}
});

#!/usr/bin/env node
'use strict';

/**
 * Verification Gate Hook — commit/push 前的阶段和证据检查
 * @version 0.10.0
 * 触发: PreToolUse:Bash
 *
 * 五重检查:
 * 1. commit 阶段检查: 必须在 VERIFY/REVIEW/FEEDBACK 才能 commit
 * 2. 证据时效性: 验证证据文件的 mtime 必须晚于 current-stage.json 的 since
 * 3. push 阶段检查: 必须在 REVIEW 才能 push
 * 4. 结构化 evidence 检查: .harness/verify-evidence.json 必须 overall=READY
 * 5. 用户入口变更三模式证据（C-GATE-07, 仅 kit 仓库触发）:
 *    commit 涉及 install.sh / update.sh / init-prompt.md / SKILL.md
 *    / resources/init-prompt.md / generate-codex-hooks.js 时，
 *    verify-evidence.md 必须同时含 '独立 agent' / 'Claude Code' / 'Codex' 三个标记
 *
 * 环境变量 HARNESS_SKIP_GATE=1 临时跳过（需记录原因）。
 *
 * 设计目标: <50ms
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const findRoot = require('./find-root');
const ROOT = findRoot();

const MAX_STDIN = 1024 * 1024;

const STAGE_FILE = path.join(ROOT, '.harness/current-stage.json');
const COMMIT_ALLOWED_STAGES = ['VERIFY', 'REVIEW', 'FEEDBACK'];
const PUSH_ALLOWED_STAGES = ['REVIEW'];
const REPORT_PATHS = [
  path.join(ROOT, '.harness/verify-evidence.json'),
  path.join(ROOT, 'docs/verification-report.md'),
  path.join(ROOT, '.harness/last-verification.json'),
  path.join(ROOT, '.harness/verify-evidence.md'),
];
const RISK_ORDER = { low: 1, medium: 2, high: 3, release: 4 };

// ── C-GATE-07: kit-only 守门 ──
// kit 特征文件，用于判定"当前仓库是否 simple-harness-kit"。
// 非 kit 仓库（用户项目）跳过本层，旧行为不变。
const KIT_MARKER_FILE = path.join(ROOT, 'tests/template-integrity.js');

// 用户入口文件白名单：任一命中 → 要求三模式证据
const USER_ENTRY_FILES = [
  'install.sh',
  'update.sh',
  'init-prompt.md',
  'skills/harness-init/SKILL.md',
  'skills/harness-init/resources/init-prompt.md',
  'scripts/generate-codex-hooks.js',
];

// 三模式证据标记（对应 C-GATE-04 三 runtime 模式）
const RUNTIME_MARKERS = ['独立 agent', 'Claude Code', 'Codex'];

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const cmd = String(input.tool_input?.command || '');

    const isCommit = /git\s+(commit|merge)/.test(cmd);
    const isTag = /git\s+tag\b/.test(cmd);
    const isPush = /git\s+push/.test(cmd);

    if (!isCommit && !isPush && !isTag) {
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

    // 读取当前阶段
    let stage = null;
    let stageSince = null;
    try {
      const data = JSON.parse(fs.readFileSync(STAGE_FILE, 'utf8'));
      stage = data.stage;
      stageSince = data.since ? new Date(data.since) : null;
    } catch {}

    if (!stage) {
      process.stderr.write(
        '[Verification Gate] 无法确定当前阶段（.harness/current-stage.json 不存在或无效）。\n' +
        '→ git commit/push 需要在 Harness 阶段声明后才能执行。\n'
      );
      process.exit(2);
    }

    // ── push 阶段检查 ──
    if (isPush) {
      if (!PUSH_ALLOWED_STAGES.includes(stage)) {
        process.stderr.write(
          `[Verification Gate] push 只允许在 REVIEW 阶段。当前阶段: ${stage}。\n` +
          '→ 完成 VERIFY 和 REVIEW 后再 push。\n'
        );
        process.exit(2);
      }
      // REVIEW 阶段 push 放行
      return;
    }

    // ── commit / tag 阶段检查 ──
    if (isCommit || isTag) {
      if (!COMMIT_ALLOWED_STAGES.includes(stage)) {
        process.stderr.write(
          `[Verification Gate] 当前阶段 ${stage} 不允许 commit。\n` +
          `→ commit 只允许在: ${COMMIT_ALLOWED_STAGES.join(', ')}。\n` +
          '→ 先完成 EXECUTE，进入 VERIFY 产出验证证据后再 commit。\n'
        );
        process.exit(2);
      }

      // ── 验证证据检查 ──
      let freshReport = null;
      for (const p of REPORT_PATHS) {
        try {
          const stat = fs.statSync(p);
          if (stat.isFile()) {
            freshReport = { path: p, mtime: stat.mtime };
            break;
          }
        } catch {}
      }

      if (!freshReport) {
        process.stderr.write(
          '[Verification Gate] 未找到验证报告。\n' +
          '→ 请先完成 QA 验证，产出证据文件。\n' +
          '→ 验证报告应在: ' + REPORT_PATHS.join(' 或 ') + '\n'
        );
        process.exit(2);
      }

      // ── 证据时效性检查 ──
      if (stageSince && freshReport.mtime < stageSince) {
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
      if (structured) {
        if (structured.overall !== 'READY') {
          process.stderr.write(
            `[Verification Gate] 结构化验证证据未 READY: overall=${structured.overall || 'UNKNOWN'}。\n` +
            `→ 证据文件: ${freshReport.path}\n` +
            '→ 请重新运行 `shk verify --risk <level> --write-evidence`，修复 FAIL 项后再提交。\n'
          );
          process.exit(2);
        }
        const sufficiencyBlockers = e2eSufficiencyEvidenceBlockers(structured, isTag ? 'release' : 'medium');
        if (sufficiencyBlockers.length > 0) {
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
          process.stderr.write(
            `[Verification Gate] 验证证据风险等级不足: evidence=${evidenceRisk}, required=${requiredRisk}。\n` +
            `→ 证据文件: ${freshReport.path}\n`
          );
          process.exit(2);
        }
        if (isTag) {
          const releaseBlockers = releaseEvidenceBlockers(structured);
          if (releaseBlockers.length > 0) {
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
  } catch {}
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

function readAllEvidenceText() {
  let out = '';
  for (const p of REPORT_PATHS) {
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

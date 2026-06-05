#!/usr/bin/env node
'use strict';

/**
 * Delivery Gate Hook — AI 输出文字前的合规检查
 * @version 0.8.0
 * 触发: Stop
 *
 * 在 AI 生成回复但还未展示给用户之前触发。
 * 检查 AI 是否在未完成 VERIFY/REVIEW 的情况下就宣称"完成"。
 *
 * exit 0 — 放行，用户看到回复
 * exit 2 — 阻止，AI 收到 reason 后必须修正
 *
 * 设计目标: <50ms
 */

const fs = require('fs');
const path = require('path');
const findRoot = require('./find-root');
const ROOT = findRoot();

const STAGE_FILE = path.join(ROOT, '.harness/current-stage.json');
const MAX_STDIN = 1024 * 1024;

// 交付性语言模式——AI 在宣称完成/交付结果
const DELIVERY_PATTERNS = [
  /已完成|已交付|交付给你|请查看|请验收/,
  /全部完成|任务完成|工作完成|修改完成/,
  /做好了|搞定了|弄好了|改好了|写好了|修好了/,
  /READY|Overall.*READY|VERIFICATION REPORT/,
  /本轮.*完成|变更.*总结|变更.*汇总/,
];

// 允许交付的阶段
const DELIVERY_ALLOWED_STAGES = ['REVIEW', 'FEEDBACK'];

// 不检查的阶段（PLAN 输出计划是正常行为）
const SKIP_CHECK_STAGES = ['PLAN', 'OFF'];

// 验证证据文件
const EVIDENCE_JSON = path.join(ROOT, '.harness/verify-evidence.json');
const EVIDENCE_PATHS = [
  EVIDENCE_JSON,
  path.join(ROOT, 'docs/verification-report.md'),
  path.join(ROOT, '.harness/last-verification.json'),
  path.join(ROOT, '.harness/verify-evidence.md'),
];
const RISK_ORDER = { low: 1, medium: 2, high: 3, release: 4 };

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const message = String(input.last_assistant_message || '');

    // 无 stage 文件 → 可能不是 Harness 项目，放行
    if (!fs.existsSync(STAGE_FILE)) {
      process.exit(0);
    }

    let stage = null;
    let stageSince = null;
    try {
      const data = JSON.parse(fs.readFileSync(STAGE_FILE, 'utf8'));
      stage = data.stage;
      stageSince = data.since ? new Date(data.since) : null;
    } catch {
      process.exit(0);
    }

    // 跳过检查的阶段
    if (SKIP_CHECK_STAGES.includes(stage)) {
      process.exit(0);
    }

    // 检查是否包含交付性语言
    const hasDeliveryLanguage = DELIVERY_PATTERNS.some(p => p.test(message));

    if (!hasDeliveryLanguage) {
      // 不是交付性输出（普通对话/提问/中间进展），放行
      process.exit(0);
    }

    // 交付话术必须有 fresh READY 结构化 evidence；REVIEW/FEEDBACK 阶段也一样。
    const structured = readStructuredEvidence();
    if (!structured) {
      process.stderr.write(
        '[Delivery Gate] 阻止：缺少结构化 READY 验证证据。\n' +
        `→ 请先运行验证并写入 ${EVIDENCE_JSON}，不能靠口头说完成。\n`
      );
      process.exit(2);
    }
    if (structured && structured.overall && structured.overall !== 'READY') {
      process.stderr.write(
        `[Delivery Gate] 阻止：当前验证证据不是 READY: overall=${structured.overall}。\n` +
        '→ 不能把测试失败或准出失败说成完成。先修复失败项，重新产出 READY evidence。\n'
      );
      process.exit(2);
    }
    if (structured && hasDegradedRequiredCheck(structured)) {
      process.stderr.write(
        '[Delivery Gate] 阻止：验证证据里有 DEGRADED 的必需检查。\n' +
        '→ 报告必须保留限制说明，不能把 DEGRADED 说成 PASS。\n'
      );
      process.exit(2);
    }
    const sufficiencyBlockers = e2eSufficiencyEvidenceBlockers(structured);
    if (sufficiencyBlockers.length > 0) {
      process.stderr.write(
        '[Delivery Gate] 阻止：E2E 充分性证据不足。\n' +
        '→ 具体问题: ' + sufficiencyBlockers.join('; ') + '\n' +
        '→ E2E PASS 不等于可以交付；NOT_SUFFICIENT 不能包装成完成。\n'
      );
      process.exit(2);
    }
    if (!isFreshStructuredEvidence(stageSince)) {
      process.stderr.write(
        '[Delivery Gate] 阻止：验证证据不是 fresh evidence，可能是上一轮残留。\n' +
        '→ 请重新跑验证，产出晚于当前阶段开始时间的 READY evidence。\n'
      );
      process.exit(2);
    }

    // 允许交付的阶段
    if (DELIVERY_ALLOWED_STAGES.includes(stage)) {
      process.exit(0);
    }

    // 到这里：AI 在 EXECUTE/VERIFY 阶段使用了交付性语言

    if (stage === 'EXECUTE') {
      process.stderr.write(
        '[Delivery Gate] 阻止：当前在 EXECUTE 阶段，未完成 VERIFY 就宣称交付。\n' +
        '→ 必须先切到 VERIFY 阶段，产出验证证据，再向用户交付。\n' +
        '→ 不要直接告诉用户"完成了"。先跑验证，确认通过后切到 REVIEW 再交付。\n'
      );
      process.exit(2);
    }

    if (stage === 'VERIFY') {
      // VERIFY 阶段：允许交付但必须有证据
      const hasEvidence = EVIDENCE_PATHS.some(p => {
        try { return fs.statSync(p).isFile(); } catch { return false; }
      });

      if (!hasEvidence) {
        process.stderr.write(
          '[Delivery Gate] 阻止：在 VERIFY 阶段宣称交付但缺少验证证据。\n' +
          '→ 请先产出验证证据文件: ' + EVIDENCE_PATHS.join(' 或 ') + '\n' +
          '→ 然后切到 REVIEW 阶段，回答交付检查清单后再交付。\n'
        );
        process.exit(2);
      }
    }
  } catch {}

  // 默认放行
  process.exit(0);
});


function readStructuredEvidence() {
  try {
    const data = JSON.parse(fs.readFileSync(EVIDENCE_JSON, 'utf8'));
    if (data && data.schema_version && data.overall) return data;
  } catch {}
  return null;
}

function hasDegradedRequiredCheck(evidence) {
  const checks = evidence && evidence.checks || {};
  return Object.values(checks).some(c => c && (c.status === 'DEGRADED' || c.degraded === true));
}

function isFreshStructuredEvidence(stageSince) {
  if (!stageSince || Number.isNaN(stageSince.getTime())) return true;
  try {
    const stat = fs.statSync(EVIDENCE_JSON);
    return stat.isFile() && stat.mtime >= stageSince;
  } catch {}
  return false;
}

function e2eSufficiencyEvidenceBlockers(evidence) {
  const risk = evidence && evidence.risk || 'low';
  if ((RISK_ORDER[risk] || 0) < RISK_ORDER.medium) return [];
  const checks = evidence && evidence.checks || {};
  const sufficiency = checks.e2e_sufficiency;
  if (!sufficiency) return ['e2e_sufficiency=MISSING'];
  if (sufficiency.overall !== 'READY' || sufficiency.status !== 'PASS') {
    return [`e2e_sufficiency=${sufficiency.overall || sufficiency.status || 'UNKNOWN'}`];
  }
  return [];
}

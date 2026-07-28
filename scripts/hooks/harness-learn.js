#!/usr/bin/env node
'use strict';

/**
 * Harness Learn — 质量回路分析（gate-events + stage-history + observations）
 * @version 0.9.0 (new-generation-agent B2: 学习对象从"工具怎么用"换成"质量回路怎么转")
 *
 * 纯本地分析，不调 AI，不启动后台进程。
 * 用法: node scripts/hooks/harness-learn.js [--report] [--periodic <days>]
 *
 * v0.9.0 重设计（VH-28 同期决策）：移除 instinct 机制——旧版按"工具选择需要纠偏"
 * 设计，对新一代模型产出的是零语义的工具连击统计（bash→bash 0.95 置信度之类），
 * 且"晋升为 Rule 省 token"的建议无效。新分析维度全部消费门禁事件：
 *
 * 1. 门禁触发统计   — gate-events.jsonl 按 gate 聚合 deny/warn/hint
 * 2. 响应良性率     — C-GATE-18 warn/deny 后 30 分钟内是否进入 VERIFY（stage-history）
 * 3. 交付修正率     — delivery-gate deny 次数（"宣称完成但无证据"的发生频率）
 * 4. 阈值余量       — C-GATE-18 事件 detail.count 分布 vs 阈值 → 数据驱动的调参建议
 * 5. 高频修改文件   — 保留（observations，高风险文件 → 测试覆盖提示）
 */

const fs = require('fs');
const path = require('path');
const findRoot = require('./find-root');
const ROOT = findRoot();

const OBS_FILE = path.join(ROOT, '.harness/observations.jsonl');
const GATE_EVENTS_FILE = path.join(ROOT, '.harness/gate-events.jsonl');
const STAGE_HISTORY_FILE = path.join(ROOT, '.harness/stage-history.jsonl');
const REPORT_FILE = path.join(ROOT, '.harness/learn-report.md');
const PERIODIC_DIR = path.join(ROOT, '.harness/reports');

const RESPONSE_WINDOW_MS = 30 * 60 * 1000; // 触发后 30 分钟内进 VERIFY 算良性响应

// ── 数据加载 ──

function loadJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

const loadObservations = () => loadJsonl(OBS_FILE);
const loadGateEvents = () => loadJsonl(GATE_EVENTS_FILE);
const loadStageHistory = () => loadJsonl(STAGE_HISTORY_FILE);

// ── 分析 1: 门禁触发统计 ──

function analyzeGateSummary(events) {
  const byGate = {};
  for (const ev of events) {
    const g = ev.gate || 'unknown';
    byGate[g] = byGate[g] || { deny: 0, warn: 0, hint: 0 };
    if (byGate[g][ev.action] !== undefined) byGate[g][ev.action] += 1;
  }
  return Object.entries(byGate)
    .map(([gate, c]) => ({ gate, ...c, total: c.deny + c.warn + c.hint }))
    .sort((a, b) => b.total - a.total);
}

// ── 分析 2: C-GATE-18 响应良性率 ──
// warn/deny 触发后 RESPONSE_WINDOW 内 stage-history 出现 VERIFY = 良性响应
// （android-ops 实测案例："写操作上限触发后按门禁进入 VERIFY，没有绕过"）

function analyzeResponseRate(events, stageHistory) {
  const triggers = events.filter(e => e.gate === 'C-GATE-18' && (e.action === 'warn' || e.action === 'deny'));
  if (triggers.length === 0) return null;
  const verifyTimes = stageHistory
    .filter(h => h.stage === 'VERIFY')
    .map(h => new Date(h.t).getTime())
    .filter(t => !Number.isNaN(t));
  let benign = 0;
  for (const tr of triggers) {
    const t0 = new Date(tr.t).getTime();
    if (Number.isNaN(t0)) continue;
    if (verifyTimes.some(vt => vt >= t0 && vt - t0 <= RESPONSE_WINDOW_MS)) benign += 1;
  }
  return { triggers: triggers.length, benign, rate: triggers.length ? benign / triggers.length : 0 };
}

// ── 分析 3: 交付修正 ──

function analyzeDeliveryCorrections(events) {
  return events.filter(e => e.hook === 'delivery-gate' && e.action === 'deny').length;
}

// ── 分析 4: 阈值余量（C-GATE-18 detail.count 分布） ──

function analyzeThresholdHeadroom(events) {
  const counts = events
    .filter(e => e.gate === 'C-GATE-18' && e.detail && typeof e.detail.count === 'number')
    .map(e => ({ count: e.detail.count, threshold: e.detail.threshold || e.detail.interval || null }));
  if (counts.length === 0) return null;
  const values = counts.map(c => c.count).sort((a, b) => a - b);
  const max = values[values.length - 1];
  const p90 = values[Math.min(values.length - 1, Math.floor(values.length * 0.9))];
  const threshold = counts.map(c => c.threshold).filter(Boolean).pop() || null;
  return { samples: counts.length, max, p90, threshold };
}

// ── 分析 5: 高频修改文件（保留自旧版） ──

function analyzeHotFiles(obs) {
  const files = {};
  for (const o of obs) {
    if (!/edit|write|patch/i.test(String(o.tool || ''))) continue;
    const input = String(o.input || '');
    const file = input.split(' | ')[0].split(' ')[0].trim();
    if (!file || file.length > 200) continue;
    files[file] = (files[file] || 0) + 1;
  }
  return Object.entries(files)
    .filter(([, count]) => count >= 3)
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 任务状态漂移检测（C-AGENT-04）。
 *
 * stage 文件的既有守门只查"新鲜度"——since 是不是够新。但新鲜不等于**记的是这件事**：
 * 只读审计发现过 stage 停在几天前的旧任务，而同一工作树里躺着 4 条互不相关的改动链，
 * 于是那一轮所有证据都挂错了账。
 *
 * 判据用**时间**而不是文本匹配。第一版试过"任务描述与高频文件路径的词重叠"，
 * 但那个思路对中文任务名整个失效——中文无法用 ASCII 正则分词，而且"设置页导航重构"
 * 与 `plugins/settings/nav.java` 之间本来就没有字面重叠。语言相关的判据在多语项目里
 * 是不可靠的，时间差则语言无关。
 *
 * 只提示不阻断：误报的成本远高于漏报。
 */
const DRIFT_STALE_HOURS = 12;

function analyzeTaskDrift(stageHistory, hotFiles) {
  if (!Array.isArray(hotFiles) || hotFiles.length === 0) return null;
  const last = Array.isArray(stageHistory) && stageHistory.length > 0
    ? stageHistory[stageHistory.length - 1] : null;
  if (!last || !last.t) return null;

  const stageAt = Date.parse(last.t);
  if (!Number.isFinite(stageAt)) return null;
  const hours = (Date.now() - stageAt) / 3600000;
  if (hours < DRIFT_STALE_HOURS) return null;

  // stage 很久没动，但仍有可观的写操作量 —— 大概率是忘了切任务
  const writes = hotFiles.reduce((sum, f) => sum + (f.count || 0), 0);
  if (writes < 10) return null;

  return {
    label: String(last.task || last.reason || last.stage || '(未命名)'),
    since: last.t,
    hours: Math.round(hours),
    writes,
    topFiles: hotFiles.slice(0, 3).map(f => f.file),
  };
}

// ── 报告 ──

function gateSummaryLines(summary) {
  const lines = [];
  lines.push('| 门禁 | deny | warn | hint | 合计 |');
  lines.push('|------|------|------|------|------|');
  for (const g of summary.slice(0, 12)) {
    lines.push(`| ${g.gate} | ${g.deny} | ${g.warn} | ${g.hint} | ${g.total} |`);
  }
  return lines;
}

function qualityLoopSection(events, stageHistory) {
  const lines = [];
  lines.push('\n## 质量回路（gate-events）');
  if (events.length === 0) {
    lines.push('\n暂无门禁事件。两种可能：');
    lines.push('- 好信号：本期没有任何阻断/警告（light 模式的目标状态）；');
    lines.push('- 或 hooks 尚未升级到含 gate-events 遥测的版本（stage-guard ≥ 0.13）。');
    return lines;
  }
  const summary = analyzeGateSummary(events);
  const denies = events.filter(e => e.action === 'deny').length;
  lines.push(`\n事件总数: ${events.length}（deny ${denies}）`);
  lines.push('');
  lines.push(...gateSummaryLines(summary));

  const resp = analyzeResponseRate(events, stageHistory);
  if (resp) {
    lines.push(`\n**C-GATE-18 响应良性率**: ${resp.benign}/${resp.triggers}（触发后 30 分钟内进入 VERIFY）` +
      (resp.rate < 0.5 ? ' — 偏低，模型在绕行而非配合，检查阈值与提示文案' : ''));
  }
  const corrections = analyzeDeliveryCorrections(events);
  if (corrections > 0) {
    lines.push(`\n**交付修正**: delivery-gate 拦截 ${corrections} 次"宣称完成但证据不足"——检查验证是否习惯性前置。`);
  }
  const headroom = analyzeThresholdHeadroom(events);
  if (headroom && headroom.threshold) {
    lines.push(`\n**C-GATE-18 阈值余量**: 观测峰值 ${headroom.max} / P90 ${headroom.p90}（阈值 ${headroom.threshold}，样本 ${headroom.samples}）` +
      (headroom.max >= headroom.threshold * 0.9
        ? ` — 建议 .harness/config.json 调整 execute_writes_block（如 ${Math.ceil(headroom.max * 1.5 / 50) * 50}）或确认周期性 VERIFY 节奏`
        : ' — 余量充足'));
  }
  return lines;
}

function generateReport(obs, events, stageHistory, hotFiles) {
  const lines = [];
  lines.push('# Harness Learn 分析报告');
  lines.push(`\n生成时间: ${new Date().toISOString().slice(0, 16)}`);
  lines.push(`观察数据: ${obs.length} 条 | 门禁事件: ${events.length} 条`);

  lines.push(...qualityLoopSection(events, stageHistory));

  if (hotFiles.length > 0) {
    lines.push('\n## 高频修改文件（可能需要测试覆盖）');
    lines.push('| 文件 | 修改次数 |');
    lines.push('|------|---------|');
    for (const f of hotFiles.slice(0, 10)) {
      lines.push(`| ${f.file} | ${f.count} |`);
    }
  }

  const drift = analyzeTaskDrift(stageHistory, hotFiles);
  if (drift) {
    lines.push('\n## 任务状态漂移提示（C-AGENT-04）');
    lines.push(`当前记录的任务是「${drift.label}」，最后一次阶段变更在 ${drift.hours} 小时前`
      + `（${String(drift.since).slice(0, 16)}），而此后仍有 ${drift.writes} 次写操作，`
      + `集中在 ${drift.topFiles.join('、')}。`);
    lines.push('');
    lines.push('如果工作重心已经转移，先把当前任务切到真正在做的那件事再继续——');
    lines.push('否则本轮产出的证据会挂在错误的任务上，事后无法归因。这是弱信号，误报请忽略。');
  }

  lines.push('\n## 改进建议');
  const suggestions = [];
  if (hotFiles.length > 0) {
    suggestions.push(`- \`${hotFiles[0].file}\` 修改了 ${hotFiles[0].count} 次 — 建议确认测试覆盖`);
  }
  const denies = events.filter(e => e.action === 'deny');
  if (denies.length > 0) {
    const topGate = analyzeGateSummary(denies)[0];
    suggestions.push(`- 门禁 ${topGate.gate} 拦截最多（${topGate.deny} 次）— 高频拦截通常意味着流程与工作形态不匹配，走 F1-F5 评估阈值/规则`);
  }
  if (suggestions.length === 0) {
    suggestions.push('- 本期无门禁拦截且无高风险文件——保持现状。');
  }
  lines.push(...suggestions);

  return lines.join('\n');
}

function generatePeriodicReport(periodDays, obs, events, stageHistory, hotFiles) {
  const now = new Date();
  const since = new Date(now - periodDays * 24 * 60 * 60 * 1000);
  const lines = [];
  lines.push('# 开发质量周期报告');
  lines.push(`\n期间: ${since.toISOString().slice(0, 10)} ~ ${now.toISOString().slice(0, 10)} (${periodDays} 天)`);
  lines.push(`本期观察: ${obs.length} 条 | 本期门禁事件: ${events.length} 条`);
  lines.push(...qualityLoopSection(events, stageHistory));
  if (hotFiles.length > 0) {
    lines.push('\n## 高频修改文件');
    for (const f of hotFiles.slice(0, 5)) {
      lines.push(`- \`${f.file}\` — ${f.count} 次修改`);
    }
  }
  if (obs.length < 20) {
    lines.push('\n> 本期数据量偏少，指标可能不稳定。');
  }
  return lines.join('\n');
}

// ── 主流程 ──

function main() {
  const args = process.argv.slice(2);
  const isReport = args.includes('--report');
  if (args.includes('--promote')) {
    console.log('instinct 机制已在 v0.9.0 移除（旧机制产出无语义的工具连击统计）。');
    console.log('质量回路指标见 learn-report；规则沉淀走 F1-F5 → constraints.md。');
  }
  const periodicIdx = args.indexOf('--periodic');
  const periodDays = periodicIdx !== -1 ? parseInt(args[periodicIdx + 1], 10) || 7 : 0;

  const allObs = loadObservations();
  const allEvents = loadGateEvents();
  const stageHistory = loadStageHistory();

  if (allObs.length < 10 && allEvents.length === 0) {
    console.log(`观察数据仅 ${allObs.length} 条且无门禁事件，建议积累后再分析。`);
    if (allObs.length === 0) console.log('提示: 确认 session-logger Hook 已启用且 HARNESS_LEARN !== off');
    return;
  }

  const cutoff = periodDays > 0 ? new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000) : null;
  const obs = cutoff ? allObs.filter(o => new Date(o.t) >= cutoff) : allObs;
  const events = cutoff ? allEvents.filter(e => new Date(e.t) >= cutoff) : allEvents;
  const hotFiles = analyzeHotFiles(obs);

  if (periodDays > 0) {
    const report = generatePeriodicReport(periodDays, obs, events, stageHistory, hotFiles);
    if (!fs.existsSync(PERIODIC_DIR)) fs.mkdirSync(PERIODIC_DIR, { recursive: true });
    const reportFile = path.join(PERIODIC_DIR, `${new Date().toISOString().slice(0, 10)}-${periodDays}d.md`);
    fs.writeFileSync(reportFile, report);
    if (isReport) console.log(report);
    else console.log(`周期报告（${periodDays} 天）: ${reportFile}`);
  } else {
    const report = generateReport(allObs, allEvents, stageHistory, hotFiles);
    fs.writeFileSync(REPORT_FILE, report);
    if (isReport) console.log(report);
    else {
      console.log(`分析完成: ${allObs.length} 条观察 + ${allEvents.length} 条门禁事件`);
      console.log(`报告: ${REPORT_FILE}`);
    }
  }
}

main();

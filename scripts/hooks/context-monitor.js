#!/usr/bin/env node
'use strict';

/**
 * Context Monitor Hook — 上下文预算监控
 * @version 0.9.0 (按上下文深度而非写次数度量)
 * 触发: PreToolUse:Edit, PreToolUse:Write
 *
 * 提醒 compact，防止上下文过长导致规则遵从度下降。
 *
 * 度量口径（0.9.0 修正）：真正导致模型把 <invoke> 信封当纯文本吐出、工具不执行、
 * 回合空转的自变量是**上下文深度**，不是写操作次数。实测同一工程的死回合随
 * session 天数暴增（1 → 10 → 28），峰值约 570K token 全程从未触发 auto-compact——
 * auto-compact 只在逼近窗口 80% 才动，长跑 session 卡在"已退化但没触发安全网"
 * 的中间地带。所以本 hook 以三个维度判断，任一触发即提醒：
 *
 *   1. 跨天       最强信号。单 session 跨自然日基本等于已进入退化区
 *   2. 时长       连续 6 小时以上
 *   3. 累计写入   写进上下文的内容体量，比调用次数更接近真实占用
 *   4. 调用次数   保留为辅助信号，权重最低
 *
 * session 识别用 stdin 的 session_id，不再用 process.ppid——ppid 在跨天、
 * 跨进程重启时会复用或变化，两种情况都会误判。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const COUNTER_FILE = path.join(os.tmpdir(), 'harness-tool-counter.json');
const THRESHOLD = 50;              // 调用次数首次提醒阈值（辅助信号）
const INTERVAL = 25;               // 后续每隔多少次提醒
const HOURS_THRESHOLD = 6;         // 连续时长阈值（小时）
const BYTES_THRESHOLD = 500 * 1024; // 累计写入阈值，粗略对应上下文压力

const MAX_STDIN = 1024 * 1024;
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

process.stdin.on('end', () => {
  try {
    let input = {};
    try { input = JSON.parse(raw); } catch { input = {}; }

    let counter = { count: 0, session: '', startedAt: 0, bytes: 0, notified: {} };
    try {
      const prev = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
      if (prev && typeof prev === 'object') counter = { notified: {}, ...prev };
    } catch { /* 首次运行 */ }

    // session 识别优先用 stdin 的 session_id；缺失时才回落 ppid（保持旧行为可用）
    const currentSession = String(input.session_id || process.ppid || '');
    const now = Date.now();
    if (counter.session !== currentSession) {
      counter = { count: 0, session: currentSession, startedAt: now, bytes: 0, notified: {} };
    }
    if (!counter.startedAt) counter.startedAt = now;

    counter.count++;
    const payload = input.tool_input || {};
    const written = String(payload.content || payload.new_string || '');
    counter.bytes = (counter.bytes || 0) + written.length;

    const hours = (now - counter.startedAt) / 3600000;
    const crossedDay = new Date(counter.startedAt).toDateString() !== new Date(now).toDateString();

    // 任一维度触发即提醒；每个维度每 session 只提醒一次，避免刷屏
    const reasons = [];
    if (crossedDay && !counter.notified.day) {
      counter.notified.day = true;
      reasons.push(`本 session 已跨自然日（起于 ${new Date(counter.startedAt).toLocaleString()}）`);
    }
    if (hours >= HOURS_THRESHOLD && !counter.notified.hours) {
      counter.notified.hours = true;
      reasons.push(`已连续运行 ${hours.toFixed(1)} 小时`);
    }
    if (counter.bytes >= BYTES_THRESHOLD && !counter.notified.bytes) {
      counter.notified.bytes = true;
      reasons.push(`累计写入约 ${Math.round(counter.bytes / 1024)} KB 内容`);
    }
    const countHit = counter.count >= THRESHOLD && (counter.count - THRESHOLD) % INTERVAL === 0;
    if (countHit) reasons.push(`已执行 ${counter.count} 次编辑操作`);

    fs.writeFileSync(COUNTER_FILE, JSON.stringify(counter));

    if (reasons.length > 0) {
      const strong = crossedDay || hours >= HOURS_THRESHOLD;
      process.stderr.write(
        `[Context Monitor] ${reasons.join('；')}。\n` +
        (strong
          ? '→ 跨天或长时运行的 session 已进入退化区：模型可能把工具调用标记当纯文本吐出，\n' +
            '   表现为回合空转、看着像卡住。这时不要反复说"继续"，直接 /compact 或开新 session。\n'
          : '→ 建议在下一个逻辑阶段边界执行 /compact，防止规则遵从度下降。\n') +
        '→ compact 前确保重要信息已写入文件或 memory。\n'
      );
    }
  } catch {}
  // stdout 保持为空（Codex 0.118.0 兼容，见 VH-13）
});

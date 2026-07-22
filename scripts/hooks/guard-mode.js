#!/usr/bin/env node
'use strict';

/**
 * Guard Mode Resolver — strict/light 双模式解析 + 双轨模型检测
 * @version 0.3.0 (new-generation-agent: + gate-events 遥测落点 appendGateEvent)
 *
 * 解析顺序（先命中先用）:
 *   0. 环境变量 HARNESS_GUARD_MODE=strict|light（最高优先级——测试确定性 + 用户临时覆盖）
 *   1. <ROOT>/.harness/config.json 的 guard_mode 显式配置（"strict" | "light"）
 *   2. 模型自动检测:
 *      - Claude Code: hook input.transcript_path → transcript 尾部最后一条 "model" 字段
 *      - Codex: ~/.codex/config.toml 的 model 键
 *   3. 默认 "strict"（存量项目行为不变）
 *
 * 新一代判定（→ light）: 版本号数值比较 + 后缀容忍
 *   - claude-fable-* / claude-mythos-*
 *   - claude-opus-4-N (N>=7)、claude-opus-5+
 *   - claude-sonnet-5+
 *   - gpt-M.N (M.N >= 5.6，含 gpt-5.6-sol / gpt-5.6-codex 等后缀)、gpt-6+
 *   - o5+（OpenAI o 系列）
 *   检测不到模型 → 不切换（维持配置/默认）。
 *
 * 一次性提示: 自动切换 light 时向 stderr 提示一次（按 session_id 去重，
 * 状态存 <ROOT>/.harness/guard-mode-notice.json）。
 *
 * 设计目标: <10ms 增量（transcript 只读尾部 64KB）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TAIL_BYTES = 64 * 1024;

function readTail(filePath, bytes) {
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - bytes);
    const len = stat.size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

// 从 Claude Code transcript (JSONL) 尾部取最后出现的 model 值
function detectClaudeModel(transcriptPath) {
  if (!transcriptPath) return null;
  const tail = readTail(String(transcriptPath), TAIL_BYTES);
  if (!tail) return null;
  const matches = [...tail.matchAll(/"model"\s*:\s*"([^"]+)"/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1];
}

// 从 ~/.codex/config.toml 顶层取 model 键（正则提取，不引入 toml 依赖）。
// 只认 [section] 出现之前的顶层赋值，避免误取 [profiles.*] 内的 model。
function detectCodexModel() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.codex/config.toml'), 'utf8');
    const topLevel = raw.split(/^\s*\[/m)[0];
    const m = topLevel.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// 新一代模型判定。返回 true → light；false → strict；null → 无法判定。
function isNewGenModel(model) {
  if (!model) return null;
  const id = String(model).toLowerCase();

  if (/^claude-(fable|mythos)-/.test(id) || /^claude-(fable|mythos)\b/.test(id)) return true;

  let m = id.match(/^claude-opus-(\d+)(?:-(\d+))?/);
  if (m) {
    const major = parseInt(m[1], 10);
    const minor = m[2] ? parseInt(m[2], 10) : 0;
    return major > 4 || (major === 4 && minor >= 7);
  }

  m = id.match(/^claude-sonnet-(\d+)/);
  if (m) return parseInt(m[1], 10) >= 5;

  m = id.match(/^claude-haiku-/);
  if (m) return false;

  // gpt-5.6 / gpt-5.6-sol / gpt-5.6-codex / gpt-6 ...
  m = id.match(/^gpt-(\d+)(?:\.(\d+))?/);
  if (m) {
    const major = parseInt(m[1], 10);
    const minor = m[2] ? parseInt(m[2], 10) : 0;
    return major > 5 || (major === 5 && minor >= 6);
  }

  // OpenAI o 系列: o5 及以上
  m = id.match(/^o(\d+)(?:\b|-)/);
  if (m) return parseInt(m[1], 10) >= 5;

  return null; // 未知家族，不判定
}

// 读取 .harness/config.json（Harness 项目级配置）。失败返回 {}。
// 已知键: guard_mode ("strict"|"light")、execute_writes_warn、execute_writes_block（C-GATE-18 阈值）。
function readHarnessConfig(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.harness/config.json'), 'utf8'));
    return (cfg && typeof cfg === 'object') ? cfg : {};
  } catch {
    return {};
  }
}

function readExplicitMode(root) {
  const cfg = readHarnessConfig(root);
  if (cfg.guard_mode === 'strict' || cfg.guard_mode === 'light') {
    return cfg.guard_mode;
  }
  return null;
}

/**
 * 解析 guard mode。
 * @param {object|null} input hook stdin JSON（可能含 transcript_path / session_id）
 * @param {string} root Harness 项目根
 * @returns {{mode: 'strict'|'light', model: string|null, source: string}}
 */
function resolveGuardMode(input, root) {
  const envMode = process.env.HARNESS_GUARD_MODE;
  if (envMode === 'strict' || envMode === 'light') {
    return { mode: envMode, model: null, source: 'env' };
  }
  const explicit = readExplicitMode(root);
  if (explicit) return { mode: explicit, model: null, source: 'config' };

  const claudeModel = detectClaudeModel(input && input.transcript_path);
  const model = claudeModel || detectCodexModel();
  const verdict = isNewGenModel(model);
  if (verdict === true) {
    return { mode: 'light', model, source: claudeModel ? 'transcript' : 'codex-config' };
  }
  if (verdict === false) {
    return { mode: 'strict', model, source: claudeModel ? 'transcript' : 'codex-config' };
  }
  return { mode: 'strict', model: model || null, source: 'default' };
}

/**
 * 自动切换 light 时的一次性提示（按 session_id 去重）。
 * 返回应写入 stderr 的提示文本，或 null（已提示过 / 非自动切换）。
 */
function onceNotice(resolved, input, root) {
  if (resolved.mode !== 'light' || resolved.source === 'config' || resolved.source === 'env') return null;
  const noticeFile = path.join(root, '.harness/guard-mode-notice.json');
  const sessionId = String((input && input.session_id) || 'unknown');
  try {
    const prev = JSON.parse(fs.readFileSync(noticeFile, 'utf8'));
    if (prev && prev.session_id === sessionId && prev.model === resolved.model) return null;
  } catch {}
  try {
    fs.writeFileSync(noticeFile, JSON.stringify({
      session_id: sessionId,
      model: resolved.model,
      mode: resolved.mode,
      t: new Date().toISOString(),
    }) + '\n');
  } catch {}
  return `[Harness Guard Mode] 检测到新一代模型 ${resolved.model}，stage-guard 已切换 light 模式：\n` +
    `  - 阶段声明变为可选遥测（不再阻断工具调用）\n` +
    `  - 交付门禁由证据类检查承担（verify-evidence / delivery-gate / safety / branch-policy）\n` +
    `  - 如需固定模式，写入 .harness/config.json: {"guard_mode":"strict"} 或 {"guard_mode":"light"}\n`;
}

/**
 * gate-events 遥测（v0.3.0）：门禁事件统一落点 <ROOT>/.harness/gate-events.jsonl。
 * 只记 warn / deny / hint（light 降级提示）事件，不记普通放行——量小且全是信号。
 * 写失败静默：telemetry 永不影响主流程。
 * 消费方：harness-learn（门禁触发率/响应良性率/阈值余量分布）、dogfood 验收
 * （`rg -c '"action":"deny"' .harness/gate-events.jsonl`）。
 *
 * @param {string} root Harness 项目根
 * @param {object} ev { gate, hook, mode, action: 'warn'|'deny'|'hint', detail?, session_id?, stage? }
 */
function appendGateEvent(root, ev) {
  try {
    const file = path.join(root, '.harness/gate-events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      t: new Date().toISOString(),
      gate: String(ev.gate || ''),
      hook: String(ev.hook || ''),
      mode: String(ev.mode || ''),
      action: String(ev.action || ''),
      detail: ev.detail || undefined,
      session_id: ev.session_id || undefined,
      stage: ev.stage || undefined,
    }) + '\n');
  } catch {}
}

module.exports = { resolveGuardMode, onceNotice, isNewGenModel, detectClaudeModel, detectCodexModel, readHarnessConfig, appendGateEvent };

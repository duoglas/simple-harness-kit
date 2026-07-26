'use strict';

/**
 * 增量验证：检查项级指纹缓存 + 多轮收敛。
 *
 * 解决的问题：RISK_CHECKS 按风险档固定跑 4/9/10 项，与本次改了什么无关，
 * 于是 Fix Cycle 每一轮都全量重跑；改一行文档也要等一遍完整测试。
 *
 * 机制：
 *   1. 每项检查按「它关心哪些文件」算指纹（变更文件集 + HEAD）。指纹未变 → CACHED，
 *      直接复用上轮结论，不执行命令。
 *   2. 多轮：第 N 轮只跑「上轮 FAIL 的」加「指纹变了的」。
 *   3. 封盘：增量轮即使全绿也不判 READY，必须跑一次 --seal 全量轮。这是 RK8 的护栏——
 *      否则最后一轮的绿只覆盖了最后一次改动。
 *
 * 默认输入划分是保守的（源码变了 build/tests/lint 一起失效，宁可多跑不可漏）。
 * 项目可在 .harness/config.json 的 check_inputs 里按自己的构建结构收窄，换取更细的跳过。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const CACHE_REL = '.harness/verify-cache.json';

const SOURCE_EXT = [
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.kt', '.go', '.py', '.rb',
  '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.sh', '.bash', '.bsh', '.php',
];
const CONFIG_HINT = [
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'tsconfig', 'jsconfig',
  'eslint', 'prettier', 'jest.config', 'vitest.config', 'babel.config', 'webpack', 'vite.config',
  'Makefile', 'pom.xml', 'build.gradle', 'settings.gradle', 'go.mod', 'go.sum', 'Cargo.toml',
  'requirements.txt', 'pyproject.toml', 'Gemfile', 'composer.json',
];
const TEST_HINT = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\./i;
const E2E_HINT = /(^|\/)(e2e|integration|cypress|playwright|selenium)(\/|$)/i;

/** 每项检查关心哪类文件。null = 永不缓存（该检查本身就是看当前状态的）。 */
const DEFAULT_CHECK_INPUTS = {
  build: ['source', 'config'],
  types: ['source', 'config'],
  lint: ['source', 'config'],
  tests: ['source', 'config', 'test'],
  coverage: ['source', 'config', 'test'],
  e2e: ['source', 'config', 'test', 'e2e'],
  runtime: ['source', 'config'],
  runtime_selftest: ['source', 'config'],
  santa: ['source'],
  security: ['any'],
  spec: ['spec'],
  diff: null,
  clean_tree: null,
  upstream: null,
  doctor: null,
  quality_gate: null,
};

function classify(rel) {
  const kinds = ['any'];
  const ext = path.extname(rel).toLowerCase();
  if (SOURCE_EXT.includes(ext)) kinds.push('source');
  if (CONFIG_HINT.some(h => rel.includes(h))) kinds.push('config');
  if (TEST_HINT.test(rel)) kinds.push('test');
  if (E2E_HINT.test(rel)) kinds.push('e2e');
  if (/spec\.json$|iteration-spec\.json$/.test(rel)) kinds.push('spec');
  return kinds;
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

/**
 * harness 自己的簿记不参与验证指纹。否则每写一次缓存/journal，
 * 下一轮的变更集就多一个文件，指纹永远在变，缓存永不命中。
 */
const LEDGER_NOISE = [/^\.harness\//, /\/journal\.jsonl$/, /\/evidence\//, /(^|\/)INDEX\.md$/];

/**
 * 工作树里所有已变更/未跟踪文件。指纹的输入面——没变更就没什么可重跑的。
 * 注意不能对 porcelain 输出整体 trim：状态位是 `XY ` 三字符定宽前缀，
 * 未暂存修改的行首就是空格，trim 掉会把路径切错一位。
 */
function changedFiles(root) {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return String(r.stdout || '')
    .split('\n')
    .filter(l => l.length > 3)
    .map(l => l.slice(3))
    .map(p => (p.includes(' -> ') ? p.split(' -> ').pop() : p))
    .map(p => p.replace(/^"|"$/g, '').trim())
    .filter(Boolean)
    .filter(p => !LEDGER_NOISE.some(re => re.test(p)));
}

function fileStamp(root, rel) {
  try {
    const st = fs.statSync(path.join(root, rel));
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

function readCache(root) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, CACHE_REL), 'utf8'));
    return (v && typeof v === 'object') ? v : {};
  } catch {
    return {};
  }
}

function writeCache(root, cache) {
  const file = path.join(root, CACHE_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function checkInputs(config, check) {
  const custom = config && config.check_inputs;
  if (custom && Object.prototype.hasOwnProperty.call(custom, check)) {
    const v = custom[check];
    return v === null ? null : (Array.isArray(v) ? v : DEFAULT_CHECK_INPUTS[check]);
  }
  return Object.prototype.hasOwnProperty.call(DEFAULT_CHECK_INPUTS, check)
    ? DEFAULT_CHECK_INPUTS[check]
    : ['any'];
}

/**
 * 检查项指纹。输入 = HEAD + 该检查关心的变更文件的 (path,size,mtime)。
 * HEAD 进指纹是必要的：切分支/新 commit 后工作树可能干净，但被验证的内容已经不同。
 */
function fingerprint(root, check, config, changed) {
  const kinds = checkInputs(config, check);
  if (kinds === null) return null;
  const relevant = changed
    .filter(f => classify(f).some(k => kinds.includes(k)))
    .map(f => `${f}@${fileStamp(root, f)}`)
    .sort();
  const head = git(root, ['rev-parse', 'HEAD']) || 'no-head';
  return crypto.createHash('sha1')
    .update(`${check}|${head}|${relevant.join(',')}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * 验证上下文。makeEvidence 每跑一项检查前问一次 shouldRun，跑完 record。
 *
 * @param {object} opts
 *   round  第几轮（默认 1）
 *   seal   封盘轮：忽略缓存全量执行，只有封盘轮才允许判 READY
 *   config .harness/config.json 内容
 */
function createContext(root, opts = {}) {
  const seal = !!opts.seal;
  const round = Number(opts.round) || 1;
  const config = opts.config || {};
  const prev = readCache(root);
  const changed = changedFiles(root);
  const next = {};
  const decisions = {};

  function decide(check) {
    if (decisions[check]) return decisions[check];
    const fp = fingerprint(root, check, config, changed);
    const before = prev[check];
    let d;
    if (seal || fp === null) {
      d = { run: true, reason: seal ? 'seal' : 'always' };
    } else if (!before || before.fingerprint !== fp) {
      d = { run: true, reason: before ? 'changed' : 'first-run' };
    } else if (before.status !== 'PASS') {
      // 上轮没过的一律重跑，哪怕指纹没变——修不动也要如实再报一次失败。
      d = { run: true, reason: 'previous-not-pass' };
    } else {
      d = { run: false, reason: 'cached', cached: before };
    }
    d.fingerprint = fp;
    decisions[check] = d;
    return d;
  }

  return {
    round,
    seal,
    changedFiles: changed,
    shouldRun(check) { return decide(check).run; },
    reasonFor(check) { return decide(check).reason; },
    cachedResult(check) {
      const d = decide(check);
      if (d.run || !d.cached) return null;
      next[check] = d.cached;
      return { ...d.cached.result, status: d.cached.status, cached: true, cached_from_round: d.cached.round };
    },
    record(check, result) {
      const d = decide(check);
      if (d.fingerprint === null) return result;
      next[check] = {
        fingerprint: d.fingerprint,
        status: result && result.status,
        round,
        t: new Date().toISOString(),
        result: { command: result && result.command, reason: result && result.reason },
      };
      return result;
    },
    /** 写回缓存。未被本轮触及的检查项保留上轮记录，避免下一轮误判为 first-run。 */
    persist() {
      writeCache(root, { ...prev, ...next });
      return { round, seal, cached: Object.keys(decisions).filter(c => !decisions[c].run) };
    },
    summary() {
      const ran = Object.keys(decisions).filter(c => decisions[c].run);
      const cached = Object.keys(decisions).filter(c => !decisions[c].run);
      return { round, seal, ran, cached, changed_files: changed.length };
    },
  };
}

/**
 * 按 spec.test_plan 的 paths 声明挑出与本轮变更相关的 test。
 * 没有 paths 声明的 test 一律选中（保守：宁可多跑，不可漏）。
 * 同时报告未被任何 test 的 paths 覆盖的变更文件——这是 RK7 的护栏，
 * 不能因为"没有 test 声明关心它"就静默当作通过。
 */
function selectTests(spec, changed) {
  const plan = (spec && Array.isArray(spec.test_plan)) ? spec.test_plan : [];
  if (!plan.length) return { selected: [], uncovered: changed, declared: false };
  const declared = plan.some(t => Array.isArray(t.paths) && t.paths.length);
  if (!declared) return { selected: plan.map(t => t.id), uncovered: [], declared: false };

  const selected = [];
  const covered = new Set();
  for (const t of plan) {
    const paths = Array.isArray(t.paths) ? t.paths.filter(Boolean) : null;
    if (!paths || !paths.length) { selected.push(t.id); continue; }
    const hit = changed.filter(f => paths.some(p => f === p || f.startsWith(p.replace(/\/?$/, '/'))));
    if (hit.length) { selected.push(t.id); hit.forEach(f => covered.add(f)); }
  }
  const uncovered = changed.filter(f => !covered.has(f));
  return { selected, uncovered, declared: true };
}

module.exports = {
  CACHE_REL,
  DEFAULT_CHECK_INPUTS,
  classify,
  changedFiles,
  fingerprint,
  readCache,
  writeCache,
  createContext,
  selectTests,
};

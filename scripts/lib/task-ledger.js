'use strict';

/**
 * Task Ledger —— 任务态持久化的路径解析与读写。
 *
 * 分层原则（判据：卸载 harness 之后这个文件还该不该留）:
 *   <tasks_dir>/<TASK-ID>/   工程产出。task.json / spec.json / plan.md / journal.jsonl /
 *                            findings.md / evidence/ / review/。进 git、进 PR diff、人要 review。
 *   .harness/                工具簿记。CURRENT 指针、config.json、runs/<TASK-ID>/ 原始日志、
 *                            gate-events / observations。整体不进 git（config.json 除外）。
 *
 * CURRENT 刻意留在 .harness/：它回答"这台机器上现在在做哪个任务"，是运行时状态而非资产。
 * 跨机器同步它反而有害——两台机器可以在做不同任务。
 *
 * 向后兼容：没有 .harness/CURRENT 的存量项目，spec/plan/evidence 全部回落到旧的
 * .harness/ 单例路径，行为与升级前完全一致。任务态是可选增量，不是破坏性迁移。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TASKS_DIR = 'docs/tasks';
const CURRENT_REL = '.harness/CURRENT';
const CONFIG_REL = '.harness/config.json';

// T-YYYYMMDD-slug。日期段让目录名可排序，slug 段让目录名自解释。
const TASK_ID_RE = /^T-\d{8}-[a-z0-9][a-z0-9-]*$/;

const TASK_STATUS = ['open', 'closed'];
const JOURNAL_KINDS = ['decision', 'deviation', 'finding', 'stage', 'blocker', 'handoff'];

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (v && typeof v === 'object') ? v : null;
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 原子写：同目录写 tmp 再 rename，避免并发读到半截文件。 */
function atomicWrite(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function readHarnessConfig(root) {
  return readJson(path.join(root, CONFIG_REL)) || {};
}

/**
 * 任务产出目录。默认 docs/tasks，可由 .harness/config.json 的 tasks_dir 覆盖。
 * 拒绝绝对路径和逃逸出仓库的相对路径——配置错误不该让任务写到仓库外。
 */
function tasksDir(root) {
  const raw = readHarnessConfig(root).tasks_dir;
  const rel = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_TASKS_DIR;
  if (path.isAbsolute(rel)) return path.join(root, DEFAULT_TASKS_DIR);
  const abs = path.resolve(root, rel);
  const inside = abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep);
  return inside ? abs : path.join(root, DEFAULT_TASKS_DIR);
}

function isValidTaskId(id) {
  return typeof id === 'string' && TASK_ID_RE.test(id);
}

/** 本机当前任务 id。无指针或格式非法都返回 null（调用方据此回落 legacy 路径）。 */
function currentTaskId(root) {
  try {
    const id = fs.readFileSync(path.join(root, CURRENT_REL), 'utf8').trim();
    return isValidTaskId(id) ? id : null;
  } catch {
    return null;
  }
}

function setCurrentTaskId(root, id) {
  if (!isValidTaskId(id)) throw new Error(`invalid task id: ${id}`);
  atomicWrite(path.join(root, CURRENT_REL), `${id}\n`);
}

function clearCurrentTaskId(root) {
  try { fs.unlinkSync(path.join(root, CURRENT_REL)); } catch { /* 本就不存在 */ }
}

function taskDir(root, id) {
  return path.join(tasksDir(root), id);
}

/** 原始日志、test-runs 产物落这里——簿记侧，不进 git。 */
function taskRunsDir(root, id) {
  return path.join(root, '.harness/runs', id);
}

function taskPaths(root, id) {
  const dir = taskDir(root, id);
  return {
    id,
    dir,
    task: path.join(dir, 'task.json'),
    spec: path.join(dir, 'spec.json'),
    plan: path.join(dir, 'plan.md'),
    journal: path.join(dir, 'journal.jsonl'),
    findings: path.join(dir, 'findings.md'),
    evidenceDir: path.join(dir, 'evidence'),
    evidenceJson: path.join(dir, 'evidence/verify-evidence.json'),
    evidenceMd: path.join(dir, 'evidence/verify-evidence.md'),
    reviewDir: path.join(dir, 'review'),
    runsDir: taskRunsDir(root, id),
  };
}

function currentTaskPaths(root) {
  const id = currentTaskId(root);
  return id ? taskPaths(root, id) : null;
}

/**
 * 解析产出类文件的实际路径。有 CURRENT 用任务目录，否则回落 .harness/ 单例。
 * key: 'spec' | 'plan' | 'evidenceJson' | 'evidenceMd'
 */
const LEGACY_REL = {
  spec: '.harness/iteration-spec.json',
  plan: '.harness/current-plan.md',
  evidenceJson: '.harness/verify-evidence.json',
  evidenceMd: '.harness/verify-evidence.md',
};

function resolveArtifactPath(root, key) {
  const legacy = LEGACY_REL[key];
  if (!legacy) throw new Error(`unknown artifact key: ${key}`);
  const p = currentTaskPaths(root);
  return p ? p[key] : path.join(root, legacy);
}

/** 展示用相对路径，供 hook 提示和报告输出。 */
function relFromRoot(root, abs) {
  const r = path.relative(root, abs);
  return r.split(path.sep).join('/');
}

/**
 * 结构化验证证据的权威路径。门禁消费方必须用这个，不要自己拼 .harness/verify-evidence.json。
 *
 * 关键语义：有当前任务时**只**认任务目录内的证据，绝不回退 .harness/ 单例。
 * 回退会造成一个隐蔽的失效：migrate 是复制不删除，legacy 证据会永远留在原地且再也不被更新，
 * 而它一旦参与优先级，门禁就被钉死在一张永不刷新的旧快照上（Santa 审查 F2）。
 */
function structuredEvidencePath(root) {
  return resolveArtifactPath(root, 'evidenceJson');
}

/**
 * 证据存在性检查用的候选列表，按优先级。第一项永远是结构化证据的权威路径。
 * 其余是历史遗留的弱证据形式，只能证明"验证跑过"，不能提供 overall/checks 结构。
 */
function evidenceSearchPaths(root) {
  const primary = structuredEvidencePath(root);
  const cur = currentTaskPaths(root);
  const weak = cur
    ? [cur.evidenceMd, path.join(root, 'docs/verification-report.md')]
    : [
      path.join(root, 'docs/verification-report.md'),
      path.join(root, '.harness/last-verification.json'),
      path.join(root, '.harness/verify-evidence.md'),
    ];
  return [primary, ...weak];
}

function readTask(root, id) {
  return readJson(taskPaths(root, id).task);
}

function writeTask(root, id, task) {
  atomicWrite(taskPaths(root, id).task, `${JSON.stringify(task, null, 2)}\n`);
}

/**
 * journal 追加。单行 JSON + O_APPEND，多 agent 并发写不冲突、天然时间有序、自带作者标识。
 * 这是替代单体 progress.md 的关键——markdown 承载不了多写者。
 */
function appendJournal(root, id, entry) {
  const p = taskPaths(root, id);
  ensureDir(p.dir);
  const line = JSON.stringify({
    t: entry.t || new Date().toISOString(),
    agent: entry.agent || detectAgent(),
    stage: entry.stage || null,
    kind: JOURNAL_KINDS.includes(entry.kind) ? entry.kind : 'decision',
    text: String(entry.text || '').trim(),
  });
  fs.appendFileSync(p.journal, `${line}\n`, 'utf8');
}

function readJournal(root, id) {
  try {
    return fs.readFileSync(taskPaths(root, id).journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 识别当前 agent，写进 journal 的 agent 字段。并发同工作树时用它回答"另一端动了什么"。
 * 环境变量优先，其次按各家 CLI 的特征变量猜，最后 unknown。
 */
function detectAgent() {
  const explicit = process.env.HARNESS_AGENT_ID;
  if (explicit) return explicit;
  const sid = process.env.CLAUDE_SESSION_ID || process.env.CODEX_SESSION_ID || '';
  const short = sid ? `:${sid.slice(0, 8)}` : '';
  if (process.env.CLAUDE_SESSION_ID || process.env.CLAUDECODE) return `claude${short}`;
  if (process.env.CODEX_SESSION_ID || process.env.CODEX_SANDBOX) return `codex${short}`;
  return `unknown${short}`;
}

function listTasks(root) {
  const dir = tasksDir(root);
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && isValidTaskId(d.name))
      .map(d => d.name);
  } catch {
    return [];
  }
  return names
    .map(id => ({ id, task: readTask(root, id) }))
    .filter(x => x.task)
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

function newTaskId(slug, now) {
  const d = now instanceof Date ? now : new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('');
  const clean = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!clean) throw new Error('slug must contain at least one alphanumeric character');
  return `T-${stamp}-${clean}`;
}

module.exports = {
  DEFAULT_TASKS_DIR,
  CURRENT_REL,
  TASK_ID_RE,
  TASK_STATUS,
  JOURNAL_KINDS,
  LEGACY_REL,
  tasksDir,
  isValidTaskId,
  currentTaskId,
  setCurrentTaskId,
  clearCurrentTaskId,
  taskDir,
  taskRunsDir,
  taskPaths,
  currentTaskPaths,
  resolveArtifactPath,
  structuredEvidencePath,
  evidenceSearchPaths,
  relFromRoot,
  readTask,
  writeTask,
  appendJournal,
  readJournal,
  listTasks,
  newTaskId,
  detectAgent,
  readHarnessConfig,
  ensureDir,
  atomicWrite,
};

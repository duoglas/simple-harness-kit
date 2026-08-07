#!/usr/bin/env node
'use strict';

/**
 * Task Ledger + Verify Cache 单元测试。
 *
 * 覆盖：
 *   T1  任务 id / CURRENT 指针 / taskPaths 生命周期
 *   T2  无 CURRENT 时产出路径回落 legacy（最高回归风险）
 *   T3  tasks_dir 配置边界（绝对路径 / 逃逸路径必须回退默认）
 *   T5  journal 追加与读回
 *   T7  verify-cache 变更集 / 指纹 / 上下文缓存
 *   T7b selectTests 按 paths 声明挑选
 *
 * 每个场景在系统临时目录建独立 git 仓库夹具，跑完清理。
 * 夹具路径一律 fs.realpathSync 归一化：macOS 上 /tmp -> /private/tmp 是软链接，
 * 不归一化会让 path.join(root, ...) 与被测代码返回值假失败。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KIT_ROOT = path.resolve(__dirname, '..');
const ledger = require(path.join(KIT_ROOT, 'scripts/lib/task-ledger.js'));
const vcache = require(path.join(KIT_ROOT, 'scripts/lib/verify-cache.js'));

// ── 夹具 ──

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return String(r.stdout || '');
}

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

/**
 * 建一个独立 git 仓库夹具。files 里的内容会被建立并提交为初始 commit
 * （fingerprint 把 HEAD 算进去，需要一个真实 HEAD）。
 */
function makeRepo(files) {
  const base = fs.realpathSync(os.tmpdir());
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, 'shk-task-ledger-')));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'shk test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // 宿主机的全局 excludesFile 可能忽略掉夹具文件，让 changedFiles 断言随机失败
  git(dir, ['config', 'core.excludesFile', '/dev/null']);
  for (const [rel, content] of Object.entries(files || { 'README.md': '# fixture\n' })) {
    writeFile(dir, rel, content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function withRepo(files, fn) {
  const dir = makeRepo(files);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ══ T1 任务生命周期 ══

function testNewTaskIdShape() {
  const id = ledger.newTaskId('foo-bar');
  assert.ok(/^T-\d{8}-foo-bar$/.test(id), `unexpected id: ${id}`);
  assert.ok(ledger.isValidTaskId(id), `newTaskId must produce a valid id: ${id}`);
  // 固定时间戳，锁住日期段格式（含个位月/日补零）
  assert.strictEqual(ledger.newTaskId('foo-bar', new Date(2026, 0, 5, 12)), 'T-20260105-foo-bar');
}

function testNewTaskIdNormalizesSlug() {
  const stamp = ledger.newTaskId('x').slice(0, 11); // "T-YYYYMMDD-"
  assert.strictEqual(ledger.newTaskId('Foo Bar'), `${stamp}foo-bar`);
  assert.strictEqual(ledger.newTaskId('  Task/With:Weird**Chars!! '), `${stamp}task-with-weird-chars`);
  assert.strictEqual(ledger.newTaskId('UPPER_snake_Case'), `${stamp}upper-snake-case`);
  assert.strictEqual(ledger.newTaskId('---leading-and-trailing---'), `${stamp}leading-and-trailing`);
  // 归一化后每个 slug 都必须仍然是合法 id
  for (const raw of ['Foo Bar', '  Task/With:Weird**Chars!! ', 'UPPER_snake_Case']) {
    assert.ok(ledger.isValidTaskId(ledger.newTaskId(raw)), `normalized slug invalid for: ${raw}`);
  }
  // 没有任何字母数字 → 抛错，不允许产生 "T-20260726-" 这种半截 id
  assert.throws(() => ledger.newTaskId('***'), /alphanumeric/);
  assert.throws(() => ledger.newTaskId(''), /alphanumeric/);
}

function testIsValidTaskId() {
  const valid = [
    'T-20260726-foo',
    'T-20260726-foo-bar-baz',
    'T-20260726-a',
    'T-20260726-9lives',
  ];
  for (const id of valid) assert.strictEqual(ledger.isValidTaskId(id), true, `should be valid: ${id}`);

  const invalid = [
    'T-2026072-foo',        // 日期段 7 位
    'T-202607261-foo',      // 日期段 9 位
    'T-20260726-Foo',       // 大写
    'T-20260726-',          // 空 slug
    'T-20260726--foo',      // slug 以连字符开头
    'T-20260726-foo bar',   // 空格
    'T-20260726-foo/bar',   // 路径分隔符（目录逃逸面）
    'T-20260726-foo..bar',
    '../../etc/passwd',
    't-20260726-foo',       // 小写前缀
    'T20260726-foo',
    '',
    null,
    undefined,
    123,
    {},
  ];
  for (const id of invalid) {
    assert.strictEqual(ledger.isValidTaskId(id), false, `should be invalid: ${JSON.stringify(id)}`);
  }
}

function testCurrentTaskIdRoundTrip() {
  withRepo(null, (dir) => {
    const id = ledger.newTaskId('round-trip');
    assert.strictEqual(ledger.currentTaskId(dir), null, 'no pointer yet');
    ledger.setCurrentTaskId(dir, id);
    assert.strictEqual(ledger.currentTaskId(dir), id);
    // 落盘位置就是 .harness/CURRENT，且没有残留 tmp 文件
    const currentFile = path.join(dir, ledger.CURRENT_REL);
    assert.ok(fs.existsSync(currentFile), '.harness/CURRENT should exist');
    assert.strictEqual(fs.readFileSync(currentFile, 'utf8').trim(), id);
    assert.strictEqual(
      fs.readdirSync(path.join(dir, '.harness')).filter(f => f.includes('.tmp-')).length,
      0,
      'atomicWrite must not leave tmp files behind'
    );
    ledger.clearCurrentTaskId(dir);
    assert.strictEqual(ledger.currentTaskId(dir), null, 'cleared pointer');
    // clear 幂等
    ledger.clearCurrentTaskId(dir);
    assert.strictEqual(ledger.currentTaskId(dir), null);
  });
}

function testSetCurrentTaskIdRejectsInvalidId() {
  withRepo(null, (dir) => {
    for (const bad of ['bogus', 'T-20260726-Foo', '../escape', '', null]) {
      assert.throws(
        () => ledger.setCurrentTaskId(dir, bad),
        /invalid task id/,
        `should reject: ${JSON.stringify(bad)}`
      );
    }
    assert.ok(!fs.existsSync(path.join(dir, ledger.CURRENT_REL)), 'rejected write must not create CURRENT');
  });
}

function testCurrentTaskIdNullOnMissingEmptyOrInvalid() {
  withRepo(null, (dir) => {
    // 1. 文件不存在
    assert.strictEqual(ledger.currentTaskId(dir), null, 'missing file → null');
    // 2. 内容为空
    writeFile(dir, ledger.CURRENT_REL, '');
    assert.strictEqual(ledger.currentTaskId(dir), null, 'empty file → null');
    writeFile(dir, ledger.CURRENT_REL, '   \n\n');
    assert.strictEqual(ledger.currentTaskId(dir), null, 'whitespace-only file → null');
    // 3. 内容非法
    writeFile(dir, ledger.CURRENT_REL, 'garbage-not-a-task-id\n');
    assert.strictEqual(ledger.currentTaskId(dir), null, 'invalid content → null');
    writeFile(dir, ledger.CURRENT_REL, '../../escape\n');
    assert.strictEqual(ledger.currentTaskId(dir), null, 'path-traversal content → null');
    // currentTaskPaths 跟着回 null
    assert.strictEqual(ledger.currentTaskPaths(dir), null);
  });
}

function testTaskPathsLayout() {
  withRepo(null, (dir) => {
    const id = 'T-20260726-layout';
    const p = ledger.taskPaths(dir, id);
    const taskDir = path.join(dir, 'docs/tasks', id);
    assert.strictEqual(p.id, id);
    assert.strictEqual(p.dir, taskDir);
    assert.strictEqual(p.task, path.join(taskDir, 'task.json'));
    assert.strictEqual(p.spec, path.join(taskDir, 'spec.json'));
    assert.strictEqual(p.plan, path.join(taskDir, 'plan.md'));
    assert.strictEqual(p.journal, path.join(taskDir, 'journal.jsonl'));
    assert.strictEqual(p.findings, path.join(taskDir, 'findings.md'));
    assert.strictEqual(p.evidenceDir, path.join(taskDir, 'evidence'));
    assert.strictEqual(p.evidenceJson, path.join(taskDir, 'evidence/verify-evidence.json'));
    assert.strictEqual(p.evidenceMd, path.join(taskDir, 'evidence/verify-evidence.md'));
    assert.strictEqual(p.reviewDir, path.join(taskDir, 'review'));
    // 工程产出全部在 <tasks_dir>/<id>/ 下
    for (const key of ['task', 'spec', 'plan', 'journal', 'findings', 'evidenceDir', 'evidenceJson', 'evidenceMd', 'reviewDir']) {
      assert.ok(
        p[key] === taskDir || p[key].startsWith(taskDir + path.sep),
        `${key} must live under ${taskDir}, got ${p[key]}`
      );
    }
    // runsDir 是簿记侧，刻意留在 .harness/ 而不是任务目录
    assert.strictEqual(p.runsDir, path.join(dir, '.harness/runs', id));
    assert.ok(!p.runsDir.startsWith(taskDir + path.sep), 'runsDir is bookkeeping, not工程产出');
    // taskDir() 与 taskPaths().dir 一致
    assert.strictEqual(ledger.taskDir(dir, id), p.dir);
  });
}

// ══ T2 向后兼容（回归风险最高）══

const ARTIFACT_KEYS = ['spec', 'plan', 'evidenceJson', 'evidenceMd'];

function testResolveArtifactPathFallsBackToLegacy() {
  withRepo(null, (dir) => {
    assert.strictEqual(ledger.currentTaskId(dir), null, 'precondition: no CURRENT');
    assert.strictEqual(ledger.resolveArtifactPath(dir, 'spec'), path.join(dir, '.harness/iteration-spec.json'));
    assert.strictEqual(ledger.resolveArtifactPath(dir, 'plan'), path.join(dir, '.harness/current-plan.md'));
    assert.strictEqual(ledger.resolveArtifactPath(dir, 'evidenceJson'), path.join(dir, '.harness/verify-evidence.json'));
    assert.strictEqual(ledger.resolveArtifactPath(dir, 'evidenceMd'), path.join(dir, '.harness/verify-evidence.md'));
    // 未知 key 必须抛错，而不是静默返回 undefined 让调用方写到 "undefined" 文件
    assert.throws(() => ledger.resolveArtifactPath(dir, 'nope'), /unknown artifact key/);
  });
}

function testResolveArtifactPathUsesTaskDirWhenCurrentSet() {
  withRepo(null, (dir) => {
    const id = ledger.newTaskId('switch-over');
    ledger.setCurrentTaskId(dir, id);
    const taskDir = path.join(dir, 'docs/tasks', id);
    assert.strictEqual(ledger.resolveArtifactPath(dir, 'spec'), path.join(taskDir, 'spec.json'));
    assert.strictEqual(ledger.resolveArtifactPath(dir, 'plan'), path.join(taskDir, 'plan.md'));
    assert.strictEqual(ledger.resolveArtifactPath(dir, 'evidenceJson'), path.join(taskDir, 'evidence/verify-evidence.json'));
    assert.strictEqual(ledger.resolveArtifactPath(dir, 'evidenceMd'), path.join(taskDir, 'evidence/verify-evidence.md'));
    // 清掉指针立刻回到 legacy —— 不留缓存态
    ledger.clearCurrentTaskId(dir);
    assert.strictEqual(ledger.resolveArtifactPath(dir, 'spec'), path.join(dir, '.harness/iteration-spec.json'));
  });
}

function testResolveArtifactPathFallsBackWhenCurrentCorrupt() {
  withRepo(null, (dir) => {
    // 指针坏了不能把产出写到错误位置——必须整体回落 legacy
    for (const junk of ['garbage\n', '', '   \n', 'T-2026-07-26-bad\n', '../../etc\n', '{"id":"T-20260726-x"}\n']) {
      writeFile(dir, ledger.CURRENT_REL, junk);
      for (const key of ARTIFACT_KEYS) {
        assert.strictEqual(
          ledger.resolveArtifactPath(dir, key),
          path.join(dir, ledger.LEGACY_REL[key]),
          `corrupt CURRENT ${JSON.stringify(junk)} must fall back for key=${key}`
        );
      }
    }
  });
}

// ══ T3 tasks_dir 配置边界 ══

function testTasksDirDefault() {
  withRepo(null, (dir) => {
    assert.strictEqual(ledger.tasksDir(dir), path.join(dir, 'docs/tasks'));
    // config.json 存在但没有 tasks_dir 字段
    writeFile(dir, '.harness/config.json', JSON.stringify({ guard_mode: 'light' }));
    assert.strictEqual(ledger.tasksDir(dir), path.join(dir, 'docs/tasks'));
    // config.json 内容非法 JSON
    writeFile(dir, '.harness/config.json', '{ not json');
    assert.strictEqual(ledger.tasksDir(dir), path.join(dir, 'docs/tasks'));
    // tasks_dir 是空白串 / 非字符串
    for (const bad of ['', '   ', 42, null, [], {}]) {
      writeFile(dir, '.harness/config.json', JSON.stringify({ tasks_dir: bad }));
      assert.strictEqual(ledger.tasksDir(dir), path.join(dir, 'docs/tasks'), `tasks_dir=${JSON.stringify(bad)}`);
    }
  });
}

function testTasksDirHonorsRelativeConfig() {
  withRepo(null, (dir) => {
    writeFile(dir, '.harness/config.json', JSON.stringify({ tasks_dir: 'tasks' }));
    assert.strictEqual(ledger.tasksDir(dir), path.join(dir, 'tasks'));
    assert.strictEqual(
      ledger.taskPaths(dir, 'T-20260726-cfg').spec,
      path.join(dir, 'tasks/T-20260726-cfg/spec.json')
    );
    writeFile(dir, '.harness/config.json', JSON.stringify({ tasks_dir: '  work/items  ' }));
    assert.strictEqual(ledger.tasksDir(dir), path.join(dir, 'work/items'), 'should trim whitespace');
  });
}

function testTasksDirRejectsAbsoluteAndEscapingPaths() {
  withRepo(null, (dir) => {
    const fallback = path.join(dir, 'docs/tasks');
    const dangerous = [
      '/etc', '/tmp/evil-tasks', '/',
      // 绝对路径即使指向仓库内部也必须回退：判据是"是不是绝对路径"，
      // 不能只靠 inside 检查（那个检查挡不住指向仓库内的绝对路径）
      path.join(dir, 'inside-but-absolute'),
      '../outside', '../../outside', 'ok/../../outside', '..',
    ];
    for (const raw of dangerous) {
      writeFile(dir, '.harness/config.json', JSON.stringify({ tasks_dir: raw }));
      const got = ledger.tasksDir(dir);
      assert.strictEqual(got, fallback, `tasks_dir=${raw} must fall back to default, got ${got}`);
      // 双保险：解析结果必须仍在仓库内
      assert.ok(got.startsWith(dir + path.sep), `tasks_dir=${raw} escaped the repo: ${got}`);
    }
    // 仓库内的绕路相对路径是允许的
    writeFile(dir, '.harness/config.json', JSON.stringify({ tasks_dir: 'a/../docs/t' }));
    assert.strictEqual(ledger.tasksDir(dir), path.join(dir, 'docs/t'));
  });
}

// ══ T5 journal ══

function testJournalAppendAndRead() {
  withRepo(null, (dir) => {
    const id = ledger.newTaskId('journal');
    assert.deepStrictEqual(ledger.readJournal(dir, id), [], 'no journal yet → []');

    ledger.appendJournal(dir, id, { kind: 'finding', text: '  发现一个边界问题  ', stage: 'VERIFY' });
    ledger.appendJournal(dir, id, { kind: 'deviation', text: '偏离计划', agent: 'tester' });

    const entries = ledger.readJournal(dir, id);
    assert.strictEqual(entries.length, 2);

    const first = entries[0];
    for (const field of ['t', 'agent', 'kind', 'text']) {
      assert.ok(Object.prototype.hasOwnProperty.call(first, field), `entry must carry ${field}`);
    }
    assert.strictEqual(first.kind, 'finding');
    assert.strictEqual(first.text, '发现一个边界问题', 'text should be trimmed');
    assert.strictEqual(first.stage, 'VERIFY');
    assert.strictEqual(typeof first.agent, 'string');
    assert.ok(first.agent.length > 0, 'agent must be identified');
    assert.ok(!Number.isNaN(Date.parse(first.t)), `t must be a parsable timestamp: ${first.t}`);

    assert.strictEqual(entries[1].kind, 'deviation');
    assert.strictEqual(entries[1].agent, 'tester', 'explicit agent wins');
    assert.strictEqual(entries[1].stage, null, 'missing stage → null');

    // 落在任务目录里，不是 .harness/
    assert.ok(fs.existsSync(path.join(dir, 'docs/tasks', id, 'journal.jsonl')));
  });
}

function testJournalNormalizesUnknownKind() {
  withRepo(null, (dir) => {
    const id = ledger.newTaskId('kind-norm');
    ledger.appendJournal(dir, id, { kind: 'bogus', text: 'a' });
    ledger.appendJournal(dir, id, { text: 'b' });                 // 缺省
    ledger.appendJournal(dir, id, { kind: 'DECISION', text: 'c' }); // 大小写不匹配
    ledger.appendJournal(dir, id, { kind: 'blocker', text: 'd' });  // 合法值原样保留

    const kinds = ledger.readJournal(dir, id).map(e => e.kind);
    assert.deepStrictEqual(kinds, ['decision', 'decision', 'decision', 'blocker']);
    for (const k of kinds) {
      assert.ok(ledger.JOURNAL_KINDS.includes(k), `normalized kind must be a known kind: ${k}`);
    }
  });
}

function testJournalAppendsAreLineOriented() {
  withRepo(null, (dir) => {
    const id = ledger.newTaskId('bulk');
    for (let i = 0; i < 50; i++) {
      ledger.appendJournal(dir, id, { kind: 'stage', text: `entry ${i}` });
    }
    const raw = fs.readFileSync(path.join(dir, 'docs/tasks', id, 'journal.jsonl'), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 50, 'exactly 50 lines');
    assert.ok(raw.endsWith('\n'), 'file must end with newline so the next append starts a fresh line');
    lines.forEach((line, i) => {
      const obj = JSON.parse(line); // 任何一行不可 parse 都会在这里抛
      assert.strictEqual(obj.text, `entry ${i}`);
    });
    assert.strictEqual(ledger.readJournal(dir, id).length, 50);
  });
}

// ══ T7 verify-cache 指纹 ══

function testChangedFilesParsesPorcelainStatuses() {
  withRepo({ 'src/app.js': 'module.exports = 1;\n', 'README.md': '# fixture\n' }, (dir) => {
    assert.deepStrictEqual(vcache.changedFiles(dir), [], 'clean tree → no changed files');

    // 已跟踪文件被修改：porcelain 行首是空格（" M src/app.js"）。
    // 这是已修复的真实 bug：对整行 trim 会把状态位前缀算错一位，路径变成 "rc/app.js"。
    writeFile(dir, 'src/app.js', 'module.exports = 2;\n');
    // 未跟踪新文件："?? src/new-file.js"
    writeFile(dir, 'src/new-file.js', 'x\n');
    // 已暂存新增："A  src/staged.js"
    writeFile(dir, 'src/staged.js', 'y\n');
    git(dir, ['add', 'src/staged.js']);

    const changed = vcache.changedFiles(dir).slice().sort();
    assert.deepStrictEqual(changed, ['src/app.js', 'src/new-file.js', 'src/staged.js'], JSON.stringify(changed));
    // 显式锁住首字母不被切掉
    assert.ok(changed.includes('src/app.js'), 'modified tracked file path must stay intact');
    assert.ok(!changed.some(f => f === 'rc/app.js' || f.startsWith('rc/')), 'leading char must not be trimmed away');
    assert.ok(!changed.some(f => /^[ ?AMR]{1,2}\s/.test(f)), 'status prefix must be stripped');
    assert.ok(changed.every(f => !f.startsWith(' ') && !f.endsWith(' ')), 'no stray padding');
  });
}

function testChangedFilesHandlesStagedModificationAndRename() {
  withRepo({ 'src/app.js': 'module.exports = 1;\n', 'src/old.js': 'old\n' }, (dir) => {
    // 已暂存修改："M  src/app.js"
    writeFile(dir, 'src/app.js', 'module.exports = 3;\n');
    git(dir, ['add', 'src/app.js']);
    // 重命名："R  src/old.js -> src/renamed.js"，取箭头右侧
    git(dir, ['mv', 'src/old.js', 'src/renamed.js']);

    const changed = vcache.changedFiles(dir).slice().sort();
    assert.ok(changed.includes('src/app.js'), JSON.stringify(changed));
    assert.ok(changed.includes('src/renamed.js'), `rename should report the new path: ${JSON.stringify(changed)}`);
    assert.ok(!changed.some(f => f.includes('->')), 'arrow must be resolved');
  });
}

function testChangedFilesExcludesLedgerNoise() {
  withRepo({ 'src/app.js': 'module.exports = 1;\n' }, (dir) => {
    writeFile(dir, 'src/keep.js', 'keep\n');
    writeFile(dir, '.harness/verify-cache.json', '{}\n');
    writeFile(dir, '.harness/observations.jsonl', '{}\n');
    writeFile(dir, 'docs/tasks/T-20260726-noise/journal.jsonl', '{}\n');
    writeFile(dir, 'docs/tasks/T-20260726-noise/evidence/verify-evidence.json', '{}\n');
    writeFile(dir, 'docs/tasks/INDEX.md', '# index\n');

    const changed = vcache.changedFiles(dir).slice().sort();
    assert.deepStrictEqual(changed, ['src/keep.js'], `ledger bookkeeping must not enter the fingerprint: ${JSON.stringify(changed)}`);
  });
}

function testFingerprintStabilityAndSensitivity() {
  withRepo({ 'src/app.js': 'module.exports = 1;\n', 'README.md': '# fixture\n' }, (dir) => {
    const fpOf = (check) => vcache.fingerprint(dir, check, {}, vcache.changedFiles(dir));

    // 1. 同一状态两次调用必须相同
    const buildA = fpOf('build');
    const buildA2 = fpOf('build');
    assert.strictEqual(buildA, buildA2, 'fingerprint must be deterministic for an unchanged state');
    assert.ok(typeof buildA === 'string' && buildA.length === 16, `unexpected fingerprint: ${buildA}`);
    const testsA = fpOf('tests');
    assert.notStrictEqual(buildA, testsA, 'different checks must not share a fingerprint');

    // 2. 改动源码 → build / tests 指纹都变
    writeFile(dir, 'src/app.js', 'module.exports = 22222;\n');
    const buildB = fpOf('build');
    const testsB = fpOf('tests');
    assert.notStrictEqual(buildB, buildA, 'source change must invalidate build');
    assert.notStrictEqual(testsB, testsA, 'source change must invalidate tests');

    // 3. 改动 README.md → build 指纹不变（.md 既不是 source 也不是 config）
    writeFile(dir, 'README.md', '# fixture, now with much more prose\n');
    assert.strictEqual(fpOf('build'), buildB, 'markdown-only change must not invalidate build');
    assert.strictEqual(fpOf('tests'), testsB, 'markdown-only change must not invalidate tests');
    // 但 security（inputs=['any']）必须感知到
    assert.notStrictEqual(
      vcache.fingerprint(dir, 'security', {}, vcache.changedFiles(dir)),
      buildB,
      'security watches any file'
    );

    // 4. inputs=null 的检查永不缓存
    assert.strictEqual(vcache.fingerprint(dir, 'diff', {}, vcache.changedFiles(dir)), null);
    assert.strictEqual(vcache.fingerprint(dir, 'clean_tree', {}, vcache.changedFiles(dir)), null);
  });
}

function testCreateContextFirstRunThenCaches() {
  withRepo({ 'src/app.js': 'module.exports = 1;\n' }, (dir) => {
    // 第 1 轮：无缓存，全部要跑
    const ctx1 = vcache.createContext(dir, { round: 1 });
    for (const check of ['build', 'tests', 'lint', 'security']) {
      assert.strictEqual(ctx1.shouldRun(check), true, `${check} should run on first round`);
      assert.strictEqual(ctx1.reasonFor(check), 'first-run', check);
      assert.strictEqual(ctx1.cachedResult(check), null, `${check} has no cached result yet`);
    }
    // inputs=null 的检查理由是 always
    assert.strictEqual(ctx1.shouldRun('diff'), true);
    assert.strictEqual(ctx1.reasonFor('diff'), 'always');

    ctx1.record('build', { status: 'PASS', command: 'npm run build' });
    ctx1.record('tests', { status: 'PASS', command: 'npm test' });
    ctx1.record('diff', { status: 'PASS', command: 'git diff --stat' });
    const persisted = ctx1.persist();
    assert.strictEqual(persisted.round, 1);
    assert.ok(fs.existsSync(path.join(dir, vcache.CACHE_REL)), 'persist must write the cache file');

    const cache = vcache.readCache(dir);
    assert.strictEqual(cache.build.status, 'PASS');
    assert.strictEqual(cache.build.round, 1);
    assert.ok(cache.build.fingerprint, 'cached entry must carry a fingerprint');
    assert.ok(!Object.prototype.hasOwnProperty.call(cache, 'diff'), 'never-cached checks must not be persisted');

    // 第 2 轮：什么都没改 → 命中缓存
    const ctx2 = vcache.createContext(dir, { round: 2 });
    assert.strictEqual(ctx2.shouldRun('build'), false, 'unchanged build must be cached');
    assert.strictEqual(ctx2.reasonFor('build'), 'cached');
    assert.strictEqual(ctx2.shouldRun('tests'), false, 'unchanged tests must be cached');
    const cached = ctx2.cachedResult('build');
    assert.ok(cached, 'cachedResult must return the previous conclusion');
    assert.strictEqual(cached.status, 'PASS');
    assert.strictEqual(cached.command, 'npm run build');
    assert.strictEqual(cached.cached, true);
    assert.strictEqual(cached.cached_from_round, 1);
    assert.strictEqual(ctx2.shouldRun('diff'), true, 'inputs=null check always runs');

    const summary = ctx2.summary();
    assert.strictEqual(summary.round, 2);
    assert.ok(summary.cached.includes('build') && summary.cached.includes('tests'), JSON.stringify(summary));
    assert.ok(summary.ran.includes('diff'), JSON.stringify(summary));

    // 第 3 轮：改了源码 → 缓存失效
    writeFile(dir, 'src/app.js', 'module.exports = 999999;\n');
    const ctx3 = vcache.createContext(dir, { round: 3 });
    assert.strictEqual(ctx3.shouldRun('build'), true, 'source change must invalidate the cached build');
    assert.strictEqual(ctx3.reasonFor('build'), 'changed');
    assert.strictEqual(ctx3.cachedResult('build'), null);
  });
}

function testCreateContextSealIgnoresCache() {
  withRepo({ 'src/app.js': 'module.exports = 1;\n' }, (dir) => {
    const ctx1 = vcache.createContext(dir, { round: 1 });
    for (const check of ['build', 'tests', 'lint', 'security', 'coverage']) {
      ctx1.shouldRun(check);
      ctx1.record(check, { status: 'PASS', command: `run ${check}` });
    }
    ctx1.persist();

    // 不封盘：全部命中缓存
    const incremental = vcache.createContext(dir, { round: 2 });
    for (const check of ['build', 'tests', 'lint', 'security', 'coverage']) {
      assert.strictEqual(incremental.shouldRun(check), false, `${check} should be cached without seal`);
    }

    // 封盘轮：忽略缓存，全量执行
    const sealed = vcache.createContext(dir, { round: 3, seal: true });
    assert.strictEqual(sealed.seal, true);
    for (const check of ['build', 'tests', 'lint', 'security', 'coverage', 'diff']) {
      assert.strictEqual(sealed.shouldRun(check), true, `${check} must run in a seal round`);
      assert.strictEqual(sealed.reasonFor(check), 'seal', check);
      assert.strictEqual(sealed.cachedResult(check), null, `${check} must not serve a cached result when sealing`);
    }
    assert.deepStrictEqual(sealed.summary().cached, [], 'seal round caches nothing');
  });
}

function testCreateContextRerunsPreviousNonPass() {
  withRepo({ 'src/app.js': 'module.exports = 1;\n' }, (dir) => {
    const ctx1 = vcache.createContext(dir, { round: 1 });
    ctx1.shouldRun('build');
    ctx1.record('build', { status: 'FAIL', command: 'npm run build' });
    ctx1.shouldRun('tests');
    ctx1.record('tests', { status: 'SKIP', command: 'not configured' });
    ctx1.shouldRun('lint');
    ctx1.record('lint', { status: 'PASS', command: 'npm run lint' });
    ctx1.persist();

    // 一个字节都没改，指纹全部相同——但上轮非 PASS 的必须重跑
    const ctx2 = vcache.createContext(dir, { round: 2 });
    assert.strictEqual(ctx2.shouldRun('build'), true, 'previous FAIL must rerun even with an unchanged fingerprint');
    assert.strictEqual(ctx2.reasonFor('build'), 'previous-not-pass');
    assert.strictEqual(ctx2.shouldRun('tests'), true, 'previous SKIP is not a PASS → rerun');
    assert.strictEqual(ctx2.reasonFor('tests'), 'previous-not-pass');
    assert.strictEqual(ctx2.shouldRun('lint'), false, 'previous PASS with unchanged fingerprint stays cached');

    // 重跑并转绿后，下一轮才允许缓存
    ctx2.record('build', { status: 'PASS', command: 'npm run build' });
    ctx2.persist();
    const ctx3 = vcache.createContext(dir, { round: 3 });
    assert.strictEqual(ctx3.shouldRun('build'), false, 'a fixed check becomes cacheable');
  });
}

function testPersistKeepsUntouchedCheckEntries() {
  withRepo({ 'src/app.js': 'module.exports = 1;\n' }, (dir) => {
    const ctx1 = vcache.createContext(dir, { round: 1 });
    ctx1.shouldRun('build');
    ctx1.record('build', { status: 'PASS', command: 'npm run build' });
    ctx1.shouldRun('lint');
    ctx1.record('lint', { status: 'PASS', command: 'npm run lint' });
    ctx1.persist();

    // 第 2 轮只碰 build，lint 的记录不能被抹掉（否则下一轮误判 first-run）
    const ctx2 = vcache.createContext(dir, { round: 2 });
    ctx2.shouldRun('build');
    ctx2.persist();
    const cache = vcache.readCache(dir);
    assert.ok(cache.lint, 'untouched check must survive persist');
    assert.strictEqual(cache.lint.round, 1);

    const ctx3 = vcache.createContext(dir, { round: 3 });
    assert.strictEqual(ctx3.reasonFor('lint'), 'cached', 'untouched check must not degrade to first-run');
  });
}

// ══ T7b selectTests ══

function testSelectTestsWithoutTestPlan() {
  const changed = ['src/a.js', 'docs/readme.md'];
  for (const spec of [null, undefined, {}, { test_plan: [] }, { test_plan: 'nope' }]) {
    const r = vcache.selectTests(spec, changed);
    assert.deepStrictEqual(r.selected, [], `no plan → nothing selected: ${JSON.stringify(spec)}`);
    assert.deepStrictEqual(r.uncovered, changed, 'every change is uncovered when there is no plan');
    assert.strictEqual(r.declared, false);
  }
}

function testSelectTestsWithoutPathDeclarations() {
  const changed = ['src/a.js', 'lib/b.js'];
  const spec = {
    test_plan: [
      { id: 'TEST-1', type: 'unit' },
      { id: 'TEST-2', type: 'e2e', paths: [] },
    ],
  };
  const r = vcache.selectTests(spec, changed);
  assert.deepStrictEqual(r.selected, ['TEST-1', 'TEST-2'], 'no paths declared → run everything (conservative)');
  assert.deepStrictEqual(r.uncovered, [], 'nothing is reported uncovered when the whole plan runs');
  assert.strictEqual(r.declared, false);
}

function testSelectTestsWithPartialPathDeclarations() {
  const changed = ['src/api/handler.js', 'src/ui/button.jsx', 'docs/notes.md'];
  const spec = {
    test_plan: [
      { id: 'TEST-API', paths: ['src/api'] },        // 目录前缀，无尾斜杠
      { id: 'TEST-UI', paths: ['src/ui/'] },         // 目录前缀，有尾斜杠
      { id: 'TEST-DB', paths: ['src/db'] },          // 本轮没命中
      { id: 'TEST-EXACT', paths: ['config/app.json'] }, // 精确文件，没命中
      { id: 'TEST-ALWAYS' },                          // 没有 paths → 无条件选中
    ],
  };
  const r = vcache.selectTests(spec, changed);
  assert.strictEqual(r.declared, true);
  assert.deepStrictEqual(r.selected.slice().sort(), ['TEST-ALWAYS', 'TEST-API', 'TEST-UI'], JSON.stringify(r.selected));
  assert.ok(!r.selected.includes('TEST-DB'), 'a test whose paths did not change must not be selected');
  assert.ok(!r.selected.includes('TEST-EXACT'));
  // 没有被任何 paths 覆盖的变更文件必须暴露出来（RK7 护栏）
  assert.deepStrictEqual(r.uncovered, ['docs/notes.md'], JSON.stringify(r.uncovered));

  // 精确文件匹配也要生效
  const exact = vcache.selectTests(spec, ['config/app.json']);
  assert.deepStrictEqual(exact.selected.slice().sort(), ['TEST-ALWAYS', 'TEST-EXACT']);
  assert.deepStrictEqual(exact.uncovered, []);

  // 前缀不能误伤同名兄弟目录（src/apiary 不属于 src/api）
  const sibling = vcache.selectTests(spec, ['src/apiary/x.js']);
  assert.ok(!sibling.selected.includes('TEST-API'), 'src/api must not match src/apiary');
  assert.deepStrictEqual(sibling.uncovered, ['src/apiary/x.js']);
}


function testCreateContextReusesTrustedBaselineOnlyForUnaffectedChecks() {
  withRepo({
    'src/app.js': 'module.exports = 1;\n',
    'docs/guide.md': '# guide\n',
  }, dir => {
    const baselineCommit = git(dir, ['rev-parse', 'HEAD']).trim();
    writeFile(dir, 'docs/guide.md', '# changed guide\n');
    const baseline = {
      identity: { commit: baselineCommit },
      completed_at: new Date().toISOString(),
      checks: {
        build: { status: 'PASS', command: 'npm run build' },
        tests: { status: 'PASS', command: 'npm test' },
        diff: { status: 'PASS', command: 'git diff' },
      },
    };
    const docsOnly = vcache.createContext(dir, { round: 1, baseline });
    assert.strictEqual(docsOnly.shouldRun('build'), false, 'docs-only change should reuse trusted build baseline');
    assert.strictEqual(docsOnly.reasonFor('build'), 'trusted-baseline');
    assert.strictEqual(docsOnly.cachedResult('build').cached_from_baseline, true);
    assert.strictEqual(docsOnly.shouldRun('tests'), false, 'docs-only change should reuse trusted test baseline');
    assert.strictEqual(docsOnly.shouldRun('diff'), true, 'uncacheable current-state checks must still execute');

    writeFile(dir, 'src/app.js', 'module.exports = 2;\n');
    const sourceChanged = vcache.createContext(dir, { round: 2, baseline });
    assert.strictEqual(sourceChanged.shouldRun('build'), true, 'source change must invalidate baseline build');
    assert.strictEqual(sourceChanged.reasonFor('build'), 'changed-since-baseline');
    assert.strictEqual(sourceChanged.shouldRun('tests'), true, 'source change must invalidate baseline tests');
  });
}


function testCreateContextFailsClosedWhenGitChangeDiscoveryFails() {
  withRepo({ 'src/app.js': 'module.exports = 1;\n' }, dir => {
    const baselineCommit = git(dir, ['rev-parse', 'HEAD']).trim();
    const baseline = {
      identity: { commit: baselineCommit },
      completed_at: new Date().toISOString(),
      checks: {
        build: { status: 'PASS', command: 'npm run build' },
        tests: { status: 'PASS', command: 'npm test' },
      },
    };
    vcache.writeCache(dir, {
      build: {
        fingerprint: vcache.fingerprint(dir, 'build', {}, []),
        status: 'PASS',
        round: 0,
        t: new Date().toISOString(),
        result: { command: 'npm run build' },
      },
    });
    const gitRunner = (command, args, options) => {
      if (command === 'git' && (args[0] === 'diff' || args[0] === 'ls-files' || args[0] === 'status')) {
        return { status: 128, stdout: '', stderr: 'injected git discovery failure' };
      }
      return spawnSync(command, args, options);
    };
    const ctx = vcache.createContext(dir, { round: 1, baseline, gitRunner });
    for (const check of ['build', 'tests']) {
      assert.strictEqual(ctx.shouldRun(check), true, `${check} must run when Git discovery fails`);
      assert.strictEqual(ctx.reasonFor(check), 'change-discovery-failed');
      assert.strictEqual(ctx.cachedResult(check), null);
    }
    const summary = ctx.summary();
    assert.strictEqual(summary.change_discovery_failed, true, JSON.stringify(summary));
    assert.deepStrictEqual(summary.cached, [], JSON.stringify(summary));
    assert.deepStrictEqual(summary.baseline_cached, [], JSON.stringify(summary));
  });
}

// ── runner ──

const tests = [
  // T1 任务生命周期
  testNewTaskIdShape,
  testNewTaskIdNormalizesSlug,
  testIsValidTaskId,
  testCurrentTaskIdRoundTrip,
  testSetCurrentTaskIdRejectsInvalidId,
  testCurrentTaskIdNullOnMissingEmptyOrInvalid,
  testTaskPathsLayout,
  // T2 向后兼容
  testResolveArtifactPathFallsBackToLegacy,
  testResolveArtifactPathUsesTaskDirWhenCurrentSet,
  testResolveArtifactPathFallsBackWhenCurrentCorrupt,
  // T3 tasks_dir 配置边界
  testTasksDirDefault,
  testTasksDirHonorsRelativeConfig,
  testTasksDirRejectsAbsoluteAndEscapingPaths,
  // T5 journal
  testJournalAppendAndRead,
  testJournalNormalizesUnknownKind,
  testJournalAppendsAreLineOriented,
  // T7 verify-cache
  testChangedFilesParsesPorcelainStatuses,
  testChangedFilesHandlesStagedModificationAndRename,
  testChangedFilesExcludesLedgerNoise,
  testFingerprintStabilityAndSensitivity,
  testCreateContextFirstRunThenCaches,
  testCreateContextSealIgnoresCache,
  testCreateContextRerunsPreviousNonPass,
  testPersistKeepsUntouchedCheckEntries,
  testCreateContextReusesTrustedBaselineOnlyForUnaffectedChecks,
  testCreateContextFailsClosedWhenGitChangeDiscoveryFails,
  // T7b selectTests
  testSelectTestsWithoutTestPlan,
  testSelectTestsWithoutPathDeclarations,
  testSelectTestsWithPartialPathDeclarations,
  // 证据路径解析 + gitignore（复审 N2 / N5）
  testStructuredEvidencePathSwitchesWithCurrent,
  testEvidenceSearchPathsTaskModeExcludesLegacy,
  testEvidenceSearchPathsLegacyModeOrder,
  testEvidencePathsFallBackOnCorruptCurrent,
  testTaskNewWritesWorkingGitignoreRules,
];

// ── 证据路径解析（复审 N2）：Critical 修复就落在这两个函数上，此前零单测覆盖。
// 第三轮变异测试 M3a 证明了后果——把 legacy 路径**追加**到任务模式的候选列表里，
// 6 个场景加 27 个单测全部保持绿，而实际行为退回 Santa F2（门禁读永不更新的旧快照）。
// 场景测试只覆盖夹具里出现过的组合；这里用精确相等锁住整个列表。

function testStructuredEvidencePathSwitchesWithCurrent() {
  withRepo(null, dir => {
    assert.strictEqual(
      ledger.structuredEvidencePath(dir),
      path.join(dir, '.harness/verify-evidence.json'),
      '无 CURRENT 时必须是 legacy 单例'
    );
    writeFile(dir, '.harness/CURRENT', 'T-20260726-alpha\n');
    assert.strictEqual(
      ledger.structuredEvidencePath(dir),
      path.join(dir, 'docs/tasks/T-20260726-alpha/evidence/verify-evidence.json'),
      '有 CURRENT 时必须落在任务目录'
    );
  });
}

function testEvidenceSearchPathsTaskModeExcludesLegacy() {
  withRepo(null, dir => {
    writeFile(dir, '.harness/CURRENT', 'T-20260726-alpha\n');
    const paths = ledger.evidenceSearchPaths(dir);
    const taskDir = path.join(dir, 'docs/tasks/T-20260726-alpha');
    // 精确相等而非"包含"——追加一个 legacy 路径也必须让这条断言失败。
    assert.deepStrictEqual(paths, [
      path.join(taskDir, 'evidence/verify-evidence.json'),
      path.join(taskDir, 'evidence/verify-evidence.md'),
      path.join(dir, 'docs/verification-report.md'),
    ], '任务模式的候选列表必须逐项相等');
    const harnessDir = path.join(dir, '.harness') + path.sep;
    for (const p of paths) {
      assert.ok(!p.startsWith(harnessDir),
        `任务模式下不得出现 .harness/ 证据（迁移残留会把门禁钉死在旧快照上）：${p}`);
    }
  });
}

function testEvidenceSearchPathsLegacyModeOrder() {
  withRepo(null, dir => {
    assert.deepStrictEqual(ledger.evidenceSearchPaths(dir), [
      path.join(dir, '.harness/verify-evidence.json'),
      path.join(dir, 'docs/verification-report.md'),
      path.join(dir, '.harness/last-verification.json'),
      path.join(dir, '.harness/verify-evidence.md'),
    ], '存量模式的顺序必须与升级前的 REPORT_PATHS 一致');
  });
}

function testEvidencePathsFallBackOnCorruptCurrent() {
  withRepo(null, dir => {
    writeFile(dir, '.harness/CURRENT', 'not-a-valid-id\n');
    assert.strictEqual(ledger.structuredEvidencePath(dir), path.join(dir, '.harness/verify-evidence.json'));
    assert.strictEqual(ledger.evidenceSearchPaths(dir).length, 4, '指针损坏时必须整体回落 legacy');
  });
}

// ── T6 的 gitignore 断言（复审 N5）：Santa 称之为"最刺眼的一条"，此前零回归锁。
function testTaskNewWritesWorkingGitignoreRules() {
  withRepo(null, dir => {
    const shk = path.join(__dirname, '..', 'scripts', 'shk.js');
    const r = spawnSync('node', [shk, 'task', 'new', 'alpha', '--title', 't'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `task new 应成功: ${r.stderr}`);
    const ignored = rel => spawnSync('git', ['check-ignore', '-q', rel], { cwd: dir }).status === 0;
    assert.ok(ignored('.harness/CURRENT'),
      'CURRENT 必须被忽略——它是本机指针，跨机同步会让两台机器互相覆盖当前任务');
    assert.ok(!ignored('.harness/config.json'),
      'config.json 必须能进 git；用 .harness/ 而不是 .harness/* 会让这条取反失效');
    const id = fs.readFileSync(path.join(dir, '.harness/CURRENT'), 'utf8').trim();
    assert.ok(!ignored(`docs/tasks/${id}/task.json`),
      '任务产出必须能进 git，它是跨机器接力的唯一载体');
  });
}

let pass = 0;
for (const t of tests) {
  try {
    t();
    pass++;
    console.log('PASS', t.name);
  } catch (err) {
    console.error('FAIL', t.name);
    console.error(err && err.stack || err);
    process.exit(1);
  }
}
console.log(`${pass}/${tests.length} task ledger tests passed`);

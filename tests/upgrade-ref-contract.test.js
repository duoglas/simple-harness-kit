#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const KIT = path.resolve(__dirname, '..');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function put(root, name, content) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function withFixture(run) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-upgrade-contract-'));
  const seed = path.join(temp, 'seed');
  const remote = path.join(temp, 'simple-harness-kit.git');
  const project = path.join(temp, 'project');
  const logs = path.join(temp, 'logs');
  fs.mkdirSync(seed);
  fs.mkdirSync(logs);
  try {
    git(seed, ['init', '-q']);
    git(seed, ['branch', '-M', 'master']);
    git(seed, ['config', 'user.name', 'SHK test']);
    git(seed, ['config', 'user.email', 'test@example.com']);
    git(seed, ['config', 'commit.gpgsign', 'false']);
    git(seed, ['config', 'tag.gpgsign', 'false']);
    put(seed, 'methodology/fixture.md', '# contract fixture\n');
    put(seed, 'manifests/shk-profiles.json', '{}\n');
    put(seed, 'upgrade.sh', 'DEFAULT_REF="v-fixture"\n');
    put(seed, 'scripts/lib/task-ledger.js', 'module.exports = {};\n');
    put(seed, 'scripts/shk.js', 'console.log(JSON.stringify({overall:"PASS",checks:[]}));\n');
    // Other checks are controlled positives: this fixture isolates the actual
    // upgrade-ref script and the real pre-release status aggregator.
    put(seed, 'tests/run.js', 'console.log("fixture checks completed");\n');
    for (const name of [
      'scripts/17-oss-dogfood-validation.sh', 'scripts/18-upstream-ci-dogfood.sh',
      'scripts/19-browser-e2e-dogfood.sh', 'codex-smoke.sh', 'codex-smoke-selftest.sh',
    ]) put(seed, `tests/${name}`, '#!/bin/bash\necho "PASS: controlled fixture"\n');
    put(seed, 'tests/scripts/21-upgrade-ref-contract.sh',
      fs.readFileSync(path.join(KIT, 'tests/scripts/21-upgrade-ref-contract.sh'), 'utf8'));
    put(seed, 'tests/pre-release-check.sh',
      fs.readFileSync(path.join(KIT, 'tests/pre-release-check.sh'), 'utf8')
        .replaceAll('/tmp/pre-release-', `${logs}/pre-release-`));
    git(seed, ['add', '.']);
    git(seed, ['commit', '-qm', 'fixture']);
    git(seed, ['tag', 'v-fixture']);
    git(temp, ['init', '--bare', '-q', remote]);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
    git(seed, ['push', '-q', remote, 'master', 'refs/tags/v-fixture']);
    git(temp, ['clone', '-q', '--no-local', remote, project]);
    git(project, ['config', 'user.name', 'SHK test']);
    git(project, ['config', 'user.email', 'test@example.com']);
    git(project, ['config', 'commit.gpgsign', 'false']);
    run({ temp, seed, remote, project });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function check(project, entry = 'tests/scripts/21-upgrade-ref-contract.sh') {
  const result = spawnSync('bash', [entry], {
    cwd: project, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { ...result, output: `${result.stdout || ''}\n${result.stderr || ''}` };
}

const cases = [
  ['remote tree cannot be vouched for by a different local tag', () => withFixture(({ seed, remote, project }) => {
    fs.unlinkSync(path.join(seed, 'scripts/shk.js'));
    git(seed, ['commit', '-qam', 'remote missing CLI']);
    git(seed, ['tag', '-f', 'v-fixture']);
    git(seed, ['push', '-q', '--force', remote, 'refs/tags/v-fixture']);
    const result = check(project);
    assert.strictEqual(result.status, 1, result.output);
    assert.match(result.output, /scripts\/shk\.js/);
  })],
  ['valid remote tree wins over a stale local tag', () => withFixture(({ project }) => {
    fs.unlinkSync(path.join(project, 'scripts/shk.js'));
    git(project, ['commit', '-qam', 'stale local tag']);
    git(project, ['tag', '-f', 'v-fixture']);
    const result = check(project);
    assert.strictEqual(result.status, 0, result.output);
    assert.match(result.output, /3 passed, 0 failed/);
  })],
  ['missing remote objects are verified without moving local refs', () => withFixture(({ seed, remote, project }) => {
    put(seed, 'remote-only.md', 'new remote object\n');
    git(seed, ['add', 'remote-only.md']);
    git(seed, ['commit', '-qm', 'remote candidate']);
    git(seed, ['tag', '-f', 'v-fixture']);
    git(seed, ['push', '-q', '--force', remote, 'refs/tags/v-fixture']);
    const wanted = git(seed, ['rev-parse', 'HEAD']);
    const localRef = git(project, ['rev-parse', 'refs/tags/v-fixture']);
    const result = check(project);
    assert.strictEqual(result.status, 0, result.output);
    assert.strictEqual(git(project, ['rev-parse', 'refs/tags/v-fixture']), localRef);
    git(project, ['cat-file', '-e', `${wanted}:scripts/shk.js`]);
    assert.strictEqual(git(project, ['status', '--porcelain']), '');
  })],
  ['offline upgrade proof stays SKIP and blocks pre-release', () => withFixture(({ remote, project }) => {
    fs.renameSync(remote, `${remote}.offline`);
    const result = check(project, 'tests/pre-release-check.sh');
    assert.strictEqual(result.status, 1, result.output);
    assert.match(result.output, /SKIP: upgrade DEFAULT_REF/);
    assert.match(result.output, /PASS=9 SKIP=1 DEGRADED=0 WARN=0 FAIL=0/);
    assert.match(result.output, /Pre-Release Check: NOT_READY/);
  })],
  ['annotated remote tags resolve to their commit tree', () => withFixture(({ seed, remote, project }) => {
    git(seed, ['tag', '-fa', 'v-fixture', '-m', 'annotated fixture']);
    git(seed, ['push', '-q', '--force', remote, 'refs/tags/v-fixture']);
    const result = check(project);
    assert.strictEqual(result.status, 0, result.output);
    assert.match(result.output, /3 passed, 0 failed/);
  })],
  ['missing or ambiguous remote refs cannot use the local tag', () => withFixture(({ seed, remote, project }) => {
    git(seed, ['push', '-q', remote, 'HEAD:refs/heads/v-fixture']);
    assert.strictEqual(check(project).status, 1, 'same tag and branch name must be rejected');
    git(seed, ['push', '-q', remote, ':refs/heads/v-fixture', ':refs/tags/v-fixture']);
    assert.strictEqual(check(project).status, 1, 'local tag cannot prove a missing remote ref');
  })],
  ['required script paths must be ordinary files', () => withFixture(({ seed, remote, project }) => {
    fs.unlinkSync(path.join(seed, 'scripts/shk.js'));
    fs.symlinkSync('lib/task-ledger.js', path.join(seed, 'scripts/shk.js'));
    git(seed, ['add', 'scripts/shk.js']);
    git(seed, ['commit', '-qm', 'remote symlink']);
    git(seed, ['tag', '-f', 'v-fixture']);
    git(seed, ['push', '-q', '--force', remote, 'refs/tags/v-fixture']);
    assert.strictEqual(check(project).status, 1, 'symlink is not the required CLI file');
  })],
];

// A URL can also name a configured remote. Source-only refspecs must not
// inherit that remote's destination mappings while retrieving a missing object.
for (const [label, relativeUrl, destination, sourceKind] of [
  ['default configuration with a tag ref', false, null, 'tag'],
  ['relative URL without a colliding remote', true, null, 'tag'],
  ['relative URL with a branch destination mapping', true, 'refs/heads/probe-moved', 'tag'],
  ['relative URL with a tag destination mapping', true, 'refs/tags/probe-moved', 'tag'],
  ['relative URL with a tracking destination mapping', true, 'refs/remotes/probe/moved', 'tag'],
  ['relative URL with a mapped branch source', true, 'refs/heads/probe-moved', 'branch'],
]) {
  cases.push([`missing-object retrieval preserves refs and FETCH_HEAD: ${label}`, () => withFixture(({ seed, remote, project }) => {
    put(seed, 'remote-only.md', 'missing object fetched from the actual remote\n');
    git(seed, ['add', 'remote-only.md']);
    git(seed, ['commit', '-qm', 'remote object retrieval fixture']);
    const wanted = git(seed, ['rev-parse', 'HEAD']);
    const sourceRef = `refs/${sourceKind === 'tag' ? 'tags' : 'heads'}/v-fixture`;
    if (sourceKind === 'tag') {
      git(seed, ['tag', '-f', 'v-fixture']);
      git(seed, ['push', '-q', '--force', remote, sourceRef]);
    } else {
      git(seed, ['push', '-q', remote, ':refs/tags/v-fixture', `HEAD:${sourceRef}`]);
    }
    const missing = spawnSync('git', ['--no-replace-objects', 'cat-file', '-e', `${wanted}^{commit}`], {
      cwd: project, encoding: 'utf8', timeout: 15000,
    });
    assert.strictEqual(missing.status, 128, 'the actual remote commit must be missing before retrieval');
    if (relativeUrl) {
      const url = `../${path.basename(remote)}`;
      git(project, ['remote', 'set-url', 'origin', url]);
      if (destination) {
        git(project, ['update-ref', destination, 'HEAD']);
        git(project, ['config', `remote.${url}.url`, url]);
        git(project, ['config', `remote.${url}.fetch`, `+${sourceRef}:${destination}`]);
      }
    }
    const fetchHead = path.join(project, '.git/FETCH_HEAD');
    put(project, '.git/FETCH_HEAD', `${git(project, ['rev-parse', 'HEAD'])}\t\tlocal fixture sentinel\n`);
    const previousFetchHead = fs.readFileSync(fetchHead);
    const refs = () => git(project, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)']);
    const previousRefs = refs();
    const result = check(project);
    assert.strictEqual(result.status, 0, result.output);
    assert.match(result.output, /3 passed, 0 failed/);
    assert.strictEqual(refs(), previousRefs, 'object retrieval must preserve every existing ref');
    assert.deepStrictEqual(fs.readFileSync(fetchHead), previousFetchHead, 'FETCH_HEAD must remain byte-identical');
    git(project, ['--no-replace-objects', 'cat-file', '-e', `${wanted}^{commit}`]);
    for (const file of ['scripts/lib/task-ledger.js', 'scripts/shk.js']) {
      assert.strictEqual(git(project, ['--no-replace-objects', 'show', `${wanted}:${file}`]),
        git(seed, ['--no-replace-objects', 'show', `${wanted}:${file}`]));
    }
    assert.strictEqual(git(project, ['status', '--porcelain']), '');
  })]);
}

// Exercise the actual object-checking block without a remote: every object is
// present locally, and fetch has no usable destination. The earlier integration
// cases cover remote resolution and object retrieval separately.
for (const format of ['sha1', 'sha256']) {
  for (const replacementType of ['commit', 'tree']) {
    for (const rawComplete of [false, true]) {
      cases.push([`upgrade content uses raw ${format} ${replacementType} objects (${rawComplete ? 'complete' : 'missing'})`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shk-upgrade-raw-'));
        try {
          git(root, ['init', '-q', `--object-format=${format}`]);
          git(root, ['config', 'user.name', 'SHK object test']);
          git(root, ['config', 'user.email', 'test@example.invalid']);
          git(root, ['config', 'commit.gpgsign', 'false']);
          put(root, 'README.md', 'local object consistency fixture\n');
          git(root, ['add', '.']);
          git(root, ['commit', '-qm', 'missing required files']);
          const missing = git(root, ['rev-parse', 'HEAD']);
          put(root, 'scripts/lib/task-ledger.js', 'module.exports = {};\n');
          put(root, 'scripts/shk.js', 'module.exports = {};\n');
          git(root, ['add', '.']);
          git(root, ['commit', '-qm', 'complete required files']);
          const complete = git(root, ['rev-parse', 'HEAD']);
          const raw = rawComplete ? complete : missing;
          const replacement = rawComplete ? missing : complete;
          const object = oid => replacementType === 'tree' ? git(root, ['rev-parse', `${oid}^{tree}`]) : oid;
          git(root, ['update-ref', `refs/replace/${object(raw)}`, object(replacement)]);
          const script = fs.readFileSync(path.join(KIT, 'tests/scripts/21-upgrade-ref-contract.sh'), 'utf8');
          const marker = '# 仅下载对象';
          assert.ok(script.includes(marker), 'object validation block exists');
          const prefix = 'set -uo pipefail\nROOT="$PWD"\nPASS=0; FAIL=0\nREF=local-object\n' +
            `REMOTE_SHA=${raw}\nREMOTE=/dev/null\nREMOTE_REF=refs/heads/unused\n` +
            'ok(){ PASS=$((PASS+1)); }\nbad(){ FAIL=$((FAIL+1)); }\n';
          const result = spawnSync('bash', [], {
            cwd: root, input: prefix + script.slice(script.indexOf(marker)),
            encoding: 'utf8', timeout: 15000,
          });
          assert.strictEqual(result.status, rawComplete ? 0 : 1, result.stdout + result.stderr);
          assert.match(result.stdout, rawComplete ? /2 passed, 0 failed/ : /0 passed, 2 failed/);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      }]);
    }
  }
}

let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(`${cases.length - failed}/${cases.length} upgrade ref contract tests passed`);
process.exitCode = failed ? 1 : 0;

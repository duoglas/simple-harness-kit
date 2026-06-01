#!/usr/bin/env node
'use strict';

/**
 * Hook 自动化功能测试 Runner
 *
 * 用法: node tests/run.js [--filter <pattern>]
 *
 * 场景格式 (JSON):
 * {
 *   "name": "场景描述",
 *   "hook": "xxx.js",                     // scripts/hooks/ 下的文件名
 *   "stdin": { ... },                      // 喂给 hook 的 JSON stdin
 *   "env": { "KEY": "val" },              // 可选环境变量
 *   "setup": {                             // 可选：在临时目录中预创建文件
 *     ".harness/current-stage.json": "{\"stage\":\"PLAN\",\"since\":\"...\",\"task\":\"test\"}"
 *   },
 *   "expect": {
 *     "exitCode": 0,                       // 预期 exit code
 *     "stderr": ["关键词1"],               // stderr 必须包含
 *     "stderrNot": ["不应出现"],           // stderr 必须不包含
 *     "stdout": "empty",                   // "empty" = stdout 必须为空（Codex 兼容要求；推荐）
 *                                          // "passthrough" = stdout 应等于 stdin（deprecated）
 *     "files": {                           // 可选：检查输出文件
 *       ".harness/observations.jsonl": { "contains": "tool" },
 *       // contains 可以是 string（单项）或 string[]（多项，全部必须命中）
 *       // containsNot 同样支持 string | string[]，要求文件中"不应"出现这些字符串
 *       ".harness/session-log.md": {
 *         "contains": ["关键词 A", "关键词 B"],
 *         "containsNot": ["禁词 X"]
 *       }
 *     },
 *     "dirs": {                            // 可选：检查目录中是否存在符合命名的文件
 *       ".harness/observations.archive": {
 *         "matches": "^observations-[a-z0-9]+-.*\\.jsonl$",  // 文件名正则
 *         "minCount": 1,                                       // 至少匹配数
 *         "contains": ["tool"]                                 // 至少一个匹配文件需包含所有 needles
 *       }
 *     }
 *   }
 * }
 *
 * 每个场景在独立临时目录中运行，互不干扰。
 */

const { execFileSync, execFile, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOKS_BASE = path.resolve(__dirname, '..', 'scripts', 'hooks');
const SCENARIOS_DIR = path.join(__dirname, 'hook-scenarios');

// ── 解析参数 ──

const args = process.argv.slice(2);
const filterIdx = args.indexOf('--filter');
const filter = filterIdx !== -1 ? args[filterIdx + 1] : null;

// ── 收集场景文件 ──

function loadScenarios() {
  if (!fs.existsSync(SCENARIOS_DIR)) {
    console.error(`场景目录不存在: ${SCENARIOS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(SCENARIOS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

  const scenarios = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf8'));
      // 支持单个场景或场景数组
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        item._file = f;
        if (!filter || item.name.includes(filter) || f.includes(filter)) {
          scenarios.push(item);
        }
      }
    } catch (e) {
      console.error(`加载失败 ${f}: ${e.message}`);
    }
  }
  return scenarios;
}

function runBashScript(script, options = {}) {
  const res = spawnSync('bash', [script], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return {
    ...res,
    combinedOutput: `${res.stdout || ''}${res.stderr || ''}`,
  };
}

function isDegradedOrSkipped(output) {
  return /\b(DEGRADED|SKIP)\b/.test(output);
}

// ── 创建临时目录并预置文件 ──

// 生成最新动态时间戳（1 分钟前，距离当前足够新可通过 since 校验）
function recentTimestamp() {
  return new Date(Date.now() - 60 * 1000).toISOString();
}

// 通用时间戳占位符替换：RECENT_TIMESTAMP + TS_OFFSET_<±N><S|M|H>
// 例：TS_OFFSET_-15M = 15 分钟前；TS_OFFSET_+45M = 45 分钟后；TS_OFFSET_-7200S = 2 小时前
// 用于 since drift 窗口边界测试（VH-14：新 30 分钟窗口验证）
function substituteTimestamps(s) {
  let out = String(s).replace(/RECENT_TIMESTAMP/g, recentTimestamp());
  out = out.replace(/TS_OFFSET_([+-]?\d+)([SMH])/g, (_, n, unit) => {
    const mult = unit === 'S' ? 1000 : unit === 'M' ? 60 * 1000 : 60 * 60 * 1000;
    return new Date(Date.now() + parseInt(n, 10) * mult).toISOString();
  });
  return out;
}

function setupTempDir(scenario) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));

  // kitPresets: true → copy <kit>/presets/ into tmpDir + create .harness/ marker
  // so find-root.js latches onto tmpDir and load-preset.js sees the real preset data.
  // Used by branch-policy-guard / commit-check scenarios that depend on preset files.
  if (scenario.kitPresets) {
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    const srcPresets = path.resolve(__dirname, '..', 'presets');
    const dstPresets = path.join(tmpDir, 'presets');
    if (fs.existsSync(srcPresets)) {
      fs.cpSync(srcPresets, dstPresets, { recursive: true });
    }
  }

  if (scenario.setup) {
    for (const [filePath, rawContent] of Object.entries(scenario.setup)) {
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      // Object form: support symlink_to (for symlink bypass tests, #30)
      if (rawContent && typeof rawContent === 'object' && rawContent.symlink_to) {
        // Resolve target relative to tmpDir if not absolute
        const target = path.isAbsolute(rawContent.symlink_to)
          ? rawContent.symlink_to
          : path.join(tmpDir, rawContent.symlink_to);
        // Optionally create the target file with given content first
        if (rawContent.target_content !== undefined) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, substituteTimestamps(rawContent.target_content));
        }
        try {
          fs.symlinkSync(target, fullPath);
        } catch (e) {
          // Windows without SeCreateSymbolicLinkPrivilege / Developer Mode → EPERM.
          // Some sandboxed envs → EACCES. Surface as SKIP so symlink-dependent
          // scenarios don't kill the whole runner.
          if (e.code === 'EPERM' || e.code === 'EACCES') {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
            const err = new Error(`symlink not permitted on this platform (${e.code})`);
            err.code = 'SYMLINK_UNAVAILABLE';
            throw err;
          }
          throw e;
        }
      } else {
        // String form: write file with placeholder substitution
        fs.writeFileSync(fullPath, substituteTimestamps(rawContent));
      }
    }
  }

  // gitSetup: 初始化 git 仓库并 stage 指定文件（用于 verification-gate C-GATE-07 测试等）
  // 格式: { "init": true, "stage": ["path/to/file", ...] }
  // stage 之前 setup 里必须先创建对应文件（或 gitSetup.create 可选填充空文件）
  if (scenario.gitSetup) {
    const { execFileSync } = require('child_process');
    const gs = scenario.gitSetup;
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpDir, stdio: 'ignore' });
      // create: 创建空占位文件（如果 setup 里没创建）
      if (Array.isArray(gs.create)) {
        for (const f of gs.create) {
          const full = path.join(tmpDir, f);
          if (!fs.existsSync(full)) {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, '');
          }
        }
      }
      if (Array.isArray(gs.stage)) {
        for (const f of gs.stage) {
          execFileSync('git', ['add', '-f', f], { cwd: tmpDir, stdio: 'ignore' });
        }
      }
    } catch (e) {
      // git 不可用或初始化失败，测试会走非 kit 路径；不抛出
    }
  }

  return tmpDir;
}

// ── 运行单个场景 ──

function runScenario(scenario) {
  const hookPath = path.join(HOOKS_BASE, scenario.hook);
  if (!fs.existsSync(hookPath)) {
    return { pass: false, reason: `Hook 不存在: ${hookPath}` };
  }

  let tmpDir;
  try {
    tmpDir = setupTempDir(scenario);
  } catch (e) {
    if (e.code === 'SYMLINK_UNAVAILABLE') {
      return { pass: true, skipped: true, reason: e.message };
    }
    return { pass: false, reason: `setup failed: ${e.message}` };
  }
  // stdin 支持 RECENT_TIMESTAMP 与 TS_OFFSET_<±N><S|M|H> 占位符（见 substituteTimestamps）
  const stdinData = scenario.stdin
    ? substituteTimestamps(JSON.stringify(scenario.stdin))
    : '';
  const env = {
    ...process.env,
    ...(scenario.env || {}),
  };

  const errors = [];

  try {
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    // cwdSub: scenario 可以把 hook 的 cwd 设为 tmpDir 的子目录（必须先在
    //   setup 里创建出来）。用于测 find-root 的 worktree 边界识别等需要
    //   特定 cwd 模式的场景。默认仍是 tmpDir 根。
    let runCwd = tmpDir;
    if (typeof scenario.cwdSub === 'string' && scenario.cwdSub.length > 0) {
      runCwd = path.join(tmpDir, scenario.cwdSub);
    }

    try {
      const result = require('child_process').spawnSync(
        process.execPath, [hookPath],
        {
          input: stdinData,
          cwd: runCwd,
          env,
          timeout: 5000,
          encoding: 'utf8',
        }
      );
      stdout = result.stdout || '';
      stderr = result.stderr || '';
      exitCode = result.status ?? 1;
    } catch (e) {
      exitCode = e.status ?? 1;
      stderr = e.stderr || '';
      stdout = e.stdout || '';
    }

    const expect = scenario.expect || {};

    // 检查 exit code
    if (expect.exitCode !== undefined && exitCode !== expect.exitCode) {
      errors.push(`exit code: 期望 ${expect.exitCode}, 实际 ${exitCode}`);
    }

    // 检查 stderr 包含
    if (expect.stderr) {
      for (const keyword of expect.stderr) {
        if (!stderr.includes(keyword)) {
          errors.push(`stderr 未包含: "${keyword}"`);
        }
      }
    }

    // 检查 stderr 不包含
    if (expect.stderrNot) {
      for (const keyword of expect.stderrNot) {
        if (stderr.includes(keyword)) {
          errors.push(`stderr 不应包含: "${keyword}"`);
        }
      }
    }

    // 检查 stdout 契约
    // "empty"（推荐）: stdout 必须为空（Codex 0.118.0 要求；Claude Code 也兼容）
    // "passthrough"（deprecated，保留兼容旧场景）: stdout 应等于 stdin
    if (expect.stdout === 'empty') {
      if (stdout.length !== 0) {
        errors.push(`stdout 必须为空，实际: ${JSON.stringify(stdout.slice(0, 80))}`);
      }
    } else if (expect.stdout === 'passthrough') {
      if (stdout.trim() !== stdinData.trim()) {
        errors.push('stdout 未透传 stdin');
      }
    }

    // 检查目录中匹配文件名的项（用于 archive 等动态文件名场景）
    if (expect.dirs) {
      for (const [dirPath, check] of Object.entries(expect.dirs)) {
        const fullDir = path.join(tmpDir, dirPath);
        if (!fs.existsSync(fullDir)) {
          if (check.exists !== false) errors.push(`目录不存在: ${dirPath}`);
          continue;
        }
        if (check.exists === false) {
          errors.push(`目录不应存在: ${dirPath}`);
          continue;
        }
        let entries;
        try {
          entries = fs.readdirSync(fullDir);
        } catch (e) {
          errors.push(`无法读取目录 ${dirPath}: ${e.message}`);
          continue;
        }
        let matched = entries;
        if (check.matches) {
          const re = new RegExp(check.matches);
          matched = entries.filter(e => re.test(e));
        }
        const minCount = check.minCount !== undefined ? check.minCount : 1;
        if (matched.length < minCount) {
          errors.push(`目录 ${dirPath} 匹配 ${check.matches || '*'} 数量 ${matched.length} < ${minCount}`);
        }
        if (check.contains !== undefined && matched.length > 0) {
          const needles = Array.isArray(check.contains) ? check.contains : [check.contains];
          const ok = matched.some(name => {
            try {
              const c = fs.readFileSync(path.join(fullDir, name), 'utf8');
              return needles.every(n => c.includes(n));
            } catch { return false; }
          });
          if (!ok) {
            errors.push(`目录 ${dirPath} 中没有匹配文件包含 ${JSON.stringify(needles)}`);
          }
        }
      }
    }

    // 检查输出文件
    if (expect.files) {
      for (const [filePath, check] of Object.entries(expect.files)) {
        const fullPath = path.join(tmpDir, filePath);
        if (check.exists === false) {
          if (fs.existsSync(fullPath)) {
            errors.push(`文件不应存在: ${filePath}`);
          }
        } else {
          if (!fs.existsSync(fullPath)) {
            errors.push(`文件不存在: ${filePath}`);
          } else {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (check.contains !== undefined) {
              const needles = Array.isArray(check.contains) ? check.contains : [check.contains];
              for (const needle of needles) {
                if (!content.includes(needle)) {
                  errors.push(`文件 ${filePath} 未包含: "${needle}"`);
                }
              }
            }
            if (check.containsNot !== undefined) {
              const forbidden = Array.isArray(check.containsNot) ? check.containsNot : [check.containsNot];
              for (const f of forbidden) {
                if (content.includes(f)) {
                  errors.push(`文件 ${filePath} 不应包含: "${f}"`);
                }
              }
            }
            // 精确出现次数断言：containsCount: { "needle": N }
            //   N 的语义: 该 substring 在文件内容中必须出现恰好 N 次
            //   用于检测重复/缺失（如 append 操作不应该让某个 sentinel 多出来）
            if (check.containsCount !== undefined) {
              for (const [needle, expectedCount] of Object.entries(check.containsCount)) {
                // 全局非重叠次数计数
                let count = 0;
                let idx = 0;
                while ((idx = content.indexOf(needle, idx)) !== -1) {
                  count++;
                  idx += needle.length;
                }
                if (count !== expectedCount) {
                  errors.push(`文件 ${filePath} 子串 "${needle}" 出现 ${count} 次, 期望 ${expectedCount} 次`);
                }
              }
            }
          }
        }
      }
    }
  } finally {
    // 清理临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return errors.length === 0
    ? { pass: true }
    : { pass: false, reason: errors.join('; ') };
}

// ── 主流程 ──

const scenarios = loadScenarios();
console.log(`\n  Hook 功能测试 — ${scenarios.length} 个场景\n`);

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

for (const s of scenarios) {
  const result = runScenario(s);
  if (result.skipped) {
    skipped++;
    console.log(`  SKIP  ${s.name} (${result.reason})`);
  } else if (result.pass) {
    passed++;
    console.log(`  PASS  ${s.name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${s.name}`);
    console.log(`        ${result.reason}`);
    failures.push({ name: s.name, file: s._file, reason: result.reason });
  }
}

console.log(`\n  ──────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped, ${scenarios.length} total\n`);

if (failures.length > 0) {
  console.log('  失败详情:');
  for (const f of failures) {
    console.log(`  - [${f.file}] ${f.name}: ${f.reason}`);
  }
  console.log();
}

// ── find-root unit tests (VH-18 C-WORK-02, F5) ──
// 纯函数 detectWorktreeRoot / isLegitimateHarnessRoot 的边界测试。
// 集成路径见 tests/hook-scenarios/find-root.json；此处只覆盖跨平台路径
// 与 Unicode-safe edge case（hook-scenarios 在 Unix 文件系统跑，
// Windows 反斜杠路径无法用 cwd 表达，必须纯函数测）。
const { detectWorktreeRoot, isLegitimateHarnessRoot } = require('../scripts/hooks/find-root');
const findRootUnit = (() => {
  const results = [];
  const exp = (name, got, want) => {
    const ok = got === want;
    results.push({ name, ok, reason: ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}` });
  };
  exp('detectWorktreeRoot: Unix worktree root', detectWorktreeRoot('/main/.claude/worktrees/foo'), '/main/.claude/worktrees/foo');
  exp('detectWorktreeRoot: Unix worktree subdir', detectWorktreeRoot('/main/.claude/worktrees/foo/src/x.js'), '/main/.claude/worktrees/foo');
  exp('detectWorktreeRoot: Unix non-worktree', detectWorktreeRoot('/main/random/cwd'), null);
  exp('detectWorktreeRoot: 嵌套 worktree → 最内层', detectWorktreeRoot('/main/.claude/worktrees/a/.claude/worktrees/b/x'), '/main/.claude/worktrees/a/.claude/worktrees/b');
  exp('detectWorktreeRoot: Windows worktree root (F5)', detectWorktreeRoot('C:\\repo\\.claude\\worktrees\\agent-a'), 'C:/repo/.claude/worktrees/agent-a');
  exp('detectWorktreeRoot: Windows worktree subdir (F5)', detectWorktreeRoot('C:\\repo\\.claude\\worktrees\\agent-a\\src'), 'C:/repo/.claude/worktrees/agent-a');
  exp('detectWorktreeRoot: Windows non-worktree (F5)', detectWorktreeRoot('C:\\repo\\foo'), null);
  exp('detectWorktreeRoot: empty string', detectWorktreeRoot(''), null);
  exp('detectWorktreeRoot: null input', detectWorktreeRoot(null), null);
  // isLegitimateHarnessRoot — 用 /tmp 沙盒
  const tmpFs = require('fs');
  const tmpPath = require('path');
  const tmpOs = require('os');
  const sandbox = tmpFs.mkdtempSync(tmpPath.join(tmpOs.tmpdir(), 'find-root-unit-'));
  const wtPath = tmpPath.join(sandbox, '.claude/worktrees/wt-a');
  const withHarness = tmpPath.join(sandbox, 'p1');
  tmpFs.mkdirSync(wtPath, { recursive: true });
  tmpFs.mkdirSync(tmpPath.join(withHarness, '.harness'), { recursive: true });
  exp('isLegitimateHarnessRoot: 普通空目录 → false (F3)', isLegitimateHarnessRoot(sandbox), false);
  exp('isLegitimateHarnessRoot: worktree-pattern 目录 → true', isLegitimateHarnessRoot(wtPath), true);
  exp('isLegitimateHarnessRoot: 已存 .harness/ → true', isLegitimateHarnessRoot(withHarness), true);
  exp('isLegitimateHarnessRoot: 不存在路径 → false', isLegitimateHarnessRoot('/nonexistent/abc/xyz'), false);
  try { tmpFs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
  return {
    pass: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length,
    results,
  };
})();
console.log('  find-root Unit Tests (VH-18)\n');
for (const r of findRootUnit.results) {
  if (r.ok) console.log(`  PASS  ${r.name}`);
  else { console.log(`  FAIL  ${r.name}`); console.log(`        ${r.reason}`); }
}
console.log(`\n  ${findRootUnit.pass} passed, ${findRootUnit.fail} failed, ${findRootUnit.results.length} total\n`);

// ── Template Integrity Tests ──
// 校验 templates/settings-json.tmpl 等 kit 模板文件的结构完整性，
// 防止模板层漂移潜伏到 E2E 才被发现。详见 tests/template-integrity.js。
const { runTemplateIntegrityTests } = require('./template-integrity');
const tpl = runTemplateIntegrityTests();
console.log('  Template Integrity Tests\n');
for (const r of tpl.results) {
  if (r.ok) {
    console.log(`  PASS  ${r.name}`);
  } else {
    console.log(`  FAIL  ${r.name}`);
    console.log(`        ${r.reason}`);
  }
}
console.log(`\n  ${tpl.pass} passed, ${tpl.fail} failed, ${tpl.results.length} total\n`);

// ── Scripted Test Matrix (tests/scripts/run-all.sh) ──
// 维度 1-7 install/update/skill-path/e2e/invariant/mutation/pathstyle/scope
// 纯 shell 测试, 不依赖 Node 测试框架. 结果作为 run.js 总 exit code 的一部分.
//
// 本块用于 catch 的问题: install.sh / update.sh / skill 安装结构 / SKILL.md 路径
// 层面的 bug (VH-10 问题 A + B). hook scenarios 和 template-integrity 都在静态
// + hook runtime 层, 但不会实际跑 install.sh, 所以这一层是必要补充.
let scriptedFailed = 0;
let scriptedTotal = 0;
try {
  const scriptsRunner = path.resolve(__dirname, 'scripts', 'run-all.sh');
  if (fs.existsSync(scriptsRunner)) {
    console.log('  Scripted Test Matrix (tests/scripts/run-all.sh)\n');
    const res = require('child_process').spawnSync('bash', [scriptsRunner], {
      stdio: 'inherit',
      timeout: 10 * 60 * 1000, // 10 分钟上限
    });
    scriptedTotal = 1; // 作为一个整体 section
    if (res.status !== 0) {
      scriptedFailed = 1;
      console.log(`\n  Scripted Matrix FAIL (exit ${res.status})\n`);
    } else {
      console.log(`\n  Scripted Matrix PASS\n`);
    }
  } else {
    console.log(`  Scripted Matrix SKIP (runner 不存在: ${scriptsRunner})\n`);
  }
} catch (e) {
  scriptedFailed = 1;
  console.log(`  Scripted Matrix FAIL: ${e.message}\n`);
}

// ── Codex Runtime Smoke (C-GATE-08, VH-15) ──
// 真正启动 codex CLI 跑一次 "Read README.md"，断言 hook 层无 "Failed" 告警。
// 动机: VH-13 (passthrough stdout) 和假想的 VH-15 都是 Codex runtime 层 bug，
// 静态 / 模板层完全无感。唯一可靠守门是真跑一次 codex。
// 默认策略: 本地无 codex → SKIP + warn (不阻塞主流程);
// CI 或强制模式: CODEX_REQUIRED=1 → 无 codex 升级为 FAIL.
let smokeFailed = 0;
let smokeTotal = 0;
try {
  const smokeScript = path.resolve(__dirname, 'codex-smoke.sh');
  const selftestScript = path.resolve(__dirname, 'codex-smoke-selftest.sh');
  if (fs.existsSync(smokeScript)) {
    console.log('  Codex Runtime Smoke (C-GATE-08)\n');
    const env = { ...process.env };
    // run.js 里默认不升级；CI 通过 CODEX_REQUIRED=1 外部注入
    const res = runBashScript(smokeScript, {
      env,
      timeout: 5 * 60 * 1000,
    });
    smokeTotal += 1;
    if (res.status !== 0) {
      smokeFailed += 1;
      console.log(`\n  Codex Smoke FAIL (exit ${res.status})\n`);
    } else {
      // 反向自测：确保 smoke 本身能捕获 bad hook
      if (fs.existsSync(selftestScript)) {
        const st = runBashScript(selftestScript, {
          env,
          timeout: 5 * 60 * 1000,
        });
        smokeTotal += 1;
        if (st.status !== 0) {
          smokeFailed += 1;
          console.log(`\n  Codex Smoke Selftest FAIL (exit ${st.status})\n`);
        } else if (isDegradedOrSkipped(res.combinedOutput) || isDegradedOrSkipped(st.combinedOutput)) {
          console.log(`\n  Codex Smoke DEGRADED / SKIP (当前 runtime 未完整验证 project hook command)\n`);
        } else {
          console.log(`\n  Codex Smoke + Selftest PASS\n`);
        }
      } else {
        if (isDegradedOrSkipped(res.combinedOutput)) {
          console.log(`\n  Codex Smoke DEGRADED / SKIP (selftest 脚本缺失)\n`);
        } else {
          console.log(`\n  Codex Smoke PASS (selftest 脚本缺失)\n`);
        }
      }
    }
  } else {
    console.log(`  Codex Smoke SKIP (脚本不存在: ${smokeScript})\n`);
  }
} catch (e) {
  smokeFailed = 1;
  console.log(`  Codex Smoke FAIL: ${e.message}\n`);
}

// ── Codex Init E2E Smoke (C-GATE-04 skill 入口自动化补齐) ──
// $harness-init 完整流程跑一遍，断言所有必选产物。比 codex-smoke 慢得多
// (~5 分钟一次)，所以 opt-in: CODEX_INIT_SMOKE=1 才执行；默认 SKIP 不卡 run.js。
let initSmokeFailed = 0;
let initSmokeTotal = 0;
try {
  const initSmokeScript = path.resolve(__dirname, 'codex-init-smoke.sh');
  if (fs.existsSync(initSmokeScript)) {
    console.log('  Codex Init E2E Smoke (C-GATE-04 skill 入口)\n');
    const res = require('child_process').spawnSync('bash', [initSmokeScript], {
      stdio: 'inherit',
      env: process.env,
      timeout: 12 * 60 * 1000, // init 流程要慢，给 12 分钟外层硬上限
    });
    initSmokeTotal += 1;
    if (res.status !== 0) {
      initSmokeFailed += 1;
      console.log(`\n  Codex Init Smoke FAIL (exit ${res.status})\n`);
    } else {
      console.log(`\n  Codex Init Smoke PASS / SKIP\n`);
    }
  }
} catch (e) {
  initSmokeFailed = 1;
  console.log(`  Codex Init Smoke FAIL: ${e.message}\n`);
}

const totalFailed = failed + tpl.fail + findRootUnit.fail + scriptedFailed + smokeFailed + initSmokeFailed;
const totalTests = scenarios.length + tpl.results.length + findRootUnit.results.length + scriptedTotal + smokeTotal + initSmokeTotal;
console.log(`  ══════════════════════════════`);
console.log(`  总计: ${passed + tpl.pass + findRootUnit.pass + (scriptedTotal - scriptedFailed) + (smokeTotal - smokeFailed) + (initSmokeTotal - initSmokeFailed)} passed, ${totalFailed} failed, ${totalTests} total\n`);

process.exit(totalFailed > 0 ? 1 : 0);

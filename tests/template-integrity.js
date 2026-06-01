#!/usr/bin/env node
'use strict';

/**
 * Template Integrity Tests
 *
 * 在 kit 仓库级别校验模板文件的结构完整性，防止模板层漂移潜伏到 E2E 才被发现。
 * 这是 #23 的产物，配合 #21 的 e2e-acceptance-validate.sh 形成两层防御：
 *   - 本脚本：kit 仓库 CI 时即时发现模板结构问题
 *   - e2e-acceptance-validate.sh：被测项目 init 后验证生成产物
 *
 * 单一真实源: tests/required-wiring.json
 *   包含必选 hook wiring 集合，本脚本和 e2e-acceptance-validate.sh 都必须消费它。
 *   不允许在脚本里硬编码 wiring 常量（会造成多份真实源漂移）。
 *
 * 由 tests/run.js 调用，失败计入统一的 fail 统计。
 */

const fs = require('fs');
const path = require('path');

const KIT_ROOT = path.resolve(__dirname, '..');
const TMPL_SETTINGS = path.join(KIT_ROOT, 'templates', 'settings-json.tmpl');
const TMPL_RULES_DIR = path.join(KIT_ROOT, 'templates', 'rules');
const SCRIPTS_HOOKS_DIR = path.join(KIT_ROOT, 'scripts', 'hooks');
const INIT_PROMPT = path.join(KIT_ROOT, 'init-prompt.md');
const REQUIRED_WIRING_FILE = path.join(__dirname, 'required-wiring.json');
const HARNESS_INIT_SKILL = path.join(KIT_ROOT, 'skills', 'harness-init', 'SKILL.md');
const KIT_CONSTRAINTS = path.join(KIT_ROOT, 'docs', 'constraints.md');
// Workspace constraints 位于 kit 的父目录 (harness-dogfood/docs/constraints.md)
// 注意: T10 只有在 workspace 存在时才运行 (kit 独立 clone 时 workspace 不存在)
const WORKSPACE_CONSTRAINTS = path.resolve(KIT_ROOT, '..', 'docs', 'constraints.md');
const WORKSPACE_RULES_DIR = path.resolve(KIT_ROOT, '..', '.claude', 'rules');

// 每个 rule 模板的关键内容锚点。
// 原则：每个模板至少 4 个锚点，覆盖核心行为点（不是单个 banner 词），
// 这样即使被 AI 无意改写结构，如果关键行为缺失也会被检测到。
const REQUIRED_RULE_TEMPLATES = {
  'role-constraints.md.tmpl': [
    'Director',
    'Implementer',
    'Reviewer',
    'YAGNI',         // 核心原则
    'NEEDS_CONTEXT', // Implementer 行为准则
  ],
  'qa-standards.md.tmpl': [
    'QA',
    'Verification Loop',  // 核心流程
    'PASS',               // 判定词
    '量化',               // 量化验收原则
  ],
  'feedback-workflow.md.tmpl': [
    'F1',
    'F2',
    'F3',
    'F4',
    'F5',            // 五步完整性
    'Constraint',    // 规则沉淀
  ],
  'harness-entry.md.tmpl': [
    'HARNESS MODE ACTIVE',
    'banner',
    '等待用户指令',  // 关键行为：不自行开始
    'PLAN',          // 进入 PLAN 阶段
    '6 阶段 Loop',  // 核心概念
  ],
};

// 检查 settings 对象中某个 wiring 是否存在
function hasWiring(settings, { event, matcher, script }) {
  const hooks = (settings.hooks && settings.hooks[event]) || [];
  return hooks.some(h => {
    const matcherOk = matcher === null || h.matcher === matcher;
    if (!matcherOk) return false;
    return (h.hooks || []).some(inner => (inner.command || '').includes(script));
  });
}

function findMissingWirings(settings, requiredWirings) {
  return requiredWirings.filter(w => !hasWiring(settings, w));
}

function formatWiring(w) {
  return `${w.event}:${w.matcher || '*'} → ${w.script}`;
}

// 从 init-prompt.md 里提取 "settings.json 最小配置" 章节中的 JSON 块
// 更精确：必须在包含"最小配置"字样的章节内
function extractMinimumSettingsFromInitPrompt(content) {
  // 查找 "## settings.json 最小配置" 章节
  const sectionRe = /##\s*settings\.json\s*最小配置[\s\S]*?```json\s*\n([\s\S]*?)\n```/;
  const match = content.match(sectionRe);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function runTemplateIntegrityTests() {
  const results = [];

  function check(name, fn) {
    try {
      const err = fn();
      if (err) {
        results.push({ name, ok: false, reason: err });
      } else {
        results.push({ name, ok: true });
      }
    } catch (e) {
      results.push({ name, ok: false, reason: e.message });
    }
  }

  // 加载单一真实源
  let requiredWirings = null;
  check('source: required-wiring.json 存在 + 可解析', () => {
    if (!fs.existsSync(REQUIRED_WIRING_FILE)) {
      return `真实源不存在: ${REQUIRED_WIRING_FILE}`;
    }
    try {
      const data = JSON.parse(fs.readFileSync(REQUIRED_WIRING_FILE, 'utf8'));
      if (!Array.isArray(data.wirings) || data.wirings.length === 0) {
        return 'required-wiring.json 结构无效 (wirings 必须是非空数组)';
      }
      requiredWirings = data.wirings;
    } catch (e) {
      return `解析失败: ${e.message}`;
    }
  });

  // ── T1: settings-json.tmpl 存在 + JSON 有效 ──
  let tmplSettings = null;
  check('template: settings-json.tmpl 存在 + JSON 有效', () => {
    if (!fs.existsSync(TMPL_SETTINGS)) return `文件不存在: ${TMPL_SETTINGS}`;
    try {
      tmplSettings = JSON.parse(fs.readFileSync(TMPL_SETTINGS, 'utf8'));
    } catch (e) {
      return `JSON 解析失败: ${e.message}`;
    }
  });

  // ── T2: 必选顶层事件（从 required-wiring.json 派生）──
  check('template: settings-json.tmpl 包含真实源声明的所有必选顶层事件', () => {
    if (!tmplSettings) return '前置检查失败，跳过';
    if (!requiredWirings) return '前置检查失败，跳过';
    // 从 required-wiring.json 推导 event 集，消除硬编码
    const requiredEvents = [...new Set(requiredWirings.map(w => w.event))];
    const missing = requiredEvents.filter(ev => !tmplSettings.hooks || !tmplSettings.hooks[ev]);
    if (missing.length > 0) return `缺失顶层事件: ${missing.join(', ')}`;
  });

  // ── T3: templates/settings-json.tmpl 包含 required-wiring.json 中所有 wiring（count-based） ──
  // 使用 count-based diff 以捕获 duplicate wiring regression（防止模板重复挂载同一 matcher）
  check('template: settings-json.tmpl 与 required-wiring.json wiring 精确一致（含重复检测）', () => {
    if (!tmplSettings) return '前置检查失败，跳过';
    if (!requiredWirings) return '前置检查失败，跳过';

    // 从 tmplSettings 提取 wiring 列表（保留重复）
    const tmplWirings = [];
    for (const [event, entries] of Object.entries(tmplSettings.hooks || {})) {
      for (const entry of entries) {
        for (const h of (entry.hooks || [])) {
          const cmd = h.command || '';
          const m = cmd.match(/node\s+scripts\/hooks\/([\w-]+\.js)/);
          if (m) {
            tmplWirings.push({ event, matcher: entry.matcher || null, script: m[1] });
          }
        }
      }
    }

    // 模板允许有 optional wiring (delivery-gate, context-monitor 等), 所以用"required 是 tmpl 的子集"语义：
    // - required 中每个 wiring 必须在 tmpl 中出现（计数至少相等）
    // - required 中的 wiring 在 tmpl 中不能重复（防止模板注册冗余）
    const expCount = countWirings(requiredWirings);
    const tmplCountMap = countWirings(tmplWirings);
    const missing = [];
    const duplicates = [];
    for (const [key, expN] of expCount.entries()) {
      const actN = tmplCountMap.get(key) || 0;
      if (actN < expN) missing.push(`${key} (缺 ${expN - actN} 次)`);
      if (actN > expN) duplicates.push(`${key} (重复 ${actN - expN} 次)`);
    }
    const problems = [];
    if (missing.length > 0) {
      problems.push(`template 缺少 (${missing.length}):\n      ` + missing.join('\n      '));
    }
    if (duplicates.length > 0) {
      problems.push(`template 重复 (${duplicates.length}):\n      ` + duplicates.join('\n      '));
    }
    if (problems.length > 0) return problems.join('\n    ');
  });

  // ── T4: 所有 command 引用的脚本都在 scripts/hooks/ 存在 ──
  check('template: 所有 command 引用的 hook 脚本真实存在', () => {
    if (!tmplSettings) return '前置检查失败，跳过';
    const referenced = new Set();
    for (const [, entries] of Object.entries(tmplSettings.hooks || {})) {
      for (const entry of entries) {
        for (const h of (entry.hooks || [])) {
          const cmd = h.command || '';
          const m = cmd.match(/node\s+scripts\/hooks\/([\w-]+\.js)/);
          if (m) referenced.add(m[1]);
        }
      }
    }
    const missing = [];
    for (const name of referenced) {
      if (!fs.existsSync(path.join(SCRIPTS_HOOKS_DIR, name))) missing.push(name);
    }
    if (missing.length > 0) return `template 引用的脚本不存在: ${missing.join(', ')}`;
  });

  // ── T5: 必选 rule 模板存在 + 含关键内容 ──
  for (const [fileName, keywords] of Object.entries(REQUIRED_RULE_TEMPLATES)) {
    check(`template: rule 模板 ${fileName} 存在且含关键内容`, () => {
      const p = path.join(TMPL_RULES_DIR, fileName);
      if (!fs.existsSync(p)) return `文件不存在: ${fileName}`;
      const content = fs.readFileSync(p, 'utf8');
      const missing = keywords.filter(kw => !content.includes(kw));
      if (missing.length > 0) {
        return `${fileName} 缺失关键字 (${missing.length}): ${missing.join(', ')}`;
      }
    });
  }

  // ── T6: init-prompt.md 最小集与 required-wiring.json 完全一致（count-based） ──
  check('doc: init-prompt.md 最小配置与 required-wiring.json 精确一致（含重复检测）', () => {
    if (!requiredWirings) return '前置检查失败，跳过';
    if (!fs.existsSync(INIT_PROMPT)) return `文件不存在: ${INIT_PROMPT}`;
    const content = fs.readFileSync(INIT_PROMPT, 'utf8');
    const initSettings = extractMinimumSettingsFromInitPrompt(content);
    if (!initSettings) {
      return 'init-prompt.md 中未找到 "## settings.json 最小配置" 章节的 JSON 代码块';
    }

    // 从 init-prompt 提取其 wiring 列表（保留重复）
    const initWirings = [];
    for (const [event, entries] of Object.entries(initSettings.hooks || {})) {
      for (const entry of entries) {
        for (const h of (entry.hooks || [])) {
          const cmd = h.command || '';
          const m = cmd.match(/node\s+scripts\/hooks\/([\w-]+\.js)/);
          if (m) {
            initWirings.push({ event, matcher: entry.matcher || null, script: m[1] });
          }
        }
      }
    }

    const diff = compareWiringsExact(requiredWirings, initWirings);
    const problems = [];
    if (diff.missing.length > 0) {
      problems.push(`init-prompt 缺少:\n      ` + diff.missing.join('\n      '));
    }
    if (diff.extra.length > 0) {
      problems.push(`init-prompt 多出:\n      ` + diff.extra.join('\n      '));
    }
    if (diff.duplicates.length > 0) {
      problems.push(`init-prompt 重复:\n      ` + diff.duplicates.join('\n      '));
    }
    if (problems.length > 0) return problems.join('\n    ');
  });

  // ── T7: e2e-acceptance-validate.sh 从 required-wiring.json 派生，不硬编码 wiring ──
  // 反回归检查：
  //   (a) 必须引用 required-wiring.json
  //   (b) 必须实际通过 node 调用读取它（且读取与 required-wiring.json 在同一 node 调用内）
  //   (c) 正文不含任何形如 'Event:Matcher:script.js' 的硬编码三元组字符串（单/双引号均检查）
  //       event 白名单从 required-wiring.json 动态派生，避免 T7 自己漂移
  check('doc: e2e-acceptance-validate.sh 从 required-wiring.json 派生 (非硬编码)', () => {
    if (!requiredWirings) return '前置检查失败，跳过';
    const shPath = path.join(__dirname, 'e2e-acceptance-validate.sh');
    if (!fs.existsSync(shPath)) return `文件不存在: ${shPath}`;
    const shContent = fs.readFileSync(shPath, 'utf8');

    // (a) 必须引用 required-wiring.json
    if (!shContent.includes('required-wiring.json')) {
      return '.sh 脚本未引用 required-wiring.json，可能回退到硬编码';
    }

    // (b) 必须有 node -e 调用，且该调用读取 required-wiring.json
    //     （通过字面串 'required-wiring.json' 或 bash 变量展开 $REQUIRED_WIRING_JSON）
    // 用非贪婪的 `$` 终结（避免吃掉后续内容），匹配 `node -e "..."` 或 `node -e '...'` 块
    const nodeEBlocks = shContent.match(/node\s+-e\s+("[\s\S]*?"|'[\s\S]*?')/g) || [];
    if (nodeEBlocks.length === 0) {
      return '.sh 脚本没有任何 node -e 调用';
    }
    const readsJson = nodeEBlocks.some(
      b => b.includes('required-wiring.json') || b.includes('REQUIRED_WIRING_JSON')
    );
    if (!readsJson) {
      return '.sh 脚本提到了 required-wiring.json，但没有任何 node -e 调用实际读取它';
    }

    // (c) 正文不含硬编码 wiring 三元组字符串
    // event 白名单从 required-wiring.json 动态派生
    const eventAlt = [...new Set(requiredWirings.map(w => w.event))]
      .map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    // 同时匹配双引号 "Event:Matcher:name.js" 和单引号 'Event:Matcher:name.js'
    const tripleRe = new RegExp(`["']\\s*(${eventAlt})\\s*:[^"']*:[\\w-]+\\.js\\s*["']`);
    const lines = shContent.split('\n');
    const hardcodedTriples = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue; // 跳过注释
      if (tripleRe.test(line)) {
        hardcodedTriples.push(`L${i + 1}: ${trimmed.substring(0, 100)}`);
      }
    }
    if (hardcodedTriples.length > 0) {
      return '.sh 脚本含硬编码 wiring 三元组 (应从 JSON 派生):\n      ' + hardcodedTriples.join('\n      ');
    }
  });

  // ── T8: skills/harness-init/SKILL.md 强制读取真实源 (C-INIT-04 守门) ──
  // 反 VH-08 回归：保证 SKILL.md 强制要求 AI 读 templates/settings-json.tmpl 和 init-prompt.md，
  // 而不是让 AI 凭记忆生成 settings.json。
  // 同时禁止 SKILL.md 复述真实源（硬编码必选清单/wiring）。
  check('skill: harness-init/SKILL.md 强制读真实源 + 不复述清单 (C-INIT-04)', () => {
    if (!fs.existsSync(HARNESS_INIT_SKILL)) return `文件不存在: ${HARNESS_INIT_SKILL}`;
    const content = fs.readFileSync(HARNESS_INIT_SKILL, 'utf8');

    // (a) 必须显式提到要读取 init-prompt.md
    // VH-10 方案 C 之后, SKILL.md 可以引用 ./resources/init-prompt.md (skill-relative)
    // 或 init-prompt.md (叙述中). 只要出现 init-prompt.md 字面即可.
    if (!/init-prompt\.md/.test(content)) {
      return 'SKILL.md 未引用 init-prompt.md (违反 C-INIT-04)';
    }

    // (b) 必须显式提到要读取 settings-json.tmpl
    // 允许 templates/settings-json.tmpl 或 VH-10 方案 C 的 ./resources/settings-json.tmpl
    if (!/settings-json\.tmpl/.test(content)) {
      return 'SKILL.md 未引用 settings-json.tmpl (违反 C-INIT-04)';
    }

    // (c) 必须显式提到要读取 required-wiring.json
    if (!/required-wiring\.json/.test(content)) {
      return 'SKILL.md 未引用 required-wiring.json (违反 C-INIT-04)';
    }

    // (c2) 必须提到 scripts/hooks/ (要求 AI 复制现有 hook 脚本而非凭记忆生成)
    if (!/scripts\/hooks/.test(content)) {
      return 'SKILL.md 未引用 scripts/hooks/ (违反 C-INIT-04: hook 脚本不得凭记忆生成, 必须从源复制)';
    }

    // (c3) 必须提到 templates/rules/ (要求 AI 从 rule 模板派生而非凭记忆)
    if (!/templates\/rules/.test(content)) {
      return 'SKILL.md 未引用 templates/rules/ (违反 C-INIT-04: rule 文件不得凭记忆生成, 必须从模板派生)';
    }

    // (d) 必须有"凭记忆生成"的禁令关键字
    if (!/凭记忆/.test(content)) {
      return 'SKILL.md 缺少"凭记忆"禁令关键字 (违反 C-INIT-04 的反退化要求)';
    }

    // (e) 不得复述硬编码的 settings.json 代码块
    //    检测：是否有 ```json ... "hooks": ...``` 这种内嵌完整 settings 结构
    const jsonBlocks = content.match(/```json[\s\S]*?```/g) || [];
    for (const block of jsonBlocks) {
      if (/"hooks"\s*:/.test(block) && /"PreToolUse"\s*:/.test(block)) {
        return 'SKILL.md 内嵌了完整的 settings.json 代码块 (违反 C-INIT-04 不复述真实源原则，应改为指针)';
      }
    }

    // (f) 不得硬编码必选 hook 文件清单 (典型形态: 多个 scripts/hooks/xxx.js 紧邻列出)
    //     启发式：若文件包含 ≥4 个 "scripts/hooks/*.js" 引用且都在同一段落（30 行内），算复述清单
    const hookRefs = [...content.matchAll(/scripts\/hooks\/[\w-]+\.js/g)];
    if (hookRefs.length >= 4) {
      const positions = hookRefs.map(m => content.substring(0, m.index).split('\n').length);
      const span = Math.max(...positions) - Math.min(...positions);
      if (span <= 30) {
        return `SKILL.md 在 ${span} 行内列出 ${hookRefs.length} 个 hook 路径，疑似硬编码必选清单 (违反 C-INIT-04)`;
      }
    }
  });

  // ── T9: stage-guard.js 内部 READ_TOOLS / TASK_TOOLS 数组与 required-wiring.json 一致性检测 ──
  // #33 治理: 防止 stage-guard 内部数组与外部 wiring 漂移. 例如新增一个 PreToolUse:Foo
  // matcher 但忘了加到 stage-guard 的 READ_TOOLS / TASK_TOOLS 数组. 早期 #16 矩阵已记录
  // 这种 "intent vs registered" 漂移类型, 现在用脚本守门.
  check('stage-guard: READ_TOOLS / TASK_TOOLS 数组与 required-wiring.json 一致 (#33)', () => {
    if (!requiredWirings) return '前置检查失败，跳过';
    const guardPath = path.join(SCRIPTS_HOOKS_DIR, 'harness-stage-guard.js');
    if (!fs.existsSync(guardPath)) return `文件不存在: ${guardPath}`;
    const content = fs.readFileSync(guardPath, 'utf8');

    // 解析 stage-guard 内部硬编码数组
    const readMatch = content.match(/const\s+READ_TOOLS\s*=\s*\[([^\]]+)\]/);
    const taskMatch = content.match(/const\s+TASK_TOOLS\s*=\s*\[([^\]]+)\]/);
    if (!readMatch) return 'READ_TOOLS 数组定义未找到（结构变了？）';
    if (!taskMatch) return 'TASK_TOOLS 数组定义未找到（结构变了？）';

    const parseArray = str => str.match(/['"]([^'"]+)['"]/g).map(s => s.slice(1, -1));
    const readTools = parseArray(readMatch[1]);
    const taskTools = parseArray(taskMatch[1]);

    // 从 required-wiring.json 提取 PreToolUse 中"非写类"的 matcher (READ 候选)
    // 即所有 PreToolUse matcher 中，不在写类（Bash/Edit/Write/Agent）也不在 task 类的
    const WRITE_MATCHERS = new Set(['Bash', 'Edit', 'Write', 'Agent']);
    const requiredPreMatchers = new Set(
      requiredWirings
        .filter(w => w.event === 'PreToolUse' && w.matcher)
        .map(w => w.matcher)
    );

    // (a) READ_TOOLS 中的每个工具，如果在 required PreToolUse matcher 里出现，必须是非写非任务类
    //     反之 required PreToolUse 中非写非任务类的 matcher，应该出现在 READ_TOOLS 中
    const expectedReadTools = [...requiredPreMatchers].filter(
      m => !WRITE_MATCHERS.has(m) && !['TaskUpdate', 'TaskCreate', 'TaskList', 'TaskGet'].includes(m)
    );

    const missingFromGuard = expectedReadTools.filter(t => !readTools.includes(t));
    if (missingFromGuard.length > 0) {
      return `READ_TOOLS 缺少 required-wiring 中的非写非任务 PreToolUse matcher: ${missingFromGuard.join(', ')}`;
    }

    // (b) TASK_TOOLS 必须包含 required-wiring 中所有 PreToolUse:Task* matcher
    const requiredTaskMatchers = [...requiredPreMatchers].filter(m =>
      ['TaskUpdate', 'TaskCreate', 'TaskList', 'TaskGet'].includes(m)
    );
    const missingTask = requiredTaskMatchers.filter(t => !taskTools.includes(t));
    if (missingTask.length > 0) {
      return `TASK_TOOLS 缺少 required-wiring 中的 task matcher: ${missingTask.join(', ')}`;
    }
  });

  // ── T10: workspace vs kit constraints.md meta 约束同步检测 (C-META-04) ──
  // VH-09 治理: kit 产品仓库 docs/constraints.md 和 workspace harness-dogfood/docs/constraints.md
  // 必须保持 "所有 kit-level meta 约束和 VH 历史同步". workspace 有的 kit-level C-* 和 VH-*,
  // kit 仓库必须都有 (kit 仓库可以额外有, 但不能少).
  //
  // kit-level 判据: 约束 ID 以这些前缀开头 → C-DOC / C-META / C-HOOK / C-TEST / C-GATE / C-INIT / C-SKILL
  //   (area-level 约束如 C-UI/C-API 是项目特定的, 不要求同步)
  //
  // 如果 workspace 不存在 (e.g. kit 被独立 clone), 此检查跳过.
  check('sync: workspace ↔ kit docs/constraints.md meta 约束同步 (C-META-04)', () => {
    if (!fs.existsSync(KIT_CONSTRAINTS)) {
      return `kit 仓库 constraints 不存在: ${KIT_CONSTRAINTS}`;
    }
    if (!fs.existsSync(WORKSPACE_CONSTRAINTS)) {
      // kit 独立 clone 场景, 没有 workspace - 视为 N/A (PASS)
      return null;
    }

    const kitContent = fs.readFileSync(KIT_CONSTRAINTS, 'utf8');
    const wsContent = fs.readFileSync(WORKSPACE_CONSTRAINTS, 'utf8');

    // 提取 C-{area}-{number} (含 5a / 06 等字母后缀扩展)
    const extractConstraintIds = (content) => {
      const re = /\|\s*(C-[A-Z]+-\d+[a-z]?)\s*\|/g;
      const ids = new Set();
      let m;
      while ((m = re.exec(content)) !== null) ids.add(m[1]);
      return ids;
    };

    // kit-level 前缀: 约束属于 kit 方法论本身而非项目特定
    const KIT_LEVEL_PREFIXES = ['C-DOC', 'C-META', 'C-HOOK', 'C-TEST', 'C-GATE', 'C-INIT', 'C-SKILL'];
    const isKitLevel = (id) => KIT_LEVEL_PREFIXES.some(p => id.startsWith(p));

    const wsIds = extractConstraintIds(wsContent);
    const kitIds = extractConstraintIds(kitContent);

    // workspace 的 kit-level C-*, kit 必须都有
    const missingInKit = [];
    for (const id of wsIds) {
      if (isKitLevel(id) && !kitIds.has(id)) {
        missingInKit.push(id);
      }
    }

    // 提取 VH-{number} (或 VH-01/VH-02...)
    const extractVHIds = (content) => {
      const re = /\|\s*(VH-\d+)\s*\|/g;
      const ids = new Set();
      let m;
      while ((m = re.exec(content)) !== null) ids.add(m[1]);
      return ids;
    };

    const wsVHs = extractVHIds(wsContent);
    const kitVHs = extractVHIds(kitContent);
    const missingVHInKit = [];
    for (const vh of wsVHs) {
      if (!kitVHs.has(vh)) missingVHInKit.push(vh);
    }

    const errors = [];
    if (missingInKit.length > 0) {
      errors.push(`kit 仓库 docs/constraints.md 缺少 workspace 中的 kit-level 约束: ${missingInKit.join(', ')}`);
    }
    if (missingVHInKit.length > 0) {
      errors.push(`kit 仓库 docs/constraints.md 缺少 workspace 中的 VH: ${missingVHInKit.join(', ')}`);
    }
    if (errors.length > 0) return errors.join(' | ');
  });

  // ── T11: workspace vs kit templates/rules 同步检测 (C-META-04) ──
  // workspace 的 .claude/rules/*.md 里的自定义 rule 应该有对应的 kit templates/rules/*.md.tmpl
  // (例如 workspace 的 commit-standards.md → kit templates/rules/commit-standards.md.tmpl)
  // 这是 C-META-04 对 rules 层的延伸.
  //
  // 注意: 不是所有 workspace rules 都需要 template (有些是纯本地配置). 此检查只要求: 如果
  // workspace 的 rule 名字匹配 kit 现有 template 的前缀 (role-constraints / qa-standards /
  // feedback-workflow / harness-entry / commit-standards), 那 kit template 必须存在.
  check('sync: workspace ↔ kit templates/rules 同步 (C-META-04)', () => {
    if (!fs.existsSync(WORKSPACE_RULES_DIR)) {
      // kit 独立 clone 场景 - N/A
      return null;
    }
    if (!fs.existsSync(TMPL_RULES_DIR)) {
      return `kit templates/rules 目录不存在: ${TMPL_RULES_DIR}`;
    }

    const SYNC_REQUIRED_RULES = [
      'role-constraints',
      'qa-standards',
      'feedback-workflow',
      'harness-entry',
      'commit-standards',
    ];

    const wsFiles = fs.readdirSync(WORKSPACE_RULES_DIR).filter(f => f.endsWith('.md'));
    const missing = [];
    for (const ruleName of SYNC_REQUIRED_RULES) {
      const wsFile = `${ruleName}.md`;
      const tmplFile = `${ruleName}.md.tmpl`;
      if (wsFiles.includes(wsFile) && !fs.existsSync(path.join(TMPL_RULES_DIR, tmplFile))) {
        missing.push(`workspace 有 ${wsFile} 但 kit 缺 ${tmplFile}`);
      }
    }

    if (missing.length > 0) {
      return missing.join(' | ');
    }
  });

  // ── T12: skills/harness-init/resources/ 与 kit 源文件 byte-identical (VH-10 方案 C 同步守门) ──
  // VH-10 方案 C: skill 自包含 resources/ 避免 cwd-relative 路径问题. 这 4 个 resources/
  // 是 kit 源文件的副本, 必须保持精确同步. 用 byte-identical 对比防止漂移.
  //
  // 映射:
  //   skills/harness-init/resources/init-prompt.md          == init-prompt.md
  //   skills/harness-init/resources/settings-json.tmpl      == templates/settings-json.tmpl
  //   skills/harness-init/resources/required-wiring.json    == tests/required-wiring.json
  //   skills/harness-init/resources/hook-coverage-matrix.md == methodology/15-hook-coverage-matrix.md
  //
  // 任一 FAIL 即说明 resources/ 已漂移, 必须同步 (一般是修改源后忘了同步 resources/ 副本).
  check('sync: skills/harness-init/resources/ 与 kit 源 byte-identical (VH-10 方案 C)', () => {
    const SKILL_RES = path.join(KIT_ROOT, 'skills', 'harness-init', 'resources');
    const pairs = [
      {
        res: path.join(SKILL_RES, 'init-prompt.md'),
        src: path.join(KIT_ROOT, 'init-prompt.md'),
        label: 'init-prompt.md',
      },
      {
        res: path.join(SKILL_RES, 'settings-json.tmpl'),
        src: path.join(KIT_ROOT, 'templates', 'settings-json.tmpl'),
        label: 'settings-json.tmpl',
      },
      {
        res: path.join(SKILL_RES, 'required-wiring.json'),
        src: path.join(KIT_ROOT, 'tests', 'required-wiring.json'),
        label: 'required-wiring.json',
      },
      {
        res: path.join(SKILL_RES, 'hook-coverage-matrix.md'),
        src: path.join(KIT_ROOT, 'methodology', '15-hook-coverage-matrix.md'),
        label: 'hook-coverage-matrix.md',
      },
    ];

    const errors = [];
    for (const p of pairs) {
      if (!fs.existsSync(p.res)) {
        errors.push(`resources 文件缺失: ${p.label} (应在 ${path.relative(KIT_ROOT, p.res)})`);
        continue;
      }
      if (!fs.existsSync(p.src)) {
        errors.push(`kit 源文件缺失: ${p.label} (应在 ${path.relative(KIT_ROOT, p.src)})`);
        continue;
      }
      const resBuf = fs.readFileSync(p.res);
      const srcBuf = fs.readFileSync(p.src);
      if (!resBuf.equals(srcBuf)) {
        errors.push(
          `drift: ${p.label} — ${path.relative(KIT_ROOT, p.res)} != ${path.relative(KIT_ROOT, p.src)}. ` +
            `同步方向: 将 kit 源的最新内容 cp 到 resources/ (源是 single source of truth)`
        );
      }
    }
    if (errors.length > 0) return errors.join(' | ');
  });

  // ── T13: skills/harness-init/SKILL.md Step 0 含 C-SKILL-02 trust model 守门 ──
  // Codex gpt-5.4 round 3 F3 发现: Step 0 "cwd 向上搜索 simple-harness-kit/" 逻辑
  // 可被影子仓库欺骗 (用户在 /tmp/untrusted 下工作, 攻击者在该目录种伪 kit, 被静默
  // 信任). C-SKILL-02 要求 Step 0 必须包含 (a) 结构完整性校验 (b) 显式用户确认.
  // 本 T 静态检查 SKILL.md 里存在这些关键守门短语, 防止未来"简化 Step 0"回归.
  check('SKILL.md Step 0 含 C-SKILL-02 trust model 守门 (VH-10 gpt-5.4 F3)', () => {
    const skillMd = path.join(KIT_ROOT, 'skills', 'harness-init', 'SKILL.md');
    if (!fs.existsSync(skillMd)) return 'SKILL.md 不存在';
    const content = fs.readFileSync(skillMd, 'utf8');

    const REQUIRED_PHRASES = [
      { needle: 'C-SKILL-02', label: 'C-SKILL-02 ID 引用' },
      { needle: 'SIMPLE_HARNESS_KIT_ROOT', label: '环境变量优先条目' },
      { needle: '结构完整性校验', label: '结构完整性校验要求' },
      { needle: 'methodology/00-philosophy.md', label: '完整性校验锚点 1 (methodology root)' },
      { needle: 'templates/settings-json.tmpl', label: '完整性校验锚点 2' },
      { needle: 'tests/required-wiring.json', label: '完整性校验锚点 3' },
      { needle: '显式', label: '显式用户确认要求 (显式)' },
      { needle: 'supply-chain', label: 'supply-chain 风险标注' },
    ];
    const FORBIDDEN_PHRASES = [
      // 禁止描述"自动向上查找 + 静默使用" — 必须明确说这是被禁止的
      // (如果未来重构去掉了禁止描述, T13 FAIL)
      { needle: '自动.*向上查找.*静默', label: '禁止 "自动向上查找+静默" 的明确描述', regex: true },
    ];

    const errors = [];
    for (const { needle, label } of REQUIRED_PHRASES) {
      if (!content.includes(needle)) errors.push(`缺少必需短语: ${label} ("${needle}")`);
    }
    for (const { needle, label, regex } of FORBIDDEN_PHRASES) {
      // FORBIDDEN_PHRASES 这里实际是"必须出现在禁止性上下文中的描述"
      // 用简化方式: 至少有一处"禁止"和"自动"+"向上"关键词组合
      const hasWarning = /禁止.*自动.*向上查找/s.test(content) || /不得.*自动.*向上查找/s.test(content);
      if (!hasWarning) errors.push(`缺少明确警告: ${label}`);
    }
    if (errors.length > 0) return errors.join(' | ');
  });

  // ── T14: SKILL.md Step 0 完整性校验锚点在 kit 里必须真实存在 ──
  // 背景: VH-10 阶段 4 真实用户场景验收发现: v0.7.2 SKILL.md 里写的锚点
  // `methodology/00-overview.md` 实际不存在 (真名是 00-philosophy.md).
  // T13 只检查 SKILL.md 里是否**含有**这个字符串, 没检查**字符串指向的文件是否真的存在**.
  // 这是 VH-10 教训的元层重演 — "静态内容检查 ≠ 真实验证".
  // T14 把 SKILL.md 里声明的每个锚点都在 kit 文件系统里真实 stat 一次.
  check('SKILL.md Step 0 完整性校验锚点在 kit 里真实存在 (VH-10 阶段 4 发现)', () => {
    const skillMd = path.join(KIT_ROOT, 'skills', 'harness-init', 'SKILL.md');
    if (!fs.existsSync(skillMd)) return 'SKILL.md 不存在';
    const content = fs.readFileSync(skillMd, 'utf8');

    // 从 SKILL.md 提取 Step 0 里所有形如 `$CAND/xxx.xxx` 的锚点
    // 格式: `$CAND/<path>`（反引号内）
    const anchorRe = /`\$CAND\/([^`\n]+)`/g;
    const anchors = new Set();
    let m;
    while ((m = anchorRe.exec(content)) !== null) {
      const rel = m[1].trim();
      // 排除目录级声明 (以 / 结尾) — 那些是 "$CAND/scripts/hooks/" 类, 不是具体文件
      if (!rel.endsWith('/')) anchors.add(rel);
    }

    if (anchors.size === 0) {
      return 'Step 0 没有声明任何 `$CAND/...` 锚点 — 结构完整性校验形同虚设';
    }

    const errors = [];
    for (const rel of anchors) {
      const full = path.join(KIT_ROOT, rel);
      if (!fs.existsSync(full)) {
        errors.push(`锚点不存在: ${rel} (SKILL.md 声明但 kit 里找不到)`);
      }
    }
    if (errors.length > 0) return errors.join(' | ');
  });

  // ── T15: qa-standards.md.tmpl 含必需行为指令 (Issue #1 / VH-11) ──
  // 背景: 用户 SJF 报告 v0.7.x init 后的 qa-standards.md 是骨架占位符,
  // 缺少 TDD 铁律 / 5 层金字塔 / Santa / Spec Review 等行为指令.
  // AI 读 rules/ 时没看到 "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"
  // → 不做 TDD → 不写测试 → 代码质量断崖.
  // T15 检查模板本身 (不是 init 后的派生文件) 含必需行为短语, 防止模板退化.
  check('qa-standards.md.tmpl 含必需行为指令 (Issue #1 / VH-11)', () => {
    const tmplPath = path.join(KIT_ROOT, 'templates', 'rules', 'qa-standards.md.tmpl');
    if (!fs.existsSync(tmplPath)) return 'qa-standards.md.tmpl 不存在';
    const content = fs.readFileSync(tmplPath, 'utf8');

    const REQUIRED = [
      { needle: 'NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST', label: 'TDD 铁律' },
      { needle: 'Layer 1', label: 'Layer 1 Agent Self-Verification' },
      { needle: 'Layer 2', label: 'Layer 2 Verification Loop' },
      { needle: 'Layer 3', label: 'Layer 3 Spec Compliance Review' },
      { needle: 'Layer 4', label: 'Layer 4 Santa Method' },
      { needle: 'Layer 5', label: 'Layer 5 Human Final Review' },
      { needle: 'VERIFICATION REPORT', label: 'VERIFICATION REPORT 输出格式' },
      { needle: 'Reviewer', label: 'Reviewer ≠ Author 要求' },
      { needle: 'pass@1', label: '量化指标 pass@1' },
    ];

    const errors = [];
    for (const { needle, label } of REQUIRED) {
      if (!content.includes(needle)) errors.push(`缺少: ${label} ("${needle}")`);
    }
    if (errors.length > 0) return errors.join(' | ');
  });

  // ── T16: settings-json.tmpl 所有 hook command 必须用 find-root wrapper (C-HOOK-08, VH-16) ──
  // 背景: VH-16 (2026-04-17) mind-palace 子目录起 session 爆 MODULE_NOT_FOUND.
  // 根因: 模板 hook command 用裸 `node scripts/hooks/X.js`, cwd=子目录时 node 解析到
  // <subdir>/scripts/hooks/X.js (不存在) → hook 报错. VH-10 dogfooding 假 PASS 复演.
  // 修复: 所有 hook command 必须带 shell wrapper 向上找 scripts/hooks/find-root.js 后 cd.
  // 本 T 同时检查源模板和 skill resources 副本 (T12 byte-identical 已覆盖同步, 本 T 覆盖内容).
  check('template: settings-json.tmpl + init-prompt.md sample 所有 hook command 用 find-root wrapper (C-HOOK-08)', () => {
    if (!tmplSettings) return '前置检查失败，跳过';

    const scanSettings = (settings, sourceLabel) => {
      const bare = [];
      for (const [event, entries] of Object.entries(settings.hooks || {})) {
        for (const entry of entries) {
          for (const h of (entry.hooks || [])) {
            if (h.type !== 'command') continue;
            const cmd = h.command || '';
            if (!cmd.includes('scripts/hooks/find-root.js')) {
              const shown = cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
              bare.push(`[${sourceLabel}] ${event}:${entry.matcher || '*'} → ${shown}`);
            }
          }
        }
      }
      return bare;
    };

    const allBare = [];
    allBare.push(...scanSettings(tmplSettings, 'templates/settings-json.tmpl'));

    // init-prompt.md 嵌入 sample
    if (fs.existsSync(INIT_PROMPT)) {
      const content = fs.readFileSync(INIT_PROMPT, 'utf8');
      const initSample = extractMinimumSettingsFromInitPrompt(content);
      if (initSample) {
        allBare.push(...scanSettings(initSample, 'init-prompt.md sample'));
      }
    }

    if (allBare.length > 0) {
      return `共 ${allBare.length} 个裸 hook command (违反 C-HOOK-08，子目录起 session 会 MODULE_NOT_FOUND):\n      ` + allBare.join('\n      ');
    }
  });

  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  return { pass, fail, results };
}

// 集合 A 中不在集合 B 中的 wiring（set-based, 忽略重复）
function findMissingWiringSet(a, b) {
  return a.filter(x => !b.some(y =>
    y.event === x.event &&
    (y.matcher || null) === (x.matcher || null) &&
    y.script === x.script
  ));
}

// 生成 wiring 的规范化 key
function wiringKey(w) {
  return `${w.event}:${w.matcher || '*'}:${w.script}`;
}

// 计数 map: key → 出现次数
function countWirings(list) {
  const m = new Map();
  for (const w of list) {
    const k = wiringKey(w);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

// 两份 wiring 列表的 count-based 精确对比：
//   returns { missing: [...], extra: [...], duplicates: [...] }
//   - missing: actual 比 expected 少的条目（含因重复不够的情况）
//   - extra: actual 比 expected 多的条目
//   - duplicates: actual 中重复出现（expected 只要求 1 次）的条目
function compareWiringsExact(expected, actual) {
  const expCount = countWirings(expected);
  const actCount = countWirings(actual);
  const missing = [];
  const extra = [];
  const duplicates = [];
  const allKeys = new Set([...expCount.keys(), ...actCount.keys()]);
  for (const k of allKeys) {
    const e = expCount.get(k) || 0;
    const a = actCount.get(k) || 0;
    if (a < e) missing.push(`${k} (缺 ${e - a} 次)`);
    if (a > e) {
      if (e === 0) extra.push(k);
      else duplicates.push(`${k} (重复 ${a - e} 次)`);
    }
  }
  return { missing, extra, duplicates };
}

module.exports = { runTemplateIntegrityTests };

if (require.main === module) {
  const { pass, fail, results } = runTemplateIntegrityTests();
  console.log('\n  Template Integrity Tests\n');
  for (const r of results) {
    if (r.ok) {
      console.log(`  PASS  ${r.name}`);
    } else {
      console.log(`  FAIL  ${r.name}`);
      console.log(`        ${r.reason}`);
    }
  }
  console.log(`\n  ${pass} passed, ${fail} failed, ${results.length} total\n`);
  process.exit(fail > 0 ? 1 : 0);
}

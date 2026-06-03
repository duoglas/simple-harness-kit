#!/usr/bin/env node
'use strict';

/**
 * Harness Stage Guard — 强制新 session 声明 Harness 阶段 + 监听 TaskCompleted 提醒 VERIFY
 * @version 0.10.0
 * 触发:
 *   - PreToolUse:*（Claude tools + Codex Bash/apply_patch/mcp__.* matcher）
 *   - PermissionRequest（Codex 权限升级请求）
 *   - TaskCompleted lifecycle event (v0.6.3 迁移自原 PreToolUse:TaskUpdate + status==completed 检测)
 *
 * 机制:
 * 1. 检查 .harness/current-stage.json 是否存在
 * 2. 不存在 → exit 2 阻止，要求声明阶段（Write .harness/current-stage.json 是唯一豁免）
 * 3. 解析/读取异常 → exit 2 阻止（损坏的 stage 文件应该被修复而不是绕过）
 * 4. stage 字段值无效（不是 PLAN|SETUP|EXECUTE|VERIFY|REVIEW|FEEDBACK|OFF）→ exit 2 阻止
 * 5. first-call guard → 本轮任务第一次工具调用时 exit 2，要求先输出阶段声明（TASK_TOOLS 跳过）
 * 6. stage = "PLAN" → 只放行 READ_TOOLS + 只读 Bash + TASK_TOOLS + Write/patch 计划/阶段文件，其他阻止
 * 7. 切换到 "REVIEW" → 检查 stage-history 是否经过 EXECUTE 和 VERIFY + 验证证据存在，缺任何一项 exit 2
 * 8. stage = "OFF" → 会话级关闭，每次调用提醒"Harness 已关闭"，放行
 * 9. 其他非 PLAN 阶段 → 放行，stderr 注入阶段 directive 和 session-log 提醒
 * 10. 存在但超过 2 小时 → 提醒确认阶段是否仍然正确（不阻止）
 *
 * 退出码说明：exit 0 放行 / exit 2 阻止并阻断工具调用。
 *
 * current-stage.json 格式:
 * { "stage": "PLAN|SETUP|EXECUTE|VERIFY|REVIEW|FEEDBACK|OFF", "since": "ISO8601", "task": "描述" }
 *
 * 会话级开关:
 *   关闭: {"stage":"OFF","since":"...","reason":"使用其他 skill / 非开发任务"}
 *   开启: {"stage":"PLAN","since":"...","task":"..."}
 *
 * 设计目标: <50ms，纯 Node.js
 */

const fs = require('fs');
const path = require('path');
const { isLegitimateHarnessRoot } = require('./find-root');
const findRoot = require('./find-root');
const ROOT_RAW = findRoot();
// macOS /tmp → /private/tmp symlink 导致 path.resolve 和 Claude Code 的绝对路径不一致。
// 用 realpathSync 跟随 symlink 统一为真实路径, 确保 PLAN 阶段 Write .harness/* 路径比较正确。
// (VH-10 阶段 5 验收在 /tmp/ 下发现: Write .harness/current-stage.json 被 PLAN 错误阻止)
const ROOT = (() => { try { return fs.realpathSync(ROOT_RAW); } catch { return ROOT_RAW; } })();

const STAGE_FILE = path.join(ROOT, '.harness/current-stage.json');
const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_STDIN = 1024 * 1024;

// VH-18 F3: 只在合法 Harness 项目根（worktree 或已存 .harness/）才
// mkdir 自举。fallback-cwd 时直接退出，确保 stage-guard 不在普通空目录
// 创建 .harness/ 污染用户环境（避免 Codex review 报告的"任意空目录变 Harness"问题）。
if (!isLegitimateHarnessRoot(ROOT)) {
  process.exit(0);
}
try { fs.mkdirSync(path.join(ROOT, '.harness'), { recursive: true }); } catch {}

// 安全文件读取: 拒绝 symlink 防止 bypass attack。
// #30 治理: 攻击者把 .harness/current-stage.json symlink 到外部受控文件可以
// 操纵 stage state. 用 lstat 检查并拒绝 symlink, 视为读取失败。
// 适用于所有 .harness/* 状态文件 (current-stage / tool-count / stage-history / verify-evidence).
function safeReadFileSync(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      process.stderr.write(
        `[Harness Stage Guard] SECURITY: ${filePath} is a symlink, refusing to read. ` +
        `This file should be a regular file. Possible bypass attempt detected.\n`
      );
      return null;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeFileExists(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    // 存在但是 symlink → 视为不存在 (forces re-creation as regular file)
    if (stats.isSymbolicLink()) {
      process.stderr.write(
        `[Harness Stage Guard] SECURITY: ${filePath} is a symlink, treating as missing. ` +
        `This file should be a regular file. Possible bypass attempt detected.\n`
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

const STAGES = ['PLAN', 'SETUP', 'EXECUTE', 'VERIFY', 'REVIEW', 'FEEDBACK'];
const PLAN_FILE = path.join(ROOT, '.harness/current-plan.md');
const TOOL_COUNT_FILE = path.join(ROOT, '.harness/tool-count.json');
const STAGE_HISTORY_FILE = path.join(ROOT, '.harness/stage-history.jsonl');
const PRETOOL_OBS_FILE = path.join(ROOT, '.harness/pretool-observations.jsonl');
const INFRA_TIER_FILE = path.join(ROOT, '.harness/infra-tier.json');

// 验证证据文件——至少一个存在才算 VERIFY 做过
const VERIFY_EVIDENCE = [
  path.join(ROOT, '.harness/verify-evidence.json'),
  path.join(ROOT, 'docs/verification-report.md'),
  path.join(ROOT, '.harness/last-verification.json'),
  path.join(ROOT, '.harness/verify-evidence.md'),
];

// 阶段切换到 REVIEW 时的 Gate 检查
const REVIEW_GATE_BLOCK = `[Harness Stage Guard] 切换到 REVIEW 被阻止（C-GATE-01）。

REVIEW Gate 检查未通过。切换到 REVIEW 前必须满足：

1. 流程完整性：必须经过 EXECUTE 和 VERIFY 阶段（检查 .harness/stage-history.jsonl）
2. 验证证据：VERIFY 阶段必须产出验证报告文件（以下至少一个）：
   - .harness/verify-evidence.json
   - docs/verification-report.md
   - .harness/last-verification.json
   - .harness/verify-evidence.md

如果是文档/方法论变更，验证证据可以是：
  - 真实项目实测记录（不只是文件存在性检查）
  - Hook 功能测试结果（node tests/run.js 输出）

请先完成 VERIFY 阶段的验证工作，产出证据文件，再切换到 REVIEW。
`;

// 交付前检查清单（REVIEW 阶段注入）
const REVIEW_DELIVERY_CHECK = `[Harness Stage Guard] 交付前检查清单（C-GATE-03）：

在向用户交付结果之前，逐项确认（这是建议自检清单，非机器强制校验）：
  [ ] 流程合规：是否按 PLAN → EXECUTE → VERIFY 执行？（Gate 只机器校验 EXECUTE + VERIFY + 证据）
  [ ] QA 达标：验证报告是否完整？量化证据是否充分？
  [ ] 真实验证：功能性变更是否在真实场景跑过（不只是 mock）？
  [ ] 需求完整：所有需求是否全部处理？
  [ ] 规则升级：过程中新问题是否写入 constraints？

任何一项不满足，不要向用户交付。回到对应阶段补齐。
`;

// 首次工具调用阻止消息
const FIRST_CALL_BLOCK = `[Harness Stage Guard] 这是本轮任务的第一次工具调用，已阻止。
你必须先向用户输出阶段声明，再调用工具：

  进入 PLAN 阶段 — [用一句话描述你理解的任务]

输出声明后，再调用 Read/Grep/Glob/WebFetch/WebSearch 或只读 Bash（pwd/ls/rg/grep/sed -n/cat/git status/git diff --stat/name-only）探索。
`;

// 读操作工具——PLAN 阶段放行（只读、无代码副作用）
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

// Codex PLAN 阶段允许的只读 Bash 命令。保持保守：拒绝 shell 控制符/重定向/替换；
// 对表面只读但带副作用参数的命令做参数级拦截（例如 find -delete / sed -i / git diff --output）。
const PLAN_READ_ONLY_BASH_COMMANDS = new Set(['pwd', 'ls', 'find', 'rg', 'grep', 'cat']);

function parsePlanBashArgs(cmd) {
  const parts = [];
  let current = '';
  let quote = null;
  let inWord = false;

  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      inWord = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (inWord) {
        parts.push(current);
        current = '';
        inWord = false;
      }
      continue;
    }

    current += ch;
    inWord = true;
  }

  if (quote) return null;
  if (inWord) parts.push(current);
  return parts;
}

function isPlanReadOnlyBash(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return true;
  if (/[\n\r`\\$]/.test(cmd) || /[;&|<>]/.test(cmd)) return false;
  const parts = parsePlanBashArgs(cmd);
  if (!parts || parts.length === 0) return false;
  const [bin, sub] = parts;

  if (PLAN_READ_ONLY_BASH_COMMANDS.has(bin)) {
    if (bin === 'find') {
      const hasSideEffect = parts.slice(1).some(arg =>
        /^-(delete|exec|execdir|ok|okdir)$/.test(arg) ||
        /^-(fprint|fprint0|fls|fprintf)(?:$|\b)/.test(arg)
      );
      return !hasSideEffect;
    }
    if (bin === 'rg') {
      const hasSideEffect = parts.slice(1).some(arg => arg === '--pre' || arg.startsWith('--pre='));
      return !hasSideEffect;
    }
    return true;
  }

  if (bin === 'sed') {
    const args = parts.slice(1);
    const hasPrintOnly = args.some(arg => arg === '-n' || /^-[A-Za-z]*n[A-Za-z]*$/.test(arg));
    const hasInPlace = args.some(arg => arg === '-i' || /^-i/.test(arg) || /^-[A-Za-z]*i[A-Za-z]*$/.test(arg));
    return hasPrintOnly && !hasInPlace;
  }

  if (bin === 'git' && sub === 'status') return true;

  if (bin === 'git' && sub === 'diff') {
    const args = parts.slice(2);
    const hasSafeFormat = args.some(arg => arg === '--stat' || arg === '--name-only');
    const hasOutput = args.some(arg => arg === '--output' || arg.startsWith('--output='));
    const hasExternalHook = args.some(arg => arg === '--ext-diff' || arg === '--textconv');
    return hasSafeFormat && !hasOutput && !hasExternalHook;
  }

  return false;
}

function toolText(input) {
  return JSON.stringify(input && input.tool_input ? input.tool_input : input || {});
}

function patchPayloadText(input) {
  const ti = input && input.tool_input ? input.tool_input : {};
  return String(ti.command || ti.patch || ti.input || ti.content || toolText(input)).replace(/\\n/g, '\n');
}

function isPatchTool(toolName) {
  return toolName === 'apply_patch' || toolName === 'functions.apply_patch';
}

function patchFileRefs(input) {
  const txt = patchPayloadText(input);
  const fileRefs = [...txt.matchAll(/(?:\*\*\*\s+(?:Add|Update|Delete) File:|file_path[\"']?\s*[:=])\s*[\"']?([^\"'\n\r]+)/g)]
    .map(m => m[1].trim());
  if (fileRefs.length > 0) return fileRefs;
  const refs = [];
  if (txt.includes('.harness/current-stage.json')) refs.push('.harness/current-stage.json');
  if (txt.includes('.harness/current-plan.md')) refs.push('.harness/current-plan.md');
  return refs;
}

function patchRefMatches(fileRef, targetPath) {
  const ref = String(fileRef || '').replace(/^["']|["']$/g, '').trim();
  if (!ref) return false;
  const target = path.resolve(targetPath);
  if (ref === '.harness/current-stage.json' && target === path.resolve(STAGE_FILE)) return true;
  if (ref === '.harness/current-plan.md' && target === path.resolve(PLAN_FILE)) return true;
  const resolved = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(ROOT, ref);
  return resolved === target;
}

function patchTouchesHarnessStage(input) {
  return patchFileRefs(input).some(p => patchRefMatches(p, STAGE_FILE));
}

function patchTouchesOnlyHarnessStage(input) {
  const refs = patchFileRefs(input);
  return refs.length > 0 && refs.every(p => patchRefMatches(p, STAGE_FILE));
}

function patchTouchesOnlyHarnessPlan(input) {
  const refs = patchFileRefs(input);
  return refs.length > 0 && refs.every(p => patchRefMatches(p, PLAN_FILE));
}

function denyPreToolUse(input, message) {
  const reason = String(message || 'Blocked by Harness Stage Guard').replace(/\s+/g, ' ').trim();
  if (input && input.hook_event_name === 'PreToolUse') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n');
    process.exit(0);
  }
  process.stderr.write(message);
  process.exit(2);
}

function denyPermissionRequest(message) {
  const reason = String(message || 'Blocked by Harness Stage Guard').replace(/\s+/g, ' ').trim();
  process.stdout.write(JSON.stringify({
    decision: {
      behavior: 'block',
      reason,
    },
  }) + '\n');
  process.exit(0);
}

function readCurrentStageValue() {
  try {
    const rawStage = safeReadFileSync(STAGE_FILE);
    if (!rawStage) return null;
    return JSON.parse(rawStage).stage || null;
  } catch {
    return null;
  }
}

// 任务管理工具——任何阶段放行（流程管理操作，不产生代码副作用）
const TASK_TOOLS = ['TaskUpdate', 'TaskCreate', 'TaskList', 'TaskGet'];

// PLAN 阶段的阻止消息
const PLAN_BLOCK_MSG = `[Harness Stage Guard] PLAN 阶段禁止此操作。
你是否已经向用户输出了阶段声明？如果没有，先输出：
  进入 PLAN 阶段 — [任务描述]

PLAN 阶段只允许：Read/Grep/Glob/WebFetch/WebSearch、只读 Bash(pwd/ls/find/rg/grep/sed -n/cat/git status/git diff --stat/name-only)、TaskUpdate/TaskCreate/TaskList/TaskGet、Write 或 apply_patch(.harness/current-plan.md|.harness/current-stage.json)
流程：澄清需求 → 任务拆解 → 等用户确认 → Write current-stage.json 切换到 EXECUTE
`;

// session-log 提醒——附加在每个阶段 directive 后面
const LOG_REMINDER = `
[Session Log] 必须记录到 .harness/session-log.md（先记录，再行动）：
  - 人的指示（原话）
  - AI 决策（做了什么 + 为什么 + 依据哪篇方法论）
  - 偏差记录（最重要）：方法论要求 X，实际做了 Y，原因是什么，建议改什么
  工具调用由 Hook 自动记录，但决策和偏差必须你主动写。偏差是方法论改进的最重要输入。
`;

// 每个阶段的工作要求——通过 stderr 在每次工具调用时注入
const STAGE_DIRECTIVES = {
  PLAN: `[PLAN 阶段 — 停下来，不要执行任何实现操作]
你当前在 PLAN 阶段。在用户确认计划之前，禁止编写代码、修改文件、运行构建命令。
只允许：读文件了解现状、与用户对齐需求。

必须完成以下步骤再继续：
1. 向用户澄清需求和验收标准
2. 任务拆解——每个任务 ≤15 分钟可独立验证
3. 定义每个任务的 done 条件
4. 识别任务间依赖关系
5. 输出任务清单，然后停下来等用户说"go"或确认

Gate: 每个任务有验收标准 + 粒度≤15min + 单一主要风险 + 依赖已标注
用户没确认之前，不要进入下一阶段。方向错了后面全白做。
`,
  SETUP: `[SETUP 阶段要求]
1. 生成项目级 Rules（.claude/rules/）
2. 生成 Hooks（scripts/hooks/ + .claude/settings.json）
3. 生成 Constraints（docs/constraints.md）
4. 验证 Hook 拦截生效（故意触发一次，验证被拦截）
Gate: Rules 存在 + Hooks 已配置 + Hook 拦截测试通过 + constraints.md 已创建
已有 Harness 的项目跳过此阶段。
`,
  EXECUTE: `[EXECUTE 阶段要求]
1. 按任务清单逐个执行
2. TDD：先写失败测试 → 最少代码通过 → 重构
3. 引用 Constraint ID（修复类）
4. 完成后自验
Gate（每个任务）: 测试先写且先失败 + 代码通过测试 + 无新 warning/error + Commit 引用 Constraint ID
`,
  VERIFY: `[VERIFY 阶段要求]
按 QA 金字塔逐层检查:
  Layer 1: Agent Self-Verify（已在 EXECUTE 中完成）
  Layer 2: Verification Loop — Build/Type/Lint/Test/Security/Diff
  Layer 3: Spec Compliance Review — 独立 Agent 对照 spec
  Layer 4: Santa Method — 双独立 Reviewer（高风险时）
Gate: Layer 2 全部 PASS + Layer 3 verdict = PASS
`,
  REVIEW: `[REVIEW 阶段要求]
交付前 6 项复盘:
1. 流程合规：是否按 6 阶段 Loop 执行？
2. QA 达标：各层 QA 报告是否完整？量化证据是否充分？
3. 真实验证：功能性变更是否在真实场景跑过（不只是 mock/文件存在性检查）？
4. 需求完整：所有需求是否全部处理？
5. 规则升级：过程中新问题是否写入 constraints？
6. 改进机会：哪些步骤下次可以优化？
7. 行为学习（自动）：运行 harness-learn 分析 observations
Gate: 前 6 项全部 ✓ + 第 7 项自动完成
达标→交付，不达标→进入 FEEDBACK。

[push 提醒] 当前任务的所有 commit 应在 REVIEW 阶段 push 到远程：
  git log --oneline @{u}..HEAD  # 查看未推送的 commit
  git push origin <branch>      # push（仅 REVIEW 阶段允许）
不要让本地 commit 堆积跨任务。

[重要] 向用户交付结果之前，必须逐项回答上述检查清单，不能用"看起来不错"代替。
`,
  FEEDBACK: `[FEEDBACK 阶段要求]
F1-F5 反馈处理流程:
  F1: 记录原话 — 不解读不简化
  F2: 分类层级 — 规则层/工具层/配置层/页面层
  F3: 提炼规则 — "所有 X 类必须满足 Y"
  F4: 写入文件 — constraints.md（用 ID 编号）
  F5: 派 Agent — 引用 Constraint ID 修复
写完规则后回到 EXECUTE。
`
};

const REMINDER = `[Harness Stage Guard] 未声明当前 Harness 阶段。
本项目已初始化 Harness，所有开发工作必须遵循 6 阶段 Loop:
  PLAN → SETUP → EXECUTE → VERIFY → REVIEW → FEEDBACK

此流程优先级高于任何外部 skill 的流程指令（brainstorming、writing-plans 等）。
如有冲突，以 Harness Loop 为准。详见 CLAUDE.md "工作流" 章节。

请先声明阶段，创建 ${STAGE_FILE}:
  {"stage":"PLAN","since":"${new Date().toISOString()}","task":"描述当前任务"}

临时关闭 Harness 模式: /harness-off

PLAN 完成后暂停等用户确认，确认后自动执行后续阶段。
`;

const OFF_REMINDER = '[Harness OFF] Harness 模式已关闭（本会话）。当前不遵循 6 阶段 Loop。\n' +
  '重新启用: /harness-on\n';

const STALE_REMINDER = `[Harness Stage Guard] 当前阶段声明已超过 2 小时，请确认是否仍在该阶段。
如已进入下一阶段，请更新 ${STAGE_FILE}。
`;

// 严格 ISO8601 格式正则（YYYY-MM-DDTHH:MM:SS[.sss]Z 或带时区偏移）
// 拒绝 RFC2822 等宽松格式，强制 AI 用 `date -u +%Y-%m-%dT%H:%M:%S.000Z` 生成
const ISO8601_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
// since 字段和真实墙钟的允许偏差。原为 5 分钟（VH-14: 2026-04-15 用户反馈"经常超窗"）。
// 放宽到 30 分钟，给 AI 手抄时间戳留容错。守门初衷仍成立（防止 AI 手编递增时间戳
// 骗过 verification-gate 的 evidence freshness 检查），30 分钟远大于正常 drift，
// 远小于有意回拨到"覆盖 evidence mtime"所需的跨度。
const SINCE_DRIFT_LIMIT = 30 * 60 * 1000; // 30 分钟（VH-14）

// 校验 Write current-stage.json 时的 since 字段。
// 返回 null = 通过；返回 string = 错误消息（调用方负责 exit 2）。
function validateSince(newData) {
  if (!newData || typeof newData !== 'object') {
    return '[Harness Stage Guard] current-stage.json 内容不是合法 JSON 对象。';
  }
  if (!newData.since) {
    return '[Harness Stage Guard] since 字段缺失，拒绝写入。\n' +
      '→ current-stage.json 必须包含 since 字段（真实当前时间）。\n' +
      '→ 请用 `date -u +%Y-%m-%dT%H:%M:%S.000Z` 获取当前时间写入 since。';
  }
  // C-HOOK-09 (VH-14 Option A): "auto" / "now" sentinel 放行，由 PostToolUse:Write
  // hook stage-since-autofill.js 立即覆写为真实 ISO。AI 不再需要手抄时间戳。
  if (newData.since === 'auto' || newData.since === 'now') {
    return null;
  }
  if (typeof newData.since !== 'string' || !ISO8601_STRICT.test(newData.since)) {
    return `[Harness Stage Guard] since 字段不是合法 ISO8601 时间戳: ${newData.since}\n` +
      '→ 要求严格 ISO8601 格式（YYYY-MM-DDTHH:MM:SS[.sss]Z），拒绝 RFC2822 等宽松格式。\n' +
      '→ 也可写 "auto" 或 "now"，PostToolUse:Write stage-since-autofill 会自动覆写真实时间（C-HOOK-09）。\n' +
      '→ 或用 `date -u +%Y-%m-%dT%H:%M:%S.000Z` 获取当前时间写入 since。';
  }
  const sinceTime = Date.parse(newData.since);
  // 防御：正则形状匹配但日期值不合法（如 2026-99-99T99:99:99Z）Date.parse 返回 NaN
  if (Number.isNaN(sinceTime)) {
    return `[Harness Stage Guard] since 字段形状合法但日期值不合法: ${newData.since}\n` +
      '→ 请检查年月日时分秒是否在合理范围内。\n' +
      '→ 请用 `date -u +%Y-%m-%dT%H:%M:%S.000Z` 获取当前时间写入 since。';
  }
  const now = Date.now();
  const drift = sinceTime - now;
  if (drift > SINCE_DRIFT_LIMIT) {
    return `[Harness Stage Guard] since 字段是未来时间，拒绝写入。\n` +
      `→ 你写入的 since: ${newData.since}\n` +
      `→ 当前真实时间: ${new Date(now).toISOString()}\n` +
      `→ 偏差: ${Math.round(drift / 1000)} 秒（上限 ${SINCE_DRIFT_LIMIT / 1000} 秒）\n` +
      `→ AI 倾向于手编递增时间戳，但 verification-gate 用真实 file mtime 比对，会误报"证据早于任务开始"。\n` +
      `→ 请用 \`date -u +%Y-%m-%dT%H:%M:%S.000Z\` 拿真实时间，再重新写入。`;
  }
  if (drift < -SINCE_DRIFT_LIMIT) {
    return `[Harness Stage Guard] since 字段过于陈旧（早于当前时间 > 5 分钟），拒绝写入。\n` +
      `→ 你写入的 since: ${newData.since}\n` +
      `→ 当前真实时间: ${new Date(now).toISOString()}\n` +
      `→ 偏差: ${Math.round(drift / 1000)} 秒（下限 -${SINCE_DRIFT_LIMIT / 1000} 秒）\n` +
      `→ 请用 \`date -u +%Y-%m-%dT%H:%M:%S.000Z\` 拿真实时间，再重新写入。`;
  }
  return null;
}

// 合法的 stage 值（写入校验用）
const VALID_STAGES_FOR_WRITE = [...STAGES, 'OFF'];

function infraTierTransitionError(newData) {
  if (!newData || newData.stage !== 'EXECUTE') return null;
  let tierData = null;
  try { tierData = JSON.parse(safeReadFileSync(INFRA_TIER_FILE) || 'null'); } catch {}
  if (!tierData || tierData.tier !== 0) return null;
  const task = String(newData.task || newData.reason || '');
  // Tier 0 的唯一例外：当前任务本身就是修复/补齐测试基础设施。
  if (/test|infra|qa|coverage|e2e|bootstrap|测试|验证|准出|覆盖率|测试基础/.test(task)) return null;
  return '[Harness Stage Guard] Infra Tier 0 项目禁止直接进入新 feature EXECUTE。\n' +
    '→ 当前 .harness/infra-tier.json 显示测试基础设施不可运行。\n' +
    '→ 先执行 `shk test-infra assess` 并补齐最小测试入口；若本任务就是修复测试基础设施，请在 task 中明确包含 test/infra/测试 等字样。';
}

// 从 Write tool_input 中解析 newData 并校验 stage + since；错误时直接写 stderr + exit 2
function validateStageData(newData) {
  // 校验 stage 值合法性（Issue #2: 防止写入 "COMPLETE" 等无效值）
  if (!newData || !newData.stage || !VALID_STAGES_FOR_WRITE.includes(newData.stage)) {
    const val = newData?.stage || '(空)';
    process.stderr.write(
      `[Harness Stage Guard] 无效的 stage 值: ${val}，拒绝写入。\n` +
      `有效值: ${VALID_STAGES_FOR_WRITE.join(', ')}\n`
    );
    process.exit(2);
  }
  const err = validateSince(newData);
  if (err) {
    process.stderr.write(err + '\n');
    process.exit(2);
  }
  const infraErr = infraTierTransitionError(newData);
  if (infraErr) {
    process.stderr.write(infraErr + '\n');
    process.exit(2);
  }
  return newData;
}

// 从 Write tool_input 中解析 newData 并校验 stage + since；错误时直接写 stderr + exit 2
function validateStageWrite(input) {
  let newData = null;
  try {
    newData = JSON.parse(String(input.tool_input?.content || ''));
  } catch {
    process.stderr.write('[Harness Stage Guard] current-stage.json 内容不是合法 JSON，拒绝写入。\n');
    process.exit(2);
  }
  return validateStageData(newData);
}

function extractStageDataFromPatch(input) {
  if (!isPatchTool(input.tool_name) || !patchTouchesOnlyHarnessStage(input)) return null;
  const txt = patchPayloadText(input);
  const addedLines = txt
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1).trim())
    .filter(Boolean);
  for (let i = addedLines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(addedLines[i]);
      if (parsed && typeof parsed === 'object' && parsed.stage) return parsed;
    } catch {}
  }
  process.stderr.write('[Harness Stage Guard] apply_patch current-stage.json 未包含可解析的目标 JSON，拒绝写入。\n');
  process.exit(2);
}

function recordStageHistory(stage) {
  try {
    if (!stage) return;
    const entry = JSON.stringify({ stage, t: new Date().toISOString() }) + '\n';
    let prefix = '';
    try {
      const existing = fs.readFileSync(STAGE_HISTORY_FILE, 'utf8');
      if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n';
    } catch {}
    fs.appendFileSync(STAGE_HISTORY_FILE, prefix + entry);
  } catch {}
}

function enforceReviewGateIfNeeded(newData, input) {
  if (!newData || newData.stage !== 'REVIEW') return;
  const gateErrors = [];

  // 检查 1: 流程完整性（stage-history 中必须有 EXECUTE 和 VERIFY）
  let history = [];
  try {
    history = fs.readFileSync(STAGE_HISTORY_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .map(h => h.stage);
  } catch {}
  if (!history.includes('EXECUTE')) gateErrors.push('未经过 EXECUTE 阶段');
  if (!history.includes('VERIFY')) gateErrors.push('未经过 VERIFY 阶段');

  // 检查 2: 验证证据文件
  const hasEvidence = VERIFY_EVIDENCE.some(p => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  if (!hasEvidence) gateErrors.push('未找到验证证据文件（' + VERIFY_EVIDENCE.join(' / ') + '）');

  if (gateErrors.length > 0) {
    const message = REVIEW_GATE_BLOCK + '\n具体问题:\n' + gateErrors.map(e => '  - ' + e).join('\n') + '\n';
    if (input && input.hook_event_name === 'PreToolUse') {
      return denyPreToolUse(input, message);
    }
    process.stderr.write(message);
    process.exit(2);
  }
}

function allowStageTransition(newData, via, input) {
  recordStageHistory(newData.stage);
  enforceReviewGateIfNeeded(newData, input);
  process.stderr.write(`[Harness Stage Guard] 阶段切换：允许通过 ${via} 修改 .harness/current-stage.json\n`);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

process.stdin.on('end', () => {
  let shouldBlock = false;

  try {
    const input = JSON.parse(raw);
    if (input.hook_event_name === 'PreToolUse') {
      try {
        fs.mkdirSync(path.dirname(PRETOOL_OBS_FILE), { recursive: true });
        fs.appendFileSync(PRETOOL_OBS_FILE, JSON.stringify({
          t: new Date().toISOString(),
          hook_event_name: input.hook_event_name,
          tool_name: input.tool_name || '',
          command: String(input.tool_input?.command || '').slice(0, 500),
        }) + '\n');
      } catch {}
    }

    // ── PermissionRequest 特殊处理（Codex） ──
    // PLAN 阶段不能通过权限升级绕过 guard；使用 Codex 官方 decision.behavior shape。
    if (input.hook_event_name === 'PermissionRequest') {
      const currentStage = readCurrentStageValue();
      if (!currentStage || currentStage === 'PLAN') {
        return denyPermissionRequest(
          '[Harness Stage Guard] PLAN 阶段拒绝权限升级。先完成 PLAN 并经用户确认后，再写入 .harness/current-stage.json 切换到 EXECUTE。'
        );
      }
      return;
    }

    // ── TaskCompleted lifecycle event 特殊处理 ──
    // TaskCompleted 是 Claude Code 为任务完成专设的 event，不是 tool call。
    // 它没有 tool_name / tool_input，只有 hook_event_name + task_id + task_subject。
    // 比旧的 PreToolUse:TaskUpdate matcher + status==completed 更精确，且覆盖 agent team
    // 场景（teammate 完成 in-progress task 时也触发）。
    if (input.hook_event_name === 'TaskCompleted') {
      let currentStage = null;
      try {
        const raw = safeReadFileSync(STAGE_FILE);
        if (raw) currentStage = JSON.parse(raw).stage;
      } catch {}
      if (['EXECUTE', 'VERIFY'].includes(currentStage)) {
        const taskId = input.task_id || '';
        const subject = input.task_subject || '';
        const label = taskId ? `任务 #${taskId}` : '任务';
        const subjectPart = subject ? ` — ${subject}` : '';
        process.stderr.write(
          `[Harness Stage Guard] 在 ${currentStage} 阶段标记 ${label}${subjectPart} 完成。\n` +
          `→ 确认是否已完成 VERIFY 并产出验证证据？\n` +
          `→ 如果任务尚未真正完成，撤回此状态变更。\n`
        );
      }
      // TaskCompleted 是 observability-style event，不阻止
      return;
    }

    if (!safeFileExists(STAGE_FILE)) {
      // Bootstrap 口：允许 Write current-stage.json，但仍要校验 since
      // 注意: 如果 STAGE_FILE 是 symlink, safeFileExists 返回 false → 视为不存在,
      // 走 Bootstrap 口要求重新 Write (作为普通文件).
      const writePath = String(input.tool_input?.file_path || '');
      if (input.tool_name === 'Write' && (() => { try { return fs.realpathSync(path.resolve(writePath)); } catch { return path.resolve(writePath); } })() === path.resolve(STAGE_FILE)) {
        const parsed = validateStageWrite(input);  // 缺失/非法/偏差过大 → exit 2
        process.stderr.write('[Harness Stage Guard] 正在创建阶段声明，放行。\n');
        // 记录阶段历史
        recordStageHistory(parsed.stage);
      } else if (isPatchTool(input.tool_name) && patchTouchesOnlyHarnessStage(input)) {
        const parsed = validateStageData(extractStageDataFromPatch(input));
        recordStageHistory(parsed.stage);
        process.stderr.write('[Harness Stage Guard] 正在通过 apply_patch 创建阶段声明，放行。\n');
      } else {
        process.stderr.write(REMINDER);
        shouldBlock = true;
      }
    } else {
      const stageRaw = safeReadFileSync(STAGE_FILE);
      if (stageRaw === null) {
        // 读失败 (e.g. symlink) → 走 reminder 路径强制重新声明
        process.stderr.write(REMINDER);
        shouldBlock = true;
        process.exit(2);
      }
      const data = JSON.parse(stageRaw);

      if (data.stage === 'OFF') {
        process.stderr.write(OFF_REMINDER);
      } else if (!data.stage || !STAGES.includes(data.stage)) {
        // 无效 stage 时也允许 Write current-stage.json（修复 deadlock），但仍要校验 since
        const writePath = String(input.tool_input?.file_path || '');
        if (input.tool_name === 'Write' && (() => { try { return fs.realpathSync(path.resolve(writePath)); } catch { return path.resolve(writePath); } })() === path.resolve(STAGE_FILE)) {
          validateStageWrite(input);  // 缺失/非法/偏差过大 → exit 2
          process.stderr.write('[Harness Stage Guard] 阶段无效，允许重写阶段声明。\n');
        } else if (isPatchTool(input.tool_name) && patchTouchesOnlyHarnessStage(input)) {
          const parsed = validateStageData(extractStageDataFromPatch(input));
          recordStageHistory(parsed.stage);
          process.stderr.write('[Harness Stage Guard] 阶段无效，允许通过 apply_patch 重写阶段声明。\n');
        } else {
          process.stderr.write(
            `[Harness Stage Guard] 无效的阶段值: ${data.stage}。有效值: ${STAGES.join(', ')}, OFF\n` +
            `修复方法: 用 Write 工具重写 ${STAGE_FILE}，例如:\n` +
            `  {"stage":"PLAN","since":"<用 date -u +%Y-%m-%dT%H:%M:%S.000Z 获取>","task":"<任务描述>"}\n`
          );
          shouldBlock = true;
        }
      } else {
        // Harness 模式生效中
        const toolName = input.tool_name || '';
        const writePath = String(input.tool_input?.file_path || '');

        // ── 阶段切换 Gate 检查 ──
        // 如果是 Write current-stage.json，校验 since 然后检查目标阶段
        if (toolName === 'Write' && (() => { try { return fs.realpathSync(path.resolve(writePath)); } catch { return path.resolve(writePath); } })() === path.resolve(STAGE_FILE)) {
          const newData = validateStageWrite(input);  // 缺失/非法/偏差过大 → exit 2

          allowStageTransition(newData, 'Write', input);
          // 阶段切换 Write 放行（如果 Gate 检查通过）
          return;
        } else if (isPatchTool(toolName) && patchTouchesOnlyHarnessStage(input)) {
          const newData = validateStageData(extractStageDataFromPatch(input));
          allowStageTransition(newData, 'apply_patch', input);
          return;
        }

        // 首次工具调用检查：强制 AI 先输出阶段声明
        let toolCount = { count: 999 }; // 默认跳过（文件不存在时不阻止）
        try { toolCount = JSON.parse(fs.readFileSync(TOOL_COUNT_FILE, 'utf8')); } catch {}
        if (toolCount.count === 0 && !TASK_TOOLS.includes(toolName)) {
          // 递增计数器，下次不再阻止
          try { fs.writeFileSync(TOOL_COUNT_FILE, JSON.stringify({ count: 1 }) + '\n'); } catch {}
          return denyPreToolUse(input, FIRST_CALL_BLOCK);
        } else if (data.stage === 'PLAN') {
        // PLAN 阶段：硬约束——只允许读工具 + 任务管理工具 + Write 计划文件/阶段文件
          const isReadTool = READ_TOOLS.includes(toolName);
          const isTaskTool = TASK_TOOLS.includes(toolName);
          const isReadOnlyBash = toolName === 'Bash' && isPlanReadOnlyBash(input.tool_input?.command);
          // 精确匹配：realpathSync 后比对, 跟随 symlink 确保 /tmp ↔ /private/tmp 一致
          const resolvedWrite = (() => { try { return fs.realpathSync(path.resolve(writePath)); } catch { return path.resolve(writePath); } })();
          const isAllowedWrite = (toolName === 'Write' &&
            [PLAN_FILE, STAGE_FILE].some(f => resolvedWrite === path.resolve(f))) ||
            (isPatchTool(toolName) && (patchTouchesOnlyHarnessPlan(input) || patchTouchesOnlyHarnessStage(input)));

          if (isReadTool || isReadOnlyBash) {
            // 读操作 / 只读 Bash 放行，注入 directive
            process.stderr.write(STAGE_DIRECTIVES.PLAN);
            process.stderr.write(LOG_REMINDER);
          } else if (isTaskTool) {
            // 任务管理工具放行，不打扰（流程管理操作）
          } else if (isAllowedWrite) {
            // 写计划文件或阶段声明放行
            process.stderr.write(`[Harness Stage Guard] PLAN 阶段：允许写入 ${writePath}\n`);
          } else {
            // 其他一律阻止
            return denyPreToolUse(input, PLAN_BLOCK_MSG);
          }
        } else {
          // 非 PLAN 阶段：注入阶段工作要求，不阻止
          process.stderr.write(
            `[Harness ON] 当前阶段: ${data.stage}` + (data.task ? ` — ${data.task}` : '') + '\n'
          );

          // 注：原 TaskUpdate(completed) 提醒已迁移到 TaskCompleted lifecycle event 处理路径
          // （见本文件顶部的 input.hook_event_name === 'TaskCompleted' 分支）。
          // 这里保留 TaskUpdate 作为 TASK_TOOLS 成员（放行流程 + 跳过 first-call guard），
          // 但不再在 PreToolUse:TaskUpdate 分支做 completed 检测，避免和 TaskCompleted 重复提醒。

          if (STAGE_DIRECTIVES[data.stage]) {
            process.stderr.write(STAGE_DIRECTIVES[data.stage]);
            process.stderr.write(LOG_REMINDER);
          }
        }

        // 过期提醒
        if (data.since) {
          const elapsed = Date.now() - new Date(data.since).getTime();
          if (elapsed > STALE_MS) {
            process.stderr.write(STALE_REMINDER);
          }
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[Harness Stage Guard] 无法读取 ${STAGE_FILE}: ${e.message}\n`);
    shouldBlock = true; // 异常时阻止，不能失败即放行
  }

  if (shouldBlock) {
    process.exit(2);
  }
  // stdout 保持为空（Codex runtime 兼容，见 VH-13）
});

#!/usr/bin/env node
'use strict';

/**
 * Commit Check Hook — 提交前检查三件事:
 * @version 0.9.0
 * 1. AI session 的 commit 必须包含 Co-Authored-By（warn）
 * 2. commit subject 必须匹配 active preset 的 subject_regex（warn）
 * 3. REVIEW 阶段检查是否有未提交变更（配合 verification-gate）
 *
 * 触发: PreToolUse:Bash
 */

const { execSync } = require('child_process');
const { loadPreset } = require('./load-preset');
const MAX_STDIN = 1024 * 1024;
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const cmd = String(input.tool_input?.command || '');

    // === 检查 1+2: git commit 必须包含 Co-Authored-By + subject 匹配 preset ===
    if (/git\s+commit/.test(cmd)) {
      // 从命令中提取 commit message
      // VH-18 F2 / R2-2: 与 git 一致——多个 -m / --message= 之间用 "\n\n" 拼接
      //   （git 的实际行为）。旧代码只取第一个 -m → 误判缺 Co-Authored-By；
      //   v1 分 3 趟 regex（双引、单引、--message=）顺序错乱，混用引号时
      //   `git commit -m 'subj' -m "trailer"` 拼成 `trailer\n\nsubj`，
      //   subject 被识别成 trailer。
      //   v2 (本版) 用单个全局 regex 一次扫所有 token，按 match.index
      //   自然顺序迭代，参数顺序 == git 实际语义。
      // 覆盖顺序：heredoc (取首段) → 所有 -m / --message= 按出现顺序拼接
      let msg = '';
      let m;
      m = cmd.match(/<<['"]?EOF([\s\S]*?)EOF/);
      if (m) msg = m[1];
      if (!msg) {
        // 单 regex 覆盖 -m "..." / -m '...' / --message="..." / --message='...' / --message=bare
        // 捕获组语义：
        //   2 = -m "..." 内容
        //   3 = -m '...' 内容
        //   5 = --message="..." 内容
        //   6 = --message='...' 内容
        //   7 = --message=bare 内容
        const re = /(?:^|\s)(?:-m\s+("([\s\S]*?)(?<!\\)"|'([\s\S]*?)')|--message=("([^"]*)"|'([^']*)'|(\S+)))/g;
        const segs = [];
        let mm;
        while ((mm = re.exec(cmd)) !== null) {
          const seg = mm[2] !== undefined ? mm[2]
                    : mm[3] !== undefined ? mm[3]
                    : mm[5] !== undefined ? mm[5]
                    : mm[6] !== undefined ? mm[6]
                    : mm[7] !== undefined ? mm[7]
                    : '';
          segs.push(seg);
        }
        if (segs.length > 0) msg = segs.join('\n\n');
      }

      if (msg) {
        const subject = (msg.split('\n').find(l => l.trim()) || '').trim();

        // === 检查 2: subject 匹配 active preset's subject_regex (warn, opt-in) ===
        // 仅在用户**主动**选了 preset 时校验（HARNESS_PRESET env / .harness.local.json
        // / .claude/settings.json `harness.preset`）。默认 fallback 到 generic
        // 的用户体验"原方式"，不应被新检查打扰（back-compat for v0.8.x → v0.9.0）。
        try {
          const preset = loadPreset();
          if (preset.source !== 'default') {
            const re = preset.commit_format?.subject_regex;
            if (re) {
              let regex;
              try { regex = new RegExp(re); } catch { regex = null; }
              if (regex && subject && !regex.test(subject)) {
                process.stderr.write(
                  `[Commit Check] Subject 不符合 preset '${preset.name}' 格式。\n` +
                  `→ 期望: ${preset.commit_format.format_description || re}\n` +
                  `→ 实际: ${subject}\n` +
                  `→ 示例: ${(preset.commit_format.examples || [])[0] || '(none)'}\n` +
                  `→ 警告级别，不阻止执行。bypass: HARNESS_SKIP_GATE=1\n`
                );
              }
            }
          }
        } catch {}

        const hasCoAuthored = /Co-Authored-By:/i.test(msg);
        if (!hasCoAuthored) {
          process.stderr.write(
            '[Commit Check] AI 辅助的 commit 缺少 Co-Authored-By 标注。\n' +
            '→ 格式: Co-Authored-By: {工具名} ({模型ID}) {code|test|fix}\n' +
            '→ 例如: Co-Authored-By: Claude Code (claude-opus-4-6) code\n' +
            '→ 详见 methodology/12-commit-standards.md\n'
          );
          // 警告但不阻止，因为可能是纯人工 commit
        } else {
          // 格式校验：每一行 Co-Authored-By 必须匹配 methodology/12-commit-standards.md 规定的格式
          // 允许的工具名清单与 methodology/12 表格同步，缺少某工具只需在这里加
          const ALLOWED_TOOLS = [
            'Claude Code',
            'Codex CLI',
            'Cursor',
            'Windsurf',
            'GitHub Copilot',
            'OpenCode',
          ];
          const toolAlt = ALLOWED_TOOLS
            .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|');
          // 正则：Co-Authored-By: <Tool Name> (<model-id>) <type>
          //   - 模型 ID 允许字母/数字/点/连字符/下划线，括号必选
          //   - 第三段 type 必选，仅 code/test/fix（commit 内容语义维度）
          //   - 禁止尾部 <email>（老模板产物）
          const validLine = new RegExp(`^Co-Authored-By:\\s+(?:${toolAlt})\\s+\\([\\w.\\-]+\\)\\s+(?:code|test|fix)\\s*$`);

          const badLines = [];
          for (const line of msg.split('\n')) {
            if (/^Co-Authored-By:/i.test(line)) {
              if (!validLine.test(line.trim())) {
                badLines.push(line.trim());
              }
            }
          }

          if (badLines.length > 0) {
            process.stderr.write(
              '[Commit Check] Co-Authored-By 格式不符合 methodology/12-commit-standards.md。\n' +
              '→ 标准格式: Co-Authored-By: {工具名} ({模型ID}) {code|test|fix}\n' +
              '→ 例如:    Co-Authored-By: Claude Code (claude-opus-4-6) code\n' +
              '→ 允许的工具名: ' + ALLOWED_TOOLS.join(' / ') + '\n' +
              '→ type 段（必填）: code（业务代码）/ test（测试）/ fix（修 bug）\n' +
              '→ 禁止: 尾部 <email> / 括号外带空格 / 工具名与表格不符 / 缺第三段\n' +
              '→ 不合规的行:\n'
            );
            for (const l of badLines) {
              process.stderr.write('    ' + l + '\n');
            }
            process.stderr.write('→ 修正后重新 commit。警告级别，不阻止执行\n');
          }
        }
      }
    }

    // === 检查 2: 检测 REVIEW 相关操作时，提醒未提交变更 ===
    if (/delivery|review|交付|复盘/.test(cmd)) {
      try {
        const status = execSync('git status --porcelain', { encoding: 'utf8', timeout: 5000 });
        if (status.trim()) {
          const fileCount = status.trim().split('\n').length;
          process.stderr.write(
            `[Commit Check] 有 ${fileCount} 个文件未提交。\n` +
            '→ REVIEW Gate 要求：代码已提交，commit message 引用 Constraint ID。\n' +
            '→ 请先 commit 再进行交付复盘。\n'
          );
        }
      } catch {}
    }
  } catch {}
  // stdout 保持为空（Codex 0.118.0 兼容，见 VH-13）
});

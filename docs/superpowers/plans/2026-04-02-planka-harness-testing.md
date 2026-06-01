# Planka Harness 实测计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Claude Code 对 Planka 项目完成 Harness init + Feature #1485（Add board/list descriptions）的完整 6 阶段 Loop，验证 Harness 方法论的跨项目适用性。

**Architecture:** Feature #1485 需要在 Board 和 List 两个实体上新增 `description` 字段（text, nullable）。改动贯穿全栈：Knex migration → Sails.js model/controller/helper → Redux-ORM model/reducer → React UI 组件。

**Tech Stack:** Sails.js (Node.js), Knex migrations, PostgreSQL, React + Redux + Redux-ORM, SCSS Modules

---

## 前置：项目准备

### Task 0: Fork、Clone 和 Branch

**Files:** 无代码改动

- [ ] **Step 1: Fork Planka**

```bash
gh repo fork plankanban/planka --clone=false
```

- [ ] **Step 2: Clone fork 到本地**

```bash
cd ~/ops/harness-dogfood
git clone git@github.com:<your-username>/planka.git
cd planka
```

- [ ] **Step 3: 创建实测 branch**

```bash
git checkout -b harness-test/claude-code
```

- [ ] **Step 4: 确认项目结构**

```bash
ls client/src/components/boards/ client/src/components/lists/ server/api/models/Board.js server/api/models/List.js
```

Expected: 文件都存在，结构符合预期

---

## Phase 1: Harness Init

### Task 1: 对 Planka 执行 Harness Init

**Files:**
- Create: `CLAUDE.md`（由 Harness init 生成）
- Create: `.claude/rules/`（由 Harness init 生成）
- Create: `.claude/settings.json`（由 Harness init 生成）

- [ ] **Step 1: 读取 init-prompt.md 和方法论**

告诉 Claude Code：
```
Read ~/ops/harness-dogfood/simple-harness-kit/init-prompt.md and the methodology/ directory.
Initialize Harness for this project (Planka).
```

- [ ] **Step 2: 审查生成的配置**

检查生成的文件：
```bash
cat CLAUDE.md
ls .claude/rules/
cat .claude/settings.json
```

评估标准：
- CLAUDE.md 包含 Planka 的技术栈信息（Sails.js, React, PostgreSQL, Knex）
- Rules 包含 QA 标准和约束
- Hooks 引用了正确的构建/测试命令

- [ ] **Step 3: 记录 Init 评估**

在实测报告中记录：
- 生成了哪些文件
- 哪些内容准确、哪些需要人工修改
- Init 耗时

- [ ] **Step 4: Commit init 结果**

```bash
git add CLAUDE.md .claude/
git commit -m "chore: Harness init for Planka"
```

---

## Phase 2: Plan 阶段（6 阶段 Loop - Stage 1）

### Task 2: 分析需求并写实现计划

**Files:**
- 无代码改动，产出是计划文档

- [ ] **Step 1: 读取 Issue #1485**

需求要点：
- Board 和 List 都需要 `description` 字段
- Description 显示在 board name 和 list name 下方
- 目的是帮助用户理解每个 list/board 的用途

- [ ] **Step 2: 分析需要改动的文件**

**后端（server/）：**
- `server/db/migrations/` — 新建 migration，给 `board` 和 `list` 表加 `description` 列
- `server/api/models/Board.js` — 新增 `description` attribute
- `server/api/models/List.js` — 新增 `description` attribute
- `server/api/controllers/boards/update.js` — 新增 `description` input
- `server/api/controllers/lists/update.js` — 新增 `description` input
- `server/api/helpers/boards/create-one.js` — 可能需要支持 description
- `server/api/helpers/lists/` — 对应 helper

**前端（client/src/）：**
- `client/src/models/Board.js` — 新增 `description` field
- `client/src/models/List.js` — 新增 `description` field
- `client/src/constants/ActionTypes.js` — 可能不需要新增（复用 BOARD_UPDATE / LIST_UPDATE）
- `client/src/components/boards/Board/` — 显示 board description
- `client/src/components/boards/BoardSettingsModal/GeneralPane/` — 编辑 board description
- `client/src/components/lists/List/` — 显示 list description + 编辑入口
- `client/src/locales/` — 国际化文案

- [ ] **Step 3: 确认计划，进入 Setup**

---

## Phase 3: Setup 阶段（6 阶段 Loop - Stage 2）— TDD

### Task 3: 后端 — DB Migration

**Files:**
- Create: `server/db/migrations/YYYYMMDDHHMMSS_add_description_to_board_and_list.js`

- [ ] **Step 1: 写 migration 文件**

```javascript
/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

module.exports.up = async (knex) => {
  await knex.schema.alterTable('board', (table) => {
    table.text('description').defaultTo(null);
  });

  return knex.schema.alterTable('list', (table) => {
    table.text('description').defaultTo(null);
  });
};

module.exports.down = async (knex) => {
  await knex.schema.alterTable('board', (table) => {
    table.dropColumn('description');
  });

  return knex.schema.alterTable('list', (table) => {
    table.dropColumn('description');
  });
};
```

- [ ] **Step 2: 验证 migration 语法**

```bash
node -c server/db/migrations/*_add_description_to_board_and_list.js
```

Expected: 无语法错误

- [ ] **Step 3: Commit**

```bash
git add server/db/migrations/
git commit -m "feat: add description column to board and list tables"
```

### Task 4: 后端 — Model 更新

**Files:**
- Modify: `server/api/models/Board.js` — 在 attributes 的 primitives 区域加 `description`
- Modify: `server/api/models/List.js` — 同上

- [ ] **Step 1: 更新 Board model**

在 `server/api/models/Board.js` 的 attributes primitives 区域（`expandTaskListsByDefault` 之后）添加：

```javascript
    description: {
      type: 'string',
      allowNull: true,
    },
```

同时更新 Swagger schema，在 properties 中添加：
```javascript
 *         description:
 *           type: string
 *           nullable: true
 *           description: Description of the board
 *           example: This board tracks the development workflow
```

- [ ] **Step 2: 更新 List model**

在 `server/api/models/List.js` 的 attributes primitives 区域（`color` 之后）添加：

```javascript
    description: {
      type: 'string',
      allowNull: true,
    },
```

同时更新 Swagger schema。

- [ ] **Step 3: 验证语法**

```bash
node -c server/api/models/Board.js server/api/models/List.js
```

- [ ] **Step 4: Commit**

```bash
git add server/api/models/Board.js server/api/models/List.js
git commit -m "feat: add description attribute to Board and List models"
```

### Task 5: 后端 — Controller 更新

**Files:**
- Modify: `server/api/controllers/boards/update.js` — 加 `description` input 和权限
- Modify: `server/api/controllers/lists/update.js` — 加 `description` input

- [ ] **Step 1: 更新 Board update controller**

在 `server/api/controllers/boards/update.js` 的 inputs 中添加：

```javascript
    description: {
      type: 'string',
      allowNull: true,
    },
```

在 `availableInputKeys`（isProjectManager 分支）中添加 `'description'`：

```javascript
    if (isProjectManager) {
      availableInputKeys.push(
        'position',
        'name',
        'description',
        'defaultView',
        // ... 其余保持不变
      );
    }
```

在 `values` 的 `_.pick` 中添加 `'description'`：

```javascript
    const values = _.pick(inputs, [
      'position',
      'name',
      'description',
      'defaultView',
      // ... 其余保持不变
    ]);
```

更新 Swagger requestBody schema。

- [ ] **Step 2: 更新 List update controller**

在 `server/api/controllers/lists/update.js` 的 inputs 中添加：

```javascript
    description: {
      type: 'string',
      allowNull: true,
    },
```

在 `values` 的 `_.pick` 中添加 `'description'`：

```javascript
    const values = _.pick(inputs, ['type', 'position', 'name', 'color', 'description']);
```

更新 Swagger requestBody schema。

- [ ] **Step 3: 验证语法**

```bash
node -c server/api/controllers/boards/update.js server/api/controllers/lists/update.js
```

- [ ] **Step 4: Commit**

```bash
git add server/api/controllers/boards/update.js server/api/controllers/lists/update.js
git commit -m "feat: add description input to board and list update controllers"
```

### Task 6: 后端 — Helper 更新（如需要）

**Files:**
- Modify: `server/api/helpers/boards/create-one.js`（如果 create 需要支持 description）
- Modify: `server/api/helpers/lists/`（对应文件）

- [ ] **Step 1: 检查 create helpers 是否需要改动**

```bash
cat server/api/helpers/boards/create-one.js
cat server/api/helpers/lists/create-one.js 2>/dev/null || ls server/api/helpers/lists/
```

如果 create helper 中有 `values` 的白名单需要更新，则添加 `description`。如果 helper 透传所有属性则无需改动。

- [ ] **Step 2: 检查 update helpers**

```bash
cat server/api/helpers/boards/update-one.js
```

同理检查是否有白名单。

- [ ] **Step 3: 按需修改并 commit**

```bash
git add server/api/helpers/
git commit -m "feat: support description in board/list helpers"
```

---

## Phase 4: Execute 阶段（6 阶段 Loop - Stage 3）— 前端实现

### Task 7: 前端 — Redux-ORM Model 更新

**Files:**
- Modify: `client/src/models/Board.js` — 加 `description` field
- Modify: `client/src/models/List.js` — 加 `description` field

- [ ] **Step 1: 更新 Board client model**

在 `client/src/models/Board.js` 的 `static fields` 中添加：

```javascript
    description: attr({
      getDefault: () => null,
    }),
```

位置：放在 `name: attr()` 之后。

- [ ] **Step 2: 更新 List client model**

在 `client/src/models/List.js` 的 `static fields` 中添加：

```javascript
    description: attr({
      getDefault: () => null,
    }),
```

位置：放在 `color: attr()` 之后。

- [ ] **Step 3: Commit**

```bash
git add client/src/models/Board.js client/src/models/List.js
git commit -m "feat: add description field to Board and List client models"
```

### Task 8: 前端 — Board Description UI

**Files:**
- Modify: `client/src/components/boards/BoardSettingsModal/GeneralPane/` — 添加 description 编辑区
- Modify: `client/src/components/boards/Board/` — 显示 description

- [ ] **Step 1: 探索现有 GeneralPane 和 Board 组件结构**

```bash
ls client/src/components/boards/BoardSettingsModal/GeneralPane/
cat client/src/components/boards/BoardSettingsModal/GeneralPane/GeneralPane.jsx
ls client/src/components/boards/Board/
```

理解现有的编辑模式（是 inline 编辑还是弹窗），找到 `name` 字段的编辑方式作为参考。

- [ ] **Step 2: 在 Board Settings GeneralPane 中添加 description 编辑**

参照 `name` 字段的编辑方式，在其下方添加一个 textarea 用于编辑 board description。使用现有的 `BOARD_UPDATE` action 保存。

- [ ] **Step 3: 在 Board 视图中显示 description**

在 board name 下方显示 description（如果有值的话）。样式应为较小字体、浅色文字，不抢 board name 的视觉。

- [ ] **Step 4: Commit**

```bash
git add client/src/components/boards/
git commit -m "feat: add board description editing and display UI"
```

### Task 9: 前端 — List Description UI

**Files:**
- Modify: `client/src/components/lists/List/` — 显示 description + 编辑入口

- [ ] **Step 1: 探索 List 组件结构**

```bash
cat client/src/components/lists/List/List.jsx
```

找到 list name 的渲染位置。

- [ ] **Step 2: 在 List header 中显示 description**

在 list name 下方显示 description（如果有值的话）。样式同 board description，小字体、浅色。

- [ ] **Step 3: 添加 description 编辑入口**

在 List 的 ActionsStep（右键菜单或 ... 按钮弹出）中添加"Edit description"选项，或者让 description 可以 inline 点击编辑。参照现有 EditName 组件的模式。

- [ ] **Step 4: Commit**

```bash
git add client/src/components/lists/
git commit -m "feat: add list description display and editing UI"
```

### Task 10: 前端 — 国际化

**Files:**
- Modify: `client/src/locales/en/core.js`（或对应文件）

- [ ] **Step 1: 找到现有的 i18n 文件结构**

```bash
ls client/src/locales/en/
```

- [ ] **Step 2: 添加翻译 key**

添加类似：
```javascript
'common.description': 'Description',
'common.editDescription': 'Edit description',
'common.noDescription': 'No description',
```

（具体 key 格式参照现有代码的命名惯例）

- [ ] **Step 3: Commit**

```bash
git add client/src/locales/
git commit -m "feat: add i18n strings for board/list descriptions"
```

---

## Phase 5: Verify 阶段（6 阶段 Loop - Stage 4）

### Task 11: 运行测试和检查

**Files:** 无改动

- [ ] **Step 1: 语法检查所有修改过的后端文件**

```bash
find server/api -name '*.js' -newer server/api/models/Board.js.orig | xargs node -c
# 或者逐个检查
node -c server/api/models/Board.js server/api/models/List.js
node -c server/api/controllers/boards/update.js server/api/controllers/lists/update.js
node -c server/db/migrations/*_add_description_to_board_and_list.js
```

- [ ] **Step 2: 前端 lint**

```bash
cd client && npm run lint 2>&1 | head -50
```

- [ ] **Step 3: 前端 build 检查**

```bash
cd client && npm run build 2>&1 | tail -20
```

Expected: 无 build error

- [ ] **Step 4: 后端 lint（如果有配置）**

```bash
cd server && npm run lint 2>&1 | head -50
```

- [ ] **Step 5: 记录 Verify 结果**

记录每项检查的通过/失败状态，失败的回 Execute 阶段修复。

---

## Phase 6: Review 阶段（6 阶段 Loop - Stage 5）

### Task 12: 代码审查 + harness-learn

**Files:** 无改动

- [ ] **Step 1: 运行 harness-learn（如果 Harness init 配置了）**

如果 Harness init 在 REVIEW 阶段配置了 harness-learn hook，它会自动触发。否则手动运行分析。

- [ ] **Step 2: 自审代码变更**

```bash
git diff harness-test/claude-code~10..HEAD --stat
git diff harness-test/claude-code~10..HEAD
```

检查清单：
- 无遗漏文件
- Model、Controller、Helper 之间的字段名一致
- 前端 model 字段与后端 API 返回一致
- i18n key 在组件中正确引用
- 样式不破坏现有布局

- [ ] **Step 3: 记录 Review 发现**

---

## Phase 7: Feedback 阶段（6 阶段 Loop - Stage 6）

### Task 13: 记录偏差和方法论反馈

**Files:**
- Create: `~/ops/harness-dogfood/simple-harness-kit/examples/experiment-c-planka/` — 实测报告

- [ ] **Step 1: 撰写实测报告**

按照 spec 中定义的报告模板，记录：
- Harness Init 评估
- 6 阶段 Loop 执行记录
- QA 金字塔覆盖
- 产出物统计
- 方法论改进点

- [ ] **Step 2: Commit 报告到 simple-harness-kit**

```bash
cd ~/ops/harness-dogfood/simple-harness-kit
git add examples/experiment-c-planka/
git commit -m "docs: Experiment C — Planka harness testing report (Claude Code)"
```

- [ ] **Step 3: 更新路线图**

将多工具实测 Phase 1 标记为完成，更新下一步计划。

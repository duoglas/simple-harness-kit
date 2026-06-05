# 05. Phase 2 本轮 dogfood 迭代记录

这份记录说明：Phase 2 不是只写给目标工程看的规则，SHK 自己这一轮也按同一套方式推进。

## 本轮 spec 要求

本轮 spec 放在本地 evidence 文件 `.harness/iteration-spec.json`，核心要求有四条：

1. SHK 安装到目标工程后，AI 能用简短有效的 spec 说明需求、方案、测试和验收。
2. SHK 能帮助目标工程完成测试生成、有效测试验证和交付准出，不只是给 SHK 仓库自己跑测试。
3. 发现问题或测试证明力不足时，AI 要进入最多 3 轮的修复 loop。
4. SHK Phase 2 自己也必须按 spec-driven 流程运作：没有可执行 spec，不能进入实现；样例目标工程要证明这条规则真的会拦住。

## 本轮真正改了什么

这轮不是只改说明文字，实际补了三层能力：

- **后端判断**：`shk spec status`、`shk test effectiveness`、`shk verify` 会把 spec、E2E 充分性、流量覆盖、mutation/fault 证据合在一起看。
- **Hook 强制**：`harness-stage-guard.js` 在切到 `EXECUTE` 前检查 `.harness/iteration-spec.json`。缺 spec 或 spec 没说清楚测试覆盖关系时，直接拦住。
- **样例工程验收**：`tests/scripts/16-spec-driven-target-app-acceptance.sh` 会创建一个临时订单应用，验证缺 spec 被拦、补 spec 后才能生成并运行 E2E、故意改坏订单逻辑后 E2E 必须失败。

## 样例工程先证明了什么

样例工程不是只跑 `echo ok`。

它证明了：

- 没有迭代 spec 时，medium 风险交付会被挡住。
- 没有迭代 spec 时，AI 不能直接切到 `EXECUTE` 开始改代码。
- 写好订单创建 spec 后，测试计划能映射到需求、风险和流量路径。
- 生成的 E2E 同时覆盖订单创建正向路径和空订单阻断路径。
- 故意把订单创建结果改坏后，E2E 会失败；坏代码不会被当成可以交付。

## 真实 OSS dogfood 又补了什么

样例工程能证明流程闭环，但还不够。因为样例工程毕竟是 SHK 自己造出来的，不能替代真实目标工程。

所以本轮又补了 `tests/scripts/17-oss-dogfood-validation.sh`：

- 前端开源工程：`1Marc/modern-todomvc-vanillajs`，测真实 `js/store.js`；
- API 开源工程：`rwieruch/node-express-server-rest-api`，测真实 `src/routes/message.js`；
- 两个工程都写入 spec、质量合约、E2E、run-token evidence；
- 正常代码下 E2E 通过；
- 故意改坏真实源码后，同一条 E2E 必须失败；
- fake / smoke-only / 注释关键词脚本不能被 `e2e assess --risk medium` 当成 READY。

这补上的是“真实工程证明力”：SHK 不是只在 fixture 上跑通，而是能在真实 OSS 代码路径上生成和判断有效测试。

## upstream CI 和浏览器链路又补了什么

上一轮真实 OSS dogfood 仍然缺两块：没有跑上游 npm install / 原项目 CI，也没有跑浏览器真实页面。

本轮继续补：

- `tests/scripts/18-upstream-ci-dogfood.sh`：两个真实 OSS 工程都执行 npm install/ci，并检查原项目 test/build/lint/typecheck 的证明力。空壳 test 会被标成 `NO_PROOF`，不能包装成“上游 CI 有效”。
- `tests/scripts/19-browser-e2e-dogfood.sh`：启动真实 TodoMVC 页面，用 headless browser 输入 todo、检查 DOM/计数/筛选/清理；再把真实 `js/store.js` 改坏，确认同一条浏览器 E2E 会失败。

这两步把验证边界说得更清楚：依赖安装、原项目 CI、SHK 生成的 E2E/mutation、浏览器链路是四种不同证据，不能混在一起报喜。

## 本轮准出证据

当前已跑过的关键验证：

- `node tests/quality-suite.test.js`：53/53 PASS。
- `bash tests/scripts/16-spec-driven-target-app-acceptance.sh`：PASS，样例目标工程能抓住 mutation。
- `bash tests/scripts/17-oss-dogfood-validation.sh`：PASS，两个真实 OSS 工程都能抓住 mutation。
- `bash tests/scripts/18-upstream-ci-dogfood.sh`：PASS，两个真实 OSS 工程 npm install/ci 完成；原项目 CI 证明力单独标注。
- `bash tests/scripts/19-browser-e2e-dogfood.sh`：PASS（需 headless browser / localhost 权限），真实 TodoMVC 页面 mutation 后失败。
- `bash tests/scripts/run-all.sh`：17 个维度全部 PASS（本机具备 OSS tarball、npm cache、browser runtime 时包含 17/18/19；普通沙盒没有浏览器权限时 19 会 SKIP，不会假装通过）。
- `node tests/run.js`：216 passed, 0 failed。
- `node scripts/shk.js verify --risk medium --write-evidence`：overall READY。
- `node scripts/shk.js security scan`：0 findings。

Codex runtime smoke 在 `tests/run.js` 里仍显示 DEGRADED。这只能说明当前环境没有完成 Codex project hook runtime smoke，不能被说成 runtime PASS，也不能用于 release READY。

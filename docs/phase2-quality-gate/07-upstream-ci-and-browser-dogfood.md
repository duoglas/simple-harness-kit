# 07. Upstream CI 与浏览器 E2E dogfood

这页补齐上一轮没有做完的两件事：

1. 上游完整 npm install / 原项目 CI；
2. 浏览器真实页面 E2E。

## 为什么要分开看

“真实工程验证”不能混成一句“测过了”。至少要分清四类证据：

| 证据 | 能证明什么 | 不能证明什么 |
|---|---|---|
| 上游 npm install / ci | 依赖能不能装，原项目自带脚本能不能跑 | 原项目脚本是否真的有质量证明力 |
| SHK 生成的 E2E | AI Harness 能否为目标工程补测试 | 是否覆盖浏览器真实页面 |
| mutation / fault injection | 坏逻辑会不会被测试抓住 | 是否覆盖所有业务路径 |
| 浏览器 E2E | 页面、DOM、用户输入、路由和浏览器 runtime 是否真的通 | 线上真实用户流量 |

## 18：upstream npm install / 原项目 CI

脚本：

```bash
bash tests/scripts/18-upstream-ci-dogfood.sh
```

它会在真实 OSS 临时副本里跑：

- `npm ci` 或 `npm install`；
- 原项目声明的 `test` / `build` / `lint` / `typecheck`；
- 对空壳脚本做证明力分级。

这轮实际结果：

- `1Marc/modern-todomvc-vanillajs`：`npm ci` 通过；没有原项目 test/build/lint/typecheck，所以 upstream CI 证明力是 `NO_PROOF`。
- `rwieruch/node-express-server-rest-api`：`npm ci` 通过；原 `npm test` 是 `echo "No test specified" && exit 0`，所以 upstream CI 证明力是 `NO_PROOF`。

这不是坏消息，反而是 SHK 需要说清楚的事实：**依赖能装，不等于原 CI 有质量证明力。**

如果 npm registry 需要代理，可以这样跑：

```bash
SHK_NPM_PROXY=http://127.0.0.1:8016 bash tests/scripts/18-upstream-ci-dogfood.sh
```

如果网络不可用，脚本会 SKIP 或 FAIL（取决于是否设置 required），不会拿 fixture 冒充 upstream CI。

## 19：浏览器真实链路 E2E

脚本：

```bash
bash tests/scripts/19-browser-e2e-dogfood.sh
```

它会：

- 使用真实 TodoMVC OSS 临时副本；
- 启动本地静态 HTTP 服务；
- 用 headless Playwright Chromium 打开真实页面；
- 输入 todo；
- 检查 DOM label 和 `1 item left`；
- 完成 todo 后检查 Completed 筛选；
- clear completed 后确认页面清空；
- 把真实 `js/store.js` 改坏为 `completed: true`；
- 确认同一条浏览器 E2E 失败。

这证明的不是“源码函数能跑”，而是浏览器里的用户路径确实通，并且关键 UI 状态坏掉时能被抓住。

如果本机还没有 browser 工具，可以这样安装到 `/private/tmp`：

```bash
SHK_BROWSER_E2E_ALLOW_INSTALL=1 \
SHK_NPM_PROXY=http://127.0.0.1:8016 \
bash tests/scripts/19-browser-e2e-dogfood.sh
```

如果运行环境禁止本地监听或没有浏览器 runtime，脚本会 SKIP 或 FAIL，不会把源码级 E2E 说成浏览器 E2E。

## 用户应该看到的人话报告

```text
这轮补齐了两块真实工程验证。

第一块是 upstream install/CI：两个开源工程都能完成 npm ci。它们的原项目测试没有证明力，其中 API 工程的 npm test 只是 No test specified，所以我不会把它说成有效 CI。

第二块是浏览器 E2E：我打开了真实 TodoMVC 页面，输入 todo，检查 DOM、剩余数量、Completed 筛选和 clear completed。然后我把真实 store.js 改坏，同一条浏览器 E2E 失败。

所以现在可以说：依赖安装、原项目 CI 证明力、SHK E2E/mutation、浏览器链路已经分开验证。还没做的是线上真实流量回放。

机器状态：READY
```

# 06. 真实开源工程 dogfood 验证

这页补的是一个很关键的洞：只用 SHK 自己的 fixture 或临时样例应用，不能证明 Phase 2 真能帮目标工程提高质量。

所以这轮增加了一个单独脚本：

```bash
bash tests/scripts/17-oss-dogfood-validation.sh
```

它做的事很简单：拿两个真实开源工程的临时副本，把 SHK 当作 AI Harness 接进去，生成 spec、质量合约、E2E 和 evidence；正常代码要通过，故意改坏真实源码后同一条 E2E 必须失败。

## 用了哪些开源工程

| 类型 | 开源工程 | 测试的真实代码路径 |
|---|---|---|
| 前端 | `1Marc/modern-todomvc-vanillajs` | `js/store.js` |
| API | `rwieruch/node-express-server-rest-api` | `src/routes/message.js` |

这两个工程都不是 SHK 仓库里的 fixture。脚本默认从本机 tarball 缓存读取；没有缓存时，可以显式设置 `SHK_OSS_DOGFOOD_ALLOW_DOWNLOAD=1` 下载。也可以用 `SHK_OSS_DOGFOOD_OFFLINE_DIR` 指向离线源码目录。

## 前端工程测了什么

测的是 TodoMVC store 的核心状态变化：

- 新增 todo 后，标题要保存；
- 新增 todo 必须是 active，不应该默认 completed；
- 删除不存在的 id 不应该误删已有 todo；
- toggle 后能进入 completed；
- clear completed 能清掉已完成 todo。

然后脚本会把真实 `js/store.js` 里的新 todo 默认状态改坏：

```text
completed: false → completed: true
```

如果这条 E2E 还通过，就说明测试只是走流程；脚本会直接失败。当前验证结果是：坏代码下 E2E 失败。

## API 工程测了什么

测的是 Express message route 的核心数据流：

- `POST /messages` 创建 message；
- 返回值保留请求里的 `text`；
- 返回值使用当前用户 id；
- `GET /messages/:messageId` 能读回刚创建的 message；
- 查询不存在的 id 不返回 message，也不改变已有数据。

然后脚本会把真实 `src/routes/message.js` 里的 message text 保存逻辑改坏：

```text
text: req.body.text → text: 'MUTATED_TEXT'
```

如果这条 E2E 还通过，就说明测试没有检查关键业务结果；脚本会直接失败。当前验证结果是：坏代码下 E2E 失败。

## SHK 在这里验证什么

这不是在证明两个开源工程本身“质量完美”。它证明的是 SHK Phase 2 的工作方式在真实代码路径上成立：

1. 先写 `.harness/iteration-spec.json`，说明需求、风险、流量路径和验收标准；
2. 生成 `.harness/task-quality-contract.json`，告诉 assessor 本轮必须证明什么；
3. E2E 必须写本轮 run-token 的 `.harness/e2e-result.json`；
4. `shk e2e assess --risk medium` 只认 fresh structured evidence；
5. mutation 必须真实跑过，并且只接受 `killed > 0 && survived === 0`；
6. `shk test effectiveness --risk medium` 和 `shk verify --risk medium` 要把 spec、E2E、mutation 证据合起来看；
7. fake / smoke-only / 注释关键词脚本不能被当成可以交付。

## 这次还没证明什么

这轮没有声称覆盖所有质量工程场景：

- 没有跑上游完整 npm install 和原项目完整 CI；
- 没有跑浏览器全链路；
- 没有做真实线上流量回放；
- 没有证明所有框架的 bootstrap 都完善。

它证明的是第一版必须守住的底线：**SHK 不能只在自造 fixture 上自嗨；至少要能在真实 OSS 工程的真实业务代码路径上生成有效测试，并用 mutation 证明坏代码会被抓住。**

## 用户应该看到的人话报告

```text
这轮真实 OSS dogfood 可以交付。

我接入了两个开源工程的临时副本。前端测 TodoMVC 的 store 状态流，API 测 Express message 创建和读回。

正常代码下 E2E 都通过；我又分别把 todo 默认状态和 message text 保存逻辑改坏，同一条 E2E 都失败了。

所以这次不是只跑了流程，测试确实能抓住关键行为坏掉。

还没覆盖的是完整浏览器链路、上游完整 CI 和线上流量回放。

机器状态：READY
```

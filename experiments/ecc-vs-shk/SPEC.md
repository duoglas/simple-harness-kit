# 实验：用 ECC 迭代本工程 vs 用 SHK 迭代本工程

> 预注册（pre-registered）设计文档。评分标准在跑实验**之前**确定，避免事后找补。

## 问题

迭代 Simple Harness Kit（SHK，本工程）本身时，用 **ECC** 作为驱动 harness 更有效，还是用 **SHK 自己**（dogfooding）更有效？

## 受测目标（两条 lane 做完全相同的任务）

两个任务取自此前 ROI 清单，难度对等、都是真实 backlog：

- **T1 — 加 CI 门禁**：新增 `.github/workflows/ci.yml`，在 PR 到 master 时运行现有测试入口
  `tests/scripts/run-all.sh`。要求：合法 YAML、真实调用现有测试、最小权限、pin action 版本。
- **T2 — no-personal-paths 校验器**：新增脚本，扫描 git 跟踪的文本文件里的 `/Users/<name>`
  与 `C:\Users\<name>` 本机绝对路径；放行占位符用户名；对合法 GitHub URL（如
  `github.com/duoglas/...`）**不得误报**；发现真实泄漏时退出码非 0；并接入 CI。
  约定：中文注释 + 中文输出（SHK 写作约定）；校验器必须支持通过 CLI 参数或环境变量指定扫描根
  目录（可测试性要求）。

## 两条 lane

| Lane | 驱动 harness | 操作化定义 |
|---|---|---|
| **A — SHK 驱动** | SHK 自己 | worktree 即 SHK 仓库副本，使用其 methodology / skills / hooks / 6 阶段 Loop |
| **B — ECC 驱动** | ECC | 同一 SHK 仓库副本上作业，但 shallow-clone ECC，用 ECC 的 validators/约定/agent 风格驱动 |

两条 lane 独立 worktree、无上下文交叉、收到**完全相同**的任务说明与汇报格式契约。

## 评分标准（预注册）

| 指标 | 含义 | 测法 | 满分 |
|---|---|---|---|
| **M1 完成度**（gate） | 两个任务各自完成质量 | 每任务 0=失败/1=部分/2=完整正确 | 4 |
| **M2 效率** | 工具调用次数（越低越好） | 子 agent 自报 | 仅对比 |
| **M3 产出质量** | 自动化交叉验证 | `evaluate.sh`，见下 5 项 | 5 |
| **M4 方法论洞察** | 可写回 `methodology/` 的、可泛化的真实洞察数 | 控制器人工判定（须具体、可泛化、非"关于任务/关于 ECC"） | 计数，**核心指标** |
| **M5 规范契合** | 中文优先、不用 emoji、文件命名、流程纪律 | 自动 emoji 扫描 + 人工 | 定性 |

### M3 自动化 5 项（evaluate.sh）

1. workflow 为合法 YAML
2. workflow 真实调用 `tests/scripts/run-all.sh`
3. validator 对植入泄漏样本 `fixtures/leak-sample.txt` 退出码非 0（抓到）
4. validator 对 `fixtures/clean-sample.md`（含合法 github URL + 占位符）退出码 0（不误报）
5. validator 输出为中文（SHK 约定）

## 核心论点与预注册预测

- 论点：SHK 是方法论产品，其价值=方法论本身；只有"用 SHK 造 SHK"才能验证/打磨方法论并产生
  F1-F5 反馈。用 ECC 造 SHK 改善的是代码、不是产品，且自相矛盾。
- 预测：**Lane B 在 M2（效率）、可能 M3（validator 成熟）领先；Lane A 在 M4（方法论洞察）
  大幅领先、M5（规范契合）领先。** 若结果如此，结论坐实：日常用 SHK 驱动，ECC 当外部预言机照盲区。

## 评判规则

不假装单一标量是真理。按指标逐项呈现：M1 为 gate（任一任务 0 分则该 lane 该任务不计后续质量分），
M4 为产品价值核心指标加权最高。最终给出分项表 + 明确结论。
